from __future__ import annotations

import hashlib
import re
import struct
import tempfile
import unittest

from fastapi.testclient import TestClient

from contract_support import require_symbols


def pcm_wav(*, sample_rate: int = 16_000, frames: int = 1_600) -> bytes:
    channels = 1
    bits_per_sample = 16
    sample_bytes = bits_per_sample // 8
    block_align = channels * sample_bytes
    byte_rate = sample_rate * block_align
    samples = bytearray()
    for index in range(frames):
        value = 0 if index < 200 else 3200
        samples += struct.pack("<h", value)
    fmt = struct.pack("<HHIIHH", 1, channels, sample_rate, byte_rate, block_align, bits_per_sample)
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(samples)) + bytes(samples)
    return b"RIFF" + struct.pack("<I", len(body)) + body


class FakeAnalyzer:
    def analyze_wav(self, _path, *, job_id: str, source_sha256: str) -> dict[str, object]:
        del job_id
        return {
            "schemaVersion": 1,
            "advisoryOnly": True,
            "canBlockDelivery": False,
            "canChangeGainDb": False,
            "levelAuthority": "gainPlanner",
            "modelSetId": "test-pinned-models",
            "source": {
                "sha256": source_sha256,
                "durationMs": 100.0,
                "sampleRate": 16_000,
                "channels": 1,
            },
            "vad": {
                "frameMs": 10,
                "frames": [
                    {"startMs": 0, "endMs": 10, "speechProbability": 0.92},
                    {"startMs": 10, "endMs": 20, "speechProbability": 0.88},
                ],
            },
            "metrics": {
                "dnsmos.ovrl": {"value": None, "available": False, "higherIsBetter": True},
            },
            "models": [
                {
                    "id": "silero-vad",
                    "version": "6.2.1",
                    "revision": "a" * 40,
                    "sha256": hashlib.sha256(b"fake-silero-vad").hexdigest(),
                }
            ],
            "telemetry": {
                "runtimeStatus": "ready",
                "reason": "ok",
                "audioMutation": False,
                "candidateSelected": False,
                "gainDbChanged": False,
            },
        }


class WorkerEndpointContractTests(unittest.TestCase):
    def test_internal_ticket_requires_secret_and_returns_metadata_only_upload_ticket(self) -> None:
        create_app, = require_symbols(self, "extreme_worker.app", "create_app")
        with tempfile.TemporaryDirectory() as temp_dir:
            with TestClient(create_app({"storage_root": temp_dir, "internal_secret": "s" * 40})) as client:
                denied = client.post("/internal/v1/tickets", json={"sizeBytes": 10, "contentType": "audio/wav"})
                allowed = client.post(
                    "/internal/v1/tickets",
                    headers={"Authorization": "Bearer " + "s" * 40},
                    json={
                        "sizeBytes": 10,
                        "contentType": "audio/wav",
                        "idempotencyKey": "batch-1-file-1",
                        "scope": "source_analysis",
                    },
                )

        self.assertEqual(denied.status_code, 401)
        self.assertEqual(allowed.status_code, 200)
        payload = allowed.json()
        self.assertIsInstance(payload["ticket"], str)
        self.assertIn("expiresAt", payload)
        self.assertNotIn("bytes", payload)
        self.assertNotIn("source", payload)

    def test_job_upload_complete_and_report_are_owner_token_scoped_and_advisory(self) -> None:
        create_app, = require_symbols(self, "extreme_worker.app", "create_app")
        source = pcm_wav()
        digest = hashlib.sha256(source).hexdigest()
        with tempfile.TemporaryDirectory() as temp_dir:
            with TestClient(
                create_app(
                    {
                        "storage_root": temp_dir,
                        "internal_secret": "s" * 40,
                        "analyzer": FakeAnalyzer(),
                    }
                )
            ) as client:
                ticket = client.post(
                    "/internal/v1/tickets",
                    headers={"Authorization": "Bearer " + "s" * 40},
                    json={
                        "sizeBytes": len(source),
                        "contentType": "audio/wav",
                        "idempotencyKey": "batch-1-file-1",
                        "scope": "source_analysis",
                        "sha256": digest,
                    },
                ).json()["ticket"]
                created = client.post(
                    "/v1/jobs",
                    headers={"Authorization": f"Bearer {ticket}"},
                    json={
                        "sizeBytes": len(source),
                        "contentType": "audio/wav",
                        "idempotencyKey": "batch-1-file-1",
                        "scope": "source_analysis",
                        "sha256": digest,
                    },
                )
                self.assertEqual(created.status_code, 200)
                job = created.json()
                self.assertRegex(job["jobId"], r"^job_[A-Za-z0-9_-]+$")
                self.assertGreater(job["maxChunkBytes"], 0)
                unauthorized_status = client.get(f"/v1/jobs/{job['jobId']}").status_code
                uploaded = client.patch(
                    f"/v1/jobs/{job['jobId']}/input",
                    headers={
                        "Authorization": f"Bearer {job['accessToken']}",
                        "Upload-Offset": "0",
                        "Content-Type": "audio/wav",
                    },
                    content=source,
                )
                completed = client.post(
                    f"/v1/jobs/{job['jobId']}/input/complete",
                    headers={"Authorization": f"Bearer {job['accessToken']}"},
                )
                status = client.get(
                    f"/v1/jobs/{job['jobId']}",
                    headers={"Authorization": f"Bearer {job['accessToken']}"},
                )
                report = client.get(
                    f"/v1/jobs/{job['jobId']}/report",
                    headers={"Authorization": f"Bearer {job['accessToken']}"},
                )

        self.assertEqual(unauthorized_status, 404)
        self.assertEqual(uploaded.status_code, 204)
        self.assertEqual(uploaded.headers["Upload-Offset"], str(len(source)))
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(status.json()["state"], "succeeded")
        self.assertEqual(report.status_code, 200)
        payload = report.json()
        self.assertTrue(payload["advisoryOnly"])
        self.assertFalse(payload["canBlockDelivery"])
        self.assertFalse(payload["canChangeGainDb"])
        self.assertEqual(payload["levelAuthority"], "gainPlanner")
        self.assertEqual(payload["source"]["sha256"], digest)
        self.assertIn("frames", payload["vad"])
        self.assertIsNone(re.fullmatch(r"([0-9a-f])\1{63}", payload["models"][0]["sha256"]))


if __name__ == "__main__":
    unittest.main()
