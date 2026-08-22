import assert from "node:assert/strict";
import test from "node:test";
import {
  hasSufficientBatchSpeechEvidence,
  planBatchSpeechAlignment,
  planDistributedSpeechEvidenceWindows,
  resolveBatchSpeechAlignmentLevelDb,
  summarizeBatchSpeechGroupEvidence,
  summarizeBatchSpeechLevelEvidence,
} from "./batchLoudnessAlign.ts";

test("batch speech alignment anchors to the median and clamps offsets", () => {
  const result = planBatchSpeechAlignment([
    { id: "quiet", speechLevelDb: -25.2 },
    { id: "anchor", speechLevelDb: -22.8 },
    { id: "loud", speechLevelDb: -20.2 },
  ]);

  assert.equal(result.anchorDb, -22.8);
  assert.deepEqual(
    result.plans.map((plan) => ({ id: plan.id, offsetDb: plan.offsetDb })),
    [
      { id: "quiet", offsetDb: 2 },
      { id: "anchor", offsetDb: 0 },
      { id: "loud", offsetDb: -2 },
    ],
  );
});

test("batch speech alignment no-ops single-file, missing, and in-threshold evidence", () => {
  assert.deepEqual(planBatchSpeechAlignment([{ id: "solo", speechLevelDb: -22.4 }]).plans, [
    { id: "solo", speechLevelDb: -22.4, alignmentLevelDb: -22.4, offsetDb: 0, shouldAlign: false },
  ]);

  const result = planBatchSpeechAlignment([
    { id: "a", speechLevelDb: -22.7 },
    { id: "b", speechLevelDb: -22.3 },
    { id: "missing", speechLevelDb: null },
  ]);

  assert.equal(result.anchorDb, -22.5);
  assert.ok(result.plans.every((plan) => !plan.shouldAlign));
  assert.deepEqual(result.plans.at(-1), {
    id: "missing",
    speechLevelDb: null,
    alignmentLevelDb: null,
    offsetDb: 0,
    shouldAlign: false,
  });
});

test("batch speech evidence stays full for short outputs and bounded for long outputs", () => {
  assert.deepEqual(planDistributedSpeechEvidenceWindows(180), [
    { startSec: 0, durationSec: 180 },
  ]);

  const windows = planDistributedSpeechEvidenceWindows(600);
  assert.equal(windows.length, 6);
  assert.deepEqual(windows[0], { startSec: 0, durationSec: 30 });
  assert.deepEqual(windows.at(-1), { startSec: 570, durationSec: 30 });
  assert.ok(windows.every((window) => window.durationSec <= 30));
  assert.ok(
    windows.reduce((total, window) => total + window.durationSec, 0) <= 180,
    "long-file batch evidence must keep a fixed decode budget",
  );
});

test("batch speech alignment can anchor to dialogue plateau evidence instead of expressive-heavy means", () => {
  const meanOnly = planBatchSpeechAlignment([
    { id: "dialogue-a", speechLevelDb: -22.9 },
    { id: "dialogue-b", speechLevelDb: -23.0 },
    { id: "expressive-a", speechLevelDb: -18.4 },
    { id: "expressive-b", speechLevelDb: -18.9 },
  ]);
  const plateauAware = planBatchSpeechAlignment([
    { id: "dialogue-a", speechLevelDb: -22.9, speechPlateauDb: -22.9, evidenceWeight: 1 },
    { id: "dialogue-b", speechLevelDb: -23.0, speechPlateauDb: -23.0, evidenceWeight: 1 },
    { id: "expressive-a", speechLevelDb: -18.4, speechPlateauDb: -22.8, evidenceWeight: 1 },
    { id: "expressive-b", speechLevelDb: -18.9, speechPlateauDb: -22.7, evidenceWeight: 1 },
  ]);

  assert.ok(
    (meanOnly.anchorDb ?? -Infinity) > -21,
    `mean speech energy should reproduce the expressive-density bias fixture, got ${meanOnly.anchorDb}`,
  );
  assert.ok(
    plateauAware.anchorDb !== null && Math.abs(plateauAware.anchorDb - -22.85) < 0.001,
    `plateau evidence should keep the batch anchor on ordinary dialogue, got ${plateauAware.anchorDb}`,
  );
  assert.deepEqual(
    plateauAware.plans.map((plan) => ({ id: plan.id, offsetDb: plan.offsetDb, shouldAlign: plan.shouldAlign })),
    [
      { id: "dialogue-a", offsetDb: 0, shouldAlign: false },
      { id: "dialogue-b", offsetDb: 0, shouldAlign: false },
      { id: "expressive-a", offsetDb: 0, shouldAlign: false },
      { id: "expressive-b", offsetDb: 0, shouldAlign: false },
    ],
    "expressive-heavy takes should not be attenuated when their dialogue plateau already matches the batch",
  );
});

test("batch speech alignment keeps two-file anchors continuous under tiny evidence-weight changes", () => {
  const slightlyHeavierQuiet = planBatchSpeechAlignment([
    {
      id: "loud",
      speechLevelDb: -20,
      speechPlateauDb: -20,
      plateauBlendAuthority: 1,
      anchorVoteWeight: 1,
    },
    {
      id: "quiet",
      speechLevelDb: -23,
      speechPlateauDb: -23,
      plateauBlendAuthority: 1,
      anchorVoteWeight: 1.01,
    },
  ]);
  const slightlyHeavierLoud = planBatchSpeechAlignment([
    {
      id: "loud",
      speechLevelDb: -20,
      speechPlateauDb: -20,
      plateauBlendAuthority: 1,
      anchorVoteWeight: 1.01,
    },
    {
      id: "quiet",
      speechLevelDb: -23,
      speechPlateauDb: -23,
      plateauBlendAuthority: 1,
      anchorVoteWeight: 1,
    },
  ]);

  assert.ok(
    slightlyHeavierQuiet.anchorDb !== null &&
      slightlyHeavierLoud.anchorDb !== null &&
      slightlyHeavierQuiet.anchorDb < -21.5 &&
      slightlyHeavierLoud.anchorDb > -21.5 &&
      Math.abs(slightlyHeavierQuiet.anchorDb - slightlyHeavierLoud.anchorDb) < 0.02,
    `a 1% vote-weight change should move the interpolated anchor continuously, got ${slightlyHeavierQuiet.anchorDb} / ${slightlyHeavierLoud.anchorDb}`,
  );
  assert.ok(
    slightlyHeavierQuiet.plans.every((plan) => Math.abs(plan.offsetDb) < 1.51),
    "a tiny vote-weight difference must not move one side onto the full +/-2 dB clamp",
  );
});

test("plateau blend authority is independent from anchor vote weight", () => {
  assert.equal(
    resolveBatchSpeechAlignmentLevelDb({
      speechLevelDb: -18,
      speechPlateauDb: -23,
      plateauBlendAuthority: 0,
      anchorVoteWeight: 2,
    }),
    -18,
    "strong anchor voting must not force the plateau lane into a file-level measurement",
  );
  assert.equal(
    resolveBatchSpeechAlignmentLevelDb({
      speechLevelDb: -18,
      speechPlateauDb: -23,
      plateauBlendAuthority: 1,
      anchorVoteWeight: 0.5,
    }),
    -23,
    "low anchor voting must not suppress trusted plateau evidence",
  );
});

test("short expressive clips gain plateau authority from explicit speech duration", () => {
  const oneSecond = summarizeBatchSpeechLevelEvidence([
    {
      speechLevelDb: -18,
      speechBodyPlateauDb: -23,
      speechFrameCount: 100,
      speechFrameMs: 10,
    },
  ]);
  const eightSeconds = summarizeBatchSpeechLevelEvidence([
    {
      speechLevelDb: -18,
      speechBodyPlateauDb: -23,
      speechFrameCount: 800,
      speechFrameMs: 10,
    },
  ]);
  const fifteenSeconds = summarizeBatchSpeechLevelEvidence([
    {
      speechLevelDb: -18,
      speechBodyPlateauDb: -23,
      speechFrameCount: 1_500,
      speechFrameMs: 10,
    },
  ]);

  assert.ok(oneSecond && eightSeconds && fifteenSeconds);
  assert.equal(oneSecond.speechDurationSec, 1);
  assert.equal(oneSecond.plateauBlendAuthority, 0);
  assert.ok(
    eightSeconds.plateauBlendAuthority > 0.49 &&
      eightSeconds.plateauBlendAuthority < 0.51,
    `8 s should sit near the middle of the continuous short-clip blend, got ${eightSeconds.plateauBlendAuthority}`,
  );
  assert.equal(fifteenSeconds.plateauBlendAuthority, 1);
  assert.equal(
    resolveBatchSpeechAlignmentLevelDb(fifteenSeconds),
    -23,
    "15 s of speech-body evidence should protect an expressive-heavy short clip from its power mean",
  );
  assert.equal(
    fifteenSeconds.anchorVoteWeight,
    0.5,
    "short-clip plateau trust and batch-anchor voting must remain separate authorities",
  );
});

test("batch speech duration is frame-size explicit instead of assuming 10 ms", () => {
  const tenMs = summarizeBatchSpeechLevelEvidence([
    {
      speechLevelDb: -22,
      speechBodyPlateauDb: -23,
      speechFrameCount: 2_000,
      speechFrameMs: 10,
    },
  ]);
  const twentyMs = summarizeBatchSpeechLevelEvidence([
    {
      speechLevelDb: -22,
      speechBodyPlateauDb: -23,
      speechFrameCount: 1_000,
      speechFrameMs: 20,
    },
  ]);

  assert.ok(tenMs && twentyMs);
  assert.equal(tenMs.speechDurationSec, 20);
  assert.equal(twentyMs.speechDurationSec, 20);
  assert.equal(tenMs.plateauBlendAuthority, twentyMs.plateauBlendAuthority);
  assert.equal(tenMs.anchorVoteWeight, twentyMs.anchorVoteWeight);
});

test("mixed legacy and explicit frame evidence fails open without mixing weight units", () => {
  const summary = summarizeBatchSpeechLevelEvidence([
    {
      speechLevelDb: -25,
      speechBodyPlateauDb: -20,
      speechFrameCount: 100,
      speechFrameMs: 10,
    },
    {
      speechLevelDb: -25,
      speechBodyPlateauDb: -30,
      speechFrameCount: 1_000,
    },
  ]);

  assert.ok(summary);
  assert.equal(summary.speechPlateauDb, -25);
  assert.equal(
    summary.speechDurationSec,
    0,
    "partial duration metadata must not be presented as complete evidence duration",
  );
  assert.equal(
    summary.plateauBlendAuthority,
    0,
    "mixed-unit legacy evidence should keep the established speech-power lane",
  );
});

test("batch speech evidence summary exposes a conservative dialogue plateau when expressive windows run hot", () => {
  const summary = summarizeBatchSpeechLevelEvidence([
    { speechLevelDb: -22.9, speechBodyPlateauDb: -22.9, speechFrameCount: 2_500, speechFrameMs: 10 },
    { speechLevelDb: -22.7, speechBodyPlateauDb: -22.7, speechFrameCount: 2_500, speechFrameMs: 10 },
    { speechLevelDb: -22.8, speechBodyPlateauDb: -22.8, speechFrameCount: 2_500, speechFrameMs: 10 },
    { speechLevelDb: -18.4, speechBodyPlateauDb: -22.8, speechFrameCount: 2_500, speechFrameMs: 10 },
    { speechLevelDb: -18.2, speechBodyPlateauDb: -22.7, speechFrameCount: 2_500, speechFrameMs: 10 },
    { speechLevelDb: -17.9, speechBodyPlateauDb: -22.9, speechFrameCount: 2_500, speechFrameMs: 10 },
  ]);
  const steady = summarizeBatchSpeechLevelEvidence([
    { speechLevelDb: -22.9, speechBodyPlateauDb: -22.9, speechFrameCount: 2_500, speechFrameMs: 10 },
    { speechLevelDb: -22.8, speechBodyPlateauDb: -22.8, speechFrameCount: 2_500, speechFrameMs: 10 },
    { speechLevelDb: -22.7, speechBodyPlateauDb: -22.7, speechFrameCount: 2_500, speechFrameMs: 10 },
    { speechLevelDb: -22.9, speechBodyPlateauDb: -22.9, speechFrameCount: 2_500, speechFrameMs: 10 },
    { speechLevelDb: -22.8, speechBodyPlateauDb: -22.8, speechFrameCount: 2_500, speechFrameMs: 10 },
    { speechLevelDb: -22.7, speechBodyPlateauDb: -22.7, speechFrameCount: 2_500, speechFrameMs: 10 },
  ]);

  assert.ok(summary);
  assert.ok(
    Math.abs(summary.speechLevelDb - -20.55) < 0.001,
    `median speech energy should still report the expressive-heavy file level, got ${summary?.speechLevelDb}`,
  );
  assert.ok(
    Math.abs(summary.speechPlateauDb - -22.8) < 0.001,
    `dialogue plateau should stay near ordinary speech windows, got ${summary?.speechPlateauDb}`,
  );
  assert.ok(summary.evidenceWeight > 1, "six usable windows should carry stronger evidence than the minimum");
  assert.ok(steady);
  assert.equal(
    steady.speechPlateauDb,
    steady.speechLevelDb,
    "steady dialogue should preserve the historical median rather than inventing a lower anchor",
  );
  assert.equal(summarizeBatchSpeechLevelEvidence([]), null);
});

test("dialogue plateau follows the dominant body evidence instead of quiet tail windows", () => {
  const summary = summarizeBatchSpeechLevelEvidence([
    { speechLevelDb: -28, speechBodyPlateauDb: -28, speechFrameCount: 600, speechFrameMs: 10 },
    { speechLevelDb: -25, speechBodyPlateauDb: -25, speechFrameCount: 700, speechFrameMs: 10 },
    { speechLevelDb: -18.2, speechBodyPlateauDb: -18.2, speechFrameCount: 2_000, speechFrameMs: 10 },
    { speechLevelDb: -18.1, speechBodyPlateauDb: -18.1, speechFrameCount: 2_000, speechFrameMs: 10 },
    { speechLevelDb: -18.0, speechBodyPlateauDb: -18.0, speechFrameCount: 2_000, speechFrameMs: 10 },
    { speechLevelDb: -17.9, speechBodyPlateauDb: -17.9, speechFrameCount: 2_000, speechFrameMs: 10 },
  ]);

  assert.ok(summary);
  assert.ok(
    summary.speechPlateauDb > -18.3 && summary.speechPlateauDb < -17.8,
    `a few quiet tails must not pull genuinely loud dialogue down, got ${summary?.speechPlateauDb}`,
  );
});

test("multipart group aggregation weights a short quiet tail below long dialogue parts", () => {
  const parts = [
    summarizeBatchSpeechLevelEvidence([
      { speechLevelDb: -27, speechBodyPlateauDb: -27, speechFrameCount: 400, speechFrameMs: 10 },
    ]),
    summarizeBatchSpeechLevelEvidence([
      { speechLevelDb: -18.2, speechBodyPlateauDb: -18.2, speechFrameCount: 8_000, speechFrameMs: 10 },
    ]),
    summarizeBatchSpeechLevelEvidence([
      { speechLevelDb: -18, speechBodyPlateauDb: -18, speechFrameCount: 8_000, speechFrameMs: 10 },
    ]),
  ];
  assert.ok(parts.every((part) => part !== null));
  const group = summarizeBatchSpeechGroupEvidence(
    parts.filter((part): part is NonNullable<typeof part> => part !== null),
  );

  assert.ok(group);
  assert.ok(
    group.speechPlateauDb > -18.3 && group.speechPlateauDb < -17.9,
    `a short quiet part must not carry the same group authority as long dialogue, got ${group?.speechPlateauDb}`,
  );
  assert.equal(group.speechFrameCount, 16_400);
  assert.equal(group.speechDurationSec, 164);
});

test("multipart aggregation fails open when only some parts carry duration metadata", () => {
  const explicitPart = summarizeBatchSpeechLevelEvidence([
    {
      speechLevelDb: -20,
      speechBodyPlateauDb: -20,
      speechFrameCount: 2_000,
      speechFrameMs: 10,
    },
  ]);
  assert.ok(explicitPart);
  const legacyPart = {
    speechLevelDb: -30,
    speechPlateauDb: -30,
    evidenceWeight: 0.5,
    speechFrameCount: 10_000,
  } as NonNullable<typeof explicitPart>;
  const group = summarizeBatchSpeechGroupEvidence([explicitPart, legacyPart]);

  assert.ok(group);
  assert.equal(group.speechLevelDb, -25);
  assert.equal(group.speechPlateauDb, -25);
  assert.equal(
    group.speechDurationSec,
    0,
    "partial multipart duration metadata must not masquerade as complete group duration",
  );
  assert.equal(
    group.plateauBlendAuthority,
    0,
    "partial multipart duration metadata must not retain plateau authority from incompatible summaries",
  );
});

test("low-confidence batch plateau evidence blends back to measured speech energy", () => {
  const lowConfidence = planBatchSpeechAlignment([
    { id: "dialogue", speechLevelDb: -23, speechPlateauDb: -23, evidenceWeight: 0.5 },
    { id: "thin-expressive", speechLevelDb: -18, speechPlateauDb: -23, evidenceWeight: 0.5 },
  ]);
  const usableConfidence = planBatchSpeechAlignment([
    { id: "dialogue", speechLevelDb: -23, speechPlateauDb: -23, evidenceWeight: 1 },
    { id: "expressive", speechLevelDb: -18, speechPlateauDb: -23, evidenceWeight: 1 },
  ]);

  assert.ok(
    lowConfidence.anchorDb !== null && lowConfidence.anchorDb > -21,
    `thin plateau hints should preserve the historical median-like anchor, got ${lowConfidence.anchorDb}`,
  );
  assert.ok(
    usableConfidence.anchorDb !== null && Math.abs(usableConfidence.anchorDb - -23) < 0.001,
    `usable plateau evidence should still anchor to ordinary dialogue, got ${usableConfidence.anchorDb}`,
  );
});

test("very long batch speech evidence grows duration-proportionally without overlapping", () => {
  const windows = planDistributedSpeechEvidenceWindows(1_828.7);

  assert.equal(windows.length, 24);
  assert.ok(windows.every((window) => window.durationSec === 15));
  assert.deepEqual(windows[0], { startSec: 0, durationSec: 15 });
  assert.deepEqual(windows.at(-1), { startSec: 1_813.7, durationSec: 15 });
  assert.ok(
    windows.every((window, index) => (
      index === 0 || window.startSec >= windows[index - 1].startSec + windows[index - 1].durationSec
    )),
    "distributed evidence windows must be deterministic and non-overlapping",
  );
  assert.equal(
    windows.reduce((total, window) => total + window.durationSec, 0),
    360,
    "the 24-window cap must bound a very long file to six minutes of decoded evidence",
  );
});

test("duration-proportional evidence never reduces coverage at the medium-file boundary", () => {
  const boundaryWindows = planDistributedSpeechEvidenceWindows(720);
  assert.equal(boundaryWindows.length, 6);
  assert.ok(boundaryWindows.every((window) => window.durationSec === 30));
  assert.equal(
    boundaryWindows.reduce((total, window) => total + window.durationSec, 0),
    180,
  );

  const firstScaledDurationSec = 720.001;
  const scaledWindows = planDistributedSpeechEvidenceWindows(firstScaledDurationSec);
  assert.equal(scaledWindows.length, 13);
  assert.ok(scaledWindows.every((window) => window.durationSec === 15));
  assert.deepEqual(scaledWindows.at(-1), { startSec: 705.001, durationSec: 15 });
  assert.ok(
    scaledWindows.reduce((total, window) => total + window.durationSec, 0) >= 180,
  );
  assert.deepEqual(
    planDistributedSpeechEvidenceWindows(firstScaledDurationSec),
    scaledWindows,
    "the same duration must always produce the same distributed windows",
  );
});

test("batch speech evidence window planning fails soft on invalid durations", () => {
  assert.deepEqual(planDistributedSpeechEvidenceWindows(Number.NaN), []);
  assert.deepEqual(planDistributedSpeechEvidenceWindows(0), []);
  assert.deepEqual(planDistributedSpeechEvidenceWindows(-1), []);
});

test("batch speech evidence follows distributed speech instead of a blind time grid", () => {
  const durationSec = 900;
  const speechSpans = [
    { startSec: 36, endSec: 52 },
    { startSec: 176, endSec: 194 },
    { startSec: 326, endSec: 342 },
    { startSec: 476, endSec: 494 },
    { startSec: 626, endSec: 642 },
    { startSec: 776, endSec: 794 },
  ];

  const windows = planDistributedSpeechEvidenceWindows(durationSec, speechSpans);
  const overlapSeconds = (
    window: { startSec: number; durationSec: number },
    span: { startSec: number; endSec: number },
  ) => Math.max(
    0,
    Math.min(window.startSec + window.durationSec, span.endSec) - Math.max(window.startSec, span.startSec),
  );

  assert.ok(windows.length >= 4, "distributed long-form evidence needs at least four speech-bearing samples");
  assert.ok(windows.every((window) => window.durationSec === 30), "speech-aware evidence should prefer 30 s windows");
  assert.ok(
    windows.every((window) => speechSpans.some((span) => overlapSeconds(window, span) >= 8)),
    "every selected window should contain substantial known speech",
  );
  assert.ok(
    windows.reduce((total, window) => total + window.durationSec, 0) <= 360,
    "occupancy-ranked evidence must retain the six-minute decode ceiling",
  );
});

test("batch alignment requires four usable samples unless one window covers the full file", () => {
  assert.equal(
    hasSufficientBatchSpeechEvidence([{ startSec: 0, durationSec: 120 }], 1, 120),
    true,
  );
  assert.equal(
    hasSufficientBatchSpeechEvidence(
      [
        { startSec: 0, durationSec: 30 },
        { startSec: 120, durationSec: 30 },
        { startSec: 240, durationSec: 30 },
        { startSec: 360, durationSec: 30 },
      ],
      3,
      600,
    ),
    false,
  );
  assert.equal(
    hasSufficientBatchSpeechEvidence(
      [
        { startSec: 0, durationSec: 30 },
        { startSec: 120, durationSec: 30 },
        { startSec: 240, durationSec: 30 },
        { startSec: 360, durationSec: 30 },
      ],
      4,
      600,
    ),
    true,
  );
});

test("speech-aware evidence keeps the six-minute decode ceiling on dense very long speech", () => {
  const durationSec = 3_600;
  const windows = planDistributedSpeechEvidenceWindows(
    durationSec,
    [{ startSec: 0, endSec: durationSec }],
  );

  assert.equal(windows.length, 12);
  assert.ok(windows.every((window) => window.durationSec === 30));
  assert.equal(
    windows.reduce((total, window) => total + window.durationSec, 0),
    360,
  );
});
