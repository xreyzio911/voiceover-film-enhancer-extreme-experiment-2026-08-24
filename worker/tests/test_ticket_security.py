from __future__ import annotations

import hashlib
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from contract_support import MutableClock, require_symbols


class UploadTicketContractTests(unittest.TestCase):
    MODULE = "extreme_worker.security"

    def _types(self):
        return require_symbols(
            self,
            self.MODULE,
            "TicketAuthority",
            "TicketScope",
            "InMemoryReplayStore",
            "TicketValidationError",
            "TicketReplayError",
        )

    def _authority(self):
        authority_type, scope_type, replay_store_type, validation_error, replay_error = self._types()
        clock = MutableClock()
        authority = authority_type(
            secret=b"t" * 32,
            replay_store=replay_store_type(),
            clock=clock,
            max_ttl_seconds=300,
        )
        scope = scope_type(
            owner_hash="owner_5c80a7",
            job_id="job_01JEXTREME000000000000001",
            upload_id="source",
            operation="upload",
            max_bytes=1024,
        )
        return authority, scope, clock, validation_error, replay_error

    def test_valid_ticket_is_consumed_once(self) -> None:
        authority, scope, _, _, replay_error = self._authority()
        token = authority.issue(scope, ttl_seconds=60)
        claims = authority.verify_and_consume(token, expected_scope=scope, observed_bytes=512)
        self.assertEqual(claims.scope, scope)
        with self.assertRaises(replay_error):
            authority.verify_and_consume(token, expected_scope=scope, observed_bytes=512)

    def test_signature_tampering_is_rejected(self) -> None:
        authority, scope, _, validation_error, _ = self._authority()
        token = authority.issue(scope, ttl_seconds=60)
        pivot = max(1, len(token) // 2)
        replacement = "A" if token[pivot] != "A" else "B"
        tampered = f"{token[:pivot]}{replacement}{token[pivot + 1:]}"
        with self.assertRaises(validation_error):
            authority.verify_and_consume(tampered, expected_scope=scope, observed_bytes=512)

    def test_scope_mismatch_is_rejected_without_consuming_nonce(self) -> None:
        authority, scope, _, validation_error, _ = self._authority()
        _, scope_type, _, _, _ = self._types()
        wrong_scope = scope_type(
            owner_hash=scope.owner_hash,
            job_id="job_01JEXTREME000000000000002",
            upload_id=scope.upload_id,
            operation=scope.operation,
            max_bytes=scope.max_bytes,
        )
        token = authority.issue(scope, ttl_seconds=60)
        with self.assertRaises(validation_error):
            authority.verify_and_consume(token, expected_scope=wrong_scope, observed_bytes=512)
        claims = authority.verify_and_consume(token, expected_scope=scope, observed_bytes=512)
        self.assertEqual(claims.scope, scope)

    def test_expired_ticket_is_rejected(self) -> None:
        authority, scope, clock, validation_error, _ = self._authority()
        token = authority.issue(scope, ttl_seconds=30)
        clock.advance(31)
        with self.assertRaises(validation_error):
            authority.verify_and_consume(token, expected_scope=scope, observed_bytes=1)

    def test_ticket_cannot_authorize_more_bytes_than_its_scope(self) -> None:
        authority, scope, _, validation_error, _ = self._authority()
        token = authority.issue(scope, ttl_seconds=60)
        with self.assertRaises(validation_error):
            authority.verify_and_consume(token, expected_scope=scope, observed_bytes=1025)

    def test_ticket_ttl_is_bounded(self) -> None:
        authority, scope, _, _, _ = self._authority()
        with self.assertRaises(ValueError):
            authority.issue(scope, ttl_seconds=301)
        with self.assertRaises(ValueError):
            authority.issue(scope, ttl_seconds=0)

    def test_hmac_secret_must_have_at_least_256_bits(self) -> None:
        authority_type, _, replay_store_type, _, _ = self._types()
        with self.assertRaises(ValueError):
            authority_type(
                secret=b"short",
                replay_store=replay_store_type(),
                clock=MutableClock(),
                max_ttl_seconds=300,
            )

    def test_ticket_for_another_operation_is_rejected(self) -> None:
        authority, scope, _, validation_error, _ = self._authority()
        _, scope_type, _, _, _ = self._types()
        download_scope = scope_type(
            owner_hash=scope.owner_hash,
            job_id=scope.job_id,
            upload_id=scope.upload_id,
            operation="download",
            max_bytes=scope.max_bytes,
        )
        token = authority.issue(scope, ttl_seconds=60)
        with self.assertRaises(validation_error):
            authority.verify_and_consume(token, expected_scope=download_scope, observed_bytes=10)


class SQLiteReplayStoreRetentionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "tickets.sqlite3"
        self.store_type, self.replay_error = require_symbols(
            self,
            "extreme_worker.security",
            "SQLiteReplayStore",
            "TicketReplayError",
        )
        self.store = self.store_type(self.database_path)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _insert(self, nonce: str, *, consumed_at: float) -> None:
        digest = hashlib.sha256(nonce.encode("utf-8")).hexdigest()
        with closing(sqlite3.connect(self.database_path)) as connection, connection:
            connection.execute(
                "INSERT INTO consumed_ticket_nonces(nonce_sha256, consumed_at) VALUES (?, ?)",
                (digest, consumed_at),
            )

    def _contains(self, nonce: str) -> bool:
        digest = hashlib.sha256(nonce.encode("utf-8")).hexdigest()
        with closing(sqlite3.connect(self.database_path)) as connection:
            row = connection.execute(
                "SELECT 1 FROM consumed_ticket_nonces WHERE nonce_sha256 = ?",
                (digest,),
            ).fetchone()
        return row is not None

    def test_prune_before_removes_only_rows_strictly_older_than_cutoff(self) -> None:
        cutoff = 1_800_000_000.0
        self._insert("old-nonce-value-0001", consumed_at=cutoff - 0.001)
        self._insert("boundary-nonce-0002", consumed_at=cutoff)
        self._insert("recent-nonce-value-0003", consumed_at=cutoff + 0.001)

        deleted = self.store.prune_before(cutoff)

        self.assertEqual(deleted, 1)
        self.assertFalse(self._contains("old-nonce-value-0001"))
        self.assertTrue(self._contains("boundary-nonce-0002"))
        self.assertTrue(self._contains("recent-nonce-value-0003"))

    def test_pruning_expired_row_preserves_recent_nonce_replay_protection(self) -> None:
        cutoff = 1_800_000_000.0
        old_nonce = "old-nonce-value-0004"
        recent_nonce = "recent-nonce-value-0005"
        self._insert(old_nonce, consumed_at=cutoff - 1.0)
        self._insert(recent_nonce, consumed_at=cutoff + 1.0)

        self.assertEqual(self.store.prune_before(cutoff), 1)

        self.store.consume(old_nonce)
        with self.assertRaises(self.replay_error):
            self.store.consume(recent_nonce)


if __name__ == "__main__":
    unittest.main()
