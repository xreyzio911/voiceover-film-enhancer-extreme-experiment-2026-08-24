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
from test_inference_runtime import _float32_wav, _pcm16_wav


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

    @staticmethod
    def _write_pcm16_voice(
        path: Path,
        *,
        sample_rate: int = 48_000,
        channels: int = 1,
        frames: int = 4_800,
        amplitude: float = 0.25,
    ) -> None:
        mono = [
            round(math.sin(2 * math.pi * 220 * index / sample_rate) * amplitude * 32_767)
            for index in range(frames)
        ]
        interleaved = [sample for sample in mono for _channel in range(channels)]
        with wave.open(str(path), "wb") as output:
            output.setnchannels(channels)
            output.setsampwidth(2)
            output.setframerate(sample_rate)
            output.writeframes(struct.pack(f"<{len(interleaved)}h", *interleaved))

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

    def test_rnnoise_policy_is_always_attempted_with_subtle_source_relative_mix(self) -> None:
        resolve_policy, = require_symbols(
            self,
            "extreme_worker.enhancement",
            "resolve_rnnoise_candidate_policy",
        )
        sources = {
            "clean-but-quiet": self._report({
                "dnsmos.bak": 4.05,
                "dnsmos.sig": 3.2,
                "dnsmos.ovrl": 2.75,
                "sigmos.noise": 4.4,
                "sigmos.sig": 3.45,
                "sigmos.loud": 2.0,
            }),
            "sparse-noisy-speech": self._report(
                {
                    "dnsmos.bak": 2.6,
                    "dnsmos.sig": 3.4,
                    "sigmos.noise": 2.7,
                    "sigmos.sig": 3.45,
                },
                speech_fraction=0.02,
            ),
            "fragile-source-speech": self._report({
                "dnsmos.bak": 2.6,
                "dnsmos.sig": 2.18,
                "sigmos.noise": 2.3,
                "sigmos.sig": 2.24,
            }),
        }

        for source_name, report in sources.items():
            with self.subTest(source=source_name):
                policy = resolve_policy(report)
                self.assertTrue(policy.eligible)
                self.assertEqual(policy.reason, "adaptive-source-relative-cleanup")
                self.assertGreater(policy.mix, 0.0)
                self.assertLessEqual(policy.mix, 0.18)

    def test_rnnoise_policy_scales_source_relative_mix_instead_of_binary_gating(self) -> None:
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

        for policy in (clean_but_quiet, noisy, sparse_noisy, silence_heavy_noisy):
            self.assertTrue(policy.eligible)
            self.assertEqual(policy.reason, "adaptive-source-relative-cleanup")
            self.assertGreater(policy.mix, 0.0)
            self.assertLessEqual(policy.mix, 0.18)
        self.assertGreater(noisy.mix, clean_but_quiet.mix)
        self.assertLess(sparse_noisy.mix, noisy.mix)
        self.assertLess(silence_heavy_noisy.mix, noisy.mix)

    def test_rnnoise_policy_damps_fragile_speech_without_skipping_cleanup_attempt(self) -> None:
        resolve_policy, = require_symbols(
            self,
            "extreme_worker.enhancement",
            "resolve_rnnoise_candidate_policy",
        )
        disputed_but_usable = resolve_policy(
            self._report({
                "dnsmos.bak": 2.85,
                "dnsmos.sig": 2.83,
                "sigmos.noise": 1.89,
                "sigmos.sig": 2.29,
            })
        )
        consistently_fragile = resolve_policy(
            self._report({
                "dnsmos.bak": 2.6,
                "dnsmos.sig": 2.18,
                "sigmos.noise": 2.3,
                "sigmos.sig": 2.24,
            })
        )

        self.assertTrue(disputed_but_usable.eligible)
        self.assertEqual(disputed_but_usable.reason, "adaptive-source-relative-cleanup")
        self.assertTrue(consistently_fragile.eligible)
        self.assertEqual(consistently_fragile.reason, "adaptive-source-relative-cleanup")
        self.assertLess(consistently_fragile.mix, disputed_but_usable.mix)

    def test_adaptive_mix_curve_is_source_relative_subtle_and_slew_limited_at_10_ms(self) -> None:
        build_curve, = require_symbols(
            self,
            "extreme_worker.enhancement",
            "build_rnnoise_adaptive_mix_curve",
        )

        def ordinary(level_db: float) -> dict[str, float]:
            return {
                "speech_probability": 0.95,
                "level_db": level_db,
                "spectral_flux": 0.05,
                "periodicity": 0.9,
                "high_band_ratio": 0.18,
                "short_event_probability": 0.03,
                "near_silence_context": 0.02,
            }

        quiet = [ordinary(-34.0) for _ in range(80)]
        louder = [ordinary(-16.0) for _ in range(80)]
        quiet_curve = build_curve(
            quiet,
            base_mix=0.18,
            source_reference_db=-34.0,
            frame_ms=10,
        )
        louder_curve = build_curve(
            louder,
            base_mix=0.18,
            source_reference_db=-16.0,
            frame_ms=10,
        )

        self.assertEqual(len(quiet_curve), len(quiet))
        self.assertTrue(all(0.0 < mix <= 0.18 for mix in quiet_curve))
        self.assertTrue(all(mix >= 0.09 for mix in quiet_curve))
        self.assertLessEqual(
            max(abs(right - left) for left, right in zip(quiet_curve, quiet_curve[1:])),
            0.025,
        )
        for quiet_mix, louder_mix in zip(quiet_curve, louder_curve):
            self.assertAlmostEqual(quiet_mix, louder_mix, places=9)

    def test_adaptive_mix_curve_nearly_withdraws_around_performance_events(self) -> None:
        build_curve, = require_symbols(
            self,
            "extreme_worker.enhancement",
            "build_rnnoise_adaptive_mix_curve",
        )
        reference_db = -24.0
        base_mix = 0.18
        ordinary = {
            "speech_probability": 0.95,
            "level_db": reference_db,
            "spectral_flux": 0.05,
            "periodicity": 0.9,
            "high_band_ratio": 0.18,
            "short_event_probability": 0.03,
            "near_silence_context": 0.02,
        }
        protected_patterns = {
            "breath": (0.35, -9.0, 0.35, 0.08, 0.75, 0.8, 0.65),
            "sigh": (0.68, -5.0, 0.45, 0.3, 0.55, 0.85, 0.55),
            "gasp": (0.55, 2.0, 0.95, 0.12, 0.8, 0.98, 0.85),
            "laugh": (0.95, 5.0, 0.8, 0.62, 0.5, 0.9, 0.25),
            "grunt": (0.9, 4.0, 0.65, 0.78, 0.16, 0.92, 0.3),
            "scream": (0.99, 10.0, 0.85, 0.5, 0.78, 0.92, 0.2),
            "onomatopoeia": (0.94, 7.0, 0.95, 0.45, 0.62, 0.99, 0.3),
            "plosive": (0.82, 5.0, 1.0, 0.12, 0.82, 0.98, 0.4),
            "consonant": (0.76, 3.0, 0.92, 0.08, 0.96, 0.82, 0.3),
        }

        for event_name, pattern in protected_patterns.items():
            speech, relative_db, flux, periodicity, high_band, short_event, near_silence = pattern
            event = {
                "speech_probability": speech,
                "level_db": reference_db + relative_db,
                "spectral_flux": flux,
                "periodicity": periodicity,
                "high_band_ratio": high_band,
                "short_event_probability": short_event,
                "near_silence_context": near_silence,
            }
            frames = [dict(ordinary) for _ in range(61)]
            frames[30] = event

            with self.subTest(event=event_name):
                curve = build_curve(
                    frames,
                    base_mix=base_mix,
                    source_reference_db=reference_db,
                    frame_ms=10,
                )
                self.assertEqual(len(curve), len(frames))
                self.assertTrue(all(0.0 <= mix <= base_mix for mix in curve))
                self.assertGreater(curve[0], 0.0)
                self.assertGreater(curve[-1], 0.0)
                self.assertLessEqual(curve[30], base_mix * 0.12)
                self.assertLessEqual(max(curve[29:32]), base_mix * 0.45)
                self.assertLessEqual(
                    max(abs(right - left) for left, right in zip(curve, curve[1:])),
                    0.025,
                )

    def test_candidate_integrity_accepts_exact_geometry_despite_advisory_metric_regression(self) -> None:
        assess_integrity, WavLimits = require_symbols(
            self,
            "extreme_worker.enhancement",
            "assess_rnnoise_candidate_integrity",
            "WavLimits",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_path = root / "source.wav"
            candidate_path = root / "candidate.wav"
            self._write_pcm16_voice(source_path)
            self._write_pcm16_voice(candidate_path, amplitude=0.2475)
            limits = WavLimits(
                max_upload_bytes=2 * 1024 * 1024,
                allowed_sample_rates=frozenset({44_100, 48_000}),
                allowed_channels=frozenset({1, 2}),
                allowed_sample_width_bytes=frozenset({2, 4}),
                max_duration_seconds=2,
                max_decoded_frames=96_000,
            )
            source_report = self._report({
                "dnsmos.bak": 4.0,
                "dnsmos.sig": 4.0,
                "dnsmos.ovrl": 4.0,
                "sigmos.noise": 4.0,
                "sigmos.sig": 4.0,
            })
            regressed_metrics = self._report({
                "dnsmos.bak": 2.0,
                "dnsmos.sig": 2.0,
                "dnsmos.ovrl": 2.0,
                "sigmos.noise": 2.0,
                "sigmos.sig": 2.0,
            })

            assessment = assess_integrity(
                source_path,
                candidate_path,
                limits=limits,
                source_report=source_report,
                candidate_report=regressed_metrics,
            )

        self.assertTrue(assessment.safe_to_use)
        self.assertEqual(assessment.reason, "technical-integrity-passed")

    def test_adaptive_render_trims_only_rnnoise_tail_padding_to_exact_source_frames(self) -> None:
        render_candidate, WavLimits = require_symbols(
            self,
            "extreme_worker.enhancement",
            "_render_adaptive_rnnoise_candidate",
            "WavLimits",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_path = root / "source.wav"
            padded_wet_path = root / "padded-wet.wav"
            short_wet_path = root / "short-wet.wav"
            candidate_path = root / "candidate.wav"
            self._write_pcm16_voice(source_path, frames=4_800, amplitude=0.25)
            self._write_pcm16_voice(padded_wet_path, frames=4_926, amplitude=0.20)
            self._write_pcm16_voice(short_wet_path, frames=4_799, amplitude=0.20)
            limits = WavLimits(
                max_upload_bytes=2 * 1024 * 1024,
                allowed_sample_rates=frozenset({48_000}),
                allowed_channels=frozenset({1}),
                allowed_sample_width_bytes=frozenset({2}),
                max_duration_seconds=2,
                max_decoded_frames=96_000,
            )

            render_candidate(
                source_path,
                padded_wet_path,
                candidate_path,
                limits=limits,
                mix_curve=(0.05,) * 10,
            )
            with wave.open(str(candidate_path), "rb") as candidate:
                candidate_frames = candidate.getnframes()

            with self.assertRaisesRegex(RuntimeError, "candidate-integrity-mismatch"):
                render_candidate(
                    source_path,
                    short_wet_path,
                    candidate_path,
                    limits=limits,
                    mix_curve=(0.05,) * 10,
                )

        self.assertEqual(candidate_frames, 4_800)

    def test_candidate_integrity_fails_open_on_any_geometry_mismatch(self) -> None:
        assess_integrity, WavLimits = require_symbols(
            self,
            "extreme_worker.enhancement",
            "assess_rnnoise_candidate_integrity",
            "WavLimits",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_path = root / "source.wav"
            candidate_path = root / "candidate.wav"
            self._write_pcm16_voice(source_path)
            limits = WavLimits(
                max_upload_bytes=2 * 1024 * 1024,
                allowed_sample_rates=frozenset({44_100, 48_000}),
                allowed_channels=frozenset({1, 2}),
                allowed_sample_width_bytes=frozenset({2, 4}),
                max_duration_seconds=2,
                max_decoded_frames=96_000,
            )
            mismatches = {
                "sample-rate": lambda: self._write_pcm16_voice(candidate_path, sample_rate=44_100),
                "channels": lambda: self._write_pcm16_voice(candidate_path, channels=2),
                "sample-count": lambda: self._write_pcm16_voice(candidate_path, frames=4_799),
                "sample-width": lambda: _float32_wav(
                    candidate_path,
                    samples=tuple(
                        math.sin(2 * math.pi * 220 * index / 48_000) * 0.25
                        for index in range(4_800)
                    ),
                ),
            }

            for mismatch_name, write_candidate in mismatches.items():
                with self.subTest(mismatch=mismatch_name):
                    write_candidate()
                    assessment = assess_integrity(
                        source_path,
                        candidate_path,
                        limits=limits,
                    )
                    self.assertFalse(assessment.safe_to_use)
                    self.assertEqual(assessment.reason, "candidate-geometry-mismatch")

    def test_candidate_integrity_fails_open_on_corrupt_or_non_finite_data(self) -> None:
        assess_integrity, WavLimits = require_symbols(
            self,
            "extreme_worker.enhancement",
            "assess_rnnoise_candidate_integrity",
            "WavLimits",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_path = root / "source.wav"
            candidate_path = root / "candidate.wav"
            limits = WavLimits(
                max_upload_bytes=2 * 1024 * 1024,
                allowed_sample_rates=frozenset({48_000}),
                allowed_channels=frozenset({1}),
                allowed_sample_width_bytes=frozenset({2, 4}),
                max_duration_seconds=2,
                max_decoded_frames=96_000,
            )
            self._write_pcm16_voice(source_path)
            candidate_path.write_bytes(b"not a wav")
            corrupt = assess_integrity(source_path, candidate_path, limits=limits)

            finite_samples = tuple(
                math.sin(2 * math.pi * 220 * index / 48_000) * 0.25
                for index in range(4_800)
            )
            _float32_wav(source_path, samples=finite_samples)
            _float32_wav(
                candidate_path,
                samples=finite_samples[:2_400] + (float("nan"),) + finite_samples[2_401:],
            )
            non_finite = assess_integrity(source_path, candidate_path, limits=limits)

        self.assertFalse(corrupt.safe_to_use)
        self.assertEqual(corrupt.reason, "candidate-corrupt-or-incompatible")
        self.assertFalse(non_finite.safe_to_use)
        self.assertEqual(non_finite.reason, "candidate-non-finite")

    def test_candidate_integrity_fails_open_on_introduced_clipping(self) -> None:
        assess_integrity, WavLimits = require_symbols(
            self,
            "extreme_worker.enhancement",
            "assess_rnnoise_candidate_integrity",
            "WavLimits",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_path = root / "source.wav"
            candidate_path = root / "candidate.wav"
            self._write_pcm16_voice(source_path, amplitude=0.25)
            self._write_pcm16_voice(candidate_path, amplitude=1.0)
            limits = WavLimits(
                max_upload_bytes=2 * 1024 * 1024,
                allowed_sample_rates=frozenset({48_000}),
                allowed_channels=frozenset({1}),
                allowed_sample_width_bytes=frozenset({2}),
                max_duration_seconds=2,
                max_decoded_frames=96_000,
            )
            assessment = assess_integrity(source_path, candidate_path, limits=limits)

        self.assertFalse(assessment.safe_to_use)
        self.assertEqual(assessment.reason, "introduced-clipping")

    def test_candidate_integrity_fails_open_on_gross_speech_erasure(self) -> None:
        assess_integrity, WavLimits = require_symbols(
            self,
            "extreme_worker.enhancement",
            "assess_rnnoise_candidate_integrity",
            "WavLimits",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_path = root / "source.wav"
            candidate_path = root / "candidate.wav"
            self._write_pcm16_voice(source_path, amplitude=0.25)
            self._write_pcm16_voice(candidate_path, amplitude=0.0)
            limits = WavLimits(
                max_upload_bytes=2 * 1024 * 1024,
                allowed_sample_rates=frozenset({48_000}),
                allowed_channels=frozenset({1}),
                allowed_sample_width_bytes=frozenset({2}),
                max_duration_seconds=2,
                max_decoded_frames=96_000,
            )
            assessment = assess_integrity(source_path, candidate_path, limits=limits)

        self.assertFalse(assessment.safe_to_use)
        self.assertEqual(assessment.reason, "gross-speech-erasure")

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
