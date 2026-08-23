from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from contract_support import MutableClock, require_symbols


class SQLiteJobStoreContractTests(unittest.TestCase):
    MODULE = "extreme_worker.job_store"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "worker.sqlite3"
        self.clock = MutableClock()
        (
            self.Store,
            self.JobState,
            self.InvalidTransition,
            self.ConcurrentUpdate,
            self.IdempotencyConflict,
            self.JobNotFound,
        ) = require_symbols(
            self,
            self.MODULE,
            "SQLiteJobStore",
            "JobState",
            "InvalidTransition",
            "ConcurrentUpdate",
            "IdempotencyConflict",
            "JobNotFound",
        )
        self.store = self.Store(self.db_path, clock=self.clock)

    def tearDown(self) -> None:
        if hasattr(self, "store"):
            self.store.close()
        self.temp_dir.cleanup()

    def _create(self, *, owner_hash: str = "owner_hash_a", key: str = "request-a", fingerprint: str = "f" * 64):
        return self.store.create_job(
            owner_token_hash=owner_hash,
            idempotency_key=key,
            request_fingerprint=fingerprint,
        )

    def test_job_creation_is_restart_safe(self) -> None:
        created = self._create()
        self.assertEqual(created.state, self.JobState.UPLOADING)
        self.store.close()
        reopened = self.Store(self.db_path, clock=self.clock)
        self.store = reopened
        restored = reopened.get_job(created.job_id)
        self.assertEqual(restored.job_id, created.job_id)
        self.assertEqual(restored.owner_token_hash, "owner_hash_a")
        self.assertEqual(restored.state, self.JobState.UPLOADING)

    def test_idempotency_is_scoped_to_owner_and_request_fingerprint(self) -> None:
        first = self._create()
        retry = self._create()
        self.assertEqual(retry.job_id, first.job_id)
        other_owner = self._create(owner_hash="owner_hash_b")
        self.assertNotEqual(other_owner.job_id, first.job_id)
        with self.assertRaises(self.IdempotencyConflict):
            self._create(fingerprint="0" * 64)

    def test_compare_and_swap_transition_rejects_stale_expected_state(self) -> None:
        job = self._create()
        queued = self.store.transition(
            job.job_id,
            expected_state=self.JobState.UPLOADING,
            target_state=self.JobState.QUEUED,
        )
        self.assertEqual(queued.state, self.JobState.QUEUED)
        with self.assertRaises(self.ConcurrentUpdate):
            self.store.transition(
                job.job_id,
                expected_state=self.JobState.UPLOADING,
                target_state=self.JobState.CANCELLED,
            )

    def test_terminal_states_cannot_be_reopened(self) -> None:
        job = self._create()
        self.store.transition(job.job_id, self.JobState.UPLOADING, self.JobState.CANCELLED)
        with self.assertRaises(self.InvalidTransition):
            self.store.transition(job.job_id, self.JobState.CANCELLED, self.JobState.QUEUED)

    def test_lease_is_atomic_across_store_instances(self) -> None:
        job = self._create()
        self.store.transition(job.job_id, self.JobState.UPLOADING, self.JobState.QUEUED)
        second = self.Store(self.db_path, clock=self.clock)
        try:
            leased = self.store.lease_next(worker_id="worker-a", lease_seconds=30)
            self.assertEqual(leased.job_id, job.job_id)
            self.assertEqual(leased.state, self.JobState.RUNNING)
            self.assertEqual(leased.lease_owner, "worker-a")
            self.assertIsNone(second.lease_next(worker_id="worker-b", lease_seconds=30))
        finally:
            second.close()

    def test_expired_lease_is_requeued_and_attempt_count_is_preserved(self) -> None:
        job = self._create()
        self.store.transition(job.job_id, self.JobState.UPLOADING, self.JobState.QUEUED)
        first_lease = self.store.lease_next(worker_id="worker-a", lease_seconds=20)
        self.assertEqual(first_lease.attempts, 1)
        clock_before_expiry = self.clock.value
        self.assertEqual(self.store.requeue_expired_leases(), ())
        self.assertEqual(self.clock.value, clock_before_expiry)
        self.clock.advance(21)
        self.assertEqual(self.store.requeue_expired_leases(), (job.job_id,))
        requeued = self.store.get_job(job.job_id)
        self.assertEqual(requeued.state, self.JobState.QUEUED)
        self.assertIsNone(requeued.lease_owner)
        second_lease = self.store.lease_next(worker_id="worker-b", lease_seconds=20)
        self.assertEqual(second_lease.attempts, 2)

    def test_heartbeat_requires_current_lease_owner(self) -> None:
        job = self._create()
        self.store.transition(job.job_id, self.JobState.UPLOADING, self.JobState.QUEUED)
        self.store.lease_next(worker_id="worker-a", lease_seconds=20)
        with self.assertRaises(self.ConcurrentUpdate):
            self.store.heartbeat(job.job_id, worker_id="worker-b", lease_seconds=20)
        refreshed = self.store.heartbeat(job.job_id, worker_id="worker-a", lease_seconds=40)
        self.assertGreater(refreshed.lease_expires_at, self.clock.value + 20)

    def test_cancellation_is_immediate_before_run_and_cooperative_during_run(self) -> None:
        queued_job = self._create(key="queued")
        self.store.transition(queued_job.job_id, self.JobState.UPLOADING, self.JobState.QUEUED)
        cancelled = self.store.request_cancel(queued_job.job_id)
        self.assertEqual(cancelled.state, self.JobState.CANCELLED)

        running_job = self._create(key="running")
        self.store.transition(running_job.job_id, self.JobState.UPLOADING, self.JobState.QUEUED)
        self.store.lease_next(worker_id="worker-a", lease_seconds=30)
        requested = self.store.request_cancel(running_job.job_id)
        self.assertEqual(requested.state, self.JobState.CANCEL_REQUESTED)
        acknowledged = self.store.transition(
            running_job.job_id,
            self.JobState.CANCEL_REQUESTED,
            self.JobState.CANCELLED,
        )
        self.assertEqual(acknowledged.state, self.JobState.CANCELLED)

    def test_cancel_is_idempotent(self) -> None:
        job = self._create()
        first = self.store.request_cancel(job.job_id)
        second = self.store.request_cancel(job.job_id)
        self.assertEqual(first.state, self.JobState.CANCELLED)
        self.assertEqual(second.state, self.JobState.CANCELLED)

    def test_wrong_owner_is_indistinguishable_from_missing_job(self) -> None:
        hasher_type, = require_symbols(self, "extreme_worker.security", "JobTokenHasher")
        hasher = hasher_type()
        raw_token = hasher.issue()
        job = self._create(owner_hash=hasher.hash(raw_token))
        self.assertEqual(
            self.store.get_job_for_owner(job.job_id, presented_token=raw_token, hasher=hasher).job_id,
            job.job_id,
        )
        with self.assertRaises(self.JobNotFound):
            self.store.get_job_for_owner(job.job_id, presented_token=hasher.issue(), hasher=hasher)
        with self.assertRaises(self.JobNotFound):
            self.store.get_job_for_owner("job_missing", presented_token=raw_token, hasher=hasher)

    def test_active_job_limit_is_atomic_but_allows_idempotent_token_rotation(self) -> None:
        ActiveJobLimitExceeded, = require_symbols(
            self,
            "extreme_worker.job_store",
            "ActiveJobLimitExceeded",
        )
        first, created = self.store.create_or_rotate_api_job(
            owner_identity_hash="a" * 64,
            access_token_hash="token-hash-1",
            idempotency_key="limited-1",
            request_fingerprint="fingerprint-1",
            max_active_jobs_per_owner=1,
        )
        self.assertTrue(created)
        retried, created = self.store.create_or_rotate_api_job(
            owner_identity_hash="a" * 64,
            access_token_hash="token-hash-2",
            idempotency_key="limited-1",
            request_fingerprint="fingerprint-1",
            max_active_jobs_per_owner=1,
        )
        self.assertFalse(created)
        self.assertEqual(retried.job_id, first.job_id)
        with self.assertRaises(ActiveJobLimitExceeded):
            self.store.create_or_rotate_api_job(
                owner_identity_hash="a" * 64,
                access_token_hash="token-hash-3",
                idempotency_key="limited-2",
                request_fingerprint="fingerprint-2",
                max_active_jobs_per_owner=1,
            )

    def test_raw_job_token_is_never_persisted(self) -> None:
        hasher_type, = require_symbols(self, "extreme_worker.security", "JobTokenHasher")
        hasher = hasher_type()
        raw_token = hasher.issue()
        self._create(owner_hash=hasher.hash(raw_token))
        self.store.close()
        self.assertNotIn(raw_token.encode("ascii"), self.db_path.read_bytes())
        self.store = self.Store(self.db_path, clock=self.clock)

    def test_retention_deletes_only_old_terminal_jobs(self) -> None:
        active_states = (
            self.JobState.UPLOADING,
            self.JobState.RUNNING,
            self.JobState.CANCEL_REQUESTED,
            self.JobState.QUEUED,
        )
        active_ids = []
        for index, target_state in enumerate(active_states):
            job = self._create(key=f"active-{index}")
            if target_state != self.JobState.UPLOADING:
                self.store.transition(job.job_id, self.JobState.UPLOADING, self.JobState.QUEUED)
            if target_state in (self.JobState.RUNNING, self.JobState.CANCEL_REQUESTED):
                self.store.lease_next(worker_id=f"worker-{index}", lease_seconds=600)
            if target_state == self.JobState.CANCEL_REQUESTED:
                self.store.request_cancel(job.job_id)
            active_ids.append(job.job_id)

        terminal = self._create(key="terminal")
        self.store.transition(terminal.job_id, self.JobState.UPLOADING, self.JobState.CANCELLED)
        self.clock.advance(3_600)
        deleted = self.store.purge_terminal_before(cutoff_timestamp=self.clock.value - 60)
        self.assertEqual(deleted, (terminal.job_id,))
        for job_id in active_ids:
            with self.subTest(job_id=job_id):
                self.assertEqual(self.store.get_job(job_id).job_id, job_id)

    def test_stale_nonterminal_expiry_is_state_safe_idempotent_and_restart_durable(self) -> None:
        active = self._create(key="active-lease")
        self.store.transition(active.job_id, self.JobState.UPLOADING, self.JobState.QUEUED)
        self.store.lease_next(worker_id="worker-active", lease_seconds=10_000)

        uploading = self._create(key="stale-uploading")
        queued = self._create(key="stale-queued")
        self.store.transition(queued.job_id, self.JobState.UPLOADING, self.JobState.QUEUED)
        running = self._create(key="stale-running")
        self.store.transition(running.job_id, self.JobState.UPLOADING, self.JobState.QUEUED)
        self.store.transition(running.job_id, self.JobState.QUEUED, self.JobState.RUNNING)
        cancelling = self._create(key="stale-cancelling")
        self.store.transition(cancelling.job_id, self.JobState.UPLOADING, self.JobState.QUEUED)
        self.store.transition(cancelling.job_id, self.JobState.QUEUED, self.JobState.RUNNING)
        self.store.request_cancel(cancelling.job_id)

        self.clock.advance(7_201)
        expired = self.store.expire_stale_jobs(stale_after_seconds=7_200)

        self.assertEqual(
            set(expired),
            {uploading.job_id, queued.job_id, running.job_id, cancelling.job_id},
        )
        for job_id in (uploading.job_id, queued.job_id, running.job_id):
            with self.subTest(job_id=job_id):
                record = self.store.get_job(job_id)
                self.assertEqual(record.state, self.JobState.FAILED)
                self.assertEqual(record.terminal_code, "stale_job_expired")
                self.assertIsNone(record.lease_owner)
                self.assertIsNone(record.lease_expires_at)
        cancelled = self.store.get_job(cancelling.job_id)
        self.assertEqual(cancelled.state, self.JobState.CANCELLED)
        self.assertEqual(cancelled.terminal_code, "stale_job_expired")

        preserved = self.store.get_job(active.job_id)
        self.assertEqual(preserved.state, self.JobState.RUNNING)
        self.assertEqual(preserved.lease_owner, "worker-active")
        self.assertIsNone(preserved.terminal_code)
        self.assertEqual(self.store.expire_stale_jobs(stale_after_seconds=7_200), ())

        self.store.close()
        self.store = self.Store(self.db_path, clock=self.clock)
        restored = self.store.get_job(uploading.job_id)
        self.assertEqual(restored.state, self.JobState.FAILED)
        self.assertEqual(restored.terminal_code, "stale_job_expired")

    def test_upload_progress_refreshes_stale_job_activity(self) -> None:
        job = self._create(key="active-upload")
        self.store.create_upload(job.job_id, expected_size=2, expected_sha256="a" * 64)
        self.clock.advance(7_199)
        self.store.advance_upload(job.job_id, expected_offset=0, new_offset=1)
        self.clock.advance(2)

        self.assertEqual(self.store.expire_stale_jobs(stale_after_seconds=7_200), ())
        self.assertEqual(self.store.get_job(job.job_id).state, self.JobState.UPLOADING)

        self.clock.advance(7_201)
        self.assertEqual(self.store.expire_stale_jobs(stale_after_seconds=7_200), (job.job_id,))
        self.assertEqual(self.store.get_job(job.job_id).terminal_code, "stale_job_expired")

    def test_legacy_database_migrates_terminal_code_without_losing_jobs(self) -> None:
        self.store.close()
        legacy_path = Path(self.temp_dir.name) / "legacy.sqlite3"
        with closing(sqlite3.connect(legacy_path)) as connection, connection:
            connection.executescript(
                """
                CREATE TABLE jobs (
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
                    owner_identity_hash TEXT
                );
                CREATE TABLE uploads (
                    job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
                    expected_size INTEGER NOT NULL,
                    expected_sha256 TEXT NOT NULL,
                    offset INTEGER NOT NULL DEFAULT 0,
                    complete INTEGER NOT NULL DEFAULT 0,
                    actual_sha256 TEXT,
                    updated_at REAL NOT NULL
                );
                INSERT INTO jobs(
                    job_id, owner_token_hash, idempotency_key, request_fingerprint,
                    state, created_at, updated_at, attempts, owner_identity_hash
                ) VALUES (
                    'job_legacy', 'owner', 'legacy-key', 'legacy-fingerprint',
                    'uploading', 0, 0, 0, NULL
                );
                """
            )

        self.store = self.Store(legacy_path, clock=self.clock)
        restored = self.store.get_job("job_legacy")
        self.assertEqual(restored.state, self.JobState.UPLOADING)
        self.assertIsNone(restored.terminal_code)
        with closing(sqlite3.connect(legacy_path)) as connection:
            columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(jobs)")}
        self.assertIn("terminal_code", columns)


if __name__ == "__main__":
    unittest.main()
