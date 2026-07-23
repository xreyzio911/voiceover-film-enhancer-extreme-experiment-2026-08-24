import assert from "node:assert/strict";
import test from "node:test";
import {
  computeSpeechKWeightedEnergyDb,
  resolvePlannerGainFrameRange,
  resolvePlannerDeliveryMakeupDb,
  resolveSourceRelativeFinalTone,
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
