export type ExtremeModelManifestEntry = Readonly<{
  id: "silero-vad" | "dnsmos" | "dnsmos-p808" | "sigmos" | "utmos" | "deepfilternet";
  purpose: string;
  license: "MIT" | "UNRESOLVED";
  deployment: "bundled" | "optional-unbundled" | "deferred-license-review";
  version: string | null;
  revision: string | null;
  sha256: string | null;
  artifactFilename: string | null;
  sourceUrl: string;
  defaultEnabled: false;
  shipsGenerativeAudio: false;
  levelAuthority: "advisory" | "protective";
  notes: readonly string[];
}>;

const entry = (value: ExtremeModelManifestEntry): ExtremeModelManifestEntry =>
  Object.freeze({ ...value, notes: Object.freeze([...value.notes]) });

export const EXTREME_MODEL_MANIFEST: readonly ExtremeModelManifestEntry[] = Object.freeze([
  entry({
    id: "silero-vad",
    purpose: "Speech-probability evidence for preserving short weak speech attached to energy-owned runs.",
    license: "MIT",
    deployment: "bundled",
    version: "6.2.1",
    revision: "7e30209a3e901f9842f81b225f3e93d8199902b1",
    sha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
    artifactFilename: "silero_vad_v6.2.1.onnx",
    sourceUrl: "https://github.com/snakers4/silero-vad",
    defaultEnabled: false,
    shipsGenerativeAudio: false,
    levelAuthority: "protective",
    notes: [
      "Can only expand protection around existing energy speech.",
      "Never creates gain targets or rejects delivery.",
    ],
  }),
  entry({
    id: "dnsmos",
    purpose: "Advisory P.835 speech, background, and overall quality measurement.",
    license: "MIT",
    deployment: "bundled",
    version: "speechonnxmetrics-0.0.1",
    revision: "27691a53aa069b27be6ac957013d43b3c442da9d",
    sha256: "269fbebdb513aa23cddfbb593542ecc540284a91849ac50516870e1ac78f6edd",
    artifactFilename: "dnsmos_sig_bak_ovr.onnx",
    sourceUrl: "https://huggingface.co/TigreGotico/dnsmos-onnx",
    defaultEnabled: false,
    shipsGenerativeAudio: false,
    levelAuthority: "advisory",
    notes: ["Scores are diagnostics until exact delivered WAVs are level-matched and auditioned."],
  }),
  entry({
    id: "dnsmos-p808",
    purpose: "Advisory P.808 overall-quality measurement.",
    license: "MIT",
    deployment: "bundled",
    version: "speechonnxmetrics-0.0.1",
    revision: "27691a53aa069b27be6ac957013d43b3c442da9d",
    sha256: "9246480c58567bc6affd4200938e77eef49468c8bc7ed3776d109c07456f6e91",
    artifactFilename: "dnsmos_p808_model_v8.onnx",
    sourceUrl: "https://huggingface.co/TigreGotico/dnsmos-onnx",
    defaultEnabled: false,
    shipsGenerativeAudio: false,
    levelAuthority: "advisory",
    notes: ["Cannot block delivery or select a render."],
  }),
  entry({
    id: "sigmos",
    purpose: "Advisory P.804 coloration, discontinuity, loudness, noise, reverb, signal, and overall scores.",
    license: "MIT",
    deployment: "bundled",
    version: "speechonnxmetrics-0.0.1",
    revision: "33ccd4fca5b8ffe03828530753f0b35769b8e880",
    sha256: "f939dcc1945055a435565b4369e27dafd0f87df3cea4e2ff6eb81225e52cc53b",
    artifactFilename: "sigmos_p804.onnx",
    sourceUrl: "https://huggingface.co/TigreGotico/sigmos-onnx",
    defaultEnabled: false,
    shipsGenerativeAudio: false,
    levelAuthority: "advisory",
    notes: ["Directional model scores do not establish naturalness."],
  }),
  entry({
    id: "utmos",
    purpose: "Optional advisory naturalness score.",
    license: "MIT",
    deployment: "optional-unbundled",
    version: "speechonnxmetrics-0.0.1",
    revision: "ff41b8f440cb12ecda18261f9ff7326d058275ce",
    sha256: "ece7ddb0999d0f12ffe8d7586b3618b8b6fa89269b5152288e4440d686409f69",
    artifactFilename: "utmos22_strong.onnx",
    sourceUrl: "https://huggingface.co/TigreGotico/utmos-onnx",
    defaultEnabled: false,
    shipsGenerativeAudio: false,
    levelAuthority: "advisory",
    notes: ["Not bundled in the first CPU image; unavailable telemetry is expected."],
  }),
  entry({
    id: "deepfilternet",
    purpose: "Potential separate repair candidate for a later, independently validated experiment.",
    license: "UNRESOLVED",
    deployment: "deferred-license-review",
    version: null,
    revision: null,
    sha256: null,
    artifactFilename: null,
    sourceUrl: "https://github.com/Rikorose/DeepFilterNet/issues/700",
    defaultEnabled: false,
    shipsGenerativeAudio: false,
    levelAuthority: "advisory",
    notes: [
      "Excluded from this release because pretrained weight redistribution licensing is unresolved upstream.",
      "A future repair candidate must remain separate and cannot replace a valid deterministic render automatically.",
    ],
  }),
]);

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

export const assertExtremeModelManifestIsShippable = (
  manifest: readonly ExtremeModelManifestEntry[] = EXTREME_MODEL_MANIFEST,
) => {
  const disallowedIds = manifest
    .map((item) => item.id.toLowerCase())
    .filter((id) => id.includes("nisqa") || id.includes("ten-vad") || id.includes("ten_vad"));
  const invalidEntries = manifest.filter((item) => {
    if (item.defaultEnabled || item.shipsGenerativeAudio) return true;
    if (item.deployment === "deferred-license-review") {
      return item.license !== "UNRESOLVED" || item.revision !== null || item.sha256 !== null;
    }
    return item.license !== "MIT" || !item.revision || !HEX_40.test(item.revision) ||
      !item.sha256 || !HEX_64.test(item.sha256) || !item.artifactFilename;
  });
  return Object.freeze({
    ok: disallowedIds.length === 0 && invalidEntries.length === 0,
    disallowedIds: Object.freeze(disallowedIds),
    invalidEntries: Object.freeze(invalidEntries.map((item) => item.id)),
  });
};
