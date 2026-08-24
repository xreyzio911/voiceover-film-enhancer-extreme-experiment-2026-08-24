from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import threading
import time
from contextlib import closing
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol


class TicketValidationError(ValueError):
    pass


class TicketReplayError(TicketValidationError):
    pass


@dataclass(frozen=True)
class TicketScope:
    owner_hash: str
    job_id: str
    upload_id: str
    operation: str
    max_bytes: int


@dataclass(frozen=True)
class TicketClaims:
    scope: TicketScope
    nonce: str
    expires_at: float


@dataclass(frozen=True)
class AdmissionScope:
    owner_hash: str
    size_bytes: int
    content_type: str
    idempotency_key: str
    scope: str
    sha256: str | None = None


@dataclass(frozen=True)
class AdmissionClaims:
    scope: AdmissionScope
    nonce: str
    expires_at: float


class InMemoryReplayStore:
    def __init__(self) -> None:
        self._seen: set[str] = set()
        self._lock = threading.Lock()

    def consume(self, nonce: str) -> None:
        digest = hashlib.sha256(nonce.encode("utf-8")).hexdigest()
        with self._lock:
            if digest in self._seen:
                raise TicketReplayError("Ticket was already consumed.")
            self._seen.add(digest)

class ReplayStore(Protocol):
    def consume(self, nonce: str) -> None: ...


class SQLiteReplayStore:
    """Durable one-time nonce consumption for restart-safe ticket replay defense."""

    def __init__(self, path: str | Path, *, timeout_seconds: float = 5.0) -> None:
        if timeout_seconds <= 0:
            raise ValueError("SQLite timeout must be positive")
        self.path = Path(path)
        self.timeout_seconds = timeout_seconds
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path, timeout=timeout_seconds)) as connection, connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS consumed_ticket_nonces(
                    nonce_sha256 TEXT PRIMARY KEY,
                    consumed_at REAL NOT NULL
                )
                """
            )

    def consume(self, nonce: str) -> None:
        digest = hashlib.sha256(nonce.encode("utf-8")).hexdigest()
        try:
            with closing(sqlite3.connect(self.path, timeout=self.timeout_seconds)) as connection, connection:
                connection.execute(
                    "INSERT INTO consumed_ticket_nonces(nonce_sha256, consumed_at) VALUES (?, ?)",
                    (digest, time.time()),
                )
        except sqlite3.IntegrityError as exc:
            raise TicketReplayError("Ticket was already consumed.") from exc

    def prune_before(self, cutoff: float) -> int:
        with closing(sqlite3.connect(self.path, timeout=self.timeout_seconds)) as connection, connection:
            cursor = connection.execute(
                "DELETE FROM consumed_ticket_nonces WHERE consumed_at < ?",
                (float(cutoff),),
            )
            return int(cursor.rowcount or 0)

    def probe_writable(self) -> None:
        """Roll back a bounded write so readiness never consumes a real nonce."""
        digest = hashlib.sha256(secrets.token_bytes(32)).hexdigest()
        with closing(
            sqlite3.connect(self.path, timeout=self.timeout_seconds)
        ) as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "INSERT INTO consumed_ticket_nonces(nonce_sha256, consumed_at) VALUES (?, ?)",
                    (digest, time.time()),
                )
            finally:
                if connection.in_transaction:
                    connection.rollback()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


class JobTokenHasher:
    def issue(self) -> str:
        return secrets.token_urlsafe(32)

    def hash(self, token: str) -> str:
        salt = secrets.token_bytes(16)
        digest = hashlib.pbkdf2_hmac("sha256", token.encode("utf-8"), salt, 120_000)
        return f"pbkdf2_sha256${_b64(salt)}${_b64(digest)}"

    def verify(self, token: str, encoded_hash: str) -> bool:
        if not token or len(token) < 32 or len(token) > 512 or not all(ch.isalnum() or ch in "_-" for ch in token):
            return False
        try:
            algorithm, salt_b64, digest_b64 = encoded_hash.split("$", 2)
            if algorithm != "pbkdf2_sha256":
                return False
            salt = _unb64(salt_b64)
            expected = _unb64(digest_b64)
            if len(salt) != 16 or len(expected) != 32:
                return False
        except Exception:
            return False
        actual = hashlib.pbkdf2_hmac("sha256", token.encode("utf-8"), salt, 120_000)
        return hmac.compare_digest(actual, expected)


class TicketAuthority:
    def __init__(self, *, secret: bytes, replay_store: ReplayStore, clock=time.time, max_ttl_seconds: int = 300):
        if len(secret) < 32:
            raise ValueError("Ticket HMAC secret must be at least 256 bits.")
        self.secret = secret
        self.replay_store = replay_store
        self.clock = clock
        self.max_ttl_seconds = max_ttl_seconds

    def issue(self, scope: TicketScope, *, ttl_seconds: int) -> str:
        if ttl_seconds <= 0 or ttl_seconds > self.max_ttl_seconds:
            raise ValueError("Ticket TTL is outside bounds.")
        if scope.max_bytes <= 0 or not all(
            (scope.owner_hash, scope.job_id, scope.upload_id, scope.operation)
        ):
            raise ValueError("Ticket scope is incomplete.")
        payload = {
            "scope": asdict(scope),
            "nonce": secrets.token_urlsafe(18),
            "expires_at": float(self.clock()) + ttl_seconds,
        }
        body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        signature = hmac.new(self.secret, body, hashlib.sha256).digest()
        return f"{_b64(body)}.{_b64(signature)}"

    def verify_and_consume(self, token: str, *, expected_scope: TicketScope, observed_bytes: int) -> TicketClaims:
        if not isinstance(token, str) or len(token) > 4096:
            raise TicketValidationError("Malformed ticket.")
        if observed_bytes < 0:
            raise TicketValidationError("Observed byte count cannot be negative.")
        try:
            body_b64, signature_b64 = token.split(".", 1)
            body = _unb64(body_b64)
            signature = _unb64(signature_b64)
        except Exception as exc:
            raise TicketValidationError("Malformed ticket.") from exc
        expected_signature = hmac.new(self.secret, body, hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected_signature):
            raise TicketValidationError("Invalid ticket signature.")
        try:
            payload = json.loads(body.decode("utf-8"))
            scope = TicketScope(**payload["scope"])
            expires_at = float(payload["expires_at"])
            nonce = str(payload["nonce"])
        except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise TicketValidationError("Malformed ticket claims.") from exc
        if scope != expected_scope:
            raise TicketValidationError("Ticket scope mismatch.")
        if expires_at <= float(self.clock()):
            raise TicketValidationError("Ticket expired.")
        if observed_bytes > scope.max_bytes:
            raise TicketValidationError("Ticket byte scope exceeded.")
        if len(nonce) < 16 or len(nonce) > 128:
            raise TicketValidationError("Malformed ticket nonce.")
        self.replay_store.consume(nonce)
        return TicketClaims(scope=scope, nonce=nonce, expires_at=expires_at)


class AdmissionTicketAuthority:
    """HMAC admission tickets bound to metadata but carrying server-issued owner identity."""

    def __init__(self, *, secret: bytes, replay_store: ReplayStore, clock=time.time, max_ttl_seconds: int = 300):
        if len(secret) < 32:
            raise ValueError("Ticket HMAC secret must be at least 256 bits.")
        self.secret = secret
        self.replay_store = replay_store
        self.clock = clock
        self.max_ttl_seconds = max_ttl_seconds

    def issue(self, scope: AdmissionScope, *, ttl_seconds: int) -> tuple[str, float]:
        if ttl_seconds <= 0 or ttl_seconds > self.max_ttl_seconds:
            raise ValueError("Ticket TTL is outside bounds.")
        expires_at = float(self.clock()) + ttl_seconds
        payload = {
            "scope": asdict(scope),
            "nonce": secrets.token_urlsafe(18),
            "expires_at": expires_at,
        }
        body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        signature = hmac.new(self.secret, body, hashlib.sha256).digest()
        return f"{_b64(body)}.{_b64(signature)}", expires_at

    def verify_and_consume(
        self,
        token: str,
        *,
        size_bytes: int,
        content_type: str,
        idempotency_key: str,
        scope: str,
        sha256: str | None,
    ) -> AdmissionClaims:
        if not token or len(token) > 4096:
            raise TicketValidationError("Malformed ticket.")
        try:
            body_b64, signature_b64 = token.split(".", 1)
            body = _unb64(body_b64)
            signature = _unb64(signature_b64)
        except Exception as exc:
            raise TicketValidationError("Malformed ticket.") from exc
        expected_signature = hmac.new(self.secret, body, hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected_signature):
            raise TicketValidationError("Invalid ticket signature.")
        try:
            payload = json.loads(body.decode("utf-8"))
            ticket_scope = AdmissionScope(**payload["scope"])
            expires_at = float(payload["expires_at"])
            nonce = str(payload["nonce"])
        except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise TicketValidationError("Malformed ticket claims.") from exc
        expected_metadata = (size_bytes, content_type, idempotency_key, scope, sha256)
        actual_metadata = (
            ticket_scope.size_bytes,
            ticket_scope.content_type,
            ticket_scope.idempotency_key,
            ticket_scope.scope,
            ticket_scope.sha256,
        )
        if actual_metadata != expected_metadata:
            raise TicketValidationError("Ticket scope mismatch.")
        if expires_at <= float(self.clock()):
            raise TicketValidationError("Ticket expired.")
        self.replay_store.consume(nonce)
        return AdmissionClaims(scope=ticket_scope, nonce=nonce, expires_at=expires_at)


def create_upload_ticket(*, secret: bytes, job_id: str, file_sha256: str, expires_in_seconds: int, now=time.time) -> str:
    if len(secret) < 32:
        raise ValueError("Ticket HMAC secret must be at least 256 bits.")
    if expires_in_seconds <= 0 or expires_in_seconds > 300:
        raise ValueError("Ticket TTL is outside bounds.")
    if not re.fullmatch(r"[0-9a-f]{64}", file_sha256):
        raise ValueError("file_sha256 must be canonical lowercase SHA-256")
    payload = {
        "job_id": job_id,
        "file_sha256": file_sha256,
        "expires_at": float(now()) + expires_in_seconds,
    }
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(secret, body, hashlib.sha256).digest()
    return f"{_b64(body)}.{_b64(signature)}"


def verify_upload_ticket(*, secret: bytes, ticket: str, job_id: str, file_sha256: str, now=time.time) -> bool:
    try:
        if len(secret) < 32 or len(ticket) > 4096:
            return False
        body_b64, signature_b64 = ticket.split(".", 1)
        body = _unb64(body_b64)
        signature = _unb64(signature_b64)
        expected = hmac.new(secret, body, hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected):
            return False
        payload = json.loads(body.decode("utf-8"))
        return (
            payload.get("job_id") == job_id
            and payload.get("file_sha256") == file_sha256
            and float(payload.get("expires_at", 0)) > float(now())
        )
    except Exception:
        return False
