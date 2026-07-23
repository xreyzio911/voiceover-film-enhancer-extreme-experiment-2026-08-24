import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_FINAL_TONE_BANDS_HZ,
  measureNativeFinalToneSpectrumDb,
} from "./finalToneEvidence.ts";

const buildSpeechLikeTone = (
  sampleRate: number,
  seconds: number,
  topOctaveAmplitude = 0.025,
) => {
  const samples = new Float32Array(Math.round(sampleRate * seconds));
  const speechStart = Math.round(sampleRate * 0.25);
  const speechEnd = Math.round(sampleRate * (seconds - 0.25));
  for (let index = speechStart; index < speechEnd; index += 1) {
    const time = index / sampleRate;
    samples[index] =
      0.12 * Math.sin(2 * Math.PI * 250 * time) +
      0.08 * Math.sin(2 * Math.PI * 1000 * time) +
      topOctaveAmplitude * Math.sin(2 * Math.PI * 12000 * time);
  }
  return samples;
};

test("native final-tone evidence measures speech-selected 12 kHz energy at production rate", () => {
  const spectrum = measureNativeFinalToneSpectrumDb(
    buildSpeechLikeTone(48_000, 1.5),
    48_000,
  );

  assert.ok(spectrum);
  assert.equal(spectrum?.length, NATIVE_FINAL_TONE_BANDS_HZ.length);
  assert.ok(spectrum?.every(Number.isFinite));
  assert.ok((spectrum?.at(-1) ?? -200) > -100);
});

test("native final-tone evidence fails open outside a valid top-octave domain", () => {
  assert.equal(
    measureNativeFinalToneSpectrumDb(buildSpeechLikeTone(16_000, 1.5), 16_000),
    null,
  );
  assert.equal(measureNativeFinalToneSpectrumDb(new Float32Array(), 48_000), null);
  assert.equal(
    measureNativeFinalToneSpectrumDb(new Float32Array(48_000), 48_000),
    null,
  );
});

test("native source/render evidence measures a stable 12 kHz differential across production rates", () => {
  const measuredExcessDb = [32_000, 44_100, 48_000].map((sampleRate) => {
    const source = measureNativeFinalToneSpectrumDb(
      buildSpeechLikeTone(sampleRate, 1.5, 0.002),
      sampleRate,
    );
    const rendered = measureNativeFinalToneSpectrumDb(
      buildSpeechLikeTone(sampleRate, 1.5, 0.03),
      sampleRate,
    );
    assert.ok(source && rendered, `${sampleRate} Hz evidence should be measurable`);
    const sourceBodyDb =
      (source![0] + source![1] + source![2] + source![3]) / 4;
    const renderedBodyDb =
      (rendered![0] + rendered![1] + rendered![2] + rendered![3]) / 4;
    return rendered![6] - renderedBodyDb - (source![6] - sourceBodyDb);
  });

  assert.ok(
    measuredExcessDb.every((excessDb) => excessDb > 15),
    `the stronger rendered top octave should remain clearly measurable: ${measuredExcessDb
      .map((value) => value.toFixed(2))
      .join(", ")} dB`,
  );
  assert.ok(
    Math.max(...measuredExcessDb) - Math.min(...measuredExcessDb) < 1,
    `the normalized differential should agree across rates: ${measuredExcessDb
      .map((value) => value.toFixed(2))
      .join(", ")} dB`,
  );
});
