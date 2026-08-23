from __future__ import annotations

import hashlib
import math
import os
import struct
import sys
import tempfile
import threading
import time
import types
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from contract_support import require_symbols


def _pcm16_wav(path: Path, *, sample_rate: int = 16_000, seconds: float = 0.08) -> bytes:
    frame_count = max(1, round(sample_rate * seconds))
    samples = b"".join(
        struct.pack("<h", round(math.sin(2 * math.pi * 220 * index / sample_rate) * 8_000))
        for index in range(frame_count)
    )
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(samples)
    return path.read_bytes()


class _FakeVad:
    def __init__(self, probabilities: tuple[float, ...] = (0.2, 0.9, 0.7)) -> None:
        self.probabilities = probabilities
        self.calls = 0

    def score_chunks(self, audio_16k):
        self.calls += 1
        self.last_sample_count = len(audio_16k)
        return self.probabilities


class _FakeMetrics:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def score(self, metric_id: str, audio, sample_rate: int):
        self.calls.append(metric_id)
        if metric_id == "dnsmos":
            return {"sig": 4.1, "bak": 3.8, "ovrl": 3.9}
        if metric_id == "dnsmos_p808":
            return 3.7
        if metric_id == "sigmos":
            return {"loud": 3.6, "ovrl": 3.5}
        if metric_id == "utmos":
            return 3.95
        raise AssertionError(f"unexpected metric: {metric_id}")


class RuntimeModelContractTests(unittest.TestCase):
    MODEL_MODULE = "extreme_worker.model_runtime"
    INFERENCE_MODULE = "extreme_worker.inference"

    def _model_symbols(self):
        return require_symbols(
            self,
            self.MODEL_MODULE,
            "ArtifactSpec",
            "RuntimeConfig",
            "DEFAULT_RUNTIME_ARTIFACTS",
            "LICENSED_METRIC_IDS",
            "sha256_file",
            "verify_artifact",
        )

    def _inference_symbols(self):
        return require_symbols(
            self,
            self.INFERENCE_MODULE,
            "AdvisoryInferenceRuntime",
            "get_runtime",
        )

    def _spec(self, artifact_id: str, component: str, filename: str, payload: bytes):
        ArtifactSpec, *_ = self._model_symbols()
        return ArtifactSpec(
            id=artifact_id,
            component=component,
            version="test-1",
            revision="a" * 40,
            sha256=hashlib.sha256(payload).hexdigest(),
            filename=filename,
            license="MIT",
            bundled_by_default=True,
        )

    def test_runtime_artifacts_are_immutable_pins_and_exclude_noncommercial_or_repair_models(self) -> None:
        _, _, artifacts, metric_ids, _, _ = self._model_symbols()

        rendered = repr((artifacts, metric_ids)).lower()
        self.assertNotIn("nisqa", rendered)
        self.assertNotIn("deepfilter", rendered)
        self.assertEqual(metric_ids, ("dnsmos", "dnsmos_p808", "sigmos", "utmos"))
        self.assertTrue(any(item.component == "silero_vad" and item.version == "6.2.1" for item in artifacts))
        for artifact in artifacts:
            with self.subTest(artifact=artifact.id):
                self.assertRegex(artifact.revision, r"^[0-9a-f]{40}$")
                self.assertRegex(artifact.sha256, r"^[0-9a-f]{64}$")
                self.assertNotEqual(artifact.sha256, "0" * 64)
                self.assertEqual(artifact.license, "MIT")

    def test_artifact_checksum_verification_is_exact(self) -> None:
        ArtifactSpec, _, _, _, sha256_file, verify_artifact = self._model_symbols()
        with tempfile.TemporaryDirectory() as temp_dir:
            model_path = Path(temp_dir, "vad.onnx")
            model_path.write_bytes(b"exact model bytes")
            artifact = ArtifactSpec(
                id="silero-vad",
                component="silero_vad",
                version="6.2.1",
                revision="b" * 40,
                sha256=hashlib.sha256(b"exact model bytes").hexdigest(),
                filename="vad.onnx",
                license="MIT",
                bundled_by_default=True,
            )
            self.assertEqual(sha256_file(model_path), artifact.sha256)
            self.assertTrue(verify_artifact(model_path, artifact))
            model_path.write_bytes(b"different")
            self.assertFalse(verify_artifact(model_path, artifact))
            self.assertFalse(verify_artifact(Path(temp_dir, "missing.onnx"), artifact))

    def test_env_configuration_accepts_only_the_licensed_advisory_metric_allowlist(self) -> None:
        _, RuntimeConfig, _, _, _, _ = self._model_symbols()
        original = os.environ.get("EXTREME_ML_METRICS")
        try:
            os.environ["EXTREME_ML_METRICS"] = "dnsmos,nisqa,SIGMOS,deepfilternet3,utmos,dnsmos"
            config = RuntimeConfig.from_env()
        finally:
            if original is None:
                os.environ.pop("EXTREME_ML_METRICS", None)
            else:
                os.environ["EXTREME_ML_METRICS"] = original

        self.assertEqual(config.metric_ids, ("dnsmos", "sigmos", "utmos"))

    def test_real_report_shape_is_advisory_and_maps_silero_chunks_to_ten_ms_frames(self) -> None:
        _, RuntimeConfig, _, _, _, _ = self._model_symbols()
        AdvisoryInferenceRuntime, _ = self._inference_symbols()
        vad_payload = b"fake silero model"
        metric_payload = b"fake dnsmos model"
        with tempfile.TemporaryDirectory() as temp_dir:
            model_dir = Path(temp_dir, "models")
            model_dir.mkdir()
            (model_dir / "silero.onnx").write_bytes(vad_payload)
            (model_dir / "dnsmos.onnx").write_bytes(metric_payload)
            source_path = Path(temp_dir, "source.wav")
            source_bytes = _pcm16_wav(source_path, seconds=0.08)
            source_hash = hashlib.sha256(source_bytes).hexdigest()
            vad_spec = self._spec("silero-vad", "silero_vad", "silero.onnx", vad_payload)
            metric_spec = self._spec("dnsmos", "dnsmos", "dnsmos.onnx", metric_payload)
            fake_vad = _FakeVad()
            fake_metrics = _FakeMetrics()
            runtime = AdvisoryInferenceRuntime(
                RuntimeConfig(
                    model_dir=model_dir,
                    metric_ids=("dnsmos",),
                    artifacts=(vad_spec, metric_spec),
                    max_analysis_seconds=10,
                ),
                vad_factory=lambda _: fake_vad,
                metrics_factory=lambda _: fake_metrics,
            )

            report = runtime.analyze_wav(source_path, job_id="job_1", source_sha256=source_hash)

        self.assertEqual(report["schemaVersion"], 1)
        self.assertTrue(report["advisoryOnly"])
        self.assertFalse(report["canBlockDelivery"])
        self.assertFalse(report["canChangeGainDb"])
        self.assertEqual(report["levelAuthority"], "gainPlanner")
        self.assertEqual(report["source"]["sha256"], source_hash)
        self.assertEqual(report["source"]["sampleRate"], 16_000)
        self.assertEqual(report["source"]["channels"], 1)
        self.assertEqual(report["vad"]["frameMs"], 10)
        self.assertEqual(len(report["vad"]["frames"]), 8)
        self.assertEqual(
            report["vad"]["frames"][:4],
            [
                {"startMs": 0, "endMs": 10, "speechProbability": 0.2},
                {"startMs": 10, "endMs": 20, "speechProbability": 0.2},
                {"startMs": 20, "endMs": 30, "speechProbability": 0.2},
                {"startMs": 30, "endMs": 40, "speechProbability": 0.2},
            ],
        )
        self.assertEqual(report["metrics"]["dnsmos.ovrl"], {
            "value": 3.9,
            "available": True,
            "higherIsBetter": True,
        })
        self.assertEqual(fake_vad.calls, 1)
        self.assertEqual(fake_metrics.calls, ["dnsmos"])
        self.assertEqual(report["telemetry"]["audioMutation"], False)
        self.assertEqual(report["telemetry"]["excludedModels"], ["nisqa", "deepfilternet3"])

    def test_analysis_never_rewrites_the_source_file(self) -> None:
        _, RuntimeConfig, _, _, _, _ = self._model_symbols()
        AdvisoryInferenceRuntime, _ = self._inference_symbols()
        vad_payload = b"fake silero model"
        with tempfile.TemporaryDirectory() as temp_dir:
            model_dir = Path(temp_dir, "models")
            model_dir.mkdir()
            (model_dir / "silero.onnx").write_bytes(vad_payload)
            source_path = Path(temp_dir, "source.wav")
            before = _pcm16_wav(source_path, sample_rate=48_000, seconds=0.04)
            runtime = AdvisoryInferenceRuntime(
                RuntimeConfig(
                    model_dir=model_dir,
                    metric_ids=(),
                    artifacts=(self._spec("silero-vad", "silero_vad", "silero.onnx", vad_payload),),
                    max_analysis_seconds=10,
                ),
                vad_factory=lambda _: _FakeVad((0.8, 0.7)),
            )

            report = runtime.analyze_wav(source_path, job_id="job_source")
            after = source_path.read_bytes()

        self.assertEqual(after, before)
        self.assertEqual(report["source"]["sha256"], hashlib.sha256(before).hexdigest())
        self.assertEqual(report["telemetry"]["audioMutation"], False)

    def test_missing_or_broken_models_return_valid_degraded_telemetry_instead_of_raising(self) -> None:
        _, RuntimeConfig, _, _, _, _ = self._model_symbols()
        AdvisoryInferenceRuntime, _ = self._inference_symbols()
        missing_payload = b"model is deliberately absent"
        with tempfile.TemporaryDirectory() as temp_dir:
            model_dir = Path(temp_dir, "models")
            model_dir.mkdir()
            source_path = Path(temp_dir, "source.wav")
            _pcm16_wav(source_path)
            vad_spec = self._spec("silero-vad", "silero_vad", "missing.onnx", missing_payload)
            metric_spec = self._spec("sigmos", "sigmos", "also-missing.onnx", missing_payload)
            runtime = AdvisoryInferenceRuntime(
                RuntimeConfig(
                    model_dir=model_dir,
                    metric_ids=("sigmos",),
                    artifacts=(vad_spec, metric_spec),
                    max_analysis_seconds=10,
                ),
                vad_factory=lambda _: (_ for _ in ()).throw(RuntimeError("should not load")),
                metrics_factory=lambda _: (_ for _ in ()).throw(RuntimeError("should not load")),
            )

            report = runtime.analyze_wav(source_path, job_id="job_missing")

        self.assertEqual(report["vad"]["frames"], [])
        self.assertFalse(report["metrics"]["sigmos.ovrl"]["available"])
        self.assertIsNone(report["metrics"]["sigmos.ovrl"]["value"])
        self.assertEqual(report["telemetry"]["runtimeStatus"], "degraded")
        self.assertEqual(report["telemetry"]["components"]["silero-vad"]["status"], "unavailable")
        self.assertFalse(report["canBlockDelivery"])

    def test_local_fallback_never_claims_models_that_were_not_executed(self) -> None:
        LocalFallbackAnalyzer, = require_symbols(
            self,
            "extreme_worker.api_support",
            "LocalFallbackAnalyzer",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir, "source.wav")
            _pcm16_wav(source_path, seconds=0.1)
            digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
            report = LocalFallbackAnalyzer().analyze_wav(
                source_path,
                job_id="job_fallback",
                source_sha256=digest,
            )

        self.assertEqual(report["vad"]["frames"], [])
        self.assertEqual(report["models"], [])
        self.assertEqual(report["modelSetId"], "unavailable-local-fallback")
        self.assertEqual(report["telemetry"]["runtimeStatus"], "degraded")

    def test_runtime_serializes_model_calls_to_one_bounded_inference_lane(self) -> None:
        _, RuntimeConfig, _, _, _, _ = self._model_symbols()
        AdvisoryInferenceRuntime, _ = self._inference_symbols()
        vad_payload = b"fake silero model"
        active = 0
        peak = 0
        guard = threading.Lock()

        class SlowVad:
            def score_chunks(self, audio_16k):
                nonlocal active, peak
                with guard:
                    active += 1
                    peak = max(peak, active)
                time.sleep(0.03)
                with guard:
                    active -= 1
                return (0.4, 0.8)

        with tempfile.TemporaryDirectory() as temp_dir:
            model_dir = Path(temp_dir, "models")
            model_dir.mkdir()
            (model_dir / "silero.onnx").write_bytes(vad_payload)
            source_path = Path(temp_dir, "source.wav")
            _pcm16_wav(source_path)
            runtime = AdvisoryInferenceRuntime(
                RuntimeConfig(
                    model_dir=model_dir,
                    metric_ids=(),
                    artifacts=(self._spec("silero-vad", "silero_vad", "silero.onnx", vad_payload),),
                    max_analysis_seconds=10,
                ),
                vad_factory=lambda _: SlowVad(),
            )
            errors: list[Exception] = []

            def run(index: int) -> None:
                try:
                    runtime.analyze_wav(source_path, job_id=f"job_{index}")
                except Exception as exc:  # pragma: no cover - surfaced by assertion
                    errors.append(exc)

            threads = [threading.Thread(target=run, args=(index,)) for index in range(3)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

        self.assertEqual(errors, [])
        self.assertEqual(peak, 1)

    def test_oversized_analysis_is_a_nonblocking_degraded_report(self) -> None:
        _, RuntimeConfig, _, _, _, _ = self._model_symbols()
        AdvisoryInferenceRuntime, _ = self._inference_symbols()
        module = __import__(self.INFERENCE_MODULE, fromlist=["_decode_pcm_samples"])
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir, "source.wav")
            _pcm16_wav(source_path, seconds=0.08)
            runtime = AdvisoryInferenceRuntime(
                RuntimeConfig(
                    model_dir=Path(temp_dir, "models"),
                    metric_ids=(),
                    artifacts=(),
                    max_analysis_seconds=0.01,
                )
            )

            with patch.object(
                module,
                "_decode_pcm_samples",
                side_effect=AssertionError("duration limit must run before PCM allocation"),
            ):
                report = runtime.analyze_wav(source_path, job_id="job_long")

        self.assertEqual(report["telemetry"]["runtimeStatus"], "degraded")
        self.assertEqual(report["telemetry"]["reason"], "analysis-duration-limit")
        self.assertEqual(report["vad"]["frames"], [])
        self.assertFalse(report["canBlockDelivery"])

    def test_runtime_singleton_is_lazy_and_reused(self) -> None:
        _, RuntimeConfig, _, _, _, _ = self._model_symbols()
        _, get_runtime = self._inference_symbols()
        with tempfile.TemporaryDirectory() as temp_dir:
            config = RuntimeConfig(
                model_dir=Path(temp_dir),
                metric_ids=(),
                artifacts=(),
                max_analysis_seconds=1,
            )
            first = get_runtime(config)
            second = get_runtime(config)

        self.assertIs(first, second)
        self.assertFalse(first.models_loaded)

    def test_silero_backend_uses_a_single_cpu_session_and_resets_state_per_audio(self) -> None:
        import numpy as np

        module = __import__(self.INFERENCE_MODULE, fromlist=["SileroOnnxBackend"])
        session_options: list[object] = []
        sessions: list[object] = []

        class FakeOptions:
            def __init__(self) -> None:
                session_options.append(self)

        class FakeSession:
            def __init__(self, path, *, sess_options, providers) -> None:
                self.path = path
                self.options = sess_options
                self.providers = providers
                self.feeds: list[dict[str, object]] = []
                sessions.append(self)

            def get_inputs(self):
                return [SimpleNamespace(name=name) for name in ("input", "state", "sr")]

            def run(self, _outputs, feed):
                self.feeds.append(feed)
                return np.asarray([[0.75]], dtype=np.float32), np.ones((2, 1, 128), dtype=np.float32)

        fake_ort = types.ModuleType("onnxruntime")
        fake_ort.SessionOptions = FakeOptions
        fake_ort.ExecutionMode = SimpleNamespace(ORT_SEQUENTIAL="sequential")
        fake_ort.InferenceSession = FakeSession
        with patch.dict(sys.modules, {"onnxruntime": fake_ort}):
            backend = module.SileroOnnxBackend(Path("pinned.onnx"))
            first = backend.score_chunks(np.zeros(600, dtype=np.float32))
            second = backend.score_chunks(np.zeros(1, dtype=np.float32))

        self.assertEqual(first, (0.75, 0.75))
        self.assertEqual(second, (0.75,))
        self.assertEqual(len(session_options), 1)
        self.assertEqual(sessions[0].providers, ["CPUExecutionProvider"])
        self.assertEqual(sessions[0].options.inter_op_num_threads, 1)
        self.assertEqual(sessions[0].options.intra_op_num_threads, 1)
        self.assertEqual(np.asarray(sessions[0].feeds[0]["state"]).sum(), 0)
        self.assertEqual(np.asarray(sessions[0].feeds[2]["state"]).sum(), 0)

    def test_speech_metrics_backend_forces_verified_local_paths_and_never_resolves_remote_models(self) -> None:
        module = __import__(self.INFERENCE_MODULE, fromlist=["SpeechOnnxMetricsBackend"])

        class FakeMetric:
            def __init__(self, *, providers) -> None:
                self.providers = providers
                self.model = SimpleNamespace(hf_file="remote.onnx", hf_repo="mutable", revision="main")

            def __call__(self, audio, sample_rate):
                return float(len(audio) + sample_rate)

        package = types.ModuleType("speechonnxmetrics")
        mos_package = types.ModuleType("speechonnxmetrics.mos")
        dnsmos_module = types.ModuleType("speechonnxmetrics.mos.dnsmos")
        dnsmos_module.DNSMOS = FakeMetric
        dnsmos_module.DNSMOSP808 = FakeMetric
        sigmos_module = types.ModuleType("speechonnxmetrics.mos.sigmos")
        sigmos_module.SIGMOS = FakeMetric
        utmos_module = types.ModuleType("speechonnxmetrics.mos.utmos")
        utmos_module.UTMOS = FakeMetric
        fake_modules = {
            "speechonnxmetrics": package,
            "speechonnxmetrics.mos": mos_package,
            "speechonnxmetrics.mos.dnsmos": dnsmos_module,
            "speechonnxmetrics.mos.sigmos": sigmos_module,
            "speechonnxmetrics.mos.utmos": utmos_module,
        }
        paths = {metric_id: Path(f"{metric_id}.onnx") for metric_id in ("dnsmos", "dnsmos_p808", "sigmos", "utmos")}
        with patch.dict(sys.modules, fake_modules):
            backend = module.SpeechOnnxMetricsBackend(paths)

        for metric_id, metric in backend._metrics.items():
            self.assertEqual(metric.providers, ["CPUExecutionProvider"])
            self.assertEqual(metric.model.hf_file, str(paths[metric_id]))
            self.assertEqual(metric.model.hf_repo, "")
            self.assertIsNone(metric.model.revision)
        self.assertEqual(backend.score("utmos", [0.0, 0.0], 16_000), 16_002.0)
        with self.assertRaises(RuntimeError):
            backend.score("not-licensed", [0.0], 16_000)

    def test_pcm_decode_and_vad_resample_cover_licensed_wav_widths(self) -> None:
        import numpy as np

        module = __import__(self.INFERENCE_MODULE, fromlist=["_decode_pcm_samples", "_resample_for_vad"])
        pcm24 = bytes((0x00, 0x00, 0x40, 0x00, 0x00, 0xC0))
        pcm32 = struct.pack("<ii", 1_073_741_824, -1_073_741_824)

        decoded24 = module._decode_pcm_samples(pcm24, 3, 1)
        decoded32 = module._decode_pcm_samples(pcm32, 4, 1)
        resampled = module._resample_for_vad(np.zeros(4_800, dtype=np.float32), 48_000)

        self.assertTrue(np.allclose(decoded24, [0.5, -0.5]))
        self.assertTrue(np.allclose(decoded32, [0.5, -0.5]))
        self.assertEqual(len(resampled), 1_600)
        with self.assertRaises(ValueError):
            module._decode_pcm_samples(b"\x00", 1, 1)


if __name__ == "__main__":
    unittest.main()
