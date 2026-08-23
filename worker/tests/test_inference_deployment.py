from __future__ import annotations

import unittest
from pathlib import Path


WORKER_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = WORKER_ROOT.parent


class InferenceDeploymentContractTests(unittest.TestCase):
    def test_container_is_reproducible_non_root_and_one_process(self) -> None:
        dockerfile = (WORKER_ROOT / "Dockerfile").read_text(encoding="utf-8")

        self.assertIn(
            "python:3.11.13-slim-bookworm@sha256:86adf8dbadc3d6e82ee5dd2c74bec2e1c2467cdad47886280501df722372d2e1",
            dockerfile,
        )
        self.assertIn("pip install --no-cache-dir --require-hashes", dockerfile)
        self.assertIn("USER extreme", dockerfile)
        self.assertIn("HEALTHCHECK", dockerfile)
        self.assertIn("--workers 1", dockerfile)
        self.assertNotIn("--reload", dockerfile)

    def test_container_fetches_only_checksum_pinned_advisory_models(self) -> None:
        dockerfile = (WORKER_ROOT / "Dockerfile").read_text(encoding="utf-8").lower()

        self.assertGreaterEqual(dockerfile.count("add --checksum=sha256:"), 4)
        self.assertIn("silero_vad_v6.2.1.onnx", dockerfile)
        self.assertIn("dnsmos_sig_bak_ovr.onnx", dockerfile)
        self.assertIn("dnsmos_p808_model_v8.onnx", dockerfile)
        self.assertIn("sigmos_p804.onnx", dockerfile)
        self.assertNotIn("utmos22_strong.onnx", dockerfile)
        self.assertNotIn("nisqa", dockerfile)
        self.assertNotIn("deepfilternet", dockerfile)

    def test_render_blueprint_is_an_isolated_single_disk_backed_service(self) -> None:
        blueprint = (REPO_ROOT / "render.yaml").read_text(encoding="utf-8")

        expected_fragments = (
            "name: voiceover-extreme-ml-worker-2026-08-24",
            "type: web",
            "runtime: docker",
            "plan: standard",
            "region: singapore",
            "rootDir: worker",
            "dockerfilePath: ./worker/Dockerfile",
            "dockerContext: ./worker",
            "healthCheckPath: /health/ready",
            "numInstances: 1",
            "mountPath: /var/data",
            "sizeGB: 20",
            "maxShutdownDelaySeconds: 300",
        )
        for fragment in expected_fragments:
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, blueprint)
        self.assertGreaterEqual(blueprint.count("sync: false"), 3)
        self.assertNotIn("value: *", blueprint)


if __name__ == "__main__":
    unittest.main()
