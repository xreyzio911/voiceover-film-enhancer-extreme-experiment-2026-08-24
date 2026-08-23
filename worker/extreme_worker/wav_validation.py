from __future__ import annotations

import math
import struct
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
    data_offset: int
    data_bytes: int


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


_WAVE_FORMAT_PCM = 0x0001
_WAVE_FORMAT_IEEE_FLOAT = 0x0003
_WAVE_FORMAT_EXTENSIBLE = 0xFFFE
_PCM_SUBFORMAT_GUID = bytes.fromhex("0100000000001000800000aa00389b71")
_IEEE_FLOAT_SUBFORMAT_GUID = bytes.fromhex("0300000000001000800000aa00389b71")
_FLOAT_SCAN_CHUNK_SAMPLES = 16_384


def _parse_format_payload(payload: bytes) -> dict[str, int]:
    if len(payload) < 16:
        raise WavValidationError("invalid format chunk")
    raw_format = _u16(payload, 0)
    bits = _u16(payload, 14)
    canonical_format = raw_format
    if raw_format == _WAVE_FORMAT_EXTENSIBLE:
        if len(payload) < 40:
            raise WavValidationError("invalid extensible format chunk")
        extension_bytes = _u16(payload, 16)
        if extension_bytes < 22 or 18 + extension_bytes > len(payload):
            raise WavValidationError("invalid extensible format size")
        valid_bits = _u16(payload, 18)
        if valid_bits != bits:
            raise WavValidationError("unsupported extensible valid-bit width")
        subformat_guid = payload[24:40]
        if subformat_guid == _PCM_SUBFORMAT_GUID:
            canonical_format = _WAVE_FORMAT_PCM
        elif subformat_guid == _IEEE_FLOAT_SUBFORMAT_GUID:
            canonical_format = _WAVE_FORMAT_IEEE_FLOAT
        else:
            raise WavValidationError("unsupported extensible WAV subformat")
    return {
        "format": canonical_format,
        "channels": _u16(payload, 2),
        "sample_rate": _u32(payload, 4),
        "byte_rate": _u32(payload, 8),
        "block_align": _u16(payload, 12),
        "bits": bits,
    }


def _parse_chunks(data: bytes) -> tuple[dict[str, int], int, int]:
    if not isinstance(data, bytes):
        raise WavValidationError("WAV upload must be bytes")
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise WavValidationError("not a RIFF/WAVE file")
    if _u32(data, 4) != len(data) - 8:
        raise WavValidationError("RIFF size does not match uploaded bytes")
    offset = 12
    fmt: dict[str, int] | None = None
    data_bytes: int | None = None
    data_offset: int | None = None
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
            fmt = _parse_format_payload(data[chunk_start:chunk_end])
        elif chunk_id == b"data":
            if data_bytes is not None:
                raise WavValidationError("multiple data chunks")
            data_bytes = chunk_size
            data_offset = chunk_start
        offset = padded_end
    if fmt is None or data_bytes is None or data_offset is None:
        raise WavValidationError("missing required WAV chunks")
    return fmt, data_bytes, data_offset


def _validate_info(
    fmt: dict[str, int],
    data_bytes: int,
    data_offset: int,
    upload_bytes: int,
    limits: WavLimits,
) -> WavInfo:
    if limits.max_upload_bytes <= 0 or limits.max_duration_seconds <= 0 or limits.max_decoded_frames <= 0:
        raise ValueError("WAV validation limits must be positive")
    if upload_bytes > limits.max_upload_bytes:
        raise WavValidationError("upload exceeds byte limit")
    if fmt["bits"] <= 0 or fmt["bits"] % 8:
        raise WavValidationError("invalid PCM sample width")
    sample_width_bytes = fmt["bits"] // 8
    expected_block_align = fmt["channels"] * sample_width_bytes
    expected_byte_rate = fmt["sample_rate"] * expected_block_align
    if fmt["format"] not in {_WAVE_FORMAT_PCM, _WAVE_FORMAT_IEEE_FLOAT}:
        raise WavValidationError("only integer PCM or IEEE float32 WAV is accepted")
    if fmt["format"] == _WAVE_FORMAT_IEEE_FLOAT and fmt["bits"] != 32:
        raise WavValidationError("IEEE float WAV must use 32-bit samples")
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
    if data_offset < 20 or data_offset + data_bytes > upload_bytes:
        raise WavValidationError("invalid audio data bounds")
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
        data_offset,
        data_bytes,
    )


def inspect_wav_bytes(data: bytes, limits: WavLimits) -> WavInfo:
    if len(data) > limits.max_upload_bytes:
        raise WavValidationError("upload exceeds byte limit")
    fmt, data_bytes, data_offset = _parse_chunks(data)
    return _validate_info(fmt, data_bytes, data_offset, len(data), limits)


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
        data_offset: int | None = None
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
                payload = stream.read(chunk_size)
                if len(payload) != chunk_size:
                    raise WavValidationError("truncated format chunk")
                fmt = _parse_format_payload(payload)
            elif chunk_id == b"data":
                if data_bytes is not None:
                    raise WavValidationError("multiple data chunks")
                data_bytes = chunk_size
                data_offset = chunk_start
            offset = padded_end
    if fmt is None or data_bytes is None or data_offset is None:
        raise WavValidationError("missing required WAV chunks")
    return _validate_info(fmt, data_bytes, data_offset, upload_bytes, limits)


def validate_float_sample_values(path: str | Path, info: WavInfo) -> None:
    """Reject float WAV values that cannot be passed to the model unchanged."""
    if info.format_code != _WAVE_FORMAT_IEEE_FLOAT:
        return
    if info.sample_width_bytes != 4:
        raise WavValidationError("IEEE float WAV must use 32-bit samples")
    source = Path(path)
    remaining = info.data_bytes
    with source.open("rb") as stream:
        stream.seek(info.data_offset)
        while remaining > 0:
            chunk_bytes = min(remaining, _FLOAT_SCAN_CHUNK_SAMPLES * 4)
            raw = stream.read(chunk_bytes)
            if len(raw) != chunk_bytes or chunk_bytes % 4:
                raise WavValidationError("truncated float audio data")
            for (sample,) in struct.iter_unpack("<f", raw):
                if not math.isfinite(sample):
                    raise WavValidationError("non-finite-float-samples")
                if sample < -1.0 or sample > 1.0:
                    raise WavValidationError("out-of-range-float-samples")
            remaining -= chunk_bytes


def validate_wav_upload(data: bytes, *, max_bytes: int, max_duration_seconds: float) -> WavValidationResult:
    try:
        if len(data) > max_bytes:
            raise WavValidationError("upload exceeds byte limit")
        fmt, data_bytes, _data_offset = _parse_chunks(data)
        sample_width_bytes = fmt["bits"] // 8
        expected_block_align = fmt["channels"] * sample_width_bytes
        if fmt["format"] not in {_WAVE_FORMAT_PCM, _WAVE_FORMAT_IEEE_FLOAT}:
            raise WavValidationError("only integer PCM or IEEE float32 WAV is accepted")
        if fmt["format"] == _WAVE_FORMAT_IEEE_FLOAT and fmt["bits"] != 32:
            raise WavValidationError("IEEE float WAV must use 32-bit samples")
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
