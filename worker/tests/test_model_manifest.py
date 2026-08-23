from __future__ import annotations

import re
import unittest

from contract_support import require_symbols


class ModelManifestContractTests(unittest.TestCase):
    MODULE = "extreme_worker.model_manifest"

    def _manifest_contract(self):
        return require_symbols(
            self,
            self.MODULE,
            "MODEL_MANIFEST",
            "DEFAULT_ANALYSIS_MODELS",
            "validate_manifest",
        )

    def test_manifest_contains_every_first_release_component(self) -> None:
        manifest, _, _ = self._manifest_contract()
        components = {artifact.component for artifact in manifest.values()}
        self.assertEqual(
            components,
            {"silero_vad", "dnsmos", "dnsmos_p808", "sigmos", "utmos", "deepfilternet3"},
        )

    def test_every_shippable_artifact_matches_an_immutable_model_graph(self) -> None:
        manifest, _, _ = self._manifest_contract()
        self.assertGreater(len(manifest), 0)
        for model_id, artifact in manifest.items():
            with self.subTest(model_id=model_id):
                if not artifact.shippable:
                    continue
                self.assertRegex(artifact.revision, r"^[a-z0-9_.:-]+$")
                self.assertRegex(artifact.sha256, r"^[0-9a-f]{64}$")
                self.assertNotEqual(artifact.sha256, "0" * 64)
                self.assertNotRegex(artifact.sha256, re.compile(r"^([0-9a-f])\1{63}$"))
                self.assertNotRegex(
                    f"{artifact.version} {artifact.revision} {artifact.source_url}",
                    re.compile(r"(?:^|[/_-])(latest|main|master|head)(?:$|[/_.-])", re.I),
                )
                self.assertTrue(artifact.filename)
                self.assertTrue(
                    artifact.source_url.startswith("https://raw.githubusercontent.com/")
                    or artifact.source_url.startswith("https://huggingface.co/")
                )
                self.assertNotIn("example.", artifact.source_url)

    def test_manifest_is_immutable(self) -> None:
        manifest, _, _ = self._manifest_contract()
        with self.assertRaises(TypeError):
            manifest["unexpected"] = next(iter(manifest.values()))

    def test_default_set_is_analysis_only(self) -> None:
        manifest, defaults, _ = self._manifest_contract()
        self.assertEqual(set(defaults), {"silero-vad", "dnsmos", "dnsmos_p808", "sigmos"})
        for model_id in defaults:
            with self.subTest(model_id=model_id):
                artifact = manifest[model_id]
                self.assertTrue(artifact.enabled_by_default)
                self.assertEqual(artifact.role, "analysis")
        self.assertFalse(manifest["utmos"].enabled_by_default)
        self.assertEqual(manifest["utmos"].role, "analysis_optional")
        self.assertNotIn("speakeronnx_resnet34", manifest)

    def test_deepfilternet_is_present_but_disabled_by_default(self) -> None:
        manifest, defaults, _ = self._manifest_contract()
        candidates = [item for item in manifest.values() if item.component == "deepfilternet3"]
        self.assertEqual(len(candidates), 1)
        candidate = candidates[0]
        self.assertFalse(candidate.enabled_by_default)
        self.assertFalse(candidate.shippable)
        self.assertEqual(candidate.role, "deferred_license_review")
        self.assertEqual(candidate.license, "UNRESOLVED")
        self.assertEqual(candidate.sha256, "")
        self.assertNotIn(candidate.model_id, defaults)

    def test_nisqa_and_noncommercial_assets_are_not_shippable(self) -> None:
        manifest, defaults, _ = self._manifest_contract()
        rendered = repr((manifest, defaults)).lower()
        self.assertNotIn("nisqa", rendered)
        self.assertNotIn("noncommercial", rendered)
        self.assertNotIn("non-commercial", rendered)
        self.assertNotIn("cc-by-nc", rendered)
        self.assertNotIn("cc by-nc", rendered)

    def test_default_ids_are_unique_and_resolve(self) -> None:
        manifest, defaults, _ = self._manifest_contract()
        self.assertEqual(len(defaults), len(set(defaults)))
        self.assertTrue(set(defaults).issubset(manifest.keys()))

    def test_manifest_self_validation_has_no_errors(self) -> None:
        manifest, _, validate_manifest = self._manifest_contract()
        self.assertEqual(tuple(validate_manifest(manifest)), ())


if __name__ == "__main__":
    unittest.main()
