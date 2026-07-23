import assert from "node:assert/strict";
import test from "node:test";
import {
  computeSpeechKWeightedEnergyDb,
  resolvePlannerDeliveryMakeupDb,
  resolveSourceRelativeFinalTone,
} from "./plannerDelivery.ts";

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

test("source-relative final tone is level-invariant and never brightens", () => {
  const source = [-40, -38, -31, -27, -24, -23, -28, -32];
  const levelShifted = source.map((value) => value + 9);
  const identical = resolveSourceRelativeFinalTone(source, levelShifted);

  assert.deepEqual(identical, {
    fourKhzExcessDb: 0,
    eightKhzExcessDb: 0,
    fourKhzTrimDb: 0,
    eightKhzTrimDb: 0,
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
