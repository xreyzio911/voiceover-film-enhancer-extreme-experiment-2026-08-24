from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest

from fastapi.testclient import TestClient

from contract_support import MutableClock, require_symbols


class WorkerContractTests(unittest.TestCase):
    def test_capabilities_expose_no_gain_authority(self) -> None:
        (build_capabilities,) = require_symbols(self, "extreme_worker.capabilities", "build_capabilities")

        capabilities = build_capabilities()

        self.assertTrue(capabilities["advisoryOnly"])
        self.assertFalse(capabilities["canBlockDelivery"])
        self.assertFalse(capabilities["canChangeGainDb"])
        self.assertEqual(capabilities["levelAuthority"], "gainPlanner")
        self.assertEqual(capabilities["supports"], ["vad_protection", "quality_metrics"])
        self.assertNotIn("optional_repair_candidate", capabilities["supports"])

    def test_upload_ticket_is_short_lived_and_bound_to_job(self) -> None:
        create_upload_ticket, verify_upload_ticket = require_symbols(
            self,
            "extreme_worker.security",
            "create_upload_ticket",
            "verify_upload_ticket",
        )
        clock = MutableClock()
        secret = b"test-secret".ljust(32, b"_")

        ticket = create_upload_ticket(
            secret=secret,
            job_id="job_1",
            file_sha256="a" * 64,
            expires_in_seconds=30,
            now=clock,
        )

        self.assertTrue(verify_upload_ticket(secret=secret, ticket=ticket, job_id="job_1", file_sha256="a" * 64, now=clock))
        self.assertFalse(verify_upload_ticket(secret=secret, ticket=ticket, job_id="job_2", file_sha256="a" * 64, now=clock))
        clock.advance(31)
        self.assertFalse(verify_upload_ticket(secret=secret, ticket=ticket, job_id="job_1", file_sha256="a" * 64, now=clock))

    def test_job_store_is_durable_and_tracks_cancel(self) -> None:
        JobStore, = require_symbols(self, "extreme_worker.job_store", "JobStore")
        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = os.path.join(temp_dir, "jobs.sqlite3")
            first = JobStore(db_path)
            job = first.create_job(owner_id="owner_1", source_name="voice.wav")
            first.mark_running(job["id"])
            first.request_cancel(job["id"], owner_id="owner_1")

            second = JobStore(db_path)
            try:
                restored = second.get_job(job["id"], owner_id="owner_1")
            finally:
                second.close()

        self.assertEqual(restored["state"], "cancel_requested")
        self.assertEqual(restored["sourceName"], "voice.wav")

    def test_artifact_paths_stay_inside_job_root(self) -> None:
        resolve_job_artifact_path, = require_symbols(
            self,
            "extreme_worker.paths",
            "resolve_job_artifact_path",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            safe = resolve_job_artifact_path(temp_dir, "job_01JEXTREME000000000000001", "analysis.json")
            self.assertTrue(safe.startswith(os.path.realpath(temp_dir)))
            with self.assertRaises(ValueError):
                resolve_job_artifact_path(temp_dir, "job_1", "../secret.wav")

    def test_wav_validation_accepts_only_bounded_pcm_wav(self) -> None:
        validate_wav_upload = require_symbols(
            self,
            "extreme_worker.wav_validation",
            "validate_wav_upload",
        )[0]
        wav = (
            b"RIFF"
            + (36).to_bytes(4, "little")
            + b"WAVEfmt "
            + (16).to_bytes(4, "little")
            + (1).to_bytes(2, "little")
            + (1).to_bytes(2, "little")
            + (48000).to_bytes(4, "little")
            + (192000).to_bytes(4, "little")
            + (4).to_bytes(2, "little")
            + (32).to_bytes(2, "little")
            + b"data"
            + (0).to_bytes(4, "little")
        )

        accepted = validate_wav_upload(wav, max_bytes=1024, max_duration_seconds=60)
        rejected = validate_wav_upload(b"not wav", max_bytes=1024, max_duration_seconds=60)

        self.assertTrue(accepted.ok)
        self.assertFalse(rejected.ok)

    def test_origin_policy_never_wildcards_credentials(self) -> None:
        build_cors_headers, = require_symbols(self, "extreme_worker.origin_policy", "build_cors_headers")

        allowed = build_cors_headers("https://extreme.example", ["https://extreme.example"])
        denied = build_cors_headers("https://evil.example", ["https://extreme.example"])

        self.assertEqual(allowed["Access-Control-Allow-Origin"], "https://extreme.example")
        self.assertEqual(allowed["Access-Control-Allow-Credentials"], "true")
        self.assertEqual(allowed["Access-Control-Expose-Headers"], "Upload-Offset")
        self.assertNotIn("Access-Control-Allow-Origin", denied)

    def test_report_schema_is_advisory_and_bounded(self) -> None:
        build_report, = require_symbols(self, "extreme_worker.report_schema", "build_report")

        report = build_report(
            job_id="job_1",
            source_sha256="a" * 64,
            result_sha256="b" * 64,
            metrics={"dnsmos.ovrl": 3.8, "speaker.cosine": 0.92},
            findings=[{"code": "ok", "severity": "info", "message": "measured"}],
        )

        self.assertTrue(report["advisoryOnly"])
        self.assertFalse(report["canBlockDelivery"])
        self.assertEqual(report["deliveryGate"], "never")

    def test_fastapi_health_and_capabilities(self) -> None:
        (create_app,) = require_symbols(self, "extreme_worker.app", "create_app")
        with tempfile.TemporaryDirectory() as temp_dir:
            app = create_app({"storage_root": temp_dir, "allowed_origins": ["https://extreme.example"]})
            client = TestClient(app)

            health = client.get("/health")
            capabilities = client.get("/capabilities")

        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["status"], "ok")
        self.assertEqual(capabilities.status_code, 200)
        self.assertTrue(capabilities.json()["advisoryOnly"])


if __name__ == "__main__":
    unittest.main()
