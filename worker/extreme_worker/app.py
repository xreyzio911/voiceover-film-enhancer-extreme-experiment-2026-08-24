from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from starlette.requests import ClientDisconnect

from .api_support import LazyRuntimeAnalyzer, LocalFallbackAnalyzer, RateLimiter
from .capabilities import build_capabilities
from .model_runtime import sha256_file
from .job_store import (
    ActiveJobLimitExceeded,
    ConcurrentUpdate,
    IdempotencyConflict,
    JobNotFound,
    JobState,
    JobStoreError,
    SQLiteJobStore,
    TerminalCode,
)
from .origin_policy import OriginPolicy, build_cors_headers
from .paths import JobPaths, PathViolation, validate_job_id
from .report_schema import ReportValidationError, validate_source_report
from .security import (
    AdmissionScope,
    AdmissionTicketAuthority,
    JobTokenHasher,
    SQLiteReplayStore,
    TicketReplayError,
    TicketValidationError,
)
from .uploads import (
    UploadIntegrityError,
    UploadManager,
    UploadOffsetConflict,
    UploadStateError,
)
from .wav_validation import WavLimits, WavValidationError, inspect_wav_file


_HEX_64 = re.compile(r"^[0-9a-f]{64}$")
_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9._:@+-]{1,128}$")
_AUDIO_TYPES = frozenset({"audio/wav", "audio/x-wav"})
_UPLOAD_TYPES = frozenset({"audio/wav", "audio/x-wav", "application/offset+octet-stream"})
_ANALYSIS_SCOPES = frozenset({"source_analysis", "render_analysis"})
_LOGGER = logging.getLogger("extreme_worker")
_TICKET_MAX_TTL_SECONDS = 300
_TICKET_REPLAY_RETENTION_SAFETY_SECONDS = 60.0


class _ShortLivedJobStore:
    """SQLite facade that never leaves a file handle open between operations."""

    def __init__(self, path: Path, *, clock: Callable[[], float]) -> None:
        self.path = path
        self.clock = clock

    def __getattr__(self, name: str):
        def invoke(*args, **kwargs):
            store = SQLiteJobStore(self.path, clock=self.clock)
            try:
                operation = getattr(store, name)
                return operation(*args, **kwargs)
            finally:
                store.close()

        return invoke

    def probe_writable(self, *, timeout_seconds: float) -> None:
        store = SQLiteJobStore(
            self.path,
            clock=self.clock,
            timeout_seconds=timeout_seconds,
        )
        try:
            store.probe_writable()
        finally:
            store.close()

    def close(self) -> None:
        """Compatibility no-op; each facade operation closes its own connection."""


class _EmbeddedProcessor:
    def __init__(
        self,
        app: FastAPI,
        poll_seconds: float,
        lease_seconds: float,
        retention_seconds: float,
        stale_job_seconds: float,
        maintenance_interval_seconds: float,
    ) -> None:
        self.app = app
        self.poll_seconds = poll_seconds
        self.lease_seconds = lease_seconds
        self.retention_seconds = retention_seconds
        self.stale_job_seconds = stale_job_seconds
        self.maintenance_interval_seconds = maintenance_interval_seconds
        self.worker_id = f"embedded-{secrets.token_urlsafe(8)}"
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.next_maintenance_at = 0.0

    def start(self) -> None:
        if self.thread is None:
            self.thread = threading.Thread(target=self._loop, name="extreme-analysis-worker", daemon=True)
            self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=min(5.0, self.lease_seconds))
            self.thread = None

    def _loop(self) -> None:
        while not self.stop_event.is_set():
            found = False
            try:
                now = float(self.app.state.clock())
                if now >= self.next_maintenance_at:
                    _expire_stale_jobs(
                        self.app,
                        stale_job_seconds=self.stale_job_seconds,
                    )
                    _purge_expired_jobs(self.app, retention_seconds=self.retention_seconds)
                    _maybe_prune_expired_ticket_replays(self.app, now=now)
                    self.next_maintenance_at = now + self.maintenance_interval_seconds
                self.app.state.job_store.requeue_expired_leases()
                job = self.app.state.job_store.lease_next(
                    worker_id=self.worker_id,
                    lease_seconds=self.lease_seconds,
                )
                if job is not None:
                    found = True
                    _run_analysis(self.app, job.job_id)
            except Exception as exc:
                _LOGGER.error("embedded_worker_loop_failed exception_type=%s", type(exc).__name__)
                found = False
            if not found:
                self.stop_event.wait(self.poll_seconds)


def _positive_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def _positive_float(value: Any, fallback: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def _csv(value: Any) -> list[str]:
    if isinstance(value, (list, tuple)):
        return [str(item) for item in value]
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return []


def _bearer(request: Request) -> str | None:
    authorization = request.headers.get("authorization", "")
    if not authorization.startswith("Bearer "):
        return None
    token = authorization[7:].strip()
    return token or None


def _json(status_code: int, payload: dict[str, Any], request: Request, extra_headers: dict[str, str] | None = None):
    headers = {"Cache-Control": "no-store", **build_cors_headers(request.headers.get("origin"), request.app.state.allowed_origins)}
    if extra_headers:
        headers.update(extra_headers)
    return JSONResponse(payload, status_code=status_code, headers=headers)


def _empty(status_code: int, request: Request, extra_headers: dict[str, str] | None = None) -> Response:
    headers = {"Cache-Control": "no-store", **build_cors_headers(request.headers.get("origin"), request.app.state.allowed_origins)}
    if extra_headers:
        headers.update(extra_headers)
    return Response(status_code=status_code, headers=headers)


def _fingerprint(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _expires_at(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _default_owner_hash(secret: str) -> str:
    return hashlib.sha256(f"compat-owner:{secret}".encode("utf-8")).hexdigest()


async def _bounded_body(request: Request, maximum: int) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            parsed_length = int(content_length)
        except ValueError as exc:
            raise TypeError("invalid Content-Length") from exc
        if parsed_length < 0:
            raise TypeError("invalid Content-Length")
        if parsed_length > maximum:
            raise OverflowError("request body exceeds limit")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > maximum:
            raise OverflowError("request body exceeds limit")
        chunks.append(chunk)
    return b"".join(chunks)


async def _bounded_json(request: Request, maximum: int, *, allow_empty: bool = False) -> dict[str, Any]:
    body = await _bounded_body(request, maximum)
    if not body and allow_empty:
        return {}
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TypeError("request body is not valid JSON") from exc
    if not isinstance(payload, dict):
        raise TypeError("request body must be an object")
    return payload


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    with temporary.open("wb") as output:
        output.write(encoded)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def _probe_writable_storage(storage_root: Path) -> None:
    """Write, sync, and remove one exact probe file in the persistent root."""
    storage_root.mkdir(parents=True, exist_ok=True)
    probe = storage_root / f".ready-{secrets.token_hex(12)}.tmp"
    try:
        with probe.open("xb") as handle:
            handle.write(b"ready")
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        probe.unlink(missing_ok=True)


def _probe_readiness(app: FastAPI) -> bool:
    if (
        not app.state.internal_secret
        or app.state.ticket_secret is None
        or (
            app.state.runtime_mode in {"manifest", "production"}
            and not app.state.ticket_secret_explicit
        )
    ):
        return False
    try:
        _probe_writable_storage(app.state.storage_root)
        app.state.job_store.probe_writable(
            timeout_seconds=app.state.readiness_timeout_seconds,
        )
        replay_store = SQLiteReplayStore(
            app.state.storage_root / "tickets.sqlite3",
            timeout_seconds=app.state.readiness_timeout_seconds,
        )
        replay_store.probe_writable()
    except (OSError, sqlite3.Error, ValueError) as exc:
        _LOGGER.warning("readiness_probe_failed exception_type=%s", type(exc).__name__)
        return False
    return True


def _admission_authority(app: FastAPI) -> AdmissionTicketAuthority | None:
    if app.state.ticket_secret is None:
        return None
    with app.state.admission_lock:
        if app.state.admission_authority is None:
            app.state.storage_root.mkdir(parents=True, exist_ok=True)
            app.state.admission_authority = AdmissionTicketAuthority(
                secret=app.state.ticket_secret,
                replay_store=SQLiteReplayStore(app.state.storage_root / "tickets.sqlite3"),
                clock=app.state.clock,
                max_ttl_seconds=_TICKET_MAX_TTL_SECONDS,
            )
        return app.state.admission_authority


def _prune_expired_ticket_replays(app: FastAPI, *, now: float | None = None) -> int:
    current_time = float(app.state.clock() if now is None else now)
    cutoff = current_time - (
        _TICKET_MAX_TTL_SECONDS + _TICKET_REPLAY_RETENTION_SAFETY_SECONDS
    )
    replay_store = SQLiteReplayStore(app.state.storage_root / "tickets.sqlite3")
    return replay_store.prune_before(cutoff)


def _maybe_prune_expired_ticket_replays(app: FastAPI, *, now: float | None = None) -> int:
    current_time = float(app.state.clock() if now is None else now)
    with app.state.ticket_replay_maintenance_lock:
        if current_time < app.state.next_ticket_replay_maintenance_at:
            return 0
        app.state.next_ticket_replay_maintenance_at = (
            current_time + float(app.state.maintenance_interval_seconds)
        )
        try:
            return _prune_expired_ticket_replays(app, now=current_time)
        except (OSError, sqlite3.Error, ValueError) as exc:
            _LOGGER.warning(
                "ticket_replay_prune_failed exception_type=%s",
                type(exc).__name__,
            )
            return 0


def _normalize_metadata(payload: Any, *, max_audio_bytes: int, require_owner: bool = False) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    if set(payload) - {"ownerHash", "sizeBytes", "contentType", "idempotencyKey", "scope", "sha256"}:
        return None
    owner_hash = payload.get("ownerHash")
    if owner_hash is None and not require_owner:
        owner_hash = ""
    if not isinstance(owner_hash, str):
        return None
    owner_hash = owner_hash.lower()
    size_bytes = payload.get("sizeBytes")
    content_type = payload.get("contentType")
    idempotency_key = payload.get("idempotencyKey")
    scope = payload.get("scope")
    sha256 = payload.get("sha256")
    if (
        not isinstance(size_bytes, int)
        or isinstance(size_bytes, bool)
        or size_bytes <= 0
        or not isinstance(content_type, str)
        or content_type not in _AUDIO_TYPES
        or not isinstance(idempotency_key, str)
        or not _IDEMPOTENCY_RE.fullmatch(idempotency_key)
        or not isinstance(scope, str)
        or scope not in _ANALYSIS_SCOPES
    ):
        return None
    if size_bytes > max_audio_bytes:
        return {"tooLarge": True}
    if sha256 is not None and (not isinstance(sha256, str) or not _HEX_64.fullmatch(sha256)):
        return None
    if owner_hash and not _HEX_64.fullmatch(owner_hash):
        return None
    return {
        "ownerHash": owner_hash,
        "sizeBytes": size_bytes,
        "contentType": content_type,
        "idempotencyKey": idempotency_key,
        "scope": scope,
        "sha256": sha256,
    }


def _status_payload(app: FastAPI, job_id: str) -> dict[str, Any]:
    job = app.state.job_store.get_job(job_id)
    upload_offset = 0
    size_bytes = 0
    try:
        if job.state in {JobState.UPLOADING, JobState.QUEUED, JobState.RUNNING, JobState.CANCEL_REQUESTED}:
            upload = app.state.upload_manager.status(job_id)
        else:
            upload = app.state.job_store.get_upload(job_id)
        upload_offset = upload.offset
        size_bytes = upload.expected_size
    except (JobNotFound, UploadIntegrityError):
        pass
    payload = {
        "jobId": job.job_id,
        "state": job.state.value,
        "attempts": job.attempts,
        "uploadOffset": upload_offset,
        "sizeBytes": size_bytes,
    }
    if job.terminal_code is not None:
        payload["terminalCode"] = job.terminal_code.value
    return payload


def _upload_offset_if_accepting(app: FastAPI, job_id: str) -> int | None:
    try:
        if app.state.job_store.get_job(job_id).state != JobState.UPLOADING:
            return None
        return app.state.upload_manager.status(job_id).offset
    except (JobNotFound, UploadIntegrityError):
        return None


def _job_for_token(request: Request, job_id: str):
    try:
        validate_job_id(job_id)
    except PathViolation:
        raise JobNotFound("job not found") from None
    token = _bearer(request)
    if token is None:
        raise JobNotFound("job not found")
    return request.app.state.job_store.get_job_for_owner(
        job_id,
        presented_token=token,
        hasher=request.app.state.token_hasher,
    )


def _wav_limits(app: FastAPI) -> WavLimits:
    return WavLimits(
        max_upload_bytes=app.state.max_audio_bytes,
        allowed_sample_rates=frozenset({16_000, 24_000, 44_100, 48_000}),
        allowed_channels=frozenset({1, 2}),
        allowed_sample_width_bytes=frozenset({2, 3, 4}),
        max_duration_seconds=app.state.max_duration_seconds,
        max_decoded_frames=round(48_000 * app.state.max_duration_seconds),
    )


def _transition_if_current(store: SQLiteJobStore, job_id: str, source: JobState, target: JobState) -> None:
    try:
        store.transition(job_id, source, target)
    except ConcurrentUpdate:
        pass


def _remove_job_artifacts(app: FastAPI, job_id: str, *, keep_report: bool = False) -> None:
    app.state.upload_manager.remove_artifacts(job_id, keep_report=keep_report)


def _acknowledge_cancel(app: FastAPI, job_id: str) -> bool:
    current = app.state.job_store.get_job(job_id)
    if current.state == JobState.CANCEL_REQUESTED:
        _transition_if_current(
            app.state.job_store,
            job_id,
            JobState.CANCEL_REQUESTED,
            JobState.CANCELLED,
        )
        current = app.state.job_store.get_job(job_id)
    if current.state == JobState.CANCELLED:
        _remove_job_artifacts(app, job_id)
        return True
    return False


def _purge_expired_jobs(app: FastAPI, *, retention_seconds: float) -> tuple[str, ...]:
    cutoff = float(app.state.clock()) - retention_seconds
    purged = app.state.job_store.purge_terminal_before(cutoff_timestamp=cutoff)
    for job_id in purged:
        _remove_job_artifacts(app, job_id)
    return purged


def _expire_stale_jobs(app: FastAPI, *, stale_job_seconds: float) -> tuple[str, ...]:
    expired = app.state.job_store.expire_stale_jobs(
        stale_after_seconds=stale_job_seconds,
    )
    cleanup_candidates = app.state.job_store.list_terminal_jobs_by_code(
        terminal_code=TerminalCode.STALE_JOB_EXPIRED,
    )
    for job_id in cleanup_candidates:
        _remove_job_artifacts(app, job_id)
    return expired


def _run_analysis(app: FastAPI, job_id: str) -> None:
    store: SQLiteJobStore = app.state.job_store
    paths = JobPaths(app.state.upload_root).for_job(job_id)
    try:
        inspect_wav_file(paths.source_wav, _wav_limits(app))
    except (OSError, WavValidationError):
        current = store.get_job(job_id)
        if current.state in {JobState.CANCEL_REQUESTED, JobState.CANCELLED}:
            _acknowledge_cancel(app, job_id)
            return
        if current.state == JobState.QUEUED:
            _transition_if_current(store, job_id, JobState.QUEUED, JobState.FAILED)
        elif current.state == JobState.RUNNING:
            _transition_if_current(store, job_id, JobState.RUNNING, JobState.FAILED)
        if store.get_job(job_id).state == JobState.FAILED:
            _remove_job_artifacts(app, job_id)
        return

    try:
        _transition_if_current(store, job_id, JobState.QUEUED, JobState.RUNNING)
        current = store.get_job(job_id)
        if current.state in {JobState.CANCEL_REQUESTED, JobState.CANCELLED}:
            _acknowledge_cancel(app, job_id)
            return
        if current.state != JobState.RUNNING:
            return
        source_sha256 = sha256_file(paths.source_wav)
        report = app.state.analyzer.analyze_wav(paths.source_wav, job_id=job_id, source_sha256=source_sha256)
        if _acknowledge_cancel(app, job_id):
            return
        if sha256_file(paths.source_wav) != source_sha256:
            raise RuntimeError("analysis mutated the immutable source")
        clean_report = validate_source_report(report, expected_source_sha256=source_sha256)
        info = inspect_wav_file(paths.source_wav, _wav_limits(app))
        source = clean_report["source"]
        if (
            source["sampleRate"] != info.sample_rate
            or source["channels"] != info.channels
            or abs(float(source["durationMs"]) - info.duration_seconds * 1000.0) > 1.0
        ):
            raise ReportValidationError("report source facts disagree with the WAV header")
        _atomic_json(paths.report_json, clean_report)
        _transition_if_current(store, job_id, JobState.RUNNING, JobState.SUCCEEDED)
        if _acknowledge_cancel(app, job_id):
            return
        if store.get_job(job_id).state == JobState.SUCCEEDED:
            _remove_job_artifacts(app, job_id, keep_report=True)
    except Exception as exc:
        _LOGGER.error("analysis_failed job_id=%s exception_type=%s", job_id, type(exc).__name__)
        try:
            paths.report_json.unlink(missing_ok=True)
        except OSError:
            pass
        current = store.get_job(job_id)
        if current.state in {JobState.CANCEL_REQUESTED, JobState.CANCELLED}:
            _acknowledge_cancel(app, job_id)
        elif current.state == JobState.QUEUED:
            _transition_if_current(store, job_id, JobState.QUEUED, JobState.FAILED)
        elif current.state == JobState.RUNNING:
            _transition_if_current(store, job_id, JobState.RUNNING, JobState.FAILED)
        if store.get_job(job_id).state == JobState.FAILED:
            _remove_job_artifacts(app, job_id)


def create_app(config: dict[str, Any] | None = None) -> FastAPI:
    settings = dict(config or {})
    explicit_config = config is not None
    if "runtime_mode" in settings:
        configured_runtime_mode = settings["runtime_mode"]
    elif "runtimeMode" in settings:
        configured_runtime_mode = settings["runtimeMode"]
    else:
        configured_runtime_mode = os.environ.get("EXTREME_ML_RUNTIME_MODE")
    runtime_mode = (
        str(configured_runtime_mode).strip().lower()
        if configured_runtime_mode is not None
        else ("local" if explicit_config else "manifest")
    )
    if runtime_mode not in {"local", "test", "manifest", "production"}:
        raise ValueError("runtime mode must be local, test, manifest, or production")
    storage_root = Path(
        settings.get("storage_root")
        or settings.get("storageRoot")
        or os.environ.get("EXTREME_STORAGE_ROOT")
        or os.environ.get("EXTREME_ML_STORAGE_ROOT")
        or "/var/data"
    ).resolve()
    allowed_origins = tuple(_csv(settings.get("allowed_origins") or settings.get("allowedOrigins")))
    if not allowed_origins:
        allowed_origins = tuple(
            _csv(os.environ.get("EXTREME_ML_ALLOWED_ORIGINS") or os.environ.get("EXTREME_ALLOWED_ORIGINS", ""))
        )
    OriginPolicy(allowed_origins)

    internal_secret = str(
        settings.get("internal_secret")
        or settings.get("internalSecret")
        or os.environ.get("EXTREME_ML_INTERNAL_SECRET")
        or os.environ.get("EXTREME_INTERNAL_SECRET", "")
    )
    if internal_secret and len(internal_secret.encode("utf-8")) < 32:
        raise ValueError("internal secret must contain at least 32 bytes")
    explicit_ticket_secret = str(
        settings.get("ticket_secret")
        or settings.get("ticketSecret")
        or os.environ.get("EXTREME_ML_TICKET_SECRET")
        or os.environ.get("EXTREME_TICKET_SECRET", "")
    )
    ticket_secret = explicit_ticket_secret.encode("utf-8") if explicit_ticket_secret else None
    if ticket_secret is None and runtime_mode in {"local", "test"}:
        ticket_secret = (
            hmac.new(
                internal_secret.encode("utf-8"),
                b"extreme-ml-admission-ticket-v1",
                hashlib.sha256,
            ).digest()
            if internal_secret
            else None
        )
    if ticket_secret is not None and len(ticket_secret) < 32:
        raise ValueError("ticket secret must contain at least 32 bytes")
    if (
        runtime_mode in {"manifest", "production"}
        and explicit_ticket_secret
        and internal_secret
        and hmac.compare_digest(explicit_ticket_secret, internal_secret)
    ):
        ticket_secret = None
    max_audio_bytes = _positive_int(
        settings.get(
            "max_audio_bytes",
            settings.get(
                "max_upload_bytes",
                os.environ.get("EXTREME_ML_MAX_AUDIO_BYTES") or os.environ.get("EXTREME_MAX_AUDIO_BYTES"),
            ),
        ),
        256 * 1024 * 1024,
    )
    max_chunk_bytes = min(
        max_audio_bytes,
        _positive_int(
            settings.get(
                "max_chunk_bytes",
                os.environ.get("EXTREME_ML_MAX_CHUNK_BYTES") or os.environ.get("EXTREME_MAX_CHUNK_BYTES"),
            ),
            8 * 1024 * 1024,
        ),
    )
    max_metadata_bytes = _positive_int(
        settings.get("max_metadata_bytes", os.environ.get("EXTREME_ML_MAX_METADATA_BYTES")),
        8 * 1024,
    )
    max_duration_seconds = _positive_float(
        settings.get(
            "max_duration_seconds",
            os.environ.get("EXTREME_ML_MAX_DURATION_SECONDS") or os.environ.get("EXTREME_MAX_DURATION_SECONDS"),
        ),
        2_160.0,
    )
    ticket_ttl_seconds = min(
        _TICKET_MAX_TTL_SECONDS,
        _positive_int(
            settings.get("ticket_ttl_seconds", os.environ.get("EXTREME_ML_TICKET_TTL_SECONDS")),
            120,
        ),
    )
    worker_poll_seconds = _positive_float(
        settings.get("worker_poll_seconds", os.environ.get("EXTREME_ML_WORKER_POLL_SECONDS")),
        0.25,
    )
    lease_seconds = _positive_float(
        settings.get("lease_seconds", os.environ.get("EXTREME_ML_LEASE_SECONDS")),
        300.0,
    )
    rate_limit_requests = _positive_int(
        settings.get("rate_limit_requests", os.environ.get("EXTREME_ML_RATE_LIMIT_REQUESTS")),
        600,
    )
    rate_limit_window_seconds = _positive_float(
        settings.get(
            "rate_limit_window_seconds",
            os.environ.get("EXTREME_ML_RATE_LIMIT_WINDOW_SECONDS"),
        ),
        60.0,
    )
    retention_seconds = _positive_float(
        settings.get("retention_seconds", os.environ.get("EXTREME_ML_RETENTION_SECONDS")),
        86_400.0,
    )
    stale_job_seconds = _positive_float(
        settings.get(
            "stale_job_seconds",
            os.environ.get("EXTREME_ML_STALE_JOB_SECONDS"),
        ),
        7_200.0,
    )
    maintenance_interval_seconds = _positive_float(
        settings.get(
            "maintenance_interval_seconds",
            os.environ.get("EXTREME_ML_MAINTENANCE_INTERVAL_SECONDS"),
        ),
        300.0,
    )
    max_active_jobs_per_owner = _positive_int(
        settings.get(
            "max_active_jobs_per_owner",
            os.environ.get("EXTREME_ML_MAX_ACTIVE_JOBS_PER_OWNER"),
        ),
        4,
    )
    readiness_timeout_seconds = min(
        1.0,
        _positive_float(
            settings.get(
                "readiness_timeout_seconds",
                os.environ.get("EXTREME_ML_READINESS_TIMEOUT_SECONDS"),
            ),
            0.25,
        ),
    )
    inline_analysis = explicit_config
    if "inline_analysis" in settings:
        inline_analysis = bool(settings["inline_analysis"])
    elif os.environ.get("EXTREME_ML_INLINE_ANALYSIS") is not None:
        inline_analysis = os.environ["EXTREME_ML_INLINE_ANALYSIS"].strip().lower() in {"1", "true", "yes", "on"}
    clock: Callable[[], float] = settings.get("clock") if callable(settings.get("clock")) else time.time

    @asynccontextmanager
    async def lifespan(lifespan_app: FastAPI):
        if not lifespan_app.state.inline_analysis:
            lifespan_app.state.processor.start()
        try:
            yield
        finally:
            lifespan_app.state.processor.stop()
            lifespan_app.state.job_store.close()

    app = FastAPI(title="Extreme audio analysis worker", version="1.0.0", lifespan=lifespan)
    app.state.storage_root = storage_root
    app.state.allowed_origins = allowed_origins
    app.state.runtime_mode = runtime_mode
    app.state.internal_secret = internal_secret
    app.state.ticket_secret = ticket_secret
    app.state.ticket_secret_explicit = bool(explicit_ticket_secret)
    app.state.clock = clock
    app.state.max_audio_bytes = max_audio_bytes
    app.state.max_chunk_bytes = max_chunk_bytes
    app.state.max_metadata_bytes = max_metadata_bytes
    app.state.max_duration_seconds = max_duration_seconds
    app.state.ticket_ttl_seconds = ticket_ttl_seconds
    app.state.worker_poll_seconds = worker_poll_seconds
    app.state.lease_seconds = lease_seconds
    app.state.retention_seconds = retention_seconds
    app.state.stale_job_seconds = stale_job_seconds
    app.state.maintenance_interval_seconds = maintenance_interval_seconds
    app.state.max_active_jobs_per_owner = max_active_jobs_per_owner
    app.state.readiness_timeout_seconds = readiness_timeout_seconds
    app.state.job_store = _ShortLivedJobStore(storage_root / "jobs.sqlite3", clock=clock)
    app.state.upload_root = storage_root / "jobs"
    app.state.upload_manager = UploadManager(root=app.state.upload_root, store=app.state.job_store)
    app.state.token_hasher = JobTokenHasher()
    app.state.analyzer = settings.get("analyzer") or (
        LocalFallbackAnalyzer() if explicit_config else LazyRuntimeAnalyzer()
    )
    if not callable(getattr(app.state.analyzer, "analyze_wav", None)):
        raise ValueError("analyzer must provide analyze_wav")
    app.state.admission_authority = None
    app.state.admission_lock = threading.Lock()
    app.state.ticket_replay_maintenance_lock = threading.Lock()
    app.state.next_ticket_replay_maintenance_at = 0.0
    app.state.inline_analysis = inline_analysis
    app.state.processor = _EmbeddedProcessor(
        app,
        worker_poll_seconds,
        lease_seconds,
        retention_seconds,
        stale_job_seconds,
        maintenance_interval_seconds,
    )
    app.state.rate_limiter = RateLimiter(
        maximum=rate_limit_requests,
        window_seconds=rate_limit_window_seconds,
        clock=clock,
    )

    @app.middleware("http")
    async def enforce_origin(request: Request, call_next):
        origin = request.headers.get("origin")
        if not OriginPolicy(app.state.allowed_origins).allows(origin):
            return Response(status_code=403, headers={"Vary": "Origin"})
        if request.method == "OPTIONS":
            return Response(status_code=204, headers=build_cors_headers(origin, app.state.allowed_origins))
        response = await call_next(request)
        for key, value in build_cors_headers(origin, app.state.allowed_origins).items():
            response.headers[key] = value
        return response

    @app.middleware("http")
    async def rate_limit_and_security_headers(request: Request, call_next):
        client_key = request.client.host if request.client is not None else "unknown"
        allowed, retry_after = app.state.rate_limiter.allow(client_key)
        if not allowed:
            headers = {
                "Cache-Control": "no-store",
                "Retry-After": str(retry_after),
                **build_cors_headers(request.headers.get("origin"), app.state.allowed_origins),
            }
            return JSONResponse({"error": "rate limit exceeded"}, status_code=429, headers=headers)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    @app.get("/health")
    @app.get("/health/live")
    async def health():
        return {"status": "ok"}

    @app.get("/health/ready")
    async def ready():
        if not _probe_readiness(app):
            return JSONResponse({"status": "not_ready"}, status_code=503)
        return {"status": "ready"}

    @app.get("/capabilities")
    async def capabilities():
        return build_capabilities()

    @app.post("/internal/v1/tickets")
    async def issue_ticket(request: Request):
        presented = _bearer(request) or ""
        if not internal_secret or not hmac.compare_digest(presented, internal_secret):
            return _json(401, {"error": "unauthorized"}, request)
        authority = _admission_authority(app)
        if authority is None:
            return _json(503, {"error": "ticket authority unavailable"}, request)
        try:
            raw_payload = await _bounded_json(request, max_metadata_bytes)
        except OverflowError:
            return _json(413, {"error": "metadata too large"}, request)
        except TypeError:
            return _json(400, {"error": "invalid metadata"}, request)
        payload = _normalize_metadata(raw_payload, max_audio_bytes=max_audio_bytes)
        if payload is None:
            return _json(400, {"error": "invalid metadata"}, request)
        if payload.get("tooLarge"):
            return _json(413, {"error": "audio too large"}, request)
        if app.state.ticket_secret_explicit and not payload["ownerHash"]:
            return _json(400, {"error": "ownerHash is required"}, request)
        owner_hash = payload["ownerHash"] or _default_owner_hash(internal_secret)
        scope = AdmissionScope(
            owner_hash=owner_hash,
            size_bytes=payload["sizeBytes"],
            content_type=payload["contentType"],
            idempotency_key=payload["idempotencyKey"],
            scope=payload["scope"],
            sha256=payload["sha256"],
        )
        if app.state.inline_analysis:
            _maybe_prune_expired_ticket_replays(app)
        ticket, expires_at = authority.issue(scope, ttl_seconds=ticket_ttl_seconds)
        return _json(200, {"ticket": ticket, "expiresAt": _expires_at(expires_at)}, request)

    @app.post("/v1/jobs")
    async def create_job(request: Request):
        authority = _admission_authority(app)
        if authority is None:
            return _json(503, {"error": "ticket authority unavailable"}, request)
        try:
            raw_payload = await _bounded_json(request, max_metadata_bytes)
        except OverflowError:
            return _json(413, {"error": "metadata too large"}, request)
        except TypeError:
            return _json(400, {"error": "invalid metadata"}, request)
        payload = _normalize_metadata(raw_payload, max_audio_bytes=max_audio_bytes)
        if payload is None:
            return _json(400, {"error": "invalid metadata"}, request)
        if payload.get("tooLarge"):
            return _json(413, {"error": "audio too large"}, request)
        ticket = _bearer(request)
        if ticket is None:
            return _json(401, {"error": "unauthorized"}, request)
        try:
            claims = authority.verify_and_consume(
                ticket,
                size_bytes=payload["sizeBytes"],
                content_type=payload["contentType"],
                idempotency_key=payload["idempotencyKey"],
                scope=payload["scope"],
                sha256=payload["sha256"],
            )
        except (TicketValidationError, TicketReplayError):
            return _json(401, {"error": "unauthorized"}, request)
        except (sqlite3.Error, OSError):
            _LOGGER.error("ticket_replay_storage_failed")
            return _json(503, {"error": "ticket authority unavailable"}, request)

        access_token = app.state.token_hasher.issue()
        request_fingerprint = _fingerprint(
            {
                "sizeBytes": payload["sizeBytes"],
                "contentType": payload["contentType"],
                "idempotencyKey": payload["idempotencyKey"],
                "scope": payload["scope"],
                "sha256": payload["sha256"],
            }
        )
        try:
            _expire_stale_jobs(
                app,
                stale_job_seconds=stale_job_seconds,
            )
            job, created = app.state.job_store.create_or_rotate_api_job(
                owner_identity_hash=claims.scope.owner_hash,
                access_token_hash=app.state.token_hasher.hash(access_token),
                idempotency_key=payload["idempotencyKey"],
                request_fingerprint=request_fingerprint,
                max_active_jobs_per_owner=max_active_jobs_per_owner,
            )
            if not created and job.state == JobState.SUCCEEDED:
                upload_offset = app.state.job_store.get_upload(job.job_id).offset
            elif not created and job.state in {JobState.FAILED, JobState.CANCELLED}:
                return _json(409, {"error": "terminal job requires a new idempotency key"}, request)
            else:
                if payload["sha256"] is None:
                    app.state.upload_manager.start_deferred_checksum(
                        job.job_id,
                        expected_size=payload["sizeBytes"],
                    )
                else:
                    app.state.upload_manager.start(
                        job.job_id,
                        expected_size=payload["sizeBytes"],
                        expected_sha256=payload["sha256"],
                    )
                upload_offset = app.state.upload_manager.status(job.job_id).offset
        except IdempotencyConflict:
            return _json(409, {"error": "idempotency conflict"}, request)
        except ActiveJobLimitExceeded:
            return _json(
                429,
                {"error": "too many active analysis jobs"},
                request,
                {"Retry-After": "5"},
            )
        except (JobStoreError, sqlite3.Error, OSError):
            _LOGGER.error("job_admission_storage_failed")
            return _json(503, {"error": "analysis storage unavailable"}, request)
        except (ValueError, UploadIntegrityError):
            return _json(400, {"error": "invalid upload"}, request)

        return _json(
            200,
            {
                "jobId": job.job_id,
                "accessToken": access_token,
                "uploadOffset": upload_offset,
                "maxChunkBytes": max_chunk_bytes,
                "scope": payload["scope"],
            },
            request,
        )

    @app.get("/v1/jobs/{job_id}")
    async def get_job(request: Request, job_id: str):
        try:
            _job_for_token(request, job_id)
        except JobNotFound:
            return _json(404, {"error": "not found"}, request)
        return _json(200, _status_payload(app, job_id), request)

    @app.delete("/v1/jobs/{job_id}")
    async def cancel_job(request: Request, job_id: str):
        try:
            job = _job_for_token(request, job_id)
        except JobNotFound:
            return _json(404, {"error": "not found"}, request)
        cancelled = app.state.job_store.request_cancel(job.job_id)
        if cancelled.state == JobState.CANCELLED:
            _remove_job_artifacts(app, job.job_id)
        status_code = 202 if cancelled.state == JobState.CANCEL_REQUESTED else 200
        return _json(status_code, _status_payload(app, job.job_id), request)

    @app.patch("/v1/jobs/{job_id}/input")
    async def upload_chunk(request: Request, job_id: str):
        try:
            job = _job_for_token(request, job_id)
        except JobNotFound:
            return _json(404, {"error": "not found"}, request)
        if job.state != JobState.UPLOADING:
            return _json(409, {"error": "job is not accepting upload bytes"}, request)
        if request.headers.get("content-type", "").split(";")[0].strip().lower() not in _UPLOAD_TYPES:
            return _json(415, {"error": "unsupported media type"}, request)
        try:
            offset = int(request.headers.get("upload-offset", ""))
        except ValueError:
            offset = -1
        if offset < 0:
            return _json(400, {"error": "invalid offset"}, request)
        try:
            chunk = await _bounded_body(request, max_chunk_bytes)
        except ClientDisconnect:
            current = _upload_offset_if_accepting(app, job_id)
            if current is None:
                return _json(409, {"error": "job is not accepting upload bytes"}, request)
            return _empty(408, request, {"Upload-Offset": str(current)})
        except OverflowError:
            current = _upload_offset_if_accepting(app, job_id)
            if current is None:
                return _json(409, {"error": "job is not accepting upload bytes"}, request)
            return _empty(413, request, {"Upload-Offset": str(current)})
        except TypeError:
            return _json(400, {"error": "invalid Content-Length"}, request)
        try:
            next_offset = app.state.upload_manager.append(job_id, offset=offset, chunk=chunk)
        except UploadOffsetConflict as exc:
            return _empty(409, request, {"Upload-Offset": str(exc.expected_offset)})
        except (UploadIntegrityError, UploadStateError, ValueError):
            current = _upload_offset_if_accepting(app, job_id)
            if current is None:
                return _json(409, {"error": "job is not accepting upload bytes"}, request)
            return _empty(413, request, {"Upload-Offset": str(current)})
        return _empty(204, request, {"Upload-Offset": str(next_offset)})

    @app.post("/v1/jobs/{job_id}/input/complete")
    async def complete_upload(request: Request, job_id: str):
        try:
            job = _job_for_token(request, job_id)
        except JobNotFound:
            return _json(404, {"error": "not found"}, request)
        try:
            completion_payload = await _bounded_json(request, max_metadata_bytes, allow_empty=True)
        except OverflowError:
            return _json(413, {"error": "metadata too large"}, request)
        except TypeError:
            return _json(400, {"error": "invalid completion metadata"}, request)
        if completion_payload:
            return _json(400, {"error": "completion body must be empty"}, request)
        if job.state == JobState.SUCCEEDED:
            return _json(200, _status_payload(app, job_id), request)
        if job.state in {JobState.QUEUED, JobState.RUNNING}:
            return _json(202, _status_payload(app, job_id), request)
        if job.state != JobState.UPLOADING:
            return _json(409, {"error": "job cannot be completed"}, request)
        paths = JobPaths(app.state.upload_root).for_job(job_id)
        try:
            upload_status = app.state.upload_manager.status(job_id)
            if upload_status.offset != upload_status.expected_size:
                return _json(
                    409,
                    {"error": "upload incomplete"},
                    request,
                    {"Upload-Offset": str(upload_status.offset)},
                )
            inspect_wav_file(paths.upload_part, _wav_limits(app))
        except (OSError, WavValidationError):
            _transition_if_current(app.state.job_store, job_id, JobState.UPLOADING, JobState.FAILED)
            _remove_job_artifacts(app, job_id)
            return _json(422, _status_payload(app, job_id), request)
        except UploadIntegrityError:
            return _json(409, {"error": "upload integrity verification failed"}, request)
        try:
            app.state.upload_manager.finalize(job_id)
        except UploadIntegrityError:
            return _json(409, {"error": "upload incomplete"}, request)
        except (UploadStateError, ValueError):
            return _json(400, {"error": "invalid upload"}, request)
        if not app.state.inline_analysis:
            return _json(202, _status_payload(app, job_id), request)
        _run_analysis(app, job_id)
        status = _status_payload(app, job_id)
        if status["state"] == JobState.FAILED.value:
            return _json(500, {"error": "advisory analysis failed safely"}, request)
        return _json(200, status, request)

    @app.get("/v1/jobs/{job_id}/report")
    async def get_report(request: Request, job_id: str):
        try:
            job = _job_for_token(request, job_id)
        except JobNotFound:
            return _json(404, {"error": "not found"}, request)
        if job.state != JobState.SUCCEEDED:
            return _json(409, {"error": "report unavailable"}, request)
        paths = JobPaths(app.state.upload_root).for_job(job_id)
        try:
            if paths.report_json.stat().st_size > 16 * 1024 * 1024:
                raise ReportValidationError("report exceeds size limit")
            report = json.loads(paths.report_json.read_text(encoding="utf-8"))
            upload = app.state.job_store.get_upload(job_id)
            report = validate_source_report(report, expected_source_sha256=upload.actual_sha256)
        except (OSError, json.JSONDecodeError, JobNotFound, ReportValidationError):
            return _json(500, {"error": "stored report failed integrity validation"}, request)
        return _json(200, report, request)

    return app


app = create_app()
