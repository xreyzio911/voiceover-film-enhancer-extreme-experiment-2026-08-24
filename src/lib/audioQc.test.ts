import assert from "node:assert/strict";
import test from "node:test";
import { analyzeFloatSamples, analyzeFrameAudio, buildSpeechMask } from "./audioQc.ts";

const FRAME_MS = 10;
const SAMPLE_RATE = 16000;

type Section = {
  frames: number;
  fromDb: number;
  toDb?: number;
  peakLiftDb?: number;
  sharpnessDb?: number;
};

const ampFromDb = (db: number) => Math.pow(10, db / 20);

const buildContinuousSignal = (
  durationSec: number,
  sampleAt: (timeSec: number) => number,
  sampleRate = SAMPLE_RATE,
) => {
  const samples = new Float32Array(Math.round(durationSec * sampleRate));
  const fadeSamples = Math.round(sampleRate * 0.025);

  for (let index = 0; index < samples.length; index += 1) {
    const edgeDistance = Math.min(index, samples.length - 1 - index);
    const fade = Math.min(1, edgeDistance / Math.max(fadeSamples, 1));
    samples[index] = sampleAt(index / sampleRate) * fade;
  }

  return samples;
};

const analyzeSections = (sections: Section[]) => {
  const frameDb: number[] = [];
  const frameRms: number[] = [];
  const framePeak: number[] = [];
  const frameSharpness: number[] = [];

  for (const section of sections) {
    for (let index = 0; index < section.frames; index += 1) {
      const progress = section.frames <= 1 ? 0 : index / (section.frames - 1);
      const db = section.fromDb + ((section.toDb ?? section.fromDb) - section.fromDb) * progress;
      const rms = ampFromDb(db);
      const peak = Math.min(0.98, rms * ampFromDb(section.peakLiftDb ?? 10));

      frameDb.push(db);
      frameRms.push(rms);
      framePeak.push(peak);
      frameSharpness.push(section.sharpnessDb ?? -60);
    }
  }

  return analyzeFrameAudio(frameRms, framePeak, frameDb, frameSharpness, {
    sampleRate: SAMPLE_RATE,
    durationSec: (frameDb.length * FRAME_MS) / 1000,
    frameMs: FRAME_MS,
    peakDb: null,
    clipPct: 0,
    sampleSpikeCount: 0,
  });
};

test("buildSpeechMask keeps soft endings active and bridges short gaps", () => {
  const frameDb = [
    ...new Array(60).fill(-74),
    ...new Array(20).fill(-29),
    ...new Array(8).fill(-62),
    ...new Array(6).fill(-66),
    ...new Array(18).fill(-30),
    ...new Array(20).fill(-74),
  ];

  const mask = buildSpeechMask(frameDb, -74, { frameMs: FRAME_MS });

  assert.equal(mask.slice(80, 88).every(Boolean), true);
  assert.equal(mask.slice(88, 94).every(Boolean), true);
  assert.equal(mask.slice(0, 50).some(Boolean), false);
});

test("buildSpeechMask holds quiet trailing speech below close threshold for at least 150 ms", () => {
  const tailStart = 160;
  const frameDb = [
    ...new Array(60).fill(-82),
    ...new Array(100).fill(-28),
    ...new Array(20).fill(-65),
    ...new Array(20).fill(-82),
  ];

  const mask = buildSpeechMask(frameDb, -82, { frameMs: FRAME_MS });

  assert.equal(mask.slice(tailStart, tailStart + 15).every(Boolean), true);
});

test("protected steady endings avoid fade and pause-noise flags", () => {
  const protectedTail = analyzeSections([
    { frames: 120, fromDb: -75 },
    { frames: 30, fromDb: -32, toDb: -28 },
    { frames: 140, fromDb: -28 },
    { frames: 25, fromDb: -28, toDb: -31 },
    { frames: 5, fromDb: -75 },
    { frames: 90, fromDb: -29 },
    { frames: 20, fromDb: -29, toDb: -31 },
  ]);

  assert.ok(protectedTail.onsetOvershootScore < 0.1);
  assert.ok(protectedTail.endFadeRiskScore < 0.1);
  assert.ok(protectedTail.pauseNoiseRisk < 0.1);
});

test("onset spike scoring rises for hot first-word entries", () => {
  const steady = analyzeSections([
    { frames: 120, fromDb: -75 },
    { frames: 180, fromDb: -28 },
    { frames: 100, fromDb: -75 },
  ]);
  const onsetHeavy = analyzeSections([
    { frames: 120, fromDb: -75 },
    { frames: 24, fromDb: -20 },
    { frames: 156, fromDb: -28 },
    { frames: 100, fromDb: -75 },
  ]);

  assert.ok(onsetHeavy.onsetOvershootScore > steady.onsetOvershootScore + 0.35);
});

test("mid-line sag scoring rises when the center of the line collapses", () => {
  const protectedTail = analyzeSections([
    { frames: 120, fromDb: -75 },
    { frames: 30, fromDb: -32, toDb: -28 },
    { frames: 140, fromDb: -28 },
    { frames: 25, fromDb: -28, toDb: -31 },
    { frames: 5, fromDb: -75 },
    { frames: 90, fromDb: -29 },
    { frames: 20, fromDb: -29, toDb: -31 },
  ]);
  const sagging = analyzeSections([
    { frames: 120, fromDb: -75 },
    { frames: 40, fromDb: -30, toDb: -28 },
    { frames: 50, fromDb: -28 },
    { frames: 70, fromDb: -38 },
    { frames: 50, fromDb: -28 },
    { frames: 40, fromDb: -28, toDb: -30 },
    { frames: 100, fromDb: -75 },
  ]);

  assert.ok(sagging.midLineSagScore > protectedTail.midLineSagScore + 0.3);
});

test("end-fade scoring rises when the last word drops away before silence", () => {
  const protectedTail = analyzeSections([
    { frames: 120, fromDb: -75 },
    { frames: 30, fromDb: -32, toDb: -28 },
    { frames: 140, fromDb: -28 },
    { frames: 25, fromDb: -28, toDb: -31 },
    { frames: 5, fromDb: -75 },
    { frames: 90, fromDb: -29 },
    { frames: 20, fromDb: -29, toDb: -31 },
  ]);
  const fadedTail = analyzeSections([
    { frames: 120, fromDb: -75 },
    { frames: 30, fromDb: -32, toDb: -28 },
    { frames: 140, fromDb: -28 },
    { frames: 25, fromDb: -28, toDb: -42 },
    { frames: 100, fromDb: -75 },
  ]);

  assert.ok(fadedTail.endFadeRiskScore > protectedTail.endFadeRiskScore + 0.6);
});

test("end-edge dip metric catches a short final-phoneme level drop", () => {
  const steadyEnding = analyzeSections([
    { frames: 100, fromDb: -78 },
    { frames: 160, fromDb: -27 },
    { frames: 30, fromDb: -78 },
  ]);
  const dippedEnding = analyzeSections([
    { frames: 100, fromDb: -78 },
    { frames: 145, fromDb: -27 },
    { frames: 15, fromDb: -33 },
    { frames: 30, fromDb: -78 },
  ]);

  assert.ok(
    steadyEnding.endEdgeDipDb < 2.0,
    `steady ending should stay below warning level, got ${steadyEnding.endEdgeDipDb.toFixed(1)} dB`,
  );
  assert.ok(dippedEnding.endEdgeDipDb > 4.5, `dipped ending should expose a short edge dip, got ${dippedEnding.endEdgeDipDb.toFixed(1)} dB`);
});

test("end-edge dip metric keeps damaged speech tails in the measured tail", () => {
  const damagedTail = analyzeSections([
    { frames: 100, fromDb: -78 },
    { frames: 145, fromDb: -27 },
    { frames: 15, fromDb: -39 },
    { frames: 30, fromDb: -78 },
  ]);

  assert.ok(
    damagedTail.endEdgeDipDb > 9,
    `damaged speech tail should not be trimmed out before scoring, got ${damagedTail.endEdgeDipDb.toFixed(1)} dB`,
  );
});

test("pause-noise scoring rises when long silences stay lifted", () => {
  const quietPauses = analyzeSections([
    { frames: 120, fromDb: -80 },
    { frames: 180, fromDb: -28 },
    { frames: 160, fromDb: -80 },
  ]);
  const noisyPauses = analyzeSections([
    { frames: 120, fromDb: -50 },
    { frames: 180, fromDb: -30 },
    { frames: 160, fromDb: -50 },
  ]);

  assert.ok(noisyPauses.pauseNoiseRisk > quietPauses.pauseNoiseRisk + 0.3);
});

test("echo scoring does not treat clean rhythmic speech correlation as room echo", () => {
  const rhythmicSpeech: Section[] = [];
  for (let index = 0; index < 50; index += 1) {
    rhythmicSpeech.push({ frames: 4, fromDb: -30 }, { frames: 4, fromDb: -78 });
  }

  const metrics = analyzeSections(rhythmicSpeech);

  assert.ok(metrics.reverbScore < 0.05);
  assert.ok(metrics.echoScore < 0.08);
  assert.equal(metrics.echoDelayMs, null);
});

test("echo scoring still flags real room tails with supported short-lag correlation", () => {
  const roomy = analyzeSections([
    { frames: 120, fromDb: -78 },
    { frames: 120, fromDb: -30 },
    { frames: 18, fromDb: -35, toDb: -42 },
    { frames: 22, fromDb: -42, toDb: -48 },
    { frames: 70, fromDb: -78 },
    { frames: 110, fromDb: -30 },
    { frames: 18, fromDb: -35, toDb: -42 },
    { frames: 22, fromDb: -42, toDb: -48 },
    { frames: 80, fromDb: -78 },
  ]);

  assert.ok(roomy.reverbScore > 0.35);
  assert.ok(roomy.echoScore >= 0.38);
  assert.notEqual(roomy.echoDelayMs, null);
});

test("breath-spike scoring rises for isolated inhale bursts before speech", () => {
  const protectedTail = analyzeSections([
    { frames: 120, fromDb: -75 },
    { frames: 30, fromDb: -32, toDb: -28 },
    { frames: 140, fromDb: -28 },
    { frames: 25, fromDb: -28, toDb: -31 },
    { frames: 5, fromDb: -75 },
    { frames: 90, fromDb: -29 },
    { frames: 20, fromDb: -29, toDb: -31 },
  ]);
  const breathy = analyzeSections([
    { frames: 120, fromDb: -75 },
    { frames: 8, fromDb: -47, peakLiftDb: 15, sharpnessDb: -45 },
    { frames: 20, fromDb: -75 },
    { frames: 25, fromDb: -32, toDb: -28 },
    { frames: 120, fromDb: -28 },
    { frames: 20, fromDb: -28, toDb: -31 },
    { frames: 20, fromDb: -75 },
    { frames: 10, fromDb: -46, peakLiftDb: 14, sharpnessDb: -44 },
    { frames: 18, fromDb: -75 },
    { frames: 70, fromDb: -29 },
    { frames: 20, fromDb: -29, toDb: -31 },
  ]);

  assert.ok(breathy.breathSpikeRisk > protectedTail.breathSpikeRisk + 0.5);
});

test("sentence-jump scoring rises when grouped lines land at different body levels", () => {
  const protectedTail = analyzeSections([
    { frames: 120, fromDb: -75 },
    { frames: 30, fromDb: -32, toDb: -28 },
    { frames: 140, fromDb: -28 },
    { frames: 25, fromDb: -28, toDb: -31 },
    { frames: 5, fromDb: -75 },
    { frames: 90, fromDb: -29 },
    { frames: 20, fromDb: -29, toDb: -31 },
  ]);
  const jumpy = analyzeSections([
    { frames: 120, fromDb: -75 },
    { frames: 30, fromDb: -32, toDb: -28 },
    { frames: 120, fromDb: -28 },
    { frames: 20, fromDb: -28, toDb: -31 },
    { frames: 28, fromDb: -75 },
    { frames: 28, fromDb: -38, toDb: -33 },
    { frames: 90, fromDb: -33 },
    { frames: 20, fromDb: -33, toDb: -35 },
  ]);

  assert.ok(jumpy.sentenceJumpScore > protectedTail.sentenceJumpScore + 0.45);
});

test("cold-open scoring measures quiet heads against later dialogue body", () => {
  const dipped = analyzeSections([
    { frames: 100, fromDb: -78 },
    { frames: 110, fromDb: -34 },
    { frames: 24, fromDb: -78 },
    { frames: 110, fromDb: -34 },
    { frames: 28, fromDb: -78 },
    { frames: 150, fromDb: -30 },
    { frames: 32, fromDb: -78 },
    { frames: 150, fromDb: -30 },
    { frames: 100, fromDb: -78 },
  ]);

  assert.ok(
    Math.abs(dipped.coldOpenDipDb - 4) < 0.35,
    `expected ~4 dB cold-open dip, got ${dipped.coldOpenDipDb}`,
  );
  assert.ok(
    Math.abs(dipped.coldOpenRiskScore - 0.75) < 0.12,
    `expected ~0.75 cold-open risk, got ${dipped.coldOpenRiskScore}`,
  );
});

test("cold-open scoring stays near zero for flat dialogue heads", () => {
  const flat = analyzeSections([
    { frames: 100, fromDb: -78 },
    { frames: 110, fromDb: -30 },
    { frames: 24, fromDb: -78 },
    { frames: 110, fromDb: -30 },
    { frames: 28, fromDb: -78 },
    { frames: 150, fromDb: -30 },
    { frames: 32, fromDb: -78 },
    { frames: 150, fromDb: -30 },
    { frames: 100, fromDb: -78 },
  ]);

  assert.ok(Math.abs(flat.coldOpenDipDb) < 0.35, `expected flat cold-open dip, got ${flat.coldOpenDipDb}`);
  assert.equal(flat.coldOpenRiskScore, 0);
});

test("cold-open scoring trims first-run edges before comparing to the later body", () => {
  const edgedHeads = analyzeSections([
    { frames: 100, fromDb: -78 },
    { frames: 10, fromDb: -42 },
    { frames: 35, fromDb: -30 },
    { frames: 10, fromDb: -42 },
    { frames: 24, fromDb: -78 },
    { frames: 10, fromDb: -42 },
    { frames: 35, fromDb: -30 },
    { frames: 10, fromDb: -42 },
    { frames: 24, fromDb: -78 },
    { frames: 10, fromDb: -42 },
    { frames: 35, fromDb: -30 },
    { frames: 10, fromDb: -42 },
    { frames: 32, fromDb: -78 },
    { frames: 150, fromDb: -30 },
    { frames: 100, fromDb: -78 },
  ]);

  assert.ok(
    edgedHeads.coldOpenDipDb < 1,
    `edge-only first-run dips should not trigger a cold-open warning, got ${edgedHeads.coldOpenDipDb}`,
  );
  assert.equal(edgedHeads.coldOpenRiskScore, 0);
});

test("cold-open scoring includes short opening words", () => {
  const shortOpener = analyzeSections([
    { frames: 80, fromDb: -78 },
    { frames: 28, fromDb: -34 },
    { frames: 18, fromDb: -78 },
    { frames: 100, fromDb: -27 },
    { frames: 20, fromDb: -78 },
    { frames: 100, fromDb: -27 },
    { frames: 80, fromDb: -78 },
  ]);

  assert.ok(
    shortOpener.coldOpenDipDb > 5,
    `short opening words should contribute to cold-open scoring, got ${shortOpener.coldOpenDipDb.toFixed(1)} dB`,
  );
});

test("sparse sentence-jump scoring still rises when isolated lines land at different levels", () => {
  const steadySparse = analyzeSections([
    { frames: 200, fromDb: -78 },
    { frames: 80, fromDb: -30 },
    { frames: 180, fromDb: -78 },
    { frames: 76, fromDb: -30 },
    { frames: 220, fromDb: -78 },
    { frames: 72, fromDb: -30 },
    { frames: 180, fromDb: -78 },
  ]);
  const jumpySparse = analyzeSections([
    { frames: 200, fromDb: -78 },
    { frames: 80, fromDb: -29 },
    { frames: 180, fromDb: -78 },
    { frames: 76, fromDb: -36 },
    { frames: 220, fromDb: -78 },
    { frames: 72, fromDb: -31 },
    { frames: 180, fromDb: -78 },
  ]);

  assert.ok(jumpySparse.sentenceJumpScore > steadySparse.sentenceJumpScore + 0.28);
});

test("lead-in breath-spike scoring rises for short pre-word transients above following speech", () => {
  const steady = analyzeSections([
    { frames: 180, fromDb: -78 },
    { frames: 24, fromDb: -78 },
    { frames: 24, fromDb: -31 },
    { frames: 80, fromDb: -29 },
    { frames: 200, fromDb: -78 },
  ]);
  const leadBurst = analyzeSections([
    { frames: 180, fromDb: -78 },
    { frames: 6, fromDb: -48, peakLiftDb: 28, sharpnessDb: -50 },
    { frames: 24, fromDb: -78 },
    { frames: 24, fromDb: -31 },
    { frames: 80, fromDb: -29 },
    { frames: 200, fromDb: -78 },
  ]);

  assert.ok(leadBurst.breathSpikeRisk > steady.breathSpikeRisk + 0.18);
});

test("click scoring ignores normal high-crest speech consonants", () => {
  const cleanConsonants = analyzeSections([
    { frames: 120, fromDb: -78 },
    { frames: 180, fromDb: -29, peakLiftDb: 22, sharpnessDb: -30 },
    { frames: 100, fromDb: -78 },
  ]);

  assert.ok(cleanConsonants.clickScore < 0.08);
});

test("click scoring still rises for repeated isolated non-speech clicks", () => {
  const clickBursts: Section[] = [{ frames: 60, fromDb: -78 }];
  for (let index = 0; index < 8; index += 1) {
    clickBursts.push({ frames: 4, fromDb: -56, peakLiftDb: 35, sharpnessDb: -20 });
    clickBursts.push({ frames: 8, fromDb: -78 });
  }
  clickBursts.push({ frames: 120, fromDb: -29 });

  const clicky = analyzeSections(clickBursts);

  assert.ok(clicky.clickScore > 0.12);
});

test("sample click scoring ignores a smooth high-frequency voiced signal", () => {
  const samples = buildContinuousSignal(
    4,
    (timeSec) => Math.sin(2 * Math.PI * 1800 * timeSec) * 0.24,
  );

  const analysis = analyzeFloatSamples(samples, SAMPLE_RATE);

  assert.ok(
    analysis.clickScore < 0.08,
    `smooth 1.8 kHz content should not look clicky, got ${analysis.clickScore.toFixed(3)}`,
  );
});

test("sample click scoring ignores sustained fricative-like high-frequency energy", () => {
  const samples = buildContinuousSignal(4, (timeSec) => {
    const slowEnvelope = 0.72 + Math.sin(2 * Math.PI * 3.1 * timeSec) * 0.18;
    const fricative =
      Math.sin(2 * Math.PI * 2700 * timeSec + 0.2) * 0.065 +
      Math.sin(2 * Math.PI * 3850 * timeSec + 1.1) * 0.05 +
      Math.sin(2 * Math.PI * 5370 * timeSec + 2.3) * 0.035;
    return fricative * slowEnvelope;
  });

  const analysis = analyzeFloatSamples(samples, SAMPLE_RATE);

  assert.ok(
    analysis.clickScore < 0.08,
    `continuous fricative energy should not look clicky, got ${analysis.clickScore.toFixed(3)}`,
  );
});

test("sample click scoring ignores periodic glottal-like voiced edges", () => {
  const sampleRate = 48000;
  const durationSec = 4;
  const fundamentalHz = 100;
  const spectralTilt = 1.25;
  const maxHarmonicHz = 12000;
  const harmonicCount = maxHarmonicHz / fundamentalHz;
  const scale = 0.12;
  const fadeSamples = Math.round(sampleRate * 0.025);
  const normalization = Array.from(
    { length: harmonicCount },
    (_, index) => 1 / Math.pow(index + 1, spectralTilt),
  ).reduce((sum, value) => sum + value, 0);
  const samples = new Float32Array(sampleRate * durationSec);

  for (let index = 0; index < samples.length; index += 1) {
    const timeSec = index / sampleRate;
    let value = 0;
    for (let harmonic = 1; harmonic <= harmonicCount; harmonic += 1) {
      value +=
        Math.sin(2 * Math.PI * fundamentalHz * harmonic * timeSec) /
        Math.pow(harmonic, spectralTilt);
    }
    const edgeDistance = Math.min(index, samples.length - 1 - index);
    const fade = Math.min(1, edgeDistance / Math.max(fadeSamples, 1));
    samples[index] = (scale * value * fade) / normalization;
  }

  const analysis = analyzeFloatSamples(samples, sampleRate);

  assert.ok(
    analysis.clickScore < 0.08,
    `periodic voiced edges should not look clicky, got ${analysis.clickScore.toFixed(3)}`,
  );
});

test("sample click scoring ignores smooth low-pitch voiced burst onsets", () => {
  const sampleRate = 16000;
  const totalDurationSec = 4;
  const fundamentalHz = 60;
  const spectralTilt = 1.25;
  const maxHarmonicHz = Math.min(12000, sampleRate * 0.44);
  const harmonicCount = Math.floor(maxHarmonicHz / fundamentalHz);
  const scale = 0.12;
  const burstStartsSec = [0.35, 1.35, 2.35];
  const burstDurationSec = 0.55;
  const attackSec = 0.02;
  const releaseSec = attackSec;
  const normalization = Array.from(
    { length: harmonicCount },
    (_, index) => 1 / Math.pow(index + 1, spectralTilt),
  ).reduce((sum, value) => sum + value, 0);
  const samples = new Float32Array(sampleRate * totalDurationSec);

  for (let index = 0; index < samples.length; index += 1) {
    const timeSec = index / sampleRate;
    let value = 0;
    for (let harmonic = 1; harmonic <= harmonicCount; harmonic += 1) {
      value +=
        Math.sin(2 * Math.PI * fundamentalHz * harmonic * timeSec) /
        Math.pow(harmonic, spectralTilt);
    }

    let envelope = 0;
    for (const startSec of burstStartsSec) {
      const relativeSec = timeSec - startSec;
      if (relativeSec < 0 || relativeSec > burstDurationSec) continue;
      if (relativeSec < attackSec) {
        envelope = 0.5 - 0.5 * Math.cos((Math.PI * relativeSec) / attackSec);
      } else if (relativeSec > burstDurationSec - releaseSec) {
        envelope =
          0.5 -
          0.5 * Math.cos((Math.PI * (burstDurationSec - relativeSec)) / releaseSec);
      } else {
        envelope = 1;
      }
      break;
    }

    samples[index] = (scale * value * envelope) / normalization;
  }

  const analysis = analyzeFloatSamples(samples, sampleRate);
  assert.ok(
    analysis.clickScore < 0.08,
    `smooth low-pitch voice onsets should not look clicky, got ${analysis.clickScore.toFixed(3)}`,
  );
});

test("sample click scoring ignores phase-continuous voiced pitch changes", () => {
  const sampleRate = 16000;
  const durationSec = 4;
  const transitionSec = 2;
  const spectralTilt = 1.25;
  const scale = 0.18;

  for (const destinationHz of [150, 200, 250, 300]) {
    for (const initialPhase of [0.2, 0.982]) {
      const sourceHz = 100;
      const harmonicCount = Math.floor(
        Math.min(12000, sampleRate * 0.44) / Math.max(sourceHz, destinationHz),
      );
      const normalization = Array.from(
        { length: harmonicCount },
        (_, index) => 1 / Math.pow(index + 1, spectralTilt),
      ).reduce((sum, value) => sum + value, 0);
      const samples = new Float32Array(sampleRate * durationSec);
      const fadeSamples = Math.round(sampleRate * 0.025);

      for (let index = 0; index < samples.length; index += 1) {
        const timeSec = index / sampleRate;
        const fundamentalCycles =
          timeSec < transitionSec
            ? sourceHz * timeSec
            : sourceHz * transitionSec + destinationHz * (timeSec - transitionSec);
        let value = 0;
        for (let harmonic = 1; harmonic <= harmonicCount; harmonic += 1) {
          value +=
            Math.sin(
              2 * Math.PI * harmonic * fundamentalCycles + harmonic * initialPhase,
            ) / Math.pow(harmonic, spectralTilt);
        }
        const edgeDistance = Math.min(index, samples.length - 1 - index);
        const fade = Math.min(1, edgeDistance / Math.max(fadeSamples, 1));
        samples[index] = (scale * value * fade) / normalization;
      }

      const boundaryIndex = Math.round(transitionSec * sampleRate);
      const boundaryJump = Math.abs(
        (samples[boundaryIndex] ?? 0) - (samples[boundaryIndex - 1] ?? 0),
      );
      assert.ok(
        boundaryJump < 0.02,
        `${sourceHz}->${destinationHz} Hz fixture must remain sample-continuous, got ${boundaryJump}`,
      );

      const analysis = analyzeFloatSamples(samples, sampleRate);
      assert.ok(
        analysis.clickScore < 0.08,
        `${sourceHz}->${destinationHz} Hz continuous pitch change should not look clicky, got ${analysis.clickScore.toFixed(3)}`,
      );
    }
  }
});

test("sample click scoring ignores an accented multi-sample voiced closure", () => {
  for (const sampleRate of [16000, 48000]) {
    const samples = buildContinuousSignal(
      4,
      (timeSec) => Math.sin(2 * Math.PI * 115 * timeSec) * 0.025,
      sampleRate,
    );
    const pitchPeriod = Math.round(sampleRate / 100);
    const firstLobeEnd = Math.max(1, Math.round(sampleRate * 0.0005));
    const secondLobeEnd = Math.max(firstLobeEnd + 1, Math.round(sampleRate * 0.0009));

    for (let start = pitchPeriod; start + secondLobeEnd < samples.length; start += pitchPeriod) {
      const isAccentedClosure = Math.abs(start / sampleRate - 2) < 0.005;
      const amplitude = isAccentedClosure ? 0.12 : 0.04;
      for (let offset = 0; offset < secondLobeEnd; offset += 1) {
        const lobe = offset < firstLobeEnd ? amplitude : amplitude / 3;
        samples[start + offset] = (samples[start + offset] ?? 0) + lobe;
      }
    }

    const analysis = analyzeFloatSamples(samples, sampleRate);
    assert.ok(
      analysis.clickScore < 0.08,
      `${sampleRate} Hz accented voiced closure should stay below click warning, got ${analysis.clickScore.toFixed(3)}`,
    );
  }
});

test("sample click scoring detects hard splice steps inside periodic voiced energy across rates", () => {
  for (const sampleRate of [16000, 48000]) {
    const durationSec = 4;
    const fundamentalHz = 100;
    const spectralTilt = 1.25;
    const maxHarmonicHz = Math.min(12000, sampleRate * 0.44);
    const harmonicCount = Math.floor(maxHarmonicHz / fundamentalHz);
    const scale = 0.12;
    const step = 0.12;
    const fadeSamples = Math.round(sampleRate * 0.025);
    const normalization = Array.from(
      { length: harmonicCount },
      (_, index) => 1 / Math.pow(index + 1, spectralTilt),
    ).reduce((sum, value) => sum + value, 0);
    const edgeIndices = [1, 2, 3].map(
      (second) => second * sampleRate + Math.round(sampleRate * 0.005),
    );
    const samples = new Float32Array(sampleRate * durationSec);

    for (let index = 0; index < samples.length; index += 1) {
      const timeSec = index / sampleRate;
      let value = 0;
      for (let harmonic = 1; harmonic <= harmonicCount; harmonic += 1) {
        value +=
          Math.sin(2 * Math.PI * fundamentalHz * harmonic * timeSec) /
          Math.pow(harmonic, spectralTilt);
      }
      let offset = 0;
      if (index >= edgeIndices[0]) offset = step;
      if (index >= edgeIndices[1]) offset = 0;
      if (index >= edgeIndices[2]) offset = step;

      const edgeDistance = Math.min(index, samples.length - 1 - index);
      const fade = Math.min(1, edgeDistance / Math.max(fadeSamples, 1));
      samples[index] = ((scale * value) / normalization + offset) * fade;
    }

    const spliceJumps = edgeIndices.map((index) =>
      Math.abs((samples[index] ?? 0) - (samples[index - 1] ?? 0)),
    );
    assert.ok(
      spliceJumps.every((jump) => jump > 0.11),
      `${sampleRate} Hz fixture must retain its hard splice steps: ${spliceJumps.join(", ")}`,
    );

    const analysis = analyzeFloatSamples(samples, sampleRate);
    assert.ok(
      analysis.clickScore > 0.12,
      `${sampleRate} Hz voiced hard splices should remain detectable, got ${analysis.clickScore.toFixed(3)}`,
    );
  }
});

test("sample click scoring detects voiced hard splices across 16 kHz pitch and phase", () => {
  const sampleRate = 16000;
  const durationSec = 4;
  const spectralTilt = 1.25;
  const scale = 0.12;
  const step = 0.12;
  const fadeSamples = Math.round(sampleRate * 0.025);

  for (const fundamentalHz of [100, 220]) {
    const harmonicCount = Math.floor(
      Math.min(12000, sampleRate * 0.44) / fundamentalHz,
    );
    const normalization = Array.from(
      { length: harmonicCount },
      (_, index) => 1 / Math.pow(index + 1, spectralTilt),
    ).reduce((sum, value) => sum + value, 0);
    const baseSamples = new Float32Array(sampleRate * durationSec);

    for (let index = 0; index < baseSamples.length; index += 1) {
      const timeSec = index / sampleRate;
      let value = 0;
      for (let harmonic = 1; harmonic <= harmonicCount; harmonic += 1) {
        value +=
          Math.sin(2 * Math.PI * fundamentalHz * harmonic * timeSec) /
          Math.pow(harmonic, spectralTilt);
      }
      const edgeDistance = Math.min(index, baseSamples.length - 1 - index);
      const fade = Math.min(1, edgeDistance / Math.max(fadeSamples, 1));
      baseSamples[index] = ((scale * value) / normalization) * fade;
    }

    let audiblePhaseCount = 0;
    for (let phaseOffsetMs = 0; phaseOffsetMs <= 9; phaseOffsetMs += 1) {
      const edgeIndices = [1, 2, 3].map(
        (second) => second * sampleRate + Math.round((sampleRate * phaseOffsetMs) / 1000),
      );
      const samples = baseSamples.slice();
      for (let index = edgeIndices[0]; index < samples.length; index += 1) {
        let offset = step;
        if (index >= edgeIndices[1]) offset = 0;
        if (index >= edgeIndices[2]) offset = step;
        const edgeDistance = Math.min(index, samples.length - 1 - index);
        const fade = Math.min(1, edgeDistance / Math.max(fadeSamples, 1));
        samples[index] = (samples[index] ?? 0) + offset * fade;
      }

      const spliceJumps = edgeIndices.map((index) =>
        Math.abs((samples[index] ?? 0) - (samples[index - 1] ?? 0)),
      );
      if (!spliceJumps.every((jump) => jump > 0.11)) continue;
      audiblePhaseCount += 1;
      const analysis = analyzeFloatSamples(samples, sampleRate);
      assert.ok(
        analysis.clickScore > 0.12,
        `${fundamentalHz} Hz voice at ${phaseOffsetMs} ms phase should detect hard splices, got ${analysis.clickScore.toFixed(3)}`,
      );
    }
    assert.ok(
      audiblePhaseCount >= 8,
      `${fundamentalHz} Hz fixture should cover most pitch phases, got ${audiblePhaseCount}`,
    );
  }
});

test("sample click scoring detects high-pitch voiced splices across common rates and phases", () => {
  const durationSec = 4;
  const fundamentalHz = 320;
  const spectralTilt = 1.25;
  const scale = 0.12;
  const step = 0.12;

  for (const sampleRate of [16000, 44100]) {
    const fadeSamples = Math.round(sampleRate * 0.025);
    const harmonicCount = Math.floor(
      Math.min(12000, sampleRate * 0.44) / fundamentalHz,
    );
    const normalization = Array.from(
      { length: harmonicCount },
      (_, index) => 1 / Math.pow(index + 1, spectralTilt),
    ).reduce((sum, value) => sum + value, 0);
    const baseSamples = new Float32Array(sampleRate * durationSec);

    for (let index = 0; index < baseSamples.length; index += 1) {
      const timeSec = index / sampleRate;
      let value = 0;
      for (let harmonic = 1; harmonic <= harmonicCount; harmonic += 1) {
        value +=
          Math.sin(2 * Math.PI * fundamentalHz * harmonic * timeSec) /
          Math.pow(harmonic, spectralTilt);
      }
      const edgeDistance = Math.min(index, baseSamples.length - 1 - index);
      const fade = Math.min(1, edgeDistance / Math.max(fadeSamples, 1));
      baseSamples[index] = ((scale * value) / normalization) * fade;
    }

    for (const phaseOffsetMs of [3, 6, 7, 9]) {
      const edgeIndices = [1, 2, 3].map(
        (second) =>
          second * sampleRate + Math.round((sampleRate * phaseOffsetMs) / 1000),
      );
      const samples = baseSamples.slice();
      for (let index = edgeIndices[0]; index < samples.length; index += 1) {
        let offset = step;
        if (index >= edgeIndices[1]) offset = 0;
        if (index >= edgeIndices[2]) offset = step;
        const edgeDistance = Math.min(index, samples.length - 1 - index);
        const fade = Math.min(1, edgeDistance / Math.max(fadeSamples, 1));
        samples[index] = (samples[index] ?? 0) + offset * fade;
      }

      const spliceJumps = edgeIndices.map((index) =>
        Math.abs((samples[index] ?? 0) - (samples[index - 1] ?? 0)),
      );
      assert.ok(
        spliceJumps.every((jump) => jump > 0.11),
        `${sampleRate} Hz/${phaseOffsetMs} ms fixture must retain its hard splice steps: ${spliceJumps.join(", ")}`,
      );
      const analysis = analyzeFloatSamples(samples, sampleRate);
      assert.ok(
        analysis.clickScore > 0.12,
        `${sampleRate} Hz/${phaseOffsetMs} ms high-pitch splices should remain detectable, got ${analysis.clickScore.toFixed(3)}`,
      );
    }
  }
});

test("sample click scoring detects zero-mean phase splices in periodic voice", () => {
  const sampleRate = 16000;
  const durationSec = 4;
  const spectralTilt = 1.25;
  const phases = [0, 1.2, -1, 2];
  const scenarios = [
    { fundamentalHz: 100, boundaryOffsetMs: 1 },
    { fundamentalHz: 150, boundaryOffsetMs: 3 },
    { fundamentalHz: 220, boundaryOffsetMs: 2 },
    { fundamentalHz: 320, boundaryOffsetMs: 4 },
  ];

  for (const scenario of scenarios) {
    const harmonicCount = Math.floor(
      Math.min(12000, sampleRate * 0.44) / scenario.fundamentalHz,
    );
    const normalization = Array.from(
      { length: harmonicCount },
      (_, index) => 1 / Math.pow(index + 1, spectralTilt),
    ).reduce((sum, value) => sum + value, 0);
    const scale = 0.36 / normalization;
    const boundaries = [1, 2, 3].map(
      (second) =>
        second * sampleRate +
        Math.round((sampleRate * scenario.boundaryOffsetMs) / 1000),
    );
    const samples = new Float32Array(sampleRate * durationSec);

    for (let index = 0; index < samples.length; index += 1) {
      const timeSec = index / sampleRate;
      const segment =
        index < boundaries[0]
          ? 0
          : index < boundaries[1]
            ? 1
            : index < boundaries[2]
              ? 2
              : 3;
      let value = 0;
      for (let harmonic = 1; harmonic <= harmonicCount; harmonic += 1) {
        value +=
          Math.sin(
            2 * Math.PI * scenario.fundamentalHz * harmonic * timeSec +
              harmonic * (phases[segment] ?? 0),
          ) / Math.pow(harmonic, spectralTilt);
      }
      samples[index] = value * scale;
    }

    const jumps = boundaries.map((index) =>
      Math.abs((samples[index] ?? 0) - (samples[index - 1] ?? 0)),
    );
    assert.ok(
      jumps.filter((jump) => jump > 0.08).length >= 2,
      `${scenario.fundamentalHz} Hz fixture must contain at least two audible phase seams: ${jumps.join(", ")}`,
    );
    const analysis = analyzeFloatSamples(samples, sampleRate);
    assert.ok(
      analysis.clickScore > 0.12,
      `${scenario.fundamentalHz} Hz zero-mean phase seams should remain detectable, got ${analysis.clickScore.toFixed(3)}`,
    );
  }
});

test("sample click scoring detects isolated discontinuities across recording levels and rates", () => {
  const scenarios = [
    { sampleRate: 16000, bodyGain: 0.03, clickGain: 0.22 },
    { sampleRate: 48000, bodyGain: 0.18, clickGain: 0.82 },
  ];

  for (const scenario of scenarios) {
    const samples = buildContinuousSignal(
      4,
      (timeSec) =>
        Math.sin(2 * Math.PI * 190 * timeSec) * scenario.bodyGain +
        Math.sin(2 * Math.PI * 430 * timeSec + 0.4) * scenario.bodyGain * 0.38,
      scenario.sampleRate,
    );
    const clickSpacing = Math.round(scenario.sampleRate * 0.32);
    let clickIndex = 0;
    for (
      let index = Math.round(scenario.sampleRate * 0.48);
      index < samples.length - 2;
      index += clickSpacing
    ) {
      samples[index] = clickIndex % 2 === 0 ? scenario.clickGain : -scenario.clickGain;
      clickIndex += 1;
    }

    const analysis = analyzeFloatSamples(samples, scenario.sampleRate);

    assert.ok(
      analysis.clickScore > 0.12,
      `${scenario.sampleRate} Hz isolated discontinuities should remain detectable, got ${analysis.clickScore.toFixed(3)}`,
    );
  }
});

test("sample click scoring detects isolated short pops wider than one sample", () => {
  for (const sampleRate of [16000, 48000]) {
    for (const pulseMs of [1, 2, 4]) {
      const samples = buildContinuousSignal(
        4,
        (timeSec) => Math.sin(2 * Math.PI * 180 * timeSec) * 0.035,
        sampleRate,
      );
      const clickSpacing = Math.round(sampleRate * 0.36);
      const pulseSamples = Math.round((sampleRate * pulseMs) / 1000);
      let clickIndex = 0;
      for (
        let index = Math.round(sampleRate * 0.48);
        index + pulseSamples < samples.length;
        index += clickSpacing
      ) {
        samples.fill(clickIndex % 2 === 0 ? 0.34 : -0.34, index, index + pulseSamples);
        clickIndex += 1;
      }

      const analysis = analyzeFloatSamples(samples, sampleRate);

      assert.ok(
        analysis.clickScore > 0.12,
        `${pulseMs} ms pops at ${sampleRate} Hz should remain detectable, got ${analysis.clickScore.toFixed(3)}`,
      );
    }
  }
});

test("sample click scoring detects isolated plateau pops beyond the rapid-return window", () => {
  for (const sampleRate of [16000, 48000]) {
    for (const pulseMs of [5, 10, 20, 29]) {
      const samples = buildContinuousSignal(
        4,
        (timeSec) => Math.sin(2 * Math.PI * 180 * timeSec) * 0.04,
        sampleRate,
      );
      const pulseSamples = Math.round((sampleRate * pulseMs) / 1000);
      for (const startSec of [0.7, 1.7, 2.7]) {
        const start = Math.round(startSec * sampleRate);
        for (let index = start; index < start + pulseSamples; index += 1) {
          samples[index] = (samples[index] ?? 0) + 0.18;
        }
      }

      const analysis = analyzeFloatSamples(samples, sampleRate);
      assert.ok(
        analysis.clickScore > 0.12,
        `${pulseMs} ms plateau pops at ${sampleRate} Hz should remain detectable, got ${analysis.clickScore.toFixed(3)}`,
      );
    }
  }
});

test("sample click scoring detects isolated hard splice steps without a rapid return", () => {
  for (const sampleRate of [16000, 48000]) {
    const phaseBySecond = [0, 1.2, -1, 2];
    const samples = buildContinuousSignal(
      4,
      (timeSec) => {
        const segment = Math.min(phaseBySecond.length - 1, Math.floor(timeSec));
        const phase = phaseBySecond[segment] ?? 0;
        return (
          Math.sin(2 * Math.PI * 190 * timeSec + phase) * 0.12 +
          Math.sin(2 * Math.PI * 430 * timeSec + phase * 0.37) * 0.04
        );
      },
      sampleRate,
    );
    const spliceJumps = [1, 2, 3].map((second) => {
      const index = Math.round(second * sampleRate);
      return Math.abs((samples[index] ?? 0) - (samples[index - 1] ?? 0));
    });
    assert.ok(
      spliceJumps.every((jump) => jump > 0.08),
      `${sampleRate} Hz fixture must contain three audible hard-splice jumps: ${spliceJumps.join(", ")}`,
    );

    const analysis = analyzeFloatSamples(samples, sampleRate);

    assert.ok(
      analysis.clickScore > 0.12,
      `${sampleRate} Hz one-sided hard splices should remain detectable, got ${analysis.clickScore.toFixed(3)}`,
    );
  }
});

test("line swing scoring rises for high-low-high speech contours", () => {
  const protectedTail = analyzeSections([
    { frames: 120, fromDb: -75 },
    { frames: 30, fromDb: -32, toDb: -28 },
    { frames: 140, fromDb: -28 },
    { frames: 25, fromDb: -28, toDb: -31 },
    { frames: 5, fromDb: -75 },
    { frames: 90, fromDb: -29 },
    { frames: 20, fromDb: -29, toDb: -31 },
  ]);
  const swingy = analyzeSections([
    { frames: 120, fromDb: -75 },
    { frames: 25, fromDb: -32, toDb: -28 },
    { frames: 35, fromDb: -28 },
    { frames: 35, fromDb: -35 },
    { frames: 35, fromDb: -27 },
    { frames: 35, fromDb: -34 },
    { frames: 35, fromDb: -28 },
    { frames: 25, fromDb: -28, toDb: -32 },
    { frames: 100, fromDb: -75 },
  ]);

  assert.ok(swingy.lineSwingScore > protectedTail.lineSwingScore + 0.05);
});
