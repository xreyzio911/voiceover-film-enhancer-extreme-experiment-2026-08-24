from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from contract_support import require_symbols


class SafePathContractTests(unittest.TestCase):
    MODULE = "extreme_worker.paths"
    VALID_JOB_ID = "job_01J00000000000000000000000"

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name) / "state"
        self.root.mkdir()
        (
            self.resolve_under,
            self.validate_job_id,
            self.JobPaths,
            self.PathViolation,
        ) = require_symbols(
            self,
            self.MODULE,
            "resolve_under",
            "validate_job_id",
            "JobPaths",
            "PathViolation",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_valid_relative_path_resolves_inside_exact_root(self) -> None:
        resolved = self.resolve_under(self.root, "jobs", self.VALID_JOB_ID, "source.wav")
        self.assertTrue(resolved.is_absolute())
        self.assertEqual(os.path.commonpath((self.root.resolve(), resolved)), str(self.root.resolve()))

    def test_parent_traversal_is_rejected(self) -> None:
        for segment in ("..", "../escape", "..\\escape"):
            with self.subTest(segment=segment), self.assertRaises(self.PathViolation):
                self.resolve_under(self.root, segment)

    def test_absolute_and_drive_qualified_paths_are_rejected(self) -> None:
        candidates = (Path(self.root.anchor) / "outside.wav", "C:\\Windows\\outside.wav", "\\\\server\\share\\x")
        for candidate in candidates:
            with self.subTest(candidate=str(candidate)), self.assertRaises(self.PathViolation):
                self.resolve_under(self.root, candidate)

    def test_nul_and_empty_components_are_rejected(self) -> None:
        for segment in ("", ".", "bad\x00name"):
            with self.subTest(segment=repr(segment)), self.assertRaises(self.PathViolation):
                self.resolve_under(self.root, segment)

    def test_symlink_escape_is_rejected(self) -> None:
        outside = Path(self.temp_dir.name) / "outside"
        outside.mkdir()
        link = self.root / "link"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"symlink creation unavailable: {exc}")
        with self.assertRaises(self.PathViolation):
            self.resolve_under(self.root, "link", "escaped.wav")

    def test_job_id_validation_rejects_path_syntax_and_unbounded_ids(self) -> None:
        self.assertEqual(self.validate_job_id(self.VALID_JOB_ID), self.VALID_JOB_ID)
        for job_id in ("../job", "job/child", "job\\child", "C:job", "x" * 200, "", "job email@example.com"):
            with self.subTest(job_id=job_id), self.assertRaises(self.PathViolation):
                self.validate_job_id(job_id)

    def test_job_artifacts_use_fixed_internal_names_not_raw_filename(self) -> None:
        paths = self.JobPaths(self.root).for_job(self.VALID_JOB_ID)
        self.assertEqual(paths.directory.parent, self.root.resolve())
        self.assertEqual(paths.upload_part.name, "source.upload.part")
        self.assertEqual(paths.source_wav.name, "source.wav")
        self.assertEqual(paths.report_json.name, "report.json")
        rendered = " ".join(str(value) for value in (paths.upload_part, paths.source_wav, paths.report_json))
        self.assertNotIn("raw", rendered.lower())
        self.assertNotIn("filename", rendered.lower())


if __name__ == "__main__":
    unittest.main()
