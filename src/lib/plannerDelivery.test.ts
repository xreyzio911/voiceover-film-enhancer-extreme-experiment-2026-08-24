import assert from "node:assert/strict";
import test from "node:test";
import {
  FINAL_TONE_BODY_PRESERVATION_MAX_TILT_DB,
  FINAL_TONE_EIGHT_KHZ_MAX_TRIM_DB,
  FINAL_TONE_FOUR_KHZ_MAX_TRIM_DB,
  FINAL_TONE_TOP_OCTAVE_MAX_TRIM_DB,
  computeSpeechKWeightedEnergyDb,
  measurePlannerDeliverySafetyEvidence,
  resolveBlendDeliverySafetyEvidence,
  resolveEvidenceAwarePlannerDeliveryMakeupDb,
  resolvePlannerGainFrameRange,
  resolvePlannerDeliveryMakeupDb,
  resolveSafePositiveDeliveryGainDb,
  resolveSourceRelativeFinalTone,
  type PlannerDeliverySafetyEvidence,
} from "./plannerDelivery.ts";
import { applyGainCurveToSamples } from "./gainPlanner.ts";

const buildSpeechTone = (sampleRate: number, seconds: number, amplitude: number) => {
  const samples = new Float32Array(Math.round(sampleRate * seconds));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] =
      amplitude * Math.sin((2 * Math.PI * 220 * index) / sampleRate) +
      amplitude * 0.35 * Math.sin((2 * Math.PI * 3200 * index) / sampleRate);
  }
  return samples;
};

const dbToAmplitude = (db: number) => 10 ** (db / 20);

const fillAlternatingFrame = (
  samples: Float32Array,
  frame: number,
  samplesPerFrame: number,
  levelDb: number,
) => {
  const amplitude = dbToAmplitude(levelDb);
  const start = frame * samplesPerFrame;
  const end = Math.min(samples.length, start + samplesPerFrame);
  for (let index = start; index < end; index += 1) {
    samples[index] = (index - start) % 2 === 0 ? amplitude : -amplitude;
  }
};

const buildMergedBedFixture = ({
  bedDb,
  samplePeakDb = -4,
}: Readonly<{
  bedDb: number;
  samplePeakDb?: number;
}>) => {
  const sampleRate = 1_000;
  const frameMs = 10;
  const frameCount = 400;
  const samplesPerFrame = (sampleRate * frameMs) / 1_000;
  const samples = new Float32Array(frameCount * samplesPerFrame);
  const activityMask = new Array<boolean>(frameCount).fill(false);

  for (let frame = 200; frame < frameCount; frame += 1) {
    fillAlternatingFrame(samples, frame, samplesPerFrame, bedDb);
    activityMask[frame] = true;
  }
  for (const [start, end] of [
    [240, 270],
    [325, 350],
    [375, 390],
  ]) {
    for (let frame = start; frame < end; frame += 1) {
      fillAlternatingFrame(samples, frame, samplesPerFrame, -28);
    }
  }
  samples[255 * samplesPerFrame] = dbToAmplitude(samplePeakDb);

  return { samples, sampleRate, activityMask, frameMs };
};

const safetyEvidence = (
  overrides: Partial<PlannerDeliverySafetyEvidence> = {},
): PlannerDeliverySafetyEvidence => ({
  nonzeroQuietBedDb: -76,
  nonzeroQuietBedConfidence: 0.95,
  nearSpeechFloorDb: -72,
  nearSpeechFloorConfidence: 0.9,
  samplePeakDb: -14,
  activityPeakDb: null,
  activityPlateauDb: null,
  ...overrides,
});

test("scene blend derives continuous conservative delivery evidence without decoding another full WAV", () => {
  const input = Object.freeze(
    safetyEvidence({
      nonzeroQuietBedDb: -70,
      nearSpeechFloorDb: -66,
      samplePeakDb: -12,
      activityPeakDb: -12,
      activityPlateauDb: -30,
    }),
  );
  const snapshot = JSON.stringify(input);
  const blended = resolveBlendDeliverySafetyEvidence({
    inputSafetyEvidence: input,
    indoorGain: 0.07,
    outdoorGain: 0.055,
    limiterCeilingDb: -2,
  });
  const nearby = resolveBlendDeliverySafetyEvidence({
    inputSafetyEvidence: input,
    indoorGain: 0.0701,
    outdoorGain: 0.055,
    limiterCeilingDb: -2,
  });

  assert.ok(blended);
  assert.ok(nearby);
  assert.ok(
    blended.nonzeroQuietBedDb !== null &&
      blended.nonzeroQuietBedDb > -70 &&
      blended.nonzeroQuietBedDb < -69.4,
    `the conservative blend envelope should reflect only the small wet sum, got ${String(blended.nonzeroQuietBedDb)}`,
  );
  assert.ok(
    blended.nearSpeechFloorDb !== null &&
      blended.nearSpeechFloorDb > -66 &&
      blended.nearSpeechFloorDb < -65.4,
  );
  assert.ok(
    blended.samplePeakDb !== null &&
      blended.samplePeakDb >= -12 &&
      blended.samplePeakDb <= -2,
    `blend peak evidence must remain a conservative limiter-bounded upper envelope, got ${String(blended.samplePeakDb)}`,
  );
  assert.ok(
    blended.activityPeakDb !== null &&
      blended.activityPeakDb !== undefined &&
      blended.activityPlateauDb !== null &&
      blended.activityPlateauDb !== undefined &&
      Math.abs(
        (blended.activityPeakDb - blended.activityPlateauDb) - 18,
      ) < 1e-9,
    "the conservative blend envelope must preserve level-invariant crest prominence",
  );
  assert.ok(
    Math.abs(
      (nearby.nonzeroQuietBedDb as number) -
        (blended.nonzeroQuietBedDb as number),
    ) < 0.01,
    "a 0.0001 wet-gain change must not create an evidence step",
  );
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(
    resolveBlendDeliverySafetyEvidence({
      inputSafetyEvidence: null,
      indoorGain: 0.07,
      outdoorGain: 0.055,
    }),
    null,
  );
});

test("scene blend preserves activity crest prominence when its peak envelope reaches the limiter ceiling", () => {
  const blended = resolveBlendDeliverySafetyEvidence({
    inputSafetyEvidence: safetyEvidence({
      nonzeroQuietBedDb: -72,
      nearSpeechFloorDb: -68,
      samplePeakDb: -1,
      activityPeakDb: -1,
      activityPlateauDb: -19,
    }),
    indoorGain: 0.2,
    outdoorGain: 0.1,
    limiterCeilingDb: -2,
  });

  assert.ok(blended);
  assert.equal(blended.activityPeakDb, -2);
  assert.ok(
    blended.activityPlateauDb !== null &&
      blended.activityPlateauDb !== undefined &&
      Math.abs((blended.activityPeakDb - blended.activityPlateauDb) - 18) < 1e-9,
    `limiter-bounded blend evidence must retain the source crest, got ${String(blended.activityPeakDb)} / ${String(blended.activityPlateauDb)}`,
  );
});

test("speech K energy averages only selected speech samples", () => {
  const sampleRate = 16_000;
  const frameMs = 10;
  const speech = buildSpeechTone(sampleRate, 0.5, 0.12);
  const samples = new Float32Array(sampleRate);
  samples.set(speech, sampleRate / 2);
  const mask = [
    ...new Array<boolean>(50).fill(false),
    ...new Array<boolean>(50).fill(true),
  ];

  const selectedEnergyDb = computeSpeechKWeightedEnergyDb(samples, sampleRate, mask, frameMs);
  const speechOnlyEnergyDb = computeSpeechKWeightedEnergyDb(
    speech,
    sampleRate,
    new Array<boolean>(50).fill(true),
    frameMs,
  );

  assert.notEqual(selectedEnergyDb, null);
  assert.notEqual(speechOnlyEnergyDb, null);
  assert.ok(
    Math.abs((selectedEnergyDb as number) - (speechOnlyEnergyDb as number)) < 0.02,
    "silence outside the selected speech mask must not lower the speech-energy measurement",
  );
  assert.equal(
    computeSpeechKWeightedEnergyDb(samples, sampleRate, new Array<boolean>(100).fill(false), frameMs),
    null,
  );
});

test("planner delivery makeup continuously restores its measured speech target", () => {
  assert.ok(
    Math.abs(
      resolvePlannerDeliveryMakeupDb({
        plannerTargetDb: -21.8,
        speechKWeightedEnergyDb: -30.46,
      }) - 10.01,
    ) < 0.01,
  );
  assert.ok(
    Math.abs(
      resolvePlannerDeliveryMakeupDb({
        plannerTargetDb: -22.5,
        speechKWeightedEnergyDb: -28.13,
      }) - 6.98,
    ) < 0.01,
  );
  assert.ok(
    resolvePlannerDeliveryMakeupDb({
      plannerTargetDb: -22,
      speechKWeightedEnergyDb: -30.01,
    }) >
      resolvePlannerDeliveryMakeupDb({
        plannerTargetDb: -22,
        speechKWeightedEnergyDb: -30,
      }),
    "nearby measurements must produce nearby gains without an engagement gate",
  );
});

test("planner delivery makeup fails open and never attenuates or exceeds bounded authority", () => {
  assert.equal(
    resolvePlannerDeliveryMakeupDb({
      plannerTargetDb: null,
      speechKWeightedEnergyDb: -30,
    }),
    0,
  );
  assert.equal(
    resolvePlannerDeliveryMakeupDb({
      plannerTargetDb: -22,
      speechKWeightedEnergyDb: null,
    }),
    0,
  );
  assert.equal(
    resolvePlannerDeliveryMakeupDb({
      plannerTargetDb: -22,
      speechKWeightedEnergyDb: -12,
    }),
    0,
  );
  assert.equal(
    resolvePlannerDeliveryMakeupDb({
      plannerTargetDb: -22,
      speechKWeightedEnergyDb: -80,
    }),
    10.5,
  );
});

test("delivery safety evidence finds a persistent nonzero bed even when the speech mask merges it", () => {
  const fixture = buildMergedBedFixture({ bedDb: -52 });
  const beforeSamples = new Float32Array(fixture.samples);
  const beforeMask = [...fixture.activityMask];
  const measured = measurePlannerDeliverySafetyEvidence(
    fixture.samples,
    fixture.sampleRate,
    fixture.activityMask,
    fixture.frameMs,
  );

  assert.ok(measured.nonzeroQuietBedDb !== null);
  assert.ok(
    (measured.nonzeroQuietBedDb ?? -120) > -54 &&
      (measured.nonzeroQuietBedDb ?? 0) < -50,
    `the persistent bed should measure near -52 dB, got ${measured.nonzeroQuietBedDb}`,
  );
  assert.ok(
    measured.nonzeroQuietBedConfidence > 0.45,
    `the long, separated bed should carry useful confidence, got ${measured.nonzeroQuietBedConfidence}`,
  );
  assert.ok(measured.nearSpeechFloorDb !== null);
  assert.ok(
    (measured.nearSpeechFloorDb ?? -120) > -54 &&
      (measured.nearSpeechFloorDb ?? 0) < -49,
    `embedded near-speech bed should remain visible, got ${measured.nearSpeechFloorDb}`,
  );
  assert.ok(measured.nearSpeechFloorConfidence > 0.3);
  assert.ok(Math.abs((measured.samplePeakDb ?? -120) - -4) < 0.01);
  assert.ok(
    measured.activityPeakDb !== null &&
      measured.activityPeakDb !== undefined &&
      measured.activityPeakDb < -27,
    `speech-localized expressive crest evidence should use robust frame peaks, got ${String(measured.activityPeakDb)}`,
  );
  assert.deepEqual(fixture.samples, beforeSamples, "measurement must not mutate decoded samples");
  assert.deepEqual(fixture.activityMask, beforeMask, "measurement must not mutate the shared speech mask");
});

test("delivery safety evidence assigns low bed authority to steady quiet speech", () => {
  const sampleRate = 1_000;
  const frameMs = 10;
  const frameCount = 300;
  const samplesPerFrame = (sampleRate * frameMs) / 1_000;
  const samples = new Float32Array(frameCount * samplesPerFrame);
  for (let frame = 0; frame < frameCount; frame += 1) {
    fillAlternatingFrame(samples, frame, samplesPerFrame, -48);
  }

  const measured = measurePlannerDeliverySafetyEvidence(
    samples,
    sampleRate,
    new Array<boolean>(frameCount).fill(true),
    frameMs,
  );

  assert.ok(Math.abs((measured.nonzeroQuietBedDb ?? -120) - -48) < 0.05);
  assert.ok(
    measured.nonzeroQuietBedConfidence < 0.08,
    `a single steady level has no evidence of a distinct quiet bed, got ${measured.nonzeroQuietBedConfidence}`,
  );
  assert.ok(
    measured.nearSpeechFloorConfidence < 0.08,
    "the same steady speech must not acquire a second high-confidence noise label",
  );
});

test("exact digital silence is exempt from nonzero-bed evidence", () => {
  const measured = measurePlannerDeliverySafetyEvidence(
    new Float32Array(2_000),
    1_000,
    new Array<boolean>(200).fill(false),
    10,
  );

  assert.deepEqual(measured, {
    nonzeroQuietBedDb: null,
    nonzeroQuietBedConfidence: 0,
    nearSpeechFloorDb: null,
    nearSpeechFloorConfidence: 0,
    samplePeakDb: null,
    activityPeakDb: null,
    activityPlateauDb: null,
  });
});

test("delivery safety evidence measures the exact decoded peak beyond a shorter activity mask", () => {
  const samples = new Float32Array(2_000);
  samples.fill(dbToAmplitude(-60), 0, 1_000);
  samples[1_999] = 1;

  const measured = measurePlannerDeliverySafetyEvidence(
    samples,
    1_000,
    new Array<boolean>(100).fill(true),
    10,
  );

  assert.equal(
    measured.samplePeakDb,
    0,
    "limiter headroom must use the whole decoded buffer, not only mask-covered frames",
  );
  assert.ok(
    measured.activityPeakDb !== null &&
      measured.activityPeakDb !== undefined &&
      measured.activityPeakDb < -59.9,
    `speech-localized crest evidence must exclude the later non-speech impulse, got ${String(measured.activityPeakDb)}`,
  );
});

test("delivery safety evidence uses a robust speech-frame peak for expressive crest", () => {
  const sampleRate = 10_000;
  const frameMs = 10;
  const frameCount = 200;
  const samplesPerFrame = (sampleRate * frameMs) / 1_000;
  const samples = new Float32Array(frameCount * samplesPerFrame);
  const activityMask = new Array<boolean>(frameCount).fill(true);

  for (let frame = 0; frame < frameCount; frame += 1) {
    fillAlternatingFrame(samples, frame, samplesPerFrame, -42);
    samples[frame * samplesPerFrame] = dbToAmplitude(-24);
  }
  samples[80 * samplesPerFrame] = dbToAmplitude(-4);

  const measured = measurePlannerDeliverySafetyEvidence(
    samples,
    sampleRate,
    activityMask,
    frameMs,
  );

  assert.ok(Math.abs((measured.samplePeakDb ?? -120) - -4) < 0.01);
  assert.ok(
    measured.activityPeakDb !== null &&
      measured.activityPeakDb !== undefined &&
      measured.activityPeakDb < -20 &&
      measured.activityPeakDb > -28,
    `speech crest evidence should ignore a single-frame click, got ${String(measured.activityPeakDb)}`,
  );
});

test("speech-localized crest evidence ignores a single in-speech click", () => {
  const sampleRate = 1_000;
  const frameMs = 10;
  const frameCount = 100;
  const samplesPerFrame = (sampleRate * frameMs) / 1_000;
  const samples = new Float32Array(frameCount * samplesPerFrame);
  for (let frame = 0; frame < frameCount; frame += 1) {
    fillAlternatingFrame(samples, frame, samplesPerFrame, -24);
  }
  samples[17 * samplesPerFrame] = dbToAmplitude(-1);

  const measured = measurePlannerDeliverySafetyEvidence(
    samples,
    sampleRate,
    new Array<boolean>(frameCount).fill(true),
    frameMs,
  );

  assert.ok(
    Math.abs((measured.samplePeakDb ?? -120) - -1) < 0.01,
    "whole-buffer peak evidence must still retain the real limiter peak",
  );
  assert.ok(
    measured.activityPeakDb !== null &&
      measured.activityPeakDb !== undefined &&
      measured.activityPeakDb < -22 &&
      measured.activityPeakDb > -26,
    `speech-localized crest evidence should use robust frame-peak evidence, got ${String(measured.activityPeakDb)}`,
  );
});

test("source-relative quiet-bed headroom spends denoise-earned room without lifting an unchanged bed", () => {
  const source = safetyEvidence({
    nonzeroQuietBedDb: -52,
    nonzeroQuietBedConfidence: 1,
    nearSpeechFloorDb: -50,
    nearSpeechFloorConfidence: 1,
    samplePeakDb: -5,
  });
  const unchanged = safetyEvidence({
    nonzeroQuietBedDb: -52,
    nonzeroQuietBedConfidence: 1,
    nearSpeechFloorDb: -50,
    nearSpeechFloorConfidence: 1,
    samplePeakDb: -8,
  });
  const denoised = safetyEvidence({
    nonzeroQuietBedDb: -58,
    nonzeroQuietBedConfidence: 1,
    nearSpeechFloorDb: -56,
    nearSpeechFloorConfidence: 1,
    samplePeakDb: -10,
  });

  const unchangedGain = resolveSafePositiveDeliveryGainDb({
    requestedGainDb: 10.5,
    sourceSafetyEvidence: source,
    renderedSafetyEvidence: unchanged,
    limiterCeilingDb: -2,
    allowedLimiterDriveDb: 1.5,
  });
  const denoisedGain = resolveSafePositiveDeliveryGainDb({
    requestedGainDb: 10.5,
    sourceSafetyEvidence: source,
    renderedSafetyEvidence: denoised,
    limiterCeilingDb: -2,
    allowedLimiterDriveDb: 1.5,
  });

  assert.ok(
    unchangedGain >= 0.7 && unchangedGain <= 1,
    `an unchanged, elevated bed should receive only the subtle source-relative budget, got ${unchangedGain}`,
  );
  assert.ok(
    denoisedGain >= 6.7 && denoisedGain <= 7,
    `six dB of denoise should earn approximately six dB more makeup, got ${denoisedGain}`,
  );
  assert.ok(denoisedGain > unchangedGain + 5.8);
});

test("clean low-floor evidence preserves requested makeup while peak evidence limits limiter drive", () => {
  const cleanSource = safetyEvidence({
    nonzeroQuietBedDb: -80,
    nearSpeechFloorDb: -74,
    samplePeakDb: -15,
  });
  const cleanRendered = safetyEvidence({
    nonzeroQuietBedDb: -81,
    nearSpeechFloorDb: -75,
    samplePeakDb: -14,
  });

  assert.equal(
    resolveSafePositiveDeliveryGainDb({
      requestedGainDb: 8,
      sourceSafetyEvidence: cleanSource,
      renderedSafetyEvidence: cleanRendered,
      limiterCeilingDb: -2,
      allowedLimiterDriveDb: 1.5,
    }),
    8,
    "a genuinely low floor and ample peak headroom should not reduce useful makeup",
  );

  const peakLimited = resolveSafePositiveDeliveryGainDb({
    requestedGainDb: 8,
    sourceSafetyEvidence: cleanSource,
    renderedSafetyEvidence: {
      ...cleanRendered,
      samplePeakDb: -2.5,
    },
    limiterCeilingDb: -2,
    allowedLimiterDriveDb: 1.5,
  });
  assert.ok(
    Math.abs(peakLimited - 2) < 1e-9,
    `static gain may drive the -2 dB limiter by at most 1.5 dB, got ${peakLimited}`,
  );
});

test("only speech-localized expressive crest prominence continuously reduces delivery limiter drive", () => {
  const cleanRendered = safetyEvidence({
    nonzeroQuietBedDb: -81,
    nearSpeechFloorDb: -75,
    samplePeakDb: -3.0,
  });
  const ordinarySource = safetyEvidence({
    nonzeroQuietBedDb: -82,
    nearSpeechFloorDb: -76,
    samplePeakDb: -3.25,
    activityPeakDb: -3.25,
    activityPlateauDb: -6.5,
  });
  const quietExpressiveSource = safetyEvidence({
    nonzeroQuietBedDb: -82,
    nearSpeechFloorDb: -76,
    samplePeakDb: -20,
    activityPeakDb: -20,
    activityPlateauDb: -46,
  });
  const hotExpressiveSource = safetyEvidence({
    nonzeroQuietBedDb: -82,
    nearSpeechFloorDb: -76,
    samplePeakDb: -3.25,
    activityPeakDb: -3.25,
    activityPlateauDb: -29.25,
  });
  const hotNonSpeechPeakSource = safetyEvidence({
    nonzeroQuietBedDb: -82,
    nearSpeechFloorDb: -76,
    samplePeakDb: -3.25,
    activityPeakDb: -20,
    activityPlateauDb: -46,
  });
  const hotterExpressiveSource = {
    ...quietExpressiveSource,
    samplePeakDb: -19.99,
    activityPeakDb: -19.99,
    activityPlateauDb: -45.99,
  };

  const ordinaryGain = resolveSafePositiveDeliveryGainDb({
    requestedGainDb: 8,
    sourceSafetyEvidence: ordinarySource,
    renderedSafetyEvidence: cleanRendered,
    limiterCeilingDb: -2,
    allowedLimiterDriveDb: 1.5,
  });
  const expressiveGain = resolveSafePositiveDeliveryGainDb({
    requestedGainDb: 8,
    sourceSafetyEvidence: quietExpressiveSource,
    renderedSafetyEvidence: cleanRendered,
    limiterCeilingDb: -2,
    allowedLimiterDriveDb: 1.5,
  });
  const hotExpressiveGain = resolveSafePositiveDeliveryGainDb({
    requestedGainDb: 8,
    sourceSafetyEvidence: hotExpressiveSource,
    renderedSafetyEvidence: cleanRendered,
    limiterCeilingDb: -2,
    allowedLimiterDriveDb: 1.5,
  });
  const nonSpeechPeakGain = resolveSafePositiveDeliveryGainDb({
    requestedGainDb: 8,
    sourceSafetyEvidence: hotNonSpeechPeakSource,
    renderedSafetyEvidence: cleanRendered,
    limiterCeilingDb: -2,
    allowedLimiterDriveDb: 1.5,
  });
  const nearbyExpressiveGain = resolveSafePositiveDeliveryGainDb({
    requestedGainDb: 8,
    sourceSafetyEvidence: hotterExpressiveSource,
    renderedSafetyEvidence: cleanRendered,
    limiterCeilingDb: -2,
    allowedLimiterDriveDb: 1.5,
  });

  assert.ok(
    ordinaryGain > expressiveGain,
    `ordinary hot speech can spend more limiter drive than a quiet expressive crest (${ordinaryGain} vs ${expressiveGain})`,
  );
  assert.ok(
    Math.abs(hotExpressiveGain - expressiveGain) < 1e-9,
    `equal crest prominence must receive equal protection regardless of recording level (${hotExpressiveGain} vs ${expressiveGain})`,
  );
  assert.equal(
    nonSpeechPeakGain,
    ordinaryGain,
    "an inactive click or bed spike must fail open to the established limiter-drive allowance",
  );
  assert.ok(
    expressiveGain >= 1.2 && expressiveGain <= 1.35,
    `expressive crest prominence should keep positive makeup but avoid the full 1.5 dB drive, got ${expressiveGain}`,
  );
  assert.ok(
    Math.abs(nearbyExpressiveGain - expressiveGain) < 0.02,
    `0.01 dB source-crest changes must remain continuous: ${expressiveGain} -> ${nearbyExpressiveGain}`,
  );
});

test("delivery crest protection starts above the measured plain-dialogue corpus center", () => {
  const rendered = safetyEvidence({
    nonzeroQuietBedDb: -81,
    nearSpeechFloorDb: -75,
    samplePeakDb: -3,
  });
  const withoutCrestEvidence = safetyEvidence({
    nonzeroQuietBedDb: -82,
    nearSpeechFloorDb: -76,
    samplePeakDb: -20,
  });
  const corpusMedianDialogue = safetyEvidence({
    ...withoutCrestEvidence,
    activityPeakDb: -20,
    activityPlateauDb: -39.4,
  });
  const upperTailExpression = safetyEvidence({
    ...withoutCrestEvidence,
    activityPeakDb: -20,
    activityPlateauDb: -45,
  });
  const gainFor = (sourceSafetyEvidence: PlannerDeliverySafetyEvidence) =>
    resolveSafePositiveDeliveryGainDb({
      requestedGainDb: 8,
      sourceSafetyEvidence,
      renderedSafetyEvidence: rendered,
      limiterCeilingDb: -2,
      allowedLimiterDriveDb: 1.5,
    });

  const ordinaryGain = gainFor(withoutCrestEvidence);
  assert.equal(
    gainFor(corpusMedianDialogue),
    ordinaryGain,
    "the measured 19.4 dB corpus median must not be treated as an expressive crest",
  );
  assert.ok(
    gainFor(upperTailExpression) < ordinaryGain - 1,
    "a 25 dB upper-tail crest should retain strong limiter protection",
  );
});

test("evidence-aware planner makeup fails safely on missing or polluted safety evidence", () => {
  const valid = safetyEvidence();
  const base = {
    plannerTargetDb: -22,
    speechKWeightedEnergyDb: -40,
    limiterCeilingDb: -2,
    allowedLimiterDriveDb: 1.5,
  } as const;

  assert.equal(
    resolveEvidenceAwarePlannerDeliveryMakeupDb({
      ...base,
      sourceSafetyEvidence: null,
      renderedSafetyEvidence: valid,
    }),
    0,
  );
  assert.equal(
    resolveEvidenceAwarePlannerDeliveryMakeupDb({
      ...base,
      sourceSafetyEvidence: valid,
      renderedSafetyEvidence: {
        ...valid,
        nearSpeechFloorConfidence: Number.NaN,
      },
    }),
    0,
  );
  assert.equal(
    resolveEvidenceAwarePlannerDeliveryMakeupDb({
      ...base,
      sourceSafetyEvidence: valid,
      renderedSafetyEvidence: {
        ...valid,
        samplePeakDb: null,
      },
    }),
    0,
    "the new path must not silently fall back to the legacy +10.5 dB cap",
  );
  assert.equal(
    resolveSafePositiveDeliveryGainDb({
      requestedGainDb: -3,
      sourceSafetyEvidence: valid,
      renderedSafetyEvidence: valid,
      limiterCeilingDb: -2,
      allowedLimiterDriveDb: 1.5,
    }),
    0,
    "the helper owns positive delivery gain only",
  );
});

test("delivery gain authority is continuous at 0.01 dB evidence changes", () => {
  const source = safetyEvidence({
    nonzeroQuietBedDb: -52,
    nonzeroQuietBedConfidence: 0.82,
    nearSpeechFloorDb: -50,
    nearSpeechFloorConfidence: 0.78,
    samplePeakDb: -12,
  });
  const rendered = safetyEvidence({
    nonzeroQuietBedDb: -53,
    nonzeroQuietBedConfidence: 0.83,
    nearSpeechFloorDb: -51,
    nearSpeechFloorConfidence: 0.79,
    samplePeakDb: -12,
  });
  const initial = resolveSafePositiveDeliveryGainDb({
    requestedGainDb: 7,
    sourceSafetyEvidence: source,
    renderedSafetyEvidence: rendered,
    limiterCeilingDb: -2,
    allowedLimiterDriveDb: 1.5,
  });
  const nearby = resolveSafePositiveDeliveryGainDb({
    requestedGainDb: 7,
    sourceSafetyEvidence: source,
    renderedSafetyEvidence: {
      ...rendered,
      nonzeroQuietBedDb: (rendered.nonzeroQuietBedDb as number) + 0.01,
      nearSpeechFloorDb: (rendered.nearSpeechFloorDb as number) + 0.01,
      samplePeakDb: (rendered.samplePeakDb as number) + 0.01,
    },
    limiterCeilingDb: -2,
    allowedLimiterDriveDb: 1.5,
  });

  assert.ok(initial > 0);
  assert.ok(
    Math.abs(nearby - initial) <= 0.03,
    `a 0.01 dB evidence change must not create a gain step: ${initial} -> ${nearby}`,
  );
});

test("delivery gain policy is deterministic and immutable", () => {
  const source = Object.freeze(safetyEvidence());
  const rendered = Object.freeze(
    safetyEvidence({
      nonzeroQuietBedDb: -70,
      nearSpeechFloorDb: -68,
      samplePeakDb: -9,
    }),
  );
  const options = Object.freeze({
    requestedGainDb: 6.25,
    sourceSafetyEvidence: source,
    renderedSafetyEvidence: rendered,
    limiterCeilingDb: -2,
    allowedLimiterDriveDb: 1.5,
  });
  const snapshot = JSON.stringify(options);

  const first = resolveSafePositiveDeliveryGainDb(options);
  const second = resolveSafePositiveDeliveryGainDb(options);

  assert.equal(first, second);
  assert.equal(JSON.stringify(options), snapshot);
});

test("range-local planner apply slices local gain frames for non-zero source offsets", () => {
  assert.deepEqual(
    resolvePlannerGainFrameRange({
      planStartSec: 0,
      durationSec: 60.02,
      frameMs: 10,
      totalFrames: 90_000,
    }),
    { frameStart: 0, frameEnd: 6003, frameOffsetFrames: 0 },
  );
  assert.deepEqual(
    resolvePlannerGainFrameRange({
      planStartSec: 60,
      durationSec: 60.02,
      frameMs: 10,
      totalFrames: 90_000,
    }),
    { frameStart: 5999, frameEnd: 12003, frameOffsetFrames: 1 },
  );
  assert.deepEqual(
    resolvePlannerGainFrameRange({
      planStartSec: 899.98,
      durationSec: 0.5,
      frameMs: 10,
      totalFrames: 90_000,
    }),
    { frameStart: 89_997, frameEnd: 90_000, frameOffsetFrames: 1 },
  );
  assert.deepEqual(
    resolvePlannerGainFrameRange({
      planStartSec: Number.NaN,
      durationSec: 60,
      frameMs: 10,
      totalFrames: 90_000,
    }),
    { frameStart: 0, frameEnd: 0, frameOffsetFrames: 0 },
    "invalid timing evidence must return an empty slice instead of an unrelated range",
  );
});

test("range-local gain interpolation matches whole-file application at its first sample", () => {
  const sampleRate = 1000;
  const frameMs = 10;
  const fullSamples = new Float32Array(50).fill(1);
  const fullGainCurve = Float32Array.from([1, 2, 3, 4, 5]);
  const fullOutput = applyGainCurveToSamples(
    fullSamples,
    fullGainCurve,
    sampleRate,
    1,
    frameMs,
  );
  const range = resolvePlannerGainFrameRange({
    planStartSec: 0.02,
    durationSec: 0.02,
    frameMs,
    totalFrames: fullGainCurve.length,
  });
  const slicedOutput = applyGainCurveToSamples(
    new Float32Array(20).fill(1),
    fullGainCurve.slice(range.frameStart, range.frameEnd),
    sampleRate,
    1,
    frameMs,
    undefined,
    range.frameOffsetFrames,
  );

  assert.deepEqual(
    slicedOutput,
    fullOutput.slice(20, 40),
    "a nonzero range must retain the previous frame needed for midpoint interpolation",
  );
});

test("source-relative final tone is level-invariant and never brightens", () => {
  const source = [-40, -38, -31, -27, -24, -23, -28, -32];
  const levelShifted = source.map((value) => value + 9);
  const identical = resolveSourceRelativeFinalTone(source, levelShifted);

  assert.deepEqual(identical, {
    bodyPreservationTiltDb: 0,
    fourKhzExcessDb: 0,
    eightKhzExcessDb: 0,
    topOctaveExcessDb: 0,
    fourKhzTrimDb: 0,
    eightKhzTrimDb: 0,
    topOctaveTrimDb: 0,
  });

  const darker = [...levelShifted];
  darker[6] -= 3;
  darker[7] -= 4;
  assert.deepEqual(resolveSourceRelativeFinalTone(source, darker), identical);
});

test("source-relative final tone preserves body-rich source weight with subtractive-only tilt", () => {
  // Bands: 60, 120, 250, 500, 1000, 2000, 4000, 8000 Hz.
  const bodyRichSource = [-44, -27, -24, -25, -32, -34, -40, -45];
  const preservedTransfer = bodyRichSource.map((value) => value + 6);
  const lowBodyLost = [...preservedTransfer];
  lowBodyLost[1] -= 2;
  lowBodyLost[2] -= 2;
  lowBodyLost[3] -= 2;

  const lostBodyDecision = resolveSourceRelativeFinalTone(
    bodyRichSource,
    lowBodyLost,
  );
  assert.ok(lostBodyDecision);
  assert.ok(
    (lostBodyDecision?.bodyPreservationTiltDb ?? 0) < 0,
    "processing-added low-body loss on a body-rich actor should receive a subtractive high-side tilt",
  );
  assert.ok(
    (lostBodyDecision?.bodyPreservationTiltDb ?? -Infinity) >= -0.75,
    "body preservation must stay inside subtle subtractive authority",
  );

  assert.equal(
    resolveSourceRelativeFinalTone(
      bodyRichSource,
      preservedTransfer,
    )?.bodyPreservationTiltDb,
    0,
    "a level-shifted but otherwise preserved body transfer must remain untouched",
  );

  const bodyLightSource = [-45, -39, -36, -34, -28, -27, -32, -38];
  const bodyLightRenderWithLowLoss = bodyLightSource.map(
    (value, index) => value + 6 - (index >= 1 && index <= 3 ? 2 : 0),
  );
  assert.equal(
    resolveSourceRelativeFinalTone(
      bodyLightSource,
      bodyLightRenderWithLowLoss,
    )?.bodyPreservationTiltDb,
    0,
    "body-light source tone must not be made generically darker",
  );
});

test("body preservation shares correction authority with every higher-frequency trim", () => {
  const source = [-46, -24, -22, -23, -31, -34, -42, -48];
  const rendered = source.map((value) => value + 6);
  rendered[1] -= 8;
  rendered[2] -= 8;
  rendered[3] -= 8;
  rendered[6] += 12;
  rendered[7] += 14;
  const nativeSource = [-24, -22, -23, -31, -34, -42, -52];
  const nativeRendered = nativeSource.map((value) => value + 6);
  nativeRendered[6] += 16;

  const decision = resolveSourceRelativeFinalTone(
    source,
    rendered,
    nativeSource,
    nativeRendered,
  );
  assert.ok(decision);
  const bodyTiltDb = Math.abs(decision?.bodyPreservationTiltDb ?? 0);
  assert.ok(bodyTiltDb > 0.7, "fixture must spend most of the body-preservation authority");
  assert.ok(
    bodyTiltDb + Math.abs(decision?.fourKhzTrimDb ?? 0) <=
      Math.max(
        FINAL_TONE_BODY_PRESERVATION_MAX_TILT_DB,
        FINAL_TONE_FOUR_KHZ_MAX_TRIM_DB,
      ) +
        1e-9,
    "the broad body shelf must replace, not stack on top of, the 4 kHz correction",
  );
  assert.ok(
    bodyTiltDb + Math.abs(decision?.eightKhzTrimDb ?? 0) <=
      Math.max(
        FINAL_TONE_BODY_PRESERVATION_MAX_TILT_DB,
        FINAL_TONE_EIGHT_KHZ_MAX_TRIM_DB,
      ) +
        1e-9,
    "the broad body shelf must replace, not stack on top of, the 8 kHz correction",
  );
  assert.ok(
    bodyTiltDb + Math.abs(decision?.topOctaveTrimDb ?? 0) <=
      Math.max(
        FINAL_TONE_BODY_PRESERVATION_MAX_TILT_DB,
        FINAL_TONE_TOP_OCTAVE_MAX_TRIM_DB,
      ) +
        1e-9,
    "the broad body shelf must replace, not stack on top of, the top-octave correction",
  );
});

test("source-relative final tone responds continuously and stays subtly bounded", () => {
  const source = [-40, -38, -31, -27, -24, -23, -28, -32];
  const slightlyBrighter = [...source];
  slightlyBrighter[6] += 0.01;
  slightlyBrighter[7] += 0.01;
  const strong = [...source];
  strong[6] += 8;
  strong[7] += 12;

  const slightResult = resolveSourceRelativeFinalTone(source, slightlyBrighter);
  const strongResult = resolveSourceRelativeFinalTone(source, strong);

  assert.ok(slightResult && slightResult.fourKhzTrimDb < 0 && slightResult.eightKhzTrimDb < 0);
  assert.ok(strongResult);
  assert.ok((strongResult?.fourKhzTrimDb ?? 0) >= -0.7);
  assert.ok((strongResult?.eightKhzTrimDb ?? 0) >= -0.9);
  assert.ok(
    Math.abs(strongResult?.fourKhzTrimDb ?? 0) + Math.abs(strongResult?.eightKhzTrimDb ?? 0) <=
      1.4 + 1e-9,
  );
});

test("source-relative final tone rejects incomplete or polluted domains", () => {
  assert.equal(resolveSourceRelativeFinalTone(new Array<number>(7).fill(-30), new Array<number>(8).fill(-30)), null);
  assert.equal(
    resolveSourceRelativeFinalTone(
      new Array<number>(8).fill(-30),
      [-30, -30, -30, -30, Number.NaN, -30, -30, -30],
    ),
    null,
  );
});

test("native top-octave reconciliation is level-invariant, continuous, and subtly bounded", () => {
  const source = [-40, -38, -31, -27, -24, -23, -28, -32];
  const rendered = source.map((value) => value + 7);
  const nativeSource = [-31, -27, -24, -23, -28, -32, -38];
  const nativeLevelShift = nativeSource.map((value) => value + 11);
  const identical = resolveSourceRelativeFinalTone(
    source,
    rendered,
    nativeSource,
    nativeLevelShift,
  );

  assert.equal(identical?.topOctaveExcessDb, 0);
  assert.equal(identical?.topOctaveTrimDb, 0);

  const tinyExcess = [...nativeLevelShift];
  tinyExcess[6] += 0.01;
  const tiny = resolveSourceRelativeFinalTone(source, rendered, nativeSource, tinyExcess);
  assert.ok(tiny);
  assert.ok((tiny?.topOctaveTrimDb ?? 0) < 0, "any positive excess must receive a continuous response");
  assert.ok((tiny?.topOctaveTrimDb ?? 0) > -0.001, "a tiny excess must not trigger an audible step");

  const moderateExcess = [...nativeLevelShift];
  moderateExcess[6] += 2.2;
  const strongExcess = [...nativeLevelShift];
  strongExcess[6] += 12;
  const moderate = resolveSourceRelativeFinalTone(source, rendered, nativeSource, moderateExcess);
  const strong = resolveSourceRelativeFinalTone(source, rendered, nativeSource, strongExcess);

  assert.ok((moderate?.topOctaveTrimDb ?? 0) < (tiny?.topOctaveTrimDb ?? 0));
  assert.ok((strong?.topOctaveTrimDb ?? 0) < (moderate?.topOctaveTrimDb ?? 0));
  assert.ok((strong?.topOctaveTrimDb ?? 0) >= -2);
  assert.equal(
    resolveSourceRelativeFinalTone(
      source,
      rendered,
      new Array<number>(6).fill(-30),
      new Array<number>(7).fill(-30),
    )?.topOctaveTrimDb,
    0,
    "invalid optional native evidence must fail open without disabling the valid 4/8 kHz result",
  );
});
