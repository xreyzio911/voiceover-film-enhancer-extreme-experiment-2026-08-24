from __future__ import annotations

import secrets
import sqlite3
import threading
import time
from contextlib import closing
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable


class JobStoreError(RuntimeError):
    pass


class JobNotFound(JobStoreError):
    pass


class InvalidTransition(JobStoreError):
    pass


class ConcurrentUpdate(JobStoreError):
    pass


class IdempotencyConflict(JobStoreError):
    pass


class ActiveJobLimitExceeded(JobStoreError):
    pass


class JobState(str, Enum):
    UPLOADING = "uploading"
    QUEUED = "queued"
    RUNNING = "running"
    CANCEL_REQUESTED = "cancel_requested"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TerminalCode(str, Enum):
    STALE_JOB_EXPIRED = "stale_job_expired"


TERMINAL_STATES = frozenset({JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELLED})
ALLOWED_TRANSITIONS = {
    JobState.UPLOADING: frozenset({JobState.QUEUED, JobState.FAILED, JobState.CANCELLED}),
    JobState.QUEUED: frozenset({JobState.RUNNING, JobState.FAILED, JobState.CANCELLED}),
    JobState.RUNNING: frozenset({JobState.SUCCEEDED, JobState.FAILED, JobState.CANCEL_REQUESTED}),
    JobState.CANCEL_REQUESTED: frozenset({JobState.CANCELLED, JobState.FAILED}),
    JobState.SUCCEEDED: frozenset(),
    JobState.FAILED: frozenset(),
    JobState.CANCELLED: frozenset(),
}


@dataclass(frozen=True)
class JobRecord:
    job_id: str
    owner_token_hash: str
    idempotency_key: str
    request_fingerprint: str
    state: JobState
    created_at: float
    updated_at: float
    lease_owner: str | None
    lease_expires_at: float | None
    attempts: int
    owner_identity_hash: str | None = None
    terminal_code: TerminalCode | None = None
    scope: str = "source_analysis"


@dataclass(frozen=True)
class UploadRecord:
    job_id: str
    expected_size: int
    expected_sha256: str
    offset: int
    complete: bool
    updated_at: float
    actual_sha256: str | None = None


class SQLiteJobStore:
    """Single-instance durable queue with SQLite compare-and-swap semantics."""

    def __init__(
        self,
        path: str | Path,
        *,
        clock: Callable[[], float] | None = None,
        timeout_seconds: float = 5.0,
    ) -> None:
        if timeout_seconds <= 0:
            raise ValueError("SQLite timeout must be positive")
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._clock = clock or time.time
        self._lock = threading.RLock()
        self._closed = False
        self._connection = sqlite3.connect(
            self.path,
            timeout=timeout_seconds,
            isolation_level=None,
            check_same_thread=False,
        )
        try:
            self._connection.row_factory = sqlite3.Row
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA foreign_keys=ON")
            self._connection.execute(f"PRAGMA busy_timeout={max(1, round(timeout_seconds * 1000))}")
            self._initialize()
        except Exception:
            self._connection.close()
            self._closed = True
            raise

    def _initialize(self) -> None:
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                job_id TEXT PRIMARY KEY,
                owner_token_hash TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                request_fingerprint TEXT NOT NULL,
                state TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                lease_owner TEXT,
                lease_expires_at REAL,
                attempts INTEGER NOT NULL DEFAULT 0,
                owner_identity_hash TEXT,
                terminal_code TEXT,
                scope TEXT NOT NULL DEFAULT 'source_analysis',
                UNIQUE(owner_token_hash, idempotency_key)
            );
            CREATE INDEX IF NOT EXISTS jobs_queue_idx
                ON jobs(state, created_at, job_id);
            CREATE INDEX IF NOT EXISTS jobs_lease_idx
                ON jobs(state, lease_expires_at);
            CREATE TABLE IF NOT EXISTS uploads (
                job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
                expected_size INTEGER NOT NULL,
                expected_sha256 TEXT NOT NULL,
                offset INTEGER NOT NULL DEFAULT 0,
                complete INTEGER NOT NULL DEFAULT 0,
                actual_sha256 TEXT,
                updated_at REAL NOT NULL
            );
            """
        )
        self._ensure_column("jobs", "owner_identity_hash", "TEXT")
        self._ensure_column("jobs", "terminal_code", "TEXT")
        self._ensure_column("jobs", "scope", "TEXT NOT NULL DEFAULT 'source_analysis'")
        self._ensure_column("uploads", "actual_sha256", "TEXT")
        self._connection.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS jobs_api_idempotency_idx
            ON jobs(owner_identity_hash, idempotency_key)
            WHERE owner_identity_hash IS NOT NULL
            """
        )

    def _ensure_column(self, table: str, column: str, declaration: str) -> None:
        existing = {str(row[1]) for row in self._connection.execute(f"PRAGMA table_info({table})")}
        if column not in existing:
            self._connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")

    def _row_to_job(self, row: sqlite3.Row) -> JobRecord:
        return JobRecord(
            job_id=str(row["job_id"]),
            owner_token_hash=str(row["owner_token_hash"]),
            idempotency_key=str(row["idempotency_key"]),
            request_fingerprint=str(row["request_fingerprint"]),
            state=JobState(str(row["state"])),
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
            lease_owner=None if row["lease_owner"] is None else str(row["lease_owner"]),
            lease_expires_at=None if row["lease_expires_at"] is None else float(row["lease_expires_at"]),
            attempts=int(row["attempts"]),
            owner_identity_hash=(
                None if row["owner_identity_hash"] is None else str(row["owner_identity_hash"])
            ),
            terminal_code=(
                None if row["terminal_code"] is None else TerminalCode(str(row["terminal_code"]))
            ),
            scope=str(row["scope"]),
        )

    def _row_to_upload(self, row: sqlite3.Row) -> UploadRecord:
        return UploadRecord(
            job_id=str(row["job_id"]),
            expected_size=int(row["expected_size"]),
            expected_sha256=str(row["expected_sha256"]),
            offset=int(row["offset"]),
            complete=bool(row["complete"]),
            updated_at=float(row["updated_at"]),
            actual_sha256=None if row["actual_sha256"] is None else str(row["actual_sha256"]),
        )

    def _begin_immediate(self) -> None:
        self._connection.execute("BEGIN IMMEDIATE")

    def _commit(self) -> None:
        self._connection.execute("COMMIT")

    def _rollback(self) -> None:
        self._connection.execute("ROLLBACK")

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                self._connection.close()
                self._closed = True

    def probe_writable(self) -> None:
        """Acquire and roll back a main-database write without persistent probe rows."""
        with self._lock:
            try:
                self._begin_immediate()
                self._connection.execute(
                    "CREATE TABLE readiness_probe(probe_id INTEGER PRIMARY KEY)"
                )
                self._connection.execute("INSERT INTO readiness_probe(probe_id) VALUES (1)")
            finally:
                if self._connection.in_transaction:
                    self._rollback()

    def create_job(
        self,
        *,
        owner_token_hash: str,
        idempotency_key: str,
        request_fingerprint: str,
        scope: str = "source_analysis",
    ) -> JobRecord:
        if not owner_token_hash or not idempotency_key or not request_fingerprint or not scope:
            raise ValueError("owner hash, idempotency key, and fingerprint are required")
        now = float(self._clock())
        with self._lock:
            self._begin_immediate()
            try:
                existing = self._connection.execute(
                    "SELECT * FROM jobs WHERE owner_token_hash=? AND idempotency_key=?",
                    (owner_token_hash, idempotency_key),
                ).fetchone()
                if existing is not None:
                    if str(existing["request_fingerprint"]) != request_fingerprint:
                        raise IdempotencyConflict("idempotency key belongs to a different request")
                    self._commit()
                    return self._row_to_job(existing)
                job_id = f"job_{secrets.token_urlsafe(18)}"
                self._connection.execute(
                    """
                    INSERT INTO jobs(
                        job_id, owner_token_hash, idempotency_key, request_fingerprint,
                        state, created_at, updated_at, attempts, scope
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
                    """,
                    (
                        job_id,
                        owner_token_hash,
                        idempotency_key,
                        request_fingerprint,
                        JobState.UPLOADING.value,
                        now,
                        now,
                        scope,
                    ),
                )
                row = self._connection.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
                self._commit()
                return self._row_to_job(row)
            except Exception:
                self._rollback()
                raise

    def get_job(self, job_id: str) -> JobRecord:
        with self._lock:
            row = self._connection.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
        if row is None:
            raise JobNotFound("job not found")
        return self._row_to_job(row)

    def create_or_rotate_api_job(
        self,
        *,
        owner_identity_hash: str,
        access_token_hash: str,
        idempotency_key: str,
        request_fingerprint: str,
        scope: str = "source_analysis",
        max_active_jobs_per_owner: int | None = None,
    ) -> tuple[JobRecord, bool]:
        """Create an API job or rotate its bearer hash on an idempotent retry."""
        if not all((owner_identity_hash, access_token_hash, idempotency_key, request_fingerprint, scope)):
            raise ValueError("API job identity and request fields are required")
        now = float(self._clock())
        with self._lock:
            self._begin_immediate()
            try:
                existing = self._connection.execute(
                    "SELECT * FROM jobs WHERE owner_identity_hash=? AND idempotency_key=?",
                    (owner_identity_hash, idempotency_key),
                ).fetchone()
                if existing is not None:
                    if str(existing["request_fingerprint"]) != request_fingerprint:
                        raise IdempotencyConflict("idempotency key belongs to a different request")
                    self._connection.execute(
                        "UPDATE jobs SET owner_token_hash=?, updated_at=? WHERE job_id=?",
                        (access_token_hash, now, existing["job_id"]),
                    )
                    row = self._connection.execute(
                        "SELECT * FROM jobs WHERE job_id=?", (existing["job_id"],)
                    ).fetchone()
                    self._commit()
                    return self._row_to_job(row), False
                if max_active_jobs_per_owner is not None:
                    if max_active_jobs_per_owner <= 0:
                        raise ValueError("active job limit must be positive")
                    terminal_values = tuple(state.value for state in TERMINAL_STATES)
                    active_count = int(
                        self._connection.execute(
                            """
                            SELECT COUNT(*) FROM jobs
                            WHERE owner_identity_hash=? AND state NOT IN (?, ?, ?)
                            """,
                            (owner_identity_hash, *terminal_values),
                        ).fetchone()[0]
                    )
                    if active_count >= max_active_jobs_per_owner:
                        raise ActiveJobLimitExceeded("owner has too many active jobs")
                job_id = f"job_{secrets.token_urlsafe(18)}"
                self._connection.execute(
                    """
                    INSERT INTO jobs(
                        job_id, owner_token_hash, owner_identity_hash, idempotency_key,
                        request_fingerprint, state, created_at, updated_at, attempts, scope
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                    """,
                    (
                        job_id,
                        access_token_hash,
                        owner_identity_hash,
                        idempotency_key,
                        request_fingerprint,
                        JobState.UPLOADING.value,
                        now,
                        now,
                        scope,
                    ),
                )
                row = self._connection.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
                self._commit()
                return self._row_to_job(row), True
            except Exception:
                self._rollback()
                raise

    def get_job_for_owner(self, job_id: str, *, presented_token: str, hasher: object) -> JobRecord:
        try:
            record = self.get_job(job_id)
        except JobNotFound:
            raise JobNotFound("job not found") from None
        verify = getattr(hasher, "verify", None)
        if not callable(verify) or not verify(presented_token, record.owner_token_hash):
            raise JobNotFound("job not found")
        return record

    def transition(
        self,
        job_id: str,
        expected_state: JobState,
        target_state: JobState,
    ) -> JobRecord:
        expected = JobState(expected_state)
        target = JobState(target_state)
        now = float(self._clock())
        with self._lock:
            self._begin_immediate()
            try:
                row = self._connection.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
                if row is None:
                    raise JobNotFound("job not found")
                current = JobState(str(row["state"]))
                if current != expected:
                    raise ConcurrentUpdate(f"expected {expected.value}, found {current.value}")
                if target not in ALLOWED_TRANSITIONS[current]:
                    raise InvalidTransition(f"cannot transition {current.value} to {target.value}")
                lease_owner = row["lease_owner"] if target in {JobState.RUNNING, JobState.CANCEL_REQUESTED} else None
                lease_expires_at = row["lease_expires_at"] if target in {JobState.RUNNING, JobState.CANCEL_REQUESTED} else None
                updated = self._connection.execute(
                    """
                    UPDATE jobs
                    SET state=?, updated_at=?, lease_owner=?, lease_expires_at=?
                    WHERE job_id=? AND state=?
                    """,
                    (target.value, now, lease_owner, lease_expires_at, job_id, expected.value),
                )
                if updated.rowcount != 1:
                    raise ConcurrentUpdate("job changed concurrently")
                result = self._connection.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
                self._commit()
                return self._row_to_job(result)
            except Exception:
                self._rollback()
                raise

    def lease_next(self, *, worker_id: str, lease_seconds: float) -> JobRecord | None:
        if not worker_id or lease_seconds <= 0:
            raise ValueError("worker id and positive lease are required")
        now = float(self._clock())
        with self._lock:
            self._begin_immediate()
            try:
                row = self._connection.execute(
                    "SELECT * FROM jobs WHERE state=? ORDER BY created_at, job_id LIMIT 1",
                    (JobState.QUEUED.value,),
                ).fetchone()
                if row is None:
                    self._commit()
                    return None
                updated = self._connection.execute(
                    """
                    UPDATE jobs
                    SET state=?, updated_at=?, lease_owner=?, lease_expires_at=?, attempts=attempts+1
                    WHERE job_id=? AND state=?
                    """,
                    (
                        JobState.RUNNING.value,
                        now,
                        worker_id,
                        now + lease_seconds,
                        row["job_id"],
                        JobState.QUEUED.value,
                    ),
                )
                if updated.rowcount != 1:
                    raise ConcurrentUpdate("queue changed concurrently")
                result = self._connection.execute(
                    "SELECT * FROM jobs WHERE job_id=?", (row["job_id"],)
                ).fetchone()
                self._commit()
                return self._row_to_job(result)
            except Exception:
                self._rollback()
                raise

    def heartbeat(self, job_id: str, *, worker_id: str, lease_seconds: float) -> JobRecord:
        if lease_seconds <= 0:
            raise ValueError("positive lease is required")
        now = float(self._clock())
        with self._lock:
            updated = self._connection.execute(
                """
                UPDATE jobs SET updated_at=?, lease_expires_at=?
                WHERE job_id=? AND state=? AND lease_owner=?
                """,
                (now, now + lease_seconds, job_id, JobState.RUNNING.value, worker_id),
            )
            if updated.rowcount != 1:
                raise ConcurrentUpdate("worker does not own the running lease")
        return self.get_job(job_id)

    def requeue_expired_leases(self) -> tuple[str, ...]:
        now = float(self._clock())
        with self._lock:
            self._begin_immediate()
            try:
                rows = self._connection.execute(
                    """
                    SELECT job_id FROM jobs
                    WHERE state=? AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
                    ORDER BY created_at, job_id
                    """,
                    (JobState.RUNNING.value, now),
                ).fetchall()
                job_ids = tuple(str(row["job_id"]) for row in rows)
                if job_ids:
                    self._connection.executemany(
                        """
                        UPDATE jobs
                        SET state=?, updated_at=?, lease_owner=NULL, lease_expires_at=NULL
                        WHERE job_id=? AND state=? AND lease_expires_at <= ?
                        """,
                        (
                            (JobState.QUEUED.value, now, job_id, JobState.RUNNING.value, now)
                            for job_id in job_ids
                        ),
                    )
                self._commit()
                return job_ids
            except Exception:
                self._rollback()
                raise

    def request_cancel(self, job_id: str) -> JobRecord:
        record = self.get_job(job_id)
        if record.state in TERMINAL_STATES or record.state == JobState.CANCEL_REQUESTED:
            return record
        target = JobState.CANCEL_REQUESTED if record.state == JobState.RUNNING else JobState.CANCELLED
        return self.transition(job_id, record.state, target)

    def expire_stale_jobs(self, *, stale_after_seconds: float) -> tuple[str, ...]:
        """Atomically terminalize stale work while preserving current active leases."""
        if stale_after_seconds <= 0:
            raise ValueError("stale job TTL must be positive")
        now = float(self._clock())
        cutoff = now - stale_after_seconds
        nonterminal_values = tuple(
            state.value
            for state in (
                JobState.UPLOADING,
                JobState.QUEUED,
                JobState.RUNNING,
                JobState.CANCEL_REQUESTED,
            )
        )
        placeholders = ",".join("?" for _ in nonterminal_values)
        with self._lock:
            self._begin_immediate()
            try:
                rows = self._connection.execute(
                    f"""
                    SELECT jobs.job_id, jobs.state
                    FROM jobs
                    LEFT JOIN uploads ON uploads.job_id = jobs.job_id
                    WHERE jobs.state IN ({placeholders})
                      AND (
                        (
                          jobs.state = ?
                          AND MAX(jobs.updated_at, COALESCE(uploads.updated_at, jobs.updated_at)) <= ?
                        )
                        OR (jobs.state <> ? AND jobs.updated_at <= ?)
                      )
                      AND (
                        jobs.state NOT IN (?, ?)
                        OR jobs.lease_expires_at IS NULL
                        OR jobs.lease_expires_at <= ?
                      )
                    ORDER BY jobs.created_at, jobs.job_id
                    """,
                    (
                        *nonterminal_values,
                        JobState.UPLOADING.value,
                        cutoff,
                        JobState.UPLOADING.value,
                        cutoff,
                        JobState.RUNNING.value,
                        JobState.CANCEL_REQUESTED.value,
                        now,
                    ),
                ).fetchall()
                expired_ids: list[str] = []
                for row in rows:
                    job_id = str(row["job_id"])
                    current = JobState(str(row["state"]))
                    target = (
                        JobState.CANCELLED
                        if current == JobState.CANCEL_REQUESTED
                        else JobState.FAILED
                    )
                    updated = self._connection.execute(
                        """
                        UPDATE jobs
                        SET state=?, updated_at=?, lease_owner=NULL, lease_expires_at=NULL,
                            terminal_code=?
                        WHERE job_id=? AND state=?
                        """,
                        (
                            target.value,
                            now,
                            TerminalCode.STALE_JOB_EXPIRED.value,
                            job_id,
                            current.value,
                        ),
                    )
                    if updated.rowcount != 1:
                        raise ConcurrentUpdate("stale job changed concurrently")
                    expired_ids.append(job_id)
                self._commit()
                return tuple(expired_ids)
            except Exception:
                self._rollback()
                raise

    def list_terminal_jobs_by_code(
        self,
        *,
        terminal_code: TerminalCode,
    ) -> tuple[str, ...]:
        code = TerminalCode(terminal_code)
        terminal_values = tuple(state.value for state in TERMINAL_STATES)
        placeholders = ",".join("?" for _ in terminal_values)
        with self._lock:
            rows = self._connection.execute(
                f"""
                SELECT job_id FROM jobs
                WHERE terminal_code=? AND state IN ({placeholders})
                ORDER BY created_at, job_id
                """,
                (code.value, *terminal_values),
            ).fetchall()
        return tuple(str(row["job_id"]) for row in rows)

    def purge_terminal_before(self, *, cutoff_timestamp: float) -> tuple[str, ...]:
        terminal_values = tuple(state.value for state in TERMINAL_STATES)
        placeholders = ",".join("?" for _ in terminal_values)
        with self._lock:
            self._begin_immediate()
            try:
                rows = self._connection.execute(
                    f"""
                    SELECT job_id FROM jobs
                    WHERE state IN ({placeholders}) AND updated_at < ?
                    ORDER BY created_at, job_id
                    """,
                    (*terminal_values, cutoff_timestamp),
                ).fetchall()
                job_ids = tuple(str(row["job_id"]) for row in rows)
                if job_ids:
                    self._connection.executemany("DELETE FROM jobs WHERE job_id=?", ((item,) for item in job_ids))
                self._commit()
                return job_ids
            except Exception:
                self._rollback()
                raise

    def create_upload(self, job_id: str, *, expected_size: int, expected_sha256: str) -> UploadRecord:
        now = float(self._clock())
        with self._lock:
            self._begin_immediate()
            try:
                job = self._connection.execute("SELECT state FROM jobs WHERE job_id=?", (job_id,)).fetchone()
                if job is None:
                    raise JobNotFound("job not found")
                existing = self._connection.execute("SELECT * FROM uploads WHERE job_id=?", (job_id,)).fetchone()
                if existing is not None:
                    if int(existing["expected_size"]) != expected_size or str(existing["expected_sha256"]) != expected_sha256:
                        raise IdempotencyConflict("upload was started with different integrity metadata")
                    self._commit()
                    return self._row_to_upload(existing)
                if JobState(str(job["state"])) != JobState.UPLOADING:
                    raise InvalidTransition("job is not accepting an upload")
                self._connection.execute(
                    """
                    INSERT INTO uploads(job_id, expected_size, expected_sha256, offset, complete, updated_at)
                    VALUES (?, ?, ?, 0, 0, ?)
                    """,
                    (job_id, expected_size, expected_sha256, now),
                )
                row = self._connection.execute("SELECT * FROM uploads WHERE job_id=?", (job_id,)).fetchone()
                self._commit()
                return self._row_to_upload(row)
            except Exception:
                self._rollback()
                raise

    def get_upload(self, job_id: str) -> UploadRecord:
        with self._lock:
            row = self._connection.execute("SELECT * FROM uploads WHERE job_id=?", (job_id,)).fetchone()
        if row is None:
            raise JobNotFound("upload not found")
        return self._row_to_upload(row)

    def advance_upload(self, job_id: str, *, expected_offset: int, new_offset: int) -> UploadRecord:
        now = float(self._clock())
        with self._lock:
            self._begin_immediate()
            try:
                updated = self._connection.execute(
                    """
                    UPDATE uploads SET offset=?, updated_at=?
                    WHERE job_id=? AND offset=? AND complete=0
                      AND EXISTS (
                        SELECT 1 FROM jobs
                        WHERE jobs.job_id=uploads.job_id AND jobs.state=?
                      )
                    """,
                    (new_offset, now, job_id, expected_offset, JobState.UPLOADING.value),
                )
                if updated.rowcount != 1:
                    raise ConcurrentUpdate("upload offset changed concurrently")
                refreshed = self._connection.execute(
                    "UPDATE jobs SET updated_at=? WHERE job_id=? AND state=?",
                    (now, job_id, JobState.UPLOADING.value),
                )
                if refreshed.rowcount != 1:
                    raise ConcurrentUpdate("job is no longer accepting upload progress")
                self._commit()
            except Exception:
                self._rollback()
                raise
        return self.get_upload(job_id)

    def mark_upload_complete(
        self,
        job_id: str,
        *,
        expected_offset: int,
        actual_sha256: str | None = None,
    ) -> UploadRecord:
        now = float(self._clock())
        with self._lock:
            self._begin_immediate()
            try:
                current_row = self._connection.execute(
                    "SELECT * FROM uploads WHERE job_id=?", (job_id,)
                ).fetchone()
                if current_row is None:
                    raise JobNotFound("upload not found")
                current = self._row_to_upload(current_row)
                if current.complete and current.offset == expected_offset:
                    self._commit()
                    return current
                updated = self._connection.execute(
                    """
                    UPDATE uploads SET complete=1, actual_sha256=?, updated_at=?
                    WHERE job_id=? AND offset=? AND expected_size=? AND complete=0
                    """,
                    (actual_sha256, now, job_id, expected_offset, expected_offset),
                )
                if updated.rowcount != 1:
                    raise ConcurrentUpdate("upload completion state changed concurrently")
                queued = self._connection.execute(
                    """
                    UPDATE jobs SET state=?, updated_at=?
                    WHERE job_id=? AND state=?
                    """,
                    (JobState.QUEUED.value, now, job_id, JobState.UPLOADING.value),
                )
                if queued.rowcount != 1:
                    raise ConcurrentUpdate("job is no longer awaiting upload completion")
                result = self._connection.execute("SELECT * FROM uploads WHERE job_id=?", (job_id,)).fetchone()
                self._commit()
                return self._row_to_upload(result)
            except Exception:
                self._rollback()
                raise


class JobStore:
    """Compatibility facade for the initial API contract; new code uses SQLiteJobStore."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS compatibility_jobs(
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    source_name TEXT NOT NULL,
                    state TEXT NOT NULL
                )
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    def create_job(self, *, owner_id: str, source_name: str) -> dict[str, str]:
        job_id = f"job_{secrets.token_urlsafe(18)}"
        with closing(self._connect()) as connection, connection:
            connection.execute(
                "INSERT INTO compatibility_jobs(id, owner_id, source_name, state) VALUES (?, ?, ?, ?)",
                (job_id, owner_id, source_name, "queued"),
            )
        return self.get_job(job_id, owner_id=owner_id)

    def get_job(self, job_id: str, *, owner_id: str) -> dict[str, str]:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT * FROM compatibility_jobs WHERE id=? AND owner_id=?", (job_id, owner_id)
            ).fetchone()
        if row is None:
            raise JobNotFound("job not found")
        return {"id": str(row["id"]), "sourceName": str(row["source_name"]), "state": str(row["state"])}

    def mark_running(self, job_id: str) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute("UPDATE compatibility_jobs SET state='running' WHERE id=?", (job_id,))

    def request_cancel(self, job_id: str, *, owner_id: str) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                "UPDATE compatibility_jobs SET state='cancel_requested' WHERE id=? AND owner_id=?",
                (job_id, owner_id),
            )

    def close(self) -> None:
        """Compatibility no-op: facade operations use short-lived connections."""
