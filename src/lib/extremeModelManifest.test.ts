import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTREME_MODEL_MANIFEST,
  assertExtremeModelManifestIsShippable,
} from "./extremeModelManifest.ts";

test("Extreme model manifest excludes restricted weights and defaults models off", () => {
  const verdict = assertExtremeModelManifestIsShippable();

  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.disallowedIds, []);
  assert.equal(EXTREME_MODEL_MANIFEST.some((entry) => entry.id === "silero-vad"), true);
  assert.equal(EXTREME_MODEL_MANIFEST.some((entry) => entry.id === "speechonnxmetrics"), true);
  assert.equal(EXTREME_MODEL_MANIFEST.every((entry) => entry.defaultEnabled === false), true);
  assert.equal(EXTREME_MODEL_MANIFEST.every((entry) => entry.shipsGenerativeAudio === false), true);
});

test("Extreme model manifest keeps ML out of gain authority", () => {
  assert.equal(
    EXTREME_MODEL_MANIFEST.every(
      (entry) => entry.levelAuthority === "advisory" || entry.levelAuthority === "protective",
    ),
    true,
  );
  assert.equal(
    EXTREME_MODEL_MANIFEST.some((entry) => entry.notes.join(" ").match(/rejects delivery|accept\/reject/)),
    true,
  );
});
