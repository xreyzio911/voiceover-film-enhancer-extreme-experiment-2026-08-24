import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRenderedConsonantReference,
  RENDERED_CONSONANT_SOURCE_FRAME_MS,
} from "./gainPlanner.ts";
import {
  createNativeConsonantReferenceAccumulator,
  isConsonantReferenceBandwidthCompatible,
} from "./nativeConsonantReference.ts";

const assertFloatArraysClose = (
  actual: Float32Array,
  expected: Float32Array,
  tolerance = 1e-5,
) => {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= tolerance,
      `frame ${index}: expected ${expected[index]}, got ${actual[index]}`,
    );
  }
};

describe("native consonant reference accumulation", () => {
  it("requires near-native bandwidth before a final 48 kHz residual can use source evidence", () => {
    assert.equal(isConsonantReferenceBandwidthCompatible(48_000, 48_000), true);
    assert.equal(isConsonantReferenceBandwidthCompatible(44_100, 48_000), true);
    assert.equal(isConsonantReferenceBandwidthCompatible(16_000, 48_000), false);
    assert.equal(isConsonantReferenceBandwidthCompatible(0, 48_000), false);
    assert.equal(isConsonantReferenceBandwidthCompatible(48_000, Number.NaN), false);
  });

  it("matches one-shot 2 ms RMS and peak analysis across contiguous uneven chunks", () => {
    const sampleRate = 44100;
    const samples = Float32Array.from({ length: 1241 }, (_, index) => (
      Math.sin((index / sampleRate) * 2 * Math.PI * 237) * 0.19
      + Math.sin((index / sampleRate) * 2 * Math.PI * 6841) * 0.025
    ));
    const expected = buildRenderedConsonantReference(
      samples,
      sampleRate,
      RENDERED_CONSONANT_SOURCE_FRAME_MS,
    );
    assert.ok(expected);

    const accumulator = createNativeConsonantReferenceAccumulator({
      sampleRate,
      totalSampleCount: samples.length,
    });
    const boundaries = [0, 137, 489, 777, samples.length];
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const startSample = boundaries[index];
      const endSample = boundaries[index + 1];
      accumulator.append({
        samples: samples.slice(startSample, endSample),
        sourceStartSample: startSample,
      });
    }

    const actual = accumulator.finalize();
    assert.equal(actual.sampleRate, sampleRate);
    assert.equal(actual.frameMs, RENDERED_CONSONANT_SOURCE_FRAME_MS);
    assert.equal(actual.durationSec, samples.length / sampleRate);
    assertFloatArraysClose(actual.rmsDb, expected.rmsDb);
    assertFloatArraysClose(actual.peakDb, expected.peakDb);
  });

  it("places frames relative to a non-zero absolute source range", () => {
    const sampleRate = 48000;
    const referenceStartSample = 480_000;
    const samples = new Float32Array(960);
    samples.fill(0.01);
    samples.fill(0.5, 384, 480);
    const expected = buildRenderedConsonantReference(samples, sampleRate);
    assert.ok(expected);

    const accumulator = createNativeConsonantReferenceAccumulator({
      sampleRate,
      totalSampleCount: samples.length,
      referenceStartSample,
    });
    accumulator.append({
      samples: samples.slice(0, 431),
      sourceStartSample: referenceStartSample,
    });
    accumulator.append({
      samples: samples.slice(431),
      sourceStartSample: referenceStartSample + 431,
    });

    const actual = accumulator.finalize();
    assert.equal(actual.peakDb.indexOf(Math.max(...actual.peakDb)), 4);
    assertFloatArraysClose(actual.rmsDb, expected.rmsDb);
    assertFloatArraysClose(actual.peakDb, expected.peakDb);
  });

  it("ignores duplicate crossfade samples outside the chunk's unique source range", () => {
    const sampleRate = 48000;
    const firstUnique = new Float32Array(480).fill(0.02);
    const secondUnique = new Float32Array(480).fill(0.04);
    const expectedSamples = new Float32Array(firstUnique.length + secondUnique.length);
    expectedSamples.set(firstUnique, 0);
    expectedSamples.set(secondUnique, firstUnique.length);
    const expected = buildRenderedConsonantReference(expectedSamples, sampleRate);
    assert.ok(expected);

    // The first decoded chunk contains the production 20 ms look-ahead/
    // crossfade tail (960 samples at 48 kHz).
    // Poison it so this test fails loudly if the duplicate region is measured.
    const crossfadeSampleCount = Math.round(0.02 * sampleRate);
    const firstDecodedChunk = new Float32Array(firstUnique.length + crossfadeSampleCount);
    firstDecodedChunk.set(firstUnique, 0);
    firstDecodedChunk.fill(1, firstUnique.length);

    const accumulator = createNativeConsonantReferenceAccumulator({
      sampleRate,
      totalSampleCount: expectedSamples.length,
    });
    accumulator.append({
      samples: firstDecodedChunk,
      sourceStartSample: 0,
      uniqueStartSample: 0,
      uniqueEndSample: firstUnique.length,
    });
    accumulator.append({
      samples: secondUnique,
      sourceStartSample: firstUnique.length,
    });

    const actual = accumulator.finalize();
    assert.ok(Math.max(...actual.peakDb) < -20, "the poisoned overlap must not enter the reference");
    assertFloatArraysClose(actual.rmsDb, expected.rmsDb);
    assertFloatArraysClose(actual.peakDb, expected.peakDb);
  });

  it("preallocates only compact frame envelopes for a 15-minute reference", () => {
    const sampleRate = 48000;
    const durationSec = 15 * 60;
    const accumulator = createNativeConsonantReferenceAccumulator({
      sampleRate,
      totalSampleCount: sampleRate * durationSec,
    });
    const expectedFrameCount = durationSec * (1000 / RENDERED_CONSONANT_SOURCE_FRAME_MS);
    const expectedBytes = expectedFrameCount * Float32Array.BYTES_PER_ELEMENT * 2;

    assert.equal(accumulator.frameCount, expectedFrameCount);
    assert.equal(accumulator.allocatedBytes, expectedBytes);
    assert.ok(accumulator.allocatedBytes < 4 * 1024 * 1024);
  });

  it("rejects gaps instead of silently manufacturing missing source evidence", () => {
    const accumulator = createNativeConsonantReferenceAccumulator({
      sampleRate: 48000,
      totalSampleCount: 960,
    });
    accumulator.append({
      samples: new Float32Array(480),
      sourceStartSample: 0,
    });

    assert.throws(
      () => accumulator.append({
        samples: new Float32Array(479),
        sourceStartSample: 481,
      }),
      /contiguous/i,
    );
  });

  it("can finalize the exact decoded tail when duration metadata rounds past the source", () => {
    const sampleRate = 48_000;
    // Mirrors a real 48 kHz fixture whose duration rounds 16 samples past its
    // decodable tail, scaled down so the regression stays memory-cheap.
    const declaredSampleCount = 1_216;
    const decodedSampleCount = 1_200;
    const tailStartSample = decodedSampleCount - 960;
    const accumulator = createNativeConsonantReferenceAccumulator({
      sampleRate,
      totalSampleCount: declaredSampleCount,
    });

    accumulator.append({
      samples: new Float32Array(tailStartSample),
      sourceStartSample: 0,
    });
    accumulator.append({
      samples: new Float32Array(960).fill(0.04),
      sourceStartSample: tailStartSample,
    });

    const reference = accumulator.finalize({ allowTrailingShortfall: true });

    assert.equal(reference.durationSec, decodedSampleCount / sampleRate);
    assert.equal(reference.rmsDb.length, Math.ceil(decodedSampleCount / (sampleRate * 0.002)));
    assert.equal(reference.rmsDb.length, reference.peakDb.length);
  });
});
