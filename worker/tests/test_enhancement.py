from __future__ import annotations

import hashlib
import math
import shutil
import struct
import tempfile
import unittest
import wave
from pathlib import Path

from contract_support import require_symbols
from test_inference_runtime import _pcm16_wav


class EnhancementCandidateTests(unittest.TestCase):
    @staticmethod
    def _report(metrics: dict[str, float], *, speech_fraction: float = 0.35) -> dict[str, object]:
        frame_count = 100
        speech_frames = round(frame_count * speech_fraction)
        return {
            "metrics": {
                key: {"value": value, "available": True, "higherIsBetter": True}
                for key, value in metrics.items()
            },
            "vad": {
                "frameMs": 10,
                "frames": [
                    {
                        "startMs": index * 10,
                        "endMs": (index + 1) * 10,
                        "speechProbability": 0.92 if index < speech_frames else 0.02,
                    }
                    for index in range(frame_count)
                ],
            },
        }

    def test_rnnoise_model_pin_matches_verified_bd_artifact(self) -> None:
        module = __import__("extreme_worker.enhancement", fromlist=["RNNOISE_BD_SHA256"])
        self.assertEqual(module.RNNOISE_BD_REVISION, "3eee541a283fd3b8f81b85b1748e3b9ccbefa04d")
        self.assertEqual(
            module.RNNOISE_BD_SHA256,
            "ae3f7411e1e6a884f839a4a145c394408398f09854dbc1216ee02faafc98a17b",
        )
        self.assertTrue(module.RNNOISE_BD_SOURCE_URL.endswith("/beguiling-drafter-2018-08-30/bd.rnnn"))

    def test_missing_rnnoise_model_fails_open_without_candidate_or_source_mutation(self) -> None:
        ArnndnEnhancer, WavLimits = require_symbols(
            self,
            "extreme_worker.enhancement",
            "ArnndnEnhancer",
            "WavLimits",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_path = root / "source.wav"
            candidate_path = root / "candidate.wav"
            source_bytes = _pcm16_wav(source_path, sample_rate=48_000, seconds=0.08)
            enhancer = ArnndnEnhancer(model_dir=root / "missing-models", ffmpeg_path="ffmpeg")

            result = enhancer.enhance(
                source_path,
                candidate_path,
                limits=WavLimits(
                    max_upload_bytes=1024 * 1024,
                    allowed_sample_rates=frozenset({48_000}),
                    allowed_channels=frozenset({1}),
                    allowed_sample_width_bytes=frozenset({2}),
                    max_duration_seconds=1,
                    max_decoded_frames=48_000,
                ),
            )
            source_after_hash = hashlib.sha256(source_path.read_bytes()).hexdigest()
            candidate_exists = candidate_path.exists()

        self.assertIsNone(result.candidate_path)
        self.assertEqual(result.telemetry["runtimeStatus"], "degraded")
        self.assertEqual(result.telemetry["reason"], "rnnoise-model-unavailable")
        self.assertFalse(result.telemetry["candidateSelected"])
        self.assertEqual(source_after_hash, hashlib.sha256(source_bytes).hexdigest())
        self.assertFalse(candidate_exists)

    def test_rnnoise_policy_targets_noise_limited_speech_not_clean_low_loudness(self) -> None:
        resolve_policy, = require_symbols(
            self,
            "extreme_worker.enhancement",
            "resolve_rnnoise_candidate_policy",
        )
        clean_but_quiet = resolve_policy(
            self._report({
                "dnsmos.bak": 4.05,
                "dnsmos.sig": 3.2,
                "dnsmos.ovrl": 2.75,
                "sigmos.noise": 4.4,
                "sigmos.sig": 3.45,
                "sigmos.loud": 2.0,
            })
        )
        noisy = resolve_policy(
            self._report({
                "dnsmos.bak": 2.7,
                "dnsmos.sig": 3.45,
                "dnsmos.ovrl": 2.65,
                "sigmos.noise": 2.8,
                "sigmos.sig": 3.5,
                "sigmos.loud": 3.2,
            })
        )
        sparse_noisy = resolve_policy(
            self._report(
                {
                    "dnsmos.bak": 2.6,
                    "dnsmos.sig": 3.4,
                    "sigmos.noise": 2.7,
                    "sigmos.sig": 3.45,
                },
                speech_fraction=0.02,
            )
        )
        silence_heavy_noisy = resolve_policy(
            self._report(
                {
                    "dnsmos.bak": 2.4,
                    "dnsmos.sig": 3.45,
                    "sigmos.noise": 2.5,
                    "sigmos.sig": 3.55,
                },
                speech_fraction=0.09,
            )
        )

        self.assertFalse(clean_but_quiet.eligible)
        self.assertEqual(clean_but_quiet.reason, "source-not-noise-limited")
        self.assertEqual(clean_but_quiet.mix, 0.0)
        self.assertTrue(noisy.eligible)
        self.assertEqual(noisy.reason, "noise-limited-source")
        self.assertGreaterEqual(noisy.mix, 0.28)
        self.assertLessEqual(noisy.mix, 0.42)
        self.assertFalse(sparse_noisy.eligible)
        self.assertEqual(sparse_noisy.reason, "insufficient-speech-support")
        self.assertFalse(silence_heavy_noisy.eligible)
        self.assertEqual(silence_heavy_noisy.reason, "insufficient-speech-support")

    def test_candidate_quality_gate_requires_noise_gain_without_speech_or_overall_regression(self) -> None:
        assess_candidate, = require_symbols(
            self,
            "extreme_worker.enhancement",
            "assess_rnnoise_candidate",
        )
        source = self._report({
            "dnsmos.bak": 2.7,
            "dnsmos.sig": 3.3,
            "dnsmos.ovrl": 2.7,
            "dnsmos_p808": 3.1,
            "sigmos.noise": 2.8,
            "sigmos.sig": 3.35,
            "sigmos.ovrl": 2.75,
            "sigmos.disc": 3.4,
            "sigmos.loud": 3.1,
        })
        improved = self._report({
            "dnsmos.bak": 3.05,
            "dnsmos.sig": 3.32,
            "dnsmos.ovrl": 2.82,
            "dnsmos_p808": 3.16,
            "sigmos.noise": 3.2,
            "sigmos.sig": 3.36,
            "sigmos.ovrl": 2.84,
            "sigmos.disc": 3.39,
            "sigmos.loud": 3.08,
        })
        damaged = self._report({
            "dnsmos.bak": 3.15,
            "dnsmos.sig": 3.05,
            "dnsmos.ovrl": 2.56,
            "dnsmos_p808": 2.92,
            "sigmos.noise": 3.25,
            "sigmos.sig": 3.08,
            "sigmos.ovrl": 2.52,
            "sigmos.disc": 3.2,
            "sigmos.loud": 2.95,
        })

        accepted = assess_candidate(source, improved)
        rejected = assess_candidate(source, damaged)

        self.assertTrue(accepted.selected)
        self.assertEqual(accepted.reason, "quality-gate-passed")
        self.assertGreaterEqual(accepted.noise_delta, 0.08)
        self.assertFalse(rejected.selected)
        self.assertEqual(rejected.reason, "speech-quality-regression")

    def test_waveform_gate_preserves_energy_owned_expressive_contrast(self) -> None:
        assess_waveform, WavLimits = require_symbols(
            self,
            "extreme_worker.enhancement",
            "assess_waveform_retention",
            "WavLimits",
        )
        sample_rate = 48_000
        frame_count = sample_rate * 2

        def write_voice(path: Path, *, ordinary_scale: float, expressive_scale: float) -> None:
            samples = []
            for index in range(frame_count):
                expressive = index >= round(frame_count * 0.9)
                amplitude = 0.58 * expressive_scale if expressive else 0.14 * ordinary_scale
                samples.append(round(math.sin(2 * math.pi * 220 * index / sample_rate) * amplitude * 32_767))
            with wave.open(str(path), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(sample_rate)
                output.writeframes(struct.pack(f"<{len(samples)}h", *samples))

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_path = root / "source.wav"
            retained_path = root / "retained.wav"
            flattened_path = root / "flattened.wav"
            write_voice(source_path, ordinary_scale=1.0, expressive_scale=1.0)
            write_voice(retained_path, ordinary_scale=0.98, expressive_scale=0.95)
            write_voice(flattened_path, ordinary_scale=0.98, expressive_scale=0.55)
            limits = WavLimits(
                max_upload_bytes=2 * 1024 * 1024,
                allowed_sample_rates=frozenset({48_000}),
                allowed_channels=frozenset({1}),
                allowed_sample_width_bytes=frozenset({2}),
                max_duration_seconds=3,
                max_decoded_frames=frame_count + 1,
            )
            retained = assess_waveform(source_path, retained_path, limits=limits)
            flattened = assess_waveform(source_path, flattened_path, limits=limits)

        self.assertTrue(retained.preserved)
        self.assertGreaterEqual(retained.expressive_contrast_retention, 0.9)
        self.assertFalse(flattened.preserved)
        self.assertEqual(flattened.reason, "expressive-contrast-regression")

    @unittest.skipIf(shutil.which("ffmpeg") is None, "ffmpeg is not installed")
    def test_local_passthrough_candidate_preserves_wav_contract_for_api_tests(self) -> None:
        LocalPassthroughEnhancer, WavLimits = require_symbols(
            self,
            "extreme_worker.enhancement",
            "LocalPassthroughEnhancer",
            "WavLimits",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_path = root / "source.wav"
            candidate_path = root / "candidate.wav"
            source_bytes = _pcm16_wav(source_path, sample_rate=48_000, seconds=0.08)
            result = LocalPassthroughEnhancer().enhance(
                source_path,
                candidate_path,
                limits=WavLimits(
                    max_upload_bytes=1024 * 1024,
                    allowed_sample_rates=frozenset({48_000}),
                    allowed_channels=frozenset({1}),
                    allowed_sample_width_bytes=frozenset({2}),
                    max_duration_seconds=1,
                    max_decoded_frames=48_000,
                ),
            )
            candidate_bytes = candidate_path.read_bytes()

        self.assertEqual(result.candidate_path, candidate_path)
        self.assertTrue(result.telemetry["candidateSelected"])
        self.assertEqual(candidate_bytes, source_bytes)


if __name__ == "__main__":
    unittest.main()
