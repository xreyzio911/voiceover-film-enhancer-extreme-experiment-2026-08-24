from __future__ import annotations

import math
import threading
from pathlib import Path
from typing import Callable

from .wav_validation import WavLimits, inspect_wav_file, validate_float_sample_values


class LocalFallbackAnalyzer:
    """Dependency-free advisory fallback for explicitly configured local/test apps."""

    def analyze_wav(self, path: Path, *, job_id: str, source_sha256: str) -> dict[str, object]:
        del job_id
        source_path = Path(path)
        upload_bytes = source_path.stat().st_size
        info = inspect_wav_file(
            source_path,
            WavLimits(
                max_upload_bytes=max(1, upload_bytes),
                allowed_sample_rates=frozenset({16_000, 24_000, 44_100, 48_000}),
                allowed_channels=frozenset({1, 2}),
                allowed_sample_width_bytes=frozenset({2, 3, 4}),
                max_duration_seconds=1_000_000_000.0,
                max_decoded_frames=max(1, upload_bytes),
            ),
        )
        validate_float_sample_values(source_path, info)
        duration_ms = info.duration_seconds * 1000.0
        return {
            "schemaVersion": 1,
            "advisoryOnly": True,
            "canBlockDelivery": False,
            "canChangeGainDb": False,
            "levelAuthority": "gainPlanner",
            "modelSetId": "unavailable-local-fallback",
            "source": {
                "sha256": source_sha256,
                "durationMs": round(duration_ms, 3),
                "sampleRate": info.sample_rate,
                "channels": info.channels,
            },
            "vad": {"frameMs": 10, "frames": []},
            "metrics": {
                "dnsmos.ovrl": {"value": None, "available": False, "higherIsBetter": True}
            },
            "models": [],
            "telemetry": {
                "runtimeStatus": "degraded",
                "reason": "local-placeholder",
                "provenanceKind": "configured-not-executed",
                "audioMutation": False,
                "candidateSelected": False,
                "gainDbChanged": False,
            },
        }


class LazyRuntimeAnalyzer:
    def __init__(self) -> None:
        self.fallback = LocalFallbackAnalyzer()

    def analyze_wav(self, path: Path, *, job_id: str, source_sha256: str) -> dict[str, object]:
        try:
            from .inference import get_runtime

            return get_runtime().analyze_wav(path, job_id=job_id, source_sha256=source_sha256)
        except Exception:
            return self.fallback.analyze_wav(path, job_id=job_id, source_sha256=source_sha256)


class RateLimiter:
    def __init__(self, *, maximum: int, window_seconds: float, clock: Callable[[], float]) -> None:
        self.maximum = maximum
        self.window_seconds = window_seconds
        self.clock = clock
        self.guard = threading.Lock()
        self.buckets: dict[str, tuple[float, int]] = {}

    def allow(self, client_key: str) -> tuple[bool, int]:
        now = float(self.clock())
        with self.guard:
            started_at, count = self.buckets.get(client_key, (now, 0))
            if now - started_at >= self.window_seconds:
                started_at, count = now, 0
            if count >= self.maximum:
                retry_after = max(1, math.ceil(self.window_seconds - (now - started_at)))
                return False, retry_after
            self.buckets = {**self.buckets, client_key: (started_at, count + 1)}
            return True, 0
