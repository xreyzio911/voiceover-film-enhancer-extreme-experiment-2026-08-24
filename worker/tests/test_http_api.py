from __future__ import annotations

import hashlib
import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from contract_support import MutableClock, require_symbols
from test_wav_validation import pcm_wav


class FakeAnalyzer:
    def analyze_wav(self, path: Path, *, job_id: str, source_sha256: str) -> dict[str, object]:
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
                "sampleRate": 48_000,
                "channels": 1,
            },
            "vad": {"frameMs": 10.0, "frames": []},
            "metrics": {
                "dnsmos.ovrl": {"value": None, "available": False, "higherIsBetter": True},
            },
            "models": [],
        }


class WorkerHttpApiContractTests(unittest.TestCase):
    ORIGIN = "https://extreme.example"
    INTERNAL_SECRET = "i" * 48
    TICKET_SECRET = "t" * 48

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.storage_root = Path(self.temp_dir.name) / "worker-state"
        self.clock = MutableClock()
        self.wav = pcm_wav(frames=4_800)
        self.create_app, = require_symbols(self, "extreme_worker.app", "create_app")
        self.app = self._new_app()
        self.client_context = TestClient(self.app)
        self.client = self.client_context.__enter__()

    def tearDown(self) -> None:
        if hasattr(self, "client_context"):
            self.client_context.__exit__(None, None, None)
        self.temp_dir.cleanup()

    def _new_app(self):
        return self.create_app(
            {
                "storage_root": self.storage_root,
                "allowed_origins": [self.ORIGIN],
                "internal_secret": self.INTERNAL_SECRET,
                "ticket_secret": self.TICKET_SECRET,
                "ticket_ttl_seconds": 60,
                "max_audio_bytes": 1_000_000,
                "max_chunk_bytes": 1_024,
                "max_duration_seconds": 30.0,
                "clock": self.clock,
                "analyzer": FakeAnalyzer(),
                "worker_poll_seconds": 0.01,
            }
        )

    def _metadata(self, **overrides: object) -> dict[str, object]:
        payload: dict[str, object] = {
            "sizeBytes": len(self.wav),
            "contentType": "audio/wav",
            "idempotencyKey": "source-contract-001",
            "scope": "source_analysis",
        }
        payload.update(overrides)
        return payload

    def _ticket(self, *, owner_hash: str = "a" * 64, metadata: dict[str, object] | None = None) -> str:
        response = self.client.post(
            "/internal/v1/tickets",
            headers={"Authorization": f"Bearer {self.INTERNAL_SECRET}"},
            json={"ownerHash": owner_hash, **(metadata or self._metadata())},
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertIn("ticket", payload)
        self.assertIn("expiresAt", payload)
        return payload["ticket"]

    def _job(self, *, ticket: str | None = None, metadata: dict[str, object] | None = None) -> dict[str, object]:
        response = self.client.post(
            "/v1/jobs",
            headers={"Authorization": f"Bearer {ticket or self._ticket()}"},
            json=metadata or self._metadata(),
        )
        self.assertIn(response.status_code, (200, 201), response.text)
        payload = response.json()
        self.assertIsInstance(payload.get("jobId"), str)
        self.assertIsInstance(payload.get("accessToken"), str)
        self.assertEqual(payload.get("uploadOffset"), 0)
        self.assertEqual(payload.get("maxChunkBytes"), 1_024)
        return payload

    def test_internal_ticket_requires_secret_and_strict_metadata(self) -> None:
        payload = {"ownerHash": "a" * 64, **self._metadata()}
        self.assertEqual(self.client.post("/internal/v1/tickets", json=payload).status_code, 401)
        self.assertEqual(
            self.client.post(
                "/internal/v1/tickets",
                headers={"Authorization": "Bearer wrong"},
                json=payload,
            ).status_code,
            401,
        )
        invalid = {**payload, "contentType": "audio/mpeg"}
        self.assertEqual(
            self.client.post(
                "/internal/v1/tickets",
                headers={"Authorization": f"Bearer {self.INTERNAL_SECRET}"},
                json=invalid,
            ).status_code,
            400,
        )
        too_large = {**payload, "sizeBytes": 1_000_001}
        self.assertEqual(
            self.client.post(
                "/internal/v1/tickets",
                headers={"Authorization": f"Bearer {self.INTERNAL_SECRET}"},
                json=too_large,
            ).status_code,
            413,
        )

    def test_admission_ticket_is_metadata_bound_and_one_time(self) -> None:
        metadata = self._metadata()
        ticket = self._ticket(metadata=metadata)
        mismatch = self.client.post(
            "/v1/jobs",
            headers={"Authorization": f"Bearer {ticket}"},
            json={**metadata, "sizeBytes": len(self.wav) - 1},
        )
        self.assertEqual(mismatch.status_code, 401)
        created = self.client.post(
            "/v1/jobs",
            headers={"Authorization": f"Bearer {ticket}"},
            json=metadata,
        )
        self.assertEqual(created.status_code, 200, created.text)
        replay = self.client.post(
            "/v1/jobs",
            headers={"Authorization": f"Bearer {ticket}"},
            json=metadata,
        )
        self.assertEqual(replay.status_code, 401)

    def test_full_resumable_upload_status_and_advisory_report_flow(self) -> None:
        job = self._job()
        job_id = str(job["jobId"])
        access_token = str(job["accessToken"])
        headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/offset+octet-stream"}
        offset = 0
        while offset < len(self.wav):
            chunk = self.wav[offset:offset + 777]
            response = self.client.patch(
                f"/v1/jobs/{job_id}/input",
                headers={**headers, "Upload-Offset": str(offset)},
                content=chunk,
            )
            self.assertEqual(response.status_code, 204, response.text)
            offset = int(response.headers["Upload-Offset"])
        complete = self.client.post(
            f"/v1/jobs/{job_id}/input/complete",
            headers={"Authorization": f"Bearer {access_token}"},
            json={},
        )
        self.assertEqual(complete.status_code, 200, complete.text)
        self.assertEqual(complete.json()["state"], "succeeded")

        status_payload: dict[str, object] = {}
        for _ in range(100):
            status = self.client.get(
                f"/v1/jobs/{job_id}",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            self.assertEqual(status.status_code, 200, status.text)
            status_payload = status.json()
            if status_payload["state"] == "succeeded":
                break
            time.sleep(0.01)
        self.assertEqual(status_payload["state"], "succeeded")
        self.assertEqual(status_payload["uploadOffset"], len(self.wav))

        report_response = self.client.get(
            f"/v1/jobs/{job_id}/report",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        self.assertEqual(report_response.status_code, 200, report_response.text)
        report = report_response.json()
        self.assertTrue(report["advisoryOnly"])
        self.assertFalse(report["canBlockDelivery"])
        self.assertFalse(report["canChangeGainDb"])
        self.assertEqual(report["levelAuthority"], "gainPlanner")
        self.assertEqual(report["source"]["sha256"], hashlib.sha256(self.wav).hexdigest())

    def test_production_completion_returns_accepted_and_embedded_worker_finishes_report(self) -> None:
        app = self.create_app(
            {
                "storage_root": self.storage_root / "async-worker",
                "allowed_origins": [self.ORIGIN],
                "internal_secret": self.INTERNAL_SECRET,
                "ticket_secret": self.TICKET_SECRET,
                "ticket_ttl_seconds": 60,
                "max_audio_bytes": 1_000_000,
                "max_chunk_bytes": 1_024,
                "max_duration_seconds": 30.0,
                "clock": self.clock,
                "analyzer": FakeAnalyzer(),
                "inline_analysis": False,
                "worker_poll_seconds": 0.01,
                "lease_seconds": 1.0,
            }
        )
        metadata = self._metadata(idempotencyKey="async-worker-contract")
        with TestClient(app) as client:
            ticket_response = client.post(
                "/internal/v1/tickets",
                headers={"Authorization": f"Bearer {self.INTERNAL_SECRET}"},
                json={"ownerHash": "c" * 64, **metadata},
            )
            self.assertEqual(ticket_response.status_code, 200, ticket_response.text)
            created = client.post(
                "/v1/jobs",
                headers={"Authorization": f"Bearer {ticket_response.json()['ticket']}"},
                json=metadata,
            )
            self.assertEqual(created.status_code, 200, created.text)
            job = created.json()
            offset = 0
            while offset < len(self.wav):
                upload = client.patch(
                    f"/v1/jobs/{job['jobId']}/input",
                    headers={
                        "Authorization": f"Bearer {job['accessToken']}",
                        "Content-Type": "application/offset+octet-stream",
                        "Upload-Offset": str(offset),
                    },
                    content=self.wav[offset : offset + int(job["maxChunkBytes"])],
                )
                self.assertEqual(upload.status_code, 204, upload.text)
                offset = int(upload.headers["Upload-Offset"])
            complete = client.post(
                f"/v1/jobs/{job['jobId']}/input/complete",
                headers={"Authorization": f"Bearer {job['accessToken']}"},
                json={},
            )
            self.assertEqual(complete.status_code, 202, complete.text)

            status_payload: dict[str, object] = {}
            for _ in range(200):
                status = client.get(
                    f"/v1/jobs/{job['jobId']}",
                    headers={"Authorization": f"Bearer {job['accessToken']}"},
                )
                self.assertEqual(status.status_code, 200, status.text)
                status_payload = status.json()
                if status_payload["state"] == "succeeded":
                    break
                time.sleep(0.01)
            self.assertEqual(status_payload["state"], "succeeded")
            report = client.get(
                f"/v1/jobs/{job['jobId']}/report",
                headers={"Authorization": f"Bearer {job['accessToken']}"},
            )
            self.assertEqual(report.status_code, 200, report.text)
            self.assertTrue(report.json()["advisoryOnly"])

    def test_wrong_offset_returns_current_offset_without_writing(self) -> None:
        job = self._job()
        response = self.client.patch(
            f"/v1/jobs/{job['jobId']}/input",
            headers={
                "Authorization": f"Bearer {job['accessToken']}",
                "Content-Type": "application/offset+octet-stream",
                "Upload-Offset": "5",
            },
            content=b"abc",
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.headers["Upload-Offset"], "0")

    def test_chunk_limit_is_enforced_without_advancing_offset(self) -> None:
        job = self._job()
        headers = {
            "Authorization": f"Bearer {job['accessToken']}",
            "Content-Type": "application/offset+octet-stream",
            "Upload-Offset": "0",
        }
        oversized = self.client.patch(
            f"/v1/jobs/{job['jobId']}/input",
            headers=headers,
            content=b"x" * 1_025,
        )
        self.assertEqual(oversized.status_code, 413)
        status = self.client.get(
            f"/v1/jobs/{job['jobId']}", headers={"Authorization": f"Bearer {job['accessToken']}"}
        )
        self.assertEqual(status.json()["uploadOffset"], 0)

    def test_job_tokens_are_owner_scoped_and_non_enumerating(self) -> None:
        first = self._job()
        second = self._job(
            ticket=self._ticket(owner_hash="b" * 64, metadata=self._metadata(idempotencyKey="source-contract-002")),
            metadata=self._metadata(idempotencyKey="source-contract-002"),
        )
        wrong_owner = self.client.get(
            f"/v1/jobs/{first['jobId']}",
            headers={"Authorization": f"Bearer {second['accessToken']}"},
        )
        missing = self.client.get(
            "/v1/jobs/job_01J00000000000000000000000",
            headers={"Authorization": f"Bearer {first['accessToken']}"},
        )
        self.assertEqual(wrong_owner.status_code, 404)
        self.assertEqual(missing.status_code, 404)

    def test_idempotent_retry_restores_offset_and_rotates_access_token_after_restart(self) -> None:
        metadata = self._metadata(idempotencyKey="durable-contract")
        first = self._job(ticket=self._ticket(metadata=metadata), metadata=metadata)
        partial = self.wav[:512]
        upload = self.client.patch(
            f"/v1/jobs/{first['jobId']}/input",
            headers={
                "Authorization": f"Bearer {first['accessToken']}",
                "Content-Type": "audio/wav",
                "Upload-Offset": "0",
            },
            content=partial,
        )
        self.assertEqual(upload.status_code, 204)
        old_token = str(first["accessToken"])
        self.client_context.__exit__(None, None, None)

        self.app = self._new_app()
        self.client_context = TestClient(self.app)
        self.client = self.client_context.__enter__()
        retried = self.client.post(
            "/v1/jobs",
            headers={"Authorization": f"Bearer {self._ticket(metadata=metadata)}"},
            json=metadata,
        )
        self.assertEqual(retried.status_code, 200, retried.text)
        payload = retried.json()
        self.assertEqual(payload["jobId"], first["jobId"])
        self.assertEqual(payload["uploadOffset"], len(partial))
        self.assertNotEqual(payload["accessToken"], old_token)
        old_access = self.client.get(
            f"/v1/jobs/{first['jobId']}", headers={"Authorization": f"Bearer {old_token}"}
        )
        self.assertEqual(old_access.status_code, 404)

    def test_invalid_wav_fails_completion_without_report(self) -> None:
        invalid = b"not a wav payload"
        metadata = self._metadata(sizeBytes=len(invalid), idempotencyKey="invalid-wav")
        job = self._job(ticket=self._ticket(metadata=metadata), metadata=metadata)
        upload = self.client.patch(
            f"/v1/jobs/{job['jobId']}/input",
            headers={
                "Authorization": f"Bearer {job['accessToken']}",
                "Content-Type": "application/offset+octet-stream",
                "Upload-Offset": "0",
            },
            content=invalid,
        )
        self.assertEqual(upload.status_code, 204)
        complete = self.client.post(
            f"/v1/jobs/{job['jobId']}/input/complete",
            headers={"Authorization": f"Bearer {job['accessToken']}"},
            json={},
        )
        self.assertEqual(complete.status_code, 422)
        status = self.client.get(
            f"/v1/jobs/{job['jobId']}", headers={"Authorization": f"Bearer {job['accessToken']}"}
        )
        self.assertEqual(status.json()["state"], "failed")
        report = self.client.get(
            f"/v1/jobs/{job['jobId']}/report", headers={"Authorization": f"Bearer {job['accessToken']}"}
        )
        self.assertEqual(report.status_code, 409)

    def test_cors_allows_only_the_configured_extreme_origin(self) -> None:
        allowed = self.client.get("/health", headers={"Origin": self.ORIGIN})
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(allowed.headers["Access-Control-Allow-Origin"], self.ORIGIN)
        self.assertEqual(allowed.headers["Access-Control-Allow-Credentials"], "true")
        denied = self.client.get("/health", headers={"Origin": "https://evil.example"})
        self.assertEqual(denied.status_code, 403)
        self.assertNotIn("Access-Control-Allow-Origin", denied.headers)

    def test_configured_rate_limit_fails_closed_without_leaking_credentials(self) -> None:
        app = self.create_app(
            {
                "storage_root": self.storage_root / "rate-limit",
                "allowed_origins": [self.ORIGIN],
                "internal_secret": self.INTERNAL_SECRET,
                "ticket_secret": self.TICKET_SECRET,
                "clock": self.clock,
                "rate_limit_requests": 2,
                "rate_limit_window_seconds": 60,
            }
        )
        with TestClient(app) as client:
            first = client.get("/health", headers={"Origin": self.ORIGIN})
            second = client.get("/health", headers={"Origin": self.ORIGIN})
            limited = client.get("/health", headers={"Origin": self.ORIGIN})

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(limited.status_code, 429)
        self.assertEqual(limited.headers["Access-Control-Allow-Origin"], self.ORIGIN)
        self.assertNotIn(self.INTERNAL_SECRET, limited.text)


if __name__ == "__main__":
    unittest.main()
