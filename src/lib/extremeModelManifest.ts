export type ExtremeModelManifestEntry = Readonly<{
  id: "silero-vad" | "speechonnxmetrics" | "speakeronnx" | "deepfilternet";
  purpose: string;
  license: "MIT" | "Apache-2.0" | "MIT/Apache-2.0";
  defaultEnabled: boolean;
  shipsGenerativeAudio: boolean;
  levelAuthority: "advisory" | "protective";
  notes: readonly string[];
}>;

export const EXTREME_MODEL_MANIFEST: readonly ExtremeModelManifestEntry[] = Object.freeze([
  Object.freeze({
    id: "silero-vad",
    purpose: "Optional speech-probability evidence for preserving attached weak speech tails.",
    license: "MIT",
    defaultEnabled: false,
    shipsGenerativeAudio: false,
    levelAuthority: "protective",
    notes: Object.freeze([
      "Can only expand a protection mask around existing energy speech.",
      "Never creates broadband gain targets or rejects delivery.",
    ]),
  }),
  Object.freeze({
    id: "speechonnxmetrics",
    purpose: "Offline perceptual scoring for candidate comparison and monitoring.",
    license: "Apache-2.0",
    defaultEnabled: false,
    shipsGenerativeAudio: false,
    levelAuthority: "advisory",
    notes: Object.freeze([
      "DNSMOS, SIGMOS, UTMOS, and P.808 scores are advisory until exact WAV audition.",
      "Non-commercial NISQA weights are intentionally excluded.",
    ]),
  }),
  Object.freeze({
    id: "speakeronnx",
    purpose: "Offline speaker-identity drift check for candidate comparison.",
    license: "Apache-2.0",
    defaultEnabled: false,
    shipsGenerativeAudio: false,
    levelAuthority: "advisory",
    notes: Object.freeze([
      "Similarity deltas are diagnostics, not render accept/reject gates.",
    ]),
  }),
  Object.freeze({
    id: "deepfilternet",
    purpose: "Optional repair candidate for noisy inputs after legacy safety checks.",
    license: "MIT/Apache-2.0",
    defaultEnabled: false,
    shipsGenerativeAudio: false,
    levelAuthority: "advisory",
    notes: Object.freeze([
      "May propose a candidate but cannot replace the selected render without normal QC.",
      "Disabled by default to avoid changing clean-source output quality.",
    ]),
  }),
]);

export const assertExtremeModelManifestIsShippable = (
  manifest: readonly ExtremeModelManifestEntry[] = EXTREME_MODEL_MANIFEST,
) => {
  const disallowedIds = manifest
    .map((entry) => entry.id.toLowerCase())
    .filter((id) => id.includes("nisqa") || id.includes("ten-vad") || id.includes("ten_vad"));
  return Object.freeze({
    ok: disallowedIds.length === 0 &&
      manifest.every((entry) => !entry.defaultEnabled && !entry.shipsGenerativeAudio),
    disallowedIds: Object.freeze(disallowedIds),
  });
};
