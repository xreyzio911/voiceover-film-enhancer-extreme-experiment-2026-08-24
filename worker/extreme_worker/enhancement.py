from __future__ import annotations

import os
import math
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from .model_runtime import sha256_file
from .wav_validation import WavLimits, WavValidationError, inspect_wav_file


RNNOISE_BD_REVISION = "3eee541a283fd3b8f81b85b1748e3b9ccbefa04d"
RNNOISE_BD_SHA256 = "ae3f7411e1e6a884f839a4a145c394408398f09854dbc1216ee02faafc98a17b"
RNNOISE_BD_FILENAME = "bd.rnnn"
RNNOISE_BD_SOURCE_URL = (
    "https://raw.githubusercontent.com/GregorR/rnnoise-models/"
    f"{RNNOISE_BD_REVISION}/beguiling-drafter-2018-08-30/bd.rnnn"
)


@dataclass(frozen=True)
class EnhancementResult:
    candidate_path: Path | None
    telemetry: dict[str, object]
    model: dict[str, str] | None = None


@dataclass(frozen=True)
class RnnoiseCandidatePolicy:
    eligible: bool
    reason: str
    mix: float
    noise_evidence: float
    speech_fraction: float


@dataclass(frozen=True)
class RnnoiseCandidateAssessment:
    selected: bool
    reason: str
    noise_delta: float
    worst_quality_delta: float


@dataclass(frozen=True)
class WaveformRetentionAssessment:
    preserved: bool
    reason: str
    expressive_contrast_retention: float
    active_median_delta_db: float
    active_p95_delta_db: float


def _metric_value(report: Mapping[str, Any], key: str) -> float | None:
    metrics = report.get("metrics")
    if not isinstance(metrics, Mapping):
        return None
    metric = metrics.get(key)
    if not isinstance(metric, Mapping) or metric.get("available") is not True:
        return None
    value = metric.get("value")
    if not isinstance(value, (int, float)):
        return None
    rendered = float(value)
    return rendered if 0.0 <= rendered <= 5.0 else None


def _speech_fraction(report: Mapping[str, Any]) -> float:
    vad = report.get("vad")
    frames = vad.get("frames") if isinstance(vad, Mapping) else None
    if not isinstance(frames, list) or not frames:
        return 0.0
    speech_frames = sum(
        1
        for frame in frames
        if isinstance(frame, Mapping)
        and isinstance(frame.get("speechProbability"), (int, float))
        and float(frame["speechProbability"]) >= 0.5
    )
    return speech_frames / len(frames)


def _deficit(value: float | None, caution_at: float, severe_at: float) -> float:
    if value is None or caution_at <= severe_at:
        return 0.0
    return min(1.0, max(0.0, (caution_at - value) / (caution_at - severe_at)))


def resolve_rnnoise_candidate_policy(report: Mapping[str, Any]) -> RnnoiseCandidatePolicy:
    speech_fraction = _speech_fraction(report)
    if speech_fraction < 0.12:
        return RnnoiseCandidatePolicy(False, "insufficient-speech-support", 0.0, 0.0, speech_fraction)
    speech_authority = min(1.0, max(0.0, (speech_fraction - 0.12) / 0.18))
    noise_evidence = max(
        _deficit(_metric_value(report, "dnsmos.bak"), 3.65, 2.4),
        _deficit(_metric_value(report, "sigmos.noise"), 3.7, 2.3),
    ) * speech_authority
    if noise_evidence < 0.18:
        return RnnoiseCandidatePolicy(False, "source-not-noise-limited", 0.0, noise_evidence, speech_fraction)
    signal_values = tuple(
        value
        for value in (
            _metric_value(report, "dnsmos.sig"),
            _metric_value(report, "sigmos.sig"),
        )
        if value is not None
    )
    if signal_values and (
        max(signal_values) < 2.65
        or sum(signal_values) / len(signal_values) < 2.45
    ):
        return RnnoiseCandidatePolicy(False, "fragile-source-speech", 0.0, noise_evidence, speech_fraction)
    mix = min(0.32, max(0.28, 0.24 + noise_evidence * 0.10))
    return RnnoiseCandidatePolicy(True, "noise-limited-source", mix, noise_evidence, speech_fraction)


def assess_rnnoise_candidate(
    source_report: Mapping[str, Any],
    candidate_report: Mapping[str, Any],
) -> RnnoiseCandidateAssessment:
    source_speech_fraction = _speech_fraction(source_report)
    candidate_speech_fraction = _speech_fraction(candidate_report)
    if source_speech_fraction < 0.12 or candidate_speech_fraction < 0.12:
        return RnnoiseCandidateAssessment(
            False,
            "insufficient-speech-support",
            0.0,
            0.0,
        )
    noise_deltas = [
        candidate - source
        for key in ("dnsmos.bak", "sigmos.noise")
        if (source := _metric_value(source_report, key)) is not None
        and (candidate := _metric_value(candidate_report, key)) is not None
    ]
    if not noise_deltas:
        return RnnoiseCandidateAssessment(False, "noise-evidence-unavailable", 0.0, 0.0)
    noise_delta = sum(noise_deltas) / len(noise_deltas)
    if noise_delta < 0.08 or min(noise_deltas) < -0.03:
        return RnnoiseCandidateAssessment(False, "noise-improvement-insufficient", noise_delta, 0.0)

    quality_deltas = [
        candidate - source
        for key in (
            "dnsmos.sig",
            "dnsmos.ovrl",
            "dnsmos_p808",
            "sigmos.sig",
            "sigmos.ovrl",
            "sigmos.disc",
            "sigmos.loud",
        )
        if (source := _metric_value(source_report, key)) is not None
        and (candidate := _metric_value(candidate_report, key)) is not None
    ]
    if not quality_deltas:
        return RnnoiseCandidateAssessment(False, "quality-evidence-unavailable", noise_delta, 0.0)
    worst_quality_delta = min(quality_deltas)
    mean_quality_delta = sum(quality_deltas) / len(quality_deltas)
    if worst_quality_delta < -0.08 or mean_quality_delta < -0.03:
        return RnnoiseCandidateAssessment(
            False,
            "speech-quality-regression",
            noise_delta,
            worst_quality_delta,
        )

    if source_speech_fraction > 0 and candidate_speech_fraction < source_speech_fraction * 0.97:
        return RnnoiseCandidateAssessment(
            False,
            "speech-activity-regression",
            noise_delta,
            worst_quality_delta,
        )
    return RnnoiseCandidateAssessment(
        True,
        "quality-gate-passed",
        noise_delta,
        worst_quality_delta,
    )


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        raise ValueError("empty-percentile")
    ordered = sorted(values)
    position = min(len(ordered) - 1, max(0.0, percentile * (len(ordered) - 1)))
    lower = int(position)
    upper = min(len(ordered) - 1, lower + 1)
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def _frame_rms_db(path: Path, *, limits: WavLimits) -> tuple[object, list[float]]:
    import numpy as np

    from .inference import _decode_pcm_samples

    info = inspect_wav_file(path, limits)
    samples_per_frame = max(1, round(info.sample_rate * 0.01))
    read_frames = samples_per_frame * 100
    bytes_per_frame = info.sample_width_bytes * info.channels
    frame_db: list[float] = []
    pending = np.empty(0, dtype=np.float32)
    remaining = info.frames
    with path.open("rb") as source:
        source.seek(info.data_offset)
        while remaining > 0:
            current_frames = min(read_frames, remaining)
            raw = source.read(current_frames * bytes_per_frame)
            if len(raw) != current_frames * bytes_per_frame:
                raise EOFError("truncated-candidate-wav")
            decoded = _decode_pcm_samples(
                raw,
                info.sample_width_bytes,
                info.channels,
                info.format_code,
            )
            combined = np.concatenate((pending, decoded)) if pending.size else decoded
            complete_frames = len(combined) // samples_per_frame
            if complete_frames:
                windows = combined[: complete_frames * samples_per_frame].reshape(
                    complete_frames,
                    samples_per_frame,
                )
                rms_values = np.sqrt(np.mean(np.square(windows), axis=1))
                frame_db.extend(
                    -120.0 if rms <= 0 else 20.0 * math.log10(float(rms))
                    for rms in rms_values
                )
            pending = combined[complete_frames * samples_per_frame :].copy()
            remaining -= current_frames
    return info, frame_db


def assess_waveform_retention(
    source_path: Path,
    candidate_path: Path,
    *,
    limits: WavLimits,
) -> WaveformRetentionAssessment:
    source_info, source_frames = _frame_rms_db(source_path, limits=limits)
    candidate_info, candidate_frames = _frame_rms_db(candidate_path, limits=limits)
    if (
        source_info.sample_rate != candidate_info.sample_rate
        or source_info.channels != candidate_info.channels
        or source_info.frames != candidate_info.frames
        or len(source_frames) != len(candidate_frames)
        or not source_frames
    ):
        return WaveformRetentionAssessment(False, "waveform-geometry-regression", 0.0, 0.0, 0.0)

    noise_floor = _percentile(source_frames, 0.2)
    ordinary_body = _percentile(source_frames, 0.5)
    active_threshold = max(-55.0, min(noise_floor + 10.0, ordinary_body - 6.0))
    active_indices = [
        index
        for index, value in enumerate(source_frames)
        if value >= active_threshold
    ]
    if len(active_indices) < 10:
        return WaveformRetentionAssessment(False, "waveform-evidence-unavailable", 0.0, 0.0, 0.0)
    source_active = [source_frames[index] for index in active_indices]
    candidate_active = [candidate_frames[index] for index in active_indices]
    active_deltas = [candidate - source for source, candidate in zip(source_active, candidate_active)]
    median_delta = _percentile(active_deltas, 0.5)
    p95_delta = _percentile(candidate_active, 0.95) - _percentile(source_active, 0.95)
    source_contrast = _percentile(source_active, 0.95) - _percentile(source_active, 0.5)
    candidate_contrast = _percentile(candidate_active, 0.95) - _percentile(candidate_active, 0.5)
    contrast_retention = (
        1.0
        if source_contrast < 3.0
        else max(0.0, candidate_contrast / source_contrast)
    )
    if contrast_retention < 0.9:
        return WaveformRetentionAssessment(
            False,
            "expressive-contrast-regression",
            contrast_retention,
            median_delta,
            p95_delta,
        )
    if median_delta < -1.0 or median_delta > 0.5 or p95_delta < -1.2 or p95_delta > 0.5:
        return WaveformRetentionAssessment(
            False,
            "speech-level-regression",
            contrast_retention,
            median_delta,
            p95_delta,
        )
    return WaveformRetentionAssessment(
        True,
        "waveform-gate-passed",
        contrast_retention,
        median_delta,
        p95_delta,
    )


class LocalPassthroughEnhancer:
    """Test fallback for explicit app configs; production uses ArnndnEnhancer."""

    def enhance(
        self,
        source_path: Path,
        candidate_path: Path,
        *,
        limits: WavLimits,
        source_report: Mapping[str, Any] | None = None,
        job_id: str = "",
    ) -> EnhancementResult:
        del source_report, job_id
        inspect_wav_file(source_path, limits)
        candidate_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_path, candidate_path)
        return EnhancementResult(
            candidate_path=candidate_path,
            telemetry={
                "runtimeStatus": "degraded",
                "reason": "test-passthrough-candidate",
                "audioMutation": False,
                "candidateSelected": True,
                "gainDbChanged": False,
                "enhancementEngine": "local-passthrough",
            },
            model=None,
        )


class ArnndnEnhancer:
    """Bounded FFmpeg arnndn candidate producer using one pinned RNNoise model."""

    def __init__(
        self,
        *,
        model_dir: str | Path,
        analyzer: Any | None = None,
        ffmpeg_path: str = "ffmpeg",
        timeout_seconds: float = 300.0,
    ) -> None:
        self.model_dir = Path(model_dir)
        self.analyzer = analyzer
        self.ffmpeg_path = ffmpeg_path
        self.timeout_seconds = max(1.0, float(timeout_seconds))

    def _model_path(self) -> Path:
        return self.model_dir / RNNOISE_BD_FILENAME

    def _model_metadata(self) -> dict[str, str]:
        return {
            "id": "rnnoise-bd",
            "version": "bd.rnnn",
            "revision": RNNOISE_BD_REVISION,
            "sha256": RNNOISE_BD_SHA256,
        }

    def enhance(
        self,
        source_path: Path,
        candidate_path: Path,
        *,
        limits: WavLimits,
        source_report: Mapping[str, Any] | None = None,
        job_id: str = "",
    ) -> EnhancementResult:
        try:
            source_info = inspect_wav_file(source_path, limits)
        except (OSError, WavValidationError):
            return EnhancementResult(
                candidate_path=None,
                telemetry=self._degraded("invalid-source-wav"),
            )
        model_path = self._model_path()
        if not model_path.is_file() or sha256_file(model_path) != RNNOISE_BD_SHA256:
            return EnhancementResult(
                candidate_path=None,
                telemetry=self._degraded("rnnoise-model-unavailable"),
            )
        if source_report is None:
            return EnhancementResult(
                candidate_path=None,
                telemetry=self._degraded("source-quality-unavailable"),
                model=self._model_metadata(),
            )
        policy = resolve_rnnoise_candidate_policy(source_report)
        if not policy.eligible:
            return EnhancementResult(
                candidate_path=None,
                telemetry={
                    **self._degraded(policy.reason),
                    "enhancementMix": policy.mix,
                    "noiseEvidence": round(policy.noise_evidence, 6),
                    "speechFraction": round(policy.speech_fraction, 6),
                },
                model=self._model_metadata(),
            )
        if not callable(getattr(self.analyzer, "analyze_wav", None)):
            return EnhancementResult(
                candidate_path=None,
                telemetry=self._degraded("candidate-quality-unavailable"),
                model=self._model_metadata(),
            )
        candidate_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = candidate_path.with_suffix(".candidate.tmp.wav")
        try:
            with tempfile.TemporaryDirectory(dir=str(candidate_path.parent)) as temp_dir:
                temp_output = Path(temp_dir) / "candidate.wav"
                command = [
                    self.ffmpeg_path,
                    "-hide_banner",
                    "-nostdin",
                    "-y",
                    "-i",
                    str(source_path),
                    "-af",
                    f"aresample=48000,arnndn=m='{str(model_path).replace(chr(92), '/').replace(':', chr(92) + ':')}':mix={policy.mix:.3f}",
                    "-ac",
                    str(source_info.channels),
                    "-ar",
                    str(source_info.sample_rate),
                    "-c:a",
                    "pcm_s16le",
                    str(temp_output),
                ]
                subprocess.run(
                    command,
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=self.timeout_seconds,
                )
                candidate_info = inspect_wav_file(temp_output, limits)
                if (
                    candidate_info.sample_rate != source_info.sample_rate
                    or candidate_info.channels != source_info.channels
                    or abs(candidate_info.duration_seconds - source_info.duration_seconds) > 0.02
                ):
                    raise RuntimeError("candidate-integrity-mismatch")
                waveform = assess_waveform_retention(
                    source_path,
                    temp_output,
                    limits=limits,
                )
                if not waveform.preserved:
                    return EnhancementResult(
                        candidate_path=None,
                        telemetry={
                            **self._degraded(waveform.reason),
                            "enhancementMix": round(policy.mix, 3),
                            "expressiveContrastRetention": round(
                                waveform.expressive_contrast_retention,
                                6,
                            ),
                            "activeMedianDeltaDb": round(waveform.active_median_delta_db, 6),
                            "activeP95DeltaDb": round(waveform.active_p95_delta_db, 6),
                        },
                        model=self._model_metadata(),
                    )
                candidate_sha256 = sha256_file(temp_output)
                candidate_report = self.analyzer.analyze_wav(
                    temp_output,
                    job_id=f"{job_id}:candidate",
                    source_sha256=candidate_sha256,
                )
                assessment = assess_rnnoise_candidate(source_report, candidate_report)
                if not assessment.selected:
                    return EnhancementResult(
                        candidate_path=None,
                        telemetry={
                            **self._degraded(assessment.reason),
                            "enhancementMix": round(policy.mix, 3),
                            "noiseDelta": round(assessment.noise_delta, 6),
                            "worstQualityDelta": round(assessment.worst_quality_delta, 6),
                        },
                        model=self._model_metadata(),
                    )
                os.replace(temp_output, temporary_path)
            os.replace(temporary_path, candidate_path)
        except (OSError, subprocess.SubprocessError, RuntimeError, WavValidationError):
            temporary_path.unlink(missing_ok=True)
            candidate_path.unlink(missing_ok=True)
            return EnhancementResult(
                candidate_path=None,
                telemetry=self._degraded("arnndn-enhancement-unavailable"),
                model=self._model_metadata(),
            )
        return EnhancementResult(
            candidate_path=candidate_path,
            telemetry={
                "runtimeStatus": "ready",
                "reason": "ok",
                "audioMutation": False,
                "candidateSelected": True,
                "gainDbChanged": False,
                "enhancementEngine": "ffmpeg-arnndn",
                "enhancementMix": round(policy.mix, 3),
                "noiseDelta": round(assessment.noise_delta, 6),
                "worstQualityDelta": round(assessment.worst_quality_delta, 6),
                "expressiveContrastRetention": round(
                    waveform.expressive_contrast_retention,
                    6,
                ),
                "activeMedianDeltaDb": round(waveform.active_median_delta_db, 6),
                "activeP95DeltaDb": round(waveform.active_p95_delta_db, 6),
            },
            model=self._model_metadata(),
        )

    @staticmethod
    def _degraded(reason: str) -> dict[str, object]:
        return {
            "runtimeStatus": "degraded",
            "reason": reason,
            "audioMutation": False,
            "candidateSelected": False,
            "gainDbChanged": False,
            "enhancementEngine": "ffmpeg-arnndn",
        }
