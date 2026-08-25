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


def _extensible_pcm24_wav(path: Path, *, sample_rate: int = 48_000, frames: int = 4_800) -> bytes:
    channels = 1
    bits_per_sample = 24
    block_align = channels * (bits_per_sample // 8)
    samples = b"\x00\x00\x20" * frames
    subformat_guid = struct.pack("<I", 1) + bytes.fromhex("00001000800000aa00389b71")
    fmt = struct.pack(
        "<HHIIHHHHI",
        0xFFFE,
        channels,
        sample_rate,
        sample_rate * block_align,
        block_align,
        bits_per_sample,
        22,
        bits_per_sample,
        4,
    ) + subformat_guid
    data_chunk = b"data" + struct.pack("<I", len(samples)) + samples
    if len(samples) % 2:
        data_chunk += b"\x00"
    body = (
        b"WAVE"
        + b"fmt "
        + struct.pack("<I", len(fmt))
        + fmt
        + data_chunk
    )
    payload = b"RIFF" + struct.pack("<I", len(body)) + body
    path.write_bytes(payload)
    return payload


def _float32_wav(
    path: Path,
    *,
    samples: tuple[float, ...] = (0.5, -0.5, 0.25, -0.25),
    sample_rate: int = 48_000,
) -> bytes:
    channels = 1
    bits_per_sample = 32
    block_align = channels * 4
    raw_samples = struct.pack(f"<{len(samples)}f", *samples)
    fmt = struct.pack(
        "<HHIIHH",
        3,
        channels,
        sample_rate,
        sample_rate * block_align,
        block_align,
        bits_per_sample,
    )
    data_chunk = b"data" + struct.pack("<I", len(raw_samples)) + raw_samples
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + data_chunk
    payload = b"RIFF" + struct.pack("<I", len(body)) + body
    path.write_bytes(payload)
    return payload


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

    def test_long_metric_scoring_uses_bounded_distributed_windows_and_finite_lower_median(self) -> None:
        import numpy as np

        _, RuntimeConfig, _, _, _, _ = self._model_symbols()
        AdvisoryInferenceRuntime, _ = self._inference_symbols()
        module = __import__(self.INFERENCE_MODULE, fromlist=["_empty_metrics"])
        sample_rate = 48_000
        source_samples = 1_158 * sample_rate
        window_samples = 10 * sample_rate
        window_results = (
            {"sig": math.nan, "bak": math.inf, "ovrl": 4.7},
            {"sig": 4.8, "bak": 4.5, "ovrl": 4.6},
            {"sig": 4.7, "bak": 4.4, "ovrl": 4.5},
            {"sig": 4.6, "bak": 4.3, "ovrl": 4.4},
            {"sig": 4.5, "bak": 4.2, "ovrl": 4.3},
            {"sig": 4.4, "bak": 4.1, "ovrl": 4.2},
            {"sig": 0.2, "bak": 0.1, "ovrl": 0.3},
        )

        def run_once():
            class LazyLongAudio:
                dtype = np.dtype(np.float32)

                def __init__(self) -> None:
                    self.slices: list[tuple[int, int]] = []
                    self.full_array_requests = 0

                def __len__(self) -> int:
                    return source_samples

                def __array__(self, *_args, **_kwargs):
                    self.full_array_requests += 1
                    raise AssertionError("long source must be sliced before array conversion")

                def __getitem__(self, key):
                    if not isinstance(key, slice) or key.step not in (None, 1):
                        raise AssertionError("metric windows must use contiguous slices")
                    start = 0 if key.start is None else key.start
                    stop = len(self) if key.stop is None else key.stop
                    if stop - start > window_samples:
                        raise AssertionError("metric window exceeded the ten-second cap")
                    self.slices.append((start, stop))
                    return np.zeros(stop - start, dtype=np.float32)

            class RecordingMetrics:
                def __init__(self) -> None:
                    self.sample_counts: list[int] = []
                    self.byte_counts: list[int] = []

                def score(self, metric_id: str, audio, sample_rate: int):
                    self.assertions(metric_id, sample_rate, audio)
                    call_index = len(self.sample_counts)
                    self.sample_counts.append(len(audio))
                    self.byte_counts.append(audio.nbytes)
                    return window_results[call_index]

                @staticmethod
                def assertions(metric_id: str, sample_rate: int, audio) -> None:
                    if metric_id != "dnsmos" or sample_rate != 48_000:
                        raise AssertionError("unexpected metric request")
                    if len(audio) > 480_000 or audio.nbytes > 2 * 1024 * 1024:
                        raise AssertionError("metric backend received an unbounded array")

            source = LazyLongAudio()
            backend = RecordingMetrics()
            runtime = AdvisoryInferenceRuntime(
                RuntimeConfig(
                    model_dir=Path("."),
                    metric_ids=(),
                    artifacts=(),
                    max_analysis_seconds=1,
                )
            )
            runtime._metrics = backend
            metrics = module._empty_metrics(("dnsmos",))
            components: dict[str, dict[str, object]] = {}
            runtime._score_metric("dnsmos", metrics, components, source, sample_rate)
            return source, backend, metrics, components

        first = run_once()
        second = run_once()

        max_start = source_samples - window_samples
        expected_starts = [(window_index * max_start) // 6 for window_index in range(7)]
        self.assertEqual(first[0].full_array_requests, 0)
        self.assertEqual(
            first[0].slices,
            [(start, start + window_samples) for start in expected_starts],
        )
        self.assertEqual(first[1].sample_counts, [window_samples] * 7)
        self.assertEqual(first[1].byte_counts, [window_samples * 4] * 7)
        self.assertEqual(first[2], second[2])
        self.assertEqual(first[0].slices, second[0].slices)
        self.assertEqual(first[2]["dnsmos.sig"]["value"], 4.5)
        self.assertEqual(first[2]["dnsmos.bak"]["value"], 4.2)
        self.assertEqual(first[2]["dnsmos.ovrl"]["value"], 4.4)
        self.assertEqual(first[3]["dnsmos"]["status"], "available")
        self.assertEqual(first[3]["dnsmos"]["code"], "ok-partial-windows")

    def test_long_pcm_reader_exposes_bounded_slices_without_a_full_duration_float_allocation(self) -> None:
        import numpy as np

        module = __import__(self.INFERENCE_MODULE, fromlist=["_read_pcm_wav"])
        sample_rate = 48_000
        channels = 2
        duration_seconds = 1_158
        frame_count = sample_rate * duration_seconds
        bytes_per_frame = channels * 2
        bounded_float_samples = module._METRIC_WINDOW_BYTE_CAP // np.dtype(np.float32).itemsize
        read_sizes: list[int] = []

        class VirtualPcmReader:
            def __init__(self) -> None:
                self.position = 0

            def __enter__(self):
                return self

            def __exit__(self, *_args) -> None:
                return None

            def seek(self, offset: int, whence: int = 0) -> int:
                if whence == 0:
                    self.position = offset
                elif whence == 1:
                    self.position += offset
                else:
                    raise AssertionError("virtual long WAV does not require end-relative seeks")
                return self.position

            def tell(self) -> int:
                return self.position

            def read(self, byte_count: int = -1) -> bytes:
                if byte_count < 0:
                    raise AssertionError("long WAV reads must always be explicitly bounded")
                if byte_count > module._METRIC_WINDOW_BYTE_CAP:
                    raise AssertionError("long WAV read exceeded the bounded transient working set")
                read_sizes.append(byte_count)
                self.position += byte_count
                return bytes(byte_count)

        info = SimpleNamespace(
            format_code=1,
            sample_rate=sample_rate,
            channels=channels,
            sample_width_bytes=2,
            frames=frame_count,
            duration_seconds=float(duration_seconds),
            upload_bytes=44 + frame_count * bytes_per_frame,
            data_offset=44,
            data_bytes=frame_count * bytes_per_frame,
        )

        original_empty = np.empty

        def bounded_empty(shape, *args, **kwargs):
            item_count = math.prod(shape) if isinstance(shape, tuple) else int(shape)
            dtype = np.dtype(kwargs.get("dtype", np.float64))
            if dtype == np.dtype(np.float32) and item_count > bounded_float_samples:
                raise AssertionError("long WAV analysis allocated a full-duration float mono array")
            return original_empty(shape, *args, **kwargs)

        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir, "virtual-long.wav")
            source_path.write_bytes(b"virtual header placeholder")
            original_open = Path.open

            def virtual_open(path: Path, mode: str = "r", *args, **kwargs):
                if Path(path) == source_path and mode == "rb":
                    return VirtualPcmReader()
                return original_open(path, mode, *args, **kwargs)

            with (
                patch.object(module, "inspect_wav_file", return_value=info),
                patch.object(Path, "open", new=virtual_open),
                patch.object(np, "empty", side_effect=bounded_empty),
            ):
                audio, actual_rate, actual_channels, actual_duration = module._read_pcm_wav(
                    source_path,
                    max_duration_seconds=duration_seconds,
                )
                preview = np.asarray(audio[: module._PCM_DECODE_CHUNK_FRAMES], dtype=np.float32)

        self.assertEqual(len(audio), frame_count)
        self.assertEqual(actual_rate, sample_rate)
        self.assertEqual(actual_channels, channels)
        self.assertEqual(actual_duration, float(duration_seconds))
        self.assertEqual(preview.shape, (module._PCM_DECODE_CHUNK_FRAMES,))
        self.assertTrue(read_sizes)
        self.assertLessEqual(max(read_sizes), module._METRIC_WINDOW_BYTE_CAP)
        if isinstance(audio, np.ndarray) and not isinstance(audio, np.memmap):
            self.assertLessEqual(audio.nbytes, module._METRIC_WINDOW_BYTE_CAP)

    def test_long_runtime_streams_all_ml_over_the_full_timeline_with_bounded_working_audio(self) -> None:
        import numpy as np

        _, RuntimeConfig, _, _, _, _ = self._model_symbols()
        AdvisoryInferenceRuntime, _ = self._inference_symbols()
        module = __import__(self.INFERENCE_MODULE, fromlist=["_read_pcm_wav"])
        sample_rate = 48_000
        channels = 2
        duration_seconds = 1_158
        source_samples = sample_rate * duration_seconds
        vad_sample_rate = 16_000
        expected_vad_samples = vad_sample_rate * duration_seconds
        max_source_slice_samples = sample_rate * 10
        max_vad_call_samples = vad_sample_rate * 10
        speech_ranges = (
            (12.0, 20.0),
            (duration_seconds / 2 - 4.0, duration_seconds / 2 + 4.0),
            (duration_seconds - 22.0, duration_seconds - 14.0),
        )

        class VirtualLongMono:
            dtype = np.dtype(np.float32)

            def __init__(self) -> None:
                self.slices: list[tuple[int, int]] = []
                self.full_array_requests = 0
                self.max_materialized_samples = 0

            def __len__(self) -> int:
                return source_samples

            def __array__(self, *_args, **_kwargs):
                self.full_array_requests += 1
                raise AssertionError("long ML analysis must not materialize the full mono timeline")

            def __getitem__(self, key):
                if not isinstance(key, slice) or key.step not in (None, 1):
                    raise AssertionError("long ML analysis must use contiguous bounded slices")
                start = 0 if key.start is None else max(0, int(key.start))
                stop = len(self) if key.stop is None else min(len(self), int(key.stop))
                sample_count = max(0, stop - start)
                if sample_count > max_source_slice_samples:
                    raise AssertionError("long ML source slice exceeded the ten-second memory cap")
                self.slices.append((start, stop))
                self.max_materialized_samples = max(self.max_materialized_samples, sample_count)
                window = np.zeros(sample_count, dtype=np.float32)
                for speech_start, speech_stop in speech_ranges:
                    overlap_start = max(start, round(speech_start * sample_rate))
                    overlap_stop = min(stop, round(speech_stop * sample_rate))
                    if overlap_stop > overlap_start:
                        window[overlap_start - start : overlap_stop - start] = 0.18
                if sample_count:
                    window[0] = start / source_samples
                return window

        class StreamingTimelineVad:
            def __init__(self) -> None:
                self.call_sizes: list[int] = []
                self.samples_seen = 0

            def score_chunks(self, audio_16k):
                bounded = np.asarray(audio_16k, dtype=np.float32).reshape(-1)
                if bounded.size > max_vad_call_samples:
                    raise AssertionError("Silero received an unbounded long-duration array")
                start_sample = self.samples_seen
                self.call_sizes.append(int(bounded.size))
                self.samples_seen += int(bounded.size)
                probabilities: list[float] = []
                for local_start in range(0, int(bounded.size), 512):
                    midpoint_seconds = (start_sample + local_start + 256) / vad_sample_rate
                    is_speech = any(start <= midpoint_seconds < stop for start, stop in speech_ranges)
                    probabilities.append(0.95 if is_speech else 0.02)
                return tuple(probabilities)

        class RecordingMetrics:
            def __init__(self) -> None:
                self.calls: dict[str, list[tuple[int, float, float]]] = {
                    "dnsmos": [],
                    "sigmos": [],
                }

            def score(self, metric_id: str, audio, received_sample_rate: int):
                if metric_id not in self.calls or received_sample_rate != sample_rate:
                    raise AssertionError("unexpected long-audio metric request")
                bounded = np.asarray(audio, dtype=np.float32).reshape(-1)
                if bounded.nbytes > module._METRIC_WINDOW_BYTE_CAP:
                    raise AssertionError("MOS backend received an unbounded long-duration array")
                start_seconds = float(bounded[0]) * duration_seconds if bounded.size else 0.0
                rms = float(np.sqrt(np.mean(np.square(bounded)))) if bounded.size else 0.0
                self.calls[metric_id].append((int(bounded.size), start_seconds, rms))
                if metric_id == "dnsmos":
                    return {"sig": 4.1, "bak": 3.7, "ovrl": 3.8}
                return {
                    "col": 3.7,
                    "disc": 3.8,
                    "loud": 3.6,
                    "noise": 3.5,
                    "reverb": 3.7,
                    "sig": 3.9,
                    "ovrl": 3.7,
                }

        vad_payload = b"streaming-long-vad"
        dnsmos_payload = b"streaming-long-dnsmos"
        sigmos_payload = b"streaming-long-sigmos"
        source = VirtualLongMono()
        vad_backend = StreamingTimelineVad()
        metrics_backend = RecordingMetrics()
        with tempfile.TemporaryDirectory() as temp_dir:
            model_dir = Path(temp_dir)
            (model_dir / "vad.onnx").write_bytes(vad_payload)
            (model_dir / "dnsmos.onnx").write_bytes(dnsmos_payload)
            (model_dir / "sigmos.onnx").write_bytes(sigmos_payload)
            source_path = model_dir / "source.wav"
            source_bytes = _pcm16_wav(source_path)
            source_hash = hashlib.sha256(source_bytes).hexdigest()
            runtime = AdvisoryInferenceRuntime(
                RuntimeConfig(
                    model_dir=model_dir,
                    metric_ids=("dnsmos", "sigmos"),
                    artifacts=(
                        self._spec("silero-vad", "silero_vad", "vad.onnx", vad_payload),
                        self._spec("dnsmos", "dnsmos", "dnsmos.onnx", dnsmos_payload),
                        self._spec("sigmos", "sigmos", "sigmos.onnx", sigmos_payload),
                    ),
                    max_analysis_seconds=duration_seconds,
                ),
                vad_factory=lambda _: vad_backend,
                metrics_factory=lambda _: metrics_backend,
            )

            with patch.object(
                module,
                "_read_pcm_wav",
                return_value=(source, sample_rate, channels, float(duration_seconds)),
            ):
                report = runtime.analyze_wav(
                    source_path,
                    job_id="long_render_batch_06",
                    source_sha256=source_hash,
                )

        self.assertEqual(source.full_array_requests, 0)
        self.assertTrue(source.slices)
        self.assertLessEqual(source.max_materialized_samples, max_source_slice_samples)
        self.assertGreater(len(vad_backend.call_sizes), 1)
        self.assertEqual(vad_backend.samples_seen, expected_vad_samples)
        self.assertLessEqual(max(vad_backend.call_sizes), max_vad_call_samples)
        self.assertEqual(report["source"]["durationMs"], duration_seconds * 1000)
        self.assertEqual(report["source"]["sampleRate"], sample_rate)
        self.assertEqual(report["source"]["channels"], channels)
        self.assertEqual(report["vad"]["frameMs"], 10)
        self.assertEqual(len(report["vad"]["frames"]), duration_seconds * 100)
        for speech_start, speech_stop in speech_ranges:
            probe_index = round(((speech_start + speech_stop) / 2) * 100)
            self.assertGreaterEqual(
                report["vad"]["frames"][probe_index]["speechProbability"],
                0.9,
            )
        for metric_id in ("dnsmos", "sigmos"):
            calls = metrics_backend.calls[metric_id]
            self.assertGreaterEqual(len(calls), 3)
            self.assertLessEqual(len(calls), 7)
            self.assertTrue(all(count <= max_source_slice_samples for count, _, _ in calls))
            self.assertTrue(all(rms > 0.02 for _, _, rms in calls), calls)
            starts = [start for _, start, _ in calls]
            self.assertLess(min(starts), 30.0)
            self.assertTrue(any(duration_seconds * 0.4 < start < duration_seconds * 0.6 for start in starts))
            self.assertGreater(max(starts), duration_seconds - 40.0)
        self.assertTrue(report["metrics"]["dnsmos.ovrl"]["available"])
        self.assertTrue(report["metrics"]["sigmos.ovrl"]["available"])
        self.assertEqual(report["telemetry"]["components"]["silero-vad"]["status"], "available")
        self.assertEqual(report["telemetry"]["components"]["dnsmos"]["status"], "available")
        self.assertEqual(report["telemetry"]["components"]["sigmos"]["status"], "available")
        self.assertTrue(report["advisoryOnly"])
        self.assertFalse(report["canBlockDelivery"])
        self.assertFalse(report["canChangeGainDb"])
        self.assertEqual(report["levelAuthority"], "gainPlanner")

    def test_long_runtime_uses_bounded_metric_window_when_only_one_speech_window_is_selected(self) -> None:
        import numpy as np

        _, RuntimeConfig, _, _, _, _ = self._model_symbols()
        AdvisoryInferenceRuntime, _ = self._inference_symbols()
        module = __import__(self.INFERENCE_MODULE, fromlist=["_read_pcm_wav"])
        sample_rate = 48_000
        duration_seconds = 600
        source_samples = sample_rate * duration_seconds
        speech_start_seconds = 30.0
        speech_stop_seconds = 36.0

        class VirtualSparseSpeech:
            def __init__(self) -> None:
                self.full_array_requests = 0
                self.max_slice_samples = 0

            def __len__(self) -> int:
                return source_samples

            def __array__(self, *_args, **_kwargs):
                self.full_array_requests += 1
                raise AssertionError("single speech metric window must not materialize the full long source")

            def __getitem__(self, key):
                if not isinstance(key, slice) or key.step not in (None, 1):
                    raise AssertionError("long metric input must use contiguous bounded slices")
                start = 0 if key.start is None else max(0, int(key.start))
                stop = len(self) if key.stop is None else min(len(self), int(key.stop))
                sample_count = max(0, stop - start)
                self.max_slice_samples = max(self.max_slice_samples, sample_count)
                window = np.zeros(sample_count, dtype=np.float32)
                overlap_start = max(start, round(speech_start_seconds * sample_rate))
                overlap_stop = min(stop, round(speech_stop_seconds * sample_rate))
                if overlap_stop > overlap_start:
                    window[overlap_start - start : overlap_stop - start] = 0.2
                return window

        class SingleSpeechVad:
            def score_stream(self, audio_chunks_16k):
                probabilities: list[float] = []
                samples_seen = 0
                for chunk in audio_chunks_16k:
                    bounded = np.asarray(chunk, dtype=np.float32).reshape(-1)
                    for local_start in range(0, int(bounded.size), 512):
                        midpoint_seconds = (samples_seen + local_start + 256) / 16_000
                        probabilities.append(
                            0.95 if speech_start_seconds <= midpoint_seconds < speech_stop_seconds else 0.02
                        )
                    samples_seen += int(bounded.size)
                return tuple(probabilities)

        class RecordingMetrics:
            def __init__(self) -> None:
                self.calls: list[int] = []

            def score(self, metric_id: str, audio, received_sample_rate: int):
                if metric_id != "dnsmos" or received_sample_rate != sample_rate:
                    raise AssertionError("unexpected metric request")
                bounded = np.asarray(audio, dtype=np.float32).reshape(-1)
                self.calls.append(int(bounded.size))
                if not np.any(np.abs(bounded) > 0.01):
                    raise AssertionError("selected metric window missed sparse speech")
                return {"sig": 4.0, "bak": 3.8, "ovrl": 3.9}

        vad_payload = b"single-speech-vad"
        dnsmos_payload = b"single-speech-dnsmos"
        source = VirtualSparseSpeech()
        metrics_backend = RecordingMetrics()
        with tempfile.TemporaryDirectory() as temp_dir:
            model_dir = Path(temp_dir)
            (model_dir / "vad.onnx").write_bytes(vad_payload)
            (model_dir / "dnsmos.onnx").write_bytes(dnsmos_payload)
            source_path = model_dir / "source.wav"
            source_bytes = _pcm16_wav(source_path)
            runtime = AdvisoryInferenceRuntime(
                RuntimeConfig(
                    model_dir=model_dir,
                    metric_ids=("dnsmos",),
                    artifacts=(
                        self._spec("silero-vad", "silero_vad", "vad.onnx", vad_payload),
                        self._spec("dnsmos", "dnsmos", "dnsmos.onnx", dnsmos_payload),
                    ),
                    max_analysis_seconds=duration_seconds,
                ),
                vad_factory=lambda _: SingleSpeechVad(),
                metrics_factory=lambda _: metrics_backend,
            )
            with patch.object(
                module,
                "_read_pcm_wav",
                return_value=(source, sample_rate, 1, float(duration_seconds)),
            ):
                report = runtime.analyze_wav(
                    source_path,
                    job_id="single_sparse_speech",
                    source_sha256=hashlib.sha256(source_bytes).hexdigest(),
                )

        self.assertEqual(source.full_array_requests, 0)
        self.assertTrue(metrics_backend.calls)
        self.assertLessEqual(source.max_slice_samples, sample_rate * 10)
        self.assertTrue(report["metrics"]["dnsmos.ovrl"]["available"])
        self.assertEqual(report["telemetry"]["components"]["dnsmos"]["status"], "available")

    def test_runtime_scores_sparse_editorial_timeline_from_speech_active_windows_only(self) -> None:
        import numpy as np

        _, RuntimeConfig, _, _, _, _ = self._model_symbols()
        AdvisoryInferenceRuntime, _ = self._inference_symbols()
        sample_rate = 16_000
        duration_seconds = 70
        audio = np.zeros(sample_rate * duration_seconds, dtype=np.float32)
        active_ranges = ((11.0, 14.0), (34.0, 38.0), (57.0, 61.0))
        for start_seconds, end_seconds in active_ranges:
            start = round(start_seconds * sample_rate)
            stop = round(end_seconds * sample_rate)
            timeline = np.arange(stop - start, dtype=np.float32) / sample_rate
            audio[start:stop] = 0.18 * np.sin(2 * np.pi * 220 * timeline)

        chunk_count = math.ceil(len(audio) / 512)
        probabilities = [0.01] * chunk_count
        for chunk_index in range(chunk_count):
            midpoint_seconds = (chunk_index * 512 + 256) / sample_rate
            if any(start <= midpoint_seconds < stop for start, stop in active_ranges):
                probabilities[chunk_index] = 0.94

        class RecordingMetrics:
            def __init__(self) -> None:
                self.rms_values: list[float] = []

            def score(self, metric_id: str, window, received_sample_rate: int):
                self.assertions(metric_id, received_sample_rate)
                self.rms_values.append(float(np.sqrt(np.mean(np.square(window)))))
                return {"sig": 4.1, "bak": 3.7, "ovrl": 3.8}

            @staticmethod
            def assertions(metric_id: str, received_sample_rate: int) -> None:
                if metric_id != "dnsmos" or received_sample_rate != sample_rate:
                    raise AssertionError("unexpected speech-aware metric request")

        vad_payload = b"speech-aware-vad"
        metric_payload = b"speech-aware-dnsmos"
        with tempfile.TemporaryDirectory() as temp_dir:
            model_dir = Path(temp_dir)
            (model_dir / "vad.onnx").write_bytes(vad_payload)
            (model_dir / "dnsmos.onnx").write_bytes(metric_payload)
            source_path = model_dir / "sparse.wav"
            pcm = np.clip(audio * 32_767, -32_768, 32_767).astype("<i2")
            with wave.open(str(source_path), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(sample_rate)
                output.writeframes(pcm.tobytes())
            backend = RecordingMetrics()
            runtime = AdvisoryInferenceRuntime(
                RuntimeConfig(
                    model_dir=model_dir,
                    metric_ids=("dnsmos",),
                    artifacts=(
                        self._spec("silero-vad", "silero_vad", "vad.onnx", vad_payload),
                        self._spec("dnsmos", "dnsmos", "dnsmos.onnx", metric_payload),
                    ),
                    max_analysis_seconds=duration_seconds + 1,
                ),
                vad_factory=lambda _: _FakeVad(tuple(probabilities)),
                metrics_factory=lambda _: backend,
            )

            report = runtime.analyze_wav(source_path)

        self.assertGreaterEqual(len(backend.rms_values), 3)
        self.assertLessEqual(len(backend.rms_values), 7)
        self.assertTrue(all(rms > 0.025 for rms in backend.rms_values), backend.rms_values)
        self.assertTrue(report["metrics"]["dnsmos.ovrl"]["available"])
        self.assertEqual(report["telemetry"]["components"]["dnsmos"]["status"], "available")

    def test_runtime_refuses_silence_only_mos_instead_of_authorizing_cleanup(self) -> None:
        import numpy as np

        _, RuntimeConfig, _, _, _, _ = self._model_symbols()
        AdvisoryInferenceRuntime, _ = self._inference_symbols()

        class UnexpectedMetrics:
            calls = 0

            def score(self, _metric_id: str, _audio, _sample_rate: int):
                self.calls += 1
                return {"sig": 2.5, "bak": 2.1, "ovrl": 1.9}

        sample_rate = 16_000
        duration_seconds = 30
        vad_payload = b"silence-vad"
        metric_payload = b"silence-dnsmos"
        with tempfile.TemporaryDirectory() as temp_dir:
            model_dir = Path(temp_dir)
            (model_dir / "vad.onnx").write_bytes(vad_payload)
            (model_dir / "dnsmos.onnx").write_bytes(metric_payload)
            source_path = model_dir / "silence.wav"
            samples = np.zeros(sample_rate * duration_seconds, dtype="<i2")
            with wave.open(str(source_path), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(sample_rate)
                output.writeframes(samples.tobytes())
            backend = UnexpectedMetrics()
            runtime = AdvisoryInferenceRuntime(
                RuntimeConfig(
                    model_dir=model_dir,
                    metric_ids=("dnsmos",),
                    artifacts=(
                        self._spec("silero-vad", "silero_vad", "vad.onnx", vad_payload),
                        self._spec("dnsmos", "dnsmos", "dnsmos.onnx", metric_payload),
                    ),
                    max_analysis_seconds=duration_seconds + 1,
                ),
                vad_factory=lambda _: _FakeVad(tuple([0.01] * math.ceil(len(samples) / 512))),
                metrics_factory=lambda _: backend,
            )

            report = runtime.analyze_wav(source_path)

        self.assertEqual(backend.calls, 0)
        self.assertFalse(report["metrics"]["dnsmos.ovrl"]["available"])
        self.assertEqual(
            report["telemetry"]["components"]["dnsmos"],
            {"status": "unavailable", "code": "no-speech-metric-windows"},
        )

    def test_short_metric_scoring_preserves_one_call_behavior(self) -> None:
        import numpy as np

        _, RuntimeConfig, _, _, _, _ = self._model_symbols()
        AdvisoryInferenceRuntime, _ = self._inference_symbols()
        module = __import__(self.INFERENCE_MODULE, fromlist=["_empty_metrics"])
        source = np.linspace(-0.25, 0.25, 100, dtype=np.float32)

        class RecordingMetrics:
            def __init__(self) -> None:
                self.inputs: list[object] = []

            def score(self, metric_id: str, audio, sample_rate: int):
                self.inputs.append(audio)
                return 3.75

        backend = RecordingMetrics()
        runtime = AdvisoryInferenceRuntime(
            RuntimeConfig(
                model_dir=Path("."),
                metric_ids=(),
                artifacts=(),
                max_analysis_seconds=1,
            )
        )
        runtime._metrics = backend
        metrics = module._empty_metrics(("utmos",))
        components: dict[str, dict[str, object]] = {}

        runtime._score_metric("utmos", metrics, components, source, 16_000)

        self.assertEqual(len(backend.inputs), 1)
        self.assertIs(backend.inputs[0], source)
        self.assertEqual(metrics["utmos"]["value"], 3.75)
        self.assertEqual(components["utmos"], {"status": "available", "code": "ok"})

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

    def test_local_fallback_reads_extensible_pcm_without_stdlib_wave_support(self) -> None:
        LocalFallbackAnalyzer, = require_symbols(
            self,
            "extreme_worker.api_support",
            "LocalFallbackAnalyzer",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir, "source-extensible.wav")
            payload = _extensible_pcm24_wav(source_path)
            report = LocalFallbackAnalyzer().analyze_wav(
                source_path,
                job_id="job_extensible_fallback",
                source_sha256=hashlib.sha256(payload).hexdigest(),
            )

        self.assertEqual(report["source"]["sampleRate"], 48_000)
        self.assertEqual(report["source"]["channels"], 1)
        self.assertEqual(report["source"]["durationMs"], 100.0)
        self.assertEqual(report["telemetry"]["runtimeStatus"], "degraded")

    def test_local_fallback_rejects_invalid_float_sample_values(self) -> None:
        LocalFallbackAnalyzer, = require_symbols(
            self,
            "extreme_worker.api_support",
            "LocalFallbackAnalyzer",
        )
        cases = (
            ("non-finite-float-samples", (0.0, math.nan, math.inf, -math.inf)),
            ("out-of-range-float-samples", (0.0, 1.0001, -1.0001, 0.5)),
        )
        for expected_error, samples in cases:
            with self.subTest(expected_error=expected_error), tempfile.TemporaryDirectory() as temp_dir:
                source_path = Path(temp_dir, "invalid-fallback.wav")
                payload = _float32_wav(source_path, samples=samples)
                with self.assertRaisesRegex(ValueError, expected_error):
                    LocalFallbackAnalyzer().analyze_wav(
                        source_path,
                        job_id="job_float_fallback",
                        source_sha256=hashlib.sha256(payload).hexdigest(),
                    )

    def test_runtime_decodes_valid_wave_format_extensible_integer_pcm(self) -> None:
        module = __import__(self.INFERENCE_MODULE, fromlist=["_read_pcm_wav"])
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir, "extensible-pcm24.wav")
            _extensible_pcm24_wav(source_path)
            audio, sample_rate, channels, duration_seconds = module._read_pcm_wav(
                source_path,
                max_duration_seconds=1.0,
            )

        self.assertEqual(sample_rate, 48_000)
        self.assertEqual(channels, 1)
        self.assertEqual(audio.shape, (4_800,))
        self.assertAlmostEqual(duration_seconds, 0.1, places=6)
        self.assertTrue((audio > 0).all())

    def test_runtime_decodes_exact_float32_deliverable_samples(self) -> None:
        module = __import__(self.INFERENCE_MODULE, fromlist=["_read_pcm_wav"])
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir, "rendered-float32.wav")
            _float32_wav(source_path)
            audio, sample_rate, channels, duration_seconds = module._read_pcm_wav(
                source_path,
                max_duration_seconds=10.0,
            )

        import numpy as np

        self.assertEqual(sample_rate, 48_000)
        self.assertEqual(channels, 1)
        self.assertAlmostEqual(duration_seconds, 4 / 48_000, places=9)
        self.assertTrue(np.allclose(audio, [0.5, -0.5, 0.25, -0.25]))

    def test_runtime_rejects_non_finite_float32_samples(self) -> None:
        module = __import__(self.INFERENCE_MODULE, fromlist=["_read_pcm_wav"])
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir, "non-finite-float32.wav")
            _float32_wav(source_path, samples=(0.0, math.nan, math.inf, -math.inf))
            with self.assertRaisesRegex(ValueError, "non-finite-float-samples"):
                module._read_pcm_wav(source_path, max_duration_seconds=10.0)

    def test_runtime_rejects_out_of_range_float32_instead_of_silently_clipping(self) -> None:
        module = __import__(self.INFERENCE_MODULE, fromlist=["_read_pcm_wav"])
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir, "out-of-range-float32.wav")
            _float32_wav(source_path, samples=(0.0, 1.0001, -1.0001, 0.5))
            with self.assertRaisesRegex(ValueError, "out-of-range-float-samples"):
                module._read_pcm_wav(source_path, max_duration_seconds=10.0)

    def test_long_float32_validation_reaches_an_invalid_tail_with_bounded_reads_and_no_full_allocation(self) -> None:
        import numpy as np

        module = __import__(self.INFERENCE_MODULE, fromlist=["_read_pcm_wav"])
        validation_module = __import__(
            "extreme_worker.wav_validation",
            fromlist=["_FLOAT_SCAN_CHUNK_SAMPLES"],
        )
        sample_rate = 48_000
        frame_count = (
            module._METRIC_WINDOW_BYTE_CAP // np.dtype(np.float32).itemsize
            + validation_module._FLOAT_SCAN_CHUNK_SAMPLES
            + 3
        )
        data_bytes = frame_count * np.dtype(np.float32).itemsize
        scan_byte_cap = validation_module._FLOAT_SCAN_CHUNK_SAMPLES * 4
        fmt = struct.pack(
            "<HHIIHH",
            3,
            1,
            sample_rate,
            sample_rate * 4,
            4,
            32,
        )
        header = (
            b"RIFF"
            + struct.pack("<I", 36 + data_bytes)
            + b"WAVE"
            + b"fmt "
            + struct.pack("<I", len(fmt))
            + fmt
            + b"data"
            + struct.pack("<I", data_bytes)
        )
        read_ranges: list[tuple[int, int]] = []

        class RecordingReader:
            def __init__(self, handle) -> None:
                self._handle = handle

            def __enter__(self):
                self._handle.__enter__()
                return self

            def __exit__(self, *args):
                return self._handle.__exit__(*args)

            def __getattr__(self, name):
                return getattr(self._handle, name)

            def read(self, byte_count: int = -1) -> bytes:
                if byte_count < 0 or byte_count > scan_byte_cap:
                    raise AssertionError("float validation read exceeded its bounded scan chunk")
                start = self._handle.tell()
                payload = self._handle.read(byte_count)
                read_ranges.append((start, start + len(payload)))
                return payload

        original_empty = np.empty

        def reject_full_duration_empty(shape, *args, **kwargs):
            item_count = math.prod(shape) if isinstance(shape, tuple) else int(shape)
            dtype_arg = kwargs.get("dtype", args[0] if args else np.float64)
            if np.dtype(dtype_arg) == np.dtype(np.float32) and item_count >= frame_count:
                raise AssertionError("long float validation allocated the full source timeline")
            return original_empty(shape, *args, **kwargs)

        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir, "long-invalid-tail-float32.wav")
            with source_path.open("wb") as source:
                source.write(header)
                source.seek(len(header) + data_bytes - 4)
                source.write(struct.pack("<f", math.nan))

            original_open = Path.open

            def recording_open(path: Path, mode: str = "r", *args, **kwargs):
                handle = original_open(path, mode, *args, **kwargs)
                if Path(path) == source_path and mode == "rb":
                    return RecordingReader(handle)
                return handle

            with (
                patch.object(Path, "open", new=recording_open),
                patch.object(np, "empty", side_effect=reject_full_duration_empty),
                self.assertRaisesRegex(ValueError, "non-finite-float-samples"),
            ):
                module._read_pcm_wav(source_path, max_duration_seconds=60.0)

        self.assertTrue(read_ranges)
        self.assertLessEqual(max(stop - start for start, stop in read_ranges), scan_byte_cap)
        self.assertGreaterEqual(max(stop for _, stop in read_ranges), len(header) + data_bytes)

    def test_runtime_decodes_large_pcm_payload_in_bounded_chunks(self) -> None:
        module = __import__(self.INFERENCE_MODULE, fromlist=["_read_pcm_wav"])
        chunk_frames = module._PCM_DECODE_CHUNK_FRAMES
        frame_count = chunk_frames * 2 + 17
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir, "bounded-extensible-pcm24.wav")
            _extensible_pcm24_wav(source_path, frames=frame_count)
            with patch.object(
                module,
                "_decode_pcm_samples",
                wraps=module._decode_pcm_samples,
            ) as decode:
                audio, _, _, _ = module._read_pcm_wav(source_path, max_duration_seconds=10.0)

        self.assertEqual(audio.shape, (frame_count,))
        self.assertGreaterEqual(decode.call_count, 3)
        self.assertTrue(
            all(len(call.args[0]) <= chunk_frames * 3 for call in decode.call_args_list)
        )

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

    def test_silero_stream_preserves_recurrent_state_and_context_across_input_boundaries(self) -> None:
        import numpy as np

        module = __import__(self.INFERENCE_MODULE, fromlist=["SileroOnnxBackend"])
        sessions: list[object] = []

        class FakeOptions:
            pass

        class FakeSession:
            def __init__(self, _path, *, sess_options, providers) -> None:
                self.options = sess_options
                self.providers = providers
                self.feeds: list[dict[str, object]] = []
                sessions.append(self)

            def get_inputs(self):
                return [SimpleNamespace(name=name) for name in ("input", "state", "sr")]

            def run(self, _outputs, feed):
                copied_feed = {
                    name: np.asarray(value).copy()
                    for name, value in feed.items()
                }
                self.feeds.append(copied_feed)
                call_number = len(self.feeds)
                return (
                    np.asarray([[call_number / 10]], dtype=np.float32),
                    np.full((2, 1, 128), call_number, dtype=np.float32),
                )

        fake_ort = types.ModuleType("onnxruntime")
        fake_ort.SessionOptions = FakeOptions
        fake_ort.ExecutionMode = SimpleNamespace(ORT_SEQUENTIAL="sequential")
        fake_ort.InferenceSession = FakeSession
        source_chunks = (
            np.full(300, 1.0, dtype=np.float32),
            np.full(400, 2.0, dtype=np.float32),
            np.full(500, 3.0, dtype=np.float32),
        )

        with patch.dict(sys.modules, {"onnxruntime": fake_ort}):
            backend = module.SileroOnnxBackend(Path("pinned.onnx"))
            probabilities = backend.score_stream(iter(source_chunks))

        self.assertTrue(np.allclose(probabilities, (0.1, 0.2, 0.3)))
        self.assertEqual(len(sessions), 1)
        feeds = sessions[0].feeds
        self.assertEqual(len(feeds), 3)
        self.assertTrue(all(feed["input"].shape == (1, 576) for feed in feeds))
        self.assertTrue(np.all(feeds[0]["state"] == 0))
        self.assertTrue(np.all(feeds[1]["state"] == 1))
        self.assertTrue(np.all(feeds[2]["state"] == 2))
        self.assertTrue(np.all(feeds[0]["input"][0, :64] == 0))
        self.assertTrue(np.all(feeds[1]["input"][0, :64] == 2))
        self.assertTrue(np.all(feeds[2]["input"][0, :64] == 3))
        self.assertTrue(np.all(feeds[0]["input"][0, 64:364] == 1))
        self.assertTrue(np.all(feeds[0]["input"][0, 364:] == 2))
        self.assertTrue(np.all(feeds[1]["input"][0, 64:252] == 2))
        self.assertTrue(np.all(feeds[1]["input"][0, 252:] == 3))
        self.assertTrue(np.all(feeds[2]["input"][0, 64:240] == 3))
        self.assertTrue(np.all(feeds[2]["input"][0, 240:] == 0))

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

    def test_streaming_vad_resample_has_exact_timeline_length_and_bounded_chunks_at_every_allowed_rate(self) -> None:
        import numpy as np

        module = __import__(self.INFERENCE_MODULE, fromlist=["_iter_resampled_for_vad"])

        for sample_rate in (16_000, 24_000, 44_100, 48_000):
            with self.subTest(sample_rate=sample_rate):
                source_samples = sample_rate * 9 + 137
                expected_output_samples = round(source_samples * 16_000 / sample_rate)
                max_source_window = (
                    math.ceil(module._VAD_STREAM_CHUNK_SAMPLES * sample_rate / 16_000)
                    + 2
                )

                class VirtualAudio:
                    def __init__(self) -> None:
                        self.requests: list[tuple[int, int]] = []
                        self.full_array_requests = 0

                    def __len__(self) -> int:
                        return source_samples

                    def __array__(self, *_args, **_kwargs):
                        self.full_array_requests += 1
                        raise AssertionError("streaming resample materialized the full source")

                    def __getitem__(self, key):
                        if not isinstance(key, slice) or key.step not in (None, 1):
                            raise AssertionError("streaming resample must use contiguous slices")
                        start, stop, step = key.indices(source_samples)
                        if step != 1 or stop - start > max_source_window:
                            raise AssertionError("streaming resample exceeded its source-window cap")
                        self.requests.append((start, stop))
                        return np.linspace(-0.25, 0.25, stop - start, dtype=np.float32)

                source = VirtualAudio()
                chunks = tuple(module._iter_resampled_for_vad(source, sample_rate))
                chunk_sizes = [int(np.asarray(chunk).size) for chunk in chunks]

                self.assertEqual(source.full_array_requests, 0)
                self.assertTrue(source.requests)
                self.assertGreater(len(chunks), 1)
                self.assertEqual(sum(chunk_sizes), expected_output_samples)
                self.assertEqual(
                    chunk_sizes[:-1],
                    [module._VAD_STREAM_CHUNK_SAMPLES] * (len(chunk_sizes) - 1),
                )
                self.assertGreater(chunk_sizes[-1], 0)
                self.assertLessEqual(chunk_sizes[-1], module._VAD_STREAM_CHUNK_SAMPLES)
                self.assertTrue(all(np.asarray(chunk).dtype == np.float32 for chunk in chunks))
                self.assertLessEqual(
                    max(stop - start for start, stop in source.requests),
                    max_source_window,
                )


if __name__ == "__main__":
    unittest.main()
