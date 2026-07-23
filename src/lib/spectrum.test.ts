import assert from "node:assert/strict";
import test from "node:test";
import {
  CINEMATIC_VO_REFERENCE_DB,
  DEFAULT_MAX_EVENT_SIBILANCE_FRAMES,
  HOUSE_TONE_BLEND,
  computeEventSibilanceAuthority,
  computeLogBandSpectrumDb,
  computeSibilanceScore,
  computeToneMatchDeltaDb,
  deriveSpectrumTiltsDb,
  resolveDeEsserCutsDb,
  resolveDeEsserBands,
  resolveEventSibilanceFrameIndices,
  resolveSpectrumFrameBudget,
} from "./spectrum.ts";

const buildTone = (
  sampleRate: number,
  durationSec: number,
  sections: Array<{ startSec: number; endSec: number; hz: number; amplitude: number }>,
) => {
  const samples = new Float32Array(Math.round(sampleRate * durationSec));
  for (const section of sections) {
    const start = Math.max(0, Math.round(section.startSec * sampleRate));
    const end = Math.min(samples.length, Math.round(section.endSec * sampleRate));
    for (let index = start; index < end; index += 1) {
      samples[index] += section.amplitude * Math.sin((2 * Math.PI * section.hz * index) / sampleRate);
    }
  }
  return samples;
};

const buildFramedSpeech = (
  sampleRate: number,
  frameCount: number,
  eventFrames: readonly number[],
  eventAmplitude: number,
) => {
  const frameSize = Math.round(sampleRate * 0.02);
  const samples = new Float32Array(frameSize * frameCount);
  const eventFrameSet = new Set(eventFrames);
  for (let index = 0; index < samples.length; index += 1) {
    const frameIndex = Math.floor(index / frameSize);
    const body =
      0.14 * Math.sin((2 * Math.PI * 1030 * index) / sampleRate) +
      0.12 * Math.sin((2 * Math.PI * 2060 * index) / sampleRate);
    const event = eventFrameSet.has(frameIndex)
      ? eventAmplitude *
        (Math.sin((2 * Math.PI * 4118 * index) / sampleRate) +
          Math.sin((2 * Math.PI * 8236 * index) / sampleRate))
      : 0;
    samples[index] = body + event;
  }
  return samples;
};

test("house-tone blend pulls an all-boomy batch toward cinematic VO shape", () => {
  const fileDb = [-14, -13, -14, -18, -24, -27, -31, -35];
  const boomyBatchReference = [-15, -14, -15, -18, -24, -28, -32, -36];
  const delta = computeToneMatchDeltaDb(fileDb, boomyBatchReference, {
    houseBlend: 0.35,
    houseReferenceDb: CINEMATIC_VO_REFERENCE_DB,
  });

  assert.ok(delta[0] < -1.2, `60 Hz should be pulled down, got ${delta[0].toFixed(2)} dB`);
  assert.ok(delta[1] < -0.6, `120 Hz should be controlled, got ${delta[1].toFixed(2)} dB`);
  assert.ok(delta[6] > 1.2, `4 kHz presence should be restored, got ${delta[6].toFixed(2)} dB`);
  assert.ok(Math.max(...delta.map(Math.abs)) <= 3);
});

test("tone-match priority bands can use the wider 3 dB cap while other bands stay at 2.5 dB", () => {
  const delta = computeToneMatchDeltaDb(
    [-8, -18, -18, -18, -18, -18, -32, -18],
    [-18, -18, -18, -18, -18, -18, -18, -18],
    { maxDb: 2.5, priorityMaxDb: 3, priorityBandCount: 2 },
  );

  assert.equal(delta[0], -3);
  assert.equal(delta[6], 3);
  assert.ok(delta.every((value, index) => index === 0 || index === 6 || Math.abs(value) <= 2.5));
});

test("adaptive de-esser placement follows measured sibilance center", () => {
  assert.deepEqual(resolveDeEsserBands([-40, -40, -35, -34, -32, -31, -22, -31]), {
    mainHz: 5800,
    secondaryHz: 8200,
  });
  assert.deepEqual(resolveDeEsserBands([-40, -40, -35, -34, -32, -31, -31, -21]), {
    mainHz: 7200,
    secondaryHz: 9800,
  });
  assert.deepEqual(resolveDeEsserBands([-40, -40, -35, -34, -32, -31, -25, -24]), {
    mainHz: 6500,
    secondaryHz: 9000,
  });
});

test("de-esser depth grows continuously instead of jumping at the legacy 0.4 gate", () => {
  const justBelow = resolveDeEsserCutsDb(0.3999);
  const atLegacyBoundary = resolveDeEsserCutsDb(0.4);
  const justAbove = resolveDeEsserCutsDb(0.4001);

  assert.ok(justBelow.mainCutDb < 0, "sub-boundary evidence should fade in instead of being hard-gated");
  assert.ok(atLegacyBoundary.mainCutDb > -1, "moderate evidence should not trigger the legacy -1.2 dB floor");
  assert.ok(Math.abs(atLegacyBoundary.mainCutDb - justBelow.mainCutDb) < 0.01);
  assert.ok(Math.abs(justAbove.mainCutDb - atLegacyBoundary.mainCutDb) < 0.01);
});

test("de-esser depth is subtle at weak evidence and bounded at strong evidence", () => {
  const assertCuts = (score: number, expectedMain: number, expectedSecondary: number) => {
    const cuts = resolveDeEsserCutsDb(score);
    assert.ok(Math.abs(cuts.mainCutDb - expectedMain) < 1e-12, `${score}: main ${cuts.mainCutDb}`);
    assert.ok(
      Math.abs(cuts.secondaryCutDb - expectedSecondary) < 1e-12,
      `${score}: secondary ${cuts.secondaryCutDb}`,
    );
  };

  assert.deepEqual(resolveDeEsserCutsDb(0), { mainCutDb: 0, secondaryCutDb: 0 });
  assertCuts(0.2, -0.16, -0.096);
  assertCuts(0.4, -0.64, -0.384);
  assertCuts(0.7, -1.96, -1.176);
  assert.deepEqual(resolveDeEsserCutsDb(1), { mainCutDb: -4, secondaryCutDb: -2.4 });
});

test("de-esser depth sanitizes invalid scores and remains monotonic within its caps", () => {
  assert.deepEqual(resolveDeEsserCutsDb(Number.NaN), { mainCutDb: 0, secondaryCutDb: 0 });
  assert.deepEqual(resolveDeEsserCutsDb(-2), { mainCutDb: 0, secondaryCutDb: 0 });
  assert.deepEqual(resolveDeEsserCutsDb(3), { mainCutDb: -4, secondaryCutDb: -2.4 });

  const cuts = [0, 0.1, 0.25, 0.4, 0.6, 0.8, 1].map(resolveDeEsserCutsDb);
  for (let index = 1; index < cuts.length; index += 1) {
    assert.ok(cuts[index].mainCutDb <= cuts[index - 1].mainCutDb);
    assert.ok(cuts[index].secondaryCutDb <= cuts[index - 1].secondaryCutDb);
  }
  assert.ok(cuts.every(({ mainCutDb }) => mainCutDb >= -4 && mainCutDb <= 0));
  assert.ok(cuts.every(({ secondaryCutDb }) => secondaryCutDb >= -2.4 && secondaryCutDb <= 0));
});

test("event sibilance authority ignores clean body speech and inactive or silent frames", () => {
  const sampleRate = 24000;
  const frameCount = 20;
  const activeMask = new Array<boolean>(frameCount).fill(true);
  const cleanBody = buildFramedSpeech(sampleRate, frameCount, [], 0);

  const cleanAuthority = computeEventSibilanceAuthority(cleanBody, sampleRate, {
    activityMask: activeMask,
    activityFrameMs: 20,
  });
  const inactiveAuthority = computeEventSibilanceAuthority(cleanBody, sampleRate, {
    activityMask: new Array<boolean>(frameCount).fill(false),
    activityFrameMs: 20,
  });
  const silentAuthority = computeEventSibilanceAuthority(new Float32Array(cleanBody.length), sampleRate, {
    activityMask: activeMask,
    activityFrameMs: 20,
  });

  assert.ok(cleanAuthority <= 0.01, `body-only speech should carry negligible event authority: ${cleanAuthority}`);
  assert.equal(inactiveAuthority, 0);
  assert.equal(silentAuthority, 0);
});

test("event sibilance authority cannot be poisoned by non-finite audio samples", () => {
  const sampleRate = 24000;
  const samples = buildFramedSpeech(sampleRate, 4, [1], 0.25);
  samples[Math.round(sampleRate * 0.025)] = Number.NaN;
  const authority = computeEventSibilanceAuthority(samples, sampleRate, {
    activityMask: new Array<boolean>(4).fill(true),
    activityFrameMs: 20,
  });

  assert.ok(Number.isFinite(authority), `authority must stay finite, got ${authority}`);
  assert.ok(authority >= 0 && authority <= 0.5);
});

test("event sibilance authority is continuous, density-sensitive, and conservatively bounded", () => {
  const sampleRate = 24000;
  const frameCount = 20;
  const activityMask = new Array<boolean>(frameCount).fill(true);
  const options = { activityMask, activityFrameMs: 20 } as const;
  const weakSparse = computeEventSibilanceAuthority(
    buildFramedSpeech(sampleRate, frameCount, [5], 0.12),
    sampleRate,
    options,
  );
  const strongSparse = computeEventSibilanceAuthority(
    buildFramedSpeech(sampleRate, frameCount, [5], 0.25),
    sampleRate,
    options,
  );
  const strongDense = computeEventSibilanceAuthority(
    buildFramedSpeech(sampleRate, frameCount, [1, 5, 9, 13, 17], 0.25),
    sampleRate,
    options,
  );
  const saturated = computeEventSibilanceAuthority(
    buildFramedSpeech(sampleRate, frameCount, Array.from({ length: frameCount }, (_, index) => index), 0.8),
    sampleRate,
    options,
  );

  assert.ok(weakSparse > 0, `a sparse weak fricative should retain nonzero evidence: ${weakSparse}`);
  assert.ok(strongSparse > weakSparse, `${strongSparse} should exceed weaker evidence ${weakSparse}`);
  assert.ok(strongDense > strongSparse, `${strongDense} should exceed sparser evidence ${strongSparse}`);
  assert.equal(saturated, 0.5);

  const maximumCuts = resolveDeEsserCutsDb(saturated);
  assert.equal(maximumCuts.mainCutDb, -1);
  assert.equal(maximumCuts.secondaryCutDb, -0.6);
});

test("event sibilance sampling is evenly distributed and capped by default", () => {
  const sampleRate = 24000;
  const frameCount = 500;
  const sampleCount = Math.round(sampleRate * 0.02) * frameCount;
  const activityMask = new Array<boolean>(frameCount).fill(true);
  const defaultSelection = resolveEventSibilanceFrameIndices(sampleCount, sampleRate, {
    activityMask,
    activityFrameMs: 20,
  });
  const narrowSelection = resolveEventSibilanceFrameIndices(sampleCount, sampleRate, {
    activityMask,
    activityFrameMs: 20,
    maxFrames: 7,
  });

  assert.equal(DEFAULT_MAX_EVENT_SIBILANCE_FRAMES, 240);
  assert.equal(defaultSelection.length, DEFAULT_MAX_EVENT_SIBILANCE_FRAMES);
  assert.deepEqual(narrowSelection, [0, 83, 166, 250, 333, 416, 499]);
});

test("production tone matching does not apply the unvalidated static house curve", () => {
  const fileDb = [-28, -24, -21, -20, -22, -23, -27, -31];
  const adaptiveBatchDb = [-27, -23, -20, -21, -22, -22, -25, -29];

  assert.equal(HOUSE_TONE_BLEND, 0);
  assert.deepEqual(
    computeToneMatchDeltaDb(fileDb, adaptiveBatchDb, { houseBlend: HOUSE_TONE_BLEND }),
    computeToneMatchDeltaDb(fileDb, adaptiveBatchDb, { houseBlend: 0 }),
  );
});

test("speech-spectrum tilts are level-invariant and follow the measured tonal region", () => {
  const neutral = deriveSpectrumTiltsDb(new Array<number>(8).fill(-40));
  const lowHeavy = deriveSpectrumTiltsDb([-20, -20, -22, -40, -40, -40, -40, -40]);
  const highHeavy = deriveSpectrumTiltsDb([-40, -40, -40, -40, -40, -40, -20, -20]);
  const shiftedLowHeavy = deriveSpectrumTiltsDb([-8, -8, -10, -28, -28, -28, -28, -28]);

  assert.deepEqual(neutral, { lowTiltDb: 0, highTiltDb: 0 });
  assert.ok((lowHeavy?.lowTiltDb ?? 0) > 14, `low-heavy spectrum should report positive low tilt: ${JSON.stringify(lowHeavy)}`);
  assert.ok((highHeavy?.highTiltDb ?? 0) > 16, `high-heavy spectrum should report positive high tilt: ${JSON.stringify(highHeavy)}`);
  assert.ok(Math.abs((shiftedLowHeavy?.lowTiltDb ?? 0) - (lowHeavy?.lowTiltDb ?? 0)) < 1e-9);
  assert.equal(deriveSpectrumTiltsDb([-40, -40, -40]), null);
});

test("activity-selected spectrum keeps de-esser placement tied to speech instead of room tone", () => {
  const sampleRate = 24000;
  const samples = buildTone(sampleRate, 1, [
    { startSec: 0, endSec: 0.8, hz: 1000, amplitude: 0.2 },
    { startSec: 0, endSec: 0.8, hz: 7250, amplitude: 0.3 },
    { startSec: 0.8, endSec: 1, hz: 1000, amplitude: 0.2 },
    { startSec: 0.8, endSec: 1, hz: 4120, amplitude: 0.3 },
    { startSec: 0.8, endSec: 1, hz: 7250, amplitude: 0.02 },
  ]);
  const activityMask = Array.from({ length: 100 }, (_, index) => index >= 80);
  const wholeSignal = computeLogBandSpectrumDb(samples, sampleRate);
  const speechOnly = computeLogBandSpectrumDb(samples, sampleRate, {
    activityMask,
    activityFrameMs: 10,
  });

  assert.equal(resolveDeEsserBands(wholeSignal).mainHz, 7200);
  assert.equal(resolveDeEsserBands(speechOnly).mainHz, 5800);
  assert.ok(computeSibilanceScore(speechOnly) >= 0.4, "synthetic sibilant speech should retain actionable evidence");
});

test("spectrum analysis caps long-file frame visits", () => {
  const sampleRate = 16000;
  const thirtyMinutes = sampleRate * 60 * 30;
  const budget = resolveSpectrumFrameBudget(thirtyMinutes, sampleRate, { maxFrames: 1600 });

  assert.ok(budget.totalFrames > 80000, `fixture should represent a long file, got ${budget.totalFrames} frames`);
  assert.ok(budget.frameStride > 1, `long files should stride frames, got stride ${budget.frameStride}`);
  assert.ok(budget.framesToVisit <= 1600, `frame visits should stay capped, got ${budget.framesToVisit}`);
});

test("optional activity mask keeps speech tone from being dominated by inactive room tone", () => {
  const sampleRate = 16000;
  const samples = buildTone(sampleRate, 1, [
    { startSec: 0, endSec: 0.8, hz: 120, amplitude: 0.35 },
    { startSec: 0.8, endSec: 1, hz: 2000, amplitude: 0.25 },
  ]);
  const activityMask = Array.from({ length: 100 }, (_, index) => index >= 80);

  const legacy = computeLogBandSpectrumDb(samples, sampleRate, {
    bands: [120, 2000],
    widthOct: 0.2,
  });
  const speechOnly = computeLogBandSpectrumDb(samples, sampleRate, {
    bands: [120, 2000],
    widthOct: 0.2,
    activityMask,
    activityFrameMs: 10,
  });

  assert.ok(legacy[0] > legacy[1], `room tone should dominate the legacy average: ${legacy.join(", ")}`);
  assert.ok(
    speechOnly[1] > speechOnly[0] + 12,
    `active speech band should dominate the selected average: ${speechOnly.join(", ")}`,
  );
  assert.ok(
    Math.abs(speechOnly[1] - computeLogBandSpectrumDb(samples.slice(Math.round(0.8 * sampleRate)), sampleRate, {
      bands: [120, 2000],
      widthOct: 0.2,
    })[1]) < 0.25,
    "activity selection should retain the speech-band measurement",
  );
});

test("sparse activity islands are sampled before applying the long-file frame cap", () => {
  const sampleRate = 16000;
  const samples = buildTone(sampleRate, 10, [
    { startSec: 0, endSec: 10, hz: 120, amplitude: 0.04 },
    { startSec: 5, endSec: 5.2, hz: 2000, amplitude: 0.8 },
  ]);
  const activityMask = Array.from({ length: 1000 }, (_, index) => index >= 500 && index < 520);
  const options = { bands: [120, 2000], widthOct: 0.2, maxFrames: 5 } as const;

  const legacy = computeLogBandSpectrumDb(samples, sampleRate, options);
  const speechOnly = computeLogBandSpectrumDb(samples, sampleRate, {
    ...options,
    activityMask,
    activityFrameMs: 10,
  });

  assert.ok(legacy[0] > legacy[1] + 20, `legacy global stride should sample room tone: ${legacy.join(", ")}`);
  assert.ok(
    speechOnly[1] > speechOnly[0] + 6,
    `activity-first sampling should retain the sparse speech island: ${speechOnly.join(", ")}`,
  );
});

test("all-inactive activity mask falls back to the legacy spectrum", () => {
  const sampleRate = 16000;
  const samples = buildTone(sampleRate, 0.4, [
    { startSec: 0, endSec: 0.4, hz: 500, amplitude: 0.2 },
  ]);
  const options = { bands: [120, 500, 2000], widthOct: 0.25, maxFrames: 7 } as const;
  const legacy = computeLogBandSpectrumDb(samples, sampleRate, options);
  const withInactiveMask = computeLogBandSpectrumDb(samples, sampleRate, {
    ...options,
    activityMask: new Array<boolean>(40).fill(false),
    activityFrameMs: 10,
  });

  assert.deepEqual(withInactiveMask, legacy);
  assert.equal(resolveSpectrumFrameBudget(samples.length, sampleRate, options).framesToVisit, 7);
});

test("long sparse activity masks sample active speech instead of strided room tone", () => {
  const sampleRate = 16000;
  const durationSec = 400;
  const samples = buildTone(sampleRate, durationSec, [
    { startSec: 0, endSec: durationSec, hz: 120, amplitude: 0.04 },
    { startSec: 233.2, endSec: 233.28, hz: 2000, amplitude: 0.9 },
  ]);
  const activityMask = new Array<boolean>(durationSec * 100).fill(false);
  for (let index = 23320; index < 23328; index += 1) activityMask[index] = true;

  const legacy = computeLogBandSpectrumDb(samples, sampleRate, {
    bands: [120, 2000],
    widthOct: 0.2,
    maxFrames: 100,
  });
  const speechOnly = computeLogBandSpectrumDb(samples, sampleRate, {
    bands: [120, 2000],
    widthOct: 0.2,
    maxFrames: 100,
    activityMask,
    activityFrameMs: 10,
  });

  assert.ok(legacy[0] > legacy[1] + 20, `legacy long average should be room-tone dominated: ${legacy.join(", ")}`);
  assert.ok(
    speechOnly[1] > speechOnly[0] + 6,
    `active sparse speech should drive tone measurement despite long-file caps: ${speechOnly.join(", ")}`,
  );
});
