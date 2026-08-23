from __future__ import annotations

import struct
import unittest

from contract_support import require_symbols


def pcm_wav(
    *,
    sample_rate: int = 48_000,
    channels: int = 1,
    bits_per_sample: int = 16,
    frames: int = 480,
    format_code: int = 1,
) -> bytes:
    sample_bytes = max(1, bits_per_sample // 8)
    block_align = channels * sample_bytes
    byte_rate = sample_rate * block_align
    samples = b"\x00" * (frames * block_align)
    fmt = struct.pack(
        "<HHIIHH",
        format_code,
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
    )
    data_chunk = b"data" + struct.pack("<I", len(samples)) + samples
    if len(samples) % 2:
        data_chunk += b"\x00"
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + data_chunk
    return b"RIFF" + struct.pack("<I", len(body)) + body


def extensible_pcm_wav(
    *,
    sample_rate: int = 48_000,
    channels: int = 1,
    bits_per_sample: int = 24,
    frames: int = 480,
    valid_bits_per_sample: int | None = None,
    subformat_code: int = 1,
) -> bytes:
    sample_bytes = bits_per_sample // 8
    block_align = channels * sample_bytes
    byte_rate = sample_rate * block_align
    samples = b"\x00" * (frames * block_align)
    subformat_guid = struct.pack("<I", subformat_code) + bytes.fromhex(
        "00001000800000aa00389b71"
    )
    fmt = struct.pack(
        "<HHIIHHHHI",
        0xFFFE,
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        22,
        valid_bits_per_sample or bits_per_sample,
        4 if channels == 1 else 3,
    ) + subformat_guid
    data_chunk = b"data" + struct.pack("<I", len(samples)) + samples
    if len(samples) % 2:
        data_chunk += b"\x00"
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + data_chunk
    return b"RIFF" + struct.pack("<I", len(body)) + body


class WavValidationContractTests(unittest.TestCase):
    MODULE = "extreme_worker.wav_validation"

    def setUp(self) -> None:
        self.WavLimits, self.inspect_wav_bytes, self.WavValidationError = require_symbols(
            self,
            self.MODULE,
            "WavLimits",
            "inspect_wav_bytes",
            "WavValidationError",
        )
        self.limits = self.WavLimits(
            max_upload_bytes=2_000_000,
            allowed_sample_rates=frozenset({16_000, 24_000, 44_100, 48_000}),
            allowed_channels=frozenset({1, 2}),
            allowed_sample_width_bytes=frozenset({2, 3, 4}),
            max_duration_seconds=10.0,
            max_decoded_frames=480_000,
        )

    def test_valid_pcm_wav_reports_exact_header_facts(self) -> None:
        payload = pcm_wav(frames=4_800)
        info = self.inspect_wav_bytes(payload, self.limits)
        self.assertEqual(info.format_code, 1)
        self.assertEqual(info.sample_rate, 48_000)
        self.assertEqual(info.channels, 1)
        self.assertEqual(info.sample_width_bytes, 2)
        self.assertEqual(info.frames, 4_800)
        self.assertAlmostEqual(info.duration_seconds, 0.1, places=6)
        self.assertEqual(info.upload_bytes, len(payload))

    def test_valid_extensible_integer_pcm_is_canonicalized_and_reports_data_bounds(self) -> None:
        payload = extensible_pcm_wav(frames=4_800)
        info = self.inspect_wav_bytes(payload, self.limits)
        self.assertEqual(info.format_code, 1)
        self.assertEqual(info.sample_rate, 48_000)
        self.assertEqual(info.channels, 1)
        self.assertEqual(info.sample_width_bytes, 3)
        self.assertEqual(info.frames, 4_800)
        self.assertEqual(info.data_offset, 68)
        self.assertEqual(info.data_bytes, 4_800 * 3)

    def test_extensible_float_and_malformed_pcm_extensions_are_rejected(self) -> None:
        malformed = bytearray(extensible_pcm_wav())
        malformed[36:38] = struct.pack("<H", 0)
        variants = (
            extensible_pcm_wav(subformat_code=3),
            extensible_pcm_wav(valid_bits_per_sample=20),
            bytes(malformed),
        )
        for payload in variants:
            with self.subTest(payload=payload[12:52].hex()), self.assertRaises(self.WavValidationError):
                self.inspect_wav_bytes(payload, self.limits)

    def test_non_riff_or_non_wave_payload_is_rejected(self) -> None:
        valid = pcm_wav()
        variants = (b"not audio", b"RIFX" + valid[4:], valid[:8] + b"AVI " + valid[12:])
        for payload in variants:
            with self.subTest(prefix=payload[:12]), self.assertRaises(self.WavValidationError):
                self.inspect_wav_bytes(payload, self.limits)

    def test_truncated_declared_audio_data_is_rejected(self) -> None:
        payload = pcm_wav(frames=480)
        with self.assertRaises(self.WavValidationError):
            self.inspect_wav_bytes(payload[:-1], self.limits)

        declared_too_large = bytearray(payload)
        declared_too_large[40:44] = struct.pack("<I", 10_000_000)
        with self.assertRaises(self.WavValidationError):
            self.inspect_wav_bytes(bytes(declared_too_large), self.limits)

    def test_float_and_compressed_wav_formats_are_rejected(self) -> None:
        for format_code in (3, 6, 7, 17):
            with self.subTest(format_code=format_code), self.assertRaises(self.WavValidationError):
                self.inspect_wav_bytes(pcm_wav(format_code=format_code), self.limits)

    def test_upload_byte_limit_is_enforced_before_decode(self) -> None:
        tiny_limit = self.WavLimits(
            max_upload_bytes=100,
            allowed_sample_rates=self.limits.allowed_sample_rates,
            allowed_channels=self.limits.allowed_channels,
            allowed_sample_width_bytes=self.limits.allowed_sample_width_bytes,
            max_duration_seconds=10.0,
            max_decoded_frames=480_000,
        )
        with self.assertRaises(self.WavValidationError):
            self.inspect_wav_bytes(pcm_wav(frames=480), tiny_limit)

    def test_sample_rate_allowlist_is_exact(self) -> None:
        for sample_rate in (8_000, 22_050, 96_000):
            with self.subTest(sample_rate=sample_rate), self.assertRaises(self.WavValidationError):
                self.inspect_wav_bytes(pcm_wav(sample_rate=sample_rate), self.limits)

    def test_channel_allowlist_is_exact(self) -> None:
        self.assertEqual(self.inspect_wav_bytes(pcm_wav(channels=2), self.limits).channels, 2)
        with self.assertRaises(self.WavValidationError):
            self.inspect_wav_bytes(pcm_wav(channels=3), self.limits)

    def test_sample_width_allowlist_is_exact(self) -> None:
        for bits in (16, 24, 32):
            with self.subTest(bits=bits):
                self.assertEqual(self.inspect_wav_bytes(pcm_wav(bits_per_sample=bits), self.limits).sample_width_bytes, bits // 8)
        with self.assertRaises(self.WavValidationError):
            self.inspect_wav_bytes(pcm_wav(bits_per_sample=8), self.limits)

    def test_duration_limit_is_enforced(self) -> None:
        with self.assertRaises(self.WavValidationError):
            self.inspect_wav_bytes(pcm_wav(sample_rate=16_000, frames=160_001), self.limits)
        boundary = self.inspect_wav_bytes(pcm_wav(sample_rate=16_000, frames=160_000), self.limits)
        self.assertAlmostEqual(boundary.duration_seconds, 10.0)

    def test_decoded_frame_limit_is_independent_of_file_size(self) -> None:
        frame_limited = self.WavLimits(
            max_upload_bytes=2_000_000,
            allowed_sample_rates=self.limits.allowed_sample_rates,
            allowed_channels=self.limits.allowed_channels,
            allowed_sample_width_bytes=self.limits.allowed_sample_width_bytes,
            max_duration_seconds=60.0,
            max_decoded_frames=1_000,
        )
        self.assertEqual(self.inspect_wav_bytes(pcm_wav(frames=1_000), frame_limited).frames, 1_000)
        with self.assertRaises(self.WavValidationError):
            self.inspect_wav_bytes(pcm_wav(frames=1_001), frame_limited)

    def test_empty_audio_and_inconsistent_format_math_are_rejected(self) -> None:
        with self.assertRaises(self.WavValidationError):
            self.inspect_wav_bytes(pcm_wav(frames=0), self.limits)

        payload = bytearray(pcm_wav(frames=10))
        payload[28:32] = struct.pack("<I", 123)
        with self.assertRaises(self.WavValidationError):
            self.inspect_wav_bytes(bytes(payload), self.limits)


if __name__ == "__main__":
    unittest.main()
