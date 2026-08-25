from __future__ import annotations

import os
import math
import shutil
import struct
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

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
class RnnoiseCandidateIntegrityAssessment:
    safe_to_use: bool
    reason: str
    source_peak: float = 0.0
    candidate_peak: float = 0.0
    active_median_delta_db: float = 0.0
    erased_active_fraction: float = 0.0


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
    noise_evidence = max(
        _deficit(_metric_value(report, "dnsmos.bak"), 3.65, 2.4),
        _deficit(_metric_value(report, "sigmos.noise"), 3.7, 2.3),
    )
    signal_values = tuple(
        value
        for value in (
            _metric_value(report, "dnsmos.sig"),
            _metric_value(report, "sigmos.sig"),
        )
        if value is not None
    )
    speech_authority = min(1.0, max(0.0, speech_fraction / 0.30))
    signal_floor = min(signal_values) if signal_values else 3.0
    speech_fragility = _deficit(signal_floor, 2.8, 2.0)
    mix = (
        0.018
        + 0.022 * speech_authority
        + 0.11 * noise_evidence * (0.25 + 0.75 * speech_authority)
        - 0.055 * speech_fragility
    )
    return RnnoiseCandidatePolicy(
        True,
        "adaptive-source-relative-cleanup",
        min(0.18, max(0.012, mix)),
        noise_evidence,
        speech_fraction,
    )


def _bounded_unit(value: object, default: float = 0.0) -> float:
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        return default
    return min(1.0, max(0.0, float(value)))


def _smoothstep(value: float, low: float, high: float) -> float:
    if high <= low:
        return 0.0
    position = min(1.0, max(0.0, (value - low) / (high - low)))
    return position * position * (3.0 - 2.0 * position)


def build_rnnoise_adaptive_mix_curve(
    frames: Sequence[Mapping[str, Any]],
    *,
    base_mix: float,
    source_reference_db: float,
    frame_ms: float = 10.0,
) -> tuple[float, ...]:
    """Build a unity dry/wet cleanup curve without granting gain authority.

    Every threshold is relative to the uploaded source. Strong attacks,
    aperiodic/short vocal events, weak-speech breaths, and near-silence context
    withdraw RNNoise influence. A symmetric protection halo and a 25 ms-normalized
    slew limit prevent the blend itself from pumping around the performance.
    """
    if not frames:
        return ()
    safe_base_mix = min(0.18, max(0.0, float(base_mix))) if math.isfinite(float(base_mix)) else 0.0
    safe_reference_db = (
        float(source_reference_db) if math.isfinite(float(source_reference_db)) else -30.0
    )
    safe_frame_ms = float(frame_ms) if math.isfinite(float(frame_ms)) and frame_ms > 0 else 10.0
    protections: list[float] = []
    for frame in frames:
        speech = _bounded_unit(frame.get("speech_probability"))
        level_value = frame.get("level_db")
        level_db = float(level_value) if isinstance(level_value, (int, float)) and math.isfinite(float(level_value)) else safe_reference_db
        relative_db = level_db - safe_reference_db
        flux = _bounded_unit(frame.get("spectral_flux"))
        periodicity = _bounded_unit(frame.get("periodicity"), 0.5)
        high_band = _bounded_unit(frame.get("high_band_ratio"))
        short_event = _bounded_unit(frame.get("short_event_probability"))
        near_silence = _bounded_unit(frame.get("near_silence_context"))

        transient = _smoothstep(flux, 0.18, 0.75)
        aperiodic = _smoothstep(1.0 - periodicity, 0.20, 0.75)
        short_authority = _smoothstep(short_event, 0.25, 0.78)
        weak_speech = _smoothstep(1.0 - speech, 0.16, 0.66)
        high_band_authority = _smoothstep(high_band, 0.30, 0.78)
        loud_authority = _smoothstep(relative_db, 1.0, 8.0)
        quiet_authority = _smoothstep(-relative_db, 3.0, 11.0)
        silence_context = _smoothstep(near_silence, 0.20, 0.72)
        protection = max(
            transient * max(short_authority, high_band_authority, loud_authority),
            short_authority * max(aperiodic, loud_authority, weak_speech),
            weak_speech * max(aperiodic, high_band_authority, silence_context, quiet_authority),
            loud_authority * max(transient, short_authority, high_band_authority, aperiodic),
        )
        protections.append(min(1.0, max(0.0, protection)))

    halo_frames = max(1, round(80.0 / safe_frame_ms))
    expanded = protections.copy()
    for index, protection in enumerate(protections):
        if protection <= 0.0:
            continue
        for distance in range(1, halo_frames + 1):
            spread = protection * max(0.0, 1.0 - distance / (halo_frames + 1.0))
            if index - distance >= 0:
                expanded[index - distance] = max(expanded[index - distance], spread)
            if index + distance < len(expanded):
                expanded[index + distance] = max(expanded[index + distance], spread)

    target = [safe_base_mix * (1.0 - 0.97 * protection) for protection in expanded]
    maximum_step = 0.025 * safe_frame_ms / 10.0
    forward = target.copy()
    for index in range(1, len(forward)):
        forward[index] = min(
            forward[index - 1] + maximum_step,
            max(forward[index - 1] - maximum_step, forward[index]),
        )
    smoothed = forward.copy()
    for index in range(len(smoothed) - 2, -1, -1):
        smoothed[index] = min(
            smoothed[index + 1] + maximum_step,
            max(smoothed[index + 1] - maximum_step, smoothed[index]),
        )
    return tuple(min(safe_base_mix, max(0.0, value)) for value in smoothed)


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        raise ValueError("empty-percentile")
    ordered = sorted(values)
    position = min(len(ordered) - 1, max(0.0, percentile * (len(ordered) - 1)))
    lower = int(position)
    upper = min(len(ordered) - 1, lower + 1)
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def _decode_interleaved_samples(
    raw: bytes,
    *,
    sample_width: int,
    channels: int,
    format_code: int,
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
    frames = decoded.reshape(-1, channels).astype(np.float32, copy=False)
    if not np.isfinite(frames).all():
        raise ValueError("non-finite-float-samples")
    return frames


def _encode_interleaved_samples(samples: Any, *, sample_width: int, format_code: int) -> bytes:
    import numpy as np

    values = np.asarray(samples, dtype=np.float32).reshape(-1)
    if not np.isfinite(values).all():
        raise ValueError("non-finite-adaptive-candidate")
    values = np.clip(values, -1.0, 1.0)
    if format_code == 3:
        if sample_width != 4:
            raise ValueError("unsupported-float-width")
        return values.astype("<f4", copy=False).tobytes()
    if format_code != 1:
        raise ValueError("unsupported-wav-format")
    if sample_width == 2:
        encoded = np.where(values >= 0, values * 32_767.0, values * 32_768.0)
        return np.rint(encoded).astype("<i2").tobytes()
    if sample_width == 3:
        encoded = np.rint(np.where(values >= 0, values * 8_388_607.0, values * 8_388_608.0)).astype(np.int32)
        unsigned = encoded & 0xFFFFFF
        octets = np.empty((unsigned.size, 3), dtype=np.uint8)
        octets[:, 0] = unsigned & 0xFF
        octets[:, 1] = (unsigned >> 8) & 0xFF
        octets[:, 2] = (unsigned >> 16) & 0xFF
        return octets.tobytes()
    if sample_width == 4:
        encoded = np.rint(
            np.where(values >= 0, values * 2_147_483_647.0, values * 2_147_483_648.0)
        )
        return encoded.astype("<i4").tobytes()
    raise ValueError("unsupported-pcm-width")


def _write_canonical_wav_header(output: Any, info: Any) -> None:
    data_bytes = info.frames * info.channels * info.sample_width_bytes
    if data_bytes <= 0 or data_bytes > 0xFFFFFFFF - 36:
        raise ValueError("candidate-wav-size-unsupported")
    byte_rate = info.sample_rate * info.channels * info.sample_width_bytes
    block_align = info.channels * info.sample_width_bytes
    output.write(
        struct.pack(
            "<4sI4s4sIHHIIHH4sI",
            b"RIFF",
            36 + data_bytes,
            b"WAVE",
            b"fmt ",
            16,
            info.format_code,
            info.channels,
            info.sample_rate,
            byte_rate,
            block_align,
            info.sample_width_bytes * 8,
            b"data",
            data_bytes,
        )
    )


def _vad_probabilities(report: Mapping[str, Any], frame_count: int) -> list[float] | None:
    vad = report.get("vad")
    frames = vad.get("frames") if isinstance(vad, Mapping) else None
    if not isinstance(frames, list) or len(frames) < frame_count:
        return None
    probabilities: list[float] = []
    for frame in frames[:frame_count]:
        value = frame.get("speechProbability") if isinstance(frame, Mapping) else None
        if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            return None
        probabilities.append(min(1.0, max(0.0, float(value))))
    return probabilities


def _extract_rnnoise_frame_evidence(
    source_path: Path,
    *,
    limits: WavLimits,
    source_report: Mapping[str, Any],
) -> tuple[list[dict[str, float]], float]:
    import numpy as np

    info = inspect_wav_file(source_path, limits)
    samples_per_frame = max(1, round(info.sample_rate * 0.01))
    block_frame_count = 100
    bytes_per_sample_frame = info.sample_width_bytes * info.channels
    levels: list[float] = []
    flux_values: list[float] = []
    periodicities: list[float] = []
    high_band_ratios: list[float] = []
    previous_spectrum: Any | None = None
    window = np.hanning(samples_per_frame).astype(np.float32)
    frequencies = np.fft.rfftfreq(samples_per_frame, d=1.0 / info.sample_rate)
    high_band_mask = frequencies >= min(3_000.0, info.sample_rate * 0.20)
    remaining = info.frames
    with source_path.open("rb") as source:
        source.seek(info.data_offset)
        while remaining > 0:
            current_frames = min(samples_per_frame * block_frame_count, remaining)
            raw = source.read(current_frames * bytes_per_sample_frame)
            if len(raw) != current_frames * bytes_per_sample_frame:
                raise EOFError("truncated-source-wav")
            interleaved = _decode_interleaved_samples(
                raw,
                sample_width=info.sample_width_bytes,
                channels=info.channels,
                format_code=info.format_code,
            )
            mono = interleaved.mean(axis=1, dtype=np.float32)
            local_count = math.ceil(current_frames / samples_per_frame)
            padded = np.pad(
                mono,
                (0, local_count * samples_per_frame - current_frames),
                mode="constant",
            ).reshape(local_count, samples_per_frame)
            rms = np.sqrt(np.mean(np.square(padded), axis=1))
            levels.extend(-120.0 if value <= 0 else 20.0 * math.log10(float(value)) for value in rms)
            spectrum = np.abs(np.fft.rfft(padded * window, axis=1)).astype(np.float64)
            power = np.square(spectrum) + 1e-18
            total_power = np.sum(power, axis=1)
            high_power = np.sum(power[:, high_band_mask], axis=1)
            high_band_ratios.extend(
                min(1.0, max(0.0, float(high / total))) if total > 0 else 0.0
                for high, total in zip(high_power, total_power)
            )
            spectral_flatness = np.exp(np.mean(np.log(power), axis=1)) / np.maximum(
                np.mean(power, axis=1),
                1e-18,
            )
            periodicities.extend(
                min(1.0, max(0.0, 1.0 - float(flatness)))
                for flatness in spectral_flatness
            )
            for local_index, current_spectrum in enumerate(spectrum):
                reference = previous_spectrum if local_index == 0 else spectrum[local_index - 1]
                if reference is None:
                    flux_values.append(0.0)
                else:
                    denominator = float(np.sum(current_spectrum) + np.sum(reference)) + 1e-12
                    flux_values.append(
                        min(1.0, max(0.0, float(np.sum(np.abs(current_spectrum - reference))) / denominator))
                    )
            previous_spectrum = spectrum[-1].copy()
            remaining -= current_frames

    frame_count = len(levels)
    probabilities = _vad_probabilities(source_report, frame_count)
    active_levels = [
        level
        for index, level in enumerate(levels)
        if level > -100.0 and (probabilities is None or probabilities[index] >= 0.5)
    ]
    reference_levels = active_levels or [level for level in levels if level > -100.0]
    source_reference_db = _percentile(reference_levels, 0.5) if reference_levels else -60.0
    noise_floor_db = _percentile(levels, 0.20) if levels else -120.0
    active_threshold_db = max(-60.0, min(noise_floor_db + 8.0, source_reference_db - 14.0))
    active_mask = [level >= active_threshold_db for level in levels]
    run_lengths = [0] * frame_count
    run_start = 0
    while run_start < frame_count:
        if not active_mask[run_start]:
            run_start += 1
            continue
        run_end = run_start + 1
        while run_end < frame_count and active_mask[run_end]:
            run_end += 1
        run_length = run_end - run_start
        for index in range(run_start, run_end):
            run_lengths[index] = run_length
        run_start = run_end
    silence_prefix = [0]
    for active in active_mask:
        silence_prefix.append(silence_prefix[-1] + (0 if active else 1))
    context_radius = max(1, round(200.0 / 10.0))
    evidence: list[dict[str, float]] = []
    for index, level_db in enumerate(levels):
        context_start = max(0, index - context_radius)
        context_end = min(frame_count, index + context_radius + 1)
        context_size = max(1, context_end - context_start)
        near_silence = (
            silence_prefix[context_end] - silence_prefix[context_start]
        ) / context_size
        speech_probability = (
            probabilities[index]
            if probabilities is not None
            else _smoothstep(level_db, active_threshold_db - 4.0, source_reference_db - 3.0)
        )
        run_length = run_lengths[index]
        short_event = (
            0.0
            if run_length <= 0 or run_length > 60
            else max(0.0, 1.0 - run_length / 60.0)
        )
        short_event = max(short_event, _smoothstep(flux_values[index], 0.20, 0.75))
        evidence.append(
            {
                "speech_probability": speech_probability,
                "level_db": level_db,
                "spectral_flux": flux_values[index],
                "periodicity": periodicities[index],
                "high_band_ratio": high_band_ratios[index],
                "short_event_probability": min(1.0, short_event),
                "near_silence_context": min(1.0, max(0.0, near_silence)),
            }
        )
    return evidence, source_reference_db


def _render_adaptive_rnnoise_candidate(
    source_path: Path,
    rnnoise_path: Path,
    candidate_path: Path,
    *,
    limits: WavLimits,
    mix_curve: Sequence[float],
) -> None:
    import numpy as np

    source_info = inspect_wav_file(source_path, limits)
    rnnoise_info = inspect_wav_file(rnnoise_path, limits)
    if (
        source_info.sample_rate != rnnoise_info.sample_rate
        or source_info.channels != rnnoise_info.channels
        or source_info.frames != rnnoise_info.frames
    ):
        raise RuntimeError("candidate-integrity-mismatch")
    samples_per_mix_frame = max(1, round(source_info.sample_rate * 0.01))
    source_bytes_per_frame = source_info.sample_width_bytes * source_info.channels
    rnnoise_bytes_per_frame = rnnoise_info.sample_width_bytes * rnnoise_info.channels
    processed_frames = 0
    block_frames = samples_per_mix_frame * 100
    with source_path.open("rb") as source, rnnoise_path.open("rb") as rnnoise, candidate_path.open("wb") as output:
        source.seek(source_info.data_offset)
        rnnoise.seek(rnnoise_info.data_offset)
        _write_canonical_wav_header(output, source_info)
        while processed_frames < source_info.frames:
            current_frames = min(block_frames, source_info.frames - processed_frames)
            source_raw = source.read(current_frames * source_bytes_per_frame)
            rnnoise_raw = rnnoise.read(current_frames * rnnoise_bytes_per_frame)
            if len(source_raw) != current_frames * source_bytes_per_frame or len(rnnoise_raw) != current_frames * rnnoise_bytes_per_frame:
                raise EOFError("truncated-adaptive-candidate-input")
            dry = _decode_interleaved_samples(
                source_raw,
                sample_width=source_info.sample_width_bytes,
                channels=source_info.channels,
                format_code=source_info.format_code,
            )
            wet = _decode_interleaved_samples(
                rnnoise_raw,
                sample_width=rnnoise_info.sample_width_bytes,
                channels=rnnoise_info.channels,
                format_code=rnnoise_info.format_code,
            )
            positions = (
                processed_frames + np.arange(current_frames, dtype=np.float64)
            ) / samples_per_mix_frame
            left = np.floor(positions).astype(np.int64)
            right = np.minimum(left + 1, max(0, len(mix_curve) - 1))
            left = np.minimum(left, max(0, len(mix_curve) - 1))
            fractions = positions - np.floor(positions)
            curve = np.asarray(mix_curve if mix_curve else (0.0,), dtype=np.float64)
            sample_mix = curve[left] * (1.0 - fractions) + curve[right] * fractions
            blended = dry * (1.0 - sample_mix[:, None]) + wet * sample_mix[:, None]
            output.write(
                _encode_interleaved_samples(
                    blended,
                    sample_width=source_info.sample_width_bytes,
                    format_code=source_info.format_code,
                )
            )
            processed_frames += current_frames


def _signal_peak(path: Path, *, info: Any) -> float:
    peak = 0.0
    bytes_per_frame = info.sample_width_bytes * info.channels
    remaining = info.frames
    with path.open("rb") as source:
        source.seek(info.data_offset)
        while remaining > 0:
            current_frames = min(65_536, remaining)
            raw = source.read(current_frames * bytes_per_frame)
            if len(raw) != current_frames * bytes_per_frame:
                raise EOFError("truncated-candidate-wav")
            decoded = _decode_interleaved_samples(
                raw,
                sample_width=info.sample_width_bytes,
                channels=info.channels,
                format_code=info.format_code,
            )
            if decoded.size:
                peak = max(peak, float(abs(decoded).max()))
            remaining -= current_frames
    return peak


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


def assess_rnnoise_candidate_integrity(
    source_path: Path,
    candidate_path: Path,
    *,
    limits: WavLimits,
    source_report: Mapping[str, Any] | None = None,
    candidate_report: Mapping[str, Any] | None = None,
) -> RnnoiseCandidateIntegrityAssessment:
    """Accept only structurally safe audio; learned quality scores stay advisory."""
    del source_report, candidate_report
    try:
        source_info = inspect_wav_file(source_path, limits)
        candidate_info = inspect_wav_file(candidate_path, limits)
    except (OSError, EOFError, WavValidationError):
        return RnnoiseCandidateIntegrityAssessment(False, "candidate-corrupt-or-incompatible")
    if (
        source_info.sample_rate != candidate_info.sample_rate
        or source_info.channels != candidate_info.channels
        or source_info.frames != candidate_info.frames
        or source_info.sample_width_bytes != candidate_info.sample_width_bytes
        or source_info.format_code != candidate_info.format_code
    ):
        return RnnoiseCandidateIntegrityAssessment(False, "candidate-geometry-mismatch")
    try:
        _, source_frames = _frame_rms_db(source_path, limits=limits)
        _, candidate_frames = _frame_rms_db(candidate_path, limits=limits)
        source_peak = _signal_peak(source_path, info=source_info)
        candidate_peak = _signal_peak(candidate_path, info=candidate_info)
    except ValueError as exc:
        reason = str(exc)
        if "non-finite" in reason or "out-of-range-float" in reason:
            return RnnoiseCandidateIntegrityAssessment(False, "candidate-non-finite")
        return RnnoiseCandidateIntegrityAssessment(False, "candidate-corrupt-or-incompatible")
    except (OSError, EOFError, WavValidationError):
        return RnnoiseCandidateIntegrityAssessment(False, "candidate-corrupt-or-incompatible")
    if len(source_frames) != len(candidate_frames) or not source_frames:
        return RnnoiseCandidateIntegrityAssessment(False, "candidate-geometry-mismatch")
    if candidate_peak >= 0.999 and source_peak < 0.98:
        return RnnoiseCandidateIntegrityAssessment(
            False,
            "introduced-clipping",
            source_peak=source_peak,
            candidate_peak=candidate_peak,
        )

    noise_floor = _percentile(source_frames, 0.20)
    ordinary_body = _percentile(source_frames, 0.50)
    active_threshold = max(-60.0, min(noise_floor + 10.0, ordinary_body - 8.0))
    active_indices = [
        index for index, source_db in enumerate(source_frames)
        if source_db >= active_threshold
    ]
    if active_indices:
        active_deltas = [
            candidate_frames[index] - source_frames[index]
            for index in active_indices
        ]
        active_median_delta = _percentile(active_deltas, 0.50)
        erased_fraction = sum(delta <= -18.0 for delta in active_deltas) / len(active_deltas)
        if active_median_delta <= -12.0 or erased_fraction >= 0.20:
            return RnnoiseCandidateIntegrityAssessment(
                False,
                "gross-speech-erasure",
                source_peak=source_peak,
                candidate_peak=candidate_peak,
                active_median_delta_db=active_median_delta,
                erased_active_fraction=erased_fraction,
            )
    else:
        active_median_delta = 0.0
        erased_fraction = 0.0
    return RnnoiseCandidateIntegrityAssessment(
        True,
        "technical-integrity-passed",
        source_peak=source_peak,
        candidate_peak=candidate_peak,
        active_median_delta_db=active_median_delta,
        erased_active_fraction=erased_fraction,
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
        candidate_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = candidate_path.with_suffix(".candidate.tmp.wav")
        try:
            frame_evidence, source_reference_db = _extract_rnnoise_frame_evidence(
                source_path,
                limits=limits,
                source_report=source_report,
            )
            mix_curve = build_rnnoise_adaptive_mix_curve(
                frame_evidence,
                base_mix=policy.mix,
                source_reference_db=source_reference_db,
                frame_ms=10.0,
            )
            if not mix_curve:
                raise RuntimeError("adaptive-mix-evidence-unavailable")
            with tempfile.TemporaryDirectory(dir=str(candidate_path.parent)) as temp_dir:
                rnnoise_output = Path(temp_dir) / "rnnoise.wav"
                temp_output = Path(temp_dir) / "candidate.wav"
                command = [
                    self.ffmpeg_path,
                    "-hide_banner",
                    "-nostdin",
                    "-y",
                    "-i",
                    str(source_path),
                    "-af",
                    f"aresample=48000,arnndn=m='{str(model_path).replace(chr(92), '/').replace(':', chr(92) + ':')}':mix=1.000",
                    "-ac",
                    str(source_info.channels),
                    "-ar",
                    str(source_info.sample_rate),
                    "-c:a",
                    "pcm_f32le",
                    str(rnnoise_output),
                ]
                subprocess.run(
                    command,
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=self.timeout_seconds,
                )
                _render_adaptive_rnnoise_candidate(
                    source_path,
                    rnnoise_output,
                    temp_output,
                    limits=limits,
                    mix_curve=mix_curve,
                )
                integrity = assess_rnnoise_candidate_integrity(
                    source_path,
                    temp_output,
                    limits=limits,
                    source_report=source_report,
                )
                if not integrity.safe_to_use:
                    return EnhancementResult(
                        candidate_path=None,
                        telemetry={
                            **self._degraded(integrity.reason),
                            "enhancementBaseMix": round(policy.mix, 6),
                            "candidatePeak": round(integrity.candidate_peak, 6),
                            "sourcePeak": round(integrity.source_peak, 6),
                            "activeMedianDeltaDb": round(integrity.active_median_delta_db, 6),
                            "erasedActiveFraction": round(integrity.erased_active_fraction, 6),
                        },
                        model=self._model_metadata(),
                    )
                os.replace(temp_output, temporary_path)
            os.replace(temporary_path, candidate_path)
        except (OSError, EOFError, ValueError, subprocess.SubprocessError, RuntimeError, WavValidationError):
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
                "enhancementBaseMix": round(policy.mix, 6),
                "enhancementMixMin": round(min(mix_curve), 6),
                "enhancementMixMedian": round(_percentile(list(mix_curve), 0.5), 6),
                "enhancementMixMax": round(max(mix_curve), 6),
                "protectedFrameFraction": round(
                    sum(mix <= policy.mix * 0.25 for mix in mix_curve) / len(mix_curve),
                    6,
                ),
                "noiseEvidence": round(policy.noise_evidence, 6),
                "speechFraction": round(policy.speech_fraction, 6),
                "sourceReferenceDb": round(source_reference_db, 3),
                "candidatePeak": round(integrity.candidate_peak, 6),
                "sourcePeak": round(integrity.source_peak, 6),
                "activeMedianDeltaDb": round(integrity.active_median_delta_db, 6),
                "erasedActiveFraction": round(integrity.erased_active_fraction, 6),
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
