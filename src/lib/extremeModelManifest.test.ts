import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTREME_MODEL_MANIFEST,
  validateExtremeModelManifest,
} from "./extremeModelManifest.ts";

test("Extreme model manifest pins only permissive advisory models with checksums", () => {
  const result = validateExtremeModelManifest(EXTREME_MODEL_MANIFEST);

  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.equal(EXTREME_MODEL_MANIFEST.schemaVersion, 1);
  assert.equal(EXTREME_MODEL_MANIFEST.advisoryOnly, true);

  assert.deepEqual(
    EXTREME_MODEL_MANIFEST.models.map((model) => model.id).sort(),
    [
      "deepfilternet3-optional-repair",
      "dnsmos-p808-advisory",
      "dnsmos-sig-bak-ovrl-advisory",
      "sigmos-advisory",
      "silero-vad-protection",
      "utmos-advisory",
      "wespeaker-resnet34-identity",
    ],
  );

  for (const model of EXTREME_MODEL_MANIFEST.models) {
    assert.match(model.license, /^(Apache-2\.0|MIT)$/);
    assert.match(model.revision, /^[a-f0-9]{7,40}$|^v?\d+\.\d+\.\d+/i);
    assert.match(model.sha256, /^[a-f0-9]{64}$/i);
    assert.equal(model.decisionAuthority, "advisory");
  }
});

test("Extreme model manifest rejects missing provenance and non-commercial authority", () => {
  const result = validateExtremeModelManifest({
    schemaVersion: 1,
    advisoryOnly: true,
    generatedAt: "2026-08-24T00:00:00.000Z",
    models: [
      {
        id: "nisqa-forbidden",
        purpose: "quality",
        packageName: "nisqa",
        packageVersion: "1.0.0",
        sourceUrl: "https://example.invalid/nisqa",
        license: "CC BY-NC-SA 4.0",
        revision: "",
        sha256: "not-a-checksum",
        decisionAuthority: "gate",
      },
    ],
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /license/i);
  assert.match(result.errors.join("\n"), /checksum/i);
  assert.match(result.errors.join("\n"), /authority/i);
});
