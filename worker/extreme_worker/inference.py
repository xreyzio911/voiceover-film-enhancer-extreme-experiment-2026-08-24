from __future__ import annotations

import math
import threading
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

from .model_runtime import (
    ArtifactSpec,
    RuntimeConfig,
    model_set_id,
    sha256_file,
    verify_artifact,
)
from .wav_validation import WavLimits, WavValidationError, inspect_wav_file


_METRIC_OUTPUTS: dict[str, tuple[str, ...]] = {
    "dnsmos": ("sig", "bak", "ovrl"),
    "dnsmos_p808": ("value",),
    "sigmos": ("col", "disc", "loud", "noise", "reverb", "sig", "ovrl"),
    "utmos": ("value",),
}
_PCM_DECODE_CHUNK_FRAMES = 65_536
_METRIC_WINDOW_SECONDS = 10.0
_METRIC_WINDOW_COUNT_CAP = 7
_METRIC_WINDOW_BYTE_CAP = 2 * 1024 * 1024
_METRIC_SAMPLE_BYTES = 4


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


def _decode_pcm_samples(
    raw: bytes,
    sample_width: int,
    channels: int,
    format_code: int = 1,
) -> Any:
    import numpy as np

    if format_code == 3:
        if sample_width != 4:
            raise ValueError("unsupported-float-width")
        decoded = np.frombuffer(raw, dtype="<f4")
        if not np.isfinite(decoded).all():
            raise ValueError("non-finite-float-samples")
        if np.any((decoded < -1.0) | (decoded > 1.0)):
            raise ValueError("out-of-range-float-samples")
    elif format_code != 1:
        raise ValueError("unsupported-wav-format")
    elif sample_width == 2:
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
    if not np.isfinite(mono).all():
        raise ValueError("non-finite-float-samples")
    return mono.astype(np.float32, copy=False)


def _read_pcm_wav(
    path: Path,
    max_duration_seconds: float | None = None,
) -> tuple[Any, int, int, float]:
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
    if max_duration_seconds is not None and info.frames > max(
        0,
        math.floor(info.sample_rate * max_duration_seconds),
    ):
        raise AnalysisDurationLimit(
            sample_rate=info.sample_rate,
            channels=info.channels,
            duration_seconds=info.duration_seconds,
        )
    import numpy as np

    bytes_per_frame = info.sample_width_bytes * info.channels
    audio = np.empty(info.frames, dtype=np.float32)
    decoded_frames = 0
    with source_path.open("rb") as source:
        source.seek(info.data_offset)
        while decoded_frames < info.frames:
            chunk_frames = min(_PCM_DECODE_CHUNK_FRAMES, info.frames - decoded_frames)
            chunk_bytes = chunk_frames * bytes_per_frame
            raw = source.read(chunk_bytes)
            if len(raw) != chunk_bytes:
                raise EOFError("truncated-pcm-payload")
            audio[decoded_frames : decoded_frames + chunk_frames] = _decode_pcm_samples(
                raw,
                info.sample_width_bytes,
                info.channels,
                info.format_code,
            )
            decoded_frames += chunk_frames
    return (
        audio,
        info.sample_rate,
        info.channels,
        info.duration_seconds,
    )


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


def _speech_metric_window_starts(
    *,
    sample_count: int,
    sample_rate: int,
    window_samples: int,
    vad_probabilities: tuple[float, ...] | list[float],
) -> tuple[int, ...]:
    probabilities = tuple(
        min(1.0, max(0.0, float(value))) if math.isfinite(float(value)) else 0.0
        for value in vad_probabilities
    )
    if not probabilities:
        return ()

    high_speech = tuple(1 if value >= 0.5 else 0 for value in probabilities)
    if not any(high_speech):
        return ()
    if sample_count <= window_samples:
        return (0,)

    max_start = sample_count - window_samples
    source_seconds = sample_count / sample_rate
    chunk_seconds = 512.0 / 16_000.0
    window_chunks = max(1, math.ceil((window_samples / sample_rate) / chunk_seconds))
    minimum_speech_seconds = min(0.75, max(chunk_seconds, source_seconds * 0.1))
    minimum_speech_chunks = max(1, math.ceil(minimum_speech_seconds / chunk_seconds))
    mass_prefix = [0.0]
    support_prefix = [0]
    for probability, is_speech in zip(probabilities, high_speech):
        mass_prefix.append(mass_prefix[-1] + max(0.0, probability - 0.25))
        support_prefix.append(support_prefix[-1] + is_speech)

    max_chunk_start = max(0, len(probabilities) - window_chunks)
    stride_chunks = max(1, round(0.25 / chunk_seconds))
    chunk_starts = list(range(0, max_chunk_start + 1, stride_chunks))
    if not chunk_starts or chunk_starts[-1] != max_chunk_start:
        chunk_starts.append(max_chunk_start)

    ranked: list[tuple[int, float, int]] = []
    seen_sample_starts: set[int] = set()
    for chunk_start in chunk_starts:
        chunk_stop = min(len(probabilities), chunk_start + window_chunks)
        speech_chunks = support_prefix[chunk_stop] - support_prefix[chunk_start]
        if speech_chunks < minimum_speech_chunks:
            continue
        speech_mass = mass_prefix[chunk_stop] - mass_prefix[chunk_start]
        sample_start = min(
            max_start,
            max(0, round(chunk_start * 512 * sample_rate / 16_000)),
        )
        if sample_start in seen_sample_starts:
            continue
        seen_sample_starts.add(sample_start)
        ranked.append((speech_chunks, speech_mass, sample_start))

    selected: list[int] = []
    for _support, _mass, sample_start in sorted(
        ranked,
        key=lambda item: (-item[0], -item[1], item[2]),
    ):
        if any(abs(sample_start - prior) < window_samples for prior in selected):
            continue
        selected.append(sample_start)
        if len(selected) >= _METRIC_WINDOW_COUNT_CAP:
            break
    return tuple(sorted(selected))


def _metric_window_plan(
    audio: Any,
    sample_rate: int,
    *,
    vad_probabilities: tuple[float, ...] | list[float] | None = None,
) -> tuple[int, tuple[int, ...]]:
    if sample_rate <= 0:
        raise ValueError("invalid-metric-sample-rate")
    sample_count = len(audio)
    if sample_count < 0:
        raise ValueError("invalid-metric-sample-count")
    duration_sample_cap = max(1, math.floor(sample_rate * _METRIC_WINDOW_SECONDS))
    memory_sample_cap = _METRIC_WINDOW_BYTE_CAP // _METRIC_SAMPLE_BYTES
    window_samples = min(duration_sample_cap, memory_sample_cap)
    if vad_probabilities is not None:
        return window_samples, _speech_metric_window_starts(
            sample_count=sample_count,
            sample_rate=sample_rate,
            window_samples=window_samples,
            vad_probabilities=vad_probabilities,
        )
    if sample_count <= window_samples:
        return window_samples, (0,)

    max_start = sample_count - window_samples
    source_window_count = (sample_count + window_samples - 1) // window_samples
    desired_window_count = max(3, source_window_count)
    window_count = min(_METRIC_WINDOW_COUNT_CAP, desired_window_count, max_start + 1)
    starts = tuple(
        (window_index * max_start) // (window_count - 1)
        for window_index in range(window_count)
    )
    return window_samples, starts


def _bounded_metric_window(
    audio: Any,
    *,
    start: int,
    window_samples: int,
    use_full_source: bool,
) -> Any:
    import numpy as np

    candidate = audio if use_full_source else audio[start : start + window_samples]
    window = np.asarray(candidate, dtype=np.float32)
    if window.ndim != 1:
        window = window.reshape(-1)
    if window.size > window_samples or window.nbytes > _METRIC_WINDOW_BYTE_CAP:
        raise ValueError("metric-window-memory-limit")
    return window


def _lower_median(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[(len(ordered) - 1) // 2]


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
        except (OSError, EOFError, ValueError, WavValidationError):
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
        metric_vad_probabilities: tuple[float, ...] | list[float] = ()

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
                metric_vad_probabilities = probabilities
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
                    self._score_metric(
                        metric_id,
                        metrics,
                        components,
                        audio,
                        sample_rate,
                        vad_probabilities=metric_vad_probabilities,
                    )
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
        *,
        vad_probabilities: tuple[float, ...] | list[float] | None = None,
    ) -> None:
        assert self._metrics is not None
        output_ids = _METRIC_OUTPUTS[metric_id]
        valid_values: dict[str, list[float]] = {output_id: [] for output_id in output_ids}
        try:
            window_samples, starts = _metric_window_plan(
                audio,
                sample_rate,
                vad_probabilities=vad_probabilities,
            )
        except Exception:
            components[metric_id] = {"status": "unavailable", "code": "metric-inference-error"}
            return

        if not starts:
            components[metric_id] = {
                "status": "unavailable",
                "code": "no-speech-metric-windows",
            }
            return

        successful_windows = 0
        for start in starts:
            try:
                window = _bounded_metric_window(
                    audio,
                    start=start,
                    window_samples=window_samples,
                    use_full_source=len(starts) == 1,
                )
                result = self._metrics.score(metric_id, window, sample_rate)
                values = result if isinstance(result, Mapping) else {"value": result}
                successful_windows += 1
                for output_id in output_ids:
                    value = _valid_metric_value(values.get(output_id))
                    if value is not None:
                        valid_values[output_id].append(value)
            except Exception:
                continue

        required_windows = max(1, (len(starts) + 1) // 2)
        available_count = 0
        used_partial_windows = successful_windows < len(starts)
        for output_id in output_ids:
            key = metric_id if output_id == "value" else f"{metric_id}.{output_id}"
            values = valid_values[output_id]
            used_partial_windows = used_partial_windows or len(values) < len(starts)
            value = _lower_median(values) if len(values) >= required_windows else None
            metrics[key] = {
                "value": value,
                "available": value is not None,
                "higherIsBetter": True,
            }
            available_count += int(value is not None)

        if available_count == len(output_ids):
            code = "ok-partial-windows" if used_partial_windows else "ok"
            components[metric_id] = {"status": "available", "code": code}
        elif successful_windows == 0:
            components[metric_id] = {"status": "unavailable", "code": "metric-inference-error"}
        else:
            components[metric_id] = {"status": "unavailable", "code": "invalid-metric-output"}


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
