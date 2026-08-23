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
  assert.deepEqual(
    EXTREME_MODEL_MANIFEST.map((entry) => entry.id),
    ["silero-vad", "dnsmos", "dnsmos-p808", "sigmos", "utmos", "deepfilternet"],
  );
  assert.equal(EXTREME_MODEL_MANIFEST.every((entry) => entry.defaultEnabled === false), true);
  assert.equal(EXTREME_MODEL_MANIFEST.every((entry) => entry.shipsGenerativeAudio === false), true);
});

test("bundled model graphs have the exact deployed immutable revisions and checksums", () => {
  const bundled = EXTREME_MODEL_MANIFEST.filter((entry) => entry.deployment === "bundled");
  assert.deepEqual(
    bundled.map(({ id, revision, sha256 }) => ({ id, revision, sha256 })),
    [
      {
        id: "silero-vad",
        revision: "7e30209a3e901f9842f81b225f3e93d8199902b1",
        sha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
      },
      {
        id: "dnsmos",
        revision: "27691a53aa069b27be6ac957013d43b3c442da9d",
        sha256: "269fbebdb513aa23cddfbb593542ecc540284a91849ac50516870e1ac78f6edd",
      },
      {
        id: "dnsmos-p808",
        revision: "27691a53aa069b27be6ac957013d43b3c442da9d",
        sha256: "9246480c58567bc6affd4200938e77eef49468c8bc7ed3776d109c07456f6e91",
      },
      {
        id: "sigmos",
        revision: "33ccd4fca5b8ffe03828530753f0b35769b8e880",
        sha256: "f939dcc1945055a435565b4369e27dafd0f87df3cea4e2ff6eb81225e52cc53b",
      },
    ],
  );
});

test("unbundled models cannot be mistaken for shipped capability", () => {
  const utmos = EXTREME_MODEL_MANIFEST.find((entry) => entry.id === "utmos");
  const deepFilter = EXTREME_MODEL_MANIFEST.find((entry) => entry.id === "deepfilternet");
  assert.equal(utmos?.deployment, "optional-unbundled");
  assert.equal(deepFilter?.deployment, "deferred-license-review");
  assert.equal(deepFilter?.revision, null);
  assert.equal(deepFilter?.sha256, null);
  assert.match(deepFilter?.notes.join(" ") ?? "", /pretrained weight.*licen/i);
  assert.equal(EXTREME_MODEL_MANIFEST.some((entry) => entry.id.includes("speaker")), false);
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
