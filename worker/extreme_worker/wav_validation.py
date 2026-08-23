from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import FrozenSet


class WavValidationError(ValueError):
    pass


@dataclass(frozen=True)
class WavLimits:
    max_upload_bytes: int
    allowed_sample_rates: FrozenSet[int]
    allowed_channels: FrozenSet[int]
    allowed_sample_width_bytes: FrozenSet[int]
    max_duration_seconds: float
    max_decoded_frames: int


@dataclass(frozen=True)
class WavInfo:
    format_code: int
    sample_rate: int
    channels: int
    sample_width_bytes: int
    frames: int
    duration_seconds: float
    upload_bytes: int


@dataclass(frozen=True)
class WavValidationResult:
    ok: bool
    error: str | None = None
    sample_rate: int | None = None
    channels: int | None = None
    duration_seconds: float | None = None


def _u16(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 2], "little")


def _u32(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 4], "little")


def _parse_chunks(data: bytes) -> tuple[dict[str, int], int]:
    if not isinstance(data, bytes):
        raise WavValidationError("WAV upload must be bytes")
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise WavValidationError("not a RIFF/WAVE file")
    if _u32(data, 4) != len(data) - 8:
        raise WavValidationError("RIFF size does not match uploaded bytes")
    offset = 12
    fmt: dict[str, int] | None = None
    data_bytes: int | None = None
    while offset < len(data):
        if offset + 8 > len(data):
            raise WavValidationError("truncated chunk header")
        chunk_id = data[offset : offset + 4]
        chunk_size = _u32(data, offset + 4)
        chunk_start = offset + 8
        chunk_end = chunk_start + chunk_size
        padded_end = chunk_end + (chunk_size % 2)
        if chunk_end > len(data) or padded_end > len(data):
            raise WavValidationError("truncated chunk")
        if chunk_id == b"fmt " and chunk_size >= 16:
            if fmt is not None:
                raise WavValidationError("multiple format chunks")
            fmt = {
                "format": _u16(data, chunk_start),
                "channels": _u16(data, chunk_start + 2),
                "sample_rate": _u32(data, chunk_start + 4),
                "byte_rate": _u32(data, chunk_start + 8),
                "block_align": _u16(data, chunk_start + 12),
                "bits": _u16(data, chunk_start + 14),
            }
        elif chunk_id == b"data":
            if data_bytes is not None:
                raise WavValidationError("multiple data chunks")
            data_bytes = chunk_size
        offset = padded_end
    if fmt is None or data_bytes is None:
        raise WavValidationError("missing required WAV chunks")
    return fmt, data_bytes


def _validate_info(fmt: dict[str, int], data_bytes: int, upload_bytes: int, limits: WavLimits) -> WavInfo:
    if limits.max_upload_bytes <= 0 or limits.max_duration_seconds <= 0 or limits.max_decoded_frames <= 0:
        raise ValueError("WAV validation limits must be positive")
    if upload_bytes > limits.max_upload_bytes:
        raise WavValidationError("upload exceeds byte limit")
    if fmt["bits"] <= 0 or fmt["bits"] % 8:
        raise WavValidationError("invalid PCM sample width")
    sample_width_bytes = fmt["bits"] // 8
    expected_block_align = fmt["channels"] * sample_width_bytes
    expected_byte_rate = fmt["sample_rate"] * expected_block_align
    if fmt["format"] != 1:
        raise WavValidationError("only PCM WAV is accepted")
    if fmt["sample_rate"] not in limits.allowed_sample_rates:
        raise WavValidationError("sample rate outside allowlist")
    if fmt["channels"] not in limits.allowed_channels:
        raise WavValidationError("channel count outside allowlist")
    if sample_width_bytes not in limits.allowed_sample_width_bytes:
        raise WavValidationError("sample width outside allowlist")
    if fmt["block_align"] != expected_block_align or fmt["byte_rate"] != expected_byte_rate:
        raise WavValidationError("inconsistent WAV format math")
    if fmt["block_align"] <= 0 or data_bytes <= 0 or data_bytes % fmt["block_align"] != 0:
        raise WavValidationError("invalid audio data length")
    frames = data_bytes // fmt["block_align"]
    duration_seconds = frames / fmt["sample_rate"]
    if duration_seconds > limits.max_duration_seconds:
        raise WavValidationError("duration exceeds limit")
    if frames > limits.max_decoded_frames:
        raise WavValidationError("decoded frame count exceeds limit")
    return WavInfo(
        fmt["format"],
        fmt["sample_rate"],
        fmt["channels"],
        sample_width_bytes,
        frames,
        duration_seconds,
        upload_bytes,
    )


def inspect_wav_bytes(data: bytes, limits: WavLimits) -> WavInfo:
    if len(data) > limits.max_upload_bytes:
        raise WavValidationError("upload exceeds byte limit")
    fmt, data_bytes = _parse_chunks(data)
    return _validate_info(fmt, data_bytes, len(data), limits)


def inspect_wav_file(path: str | Path, limits: WavLimits) -> WavInfo:
    """Inspect a WAV by seeking over chunks, never loading the audio payload."""
    source = Path(path)
    upload_bytes = source.stat().st_size
    if upload_bytes > limits.max_upload_bytes:
        raise WavValidationError("upload exceeds byte limit")
    if upload_bytes < 44:
        raise WavValidationError("not a RIFF/WAVE file")
    with source.open("rb") as stream:
        header = stream.read(12)
        if header[:4] != b"RIFF" or header[8:12] != b"WAVE":
            raise WavValidationError("not a RIFF/WAVE file")
        if _u32(header, 4) != upload_bytes - 8:
            raise WavValidationError("RIFF size does not match uploaded bytes")
        offset = 12
        fmt: dict[str, int] | None = None
        data_bytes: int | None = None
        while offset < upload_bytes:
            if offset + 8 > upload_bytes:
                raise WavValidationError("truncated chunk header")
            stream.seek(offset)
            chunk_header = stream.read(8)
            chunk_id = chunk_header[:4]
            chunk_size = _u32(chunk_header, 4)
            chunk_start = offset + 8
            chunk_end = chunk_start + chunk_size
            padded_end = chunk_end + (chunk_size % 2)
            if chunk_end > upload_bytes or padded_end > upload_bytes:
                raise WavValidationError("truncated chunk")
            if chunk_id == b"fmt ":
                if fmt is not None or chunk_size < 16 or chunk_size > 4096:
                    raise WavValidationError("invalid format chunk")
                stream.seek(chunk_start)
                payload = stream.read(16)
                fmt = {
                    "format": _u16(payload, 0),
                    "channels": _u16(payload, 2),
                    "sample_rate": _u32(payload, 4),
                    "byte_rate": _u32(payload, 8),
                    "block_align": _u16(payload, 12),
                    "bits": _u16(payload, 14),
                }
            elif chunk_id == b"data":
                if data_bytes is not None:
                    raise WavValidationError("multiple data chunks")
                data_bytes = chunk_size
            offset = padded_end
    if fmt is None or data_bytes is None:
        raise WavValidationError("missing required WAV chunks")
    return _validate_info(fmt, data_bytes, upload_bytes, limits)


def validate_wav_upload(data: bytes, *, max_bytes: int, max_duration_seconds: float) -> WavValidationResult:
    try:
        if len(data) > max_bytes:
            raise WavValidationError("upload exceeds byte limit")
        fmt, data_bytes = _parse_chunks(data)
        sample_width_bytes = fmt["bits"] // 8
        expected_block_align = fmt["channels"] * sample_width_bytes
        if fmt["format"] != 1:
            raise WavValidationError("only PCM WAV is accepted")
        if fmt["channels"] < 1 or fmt["channels"] > 16:
            raise WavValidationError("channel count outside allowlist")
        if fmt["sample_rate"] < 8_000 or fmt["sample_rate"] > 384_000:
            raise WavValidationError("sample rate outside allowlist")
        if sample_width_bytes not in {2, 3, 4, 8}:
            raise WavValidationError("sample width outside allowlist")
        if fmt["block_align"] != expected_block_align:
            raise WavValidationError("inconsistent WAV format math")
        frames = data_bytes // fmt["block_align"] if fmt["block_align"] > 0 else 0
        duration_seconds = frames / fmt["sample_rate"]
        if duration_seconds > max_duration_seconds:
            raise WavValidationError("duration exceeds limit")
        return WavValidationResult(True, None, fmt["sample_rate"], fmt["channels"], duration_seconds)
    except WavValidationError as exc:
        return WavValidationResult(False, str(exc))
