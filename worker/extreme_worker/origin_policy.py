from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlsplit


def _canonical_origin(origin: str) -> str:
    value = origin.strip()
    if not value or value == "null" or "*" in value:
        raise ValueError("CORS origins must be explicit HTTP(S) origins")
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("CORS origin must not contain credentials, paths, queries, or fragments")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("CORS origin contains an invalid port") from exc
    default_port = (parsed.scheme == "https" and port == 443) or (parsed.scheme == "http" and port == 80)
    authority = parsed.hostname.lower()
    if port is not None and not default_port:
        authority = f"{authority}:{port}"
    return f"{parsed.scheme}://{authority}"


@dataclass(frozen=True)
class OriginPolicy:
    allowed_origins: tuple[str, ...]

    def __init__(self, allowed_origins: list[str] | tuple[str, ...]) -> None:
        canonical = tuple(dict.fromkeys(_canonical_origin(origin) for origin in allowed_origins))
        object.__setattr__(self, "allowed_origins", canonical)

    def allows(self, request_origin: str | None) -> bool:
        if request_origin is None or not request_origin.strip():
            return True
        try:
            canonical = _canonical_origin(request_origin)
        except ValueError:
            return False
        return canonical in self.allowed_origins


def build_cors_headers(request_origin: str | None, allowed_origins: list[str] | tuple[str, ...]) -> dict[str, str]:
    origin = (request_origin or "").strip()
    policy = OriginPolicy(allowed_origins)
    if not origin or not policy.allows(origin):
        return {"Vary": "Origin"}
    canonical = _canonical_origin(origin)
    return {
        "Access-Control-Allow-Origin": canonical,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Upload-Offset",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, PATCH, DELETE, OPTIONS",
        "Vary": "Origin",
    }
