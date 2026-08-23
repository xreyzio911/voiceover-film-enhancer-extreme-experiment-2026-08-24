from __future__ import annotations

import unittest

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


if __name__ == "__main__":
    unittest.main()

