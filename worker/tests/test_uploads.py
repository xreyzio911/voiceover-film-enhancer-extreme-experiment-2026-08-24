from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from contract_support import MutableClock, require_symbols


class ResumableUploadContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name) / "artifacts"
        self.root.mkdir()
        self.db_path = Path(self.temp_dir.name) / "worker.sqlite3"
        self.clock = MutableClock()
        self.Store, = require_symbols(self, "extreme_worker.job_store", "SQLiteJobStore")
        (
            self.UploadManager,
            self.UploadOffsetConflict,
            self.UploadIntegrityError,
            self.UploadStateError,
        ) = require_symbols(
            self,
            "extreme_worker.uploads",
            "UploadManager",
            "UploadOffsetConflict",
            "UploadIntegrityError",
            "UploadStateError",
        )
        self.store = self.Store(self.db_path, clock=self.clock)
        self.job = self.store.create_job(
            owner_token_hash="owner_hash",
            idempotency_key="upload-contract",
            request_fingerprint="f" * 64,
        )
        self.manager = self.UploadManager(root=self.root, store=self.store)
        self.payload = b"RIFF" + bytes(range(64)) + b"WAVE"
        self.sha256 = hashlib.sha256(self.payload).hexdigest()

    def tearDown(self) -> None:
        if hasattr(self, "store"):
            self.store.close()
        self.temp_dir.cleanup()

    def _start(self) -> None:
        self.manager.start(
            self.job.job_id,
            expected_size=len(self.payload),
            expected_sha256=self.sha256,
        )

    def test_ordered_chunks_complete_with_exact_size_and_checksum(self) -> None:
        self._start()
        split = 17
        self.assertEqual(self.manager.append(self.job.job_id, offset=0, chunk=self.payload[:split]), split)
        self.assertEqual(
            self.manager.append(self.job.job_id, offset=split, chunk=self.payload[split:]),
            len(self.payload),
        )
        completed = self.manager.finalize(self.job.job_id)
        self.assertEqual(completed.name, "source.wav")
        self.assertEqual(completed.read_bytes(), self.payload)
        self.assertFalse(completed.with_name("source.upload.part").exists())

    def test_wrong_offset_is_rejected_without_writing(self) -> None:
        self._start()
        with self.assertRaises(self.UploadOffsetConflict) as raised:
            self.manager.append(self.job.job_id, offset=1, chunk=b"abc")
        self.assertEqual(raised.exception.expected_offset, 0)
        self.assertEqual(self.manager.status(self.job.job_id).offset, 0)

    def test_chunk_cannot_overflow_declared_size(self) -> None:
        self._start()
        with self.assertRaises(self.UploadIntegrityError):
            self.manager.append(self.job.job_id, offset=0, chunk=self.payload + b"overflow")
        self.assertEqual(self.manager.status(self.job.job_id).offset, 0)

    def test_incomplete_upload_cannot_finalize(self) -> None:
        self._start()
        self.manager.append(self.job.job_id, offset=0, chunk=self.payload[:-1])
        with self.assertRaises(self.UploadIntegrityError):
            self.manager.finalize(self.job.job_id)
        self.assertFalse((self.root / self.job.job_id / "source.wav").exists())

    def test_checksum_mismatch_never_publishes_completed_wav(self) -> None:
        self._start()
        corrupted = self.payload[:-1] + bytes([self.payload[-1] ^ 0x01])
        self.manager.append(self.job.job_id, offset=0, chunk=corrupted)
        with self.assertRaises(self.UploadIntegrityError):
            self.manager.finalize(self.job.job_id)
        self.assertFalse((self.root / self.job.job_id / "source.wav").exists())

    def test_completion_is_idempotent_but_append_after_completion_is_rejected(self) -> None:
        self._start()
        self.manager.append(self.job.job_id, offset=0, chunk=self.payload)
        first = self.manager.finalize(self.job.job_id)
        second = self.manager.finalize(self.job.job_id)
        self.assertEqual(first, second)
        with self.assertRaises(self.UploadStateError):
            self.manager.append(self.job.job_id, offset=len(self.payload), chunk=b"x")

    def test_offset_survives_sqlite_and_process_restart(self) -> None:
        self._start()
        split = 13
        self.manager.append(self.job.job_id, offset=0, chunk=self.payload[:split])
        self.store.close()
        self.store = self.Store(self.db_path, clock=self.clock)
        self.manager = self.UploadManager(root=self.root, store=self.store)
        self.assertEqual(self.manager.status(self.job.job_id).offset, split)
        self.manager.append(self.job.job_id, offset=split, chunk=self.payload[split:])
        self.assertEqual(self.manager.finalize(self.job.job_id).read_bytes(), self.payload)

    def test_disk_and_sqlite_offset_disagreement_fails_safe(self) -> None:
        self._start()
        self.manager.append(self.job.job_id, offset=0, chunk=self.payload[:20])
        partial = self.root / self.job.job_id / "source.upload.part"
        partial.write_bytes(partial.read_bytes()[:10])
        self.store.close()
        self.store = self.Store(self.db_path, clock=self.clock)
        self.manager = self.UploadManager(root=self.root, store=self.store)
        with self.assertRaises(self.UploadIntegrityError):
            self.manager.status(self.job.job_id)

    def test_expected_checksum_must_be_canonical_sha256(self) -> None:
        for invalid in ("", "abc", "A" * 64, "g" * 64):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.manager.start(
                    self.job.job_id,
                    expected_size=len(self.payload),
                    expected_sha256=invalid,
                )


if __name__ == "__main__":
    unittest.main()
