import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMlSpeechProtectionMask,
  type MlVadFrame,
} from "./mlSpeechProtection.ts";

const vad = (probabilities: readonly number[]): MlVadFrame[] =>
  probabilities.map((speechProbability, index) => ({
    startMs: index * 10,
    endMs: (index + 1) * 10,
    speechProbability,
  }));

test("ML speech protection fails open to the energy mask when evidence is absent or malformed", () => {
  const energySpeechMask = [false, true, true, false, false];

  assert.deepEqual(
    buildMlSpeechProtectionMask({
      frameCount: energySpeechMask.length,
      frameMs: 10,
      energySpeechMask,
      vadFrames: [],
    }).protectedSpeechMask,
    energySpeechMask,
  );

  assert.deepEqual(
    buildMlSpeechProtectionMask({
      frameCount: energySpeechMask.length,
      frameMs: 10,
      energySpeechMask,
      vadFrames: vad([0.9, 0.9]),
    }).protectedSpeechMask,
    energySpeechMask,
  );
});

test("ML speech protection can bridge a short speech-supported gap but never removes energy speech", () => {
  const energySpeechMask = [
    false,
    true,
    true,
    false,
    false,
    false,
    true,
    true,
    false,
  ];
  const originalEnergyMask = [...energySpeechMask];

  const result = buildMlSpeechProtectionMask({
    frameCount: energySpeechMask.length,
    frameMs: 10,
    energySpeechMask,
    vadFrames: vad([0.1, 0.9, 0.9, 0.82, 0.84, 0.8, 0.91, 0.9, 0.2]),
  });

  assert.equal(result.advisoryOnly, true);
  assert.deepEqual(energySpeechMask, originalEnergyMask);
  assert.deepEqual(result.protectedSpeechMask, [
    false,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    false,
  ]);
  assert.equal(result.addedFrameCount, 3);
  assert.equal(result.isolatedMlFrameCount, 0);
});

test("ML speech protection can preserve a longer speech-supported breath gap between energy runs", () => {
  const energySpeechMask = [
    false,
    true,
    true,
    true,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
    true,
    true,
    false,
  ];

  const result = buildMlSpeechProtectionMask({
    frameCount: energySpeechMask.length,
    frameMs: 10,
    energySpeechMask,
    vadFrames: vad(energySpeechMask.map((active, frame) => {
      if (active) return 0.91;
      if (frame >= 4 && frame < 30) return 0.63;
      return 0.08;
    })),
  });

  assert.equal(result.reason, "ml-protection");
  assert.equal(result.addedFrameCount, 26);
  assert.equal(result.isolatedMlFrameCount, 0);
  assert.deepEqual(
    result.protectedSpeechMask.slice(4, 30),
    new Array<boolean>(26).fill(true),
  );
});

test("ML speech protection keeps one-sided tails shorter and higher-confidence than breath gaps", () => {
  const energySpeechMask = new Array<boolean>(36).fill(false);
  for (let frame = 4; frame < 12; frame += 1) energySpeechMask[frame] = true;

  const result = buildMlSpeechProtectionMask({
    frameCount: energySpeechMask.length,
    frameMs: 10,
    energySpeechMask,
    vadFrames: vad(energySpeechMask.map((active, frame) => {
      if (active) return 0.92;
      if (frame >= 12 && frame < 32) return 0.66;
      return 0.05;
    })),
  });

  assert.equal(result.reason, "ml-protection");
  assert.equal(result.addedFrameCount, 0);
  assert.equal(result.isolatedMlFrameCount, 20);
  assert.deepEqual(result.protectedSpeechMask, energySpeechMask);
});

test("ML speech protection ignores isolated VAD islands instead of creating speech runs", () => {
  const result = buildMlSpeechProtectionMask({
    frameCount: 12,
    frameMs: 10,
    energySpeechMask: [
      false,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ],
    vadFrames: vad([0.1, 0.9, 0.9, 0.1, 0.92, 0.93, 0.94, 0.1, 0.1, 0.1, 0.9, 0.9]),
  });

  assert.deepEqual(result.protectedSpeechMask, [
    false,
    true,
    true,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
    true,
  ]);
  assert.equal(result.addedFrameCount, 0);
  assert.equal(result.isolatedMlFrameCount, 3);
});
