from __future__ import annotations

import hashlib
import tempfile
import unittest

from fastapi.testclient import TestClient

from contract_support import require_symbols


def minimal_wav() -> bytes:
    data = (0).to_bytes(2, "little", signed=True) * 480
    return (
        b"RIFF"
        + (36 + len(data)).to_bytes(4, "little")
        + b"WAVEfmt "
        + (16).to_bytes(4, "little")
        + (1).to_bytes(2, "little")
        + (1).to_bytes(2, "little")
        + (48000).to_bytes(4, "little")
        + (96000).to_bytes(4, "little")
        + (2).to_bytes(2, "little")
        + (16).to_bytes(2, "little")
        + b"data"
        + len(data).to_bytes(4, "little")
        + data
    )


class ExtremeWorkerApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        create_app, = require_symbols(self, "extreme_worker.app", "create_app")
        self.internal_secret = "s" * 40
        self.client = TestClient(
            create_app(
                {
                    "storage_root": self.temp_dir.name,
                    "internal_secret": self.internal_secret,
                    "ticket_ttl_seconds": 300,
                    "max_upload_bytes": 1024 * 1024,
                    "max_duration_seconds": 60,
                }
            )
        )

    def tearDown(self) -> None:
        self.client.app.state.job_store.close()
        self.temp_dir.cleanup()

    def _ticket(self, *, size: int, sha256: str) -> str:
        response = self.client.post(
            "/internal/v1/tickets",
            headers={"Authorization": f"Bearer {self.internal_secret}"},
            json={
                "ownerHash": "a" * 64,
                "sizeBytes": size,
                "contentType": "audio/wav",
                "idempotencyKey": "batch-1-file-1",
                "scope": "source_analysis",
                "sha256": sha256,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertIsInstance(payload["ticket"], str)
        self.assertNotIn(self.internal_secret, payload["ticket"])
        return payload["ticket"]

    def test_internal_ticket_endpoint_requires_server_secret(self) -> None:
        response = self.client.post("/internal/v1/tickets", json={})
        self.assertEqual(response.status_code, 401)

    def test_render_analysis_scope_is_preserved_by_ticket_and_job_admission(self) -> None:
        wav = minimal_wav()
        digest = hashlib.sha256(wav).hexdigest()
        metadata = {
            "ownerHash": "a" * 64,
            "sizeBytes": len(wav),
            "contentType": "audio/wav",
            "idempotencyKey": "render-1",
            "scope": "render_analysis",
            "sha256": digest,
        }
        ticket_response = self.client.post(
            "/internal/v1/tickets",
            headers={"Authorization": f"Bearer {self.internal_secret}"},
            json=metadata,
        )
        self.assertEqual(ticket_response.status_code, 200, ticket_response.text)
        job_response = self.client.post(
            "/v1/jobs",
            headers={"Authorization": f"Bearer {ticket_response.json()['ticket']}"},
            json={key: value for key, value in metadata.items() if key != "ownerHash"},
        )
        self.assertEqual(job_response.status_code, 200, job_response.text)
        self.assertEqual(job_response.json()["scope"], "render_analysis")

    def test_unknown_analysis_scope_is_rejected(self) -> None:
        wav = minimal_wav()
        response = self.client.post(
            "/internal/v1/tickets",
            headers={"Authorization": f"Bearer {self.internal_secret}"},
            json={
                "ownerHash": "a" * 64,
                "sizeBytes": len(wav),
                "contentType": "audio/wav",
                "idempotencyKey": "unknown-scope",
                "scope": "output_analysis",
                "sha256": hashlib.sha256(wav).hexdigest(),
            },
        )
        self.assertEqual(response.status_code, 400)

    def test_direct_upload_job_lifecycle_returns_advisory_report(self) -> None:
        wav = minimal_wav()
        digest = hashlib.sha256(wav).hexdigest()
        ticket = self._ticket(size=len(wav), sha256=digest)
        job_response = self.client.post(
            "/v1/jobs",
            headers={"Authorization": f"Bearer {ticket}"},
            json={
                "idempotencyKey": "batch-1-file-1",
                "sizeBytes": len(wav),
                "contentType": "audio/wav",
                "scope": "source_analysis",
                "sha256": digest,
            },
        )
        self.assertEqual(job_response.status_code, 200, job_response.text)
        job = job_response.json()
        self.assertRegex(job["jobId"], r"^job_[A-Za-z0-9_-]+$")
        self.assertGreaterEqual(job["maxChunkBytes"], 1)
        access_token = job["accessToken"]

        upload_response = self.client.patch(
            f"/v1/jobs/{job['jobId']}/input",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "audio/wav",
                "Upload-Offset": "0",
            },
            content=wav,
        )
        self.assertEqual(upload_response.status_code, 204, upload_response.text)
        self.assertEqual(upload_response.headers["Upload-Offset"], str(len(wav)))

        complete_response = self.client.post(
            f"/v1/jobs/{job['jobId']}/input/complete",
            headers={"Authorization": f"Bearer {access_token}"},
            json={},
        )
        self.assertEqual(complete_response.status_code, 200, complete_response.text)
        self.assertEqual(complete_response.json()["state"], "succeeded")

        status_response = self.client.get(
            f"/v1/jobs/{job['jobId']}",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        self.assertEqual(status_response.status_code, 200)
        self.assertEqual(status_response.json()["state"], "succeeded")

        report_response = self.client.get(
            f"/v1/jobs/{job['jobId']}/report",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        self.assertEqual(report_response.status_code, 200, report_response.text)
        report = report_response.json()
        self.assertEqual(report["advisoryOnly"], True)
        self.assertEqual(report["canBlockDelivery"], False)
        self.assertEqual(report["canChangeGainDb"], False)
        self.assertEqual(report["levelAuthority"], "gainPlanner")
        self.assertEqual(report["source"]["sha256"], hashlib.sha256(wav).hexdigest())


if __name__ == "__main__":
    unittest.main()
