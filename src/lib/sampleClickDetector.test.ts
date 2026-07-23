import assert from "node:assert/strict";
import test from "node:test";

import {
  countAdaptiveSampleClickDiscontinuities,
  countAdaptiveSampleClickDiscontinuitiesBounded,
} from "./sampleClickDetector.ts";

const toDb = (value: number) => (value <= 0 ? -120 : 20 * Math.log10(value));

const measureFrames = (samples: Float32Array, sampleRate: number) => {
  const frameSize = Math.max(1, Math.round(sampleRate * 0.01));
  const frameCount = Math.floor(samples.length / frameSize);
  const frameRms = new Array<number>(frameCount);
  const frameSharpness = new Array<number>(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameSize;
    let sumSquares = 0;
    let sharpEnergy = 0;
    for (let offset = 0; offset < frameSize; offset += 1) {
      const value = samples[start + offset] ?? 0;
      const previous = offset > 0 ? samples[start + offset - 1] ?? 0 : value;
      const next = offset + 1 < frameSize ? samples[start + offset + 1] ?? 0 : value;
      const spike = value - (previous + next) * 0.5;
      sumSquares += value * value;
      sharpEnergy += spike * spike;
    }
    frameRms[frame] = Math.sqrt(sumSquares / frameSize);
    frameSharpness[frame] = toDb(Math.sqrt(sharpEnergy / frameSize) + 1e-12);
  }

  return { frameSize, frameRms, frameSharpness };
};

const countBothWays = async (
  samples: Float32Array,
  sampleRate: number,
  alignedCoreSamples: number,
) => {
  const frames = measureFrames(samples, sampleRate);
  const full = countAdaptiveSampleClickDiscontinuities({
    samples,
    sampleRate,
    ...frames,
    globalSampleOffset: 0,
    coreStartSample: 0,
    coreEndSample: samples.length,
  });
  const loads: Array<{ start: number; end: number }> = [];
  const bounded = await countAdaptiveSampleClickDiscontinuitiesBounded({
    totalSamples: samples.length,
    sampleRate,
    ...frames,
    alignedCoreSamples,
    loadSamples: async (start, end) => {
      loads.push({ start, end });
      return samples.slice(start, end);
    },
  });

  return { full, bounded, loads, frames };
};

const buildSine = (
  length: number,
  sampleRate: number,
  frequencyHz = 181,
  gain = 0.035,
) => {
  const samples = new Float32Array(length);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate) * gain;
  }
  return samples;
};

const harmonicNormalization = (harmonicCount: number, spectralTilt: number) => {
  let result = 0;
  for (let harmonic = 1; harmonic <= harmonicCount; harmonic += 1) {
    result += 1 / Math.pow(harmonic, spectralTilt);
  }
  return result;
};

test("bounded click counting matches full-buffer counting at every core boundary side", async () => {
  for (const sampleRate of [16000, 44100, 48000]) {
    const frameSize = Math.round(sampleRate * 0.01);
    const coreSamples = frameSize * 13;
    const length = coreSamples * 4 + Math.floor(frameSize * 0.37) + 7;

    for (const boundaryOffset of [-1, 0, 1]) {
      const samples = buildSine(length, sampleRate);
      const clickIndex = coreSamples * 2 + boundaryOffset;
      samples[clickIndex] = boundaryOffset % 2 === 0 ? 0.72 : -0.72;

      const { full, bounded, loads } = await countBothWays(
        samples,
        sampleRate,
        coreSamples,
      );
      assert.equal(
        bounded.count,
        full.count,
        `${sampleRate} Hz boundary ${boundaryOffset} count`,
      );
      assert.equal(bounded.state.lastDiscontinuityGlobalIndex, full.state.lastDiscontinuityGlobalIndex);
      assert.ok(full.count >= 1, `${sampleRate} Hz boundary click should be detected`);
      assert.ok(loads.length > 1, "fixture must exercise more than one bounded core");
    }
  }
});

test("bounded click counting carries refractory state across adjacent cores", async () => {
  const sampleRate = 48000;
  const frameSize = Math.round(sampleRate * 0.01);
  const coreSamples = frameSize * 13;
  const samples = buildSine(coreSamples * 3, sampleRate);
  const firstClick = coreSamples - Math.round(sampleRate * 0.002);
  const secondClick = coreSamples + Math.round(sampleRate * 0.001);
  samples[firstClick] = 0.72;
  samples[secondClick] = 0.18;

  const { full, bounded } = await countBothWays(samples, sampleRate, coreSamples);
  assert.equal(full.count, 1, "full scan should collapse both clicks inside the 4 ms refractory period");
  assert.equal(bounded.count, full.count);
  assert.equal(bounded.state.lastDiscontinuityGlobalIndex, full.state.lastDiscontinuityGlobalIndex);
});

test("bounded click counting ignores smooth low-pitch voiced burst onsets", async () => {
  for (const sampleRate of [16000, 48000]) {
    const durationSec = 2.4;
    const fundamentalHz = 60;
    const spectralTilt = 1.25;
    const maxHarmonicHz = Math.min(12000, sampleRate * 0.44);
    const harmonicCount = Math.floor(maxHarmonicHz / fundamentalHz);
    const normalization = harmonicNormalization(harmonicCount, spectralTilt);
    const starts = [0.25, 0.95, 1.65];
    const burstDurationSec = 0.48;
    const attackSec = 0.02;
    const samples = new Float32Array(Math.round(sampleRate * durationSec));

    for (let index = 0; index < samples.length; index += 1) {
      const timeSec = index / sampleRate;
      let voice = 0;
      for (let harmonic = 1; harmonic <= harmonicCount; harmonic += 1) {
        voice +=
          Math.sin(2 * Math.PI * fundamentalHz * harmonic * timeSec) /
          Math.pow(harmonic, spectralTilt);
      }
      let envelope = 0;
      for (const startSec of starts) {
        const relativeSec = timeSec - startSec;
        if (relativeSec < 0 || relativeSec > burstDurationSec) continue;
        if (relativeSec < attackSec) {
          envelope = 0.5 - 0.5 * Math.cos((Math.PI * relativeSec) / attackSec);
        } else if (relativeSec > burstDurationSec - attackSec) {
          envelope =
            0.5 -
            0.5 * Math.cos((Math.PI * (burstDurationSec - relativeSec)) / attackSec);
        } else {
          envelope = 1;
        }
        break;
      }
      samples[index] = (voice * 0.12 * envelope) / normalization;
    }

    const { full, bounded } = await countBothWays(
      samples,
      sampleRate,
      Math.round(sampleRate * 0.17),
    );
    assert.equal(full.count, 0, `${sampleRate} Hz natural onset full count`);
    assert.equal(bounded.count, 0, `${sampleRate} Hz natural onset bounded count`);
  }
});

test("bounded click counting ignores continuous voiced pitch changes", async () => {
  for (const sampleRate of [16000, 48000]) {
    const durationSec = 2;
    const transitionSec = 1;
    const sourceHz = 100;
    const destinationHz = 250;
    const spectralTilt = 1.25;
    const harmonicCount = Math.floor(
      Math.min(12000, sampleRate * 0.44) / destinationHz,
    );
    const normalization = harmonicNormalization(harmonicCount, spectralTilt);
    const samples = new Float32Array(sampleRate * durationSec);

    for (let index = 0; index < samples.length; index += 1) {
      const timeSec = index / sampleRate;
      const cycles =
        timeSec < transitionSec
          ? sourceHz * timeSec
          : sourceHz * transitionSec + destinationHz * (timeSec - transitionSec);
      let value = 0;
      for (let harmonic = 1; harmonic <= harmonicCount; harmonic += 1) {
        value +=
          Math.sin(2 * Math.PI * harmonic * cycles + harmonic * 0.982) /
          Math.pow(harmonic, spectralTilt);
      }
      samples[index] = (value * 0.18) / normalization;
    }

    const { full, bounded } = await countBothWays(
      samples,
      sampleRate,
      Math.round(sampleRate * 0.2),
    );
    assert.equal(full.count, 0, `${sampleRate} Hz pitch change full count`);
    assert.equal(bounded.count, 0, `${sampleRate} Hz pitch change bounded count`);
  }
});

test("bounded click counting preserves DC-step detections and refractory state", async () => {
  for (const sampleRate of [16000, 44100, 48000]) {
    const frameSize = Math.round(sampleRate * 0.01);
    const coreSamples = frameSize * 19;
    const samples = buildSine(coreSamples * 5, sampleRate, 173, 0.04);
    const boundaries = [coreSamples, coreSamples * 2, coreSamples * 3];
    for (let index = boundaries[0]; index < samples.length; index += 1) {
      const offset = index < boundaries[1] ? 0.14 : index < boundaries[2] ? 0 : 0.14;
      samples[index] = (samples[index] ?? 0) + offset;
    }

    const { full, bounded } = await countBothWays(samples, sampleRate, coreSamples);
    assert.equal(bounded.count, full.count, `${sampleRate} Hz DC-step count`);
    assert.equal(bounded.state.lastDiscontinuityGlobalIndex, full.state.lastDiscontinuityGlobalIndex);
    assert.ok(full.count >= 3, `${sampleRate} Hz should retain all separated DC steps`);
  }
});

test("bounded click counting preserves zero-mean periodic phase-splice detections", async () => {
  const sampleRate = 16000;
  const fundamentalHz = 150;
  const spectralTilt = 1.25;
  const harmonicCount = Math.floor(Math.min(12000, sampleRate * 0.44) / fundamentalHz);
  const normalization = harmonicNormalization(harmonicCount, spectralTilt);
  const phases = [0, 1.2, -1, 2];
  const coreSamples = Math.round(sampleRate * 0.5);
  const boundaries = [coreSamples * 2, coreSamples * 4, coreSamples * 6];
  const samples = new Float32Array(coreSamples * 8);

  for (let index = 0; index < samples.length; index += 1) {
    const segment =
      index < boundaries[0] ? 0 : index < boundaries[1] ? 1 : index < boundaries[2] ? 2 : 3;
    const timeSec = index / sampleRate;
    let value = 0;
    for (let harmonic = 1; harmonic <= harmonicCount; harmonic += 1) {
      value +=
        Math.sin(
          2 * Math.PI * fundamentalHz * harmonic * timeSec +
            harmonic * (phases[segment] ?? 0),
        ) / Math.pow(harmonic, spectralTilt);
    }
    samples[index] = (value * 0.36) / normalization;
  }

  const { full, bounded } = await countBothWays(samples, sampleRate, coreSamples);
  assert.equal(bounded.count, full.count);
  assert.equal(bounded.state.lastDiscontinuityGlobalIndex, full.state.lastDiscontinuityGlobalIndex);
  assert.ok(full.count >= 2, "audible zero-mean phase seams should remain detectable");
});

test("bounded click counting matches through a non-frame-aligned final core", async () => {
  const sampleRate = 44100;
  const frameSize = Math.round(sampleRate * 0.01);
  const coreSamples = frameSize * 11;
  const length = coreSamples * 2 + Math.floor(frameSize * 0.43) + 3;
  const samples = buildSine(length, sampleRate, 197, 0.025);
  samples[length - 2] = 0.8;

  const { full, bounded, loads, frames } = await countBothWays(
    samples,
    sampleRate,
    coreSamples,
  );
  assert.notEqual(length % frames.frameSize, 0, "fixture must have a partial final frame");
  assert.equal(bounded.count, full.count);
  assert.equal(bounded.state.lastDiscontinuityGlobalIndex, full.state.lastDiscontinuityGlobalIndex);
  assert.ok(full.count >= 1, "penultimate-sample click should be detected");
  assert.equal(loads.at(-1)?.end, length, "final bounded load must clamp to exact file length");
});
