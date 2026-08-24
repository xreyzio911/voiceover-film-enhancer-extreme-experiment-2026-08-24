from __future__ import annotations

import hashlib
import logging
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path

from .job_store import ConcurrentUpdate, SQLiteJobStore
from .paths import JobPaths


_LOGGER = logging.getLogger("extreme_worker")


class UploadOffsetConflict(RuntimeError):
    def __init__(self, expected_offset: int) -> None:
        super().__init__(f"Expected upload offset {expected_offset}.")
        self.expected_offset = expected_offset


class UploadIntegrityError(RuntimeError):
    pass


class UploadStateError(RuntimeError):
    pass


@dataclass(frozen=True)
class UploadStatus:
    job_id: str
    offset: int
    expected_size: int
    completed: bool


class UploadManager:
    def __init__(self, *, root: str | Path, store: SQLiteJobStore) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.store = store
        self.paths = JobPaths(self.root)
        self._locks_guard = threading.Lock()
        self._job_locks: dict[str, threading.RLock] = {}

    def _lock_for(self, job_id: str) -> threading.RLock:
        with self._locks_guard:
            return self._job_locks.setdefault(job_id, threading.RLock())

    def start(self, job_id: str, *, expected_size: int, expected_sha256: str) -> UploadStatus:
        if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
            raise ValueError("expected_sha256 must be canonical lowercase SHA-256")
        return self._start(job_id, expected_size=expected_size, expected_sha256=expected_sha256)

    def start_deferred_checksum(self, job_id: str, *, expected_size: int) -> UploadStatus:
        return self._start(job_id, expected_size=expected_size, expected_sha256="")

    def _start(self, job_id: str, *, expected_size: int, expected_sha256: str) -> UploadStatus:
        if expected_size <= 0:
            raise ValueError("expected_size must be positive")
        paths = self.paths.for_job(job_id)
        paths.directory.mkdir(parents=True, exist_ok=True)
        self.store.create_upload(job_id, expected_size=expected_size, expected_sha256=expected_sha256)
        return self.status(job_id)

    def status(self, job_id: str) -> UploadStatus:
        upload = self.store.get_upload(job_id)
        paths = self.paths.for_job(job_id)
        part_size = paths.upload_part.stat().st_size if paths.upload_part.exists() else 0
        if not upload.complete and part_size != upload.offset:
            raise UploadIntegrityError("upload offset disagrees with disk")
        if upload.complete:
            if paths.upload_part.exists():
                raise UploadIntegrityError("completed upload still has partial bytes")
            if not paths.source_wav.is_file() or paths.source_wav.stat().st_size != upload.expected_size:
                raise UploadIntegrityError("completed upload bytes are missing or inconsistent")
        elif paths.source_wav.exists():
            raise UploadIntegrityError("uncommitted upload has a published source artifact")
        return UploadStatus(job_id, upload.offset, upload.expected_size, upload.complete)

    def append(self, job_id: str, *, offset: int, chunk: bytes) -> int:
        with self._lock_for(job_id):
            status = self.status(job_id)
            if status.completed:
                raise UploadStateError("upload already completed")
            if offset != status.offset:
                raise UploadOffsetConflict(status.offset)
            if not isinstance(chunk, bytes):
                raise TypeError("upload chunk must be bytes")
            next_offset = status.offset + len(chunk)
            if next_offset > status.expected_size:
                raise UploadIntegrityError("chunk exceeds declared size")
            if not chunk:
                return status.offset
            paths = self.paths.for_job(job_id)
            try:
                with paths.upload_part.open("ab") as handle:
                    handle.write(chunk)
                    handle.flush()
                    os.fsync(handle.fileno())
                self.store.advance_upload(job_id, expected_offset=offset, new_offset=next_offset)
            except ConcurrentUpdate as exc:
                self._truncate(paths.upload_part, status.offset)
                raise UploadOffsetConflict(status.offset) from exc
            except Exception:
                self._truncate(paths.upload_part, status.offset)
                raise
            return next_offset

    def finalize(self, job_id: str) -> Path:
        with self._lock_for(job_id):
            upload = self.store.get_upload(job_id)
            paths = self.paths.for_job(job_id)
            if upload.complete:
                self.status(job_id)
                return paths.source_wav
            status = self.status(job_id)
            if status.offset != status.expected_size:
                raise UploadIntegrityError("upload is incomplete")
            actual_sha256 = self._sha256(paths.upload_part)
            if upload.expected_sha256 and actual_sha256 != upload.expected_sha256:
                raise UploadIntegrityError("upload checksum mismatch")
            os.replace(paths.upload_part, paths.source_wav)
            try:
                self.store.mark_upload_complete(
                    job_id,
                    expected_offset=status.offset,
                    actual_sha256=actual_sha256,
                )
            except Exception:
                if paths.source_wav.exists() and not paths.upload_part.exists():
                    os.replace(paths.source_wav, paths.upload_part)
                raise
            return paths.source_wav

    def remove_artifacts(self, job_id: str, *, keep_report: bool = False) -> None:
        """Delete only one validated job's fixed artifacts under its upload lock."""
        with self._lock_for(job_id):
            paths = self.paths.for_job(job_id)
            targets = [paths.upload_part, paths.source_wav]
            if not keep_report:
                targets.extend((paths.report_json, paths.candidate_wav))
            for target in targets:
                try:
                    target.unlink(missing_ok=True)
                except OSError as exc:
                    _LOGGER.warning(
                        "job_artifact_cleanup_failed artifact=%s exception_type=%s",
                        target.name,
                        type(exc).__name__,
                    )
            try:
                paths.directory.rmdir()
            except FileNotFoundError:
                pass
            except OSError:
                # Reports or unexpected files keep the directory alive. Cleanup
                # never recursively removes content it does not explicitly own.
                pass

    @staticmethod
    def _truncate(path: Path, offset: int) -> None:
        if path.exists() and path.stat().st_size > offset:
            with path.open("r+b") as handle:
                handle.truncate(offset)
                handle.flush()
                os.fsync(handle.fileno())

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
