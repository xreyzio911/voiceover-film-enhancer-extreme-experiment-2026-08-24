from __future__ import annotations

import math
import threading
import wave
from pathlib import Path
from typing import Callable

from .model_runtime import DEFAULT_RUNTIME_ARTIFACTS, RuntimeConfig, model_set_id


class LocalFallbackAnalyzer:
    """Dependency-free advisory fallback for explicitly configured local/test apps."""

    def analyze_wav(self, path: Path, *, job_id: str, source_sha256: str) -> dict[str, object]:
        del job_id
        with wave.open(str(path), "rb") as source:
            sample_rate = source.getframerate()
            channels = source.getnchannels()
            duration_ms = source.getnframes() * 1000.0 / sample_rate
        frames = [
            {
                "startMs": index * 10,
                "endMs": min(duration_ms, (index + 1) * 10),
                "speechProbability": 0.0,
            }
            for index in range(max(1, math.ceil(duration_ms / 10.0)))
            if index * 10 < duration_ms
        ]
        runtime_config = RuntimeConfig.from_env()
        declared = [item for item in DEFAULT_RUNTIME_ARTIFACTS if item.bundled_by_default]
        return {
            "schemaVersion": 1,
            "advisoryOnly": True,
            "canBlockDelivery": False,
            "canChangeGainDb": False,
            "levelAuthority": "gainPlanner",
            "modelSetId": model_set_id(runtime_config),
            "source": {
                "sha256": source_sha256,
                "durationMs": round(duration_ms, 3),
                "sampleRate": sample_rate,
                "channels": channels,
            },
            "vad": {"frameMs": 10, "frames": frames},
            "metrics": {
                "dnsmos.ovrl": {"value": None, "available": False, "higherIsBetter": True}
            },
            "models": [
                {
                    "id": item.id,
                    "version": item.version,
                    "revision": item.revision,
                    "sha256": item.sha256,
                }
                for item in declared
            ],
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
