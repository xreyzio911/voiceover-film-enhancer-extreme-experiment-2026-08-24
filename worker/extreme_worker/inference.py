from __future__ import annotations

import math
import threading
import wave
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

from .model_runtime import (
    ArtifactSpec,
    RuntimeConfig,
    model_set_id,
    sha256_file,
    verify_artifact,
)


_METRIC_OUTPUTS: dict[str, tuple[str, ...]] = {
    "dnsmos": ("sig", "bak", "ovrl"),
    "dnsmos_p808": ("value",),
    "sigmos": ("col", "disc", "loud", "noise", "reverb", "sig", "ovrl"),
    "utmos": ("value",),
}


class VadBackend(Protocol):
    def score_chunks(self, audio_16k: Any) -> tuple[float, ...] | list[float]: ...


class MetricsBackend(Protocol):
    def score(self, metric_id: str, audio: Any, sample_rate: int) -> float | Mapping[str, float]: ...


class AnalysisDurationLimit(ValueError):
    """Carries trusted WAV-header facts when analysis is intentionally bounded."""

    def __init__(self, *, sample_rate: int, channels: int, duration_seconds: float) -> None:
        super().__init__("analysis-duration-limit")
        self.sample_rate = sample_rate
        self.channels = channels
        self.duration_seconds = duration_seconds


class SileroOnnxBackend:
    """Small CPU-only wrapper around the immutable Silero VAD 6.2.1 ONNX graph."""

    def __init__(self, model_path: Path) -> None:
        import numpy as np
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self._np = np
        self._session = ort.InferenceSession(
            str(model_path),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )
        input_names = {item.name for item in self._session.get_inputs()}
        if not {"input", "state", "sr"}.issubset(input_names):
            raise RuntimeError("unsupported-silero-input-contract")

    def score_chunks(self, audio_16k: Any) -> tuple[float, ...]:
        np = self._np
        audio = np.asarray(audio_16k, dtype=np.float32).reshape(-1)
        if audio.size == 0:
            return ()
        state = np.zeros((2, 1, 128), dtype=np.float32)
        context = np.zeros((1, 64), dtype=np.float32)
        probabilities: list[float] = []
        for offset in range(0, int(audio.size), 512):
            chunk = audio[offset : offset + 512]
            if chunk.size < 512:
                chunk = np.pad(chunk, (0, 512 - chunk.size))
            model_input = np.concatenate((context, chunk.reshape(1, -1)), axis=1)
            output, state = self._session.run(
                None,
                {
                    "input": model_input.astype(np.float32, copy=False),
                    "state": state,
                    "sr": np.asarray(16_000, dtype=np.int64),
                },
            )
            probability = float(np.asarray(output).reshape(-1)[0])
            probabilities.append(min(1.0, max(0.0, probability)) if math.isfinite(probability) else 0.0)
            context = model_input[:, -64:]
        return tuple(probabilities)


class SpeechOnnxMetricsBackend:
    """Licensed, local-file-only speechonnxmetrics adapters.

    Artifact paths are verified before this object is built. Overriding each model's
    local path prevents a scoring call from resolving a mutable remote revision.
    """

    def __init__(self, model_paths: Mapping[str, Path]) -> None:
        from speechonnxmetrics.mos.dnsmos import DNSMOS, DNSMOSP808
        from speechonnxmetrics.mos.sigmos import SIGMOS
        from speechonnxmetrics.mos.utmos import UTMOS

        constructors: dict[str, Callable[[], Any]] = {
            "dnsmos": DNSMOS,
            "dnsmos_p808": DNSMOSP808,
            "sigmos": SIGMOS,
            "utmos": UTMOS,
        }
        self._metrics: dict[str, Any] = {}
        for metric_id, model_path in model_paths.items():
            constructor = constructors.get(metric_id)
            if constructor is None:
                continue
            metric = constructor(providers=["CPUExecutionProvider"])
            metric.model.hf_file = str(model_path)
            metric.model.hf_repo = ""
            metric.model.revision = None
            self._metrics[metric_id] = metric

    def score(self, metric_id: str, audio: Any, sample_rate: int) -> float | Mapping[str, float]:
        metric = self._metrics.get(metric_id)
        if metric is None:
            raise RuntimeError("metric-not-loaded")
        return metric(audio, sample_rate)


def _decode_pcm_samples(raw: bytes, sample_width: int, channels: int) -> Any:
    import numpy as np

    if sample_width == 2:
        decoded = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32_768.0
    elif sample_width == 3:
        octets = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        signed = (
            octets[:, 0].astype(np.int32)
            | (octets[:, 1].astype(np.int32) << 8)
            | (octets[:, 2].astype(np.int32) << 16)
        )
        signed = np.where(signed & 0x800000, signed - 0x1000000, signed)
        decoded = signed.astype(np.float32) / 8_388_608.0
    elif sample_width == 4:
        decoded = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2_147_483_648.0
    else:
        raise ValueError("unsupported-pcm-width")
    if decoded.size % channels:
        raise ValueError("misaligned-pcm-frames")
    frames = decoded.reshape(-1, channels)
    mono = frames.mean(axis=1, dtype=np.float32)
    return np.clip(mono, -1.0, 1.0).astype(np.float32, copy=False)


def _read_pcm_wav(
    path: Path,
    max_duration_seconds: float | None = None,
) -> tuple[Any, int, int, float]:
    with wave.open(str(path), "rb") as source:
        channels = source.getnchannels()
        sample_width = source.getsampwidth()
        sample_rate = source.getframerate()
        frame_count = source.getnframes()
        compression = source.getcomptype()
        if compression != "NONE" or channels not in (1, 2) or sample_width not in (2, 3, 4):
            raise ValueError("unsupported-pcm-wav")
        if sample_rate not in (16_000, 24_000, 44_100, 48_000):
            raise ValueError("unsupported-sample-rate")
        duration_seconds = frame_count / sample_rate
        if max_duration_seconds is not None and frame_count > max(0, math.floor(sample_rate * max_duration_seconds)):
            raise AnalysisDurationLimit(
                sample_rate=sample_rate,
                channels=channels,
                duration_seconds=duration_seconds,
            )
        raw = source.readframes(frame_count)
    return _decode_pcm_samples(raw, sample_width, channels), sample_rate, channels, duration_seconds


def _resample_for_vad(audio: Any, sample_rate: int) -> Any:
    import numpy as np

    source = np.asarray(audio, dtype=np.float32).reshape(-1)
    if sample_rate == 16_000 or source.size == 0:
        return source
    output_count = max(1, round(source.size * 16_000 / sample_rate))
    source_positions = np.arange(source.size, dtype=np.float64) / sample_rate
    output_positions = np.arange(output_count, dtype=np.float64) / 16_000
    return np.interp(output_positions, source_positions, source).astype(np.float32)


def _empty_metrics(metric_ids: tuple[str, ...]) -> dict[str, dict[str, object]]:
    empty: dict[str, dict[str, object]] = {}
    for metric_id in metric_ids:
        for output_id in _METRIC_OUTPUTS[metric_id]:
            key = metric_id if output_id == "value" else f"{metric_id}.{output_id}"
            empty[key] = {"value": None, "available": False, "higherIsBetter": True}
    return empty


def _valid_metric_value(value: object) -> float | None:
    if not isinstance(value, (int, float)):
        return None
    rendered = float(value)
    return rendered if math.isfinite(rendered) and 0.0 <= rendered <= 5.0 else None


def _vad_frames(probabilities: tuple[float, ...] | list[float], duration_ms: float) -> list[dict[str, object]]:
    if not probabilities or duration_ms <= 0:
        return []
    frame_count = math.ceil(duration_ms / 10.0)
    frames: list[dict[str, object]] = []
    for frame_index in range(frame_count):
        chunk_index = min(len(probabilities) - 1, math.floor((frame_index * 10.0) / 32.0))
        probability = float(probabilities[chunk_index])
        if not math.isfinite(probability):
            probability = 0.0
        frames.append(
            {
                "startMs": frame_index * 10,
                "endMs": (frame_index + 1) * 10,
                "speechProbability": round(min(1.0, max(0.0, probability)), 6),
            }
        )
    return frames


def _model_provenance(artifacts: list[ArtifactSpec]) -> list[dict[str, str]]:
    return [
        {
            "id": artifact.id,
            "version": artifact.version,
            "revision": artifact.revision,
            "sha256": artifact.sha256,
        }
        for artifact in artifacts
    ]


class AdvisoryInferenceRuntime:
    def __init__(
        self,
        config: RuntimeConfig | None = None,
        *,
        vad_factory: Callable[[Path], VadBackend] | None = None,
        metrics_factory: Callable[[Mapping[str, Path]], MetricsBackend] | None = None,
    ) -> None:
        self.config = config or RuntimeConfig.from_env()
        self._vad_factory = vad_factory or SileroOnnxBackend
        self._metrics_factory = metrics_factory or SpeechOnnxMetricsBackend
        self._analysis_lock = threading.Lock()
        self._vad: VadBackend | None = None
        self._metrics: MetricsBackend | None = None
        self._models_loaded = False

    @property
    def models_loaded(self) -> bool:
        return self._models_loaded

    def _artifact_path(self, artifact: ArtifactSpec) -> Path:
        return self.config.model_dir / artifact.filename

    def _verified_artifact(self, artifact_id: str) -> tuple[ArtifactSpec, Path] | None:
        artifact = self.config.artifact(artifact_id)
        if artifact is None:
            return None
        path = self._artifact_path(artifact)
        return (artifact, path) if verify_artifact(path, artifact) else None

    def _base_report(
        self,
        *,
        source_sha256: str,
        duration_ms: float,
        sample_rate: int,
        channels: int,
        reason: str,
    ) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "advisoryOnly": True,
            "canBlockDelivery": False,
            "canChangeGainDb": False,
            "levelAuthority": "gainPlanner",
            "modelSetId": model_set_id(self.config),
            "source": {
                "sha256": source_sha256,
                "durationMs": round(duration_ms, 3),
                "sampleRate": sample_rate,
                "channels": channels,
            },
            "vad": {"frameMs": 10, "frames": []},
            "metrics": _empty_metrics(self.config.metric_ids),
            "models": [],
            "telemetry": {
                "runtimeStatus": "degraded",
                "reason": reason,
                "components": {},
                "audioMutation": False,
                "candidateSelected": False,
                "gainDbChanged": False,
                "excludedModels": ["nisqa", "deepfilternet3"],
            },
        }

    def analyze_wav(
        self,
        path: str | Path,
        *,
        job_id: str = "",
        source_sha256: str | None = None,
    ) -> dict[str, object]:
        source_path = Path(path)
        actual_sha256 = sha256_file(source_path)
        try:
            audio, sample_rate, channels, duration_seconds = _read_pcm_wav(
                source_path,
                self.config.max_analysis_seconds,
            )
        except AnalysisDurationLimit as error:
            return self._base_report(
                source_sha256=actual_sha256,
                duration_ms=error.duration_seconds * 1000.0,
                sample_rate=error.sample_rate,
                channels=error.channels,
                reason="analysis-duration-limit",
            )
        except (OSError, EOFError, ValueError, wave.Error):
            return self._base_report(
                source_sha256=actual_sha256,
                duration_ms=0.0,
                sample_rate=1,
                channels=1,
                reason="invalid-wav",
            )

        report = self._base_report(
            source_sha256=actual_sha256,
            duration_ms=duration_seconds * 1000.0,
            sample_rate=sample_rate,
            channels=channels,
            reason="model-unavailable",
        )
        telemetry = report["telemetry"]
        assert isinstance(telemetry, dict)
        telemetry["jobIdPresent"] = bool(job_id)
        if source_sha256 is not None and source_sha256 != actual_sha256:
            telemetry["reason"] = "source-sha256-mismatch"
            return report

        with self._analysis_lock:
            self._run_models(report, audio, sample_rate, duration_seconds)

        try:
            telemetry["audioMutation"] = sha256_file(source_path) != actual_sha256
        except OSError:
            telemetry["audioMutation"] = True
        if telemetry["audioMutation"]:
            telemetry["runtimeStatus"] = "degraded"
            telemetry["reason"] = "source-changed-during-analysis"
        return report

    def _run_models(self, report: dict[str, object], audio: Any, sample_rate: int, duration_seconds: float) -> None:
        telemetry = report["telemetry"]
        metrics = report["metrics"]
        vad = report["vad"]
        assert isinstance(telemetry, dict)
        assert isinstance(metrics, dict)
        assert isinstance(vad, dict)
        components: dict[str, dict[str, str]] = {}
        verified: list[ArtifactSpec] = []

        vad_entry = self._verified_artifact("silero-vad")
        if vad_entry is None:
            components["silero-vad"] = {"status": "unavailable", "code": "artifact-missing-or-invalid"}
        else:
            vad_artifact, vad_path = vad_entry
            verified.append(vad_artifact)
            try:
                if self._vad is None:
                    self._vad = self._vad_factory(vad_path)
                    self._models_loaded = True
                probabilities = self._vad.score_chunks(_resample_for_vad(audio, sample_rate))
                frames = _vad_frames(probabilities, duration_seconds * 1000.0)
                if frames:
                    vad["frames"] = frames
                    components["silero-vad"] = {"status": "available", "code": "ok"}
                else:
                    components["silero-vad"] = {"status": "unavailable", "code": "empty-vad-output"}
            except Exception:
                self._vad = None
                components["silero-vad"] = {"status": "unavailable", "code": "dependency-or-inference-error"}

        verified_metric_paths: dict[str, Path] = {}
        for metric_id in self.config.metric_ids:
            entry = self._verified_artifact(metric_id)
            if entry is None:
                components[metric_id] = {"status": "unavailable", "code": "artifact-missing-or-invalid"}
                continue
            artifact, artifact_path = entry
            verified.append(artifact)
            verified_metric_paths[metric_id] = artifact_path

        if verified_metric_paths:
            try:
                if self._metrics is None:
                    self._metrics = self._metrics_factory(verified_metric_paths)
                    self._models_loaded = True
                for metric_id in self.config.metric_ids:
                    if metric_id not in verified_metric_paths:
                        continue
                    self._score_metric(metric_id, metrics, components, audio, sample_rate)
            except Exception:
                self._metrics = None
                for metric_id in verified_metric_paths:
                    components[metric_id] = {
                        "status": "unavailable",
                        "code": "dependency-or-inference-error",
                    }

        report["models"] = _model_provenance(verified)
        telemetry["components"] = components
        statuses = [item["status"] for item in components.values()]
        if statuses and all(status == "available" for status in statuses):
            telemetry["runtimeStatus"] = "ready"
            telemetry["reason"] = "ok"
        else:
            telemetry["runtimeStatus"] = "degraded"
            telemetry["reason"] = "model-unavailable"

    def _score_metric(
        self,
        metric_id: str,
        metrics: dict[str, object],
        components: dict[str, dict[str, str]],
        audio: Any,
        sample_rate: int,
    ) -> None:
        assert self._metrics is not None
        try:
            result = self._metrics.score(metric_id, audio, sample_rate)
            output_ids = _METRIC_OUTPUTS[metric_id]
            values = result if isinstance(result, Mapping) else {"value": result}
            available_count = 0
            for output_id in output_ids:
                key = metric_id if output_id == "value" else f"{metric_id}.{output_id}"
                value = _valid_metric_value(values.get(output_id))
                metrics[key] = {
                    "value": value,
                    "available": value is not None,
                    "higherIsBetter": True,
                }
                available_count += int(value is not None)
            if available_count == len(output_ids):
                components[metric_id] = {"status": "available", "code": "ok"}
            else:
                components[metric_id] = {"status": "unavailable", "code": "invalid-metric-output"}
        except Exception:
            components[metric_id] = {"status": "unavailable", "code": "metric-inference-error"}


_runtime_lock = threading.Lock()
_runtime: AdvisoryInferenceRuntime | None = None


def get_runtime(config: RuntimeConfig | None = None) -> AdvisoryInferenceRuntime:
    global _runtime
    selected_config = config or RuntimeConfig.from_env()
    with _runtime_lock:
        if _runtime is None:
            _runtime = AdvisoryInferenceRuntime(selected_config)
        elif _runtime.config != selected_config:
            raise ValueError("the process-wide runtime is already configured")
        return _runtime
