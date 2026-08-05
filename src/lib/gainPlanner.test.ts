import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeFloatSamples, buildSpeechMask } from "./audioQc.ts";
import {
  applyKWeighting,
  applyGainCurveToSamples,
  buildRenderedConsonantReference,
  computeFricativeFrameDb,
  computeSpeechBodyFrameDb,
  emitSendcmdScript,
  limitEmbeddedPerformancePositiveGainAuthority,
  planGainCurve,
  RENDERED_CONSONANT_SOURCE_FRAME_MS,
  recoverRecurrentBodySpeechValleys,
  relaxNarrowBodySpeechGainValleys,
  relaxNarrowConsonantOwnerCaps,
  resolvePlannerCalibration,
  speechRunsFromMask,
  stabilizeRecurrentWordScaleBody,
  tameRenderedConsonantPeaks,
} from "./gainPlanner.ts";
import { computeLogBandSpectrumDb, computeSibilanceScore } from "./spectrum.ts";
import { decodeWav, encodeWavFloat32 } from "./webAudioRender.ts";

const SAMPLE_RATE = 16000;
const FRAME_MS = 10;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;

const dbToLin = (db: number) => Math.pow(10, db / 20);
const gainDbAtFrame = (curve: Float32Array, frame: number) => 20 * Math.log10(curve[frame] + 1e-9);

const synthesizeTake = (
  spans: Array<{ startSec: number; endSec: number; rmsDb: number }>,
  totalSec: number,
  noiseDb = -70,
): Float32Array => {
  const total = Math.round(totalSec * SAMPLE_RATE);
  const out = new Float32Array(total);
  // Noise floor.
  const noiseAmp = dbToLin(noiseDb);
  for (let i = 0; i < total; i += 1) out[i] = (Math.random() * 2 - 1) * noiseAmp;

  // Each span is a low-frequency speech-like tone at the requested RMS.
  for (const span of spans) {
    const start = Math.round(span.startSec * SAMPLE_RATE);
    const end = Math.round(span.endSec * SAMPLE_RATE);
    const amp = dbToLin(span.rmsDb) * Math.SQRT2; // peak for a sine at rmsDb
    for (let i = start; i < end && i < total; i += 1) {
      // mix of 200 Hz + 500 Hz to look like a voice formant
      out[i] += amp * (0.65 * Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE) + 0.35 * Math.sin((2 * Math.PI * 500 * i) / SAMPLE_RATE));
    }
  }
  return out;
};

const measureRmsDb = (samples: Float32Array, start: number, end: number) => {
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, end - start));
  return rms <= 0 ? -120 : 20 * Math.log10(rms);
};

const stdDev = (values: number[]) => {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance);
};

const frameDbForSamples = (samples: Float32Array) => {
  const frameDb: number[] = [];
  const frameCount = Math.floor(samples.length / FRAME_SAMPLES);
  for (let f = 0; f < frameCount; f += 1) {
    let sum = 0;
    for (let i = 0; i < FRAME_SAMPLES; i += 1) {
      const v = samples[f * FRAME_SAMPLES + i] ?? 0;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / FRAME_SAMPLES);
    frameDb.push(rms <= 0 ? -120 : 20 * Math.log10(rms));
  }
  return frameDb;
};

const rmsDbForSamples = (samples: Float32Array) => {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return 10 * Math.log10(sum / Math.max(1, samples.length) + 1e-30);
};

const makeTone = (frequencyHz: number, gain: number, seconds = 2) => {
  const samples = new Float32Array(Math.round(SAMPLE_RATE * seconds));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * frequencyHz * i) / SAMPLE_RATE) * gain;
  }
  return samples;
};

const buildEditedBedCalibrationFixture = (bedDb = -52) => {
  const frameDb = new Array<number>(1000).fill(-120);
  for (let frame = 500; frame < frameDb.length; frame += 1) frameDb[frame] = bedDb;
  for (const [startFrame, endFrame] of [
    [550, 575],
    [675, 700],
    [800, 825],
    [925, 950],
  ] as const) {
    for (let frame = startFrame; frame < endFrame; frame += 1) frameDb[frame] = -28;
  }
  return frameDb;
};

describe("fricative-band envelope", () => {
  it("responds to consonant-band energy without mistaking low formants for fricatives", () => {
    const totalSamples = SAMPLE_RATE;
    const lowFormant = new Float32Array(totalSamples);
    const fricative = new Float32Array(totalSamples);
    for (let index = 0; index < totalSamples; index += 1) {
      lowFormant[index] = Math.sin((2 * Math.PI * 500 * index) / SAMPLE_RATE) * 0.2;
      fricative[index] = Math.sin((2 * Math.PI * 6000 * index) / SAMPLE_RATE) * 0.2;
    }

    const lowEnvelope = computeFricativeFrameDb(lowFormant, SAMPLE_RATE, FRAME_MS);
    const highEnvelope = computeFricativeFrameDb(fricative, SAMPLE_RATE, FRAME_MS);

    assert.equal(highEnvelope.length, totalSamples / FRAME_SAMPLES);
    assert.equal(lowEnvelope.length, highEnvelope.length);
    const stableFrame = 20;
    assert.ok(
      highEnvelope[stableFrame] > lowEnvelope[stableFrame] + 24,
      `expected HF-selective envelope, got low ${lowEnvelope[stableFrame].toFixed(2)} dB and high ${highEnvelope[stableFrame].toFixed(2)} dB`,
    );
  });

  it("isolates speech-body energy from LF impacts and bright consonants", () => {
    const lowImpact = makeTone(80, 0.2, 1);
    const speechBody = makeTone(500, 0.2, 1);
    const brightConsonant = makeTone(6000, 0.2, 1);

    const lowEnvelope = computeSpeechBodyFrameDb(lowImpact, SAMPLE_RATE, FRAME_MS);
    const bodyEnvelope = computeSpeechBodyFrameDb(speechBody, SAMPLE_RATE, FRAME_MS);
    const brightEnvelope = computeSpeechBodyFrameDb(brightConsonant, SAMPLE_RATE, FRAME_MS);
    const stableFrame = 20;

    assert.equal(bodyEnvelope.length, lowEnvelope.length);
    assert.equal(bodyEnvelope.length, brightEnvelope.length);
    assert.ok(
      bodyEnvelope[stableFrame] > lowEnvelope[stableFrame] + 10,
      `speech body should outrank LF-only energy: ${bodyEnvelope[stableFrame].toFixed(2)} vs ${lowEnvelope[stableFrame].toFixed(2)} dB`,
    );
    assert.ok(
      bodyEnvelope[stableFrame] > brightEnvelope[stableFrame] + 8,
      `speech body should outrank consonant-only energy: ${bodyEnvelope[stableFrame].toFixed(2)} vs ${brightEnvelope[stableFrame].toFixed(2)} dB`,
    );
  });
});

describe("gainPlanner", () => {
  it("learns a clip-attached recording bed despite edited digital silence", () => {
    const frameDb = buildEditedBedCalibrationFixture();
    const originalFrameDb = [...frameDb];

    const calibration = resolvePlannerCalibration(frameDb, -110, -58);
    const runs = speechRunsFromMask(
      buildSpeechMask(frameDb, calibration.noiseFloorDb, { frameMs: FRAME_MS }),
    );

    assert.deepEqual(frameDb, originalFrameDb, "calibration must not mutate the decoded envelope");
    assert.ok(
      calibration.noiseFloorDb >= -59 && calibration.noiseFloorDb <= -54,
      `recording bed should move the planner floor near -56 dB, got ${calibration.noiseFloorDb.toFixed(2)} dB`,
    );
    assert.ok(
      calibration.speechThresholdDb >= -46 && calibration.speechThresholdDb <= -42,
      `speech threshold should sit above the -52 dB bed, got ${calibration.speechThresholdDb.toFixed(2)} dB`,
    );
    assert.equal(runs.length, 4, "the recorded bed must not become one continuous body-speech run");
    for (const run of runs) {
      assert.ok(run.endFrame - run.startFrame < 60, `speech burst grew into recorded bed: ${JSON.stringify(run)}`);
    }
  });

  it("keeps a permissive floor for sparse clean quiet speech amid digital silence", () => {
    const frameDb = new Array<number>(1000).fill(-120);
    for (const [startFrame, endFrame] of [
      [100, 145],
      [420, 475],
      [760, 810],
    ] as const) {
      for (let frame = startFrame; frame < endFrame; frame += 1) frameDb[frame] = -48;
    }

    const calibration = resolvePlannerCalibration(frameDb, -110, -58);
    const runs = speechRunsFromMask(
      buildSpeechMask(frameDb, calibration.noiseFloorDb, { frameMs: FRAME_MS }),
    );

    assert.ok(
      calibration.noiseFloorDb <= -100,
      `sparse clean words must not be reinterpreted as a noise bed, got ${calibration.noiseFloorDb.toFixed(2)} dB`,
    );
    assert.equal(calibration.speechThresholdDb, -58);
    assert.equal(runs.length, 3, "all quiet clean words should remain detectable");
  });

  it("does not relabel a recurring quiet-dialogue mode as a persistent recording bed", () => {
    const frameDb = new Array<number>(1000).fill(-120);
    const quietWordFrames: number[] = [];
    for (let cycleStart = 0; cycleStart < frameDb.length; cycleStart += 100) {
      for (let frame = cycleStart + 50; frame < cycleStart + 75; frame += 1) {
        frameDb[frame] = -48;
        quietWordFrames.push(frame);
      }
      for (let frame = cycleStart + 75; frame < cycleStart + 100; frame += 1) {
        frameDb[frame] = -28;
      }
    }

    const calibration = resolvePlannerCalibration(frameDb, -110, -58);
    const mask = buildSpeechMask(frameDb, calibration.noiseFloorDb, { frameMs: FRAME_MS });

    assert.ok(
      calibration.noiseFloorDb <= -78,
      `intermittent quiet dialogue must keep a permissive planner floor, got ${calibration.noiseFloorDb.toFixed(2)} dB`,
    );
    assert.equal(calibration.speechThresholdDb, -58);
    const retainedQuietFrameRatio =
      quietWordFrames.filter((frame) => mask[frame]).length / quietWordFrames.length;
    assert.ok(
      retainedQuietFrameRatio >= 0.85,
      `quiet-dialogue words should remain detected apart from normal mask edge confirmation, retained ${(retainedQuietFrameRatio * 100).toFixed(1)}%`,
    );
    for (let cycleStart = 0; cycleStart < frameDb.length; cycleStart += 100) {
      assert.ok(
        mask.slice(cycleStart + 50, cycleStart + 75).some(Boolean),
        `quiet word at frame ${cycleStart + 50} disappeared`,
      );
    }
  });

  it("moves calibration continuously for a 0.01 dB recording-bed change", () => {
    const lowerBed = buildEditedBedCalibrationFixture(-52);
    const higherBed = buildEditedBedCalibrationFixture(-51.99);
    const lowerSnapshot = [...lowerBed];
    const higherSnapshot = [...higherBed];

    const lower = resolvePlannerCalibration(lowerBed, -110, -58);
    const higher = resolvePlannerCalibration(higherBed, -110, -58);

    assert.deepEqual(lowerBed, lowerSnapshot);
    assert.deepEqual(higherBed, higherSnapshot);
    assert.ok(
      higher.noiseFloorDb > lower.noiseFloorDb &&
        higher.noiseFloorDb - lower.noiseFloorDb < 0.03,
      `0.01 dB evidence change should make a small monotonic floor change, got ${lower.noiseFloorDb.toFixed(5)} -> ${higher.noiseFloorDb.toFixed(5)}`,
    );
    assert.ok(
      higher.speechThresholdDb > lower.speechThresholdDb &&
        higher.speechThresholdDb - lower.speechThresholdDb < 0.03,
      `0.01 dB evidence change should make a small monotonic threshold change, got ${lower.speechThresholdDb.toFixed(5)} -> ${higher.speechThresholdDb.toFixed(5)}`,
    );
  });

  it("caps hot adaptive noise floors against the decoded planner envelope", () => {
    const frameDb = new Array<number>(1000).fill(-120);
    for (let frame = 100; frame < 220; frame += 1) frameDb[frame] = -29;
    for (let frame = 220; frame < 240; frame += 1) frameDb[frame] = -52;
    for (let frame = 620; frame < 760; frame += 1) frameDb[frame] = -31;

    const calibration = resolvePlannerCalibration(frameDb, -32.9, -26);
    const hotMaskRuns = speechRunsFromMask(buildSpeechMask(frameDb, -32.9, { frameMs: FRAME_MS }));
    const plannerMaskRuns = speechRunsFromMask(buildSpeechMask(frameDb, calibration.noiseFloorDb, { frameMs: FRAME_MS }));

    assert.ok(calibration.noiseFloorDb <= -80, `planner floor should be capped low, got ${calibration.noiseFloorDb.toFixed(1)} dB`);
    assert.equal(calibration.speechThresholdDb, -58);
    assert.equal(hotMaskRuns.length, 0, "fixture should prove hot profile floor loses the quiet speech");
    assert.equal(plannerMaskRuns.length, 2);
    assert.ok(plannerMaskRuns[0].endFrame >= 240, "quiet tail should stay in the first planner run");
  });

  it("uses K-weighted frame energy to align boomy and bright voices with equal perceived loudness", () => {
    const lowUnit = makeTone(100, 1);
    const highUnit = makeTone(3000, 1);
    const lowWeightedDb = rmsDbForSamples(applyKWeighting(lowUnit, SAMPLE_RATE));
    const highWeightedDb = rmsDbForSamples(applyKWeighting(highUnit, SAMPLE_RATE));
    const lowVoice = makeTone(100, dbToLin(-18));
    const highVoice = makeTone(3000, dbToLin(-18 + lowWeightedDb - highWeightedDb));
    const run = { startFrame: 0, endFrame: Math.floor(lowVoice.length / FRAME_SAMPLES) };
    const baseInput = {
      speechRuns: [run],
      noiseFloorDb: -80,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.05,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
    };

    const lowPlainPlan = planGainCurve({
      ...baseInput,
      frameDb: frameDbForSamples(lowVoice),
    });
    const highPlainPlan = planGainCurve({
      ...baseInput,
      frameDb: frameDbForSamples(highVoice),
    });
    const lowWeightedFrameDb = frameDbForSamples(applyKWeighting(lowVoice, SAMPLE_RATE));
    const highWeightedFrameDb = frameDbForSamples(applyKWeighting(highVoice, SAMPLE_RATE));
    const lowWeightedPlan = planGainCurve({
      ...baseInput,
      frameDb: frameDbForSamples(lowVoice),
      loudnessFrameDb: lowWeightedFrameDb,
    });
    const highWeightedPlan = planGainCurve({
      ...baseInput,
      frameDb: frameDbForSamples(highVoice),
      loudnessFrameDb: highWeightedFrameDb,
    });

    const plainGapDb = Math.abs(lowPlainPlan.runs[0].plannedGainDb - highPlainPlan.runs[0].plannedGainDb);
    const weightedGapDb = Math.abs(lowWeightedPlan.runs[0].plannedGainDb - highWeightedPlan.runs[0].plannedGainDb);

    assert.ok(plainGapDb > 3, `plain RMS should diverge by several dB, got ${plainGapDb.toFixed(2)} dB`);
    assert.ok(weightedGapDb < 0.5, `K-weighted planner gap should stay tight, got ${weightedGapDb.toFixed(2)} dB`);
  });

  it("does not create an end-edge dip when a sibilant ending is only hot in the K-weighted envelope", () => {
    const totalFrames = 180;
    const run = { startFrame: 20, endFrame: 150 };
    const tailStart = run.endFrame - 15;
    const rawFrameDb = new Array<number>(totalFrames).fill(-78);
    const loudnessFrameDb = [...rawFrameDb];
    const samples = new Float32Array(totalFrames * FRAME_SAMPLES);

    for (let frame = run.startFrame; frame < run.endFrame; frame += 1) {
      rawFrameDb[frame] = -24;
      loudnessFrameDb[frame] = frame >= tailStart ? -20.5 : -24;
      const hz = frame >= tailStart ? 6200 : 240;
      const start = frame * FRAME_SAMPLES;
      const amp = dbToLin(-24) * Math.SQRT2;
      for (let sample = 0; sample < FRAME_SAMPLES; sample += 1) {
        const sampleIndex = start + sample;
        samples[sampleIndex] = Math.sin((2 * Math.PI * hz * sampleIndex) / SAMPLE_RATE) * amp;
      }
    }

    const plan = planGainCurve({
      frameDb: rawFrameDb,
      loudnessFrameDb,
      speechRuns: [run],
      noiseFloorDb: -78,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.05,
      frameMs: FRAME_MS,
      samples,
      sampleRate: SAMPLE_RATE,
      targetDb: -22,
      sourceTargetBlend: 0,
      peakCeilingDb: -3,
    });

    const bodyGainDb = gainDbAtFrame(plan.gainCurve, 70);
    const endEdgeGains = Array.from({ length: 20 }, (_, index) => gainDbAtFrame(plan.gainCurve, run.endFrame - 20 + index));
    const worstEndDipDb = bodyGainDb - Math.min(...endEdgeGains);

    assert.ok(
      worstEndDipDb < 1,
      `sibilant ending should hold level to the last phoneme; worst dip ${worstEndDipDb.toFixed(2)} dB vs body ${bodyGainDb.toFixed(2)} dB`,
    );
  });

  it("keeps speech-run boundaries tied to the raw envelope when K-weighted loudness rises at the tail", () => {
    const rawFrameDb = new Array<number>(220).fill(-78);
    const loudnessFrameDb = [...rawFrameDb];
    for (let frame = 50; frame < 150; frame += 1) {
      rawFrameDb[frame] = frame >= 120 ? -68 : -31;
      loudnessFrameDb[frame] = frame >= 120 ? -31 : -31;
    }
    const rawRuns = speechRunsFromMask(buildSpeechMask(rawFrameDb, -78, { frameMs: FRAME_MS }));
    const kRuns = speechRunsFromMask(buildSpeechMask(loudnessFrameDb, -78, { frameMs: FRAME_MS }));

    assert.notDeepEqual(kRuns, rawRuns, "fixture must prove the K envelope would shift speech boundaries");

    const plan = planGainCurve({
      frameDb: rawFrameDb,
      loudnessFrameDb,
      speechRuns: rawRuns,
      noiseFloorDb: -78,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.05,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.2,
    });

    assert.deepEqual(
      plan.runs.map(({ startFrame, endFrame }) => ({ startFrame, endFrame })),
      rawRuns,
      "planner runs must preserve the raw-mask boundaries instead of the K-weighted tail",
    );
  });

  it("uses raw run mean for residual loud-run correction after K-weighted targeting", () => {
    const frameDb = new Array<number>(180).fill(-78);
    const loudnessFrameDb = new Array<number>(180).fill(-78);
    const run = { startFrame: 20, endFrame: 150 };
    for (let frame = run.startFrame; frame < run.endFrame; frame += 1) {
      frameDb[frame] = -16;
      loudnessFrameDb[frame] = -22;
    }

    const plan = planGainCurve({
      frameDb,
      loudnessFrameDb,
      speechRuns: [run],
      noiseFloorDb: -78,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.05,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.2,
      speechSpikeTaming: 0.8,
    });

    const bodyGainDb = gainDbAtFrame(plan.gainCurve, 70);

    assert.equal(plan.sustainedLoudClusterCount, 1);
    assert.ok(bodyGainDb < -1, `raw-hot body should receive a residual cut, got ${bodyGainDb.toFixed(2)} dB`);
  });

  it("adds a bounded floor lift when high-crest body speech is raw-quiet and perceptually under target", () => {
    const frameDb = new Array<number>(180).fill(-78);
    const loudnessFrameDb = new Array<number>(180).fill(-78);
    const samples = new Float32Array(frameDb.length * FRAME_SAMPLES);
    const run = { startFrame: 20, endFrame: 150 };

    for (let frame = run.startFrame; frame < run.endFrame; frame += 1) {
      frameDb[frame] = -27;
      loudnessFrameDb[frame] = -24;
      const start = frame * FRAME_SAMPLES;
      for (let sample = 0; sample < FRAME_SAMPLES; sample += 1) {
        const sampleIndex = start + sample;
        samples[sampleIndex] = Math.sin((2 * Math.PI * 240 * sampleIndex) / SAMPLE_RATE) * dbToLin(-27) * Math.SQRT2;
      }
      samples[start + 4] = dbToLin(-5);
    }

    const plan = planGainCurve({
      frameDb,
      loudnessFrameDb,
      speechRuns: [run],
      noiseFloorDb: -78,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.05,
      frameMs: FRAME_MS,
      samples,
      sampleRate: SAMPLE_RATE,
      targetDb: -22,
      sourceTargetBlend: 0,
      peakCeilingDb: -3,
      instabilityHint: 0.7,
      speechSpikeTaming: 0.85,
    });

    assert.equal(plan.runs[0].runClass, "body-speech");
    assert.ok(plan.runs[0].plannedGainDb > 0, `quiet high-crest body should not be left below source level, got ${plan.runs[0].plannedGainDb.toFixed(2)} dB`);
    assert.ok(
      plan.runs[0].meanDb + plan.runs[0].plannedGainDb > -27,
      `raw body should receive a small floor lift, got ${(plan.runs[0].meanDb + plan.runs[0].plannedGainDb).toFixed(2)} dB`,
    );
  });

  it("keeps spike taming from crushing an entire body-speech run", () => {
    const frameDb = new Array<number>(220).fill(-78);
    const samples = new Float32Array(frameDb.length * FRAME_SAMPLES);
    const run = { startFrame: 30, endFrame: 190 };

    for (let frame = run.startFrame; frame < run.endFrame; frame += 1) {
      frameDb[frame] = -22;
      const start = frame * FRAME_SAMPLES;
      for (let sample = 0; sample < FRAME_SAMPLES; sample += 1) {
        const sampleIndex = start + sample;
        samples[sampleIndex] = Math.sin((2 * Math.PI * 260 * sampleIndex) / SAMPLE_RATE) * dbToLin(-22) * Math.SQRT2;
      }
      if ((frame - run.startFrame) % 3 === 0) {
        samples[start + 6] = dbToLin(-1);
      }
    }

    const plan = planGainCurve({
      frameDb,
      speechRuns: [run],
      noiseFloorDb: -78,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.05,
      frameMs: FRAME_MS,
      samples,
      sampleRate: SAMPLE_RATE,
      targetDb: -22,
      sourceTargetBlend: 0,
      peakCeilingDb: -3,
      instabilityHint: 1,
      speechSpikeTaming: 1,
    });
    const leveled = applyGainCurveToSamples(samples, plan.gainCurve, SAMPLE_RATE, 1, FRAME_MS);
    const sourceDb = measureRmsDb(samples, run.startFrame * FRAME_SAMPLES, run.endFrame * FRAME_SAMPLES);
    const leveledDb = measureRmsDb(leveled, run.startFrame * FRAME_SAMPLES, run.endFrame * FRAME_SAMPLES);

    const ordinaryBodyGainDb = gainDbAtFrame(plan.gainCurve, run.startFrame + 1);
    const spikeFrameGainDb = gainDbAtFrame(plan.gainCurve, run.startFrame + 3);
    assert.ok(
      Math.abs(spikeFrameGainDb - ordinaryBodyGainDb) < 0.8,
      `sample peaks must not create a local body notch: ${ordinaryBodyGainDb.toFixed(2)} vs ${spikeFrameGainDb.toFixed(2)} dB`,
    );
    assert.ok(
      leveledDb >= sourceDb - 10.2,
      `spike guard should not crush the run body: source ${sourceDb.toFixed(2)} dB, leveled ${leveledDb.toFixed(2)} dB`,
    );
  });

  it("honors the speech-spike floor even when the caller passes zero", () => {
    const frameDb = new Array<number>(180).fill(-78);
    const run = { startFrame: 20, endFrame: 150 };
    for (let frame = run.startFrame; frame < run.endFrame; frame += 1) frameDb[frame] = -2;

    const plan = planGainCurve({
      frameDb,
      speechRuns: [run],
      noiseFloorDb: -78,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.05,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0,
      speechSpikeTaming: 0,
    });

    assert.ok(plan.sustainedLoudClusterCount >= 1, "explicit zero should not bypass the residual spike floor");
  });

  it("keeps the speech-spike floor in sparse consistent takes", () => {
    const speechRuns = [
      { startFrame: 10, endFrame: 50 },
      { startFrame: 70, endFrame: 110 },
      { startFrame: 130, endFrame: 170 },
      { startFrame: 190, endFrame: 230 },
    ];
    const frameDb = new Array<number>(250).fill(-78);
    for (const run of speechRuns) {
      for (let frame = run.startFrame; frame < run.endFrame; frame += 1) frameDb[frame] = -2;
    }

    const plan = planGainCurve({
      frameDb,
      speechRuns,
      noiseFloorDb: -78,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.05,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0,
      speechSpikeTaming: 0,
    });

    assert.ok(
      plan.sustainedLoudClusterCount >= speechRuns.length,
      `sparse-take guard should keep residual spike checks active, got ${plan.sustainedLoudClusterCount}`,
    );
  });

  it("lifts quiet cold-open short high-crest runs to the later dialogue anchor", () => {
    const speechRuns = [
      { startFrame: 20, endFrame: 55 },
      { startFrame: 90, endFrame: 190 },
      { startFrame: 225, endFrame: 325 },
      { startFrame: 360, endFrame: 460 },
      { startFrame: 495, endFrame: 595 },
      { startFrame: 630, endFrame: 730 },
    ];
    const frameDb = new Array(780).fill(-78);
    for (const [index, run] of speechRuns.entries()) {
      const bodyDb = index === 0 ? -34 : -26;
      for (let frame = run.startFrame; frame < run.endFrame; frame += 1) frameDb[frame] = bodyDb;
    }
    frameDb[speechRuns[0].startFrame] = -12;

    const plan = planGainCurve({
      frameDb,
      speechRuns,
      noiseFloorDb: -78,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.05,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      minGainDb: -14,
      maxGainDb: 14,
      instabilityHint: 0.4,
    });

    const firstRun = plan.runs[0];
    assert.equal(firstRun.runClass, "body-speech");
    const firstAppliedBodyDb = firstRun.meanDb + firstRun.plannedGainDb;
    const laterAppliedBodies = plan.runs.slice(3).map((run) => run.meanDb + run.plannedGainDb).sort((a, b) => a - b);
    const laterAnchorDb = laterAppliedBodies[Math.floor(laterAppliedBodies.length / 2)];

    assert.ok(
      firstAppliedBodyDb >= laterAnchorDb - 1.5,
      `quiet opener should land near later anchor: first ${firstAppliedBodyDb.toFixed(1)} dB vs anchor ${laterAnchorDb.toFixed(1)} dB`,
    );
  });

  it("bounds cold-open lift and still supports short files with a later anchor", () => {
    const buildPlan = (runCount: number) => {
      const speechRuns: Array<{ startFrame: number; endFrame: number }> = [];
      let cursor = 20;
      const totalFrames = cursor + runCount * 110 + 80;
      const frameDb = new Array(totalFrames).fill(-78);
      const samples = new Float32Array(totalFrames * FRAME_SAMPLES);
      for (let index = 0; index < runCount; index += 1) {
        const run = { startFrame: cursor, endFrame: cursor + 80 };
        speechRuns.push(run);
        const bodyDb = index === 0 ? -30 : -26;
        for (let frame = run.startFrame; frame < run.endFrame; frame += 1) {
          frameDb[frame] = bodyDb;
          const start = frame * FRAME_SAMPLES;
          for (let sample = 0; sample < FRAME_SAMPLES; sample += 1) {
            const sampleIndex = start + sample;
            samples[sampleIndex] = Math.sin((2 * Math.PI * 240 * sampleIndex) / SAMPLE_RATE) * dbToLin(bodyDb) * Math.SQRT2;
          }
          if (index < 3 && (frame - run.startFrame) % 4 === 0) {
            samples[start + 10] = dbToLin(-14.5);
          }
        }
        cursor += 110;
      }
      return planGainCurve({
        frameDb,
        speechRuns,
        noiseFloorDb: -78,
        speechThresholdDb: -55,
        pauseNoiseRisk: 0.05,
        frameMs: FRAME_MS,
        samples,
        sampleRate: SAMPLE_RATE,
        targetDb: -22,
        sourceTargetBlend: 0,
        minGainDb: -14,
        maxGainDb: 14,
        instabilityHint: 0.4,
      });
    };

    const assertOpenerSupported = (plan: ReturnType<typeof planGainCurve>) => {
      const firstAppliedBodyDb = plan.runs[0].meanDb + plan.runs[0].plannedGainDb;
      const laterAppliedBodies = plan.runs
        .slice(1)
        .map((run) => run.meanDb + run.plannedGainDb)
        .sort((a, b) => a - b);
      const laterAnchorDb = laterAppliedBodies[Math.floor(laterAppliedBodies.length / 2)];
      assert.ok(
        firstAppliedBodyDb >= laterAnchorDb - 1.5,
        `quiet opener should be supported whether continuity or the explicit lift owns it: ${firstAppliedBodyDb.toFixed(2)} vs ${laterAnchorDb.toFixed(2)} dB`,
      );
    };

    const lifted = buildPlan(8);
    assertOpenerSupported(lifted);
    assert.ok(
      lifted.coldOpenLiftMaxDb <= 5,
      `cold-open lift must stay capped at 5 dB, got ${lifted.coldOpenLiftMaxDb.toFixed(2)} dB`,
    );

    const shortTake = buildPlan(3);
    assertOpenerSupported(shortTake);

    const tooFewBodies = buildPlan(2);
    assert.equal(tooFewBodies.coldOpenLiftCount, 0);
    assert.equal(tooFewBodies.coldOpenLiftMaxDb, 0);
  });

  it("starts file-head speech at body gain instead of the expander floor", () => {
    const frameDb = new Array(220).fill(-78);
    for (let frame = 0; frame < 140; frame += 1) frameDb[frame] = -28;

    const plan = planGainCurve({
      frameDb,
      speechRuns: [{ startFrame: 0, endFrame: 140 }],
      noiseFloorDb: -78,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.2,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.2,
    });

    const frameZeroGainDb = 20 * Math.log10(plan.gainCurve[0] + 1e-9);
    const bodyGainDb = 20 * Math.log10(plan.gainCurve[40] + 1e-9);

    assert.ok(
      Math.abs(frameZeroGainDb - bodyGainDb) < 0.2,
      `frame 0 gain should equal body gain, got ${frameZeroGainDb.toFixed(2)} vs ${bodyGainDb.toFixed(2)} dB`,
    );
  });

  it("caps severe hot openers against later dialogue while preserving normal emphasis", () => {
    const speechRuns = [
      { startFrame: 20, endFrame: 120 },
      { startFrame: 150, endFrame: 250 },
      { startFrame: 280, endFrame: 380 },
      { startFrame: 410, endFrame: 510 },
      { startFrame: 540, endFrame: 640 },
      { startFrame: 670, endFrame: 770 },
    ];
    const frameDb = new Array(800).fill(-78);
    for (const [index, run] of speechRuns.entries()) {
      const bodyDb = index < 2 ? -2 : -24;
      for (let frame = run.startFrame; frame < run.endFrame; frame += 1) frameDb[frame] = bodyDb;
    }

    const plan = planGainCurve({
      frameDb,
      speechRuns,
      noiseFloorDb: -78,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.05,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      minGainDb: -14,
      maxGainDb: 14,
      instabilityHint: 0.4,
    });

    assert.ok(plan.earlyRunCapCount >= 2, `expected early caps, got ${plan.earlyRunCapCount}`);
    const appliedBodies = plan.runs.map((run) => run.meanDb + run.plannedGainDb);
    assert.ok(
      appliedBodies[0] >= plan.targetDb + 1 && appliedBodies[0] <= plan.targetDb + 4,
      `hot opener should remain emphasized but controlled: ${appliedBodies[0].toFixed(2)} dB`,
    );
    assert.ok(
      appliedBodies[0] <= -7.5,
      `hot openers should be tamed without being forced to ordinary dialogue: ${appliedBodies.map((v) => v.toFixed(1)).join(", ")}`,
    );

    const naturalFrameDb = new Array(800).fill(-78);
    for (const [index, run] of speechRuns.entries()) {
      const bodyDb = index < 2 ? -20.4 : -22;
      for (let frame = run.startFrame; frame < run.endFrame; frame += 1) naturalFrameDb[frame] = bodyDb;
    }
    const naturalPlan = planGainCurve({
      frameDb: naturalFrameDb,
      speechRuns,
      noiseFloorDb: -78,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.05,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      minGainDb: -14,
      maxGainDb: 14,
      instabilityHint: 0.4,
    });
    assert.equal(naturalPlan.earlyRunCapCount, 0, "normal 1-2 dB opener emphasis must stay intact");
  });

  it("does not over-dip sparse dialogue that is already line-consistent", () => {
    const spans = [
      { startSec: 0.6, endSec: 1.7, rmsDb: -36 },
      { startSec: 2.4, endSec: 3.4, rmsDb: -35.5 },
      { startSec: 4.2, endSec: 5.2, rmsDb: -35.7 },
      { startSec: 6.0, endSec: 7.2, rmsDb: -36.2 },
    ];
    const samples = synthesizeTake(spans, 8, -78);

    // A sharp consonant-like peak inside the last line should not cause the
    // whole sparse take to re-shape around it when the line bodies are already
    // consistent and the absolute peak remains safe.
    const spikeStart = Math.round(6.35 * SAMPLE_RATE);
    for (let i = 0; i < Math.round(0.02 * SAMPLE_RATE); i += 1) {
      samples[spikeStart + i] += i % 2 === 0 ? 0.08 : -0.08;
    }

    const metrics = analyzeFloatSamples(samples, SAMPLE_RATE, FRAME_MS);
    const frameDb = frameDbForSamples(samples);
    const runs = speechRunsFromMask(buildSpeechMask(frameDb, metrics.noiseFloorDb));
    const plan = planGainCurve({
      frameDb,
      speechRuns: runs,
      noiseFloorDb: metrics.noiseFloorDb,
      speechThresholdDb: metrics.speechThresholdDb,
      pauseNoiseRisk: metrics.pauseNoiseRisk,
      frameMs: FRAME_MS,
      samples,
      sampleRate: SAMPLE_RATE,
      targetDb: -22,
      sourceTargetBlend: 0.1,
      maxGainDb: 16,
      peakCeilingDb: -3,
      instabilityHint: 0.6,
      speechSpikeTaming: 0.85,
    });

    const leveled = applyGainCurveToSamples(samples, plan.gainCurve, SAMPLE_RATE, 1, FRAME_MS);
    const leveledBodies = spans.map((span) =>
      measureRmsDb(
        leveled,
        Math.round((span.startSec + 0.2) * SAMPLE_RATE),
        Math.round((span.endSec - 0.2) * SAMPLE_RATE),
      ),
    );

    assert.ok(
      stdDev(leveledBodies) < 0.9,
      `already-consistent sparse dialogue should remain consistent: ${leveledBodies.map((v) => v.toFixed(1)).join(", ")}`,
    );
    assert.equal(plan.speechSpikeFrameCount, 0, "localized planner shaping must stay absent on this sparse clean take");
  });

  it("normalizes uneven sentences to within +/- 2 dB", () => {
    // Three sentences at -30, -12, -26 dB RMS.
    const spans = [
      { startSec: 0.3, endSec: 1.5, rmsDb: -30 },
      { startSec: 2.0, endSec: 3.2, rmsDb: -12 },
      { startSec: 3.7, endSec: 4.9, rmsDb: -26 },
    ];
    const samples = synthesizeTake(spans, 5.2, -72);
    const metrics = analyzeFloatSamples(samples, SAMPLE_RATE, FRAME_MS);

    // Build frame-db + speech mask from the same envelope metrics.
    const frameDb: number[] = [];
    const frameCount = Math.floor(samples.length / FRAME_SAMPLES);
    for (let f = 0; f < frameCount; f += 1) {
      let sum = 0;
      for (let i = 0; i < FRAME_SAMPLES; i += 1) {
        const v = samples[f * FRAME_SAMPLES + i] ?? 0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / FRAME_SAMPLES);
      frameDb.push(rms <= 0 ? -120 : 20 * Math.log10(rms));
    }
    const mask = buildSpeechMask(frameDb, metrics.noiseFloorDb);
    const runs = speechRunsFromMask(mask);
    assert.ok(runs.length >= 3, `expected at least 3 runs, got ${runs.length}`);

    const plan = planGainCurve({
      frameDb,
      speechRuns: runs,
      noiseFloorDb: metrics.noiseFloorDb,
      speechThresholdDb: metrics.speechThresholdDb,
      pauseNoiseRisk: metrics.pauseNoiseRisk,
      frameMs: FRAME_MS,
      samples,
      sampleRate: SAMPLE_RATE,
      // Input is wildly uneven (-30 / -12 / -26 dB). Tell the planner to use
      // the full micro-ride budget so it can track each sentence body.
      instabilityHint: 0.95,
    });

    const leveled = applyGainCurveToSamples(samples, plan.gainCurve, SAMPLE_RATE, 1, FRAME_MS);

    // Measure the stable BODY of each synthesized span, not the detected-run
    // edges (which include expander ramps — those are intentional and not a
    // defect of the leveler).
    const rmsBodyByRun = spans.map((s) => {
      const span = s.endSec - s.startSec;
      const bodyStart = Math.round((s.startSec + span * 0.25) * SAMPLE_RATE);
      const bodyEnd = Math.round((s.endSec - span * 0.25) * SAMPLE_RATE);
      return measureRmsDb(leveled, bodyStart, bodyEnd);
    });
    const spread = Math.max(...rmsBodyByRun) - Math.min(...rmsBodyByRun);
    // Original source spread is 18 dB (rms -30/-12/-26). We consider the
    // leveler healthy when that is cut to < 7 dB (outliers capped by the
    // configured gain bounds) AND std-dev drops by >55%.
    assert.ok(spread < 7, `body RMS spread should be < 7 dB after leveling, got ${spread.toFixed(2)} (${rmsBodyByRun.map((v) => v.toFixed(1)).join(", ")})`);

    const stdBefore = stdDev(spans.map((s) => s.rmsDb));
    const stdAfter = stdDev(rmsBodyByRun);
    assert.ok(stdAfter < stdBefore * 0.45, `std dev should drop >55%: before ${stdBefore.toFixed(2)} after ${stdAfter.toFixed(2)}`);

    // The leveled output must have its runs all sitting in the -30..-18 dB band
    // (not spread across the original -30..-12 band). This is the core "same
    // tone / same volume" promise of the planner.
    for (const level of rmsBodyByRun) {
      assert.ok(level >= -32 && level <= -18, `run body out of target band: ${level.toFixed(2)} dB`);
    }
  });

  it("keeps unclassified recording beds source-stable instead of hard-ducking them", () => {
    const spans = [{ startSec: 0.5, endSec: 2.5, rmsDb: -24 }];
    const samples = synthesizeTake(spans, 4, -58); // noisier pause
    const metrics = analyzeFloatSamples(samples, SAMPLE_RATE, FRAME_MS);

    const frameDb: number[] = [];
    const frameCount = Math.floor(samples.length / FRAME_SAMPLES);
    for (let f = 0; f < frameCount; f += 1) {
      let sum = 0;
      for (let i = 0; i < FRAME_SAMPLES; i += 1) {
        const v = samples[f * FRAME_SAMPLES + i] ?? 0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / FRAME_SAMPLES);
      frameDb.push(rms <= 0 ? -120 : 20 * Math.log10(rms));
    }
    const mask = buildSpeechMask(frameDb, metrics.noiseFloorDb);
    const runs = speechRunsFromMask(mask);

    const plan = planGainCurve({
      frameDb,
      speechRuns: runs,
      noiseFloorDb: metrics.noiseFloorDb,
      speechThresholdDb: metrics.speechThresholdDb,
      pauseNoiseRisk: metrics.pauseNoiseRisk,
      frameMs: FRAME_MS,
    });

    // The legacy binary mask applied 12-30 dB of attenuation to every
    // unclassified frame, including real quiet words. Pause risk may now trim
    // an unchanged bed only subtly and continuously.
    assert.ok(
      plan.expanderDepthDb >= 0 && plan.expanderDepthDb <= 1.5,
      `unclassified-frame trim must stay subtle: ${plan.expanderDepthDb.toFixed(2)} dB`,
    );

    // Pick a mid-pause frame (3.5 s): no uplift, but never a speech-erasing
    // binary expansion cut.
    const pauseFrame = Math.round(3.5 * 100);
    const pauseGainDb = 20 * Math.log10(plan.gainCurve[pauseFrame] + 1e-9);
    assert.ok(
      pauseGainDb <= 0.05 && pauseGainDb >= -1.55,
      `pause gain should remain source-stable, got ${pauseGainDb.toFixed(2)} dB`,
    );
  });

  it("preserves an unclassified quiet word even when pause-noise risk is high", () => {
    const frameDb = new Array<number>(400).fill(-58);
    for (let frame = 80; frame < 210; frame += 1) frameDb[frame] = -24;
    for (let frame = 280; frame < 315; frame += 1) frameDb[frame] = -49;
    const before = frameDb.slice();

    const plan = planGainCurve({
      frameDb,
      speechRuns: [{ startFrame: 80, endFrame: 210 }],
      noiseFloorDb: -58,
      speechThresholdDb: -45,
      pauseNoiseRisk: 1,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
    });

    const quietWordGainDb = gainDbAtFrame(plan.gainCurve, 295);
    assert.ok(
      quietWordGainDb >= -1.55 && quietWordGainDb <= 0.05,
      `an uncertain quiet word must remain audible, got ${quietWordGainDb.toFixed(2)} dB`,
    );
    assert.deepEqual(frameDb, before);
  });

  it("does not apply peaks above the ceiling (peak guard)", () => {
    const spans = [{ startSec: 0.3, endSec: 1.0, rmsDb: -6 }]; // already loud
    const samples = synthesizeTake(spans, 1.5, -75);

    const frameDb: number[] = [];
    const frameCount = Math.floor(samples.length / FRAME_SAMPLES);
    for (let f = 0; f < frameCount; f += 1) {
      let sum = 0;
      for (let i = 0; i < FRAME_SAMPLES; i += 1) {
        const v = samples[f * FRAME_SAMPLES + i] ?? 0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / FRAME_SAMPLES);
      frameDb.push(rms <= 0 ? -120 : 20 * Math.log10(rms));
    }
    const metrics = analyzeFloatSamples(samples, SAMPLE_RATE, FRAME_MS);
    const mask = buildSpeechMask(frameDb, metrics.noiseFloorDb);
    const runs = speechRunsFromMask(mask);

    const plan = planGainCurve({
      frameDb,
      speechRuns: runs,
      noiseFloorDb: metrics.noiseFloorDb,
      speechThresholdDb: metrics.speechThresholdDb,
      pauseNoiseRisk: metrics.pauseNoiseRisk,
      frameMs: FRAME_MS,
      samples,
      sampleRate: SAMPLE_RATE,
      peakCeilingDb: -3,
    });

    const leveled = applyGainCurveToSamples(samples, plan.gainCurve, SAMPLE_RATE, 1, FRAME_MS);
    let maxAbs = 0;
    for (let i = 0; i < leveled.length; i += 1) if (Math.abs(leveled[i]) > maxAbs) maxAbs = Math.abs(leveled[i]);
    const peakDb = 20 * Math.log10(maxAbs + 1e-9);
    assert.ok(peakDb <= -2.5, `peak ceiling exceeded: ${peakDb.toFixed(2)} dB`);
  });
});

describe("run classification", () => {
  it("tags short high-crest runs as transient-breath and normal runs as body-speech", () => {
    // Without sample data the planner estimates peak = max(frameDb) + 12 dB,
    // so we can drive classification purely through frame-level dB values.
    const frameDb: number[] = [];
    // 1 s silence
    for (let i = 0; i < 100; i += 1) frameDb.push(-70);
    // 1.5 s dialogue body at -22 dB (frames 100..249, stable throughout —
    // max ≈ body so crest ≈ 12 dB → body-speech).
    for (let i = 0; i < 150; i += 1) frameDb.push(-22);
    // 0.3 s silence + two more normal body runs so the gasp is no longer
    // treated as a protected cold-open run.
    for (let i = 0; i < 30; i += 1) frameDb.push(-70);
    for (let i = 0; i < 100; i += 1) frameDb.push(-22);
    for (let i = 0; i < 30; i += 1) frameDb.push(-70);
    for (let i = 0; i < 100; i += 1) frameDb.push(-22);
    for (let i = 0; i < 140; i += 1) frameDb.push(-70);
    // 0.25 s gasp: 25 frames. 2 frames at 0 dB (gasp "puff"), 23 frames
    // at -25 dB (quiet post-puff tail). Body mean ≈ -11 dB, max = 0 dB,
    // estimated peak = 0 + 12 = +12 dB → crest ≈ 23 dB → transient-breath.
    for (let i = 0; i < 2; i += 1) frameDb.push(0);
    for (let i = 0; i < 23; i += 1) frameDb.push(-25);
    // 0.5 s silence
    for (let i = 0; i < 50; i += 1) frameDb.push(-70);

    const speechRuns = [
      { startFrame: 100, endFrame: 250 }, // dialogue (1.5 s)
      { startFrame: 280, endFrame: 380 }, // dialogue (1.0 s)
      { startFrame: 410, endFrame: 510 }, // dialogue (1.0 s)
      { startFrame: 650, endFrame: 675 }, // gasp (250 ms)
    ];
    const plan = planGainCurve({
      frameDb,
      speechRuns,
      noiseFloorDb: -70,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs: 10,
      targetDb: -22,
    });

    assert.equal(plan.runs.length, 4);
    assert.equal(plan.runs[0].runClass, "body-speech");
    assert.equal(
      plan.runs[3].runClass,
      "transient-breath",
      `gasp should classify as breath (crest=${plan.runs[3].crestDb.toFixed(1)} dB, len=${(plan.runs[3].endFrame - plan.runs[3].startFrame) * 10} ms)`,
    );
    assert.equal(plan.breathRunCount, 1);

    // Breath runs use a tighter ±6 dB clamp AND a lower target (breathTarget
    // = targetDb - 2.5 = -24.5). Whatever the gasp body RMS came out to,
    // the planned gain must stay within [-6, 6].
    const gaspGain = plan.runs[3].plannedGainDb;
    assert.ok(
      gaspGain <= 6 && gaspGain >= -6,
      `gasp gain must stay in tight breath clamp, got ${gaspGain.toFixed(2)} dB`,
    );
    // Body-speech dialogue gets the wider ±14 dB clamp, so it can rise or
    // fall more. This asserts we DIDN'T apply the breath clamp to dialogue.
    const dialogueGain = plan.runs[0].plannedGainDb;
    assert.ok(
      plan.runs[0].runClass === "body-speech" && Math.abs(dialogueGain) <= 14,
      `dialogue gain must use body-speech clamp (got ${dialogueGain.toFixed(2)} dB)`,
    );
  });
});

describe("loud-vocalization handling (onomatopoeia / yells / screams)", () => {
  it("materially narrows extreme phrase spread while retaining quiet-dialogue-emotion order", () => {
    const frameMs = 10;
    const frameDb = new Array<number>(1_600).fill(-70);
    const speechRuns: Array<{ startFrame: number; endFrame: number }> = [];
    let cursor = 40;
    const appendRun = (bodyDb: number, peakDb?: number) => {
      const run = { startFrame: cursor, endFrame: cursor + 100 };
      speechRuns.push(run);
      for (let frame = run.startFrame; frame < run.endFrame; frame += 1) {
        frameDb[frame] = bodyDb;
      }
      if (peakDb !== undefined) frameDb[run.startFrame + 50] = peakDb;
      cursor = run.endFrame + 30;
      return run;
    };
    for (let index = 0; index < 8; index += 1) appendRun(-22);
    const quietRun = appendRun(-38);
    const emotionalRun = appendRun(-6, 4);
    const frameDbBefore = frameDb.slice();
    const speechRunsBefore = speechRuns.map((run) => ({ ...run }));

    const plan = planGainCurve({
      frameDb,
      speechRuns,
      noiseFloorDb: -70,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.8,
    });

    const typicalRun = speechRuns[4];
    const outputBodyDb = (run: { startFrame: number; endFrame: number }) =>
      frameDb[run.startFrame + 25] + gainDbAtFrame(plan.gainCurve, run.startFrame + 25);
    const quietOutputDb = outputBodyDb(quietRun);
    const typicalOutputDb = outputBodyDb(typicalRun);
    const emotionalOutputDb = outputBodyDb(emotionalRun);
    const sourceSpreadDb = -6 - -38;
    const outputSpreadDb = emotionalOutputDb - quietOutputDb;

    assert.ok(sourceSpreadDb >= 30, `fixture must remain extreme, got ${sourceSpreadDb.toFixed(2)} dB`);
    assert.ok(
      outputSpreadDb < 8,
      `phrase-scale leveling should materially narrow the 32 dB source spread, got ${outputSpreadDb.toFixed(2)} dB`,
    );
    assert.ok(
      quietOutputDb < typicalOutputDb && typicalOutputDb < emotionalOutputDb,
      `performance order must remain quiet < dialogue < emotion, got ${quietOutputDb.toFixed(2)}, ${typicalOutputDb.toFixed(2)}, ${emotionalOutputDb.toFixed(2)} dB`,
    );
    assert.ok(
      emotionalOutputDb - typicalOutputDb >= 2,
      `the emotional phrase must retain audible emphasis, got ${(emotionalOutputDb - typicalOutputDb).toFixed(2)} dB`,
    );
    assert.deepEqual(frameDb, frameDbBefore, "planner must not mutate frame evidence");
    assert.deepEqual(speechRuns, speechRunsBefore, "planner must not mutate run boundaries");
  });

  it("spends deep correction as a smooth phrase-scale move, never a mid-word notch", () => {
    const frameMs = 10;
    const frameDb = new Array<number>(420).fill(-70);
    const speechRuns = [
      { startFrame: 40, endFrame: 140 },
      { startFrame: 190, endFrame: 340 },
    ];
    for (let frame = 40; frame < 140; frame += 1) frameDb[frame] = -22;
    for (let frame = 190; frame < 340; frame += 1) frameDb[frame] = -5;
    frameDb[265] = 3;

    const plan = planGainCurve({
      frameDb,
      speechRuns,
      noiseFloorDb: -70,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.8,
    });

    const bodyGainDb = Array.from(
      { length: 90 },
      (_, offset) => gainDbAtFrame(plan.gainCurve, 220 + offset),
    );
    const deepestGainDb = Math.min(...bodyGainDb);
    const shallowestGainDb = Math.max(...bodyGainDb);
    let maxAdjacentStepDb = 0;
    for (let index = 1; index < bodyGainDb.length; index += 1) {
      maxAdjacentStepDb = Math.max(
        maxAdjacentStepDb,
        Math.abs(bodyGainDb[index] - bodyGainDb[index - 1]),
      );
    }

    assert.ok(
      shallowestGainDb < -9,
      `extreme loudness needs phrase authority beyond the old 6 dB ceiling, got ${shallowestGainDb.toFixed(2)} dB`,
    );
    assert.ok(
      shallowestGainDb - deepestGainDb < 0.8,
      `a uniform loud phrase must not contain a local gain notch, range ${(shallowestGainDb - deepestGainDb).toFixed(3)} dB`,
    );
    assert.ok(
      maxAdjacentStepDb < 0.15,
      `body gain must not jump down/up between 10 ms frames, got ${maxAdjacentStepDb.toFixed(3)} dB`,
    );
  });

  it("changes continuously when adjacent phrase contrast crosses the former 8 dB boundary", () => {
    const planSecondRunGainDb = (secondBodyDb: number) => {
      const frameDb = new Array<number>(300).fill(-70);
      const speechRuns = [
        { startFrame: 30, endFrame: 130 },
        { startFrame: 160, endFrame: 260 },
      ];
      for (let frame = 30; frame < 130; frame += 1) frameDb[frame] = -24;
      for (let frame = 160; frame < 260; frame += 1) frameDb[frame] = secondBodyDb;
      const frameDbBefore = frameDb.slice();
      const speechRunsBefore = speechRuns.map((run) => ({ ...run }));

      const plan = planGainCurve({
        frameDb,
        speechRuns,
        noiseFloorDb: -70,
        speechThresholdDb: -55,
        pauseNoiseRisk: 0.1,
        frameMs: 10,
        targetDb: -22,
        sourceTargetBlend: 0,
        instabilityHint: 0.5,
      });

      assert.deepEqual(frameDb, frameDbBefore);
      assert.deepEqual(speechRuns, speechRunsBefore);
      return gainDbAtFrame(plan.gainCurve, 210);
    };

    const justInsideGainDb = planSecondRunGainDb(-16.01);
    const justOutsideGainDb = planSecondRunGainDb(-15.99);
    assert.ok(
      Math.abs(justOutsideGainDb - justInsideGainDb) < 0.15,
      `0.02 dB of source contrast must not cause a gain-policy cliff: ${justInsideGainDb.toFixed(3)} -> ${justOutsideGainDb.toFixed(3)} dB`,
    );
  });

  it("controls long high-crest body-speech runs without flattening them to dialogue", () => {
    const frameMs = 10;
    // 8 dialogue runs at body -22 dB anchor the trimmed-mean target near
    // -22 dB. One LOUD vocalization run with body +0 dB (extreme — well
    // above target+14 dB clamp) and a high crest factor (peak ~+6 dB
    // above body via framePeakDb estimation = max(frameDb) + 12 in
    // sample-less mode). This run should:
    //   1. classify as body-speech (1500 ms > 400 ms)
    //   2. get a high-crest sub-target shift down (because crest >= 13)
    //   3. trigger the post-clamp residual pass (since source is so loud
    //      that even the widened -18 dB clamp leaves applied body above
    //      target by 3+ dB)
    //   4. NOT touch dialogue runs at all
    const dialogueRuns: Array<{ startFrame: number; endFrame: number }> = [];
    let cursor = 50;
    for (let i = 0; i < 8; i += 1) {
      dialogueRuns.push({ startFrame: cursor, endFrame: cursor + 80 });
      cursor += 80 + 30;
    }
    const yellStart = cursor + 50;
    const yellEnd = yellStart + 150;
    const totalFrames = yellEnd + 100;

    const frameDb: number[] = [];
    for (let f = 0; f < totalFrames; f += 1) frameDb.push(-70);
    for (const run of dialogueRuns) {
      for (let f = run.startFrame; f < run.endFrame; f += 1) frameDb[f] = -22;
    }
    // Yell: body +0 dB. The synthesized peak from the frameDb-only path is
    // max(frameDb) + 12 = +12. crest = +12 - 0 = 12 dB. To trigger the
    // high-crest sub-target (>= 13), we set ONE frame slightly higher to
    // bump max-frame-db.
    for (let f = yellStart; f < yellEnd; f += 1) frameDb[f] = 0;
    frameDb[yellStart + 50] = 2; // peak frame: peakDb = 2 + 12 = 14 → crest = 14

    const speechRuns = [
      ...dialogueRuns,
      { startFrame: yellStart, endFrame: yellEnd },
    ];

    const plan = planGainCurve({
      frameDb,
      speechRuns,
      noiseFloorDb: -70,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs,
      targetDb: -22,
      instabilityHint: 0.7,
    });

    const yellRun = plan.runs.find((r) => r.startFrame === yellStart);
    assert.ok(yellRun, "yell run must appear in planner output");
    assert.equal(yellRun!.runClass, "body-speech");
    assert.ok(yellRun!.crestDb >= 13, `yell should have crest ≥ 13 dB; got ${yellRun!.crestDb.toFixed(1)}`);

    // Post-clamp residual MUST fire — yell body is +22 dB above target,
    // even widened ±18 clamp leaves applied body well above target.
    assert.ok(
      plan.sustainedLoudClusterCount >= 1,
      `post-clamp residual must fire on extreme-loud yell; got count ${plan.sustainedLoudClusterCount}`,
    );

    // Even an extreme vocalization is tamed continuously, not flattened to
    // dialogue. Phrase-scale authority may exceed 6 dB; the emotional body
    // still retains a small level advantage over ordinary dialogue.
    assert.ok(
      yellRun!.plannedGainDb <= -12 && yellRun!.plannedGainDb >= -18.1,
      `high-crest yell needs phrase-scale attenuation, got ${yellRun!.plannedGainDb.toFixed(2)} dB`,
    );
    const yellCenterGainDb = gainDbAtFrame(plan.gainCurve, yellStart + 75);
    const yellOutputBodyDb = frameDb[yellStart + 75] + yellCenterGainDb;
    assert.ok(
      yellOutputBodyDb >= plan.targetDb + 2 && yellOutputBodyDb <= plan.targetDb + 6.5,
      `the controlled yell must remain above dialogue without dominating it; got ${yellOutputBodyDb.toFixed(2)} dB`,
    );

    // Dialogue frames untouched.
    const dialogueFrame = dialogueRuns[3].startFrame + 20;
    const dialogueGainDb = 20 * Math.log10(plan.gainCurve[dialogueFrame] + 1e-9);
    assert.ok(
      Math.abs(dialogueGainDb) < 1.5,
      `dialogue frames must stay near body gain; got ${dialogueGainDb.toFixed(2)} dB`,
    );
  });

  it("retains a controlled level advantage for a normal-body high-crest scream", () => {
    // Yell body is relatively moderate (-12) but crest is high. It should
    // be controlled strongly while retaining the source's emotional order.
    const frameMs = 10;
    const dialogueRuns: Array<{ startFrame: number; endFrame: number }> = [];
    let cursor = 50;
    for (let i = 0; i < 8; i += 1) {
      dialogueRuns.push({ startFrame: cursor, endFrame: cursor + 80 });
      cursor += 80 + 30;
    }
    const yellStart = cursor + 50;
    const yellEnd = yellStart + 100;
    const totalFrames = yellEnd + 50;

    const frameDb: number[] = [];
    for (let f = 0; f < totalFrames; f += 1) frameDb.push(-70);
    for (const run of dialogueRuns) {
      for (let f = run.startFrame; f < run.endFrame; f += 1) frameDb[f] = -22;
    }
    // Yell body -12 dB (only 10 dB above dialogue body — within ±14 clamp)
    // with high crest via a peak frame.
    for (let f = yellStart; f < yellEnd; f += 1) frameDb[f] = -12;
    frameDb[yellStart + 30] = 4; // peakDb = 4 + 12 = 16 → crest 16 - (-12) ≈ 18 dB

    const speechRuns = [
      ...dialogueRuns,
      { startFrame: yellStart, endFrame: yellEnd },
    ];
    const plan = planGainCurve({
      frameDb,
      speechRuns,
      noiseFloorDb: -70,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs,
      targetDb: -22,
      instabilityHint: 0.7,
    });

    const yellRun = plan.runs.find((r) => r.startFrame === yellStart)!;
    assert.equal(yellRun.runClass, "body-speech");
    assert.ok(
      yellRun.plannedGainDb < -6 && yellRun.plannedGainDb > -10,
      `high-crest phrase should be controlled beyond the old ceiling without flattening, got ${yellRun.plannedGainDb.toFixed(2)} dB`,
    );
    const yellAppliedBodyDb = -12 + yellRun.plannedGainDb;
    assert.ok(
      yellAppliedBodyDb > -21 && yellAppliedBodyDb < -18,
      `high-crest yell should remain above dialogue but controlled; got ${yellAppliedBodyDb.toFixed(2)} dB`,
    );
  });
});

describe("source-native within-sentence emphasis", () => {
  it("preserves a below-ceiling stressed syllable for the source-relative delivery stage", () => {
    const sampleRate = 48000;
    const frameMs = 10;
    const samplesPerFrame = (sampleRate * frameMs) / 1000;
    // 2 s sentence body at -22 dB, with a 60 ms stressed syllable at frames
    // 100..105 whose peak remains below the absolute ceiling.
    const totalFrames = 200;
    const samples = new Float32Array(totalFrames * samplesPerFrame);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 300 * i) / sampleRate) * 0.08; // -22 dB body
    }
    // 6-frame stressed cluster at amplitude ≈ 0.45 (peak -7 dBFS, ~15 dB above body peak).
    for (let f = 100; f < 106; f += 1) {
      for (let i = 0; i < samplesPerFrame; i += 1) {
        samples[f * samplesPerFrame + i] = Math.sin((2 * Math.PI * 300 * i) / sampleRate) * 0.45;
      }
    }

    const frameDb: number[] = [];
    for (let f = 0; f < totalFrames; f += 1) frameDb.push(-22);
    for (let f = 100; f < 106; f += 1) frameDb[f] = -7; // matches the boosted samples

    const speechRuns = [{ startFrame: 0, endFrame: totalFrames }];
    const plan = planGainCurve({
      frameDb,
      speechRuns,
      noiseFloorDb: -70,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs,
      samples,
      sampleRate,
      targetDb: -22,
      peakCeilingDb: -4,
      instabilityHint: 0.7,
    });

    // Compute APPLIED frame dB (frame RMS + applied gain) at the spike
    // center (frame 102) and at a quiet body frame (frame 50).
    const appliedSpikeDb =
      frameDb[102] + 20 * Math.log10(plan.gainCurve[102] + 1e-9);
    const appliedBodyDb =
      frameDb[50] + 20 * Math.log10(plan.gainCurve[50] + 1e-9);
    const spikeAboveBodyDb = appliedSpikeDb - appliedBodyDb;

    // Natural emphasis is not evidence of a processing defect. The planner's
    // small micro-ride may move it, but must not flatten it source-blind.
    assert.ok(
      spikeAboveBodyDb >= 11,
      `source-native stress should remain clearly above body, got ${spikeAboveBodyDb.toFixed(2)} dB`,
    );
    assert.equal(plan.speechSpikeFrameCount, 0);
    assert.equal(plan.speechSpikeMaxReductionDb, 0);

    // Frames far from the spike are at body gain (no collateral ducking).
    const gainFar = 20 * Math.log10(plan.gainCurve[150] + 1e-9);
    const gainBody = 20 * Math.log10(plan.gainCurve[50] + 1e-9);
    assert.ok(
      Math.abs(gainFar - gainBody) < 0.3,
      `body frames far from the spike must match each other: ${gainFar.toFixed(2)} vs ${gainBody.toFixed(2)}`,
    );
  });
});

const synthesizeVoicedFricativeTake = ({
  sampleRate,
  durationSec,
  bodyRmsDb,
  consonantPeakDb,
  consonantCentersSec,
}: {
  sampleRate: number;
  durationSec: number;
  bodyRmsDb: number;
  consonantPeakDb: number | number[];
  consonantCentersSec: number[];
}) => {
  const samples = new Float32Array(Math.round(sampleRate * durationSec));
  const bodyMixRms = Math.sqrt((0.82 ** 2 + 0.18 ** 2) / 2);
  const bodyScale = dbToLin(bodyRmsDb) / bodyMixRms;
  for (let index = 0; index < samples.length; index += 1) {
    const timeSec = index / sampleRate;
    samples[index] = bodyScale * (
      0.82 * Math.sin(2 * Math.PI * 220 * timeSec)
      + 0.18 * Math.sin(2 * Math.PI * 510 * timeSec)
    );
  }

  const halfBurstSamples = Math.max(1, Math.round(sampleRate * 0.008));
  for (const [centerIndex, centerSec] of consonantCentersSec.entries()) {
    const targetPeakDb = Array.isArray(consonantPeakDb)
      ? consonantPeakDb[centerIndex] ?? consonantPeakDb[consonantPeakDb.length - 1] ?? -120
      : consonantPeakDb;
    const targetPeak = dbToLin(targetPeakDb);
    const centerSample = Math.round(centerSec * sampleRate);
    const start = Math.max(0, centerSample - halfBurstSamples);
    const end = Math.min(samples.length, centerSample + halfBurstSamples);
    const burst = new Float32Array(end - start);
    let burstPeak = 0;
    for (let offset = 0; offset < burst.length; offset += 1) {
      const timeSec = (start + offset) / sampleRate;
      const value = (
        0.22 * Math.sin(2 * Math.PI * 220 * timeSec)
        + 0.72 * Math.sin(2 * Math.PI * 5600 * timeSec)
        + 0.28 * Math.sin(2 * Math.PI * 6800 * timeSec)
      );
      burst[offset] = value;
      burstPeak = Math.max(burstPeak, Math.abs(value));
    }
    const burstScale = targetPeak / Math.max(1e-9, burstPeak);
    for (let offset = 0; offset < burst.length; offset += 1) {
      samples[start + offset] = burst[offset] * burstScale;
    }
  }
  return samples;
};

const peakDbNear = (
  samples: Float32Array,
  sampleRate: number,
  centerSec: number,
  halfWindowMs = 14,
) => {
  const halfWindowSamples = Math.max(1, Math.round((sampleRate * halfWindowMs) / 1000));
  const centerSample = Math.round(centerSec * sampleRate);
  const start = Math.max(0, centerSample - halfWindowSamples);
  const end = Math.min(samples.length, centerSample + halfWindowSamples);
  let peak = 0;
  for (let index = start; index < end; index += 1) {
    peak = Math.max(peak, Math.abs(samples[index]));
  }
  return peak > 0 ? 20 * Math.log10(peak) : -120;
};

const synthesizeDenseSixKhzPair = ({
  gapMs,
  secondPeakDb,
}: {
  gapMs: number;
  secondPeakDb: number;
}) => {
  const sampleRate = 48000;
  const durationSec = 0.4;
  const secondCenterSec = 0.1;
  const firstCenterSec = secondCenterSec - gapMs / 1000;
  const radiusSec = 0.003;
  const samples = new Float32Array(Math.round(sampleRate * durationSec));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = dbToLin(-24) * Math.sin((2 * Math.PI * 220 * index) / sampleRate);
  }
  for (const [centerSec, peakDb] of [
    [firstCenterSec, -4],
    [secondCenterSec, secondPeakDb],
  ] as const) {
    const start = Math.max(0, Math.ceil((centerSec - radiusSec) * sampleRate));
    const end = Math.min(samples.length - 1, Math.floor((centerSec + radiusSec) * sampleRate));
    for (let index = start; index <= end; index += 1) {
      const deltaSec = index / sampleRate - centerSec;
      const envelope = Math.cos((Math.PI * deltaSec) / (2 * radiusSec)) ** 2;
      // Overwrite the body in the event window, matching the adversarial
      // fixture that exposed sub-frame gain spill between adjacent fricatives.
      samples[index] = dbToLin(peakDb)
        * Math.sin((2 * Math.PI * 6000 * index) / sampleRate)
        * envelope;
    }
  }
  return { samples, sampleRate, firstCenterSec, secondCenterSec };
};

const synthesizeAdjacentWeakStrongLaneTake = (eventPeakDb: readonly [number, number]) => {
  const sampleRate = 48000;
  const durationSec = 0.4;
  const centersSec = [0.099, 0.101] as const;
  const eventRadiusSec = 0.0004;
  const samples = new Float32Array(Math.round(sampleRate * durationSec));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = dbToLin(-20.2)
      * Math.sin((2 * Math.PI * 220 * index) / sampleRate)
      * Math.SQRT2;
  }
  for (const [eventIndex, centerSec] of centersSec.entries()) {
    const centerSample = Math.round(centerSec * sampleRate);
    const radiusSamples = Math.round(eventRadiusSec * sampleRate);
    for (let index = centerSample - radiusSamples; index <= centerSample + radiusSamples; index += 1) {
      const normalizedOffset = (index - centerSample) / radiusSamples;
      const envelope = Math.cos((normalizedOffset * Math.PI) / 2) ** 2;
      samples[index] = dbToLin(eventPeakDb[eventIndex] ?? -120)
        * Math.sin((2 * Math.PI * 6000 * index) / sampleRate)
        * envelope;
    }
  }
  return {
    samples,
    sampleRate,
    centersSec,
    eventRadiusSamples: Math.round(eventRadiusSec * sampleRate),
  };
};

const synthesizeIsolatedEvidenceLaneTake = (eventPeakDb: readonly number[]) => {
  const sampleRate = 48000;
  const durationSec = 0.4;
  const centersSec = [0.051, 0.101, 0.201, 0.301] as const;
  const eventRadiusSec = 0.0004;
  const samples = new Float32Array(Math.round(sampleRate * durationSec));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = dbToLin(-20.2)
      * Math.sin((2 * Math.PI * 220 * index) / sampleRate)
      * Math.SQRT2;
  }
  for (const [eventIndex, centerSec] of centersSec.entries()) {
    const centerSample = Math.round(centerSec * sampleRate);
    const radiusSamples = Math.round(eventRadiusSec * sampleRate);
    for (let index = centerSample - radiusSamples; index <= centerSample + radiusSamples; index += 1) {
      const normalizedOffset = (index - centerSample) / radiusSamples;
      const envelope = Math.cos((normalizedOffset * Math.PI) / 2) ** 2;
      samples[index] = dbToLin(eventPeakDb[eventIndex] ?? -120)
        * Math.sin((2 * Math.PI * 6000 * index) / sampleRate)
        * envelope;
    }
  }
  return { samples, sampleRate, centersSec };
};

const synthesizeAlternatingEvidenceLaneTake = (
  eventPeakDb: readonly number[],
  centersSec: readonly number[] = [
    0.051,
    0.101,
    0.105,
    0.109,
    0.113,
    0.117,
    0.203,
    0.307,
  ],
) => {
  const sampleRate = 48000;
  const durationSec = 0.4;
  // The five central bursts occupy every other 2 ms owner. This reproduces
  // the alternating authorized/zero owner pattern measured in the German
  // stage probe while the irregular outer events keep reference alignment
  // unambiguous.
  const eventRadiusSec = 0.0004;
  const samples = new Float32Array(Math.round(sampleRate * durationSec));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = dbToLin(-20.2)
      * Math.sin((2 * Math.PI * 220 * index) / sampleRate)
      * Math.SQRT2;
  }
  for (const [eventIndex, centerSec] of centersSec.entries()) {
    const centerSample = Math.round(centerSec * sampleRate);
    const radiusSamples = Math.round(eventRadiusSec * sampleRate);
    for (let index = centerSample - radiusSamples; index <= centerSample + radiusSamples; index += 1) {
      const normalizedOffset = (index - centerSample) / radiusSamples;
      const envelope = Math.cos((normalizedOffset * Math.PI) / 2) ** 2;
      samples[index] = dbToLin(eventPeakDb[eventIndex] ?? -120)
        * Math.sin((2 * Math.PI * 6000 * index) / sampleRate)
        * envelope;
    }
  }
  return { samples, sampleRate, centersSec };
};

const synthesizeFractionalBoundaryLaneTake = (
  eventPeakDb: readonly [number, number | null],
) => {
  const sampleRate = 44_100;
  const durationSec = 0.4;
  const centers = [4454, 4498] as const;
  const eventRadiusSamples = Math.round(0.0004 * sampleRate);
  const samples = new Float32Array(Math.round(sampleRate * durationSec));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = dbToLin(-20.2)
      * Math.sin((2 * Math.PI * 220 * index) / sampleRate)
      * Math.SQRT2;
  }
  for (const [eventIndex, centerSample] of centers.entries()) {
    const peakDb = eventPeakDb[eventIndex];
    if (peakDb === null) continue;
    for (
      let index = centerSample - eventRadiusSamples;
      index <= centerSample + eventRadiusSamples;
      index += 1
    ) {
      const normalizedOffset = (index - centerSample) / eventRadiusSamples;
      const envelope = Math.cos((normalizedOffset * Math.PI) / 2) ** 2;
      samples[index] = dbToLin(peakDb)
        * Math.sin((2 * Math.PI * 6000 * index) / sampleRate)
        * envelope;
    }
  }
  return { samples, sampleRate, centers, eventRadiusSamples };
};

const maxSampleReductionDb = (
  before: Float32Array,
  after: Float32Array,
  startSample: number,
  endSampleInclusive: number,
) => {
  let maxReductionDb = 0;
  let nonzeroSampleCount = 0;
  let samplesOverWeakCap = 0;
  for (let index = startSample; index <= endSampleInclusive; index += 1) {
    if (Math.abs(before[index] ?? 0) <= 1e-8) continue;
    nonzeroSampleCount += 1;
    const reductionDb = 20 * Math.log10(
      Math.abs(before[index]) / Math.max(Math.abs(after[index]), 1e-12),
    );
    maxReductionDb = Math.max(maxReductionDb, reductionDb);
    if (reductionDb > 1.251) samplesOverWeakCap += 1;
  }
  return { maxReductionDb, nonzeroSampleCount, samplesOverWeakCap };
};

describe("narrow source-relative consonant owner-cap relaxation", () => {
  it("continuously relaxes isolated and two-cell caps with a five-tap triangular kernel", () => {
    const isolated = relaxNarrowConsonantOwnerCaps(
      Float32Array.from([0, 0, 0.6, 0, 0]),
    );
    const adjacentPair = relaxNarrowConsonantOwnerCaps(
      Float32Array.from([0, 0, 0.6, 0.6, 0, 0]),
    );
    assert.ok(
      Math.abs(isolated[2] - 0.6 * ((3 / 9) ** 4)) < 1e-6,
      `isolated owner should retain only its triangular self-support, got ${isolated[2].toFixed(6)} dB`,
    );
    assert.ok(
      Math.abs(adjacentPair[2] - 0.6 * ((5 / 9) ** 4)) < 1e-6,
      `first paired owner should blend self and adjacent support, got ${adjacentPair[2].toFixed(6)} dB`,
    );
    assert.ok(
      Math.abs(adjacentPair[3] - 0.6 * ((5 / 9) ** 4)) < 1e-6,
      `second paired owner should blend self and adjacent support, got ${adjacentPair[3].toFixed(6)} dB`,
    );
  });

  it("keeps native owners at zero and never grants more attenuation than an original owner cap", () => {
    const original = Float32Array.from([
      0,
      0.6,
      2.5,
      0,
      1.2,
      0.35,
      0,
      2,
      0,
    ]);
    const relaxed = relaxNarrowConsonantOwnerCaps(original);

    assert.equal(relaxed.length, original.length);
    for (let frame = 0; frame < original.length; frame += 1) {
      if (original[frame] === 0) {
        assert.equal(
          relaxed[frame],
          0,
          `native owner ${frame} must remain exactly zero instead of borrowing neighboring authority`,
        );
      }
      assert.ok(
        relaxed[frame] <= original[frame] + 1e-7,
        `owner ${frame} deepened from ${original[frame].toFixed(6)} to ${relaxed[frame].toFixed(6)} dB`,
      );
      assert.ok(
        relaxed[frame] >= 0,
        `owner ${frame} produced an invalid negative attenuation cap`,
      );
    }
  });

  it("relaxes the measured four-cell regression cluster without widening it", () => {
    const original = Float32Array.from([
      0,
      0,
      0.121,
      1.407,
      1.201,
      0.037,
      0,
      0,
    ]);
    const relaxed = relaxNarrowConsonantOwnerCaps(original, original);

    assert.ok(
      Math.abs(relaxed[3] - 0.124179) < 1e-6,
      `first strong 2 ms owner should relax to the measured safe cap, got ${relaxed[3].toFixed(6)} dB`,
    );
    assert.ok(
      Math.abs(relaxed[4] - 0.168164) < 1e-6,
      `second strong 2 ms owner should relax to the measured safe cap, got ${relaxed[4].toFixed(6)} dB`,
    );
    assert.deepEqual(
      Array.from(relaxed, (value, frame) => original[frame] === 0 ? value : 0),
      Array.from(original, () => 0),
      "the regression repair must not widen attenuation into unsupported owners",
    );
  });

  it("retains the interior depth of a sustained five-cell event", () => {
    const relaxed = relaxNarrowConsonantOwnerCaps(
      Float32Array.from([0, 0, 2.5, 2.5, 2.5, 2.5, 2.5, 0, 0]),
    );

    assert.ok(
      Math.abs(relaxed[4] - 2.5) < 1e-6,
      `five supported owners should retain full interior depth, got ${relaxed[4].toFixed(6)} dB`,
    );
    assert.ok(
      relaxed[2] <= relaxed[3] && relaxed[3] < relaxed[4],
      `event edges should ease continuously into the retained interior: ${Array.from(relaxed)
        .map((value) => value.toFixed(3))
        .join(", ")}`,
    );
    assert.ok(
      relaxed[4] > relaxed[5] && relaxed[5] >= relaxed[6],
      `event edges should ease continuously out of the retained interior: ${Array.from(relaxed)
        .map((value) => value.toFixed(3))
        .join(", ")}`,
    );
  });
});

describe("narrow body-speech planner-gain valley relaxation", () => {
  it("materially lifts one- through four-frame valleys without an engagement step", () => {
    for (const valleyFrames of [1, 2, 3, 4]) {
      const original = new Float32Array(81).fill(2);
      const valleyStart = 40 - Math.floor(valleyFrames / 2);
      original.fill(-2, valleyStart, valleyStart + valleyFrames);

      const relaxed = relaxNarrowBodySpeechGainValleys(
        original,
        new Float32Array(original.length).fill(-24),
        [{ startFrame: 5, endFrame: 76 }],
      );
      const valleyLiftDb = Array.from(
        relaxed.slice(valleyStart, valleyStart + valleyFrames),
        (gainDb, index) => gainDb - original[valleyStart + index],
      );

      assert.ok(
        valleyLiftDb.every((liftDb) => liftDb >= 0.4),
        `${valleyFrames}-frame valley should be materially relaxed, got lifts ${valleyLiftDb
          .map((value) => value.toFixed(6))
          .join(", ")} dB`,
      );
    }

    for (const valleyFrames of [13, 19]) {
      const original = new Float32Array(81).fill(2);
      const valleyStart = 40 - Math.floor(valleyFrames / 2);
      original.fill(-2, valleyStart, valleyStart + valleyFrames);
      const relaxed = relaxNarrowBodySpeechGainValleys(
        original,
        new Float32Array(original.length).fill(-24),
        [{ startFrame: 5, endFrame: 76 }],
      );
      assert.ok(
        relaxed[40] - original[40] >= 0.4,
        `${valleyFrames}-frame measured-width valley should be materially relaxed at its center`,
      );
    }

    const shallow = new Float32Array(61).fill(2);
    shallow[30] = 1.99;
    const shallowRelaxed = relaxNarrowBodySpeechGainValleys(
      shallow,
      new Float32Array(shallow.length).fill(-24),
      [{ startFrame: 0, endFrame: shallow.length }],
    );
    assert.ok(
      shallowRelaxed[30] > shallow[30] && shallowRelaxed[30] < 2,
      `a shallow valley should receive a proportionate nonzero lift, got ${shallowRelaxed[30].toFixed(6)} dB`,
    );
  });

  it("preserves sustained and one-sided lower passages", () => {
    const original = new Float32Array(81).fill(2);
    for (let frame = 10; frame <= 30; frame += 1) {
      original[frame] = 2 - ((frame - 10) / 20) * 4;
    }
    original.fill(-2, 31, 71);

    const relaxed = relaxNarrowBodySpeechGainValleys(
      original,
      new Float32Array(original.length).fill(-24),
      [{ startFrame: 5, endFrame: 76 }],
    );

    assert.equal(
      relaxed[40],
      original[40],
      "the fully supported center of a sustained lower plateau must retain its intended depth",
    );
    assert.equal(
      relaxed[32],
      original[32],
      "a low passage with one equally low shoulder must not be mistaken for a narrow valley",
    );
  });

  it("leaves constant gain, run edges, and every frame outside supplied runs exact", () => {
    const constant = new Float32Array(12).fill(1.25);
    assert.deepEqual(
      relaxNarrowBodySpeechGainValleys(
        constant,
        new Float32Array(constant.length).fill(-24),
        [{ startFrame: 2, endFrame: 10 }],
      ),
      constant,
      "a constant planner curve must remain sample-exact",
    );

    const original = new Float32Array(81).fill(2);
    original[4] = -3;
    original[21] = -2;
    original[40] = -2;
    original[76] = -3;
    const relaxed = relaxNarrowBodySpeechGainValleys(
      original,
      new Float32Array(original.length).fill(-24),
      [{ startFrame: 20, endFrame: 61 }],
    );

    assert.equal(relaxed[4], original[4], "a valley before the supplied run must remain exact");
    assert.equal(relaxed[76], original[76], "a valley after the supplied run must remain exact");
    assert.equal(
      relaxed[21],
      original[21],
      "a run-edge valley without two-sided body context must remain exact",
    );
    assert.ok(relaxed[40] > original[40], "the same valley with two-sided body context should relax");
  });

  it("is immutable and can only lift, never lower, planner gain", () => {
    const original = Float32Array.from([
      -1,
      0.5,
      -2,
      1,
      -0.25,
      2,
      -3,
      0,
      1.5,
    ]);
    const snapshot = new Float32Array(original);
    const relaxed = relaxNarrowBodySpeechGainValleys(
      original,
      new Float32Array(original.length).fill(-24),
      [{ startFrame: 1, endFrame: 8 }],
    );

    assert.deepEqual(original, snapshot, "valley relaxation must not mutate its input curve");
    for (let frame = 0; frame < original.length; frame += 1) {
      assert.ok(
        relaxed[frame] >= original[frame],
        `frame ${frame} was lowered from ${original[frame].toFixed(6)} to ${relaxed[frame].toFixed(6)} dB`,
      );
    }
  });

  it("does not undo intentional leveling or flatten natural source dynamics", () => {
    const flatOutputGain = new Float32Array(81).fill(1.5);
    const flatOutputSource = new Float32Array(81).fill(-23.5);
    flatOutputGain.fill(-1.5, 38, 42);
    flatOutputSource.fill(-20.5, 38, 42);

    const flatOutputRelaxed = relaxNarrowBodySpeechGainValleys(
      flatOutputGain,
      flatOutputSource,
      [{ startFrame: 5, endFrame: 76 }],
    );
    assert.deepEqual(
      flatOutputRelaxed,
      flatOutputGain,
      "a gain valley that intentionally levels a loud phoneme to flat output must remain exact",
    );

    const naturalDipGain = new Float32Array(81).fill(1);
    const naturalDipSource = new Float32Array(81).fill(-23);
    naturalDipSource.fill(-26, 38, 42);
    const naturalDipRelaxed = relaxNarrowBodySpeechGainValleys(
      naturalDipGain,
      naturalDipSource,
      [{ startFrame: 5, endFrame: 76 }],
    );
    assert.deepEqual(
      naturalDipRelaxed,
      naturalDipGain,
      "an unchanged natural source valley must not be mistaken for processing damage",
    );
  });

  it("lifts only the processing-added portion of a real planned-output valley", () => {
    const gain = new Float32Array(81).fill(1.5);
    const source = new Float32Array(81).fill(-23.5);
    gain.fill(-1.5, 38, 42);
    source.fill(-21.5, 38, 42);

    const relaxed = relaxNarrowBodySpeechGainValleys(
      gain,
      source,
      [{ startFrame: 5, endFrame: 76 }],
    );
    for (let frame = 38; frame < 42; frame += 1) {
      const originalOutputDb = source[frame] + gain[frame];
      const relaxedOutputDb = source[frame] + relaxed[frame];
      assert.ok(
        relaxedOutputDb > originalOutputDb,
        `frame ${frame} should receive a continuous lift for its real output valley`,
      );
      assert.ok(
        relaxedOutputDb < -22,
        `frame ${frame} must remain below the -22 dB shoulders instead of becoming a bump`,
      );
    }

    const naturallyQuietSource = new Float32Array(81).fill(-22);
    const naturallyQuietGain = new Float32Array(81);
    naturallyQuietSource.fill(-24, 38, 42);
    naturallyQuietGain.fill(-1, 38, 42);
    const naturallyQuietRelaxed = relaxNarrowBodySpeechGainValleys(
      naturallyQuietGain,
      naturallyQuietSource,
      [{ startFrame: 5, endFrame: 76 }],
    );
    for (let frame = 38; frame < 42; frame += 1) {
      const liftDb = naturallyQuietRelaxed[frame] - naturallyQuietGain[frame];
      assert.ok(
        liftDb > 0 && liftDb < 1,
        `only the extra 1 dB processing dip should be relaxed, got ${liftDb.toFixed(6)} dB`,
      );
    }
  });
});

describe("recurrent voiced-body continuity", () => {
  it("fails open on mismatched, non-finite, or invalid evidence without mutating inputs", () => {
    const gain = Float32Array.from(
      { length: 300 },
      (_, frame) => Math.sin(frame / 19) * 1.25,
    );
    const source = new Float32Array(300).fill(-24);
    const body = new Float32Array(300).fill(-25);
    const runs = [{ startFrame: 20, endFrame: 280 }];
    const gainSnapshot = new Float32Array(gain);
    const sourceSnapshot = new Float32Array(source);
    const bodySnapshot = new Float32Array(body);
    const runSnapshot = runs.map((run) => ({ ...run }));

    const mismatched = recoverRecurrentBodySpeechValleys(
      gain,
      source,
      body.subarray(0, body.length - 1),
      runs,
      14,
      10,
    );
    const invalidDuration = recoverRecurrentBodySpeechValleys(
      gain,
      source,
      body,
      runs,
      14,
      0,
    );
    const nonFiniteSource = new Float32Array(source);
    const nonFiniteBody = new Float32Array(body);
    for (let frame = 20; frame < 280; frame += 1) {
      if ((frame - 20) % 24 < 8) {
        nonFiniteSource[frame] -= 10;
        nonFiniteBody[frame] -= 10;
      }
    }
    nonFiniteBody[150] = Number.NaN;
    const nonFiniteSourceSnapshot = new Float32Array(nonFiniteSource);
    const nonFiniteBodySnapshot = new Float32Array(nonFiniteBody);
    const nonFinite = recoverRecurrentBodySpeechValleys(
      gain,
      nonFiniteSource,
      nonFiniteBody,
      runs,
      14,
      10,
    );

    for (const result of [mismatched, invalidDuration, nonFinite]) {
      assert.notEqual(result, gain);
      assert.deepEqual(result, gainSnapshot);
      assert.ok([...result].every(Number.isFinite));
    }
    assert.deepEqual(gain, gainSnapshot);
    assert.deepEqual(source, sourceSnapshot);
    assert.deepEqual(body, bodySnapshot);
    assert.deepEqual(nonFiniteSource, nonFiniteSourceSnapshot);
    assert.deepEqual(nonFiniteBody, nonFiniteBodySnapshot);
    assert.deepEqual(runs, runSnapshot);
  });

  it("does not turn one native upward event or modest voiced vibrato into body fill", () => {
    const frameCount = 400;
    const flatGain = new Float32Array(frameCount);
    const nativeEvent = new Float32Array(frameCount).fill(-24);
    nativeEvent.fill(-17, 198, 202);
    const nativeResult = recoverRecurrentBodySpeechValleys(
      flatGain,
      nativeEvent,
      nativeEvent,
      [{ startFrame: 50, endFrame: 350 }],
      14,
      10,
    );
    assert.ok(
      Math.max(...nativeResult.map(Math.abs)) <= 0.05,
      "a native upward event must not create gain in its surrounding body",
    );

    const vibrato = Float32Array.from(
      { length: frameCount },
      (_, frame) => -24 + 1.5 * Math.sin(2 * Math.PI * 5.5 * frame * 0.01),
    );
    const vibratoResult = recoverRecurrentBodySpeechValleys(
      flatGain,
      vibrato,
      vibrato,
      [{ startFrame: 50, endFrame: 350 }],
      14,
      10,
    );
    const sourceSlice = [...vibrato.slice(70, 330)];
    const outputSlice = sourceSlice.map(
      (value, index) => value + vibratoResult[index + 70],
    );
    const sourceDepthDb = Math.max(...sourceSlice) - Math.min(...sourceSlice);
    const outputDepthDb = Math.max(...outputSlice) - Math.min(...outputSlice);
    assert.ok(
      Math.max(...vibratoResult.map(Math.abs)) <= 0.8,
      "modest voiced vibrato may receive only a subtle continuity touch",
    );
    assert.ok(
      outputDepthDb >= sourceDepthDb * 0.6,
      `vibrato depth must remain expressive, source ${sourceDepthDb.toFixed(2)} vs output ${outputDepthDb.toFixed(2)} dB`,
    );
  });
});

describe("full-rate rendered consonant peak tamer", () => {
  it("tames narrow full-rate consonant peaks without changing the surrounding voice body", () => {
    const sampleRate = 48000;
    const frameMs = 10;
    const samplesPerFrame = (sampleRate * frameMs) / 1000;
    const totalFrames = 220;
    const samples = new Float32Array(totalFrames * samplesPerFrame);

    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 260 * i) / sampleRate) * dbToLin(-28) * Math.SQRT2;
    }
    const spikeIndex = 110 * samplesPerFrame + 80;
    samples[spikeIndex] = dbToLin(-3.5);

    const bodyStart = 40 * samplesPerFrame;
    const bodyEnd = 90 * samplesPerFrame;
    const bodyBeforeDb = measureRmsDb(samples, bodyStart, bodyEnd);
    const result = tameRenderedConsonantPeaks(samples, sampleRate, frameMs);
    const bodyAfterDb = measureRmsDb(result.samples, bodyStart, bodyEnd);
    let peakBefore = 0;
    let peakAfter = 0;
    for (let index = 109 * samplesPerFrame; index < 112 * samplesPerFrame; index += 1) {
      peakBefore = Math.max(peakBefore, Math.abs(samples[index]));
      peakAfter = Math.max(peakAfter, Math.abs(result.samples[index]));
    }

    assert.ok(result.stats.tamedFrameCount >= 1, "full-rate tamer should catch the isolated consonant spike");
    assert.ok(
      20 * Math.log10(peakAfter) <= -8,
      `consonant peak should be pulled below -8 dBFS, got ${(20 * Math.log10(peakAfter)).toFixed(2)} dB`,
    );
    assert.ok(
      20 * Math.log10(peakBefore) - 20 * Math.log10(peakAfter) >= 4,
      "peak should receive a visible local reduction",
    );
    assert.ok(
      Math.abs(bodyAfterDb - bodyBeforeDb) < 0.05,
      `surrounding actor body must not move: before ${bodyBeforeDb.toFixed(2)} dB after ${bodyAfterDb.toFixed(2)} dB`,
    );
  });

  it("leaves normal loud voice emphasis alone when peak-over-body is natural", () => {
    const sampleRate = 48000;
    const frameMs = 10;
    const samplesPerFrame = (sampleRate * frameMs) / 1000;
    const totalFrames = 180;
    const samples = new Float32Array(totalFrames * samplesPerFrame);

    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 300 * i) / sampleRate) * dbToLin(-18) * Math.SQRT2;
    }
    samples[90 * samplesPerFrame + 40] = dbToLin(-8.5);

    const result = tameRenderedConsonantPeaks(samples, sampleRate, frameMs);

    assert.equal(result.stats.tamedFrameCount, 0);
    assert.deepEqual(result.samples, samples);
  });

  it("subtly repairs source-worsened voiced fricatives at the start, middle, and end", () => {
    const sampleRate = 48000;
    const frameMs = 10;
    const durationSec = 2.2;
    const consonantCentersSec = [0.04, 1.1, durationSec - 0.04];
    const referenceSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -20.2,
      consonantPeakDb: -4,
      consonantCentersSec,
    });
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: -4,
      consonantCentersSec,
    });
    const bodyStart = Math.round(sampleRate * 0.4);
    const bodyEnd = Math.round(sampleRate * 0.8);
    const referenceBodyDb = measureRmsDb(referenceSamples, bodyStart, bodyEnd);
    const renderedBodyDb = measureRmsDb(renderedSamples, bodyStart, bodyEnd);
    for (const centerSec of consonantCentersSec) {
      const referenceContrastDb = peakDbNear(referenceSamples, sampleRate, centerSec) - referenceBodyDb;
      const renderedContrastDb = peakDbNear(renderedSamples, sampleRate, centerSec) - renderedBodyDb;
      assert.ok(
        Math.abs((renderedContrastDb - referenceContrastDb) - 3.8) < 0.15,
        `fixture must reproduce about 3.8 dB of render-created consonant contrast, got ${(renderedContrastDb - referenceContrastDb).toFixed(2)} dB`,
      );
    }

    const bodyBeforeDb = measureRmsDb(renderedSamples, bodyStart, bodyEnd);
    const result = tameRenderedConsonantPeaks(renderedSamples, sampleRate, frameMs, {
      referenceSamples,
      referenceSampleRate: sampleRate,
      referenceMatchWindowMs: 20,
    });
    const bodyAfterDb = measureRmsDb(result.samples, bodyStart, bodyEnd);

    assert.equal(result.samples.length, renderedSamples.length, "source-aware repair must preserve sample length");
    assert.ok(result.stats.tamedFrameCount >= 3, "each start, middle, and final fricative should receive local repair");
    assert.ok(result.stats.maxReductionDb > 0 && result.stats.maxReductionDb <= 1.5, `source-relative repair must stay below the audible micro-dip budget, got ${result.stats.maxReductionDb.toFixed(2)} dB`);
    for (const centerSec of consonantCentersSec) {
      const reductionDb = peakDbNear(renderedSamples, sampleRate, centerSec) - peakDbNear(result.samples, sampleRate, centerSec);
      assert.ok(reductionDb >= 0.3, `fricative at ${centerSec.toFixed(2)} s should receive a measurable local reduction`);
      assert.ok(reductionDb <= 1.5, `fricative at ${centerSec.toFixed(2)} s must not be reduced more than 1.5 dB, got ${reductionDb.toFixed(2)} dB`);
    }
    assert.ok(
      Math.abs(bodyAfterDb - bodyBeforeDb) < 0.05,
      `surrounding voice body must stay stable: before ${bodyBeforeDb.toFixed(2)} dB after ${bodyAfterDb.toFixed(2)} dB`,
    );
    const tailStart = result.samples.length - Math.round(sampleRate * 0.02);
    assert.ok(measureRmsDb(result.samples, tailStart, result.samples.length) > -50, "sentence-final repair must preserve a nonzero voiced tail");
  });

  it("subtly repairs weak-but-real full-band source evidence without authorizing a low-rate equivalent", () => {
    const renderedSampleRate = 48000;
    const lowReferenceSampleRate = 16000;
    const durationSec = 1.6;
    const eventSec = 0.8;
    const bodyRmsDb = -20.2;
    const sourcePeakDb = -10.4;
    const renderedPeakDb = -3.9;
    const fullBandReferenceSamples = synthesizeVoicedFricativeTake({
      sampleRate: renderedSampleRate,
      durationSec,
      bodyRmsDb,
      consonantPeakDb: sourcePeakDb,
      consonantCentersSec: [eventSec],
    });
    const lowRateReferenceSamples = synthesizeVoicedFricativeTake({
      sampleRate: lowReferenceSampleRate,
      durationSec,
      bodyRmsDb,
      consonantPeakDb: sourcePeakDb,
      consonantCentersSec: [eventSec],
    });
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate: renderedSampleRate,
      durationSec,
      bodyRmsDb,
      consonantPeakDb: renderedPeakDb,
      consonantCentersSec: [eventSec],
    });
    const bodyStart = Math.round(renderedSampleRate * 0.2);
    const bodyEnd = Math.round(renderedSampleRate * 0.5);
    const sourceBodyDb = measureRmsDb(fullBandReferenceSamples, bodyStart, bodyEnd);
    const renderedBodyDb = measureRmsDb(renderedSamples, bodyStart, bodyEnd);
    const sourceContrastDb = peakDbNear(
      fullBandReferenceSamples,
      renderedSampleRate,
      eventSec,
      8,
    ) - sourceBodyDb;
    const renderedContrastDb = peakDbNear(renderedSamples, renderedSampleRate, eventSec, 8) - renderedBodyDb;
    assert.ok(
      sourceContrastDb >= 9 && sourceContrastDb <= 11,
      `fixture needs weak positive source contrast near 9.8 dB, got ${sourceContrastDb.toFixed(2)} dB`,
    );
    assert.ok(
      renderedContrastDb - sourceContrastDb >= 6 && renderedContrastDb - sourceContrastDb <= 7,
      `fixture needs 6-7 dB of processing growth, got ${(renderedContrastDb - sourceContrastDb).toFixed(2)} dB`,
    );

    const fullBandReference = buildRenderedConsonantReference(
      fullBandReferenceSamples,
      renderedSampleRate,
    );
    const lowRateReference = buildRenderedConsonantReference(
      lowRateReferenceSamples,
      lowReferenceSampleRate,
    );
    assert.ok(fullBandReference);
    assert.ok(lowRateReference);
    const fullBandResult = tameRenderedConsonantPeaks(renderedSamples, renderedSampleRate, 10, {
      reference: fullBandReference,
      maxReductionDb: 2.5,
    });
    const lowRateResult = tameRenderedConsonantPeaks(renderedSamples, renderedSampleRate, 10, {
      reference: lowRateReference,
      maxReductionDb: 2.5,
    });
    const fullBandReductionDb = peakDbNear(renderedSamples, renderedSampleRate, eventSec, 8)
      - peakDbNear(fullBandResult.samples, renderedSampleRate, eventSec, 8);

    assert.equal(fullBandResult.stats.referenceUsed, true);
    assert.ok(
      fullBandReductionDb >= 0.1 && fullBandReductionDb <= 1.25,
      `full-band weak evidence should authorize only subtle repair, got ${fullBandReductionDb.toFixed(3)} dB`,
    );
    assert.ok(
      fullBandResult.stats.maxReductionDb <= 1.25,
      `weak-evidence planning must stay under 1.25 dB, got ${fullBandResult.stats.maxReductionDb.toFixed(3)} dB`,
    );
    assert.ok(
      Math.abs(measureRmsDb(fullBandResult.samples, bodyStart, bodyEnd) - renderedBodyDb) < 0.01,
      "weak-evidence repair must remain local to the consonant",
    );
    assert.equal(lowRateResult.stats.tamedFrameCount, 0);
    assert.equal(lowRateResult.stats.maxReductionDb, 0);
    assert.deepEqual(lowRateResult.samples, renderedSamples);
  });

  it("never lets an adjacent strong lane lend its residual budget to weak or native owner samples", () => {
    const source = synthesizeAdjacentWeakStrongLaneTake([-10.4, -4]);
    const rendered = synthesizeAdjacentWeakStrongLaneTake([-3.9, 2]);
    const reference = buildRenderedConsonantReference(source.samples, source.sampleRate);
    assert.ok(reference);
    const result = tameRenderedConsonantPeaks(rendered.samples, rendered.sampleRate, 10, {
      reference,
      maxReductionDb: 2.5,
    });
    const samplesPerEvidenceFrame = Math.round(
      (rendered.sampleRate * RENDERED_CONSONANT_SOURCE_FRAME_MS) / 1000,
    );
    const weakCenterSample = Math.round(rendered.centersSec[0] * rendered.sampleRate);
    const strongCenterSample = Math.round(rendered.centersSec[1] * rendered.sampleRate);
    const weak = maxSampleReductionDb(
      rendered.samples,
      result.samples,
      weakCenterSample - rendered.eventRadiusSamples,
      weakCenterSample + rendered.eventRadiusSamples,
    );
    const strong = maxSampleReductionDb(
      rendered.samples,
      result.samples,
      strongCenterSample - rendered.eventRadiusSamples,
      strongCenterSample + rendered.eventRadiusSamples,
    );
    const nativeOwnerFrame = Math.floor(weakCenterSample / samplesPerEvidenceFrame) - 1;
    const native = maxSampleReductionDb(
      rendered.samples,
      result.samples,
      nativeOwnerFrame * samplesPerEvidenceFrame,
      (nativeOwnerFrame + 1) * samplesPerEvidenceFrame - 1,
    );

    assert.equal(weak.nonzeroSampleCount, 28);
    assert.equal(
      weak.samplesOverWeakCap,
      0,
      `${weak.samplesOverWeakCap}/${weak.nonzeroSampleCount} weak-owner samples borrowed the strong budget`,
    );
    assert.ok(weak.maxReductionDb <= 1.251, `weak owner reached ${weak.maxReductionDb.toFixed(6)} dB`);
    assert.ok(
      strong.maxReductionDb > 0.05 && strong.maxReductionDb <= 1.251,
      `a two-frame strong owner should retain only subtle repair, got ${strong.maxReductionDb.toFixed(6)} dB`,
    );
    assert.ok(native.maxReductionDb <= 0.001, `native owner borrowed ${native.maxReductionDb.toFixed(6)} dB`);
  });

  it("keeps an isolated 2 ms source-relative repair subtle instead of creating a broadband down-up hole", () => {
    const source = synthesizeIsolatedEvidenceLaneTake([-4, -4, -4, -4]);
    const rendered = synthesizeIsolatedEvidenceLaneTake([-4, 2, -4, -4]);
    const reference = buildRenderedConsonantReference(source.samples, source.sampleRate);
    assert.ok(reference);

    const result = tameRenderedConsonantPeaks(rendered.samples, rendered.sampleRate, 10, {
      reference,
      maxReductionDb: 2.5,
    });
    const samplesPerEvidenceFrame = Math.round(
      (rendered.sampleRate * RENDERED_CONSONANT_SOURCE_FRAME_MS) / 1000,
    );
    const targetFrame = Math.floor(
      (rendered.centersSec[1] * 1000) / RENDERED_CONSONANT_SOURCE_FRAME_MS,
    );
    const targetFrameStart = targetFrame * samplesPerEvidenceFrame;
    const targetFrameEnd = targetFrameStart + samplesPerEvidenceFrame - 1;
    const target = maxSampleReductionDb(
      rendered.samples,
      result.samples,
      targetFrameStart,
      targetFrameEnd,
    );

    assert.equal(result.stats.referenceUsed, true);
    assert.ok(target.maxReductionDb > 0.005, `isolated processing growth still needs subtle nonzero repair, got ${target.maxReductionDb.toFixed(3)} dB`);
    assert.ok(
      target.maxReductionDb <= 0.15,
      `one isolated 2 ms owner must not create a deep broadband hole, got ${target.maxReductionDb.toFixed(3)} dB`,
    );
    assert.deepEqual(
      result.samples.slice(targetFrameStart - samplesPerEvidenceFrame, targetFrameStart),
      rendered.samples.slice(targetFrameStart - samplesPerEvidenceFrame, targetFrameStart),
      "the preceding native owner must remain sample-identical",
    );
    assert.deepEqual(
      result.samples.slice(targetFrameEnd + 1, targetFrameEnd + 1 + samplesPerEvidenceFrame),
      rendered.samples.slice(targetFrameEnd + 1, targetFrameEnd + 1 + samplesPerEvidenceFrame),
      "the following native owner must remain sample-identical",
    );
  });

  it("ramps repair depth across two adjacent 2 ms owners instead of opening a 4 ms depth cliff", () => {
    const source = synthesizeAdjacentWeakStrongLaneTake([-4, -4]);
    const rendered = synthesizeAdjacentWeakStrongLaneTake([2, 2]);
    const reference = buildRenderedConsonantReference(source.samples, source.sampleRate);
    assert.ok(reference);

    const result = tameRenderedConsonantPeaks(rendered.samples, rendered.sampleRate, 10, {
      reference,
      maxReductionDb: 2.5,
    });
    const samplesPerEvidenceFrame = Math.round(
      (rendered.sampleRate * RENDERED_CONSONANT_SOURCE_FRAME_MS) / 1000,
    );
    const firstOwnerFrame = Math.floor(
      (rendered.centersSec[0] * 1000) / RENDERED_CONSONANT_SOURCE_FRAME_MS,
    );
    const firstOwnerStart = firstOwnerFrame * samplesPerEvidenceFrame;
    const secondOwnerEnd = (firstOwnerFrame + 2) * samplesPerEvidenceFrame - 1;
    const pair = maxSampleReductionDb(
      rendered.samples,
      result.samples,
      firstOwnerStart,
      secondOwnerEnd,
    );

    assert.equal(result.stats.referenceUsed, true);
    assert.ok(
      pair.maxReductionDb >= 0.1,
      `two adjacent processing-grown owners should retain useful subtle repair, got ${pair.maxReductionDb.toFixed(3)} dB`,
    );
    assert.ok(
      pair.maxReductionDb <= 1.75,
      `two adjacent 2 ms owners must not jump to the full residual depth, got ${pair.maxReductionDb.toFixed(3)} dB`,
    );
    assert.deepEqual(
      result.samples.slice(firstOwnerStart - samplesPerEvidenceFrame, firstOwnerStart),
      rendered.samples.slice(firstOwnerStart - samplesPerEvidenceFrame, firstOwnerStart),
      "the preceding native owner must remain sample-identical",
    );
    assert.deepEqual(
      result.samples.slice(secondOwnerEnd + 1, secondOwnerEnd + 1 + samplesPerEvidenceFrame),
      rendered.samples.slice(secondOwnerEnd + 1, secondOwnerEnd + 1 + samplesPerEvidenceFrame),
      "the following native owner must remain sample-identical",
    );
  });

  it("reconciles one-frame holes inside a processing-grown consonant event without raising its bounded depth", () => {
    const source = synthesizeAlternatingEvidenceLaneTake([
      -4,
      -4,
      -4,
      -4,
      -4,
      -4,
      -4,
      -4,
    ]);
    const rendered = synthesizeAlternatingEvidenceLaneTake([
      -4,
      2,
      2,
      2,
      2,
      2,
      -4,
      -4,
    ]);
    const reference = buildRenderedConsonantReference(source.samples, source.sampleRate);
    assert.ok(reference);

    const result = tameRenderedConsonantPeaks(rendered.samples, rendered.sampleRate, 10, {
      reference,
      maxReductionDb: 2.5,
    });
    const samplesPerEvidenceFrame = Math.round(
      (rendered.sampleRate * RENDERED_CONSONANT_SOURCE_FRAME_MS) / 1000,
    );
    const firstEvidenceFrame = Math.floor(
      (rendered.centersSec[1] * 1000) / RENDERED_CONSONANT_SOURCE_FRAME_MS,
    );
    const ownerPeakReductionDb = (frame: number) => maxSampleReductionDb(
      rendered.samples,
      result.samples,
      frame * samplesPerEvidenceFrame,
      (frame + 1) * samplesPerEvidenceFrame - 1,
    ).maxReductionDb;
    const evidenceReductionDb = Array.from(
      { length: 5 },
      (_, eventIndex) => ownerPeakReductionDb(firstEvidenceFrame + eventIndex * 2),
    );
    const bridgedReductionDb = Array.from(
      { length: 4 },
      (_, gapIndex) => ownerPeakReductionDb(firstEvidenceFrame + gapIndex * 2 + 1),
    );

    assert.equal(result.stats.referenceUsed, true);
    assert.ok(
      evidenceReductionDb.every((reductionDb) => reductionDb >= 0.04 && reductionDb <= 0.25),
      `multi-frame event must retain useful repair, got ${evidenceReductionDb.map((value) => value.toFixed(3)).join(", ")}`,
    );
    assert.ok(
      bridgedReductionDb.every((reductionDb) => reductionDb >= 0.005 && reductionDb <= 0.1),
      `one-frame event holes must receive a soft bridge, got ${bridgedReductionDb.map((value) => value.toFixed(3)).join(", ")}`,
    );
    for (const [gapIndex, bridgedDb] of bridgedReductionDb.entries()) {
      assert.ok(
        bridgedDb
          <= Math.min(evidenceReductionDb[gapIndex], evidenceReductionDb[gapIndex + 1]) * 0.41,
        `bridge ${gapIndex} borrowed depth: ${bridgedDb.toFixed(3)} dB vs neighbors ${evidenceReductionDb[gapIndex].toFixed(3)}/${evidenceReductionDb[gapIndex + 1].toFixed(3)} dB`,
      );
    }
    assert.ok(
      result.stats.maxReductionDb <= 0.75,
      `bridging must not deepen the event's existing isolated-owner ceiling, got ${result.stats.maxReductionDb.toFixed(3)} dB`,
    );
    assert.deepEqual(
      result.samples.slice(
        (firstEvidenceFrame - 1) * samplesPerEvidenceFrame,
        firstEvidenceFrame * samplesPerEvidenceFrame,
      ),
      rendered.samples.slice(
        (firstEvidenceFrame - 1) * samplesPerEvidenceFrame,
        firstEvidenceFrame * samplesPerEvidenceFrame,
      ),
      "an unbounded owner before the event must remain sample-identical",
    );
    assert.deepEqual(
      result.samples.slice(
        (firstEvidenceFrame + 9) * samplesPerEvidenceFrame,
        (firstEvidenceFrame + 10) * samplesPerEvidenceFrame,
      ),
      rendered.samples.slice(
        (firstEvidenceFrame + 9) * samplesPerEvidenceFrame,
        (firstEvidenceFrame + 10) * samplesPerEvidenceFrame,
      ),
      "an unbounded owner after the event must remain sample-identical",
    );
  });

  it("does not propagate event smoothing across a true two-frame evidence gap", () => {
    const centersSec = [0.051, 0.101, 0.107, 0.203, 0.307] as const;
    const source = synthesizeAlternatingEvidenceLaneTake(
      [-4, -4, -4, -4, -4],
      centersSec,
    );
    const rendered = synthesizeAlternatingEvidenceLaneTake(
      [-4, 2, 2, -4, -4],
      centersSec,
    );
    const reference = buildRenderedConsonantReference(source.samples, source.sampleRate);
    assert.ok(reference);

    const result = tameRenderedConsonantPeaks(rendered.samples, rendered.sampleRate, 10, {
      reference,
      maxReductionDb: 2.5,
    });
    const samplesPerEvidenceFrame = Math.round(
      (rendered.sampleRate * RENDERED_CONSONANT_SOURCE_FRAME_MS) / 1000,
    );
    const firstEvidenceFrame = Math.floor(
      (centersSec[1] * 1000) / RENDERED_CONSONANT_SOURCE_FRAME_MS,
    );
    const gapStart = (firstEvidenceFrame + 1) * samplesPerEvidenceFrame;
    const gapEnd = (firstEvidenceFrame + 3) * samplesPerEvidenceFrame;

    assert.equal(result.stats.referenceUsed, true);
    assert.deepEqual(
      result.samples.slice(gapStart, gapEnd),
      rendered.samples.slice(gapStart, gapEnd),
      "two unsupported owners must remain sample-identical instead of becoming a propagated bridge",
    );
  });

  it("crosses weak source-relative evidence continuously without a 0.4 dB engagement jump", () => {
    const sampleRate = 48000;
    const eventSec = 0.8;
    const referenceSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec: 1.6,
      bodyRmsDb: -20.2,
      consonantPeakDb: -4,
      consonantCentersSec: [eventSec],
    });
    const reference = buildRenderedConsonantReference(referenceSamples, sampleRate);
    assert.ok(reference);

    const measureRepair = (consonantPeakDb: number) => {
      const renderedSamples = synthesizeVoicedFricativeTake({
        sampleRate,
        durationSec: 1.6,
        bodyRmsDb: -20.2,
        consonantPeakDb,
        consonantCentersSec: [eventSec],
      });
      const result = tameRenderedConsonantPeaks(renderedSamples, sampleRate, 10, {
        reference,
        maxReductionDb: 2.5,
      });
      return peakDbNear(renderedSamples, sampleRate, eventSec, 8)
        - peakDbNear(result.samples, sampleRate, eventSec, 8);
    };

    const lowerRepairDb = measureRepair(-2.12);
    const upperRepairDb = measureRepair(-2.10);
    assert.ok(
      lowerRepairDb > 0,
      `positive source-relative evidence must receive a continuous subtle correction, got ${lowerRepairDb.toFixed(4)} dB`,
    );
    assert.ok(
      Math.abs(upperRepairDb - lowerRepairDb) < 0.08,
      `a 0.02 dB input change must not cause a correction jump: ${lowerRepairDb.toFixed(4)} -> ${upperRepairDb.toFixed(4)} dB`,
    );
  });

  it("crosses rendered-local contrast continuously instead of opening a 0.6 dB detector lane", () => {
    const sampleRate = 48000;
    const eventSec = 0.8;
    const referenceSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec: 1.6,
      bodyRmsDb: -20.2,
      consonantPeakDb: -10.4,
      consonantCentersSec: [eventSec],
    });
    const reference = buildRenderedConsonantReference(referenceSamples, sampleRate);
    assert.ok(reference);

    const measureRepair = (consonantPeakDb: number) => {
      const renderedSamples = synthesizeVoicedFricativeTake({
        sampleRate,
        durationSec: 1.6,
        bodyRmsDb: -20.2,
        consonantPeakDb,
        consonantCentersSec: [eventSec],
      });
      const result = tameRenderedConsonantPeaks(renderedSamples, sampleRate, 10, {
        reference,
        maxReductionDb: 2.5,
      });
      return peakDbNear(renderedSamples, sampleRate, eventSec, 8)
        - peakDbNear(result.samples, sampleRate, eventSec, 8);
    };

    const lowerRepairDb = measureRepair(-8.3);
    const upperRepairDb = measureRepair(-8.2);
    assert.ok(
      lowerRepairDb > 0,
      `positive rendered contrast growth must enter continuously, got ${lowerRepairDb.toFixed(4)} dB`,
    );
    assert.ok(
      Math.abs(upperRepairDb - lowerRepairDb) < 0.15,
      `a 0.1 dB rendered change must not open a detector lane: ${lowerRepairDb.toFixed(4)} -> ${upperRepairDb.toFixed(4)} dB`,
    );
  });

  it("scales source evidence continuously instead of switching on the weak-reference cap", () => {
    const sampleRate = 48000;
    const eventSec = 0.8;
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec: 1.6,
      bodyRmsDb: -20.2,
      consonantPeakDb: -3.9,
      consonantCentersSec: [eventSec],
    });

    const measureRepair = (sourcePeakDb: number) => {
      const referenceSamples = synthesizeVoicedFricativeTake({
        sampleRate,
        durationSec: 1.6,
        bodyRmsDb: -20.2,
        consonantPeakDb: sourcePeakDb,
        consonantCentersSec: [eventSec],
      });
      const reference = buildRenderedConsonantReference(referenceSamples, sampleRate);
      assert.ok(reference);
      const result = tameRenderedConsonantPeaks(renderedSamples, sampleRate, 10, {
        reference,
        maxReductionDb: 2.5,
      });
      return peakDbNear(renderedSamples, sampleRate, eventSec, 8)
        - peakDbNear(result.samples, sampleRate, eventSec, 8);
    };

    const lowerRepairDb = measureRepair(-12.5);
    const upperRepairDb = measureRepair(-12.0);
    assert.ok(
      lowerRepairDb > 0,
      `weak but time-matched source evidence must enter continuously, got ${lowerRepairDb.toFixed(4)} dB`,
    );
    assert.ok(
      Math.abs(upperRepairDb - lowerRepairDb) < 0.35,
      `a 0.5 dB source change must not switch on a full weak lane: ${lowerRepairDb.toFixed(4)} -> ${upperRepairDb.toFixed(4)} dB`,
    );
  });

  it("does not let epsilon nearer source evidence replace a trusted adjacent timing match", () => {
    const sampleRate = 48_000;
    const targetSec = 1;
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec: 2.2,
      bodyRmsDb: -20.2,
      consonantPeakDb: -3.9,
      consonantCentersSec: [0.3, 0.6, targetSec, 1.4, 1.8],
    });
    const baseReference = buildRenderedConsonantReference(renderedSamples, sampleRate);
    assert.ok(baseReference);

    const measureRepair = (nearestContrastDb: number) => {
      const rmsDb = new Float32Array(baseReference.rmsDb);
      const peakDb = new Float32Array(baseReference.peakDb);
      const targetFrame = Math.round((targetSec * 1000) / baseReference.frameMs);
      for (let frame = targetFrame - 12; frame <= targetFrame + 12; frame += 1) {
        rmsDb[frame] = -20.2;
        peakDb[frame] = -17.2;
      }
      peakDb[targetFrame] = -20.2 + nearestContrastDb;
      peakDb[targetFrame + 1] = -10.2;
      const reference = {
        ...baseReference,
        rmsDb,
        peakDb,
      };
      const result = tameRenderedConsonantPeaks(renderedSamples, sampleRate, 10, {
        reference,
        maxReductionDb: 2.5,
      });
      const samplesPerEvidenceFrame = Math.round(
        (sampleRate * baseReference.frameMs) / 1000,
      );
      const target = maxSampleReductionDb(
        renderedSamples,
        result.samples,
        targetFrame * samplesPerEvidenceFrame,
        (targetFrame + 1) * samplesPerEvidenceFrame - 1,
      );
      return {
        referenceUsed: result.stats.referenceUsed,
        targetReductionDb: target.maxReductionDb,
      };
    };

    const atBoundary = measureRepair(4);
    const justAbove = measureRepair(4.001);
    assert.equal(atBoundary.referenceUsed, true);
    assert.equal(justAbove.referenceUsed, true);
    assert.ok(
      Math.abs(justAbove.targetReductionDb - atBoundary.targetReductionDb) < 0.05,
      `0.001 dB nearer evidence must not replace an adjacent match: ${atBoundary.targetReductionDb.toFixed(6)} -> ${justAbove.targetReductionDb.toFixed(6)} dB`,
    );
    assert.ok(
      Math.max(atBoundary.targetReductionDb, justAbove.targetReductionDb) <= 0.75,
      `adjacent-only evidence must remain a subtle timing allowance: ${atBoundary.targetReductionDb.toFixed(6)} / ${justAbove.targetReductionDb.toFixed(6)} dB`,
    );
  });

  it("uses rounded 44.1 kHz evidence boundaries when a strong lane precedes a weak lane", () => {
    const source = synthesizeFractionalBoundaryLaneTake([-4, -10.4]);
    const rendered = synthesizeFractionalBoundaryLaneTake([2, -3.9]);
    const reference = buildRenderedConsonantReference(source.samples, source.sampleRate);
    assert.ok(reference);
    const result = tameRenderedConsonantPeaks(rendered.samples, rendered.sampleRate, 10, {
      reference,
      maxReductionDb: 2.5,
    });
    const samplesPerEvidenceFrame = (rendered.sampleRate * reference.frameMs) / 1000;
    const weakFrameStart = Math.round(51 * samplesPerEvidenceFrame);
    const weakFrameEnd = Math.round(52 * samplesPerEvidenceFrame) - 1;
    const weak = maxSampleReductionDb(
      rendered.samples,
      result.samples,
      weakFrameStart,
      weakFrameEnd,
    );
    const strong = maxSampleReductionDb(
      rendered.samples,
      result.samples,
      Math.round(50 * samplesPerEvidenceFrame),
      weakFrameStart - 1,
    );

    assert.equal(weakFrameStart, 4498);
    assert.equal(weak.samplesOverWeakCap, 0);
    assert.ok(weak.maxReductionDb <= 1.251, `weak measured owner reached ${weak.maxReductionDb.toFixed(9)} dB`);
    assert.ok(strong.maxReductionDb > 0.05 && strong.maxReductionDb <= 1.251);
  });

  it("does not let a rounded 44.1 kHz native frame borrow from its strong predecessor", () => {
    const source = synthesizeFractionalBoundaryLaneTake([-4, null]);
    const rendered = synthesizeFractionalBoundaryLaneTake([2, null]);
    const reference = buildRenderedConsonantReference(source.samples, source.sampleRate);
    assert.ok(reference);
    const result = tameRenderedConsonantPeaks(rendered.samples, rendered.sampleRate, 10, {
      reference,
      maxReductionDb: 2.5,
    });
    const samplesPerEvidenceFrame = (rendered.sampleRate * reference.frameMs) / 1000;
    const nativeFrameStart = Math.round(51 * samplesPerEvidenceFrame);
    const nativeFrameEnd = Math.round(52 * samplesPerEvidenceFrame) - 1;
    const native = maxSampleReductionDb(
      rendered.samples,
      result.samples,
      nativeFrameStart,
      nativeFrameEnd,
    );

    assert.equal(nativeFrameStart, 4498);
    assert.ok(native.maxReductionDb <= 0.001, `native measured owner borrowed ${native.maxReductionDb.toFixed(9)} dB`);
    assert.deepEqual(
      result.samples.slice(nativeFrameStart, nativeFrameEnd + 1),
      rendered.samples.slice(nativeFrameStart, nativeFrameEnd + 1),
    );
  });

  it("leaves a naturally strong consonant sample-identical when its contrast matches the source", () => {
    const sampleRate = 48000;
    const frameMs = 10;
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec: 1.6,
      bodyRmsDb: -24,
      consonantPeakDb: -4,
      consonantCentersSec: [0.8],
    });
    const referenceSamples = new Float32Array(renderedSamples);

    const result = tameRenderedConsonantPeaks(renderedSamples, sampleRate, frameMs, {
      referenceSamples,
      referenceSampleRate: sampleRate,
      referenceMatchWindowMs: 20,
    });

    assert.equal(result.stats.tamedFrameCount, 0);
    assert.equal(result.stats.maxReductionDb, 0);
    assert.deepEqual(result.samples, renderedSamples);
  });

  it("screens ordinary rendered frames before scanning the source match neighborhood", () => {
    const sampleRate = 48000;
    const durationSec = 6;
    const eventCentersSec = [0.55, 1.42, 2.86, 4.73];
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -12,
      consonantPeakDb: [-1, -4, -2, -5],
      consonantCentersSec: eventCentersSec,
    });
    const reference = buildRenderedConsonantReference(renderedSamples, sampleRate);
    assert.ok(reference);

    let referenceIndexReads = 0;
    const countReads = (values: Float32Array) => new Proxy(values, {
      get(target, property) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          referenceIndexReads += 1;
        }
        return Reflect.get(target, property, target);
      },
    });
    const instrumentedReference = {
      ...reference,
      rmsDb: countReads(reference.rmsDb),
      peakDb: countReads(reference.peakDb),
    };

    const result = tameRenderedConsonantPeaks(renderedSamples, sampleRate, 10, {
      reference: instrumentedReference,
    });

    assert.equal(result.stats.referenceUsed, true);
    assert.equal(result.stats.tamedFrameCount, 0);
    assert.deepEqual(result.samples, renderedSamples);
    assert.ok(
      referenceIndexReads < 1_000_000,
      `ordinary frames should not trigger source-neighborhood scans; observed ${referenceIndexReads.toLocaleString()} indexed reads`,
    );
  });

  it("matches a native consonant across sample rates within a 20 ms timing neighborhood", () => {
    const renderedSampleRate = 48000;
    const referenceSampleRate = 44100;
    const frameMs = 10;
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate: renderedSampleRate,
      durationSec: 1.6,
      bodyRmsDb: -24,
      consonantPeakDb: -4,
      consonantCentersSec: [0.8],
    });
    const referenceSamples = synthesizeVoicedFricativeTake({
      sampleRate: referenceSampleRate,
      durationSec: 1.6,
      bodyRmsDb: -24,
      consonantPeakDb: -4,
      consonantCentersSec: [0.815],
    });

    const result = tameRenderedConsonantPeaks(renderedSamples, renderedSampleRate, frameMs, {
      referenceSamples,
      referenceSampleRate,
      referenceMatchWindowMs: 20,
    });

    assert.equal(result.stats.tamedFrameCount, 0, "a 15 ms source/render offset should still identify the native consonant");
    assert.equal(result.stats.maxReductionDb, 0);
    assert.deepEqual(result.samples, renderedSamples);
  });

  it("keeps 44.1 kHz source evidence time-locked to a 48 kHz render after 60 seconds", () => {
    const referenceSampleRate = 44100;
    const renderedSampleRate = 48000;
    const durationSec = 72;
    const anchorSec = 2;
    const lateNativeSec = 63;
    const lateGrownSec = 68;
    const eventCentersSec = [anchorSec, lateNativeSec, lateGrownSec];
    const referenceSamples = synthesizeVoicedFricativeTake({
      sampleRate: referenceSampleRate,
      durationSec,
      bodyRmsDb: -20.2,
      consonantPeakDb: [-4, -4, -4],
      consonantCentersSec: eventCentersSec,
    });
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate: renderedSampleRate,
      durationSec,
      bodyRmsDb: -24,
      // The anchor and late native event retain source-relative contrast;
      // only the final event gains 3.8 dB against the rendered body.
      consonantPeakDb: [-7.8, -7.8, -4],
      consonantCentersSec: eventCentersSec,
    });
    const compactReference = buildRenderedConsonantReference(
      referenceSamples,
      referenceSampleRate,
      RENDERED_CONSONANT_SOURCE_FRAME_MS,
    );
    assert.ok(compactReference);
    assert.equal(
      compactReference.rmsDb.length,
      Math.ceil((durationSec * 1000) / RENDERED_CONSONANT_SOURCE_FRAME_MS),
      "fractional samples per frame must not accumulate extra source frames",
    );

    const result = tameRenderedConsonantPeaks(renderedSamples, renderedSampleRate, 10, {
      reference: compactReference,
      maxReductionDb: 2.5,
    });
    const nativeReductionDb = peakDbNear(renderedSamples, renderedSampleRate, lateNativeSec, 8)
      - peakDbNear(result.samples, renderedSampleRate, lateNativeSec, 8);
    const grownReductionDb = peakDbNear(renderedSamples, renderedSampleRate, lateGrownSec, 8)
      - peakDbNear(result.samples, renderedSampleRate, lateGrownSec, 8);

    assert.equal(result.stats.referenceUsed, true, "long cross-rate evidence should remain trustworthy");
    assert.ok(
      nativeReductionDb < 0.1,
      `the late source-native event must remain intact, got ${nativeReductionDb.toFixed(3)} dB reduction`,
    );
    assert.ok(
      grownReductionDb >= 0.3 && grownReductionDb <= 1.5,
      `the late processing-grown event needs bounded repair, got ${grownReductionDb.toFixed(3)} dB`,
    );
  });

  it("automatically preserves a native consonant after 45 ms of accumulated render latency", () => {
    const sampleRate = 48000;
    const frameMs = 10;
    const referenceSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec: 1.6,
      bodyRmsDb: -24,
      consonantPeakDb: -4,
      consonantCentersSec: [0.8],
    });
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec: 1.6,
      bodyRmsDb: -24,
      consonantPeakDb: -4,
      consonantCentersSec: [0.845],
    });

    // The caller deliberately supplies no fixed offset or enlarged match
    // window: accumulated DSP latency must be inferred from the envelopes.
    const result = tameRenderedConsonantPeaks(renderedSamples, sampleRate, frameMs, {
      referenceSamples,
      referenceSampleRate: sampleRate,
    });

    assert.ok(
      typeof result.stats.referenceLagMs === "number"
        && Math.abs(result.stats.referenceLagMs) >= 30
        && Math.abs(result.stats.referenceLagMs) <= 60,
      `diagnostics should report the automatically inferred ~45 ms reference lag, got ${String(result.stats.referenceLagMs)}`,
    );
    const nativeReductionDb = peakDbNear(renderedSamples, sampleRate, 0.845, 8)
      - peakDbNear(result.samples, sampleRate, 0.845, 8);
    assert.ok(
      result.stats.tamedFrameCount <= 1 && result.stats.maxReductionDb < 0.01,
      `alignment rounding may enter continuously but must remain below 0.01 dB, got ${result.stats.tamedFrameCount} frame(s) / ${result.stats.maxReductionDb.toFixed(4)} dB`,
    );
    assert.ok(
      nativeReductionDb < 0.01,
      `automatic alignment must preserve native articulation perceptually, got ${nativeReductionDb.toFixed(4)} dB`,
    );
  });

  it("automatically repairs a 3.8 dB contrast increase after 45 ms of render latency", () => {
    const sampleRate = 48000;
    const frameMs = 10;
    const durationSec = 1.6;
    const referenceTargetSec = 0.7;
    const renderedTargetSec = 0.745;
    const referenceAnchorSec = 0.76;
    const renderedAnchorSec = 0.805;
    const referenceSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -20.2,
      consonantPeakDb: [-4, -2],
      consonantCentersSec: [referenceTargetSec, referenceAnchorSec],
    });
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -24,
      // The first consonant gained 3.8 dB of body-relative contrast. The
      // second is a native anchor with unchanged contrast after the level shift.
      consonantPeakDb: [-4, -5.8],
      consonantCentersSec: [renderedTargetSec, renderedAnchorSec],
    });
    const bodyStart = Math.round(sampleRate * 0.2);
    const bodyEnd = Math.round(sampleRate * 0.5);
    const referenceBodyDb = measureRmsDb(referenceSamples, bodyStart, bodyEnd);
    const renderedBodyDb = measureRmsDb(renderedSamples, bodyStart, bodyEnd);
    const referenceTargetContrastDb = peakDbNear(referenceSamples, sampleRate, referenceTargetSec) - referenceBodyDb;
    const renderedTargetContrastDb = peakDbNear(renderedSamples, sampleRate, renderedTargetSec) - renderedBodyDb;
    assert.ok(
      Math.abs((renderedTargetContrastDb - referenceTargetContrastDb) - 3.8) < 0.15,
      `fixture must retain the reported +3.8 dB contrast defect, got ${(renderedTargetContrastDb - referenceTargetContrastDb).toFixed(2)} dB`,
    );

    const result = tameRenderedConsonantPeaks(renderedSamples, sampleRate, frameMs, {
      referenceSamples,
      referenceSampleRate: sampleRate,
    });
    assert.ok(
      typeof result.stats.referenceLagMs === "number"
        && Math.abs(result.stats.referenceLagMs) >= 30
        && Math.abs(result.stats.referenceLagMs) <= 60,
      `diagnostics should report the automatically inferred ~45 ms reference lag, got ${String(result.stats.referenceLagMs)}`,
    );
    const targetReductionDb = peakDbNear(renderedSamples, sampleRate, renderedTargetSec)
      - peakDbNear(result.samples, sampleRate, renderedTargetSec);
    const nativeAnchorReductionDb = peakDbNear(renderedSamples, sampleRate, renderedAnchorSec)
      - peakDbNear(result.samples, sampleRate, renderedAnchorSec);

    assert.ok(
      targetReductionDb >= 0.3,
      `the latency-shifted render-created consonant contrast must still be repaired, got ${targetReductionDb.toFixed(3)} dB`,
    );
    assert.ok(targetReductionDb <= 1.5, `latency-aware repair must stay subtle, got ${targetReductionDb.toFixed(2)} dB`);
    assert.ok(nativeAnchorReductionDb < 0.1, `the aligned native consonant anchor must stay intact, got ${nativeAnchorReductionDb.toFixed(2)} dB reduction`);
  });

  it("does not let an adjacent native consonant mask render-created contrast", () => {
    const sampleRate = 48000;
    const frameMs = 10;
    const durationSec = 1.8;
    const targetSec = 0.8;
    const nativeNeighborSec = 0.82;
    const referenceSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: [-10, -2],
      consonantCentersSec: [targetSec, nativeNeighborSec],
    });
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: [-4, -2],
      consonantCentersSec: [targetSec, nativeNeighborSec],
    });

    const result = tameRenderedConsonantPeaks(renderedSamples, sampleRate, frameMs, {
      referenceSamples,
      referenceSampleRate: sampleRate,
      maxReductionDb: 2.5,
    });
    const targetReductionDb = peakDbNear(renderedSamples, sampleRate, targetSec, 8)
      - peakDbNear(result.samples, sampleRate, targetSec, 8);
    const neighborReductionDb = peakDbNear(renderedSamples, sampleRate, nativeNeighborSec, 8)
      - peakDbNear(result.samples, sampleRate, nativeNeighborSec, 8);

    assert.ok(
      targetReductionDb >= 0.3,
      `the render-created member of a dense consonant pair must be repaired, got ${targetReductionDb.toFixed(2)} dB`,
    );
    assert.ok(targetReductionDb <= 1.5, `dense-pair repair must stay subtle, got ${targetReductionDb.toFixed(2)} dB`);
    assert.ok(
      neighborReductionDb < 0.1,
      `the adjacent source-native consonant must stay intact, got ${neighborReductionDb.toFixed(2)} dB reduction`,
    );
  });

  it("keeps a source-native 6 kHz event untouched beside a processing-grown event at sub-frame gaps", () => {
    for (const gapMs of [4, 6, 8, 10, 12]) {
      const reference = synthesizeDenseSixKhzPair({ gapMs, secondPeakDb: -4 });
      const rendered = synthesizeDenseSixKhzPair({ gapMs, secondPeakDb: -1 });
      const nativePeakBeforeDb = peakDbNear(
        rendered.samples,
        rendered.sampleRate,
        rendered.firstCenterSec,
        2,
      );
      const sourceNativePeakDb = peakDbNear(
        reference.samples,
        reference.sampleRate,
        reference.firstCenterSec,
        2,
      );
      assert.ok(
        Math.abs(nativePeakBeforeDb - sourceNativePeakDb) < 0.01,
        `the ${gapMs} ms fixture's first event must be source-native before processing`,
      );

      const compactReference = buildRenderedConsonantReference(
        reference.samples,
        reference.sampleRate,
        RENDERED_CONSONANT_SOURCE_FRAME_MS,
      );
      assert.ok(compactReference);
      const result = tameRenderedConsonantPeaks(rendered.samples, rendered.sampleRate, 10, {
        reference: compactReference,
        maxReductionDb: 2.5,
      });
      const nativeReductionDb = nativePeakBeforeDb - peakDbNear(
        result.samples,
        rendered.sampleRate,
        rendered.firstCenterSec,
        2,
      );
      const grownReductionDb = peakDbNear(
        rendered.samples,
        rendered.sampleRate,
        rendered.secondCenterSec,
        2,
      ) - peakDbNear(
        result.samples,
        rendered.sampleRate,
        rendered.secondCenterSec,
        2,
      );

      assert.equal(result.stats.referenceUsed, true, `${gapMs} ms pair should retain trustworthy source evidence`);
      assert.ok(
        nativeReductionDb < 0.1,
        `${gapMs} ms source-native event must stay effectively untouched, got ${nativeReductionDb.toFixed(3)} dB`,
      );
      assert.ok(
        grownReductionDb >= 0.2,
        `${gapMs} ms processing-grown event should receive a subtle repair, got ${grownReductionDb.toFixed(3)} dB`,
      );
      assert.ok(
        grownReductionDb <= 1.5,
        `${gapMs} ms repair must remain within the 1.5 dB cap, got ${grownReductionDb.toFixed(3)} dB`,
      );
    }
  });

  it("fails open when a supplied source reference is duration-incompatible", () => {
    const sampleRate = 48000;
    const frameMs = 10;
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec: 1.6,
      bodyRmsDb: -24,
      consonantPeakDb: -2,
      consonantCentersSec: [0.8],
    });
    const referenceSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec: 1.2,
      bodyRmsDb: -24,
      consonantPeakDb: -2,
      consonantCentersSec: [0.8],
    });

    const result = tameRenderedConsonantPeaks(renderedSamples, sampleRate, frameMs, {
      referenceSamples,
      referenceSampleRate: sampleRate,
      maxReductionDb: 2.5,
    });

    assert.equal(result.stats.tamedFrameCount, 0);
    assert.equal(result.stats.maxReductionDb, 0);
    assert.deepEqual(result.samples, renderedSamples);
  });

  it("fails open when a same-duration source reference is temporally unrelated", () => {
    const sampleRate = 48000;
    const frameMs = 10;
    const durationSec = 1.6;
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: -2,
      consonantCentersSec: [0.8],
    });
    const unrelatedReferenceSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: -10,
      consonantCentersSec: [1.1],
    });

    const result = tameRenderedConsonantPeaks(renderedSamples, sampleRate, frameMs, {
      referenceSamples: unrelatedReferenceSamples,
      referenceSampleRate: sampleRate,
      maxReductionDb: 2.5,
    });

    assert.equal(result.stats.referenceUsed, false, "an unrelated source must not authorize attenuation");
    assert.ok(
      result.stats.referenceConfidence < 0.5,
      `unrelated alignment confidence must stay low, got ${String(result.stats.referenceConfidence)}`,
    );
    assert.equal(result.stats.tamedFrameCount, 0);
    assert.deepEqual(result.samples, renderedSamples);
  });

  it("fails open when two source alignments are equally plausible", () => {
    const sampleRate = 48000;
    const frameMs = 10;
    const durationSec = 1.6;
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: -2,
      consonantCentersSec: [0.8],
    });
    const ambiguousReferenceSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: [-10, -10],
      consonantCentersSec: [0.7, 0.9],
    });

    const result = tameRenderedConsonantPeaks(renderedSamples, sampleRate, frameMs, {
      referenceSamples: ambiguousReferenceSamples,
      referenceSampleRate: sampleRate,
      maxReductionDb: 2.5,
    });

    assert.equal(result.stats.referenceUsed, false, "an ambiguous lag must not authorize attenuation");
    assert.ok(
      result.stats.referenceConfidence < 0.5,
      `ambiguous alignment confidence must stay low, got ${String(result.stats.referenceConfidence)}`,
    );
    assert.equal(result.stats.tamedFrameCount, 0);
    assert.deepEqual(result.samples, renderedSamples);
  });

  it("requires a time-matched localized source event before attenuating a rendered event", () => {
    const sampleRate = 48000;
    const frameMs = 10;
    const durationSec = 1.6;
    const sharedAnchorSec = 0.4;
    const unmatchedRenderedEventSec = 0.8;
    const referenceSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: -2,
      consonantCentersSec: [sharedAnchorSec],
    });
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: [-2, -2],
      consonantCentersSec: [sharedAnchorSec, unmatchedRenderedEventSec],
    });

    const result = tameRenderedConsonantPeaks(renderedSamples, sampleRate, frameMs, {
      referenceSamples,
      referenceSampleRate: sampleRate,
      maxReductionDb: 2.5,
    });
    const unmatchedReductionDb = peakDbNear(renderedSamples, sampleRate, unmatchedRenderedEventSec, 8)
      - peakDbNear(result.samples, sampleRate, unmatchedRenderedEventSec, 8);

    assert.equal(result.stats.referenceUsed, true, "the shared anchor should establish trustworthy alignment");
    assert.ok(result.stats.referenceConfidence >= 0.5);
    assert.ok(
      unmatchedReductionDb < 0.1,
      `an event absent from the source evidence must fail open, got ${unmatchedReductionDb.toFixed(2)} dB reduction`,
    );
  });

  it("fails open on invalid frame durations instead of entering an unbounded dip loop", () => {
    const samples = synthesizeVoicedFricativeTake({
      sampleRate: 48000,
      durationSec: 1,
      bodyRmsDb: -24,
      consonantPeakDb: -2,
      consonantCentersSec: [0.5],
    });

    for (const frameMs of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = tameRenderedConsonantPeaks(samples, 48000, frameMs);
      assert.equal(result.stats.tamedFrameCount, 0);
      assert.equal(result.stats.maxReductionDb, 0);
      assert.deepEqual(result.samples, samples);
    }
  });
});

describe("localized peak guard", () => {
  it("does not turn a peak-only sample into a broadband body-volume hole", () => {
    const sampleRate = 48000;
    const frameMs = 10;
    const samplesPerFrame = (sampleRate * frameMs) / 1000; // 480
    const totalFrames = 200;

    // Constant -22 dB body with ONE sample-level spike at frame 100. We
    // keep `frameDb[100] = -22` so the body RMS over the trim region
    // remains -22 (target lands at -22, planned gain 0 dB). The spike is
    // visible to the peak-guard via `framePeakDb` (computed from samples).
    const samples = new Float32Array(totalFrames * samplesPerFrame);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 300 * i) / sampleRate) * 0.08; // -22 dB RMS
    }
    // Inject a single full-scale sample at frame 100. This bumps frame
    // 100's peak to ≈ 0.99 but barely changes its RMS (479 quiet + 1 loud).
    samples[100 * samplesPerFrame + 100] = 0.99;

    const frameDb: number[] = [];
    for (let f = 0; f < totalFrames; f += 1) frameDb.push(-22);

    const speechRuns = [{ startFrame: 0, endFrame: totalFrames }];
    const plan = planGainCurve({
      frameDb,
      speechRuns,
      noiseFloorDb: -70,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs,
      samples,
      sampleRate,
      targetDb: -22,
      peakCeilingDb: -4,
    });

    const gainFarA = 20 * Math.log10(plan.gainCurve[10] + 1e-9);
    const gainFarB = 20 * Math.log10(plan.gainCurve[190] + 1e-9);
    const gainAtPlosive = 20 * Math.log10(plan.gainCurve[100] + 1e-9);
    const gainNearPlosive = 20 * Math.log10(plan.gainCurve[105] + 1e-9);

    // 1. Body frames FAR from the plosive are untouched.
    assert.ok(
      Math.abs(gainFarA) < 0.3 && Math.abs(gainFarB) < 0.3,
      `body frames far from the plosive should be at 0 dB: ${gainFarA.toFixed(2)} / ${gainFarB.toFixed(2)}`,
    );

    // 2. A sample peak without matching frame-energy growth must not make the
    // ordinary speech body dive and recover. Peak limiting/click repair can
    // address the sample itself without turning it into a broadband hole.
    assert.ok(
      gainAtPlosive >= gainFarA - 0.75,
      `peak-only evidence must not create a body-volume hole (got ${gainAtPlosive.toFixed(2)} vs body ${gainFarA.toFixed(2)})`,
    );

    // 3. Ordinary shoulder frames must receive the same protection. This
    // catches a wide cosine valley even when its center is later smoothed.
    const deepestShoulderGainDb = Math.min(
      ...Array.from(plan.gainCurve.slice(96, 105), (gain) => 20 * Math.log10(gain + 1e-9)),
    );
    assert.ok(
      deepestShoulderGainDb >= gainFarA - 0.75,
      `flat source body must stay stable through the peak shoulder (deepest ${deepestShoulderGainDb.toFixed(2)} vs body ${gainFarA.toFixed(2)})`,
    );

    assert.ok(
      Math.abs(gainNearPlosive - gainFarA) < 0.3,
      `50 ms away should remain body gain (got ${gainNearPlosive.toFixed(2)} vs body ${gainFarA.toFixed(2)})`,
    );
    assert.ok(
      plan.speechSpikeMaxReductionDb <= 0.61,
      `diagnostics must report the applied envelope-capped reduction, got ${plan.speechSpikeMaxReductionDb.toFixed(2)} dB`,
    );
    assert.ok(
      (plan.runs[0]?.peakReducedDb ?? 0) >= -0.61,
      `run diagnostics must not retain the pre-cap request, got ${(plan.runs[0]?.peakReducedDb ?? 0).toFixed(2)} dB`,
    );
  });

  it("defers below-ceiling body-speech peaks to source-relative delivery", () => {
    const sampleRate = 16000;
    const frameMs = 10;
    const samplesPerFrame = (sampleRate * frameMs) / 1000;
    const totalFrames = 260;
    const samples = new Float32Array(totalFrames * samplesPerFrame);
    const frameDb = new Array<number>(totalFrames).fill(-22);

    const paintFrame = (frame: number, rmsDb: number) => {
      frameDb[frame] = rmsDb;
      const amp = dbToLin(rmsDb) * Math.SQRT2;
      const start = frame * samplesPerFrame;
      for (let i = 0; i < samplesPerFrame; i += 1) {
        const sampleIndex = start + i;
        samples[sampleIndex] = Math.sin((2 * Math.PI * 260 * sampleIndex) / sampleRate) * amp;
      }
    };

    for (let frame = 0; frame < totalFrames; frame += 1) paintFrame(frame, -22);
    for (let frame = 120; frame < 124; frame += 1) paintFrame(frame, -10);

    const baseInput = {
      frameDb,
      speechRuns: [{ startFrame: 0, endFrame: totalFrames }],
      noiseFloorDb: -75,
      speechThresholdDb: -58,
      pauseNoiseRisk: 0.05,
      frameMs,
      sampleRate,
      targetDb: -22,
      peakCeilingDb: -3,
      instabilityHint: 1,
      speechSpikeTaming: 1,
    };
    const baselinePlan = planGainCurve({ ...baseInput, samples, peakCeilingDb: 0 });
    const plan = planGainCurve({ ...baseInput, samples });

    assert.equal(plan.speechSpikeFrameCount, 0);
    assert.equal(plan.speechSpikeMaxReductionDb, 0);
    for (let frame = 116; frame <= 128; frame += 1) {
      const gainDb = 20 * Math.log10(plan.gainCurve[frame] + 1e-9);
      const baselineGainDb = 20 * Math.log10(baselinePlan.gainCurve[frame] + 1e-9);
      assert.ok(
        Math.abs(gainDb - baselineGainDb) < 0.05,
        `below-ceiling source emphasis must not receive a sample-driven dip at frame ${frame}: ${gainDb.toFixed(2)} vs ${baselineGainDb.toFixed(2)} dB`,
      );
    }
  });

  it("preserves an ordinary mid-word bridge between real hot speech frames", () => {
    const sampleRate = 16000;
    const frameMs = 10;
    const samplesPerFrame = (sampleRate * frameMs) / 1000;
    const totalFrames = 260;
    const samples = new Float32Array(totalFrames * samplesPerFrame);
    const frameDb = new Array<number>(totalFrames).fill(-22);
    const paintFrame = (frame: number, rmsDb: number) => {
      frameDb[frame] = rmsDb;
      const amplitude = dbToLin(rmsDb) * Math.SQRT2;
      const start = frame * samplesPerFrame;
      for (let offset = 0; offset < samplesPerFrame; offset += 1) {
        const sampleIndex = start + offset;
        samples[sampleIndex] = Math.sin((2 * Math.PI * 260 * sampleIndex) / sampleRate) * amplitude;
      }
    };
    for (let frame = 0; frame < totalFrames; frame += 1) paintFrame(frame, -22);
    for (const frame of [120, 121, 123, 124]) paintFrame(frame, -10);

    const baseInput = {
      frameDb,
      speechRuns: [{ startFrame: 0, endFrame: totalFrames }],
      noiseFloorDb: -75,
      speechThresholdDb: -58,
      pauseNoiseRisk: 0.05,
      frameMs,
      sampleRate,
      targetDb: -22,
      peakCeilingDb: -3,
      instabilityHint: 1,
      speechSpikeTaming: 1,
    };
    const baselinePlan = planGainCurve({ ...baseInput, samples, peakCeilingDb: 0 });
    const plan = planGainCurve({ ...baseInput, samples });

    const baselineBridgeGainDb = 20 * Math.log10(baselinePlan.gainCurve[122] + 1e-9);
    const bridgeGainDb = 20 * Math.log10(plan.gainCurve[122] + 1e-9);
    const hotGainDb = Math.min(
      20 * Math.log10(plan.gainCurve[120] + 1e-9),
      20 * Math.log10(plan.gainCurve[123] + 1e-9),
    );
    const baselineHotGainDb = Math.min(
      20 * Math.log10(baselinePlan.gainCurve[120] + 1e-9),
      20 * Math.log10(baselinePlan.gainCurve[123] + 1e-9),
    );
    assert.ok(
      bridgeGainDb >= baselineBridgeGainDb - 0.75,
      `peak evidence must not turn the normal bridge into an added gain hole: ${bridgeGainDb.toFixed(2)} vs ${baselineBridgeGainDb.toFixed(2)} dB`,
    );
    assert.ok(
      Math.abs(hotGainDb - baselineHotGainDb) < 0.05,
      `below-ceiling hot frames must not receive source-blind taming: ${hotGainDb.toFixed(2)} vs ${baselineHotGainDb.toFixed(2)} dB`,
    );
  });

  it("does not flatten sustained loud dialogue as a spike cluster", () => {
    const sampleRate = 16000;
    const frameMs = 10;
    const samplesPerFrame = (sampleRate * frameMs) / 1000;
    const totalFrames = 260;
    const samples = new Float32Array(totalFrames * samplesPerFrame);
    const frameDb = new Array<number>(totalFrames).fill(-22);

    const paintFrame = (frame: number, rmsDb: number) => {
      frameDb[frame] = rmsDb;
      const amp = dbToLin(rmsDb) * Math.SQRT2;
      const start = frame * samplesPerFrame;
      for (let i = 0; i < samplesPerFrame; i += 1) {
        const sampleIndex = start + i;
        samples[sampleIndex] = Math.sin((2 * Math.PI * 260 * sampleIndex) / sampleRate) * amp;
      }
    };

    for (let frame = 0; frame < totalFrames; frame += 1) paintFrame(frame, -22);
    for (let frame = 100; frame < 160; frame += 1) paintFrame(frame, -16);

    const plan = planGainCurve({
      frameDb,
      speechRuns: [{ startFrame: 0, endFrame: totalFrames }],
      noiseFloorDb: -75,
      speechThresholdDb: -58,
      pauseNoiseRisk: 0.05,
      frameMs,
      samples,
      sampleRate,
      targetDb: -22,
      peakCeilingDb: -3,
      instabilityHint: 0.65,
      speechSpikeTaming: 1,
    });

    const bodyGainDb = 20 * Math.log10(plan.gainCurve[80] + 1e-9);
    const loudPhraseGainDb = 20 * Math.log10(plan.gainCurve[130] + 1e-9);

    assert.equal(plan.speechSpikeFrameCount, 0);
    assert.ok(
      loudPhraseGainDb > bodyGainDb - 3,
      `sustained loud phrase should keep performance level, got ${loudPhraseGainDb.toFixed(2)} vs body ${bodyGainDb.toFixed(2)} dB`,
    );
  });

  it("does not lend a long low-bed run's +14 dB authority to embedded performance events", () => {
    const totalFrames = 2400;
    const frameDb = new Array<number>(totalFrames).fill(-52);
    for (const [startFrame, endFrame] of [
      [900, 920],
      [1500, 1530],
    ] as const) {
      for (let frame = startFrame; frame < endFrame; frame += 1) frameDb[frame] = -20;
    }
    const speechRuns = [{ startFrame: 0, endFrame: totalFrames }];

    const plan = planGainCurve({
      frameDb,
      speechRuns,
      noiseFloorDb: -110,
      speechThresholdDb: -58,
      pauseNoiseRisk: 0.4,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.5,
    });

    const eventGains = Array.from(
      { length: 12 },
      (_, index) => gainDbAtFrame(plan.gainCurve, 904 + index),
    );
    const eventCenterGainDb = gainDbAtFrame(plan.gainCurve, 910);
    const lowBedGainDb = gainDbAtFrame(plan.gainCurve, 700);
    const eventOutputDb = frameDb[910] + eventCenterGainDb;
    const bedOutputDb = frameDb[700] + lowBedGainDb;
    const largestEventStepDb = eventGains.slice(1).reduce(
      (largest, gainDb, index) => Math.max(largest, Math.abs(gainDb - eventGains[index])),
      0,
    );

    assert.equal(plan.runs[0].runClass, "body-speech");
    assert.ok(
      plan.runs[0].plannedGainDb >= 13.4,
      `fixture must reproduce near-maximum broad-run authority, got ${plan.runs[0].plannedGainDb.toFixed(2)} dB`,
    );
    assert.ok(
      eventCenterGainDb >= -0.05 && eventCenterGainDb <= 3,
      `source-owned performance event should receive only target recovery, got ${eventCenterGainDb.toFixed(2)} dB`,
    );
    assert.ok(
      lowBedGainDb >= 13.5,
      `event ownership must not lower unrelated run frames, got ${lowBedGainDb.toFixed(2)} dB`,
    );
    assert.ok(
      eventOutputDb - bedOutputDb >= 18,
      `source dynamics should remain expressive after authority limiting, got ${(eventOutputDb - bedOutputDb).toFixed(2)} dB`,
    );
    assert.ok(
      largestEventStepDb < 1.5,
      `event ownership should move as a phrase envelope, not a millisecond notch; largest step ${largestEventStepDb.toFixed(2)} dB`,
    );
  });

  it("does not let a future embedded burst pre-duck its quiet voiced lead-in", () => {
    const gainDbCurve = new Float32Array(320).fill(12);
    const sourceFrameDb = new Array<number>(gainDbCurve.length).fill(-34);
    for (let frame = 150; frame < 155; frame += 1) {
      sourceFrameDb[frame] = -14;
    }
    const runs = [{ startFrame: 0, endFrame: gainDbCurve.length }];
    const gainSnapshot = new Float32Array(gainDbCurve);
    const sourceSnapshot = [...sourceFrameDb];
    const runSnapshot = runs.map((run) => ({ ...run }));

    const result = limitEmbeddedPerformancePositiveGainAuthority(
      gainDbCurve,
      sourceFrameDb,
      runs,
      -22,
      FRAME_MS,
    );
    const settledQuietOutputDb = sourceFrameDb[130] + result[130];
    const quietLeadOutputDb = sourceFrameDb[146] + result[146];
    const eventOutputDb = sourceFrameDb[152] + result[152];

    assert.ok(
      quietLeadOutputDb >= settledQuietOutputDb - 3,
      `future energy must not create an anticipatory quiet-word hole: ${quietLeadOutputDb.toFixed(2)} vs ${settledQuietOutputDb.toFixed(2)} dB`,
    );
    assert.ok(
      result[152] <= 3,
      `the source-owned burst must still shed inappropriate broad-run lift, got ${result[152].toFixed(2)} dB`,
    );
    assert.ok(
      eventOutputDb >= settledQuietOutputDb + 2,
      `the controlled burst should retain emotional emphasis: ${eventOutputDb.toFixed(2)} vs ${settledQuietOutputDb.toFixed(2)} dB`,
    );
    assert.deepEqual(gainDbCurve, gainSnapshot);
    assert.deepEqual(sourceFrameDb, sourceSnapshot);
    assert.deepEqual(runs, runSnapshot);
  });

  it("does not let an out-of-band burst remove recovery from a steady speech body", () => {
    const totalFrames = 320;
    const frameDb = new Array<number>(totalFrames).fill(-34);
    const loudnessFrameDb = new Array<number>(totalFrames).fill(-34);
    const speechBodyFrameDb = new Array<number>(totalFrames).fill(-34);
    for (let frame = 150; frame < 152; frame += 1) {
      frameDb[frame] = -14;
      loudnessFrameDb[frame] = -16;
    }
    const frameSnapshot = [...frameDb];
    const loudnessSnapshot = [...loudnessFrameDb];
    const speechBodySnapshot = [...speechBodyFrameDb];
    const speechRuns = [{ startFrame: 0, endFrame: totalFrames }];
    const runSnapshot = speechRuns.map((run) => ({ ...run }));

    const plan = planGainCurve({
      frameDb,
      loudnessFrameDb,
      speechBodyFrameDb,
      speechRuns,
      noiseFloorDb: -75,
      speechThresholdDb: -58,
      pauseNoiseRisk: 0.05,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.7,
    });
    const ordinaryVoiceGainDb = gainDbAtFrame(plan.gainCurve, 130);
    const lfBurstGainDb = gainDbAtFrame(plan.gainCurve, 150);

    assert.ok(
      lfBurstGainDb >= ordinaryVoiceGainDb - 3,
      `energy outside the speech body must not open a mid-word gain hole: ${ordinaryVoiceGainDb.toFixed(2)} -> ${lfBurstGainDb.toFixed(2)} dB`,
    );
    assert.deepEqual(frameDb, frameSnapshot);
    assert.deepEqual(loudnessFrameDb, loudnessSnapshot);
    assert.deepEqual(speechBodyFrameDb, speechBodySnapshot);
    assert.deepEqual(speechRuns, runSnapshot);
  });

  it("retains recovery for a quiet voiced high-frequency island and keeps inputs immutable", () => {
    const totalFrames = 1600;
    const frameDb = new Array<number>(totalFrames).fill(-58);
    const fricativeFrameDb = new Array<number>(totalFrames).fill(-90);
    for (let frame = 700; frame < 735; frame += 1) {
      frameDb[frame] = -38;
      fricativeFrameDb[frame] = -32;
    }
    const speechRuns = [{ startFrame: 0, endFrame: totalFrames }];
    const frameSnapshot = [...frameDb];
    const fricativeSnapshot = [...fricativeFrameDb];
    const runSnapshot = speechRuns.map((run) => ({ ...run }));

    const plan = planGainCurve({
      frameDb,
      fricativeFrameDb,
      fricativeNoiseFloorDb: -90,
      speechRuns,
      noiseFloorDb: -110,
      speechThresholdDb: -58,
      pauseNoiseRisk: 0.4,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.5,
    });

    const quietVoiceGainDb = gainDbAtFrame(plan.gainCurve, 717);
    assert.ok(
      quietVoiceGainDb >= 13.5,
      `quiet voiced/HF evidence should keep recovery authority, got ${quietVoiceGainDb.toFixed(2)} dB`,
    );
    assert.ok(
      frameDb[717] + quietVoiceGainDb >= -24.5,
      `quiet voiced island should recover near dialogue level, got ${(frameDb[717] + quietVoiceGainDb).toFixed(2)} dB`,
    );
    assert.deepEqual(frameDb, frameSnapshot);
    assert.deepEqual(fricativeFrameDb, fricativeSnapshot);
    assert.deepEqual(speechRuns, runSnapshot);
  });

  it("changes embedded-event authority continuously and leaves helper inputs immutable", () => {
    const gainDbCurve = new Float32Array(320).fill(14);
    const buildSource = (eventDb: number) => {
      const sourceFrameDb = new Array<number>(gainDbCurve.length).fill(-52);
      for (let frame = 140; frame < 160; frame += 1) sourceFrameDb[frame] = eventDb;
      return sourceFrameDb;
    };
    const lowerEvent = buildSource(-20);
    const higherEvent = buildSource(-19.99);
    const gainSnapshot = new Float32Array(gainDbCurve);
    const lowerSnapshot = [...lowerEvent];
    const runs = [{ startFrame: 0, endFrame: gainDbCurve.length }];
    const runSnapshot = runs.map((run) => ({ ...run }));

    const lowerResult = limitEmbeddedPerformancePositiveGainAuthority(
      gainDbCurve,
      lowerEvent,
      runs,
      -22,
      FRAME_MS,
    );
    const higherResult = limitEmbeddedPerformancePositiveGainAuthority(
      gainDbCurve,
      higherEvent,
      runs,
      -22,
      FRAME_MS,
    );
    const lowerGainDb = lowerResult[150];
    const higherGainDb = higherResult[150];

    assert.ok(
      higherGainDb < lowerGainDb && lowerGainDb - higherGainDb < 0.03,
      `0.01 dB stronger event should receive a small monotonic authority change, got ${lowerGainDb.toFixed(5)} -> ${higherGainDb.toFixed(5)}`,
    );
    assert.deepEqual(gainDbCurve, gainSnapshot);
    assert.deepEqual(lowerEvent, lowerSnapshot);
    assert.deepEqual(runs, runSnapshot);
  });
});

describe("ramp placement", () => {
  it("eases only excess positive gain into a quiet later run instead of lifting its pre-roll bed", () => {
    const frameDb = new Array<number>(260).fill(-58);
    for (let frame = 20; frame < 90; frame += 1) frameDb[frame] = -22;
    for (let frame = 150; frame < 190; frame += 1) frameDb[frame] = -40;

    const plan = planGainCurve({
      frameDb,
      speechRuns: [
        { startFrame: 20, endFrame: 90 },
        { startFrame: 150, endFrame: 190 },
      ],
      noiseFloorDb: -58,
      speechThresholdDb: -47,
      pauseNoiseRisk: 0.7,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      maxGainDb: 14,
      instabilityHint: 0.1,
    });

    const untouchedBedGainDb = gainDbAtFrame(plan.gainCurve, 141);
    const lastPreRollGainDb = gainDbAtFrame(plan.gainCurve, 149);
    const earlySpeechGainDb = gainDbAtFrame(plan.gainCurve, 151);
    const settledSpeechGainDb = gainDbAtFrame(plan.gainCurve, 178);

    assert.ok(
      lastPreRollGainDb <= 4.1,
      `detector-negative pre-roll must receive only subtle onset authority, got ${lastPreRollGainDb.toFixed(2)} dB`,
    );
    assert.ok(
      earlySpeechGainDb - untouchedBedGainDb <= 5.5,
      `processing must not add a >5.5 dB/100 ms handoff while the source bed is flat, got ${(earlySpeechGainDb - untouchedBedGainDb).toFixed(2)} dB`,
    );
    assert.ok(
      settledSpeechGainDb >= 12,
      `verified quiet speech must still reach the intended leveling gain, got ${settledSpeechGainDb.toFixed(2)} dB`,
    );
  });

  it("uses bounded high-frequency evidence to preserve a later line onset", () => {
    const frameDb = new Array<number>(300).fill(-82);
    for (let frame = 20; frame < 80; frame += 1) frameDb[frame] = -28;
    for (let frame = 150; frame < 230; frame += 1) frameDb[frame] = -28;

    const fricativeFrameDb = new Array<number>(frameDb.length).fill(-82);
    for (let frame = 144; frame < 150; frame += 1) fricativeFrameDb[frame] = -48;

    const baseInput = {
      frameDb,
      speechRuns: [
        { startFrame: 20, endFrame: 80 },
        { startFrame: 150, endFrame: 230 },
      ],
      noiseFloorDb: -82,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.1,
    };

    const withoutEvidence = planGainCurve(baseInput);
    const withEvidence = planGainCurve({
      ...baseInput,
      fricativeFrameDb,
      fricativeNoiseFloorDb: -82,
    });

    assert.equal(withoutEvidence.runs[1].startFrame, 150, "legacy path should keep a true-silence boundary");
    assert.equal(withEvidence.runs[1].startFrame, 144, "contiguous fricative onset should join the later speech run");
    assert.equal(withEvidence.runs.length, baseInput.speechRuns.length, "evidence must not create independent runs");

    const preservedOnsetGainDb = gainDbAtFrame(withEvidence.gainCurve, 144);
    const laterBodyGainDb = gainDbAtFrame(withEvidence.gainCurve, 180);
    assert.ok(
      Math.abs(preservedOnsetGainDb - laterBodyGainDb) < 1,
      `fricative onset ${preservedOnsetGainDb.toFixed(2)} dB should receive body gain ${laterBodyGainDb.toFixed(2)} dB`,
    );
  });

  it("generalizes raw-envelope onset backtracking to later speech runs", () => {
    const frameDb = new Array<number>(260).fill(-82);
    for (let frame = 20; frame < 80; frame += 1) frameDb[frame] = -28;
    for (let frame = 144; frame < 150; frame += 1) frameDb[frame] = -60;
    for (let frame = 150; frame < 220; frame += 1) frameDb[frame] = -28;

    const plan = planGainCurve({
      frameDb,
      speechRuns: [
        { startFrame: 20, endFrame: 80 },
        { startFrame: 150, endFrame: 220 },
      ],
      noiseFloorDb: -82,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.1,
    });

    assert.equal(plan.runs[1].startFrame, 144);
  });

  it("does not treat continuous high-frequency room hiss as a speech edge", () => {
    const frameDb = new Array<number>(260).fill(-82);
    for (let frame = 20; frame < 80; frame += 1) frameDb[frame] = -28;
    for (let frame = 150; frame < 220; frame += 1) frameDb[frame] = -28;
    const fricativeFrameDb = new Array<number>(frameDb.length).fill(-50);

    const plan = planGainCurve({
      frameDb,
      fricativeFrameDb,
      fricativeNoiseFloorDb: -50,
      speechRuns: [
        { startFrame: 20, endFrame: 80 },
        { startFrame: 150, endFrame: 220 },
      ],
      noiseFloorDb: -82,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.1,
    });

    assert.equal(plan.runs.length, 2);
    assert.equal(plan.runs[1].startFrame, 150, "steady energy at its own noise floor is not onset evidence");
    assert.equal(plan.tailRescueRunCount, 0, "steady HF room tone must not become a rescued tail");
  });

  it("bounds close-gap onset evidence at the previous run boundary", () => {
    const frameDb = new Array<number>(220).fill(-82);
    for (let frame = 30; frame < 100; frame += 1) frameDb[frame] = -28;
    for (let frame = 103; frame < 180; frame += 1) frameDb[frame] = -28;
    const fricativeFrameDb = new Array<number>(frameDb.length).fill(-82);
    for (let frame = 90; frame < 103; frame += 1) fricativeFrameDb[frame] = -42;

    const plan = planGainCurve({
      frameDb,
      fricativeFrameDb,
      fricativeNoiseFloorDb: -82,
      speechRuns: [
        { startFrame: 30, endFrame: 100 },
        { startFrame: 103, endFrame: 180 },
      ],
      noiseFloorDb: -82,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.1,
    });

    assert.equal(plan.runs[0].endFrame, 100);
    assert.equal(plan.runs[1].startFrame, 100);
    assert.ok(plan.runs[1].startFrame >= plan.runs[0].endFrame, "backtracking must never overlap the previous run");
  });

  it("does not use high-frequency evidence alone to hold a speech tail at body gain", () => {
    const frameDb = new Array<number>(240).fill(-82);
    for (let frame = 20; frame < 100; frame += 1) frameDb[frame] = -28;
    const fricativeFrameDb = new Array<number>(frameDb.length).fill(-82);
    for (let frame = 100; frame < frameDb.length; frame += 1) fricativeFrameDb[frame] = -42;
    const baseInput = {
      frameDb,
      fricativeFrameDb,
      fricativeNoiseFloorDb: -82,
      speechRuns: [{ startFrame: 20, endFrame: 100 }],
      noiseFloorDb: -82,
      speechThresholdDb: -55,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.1,
    };

    const plan = planGainCurve({ ...baseInput, pauseNoiseRisk: 0.1 });

    assert.equal(plan.tailRescueRunCount, 0);
    assert.equal(plan.tailRescueFrameCount, 0);
    assert.equal(plan.tailRescueMaxMs, 0);
  });

  it("uses bounded high-frequency evidence to preserve a quiet sentence-final fricative tail", () => {
    const frameDb = new Array<number>(240).fill(-82);
    for (let frame = 40; frame < 140; frame += 1) frameDb[frame] = -28;
    for (let frame = 140; frame < 155; frame += 1) frameDb[frame] = -77;
    const fricativeFrameDb = new Array<number>(frameDb.length).fill(-82);
    for (let frame = 140; frame < 155; frame += 1) fricativeFrameDb[frame] = -45;

    const plan = planGainCurve({
      frameDb,
      fricativeFrameDb,
      fricativeNoiseFloorDb: -82,
      speechRuns: [{ startFrame: 40, endFrame: 140 }],
      noiseFloorDb: -82,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.1,
    });

    const bodyGainDb = gainDbAtFrame(plan.gainCurve, 100);
    const tailGainDb = gainDbAtFrame(plan.gainCurve, 154);
    assert.equal(plan.tailRescueRunCount, 1);
    assert.equal(plan.tailRescueFrameCount, 15);
    assert.equal(plan.tailRescueMaxMs, 150);
    assert.ok(Math.abs(tailGainDb - bodyGainDb) < 1, `fricative tail ${tailGainDb.toFixed(2)} dB should retain body gain ${bodyGainDb.toFixed(2)} dB`);
  });

  it("uses one attached high-frequency evidence frame for a brief final t burst", () => {
    const frameDb = new Array<number>(220).fill(-82);
    for (let frame = 40; frame < 140; frame += 1) frameDb[frame] = -28;
    frameDb[140] = -77;
    const fricativeFrameDb = new Array<number>(frameDb.length).fill(-82);
    fricativeFrameDb[140] = -44;

    const plan = planGainCurve({
      frameDb,
      fricativeFrameDb,
      fricativeNoiseFloorDb: -82,
      speechRuns: [{ startFrame: 40, endFrame: 140 }],
      noiseFloorDb: -82,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.1,
    });

    assert.equal(plan.tailRescueRunCount, 1);
    assert.equal(plan.tailRescueFrameCount, 1);
    assert.ok(Math.abs(gainDbAtFrame(plan.gainCurve, 140) - gainDbAtFrame(plan.gainCurve, 100)) < 1);
  });

  it("does not attach detached high-frequency room or reverb after a silent gap", () => {
    const frameDb = new Array<number>(240).fill(-82);
    for (let frame = 40; frame < 140; frame += 1) frameDb[frame] = -28;
    for (let frame = 144; frame < 160; frame += 1) frameDb[frame] = -77;
    const fricativeFrameDb = new Array<number>(frameDb.length).fill(-82);
    for (let frame = 144; frame < 160; frame += 1) fricativeFrameDb[frame] = -45;

    const plan = planGainCurve({
      frameDb,
      fricativeFrameDb,
      fricativeNoiseFloorDb: -82,
      speechRuns: [{ startFrame: 40, endFrame: 140 }],
      noiseFloorDb: -82,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.1,
    });

    assert.equal(plan.tailRescueRunCount, 0);
    assert.equal(plan.tailRescueFrameCount, 0);
  });

  it("bounds high-frequency tail rescue at the next detected speech run", () => {
    const frameDb = new Array<number>(260).fill(-82);
    for (let frame = 40; frame < 140; frame += 1) frameDb[frame] = -28;
    for (let frame = 140; frame < 180; frame += 1) frameDb[frame] = -77;
    for (let frame = 160; frame < 230; frame += 1) frameDb[frame] = -28;
    const fricativeFrameDb = new Array<number>(frameDb.length).fill(-82);
    for (let frame = 140; frame < 180; frame += 1) fricativeFrameDb[frame] = -45;

    const plan = planGainCurve({
      frameDb,
      fricativeFrameDb,
      fricativeNoiseFloorDb: -82,
      speechRuns: [
        { startFrame: 40, endFrame: 140 },
        { startFrame: 160, endFrame: 230 },
      ],
      noiseFloorDb: -82,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.1,
    });

    assert.equal(plan.tailRescueRunCount, 1);
    assert.equal(plan.tailRescueFrameCount, 20);
    assert.ok(Math.abs(gainDbAtFrame(plan.gainCurve, 190) - gainDbAtFrame(plan.gainCurve, 100)) < 1);
  });

  it("keeps the full body of a speech run at body gain, ramps only into surrounding silence", () => {
    // Simulate 3 s file: 0-1 s silence, 1-2.5 s speech, 2.5-3 s silence.
    const frameDb: number[] = [];
    for (let i = 0; i < 100; i += 1) frameDb.push(-70); // 1 s silence
    for (let i = 0; i < 150; i += 1) frameDb.push(-22); // 1.5 s speech
    for (let i = 0; i < 50; i += 1) frameDb.push(-70); // 0.5 s silence
    const speechRuns = [{ startFrame: 100, endFrame: 250 }];

    const plan = planGainCurve({
      frameDb,
      speechRuns,
      noiseFloorDb: -70,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs: 10,
      targetDb: -22,
      instabilityHint: 0.05,
    });

    // Pick 5 frames spread across the body. The first frame of the run
    // (frame 100) and the last frame (frame 249) BOTH need to be at full
    // body gain — that's the whole point of moving ramps into silence.
    const bodyFirstDb = 20 * Math.log10(plan.gainCurve[100] + 1e-9);
    const bodyLastDb = 20 * Math.log10(plan.gainCurve[249] + 1e-9);
    const bodyMidDb = 20 * Math.log10(plan.gainCurve[175] + 1e-9);
    assert.ok(
      Math.abs(bodyFirstDb - bodyMidDb) < 1.2,
      `first body frame ${bodyFirstDb.toFixed(2)} dB should be close to mid ${bodyMidDb.toFixed(2)} dB (no attack-duck)`,
    );
    assert.ok(
      Math.abs(bodyLastDb - bodyMidDb) < 1.2,
      `last body frame ${bodyLastDb.toFixed(2)} dB should be close to mid ${bodyMidDb.toFixed(2)} dB (no release-duck)`,
    );

    // Phase-1 cold-open protection completes the first-run attack before
    // the detected start, so the last few pre-run frames are already at body
    // gain while deeper pre-roll remains below body.
    const attackEdgeDb = 20 * Math.log10(plan.gainCurve[99] + 1e-9);
    assert.ok(
      Math.abs(attackEdgeDb - bodyFirstDb) < 0.3,
      `attack edge ${attackEdgeDb.toFixed(2)} dB should be at body first ${bodyFirstDb.toFixed(2)} dB`,
    );
    const attackPreRollDb = 20 * Math.log10(plan.gainCurve[92] + 1e-9);
    assert.ok(
      attackPreRollDb < bodyFirstDb,
      `deeper attack pre-roll ${attackPreRollDb.toFixed(2)} dB should be below body first ${bodyFirstDb.toFixed(2)} dB`,
    );

    // Deep in the post-run silence (frame 299 → 2.99 s, well past 500 ms
    // release) gain should be at full expander floor.
    const deepSilenceGainDb = 20 * Math.log10(plan.gainCurve[299] + 1e-9);
    assert.ok(
      deepSilenceGainDb <= 0.05 && deepSilenceGainDb >= -1.55,
      `deep silence gain ${deepSilenceGainDb.toFixed(2)} dB should stay source-stable`,
    );
  });

  it("protects soft spoken tails that fall just outside the detected speech run", () => {
    const frameDb = new Array<number>(260).fill(-78);
    for (let frame = 50; frame < 170; frame += 1) frameDb[frame] = -30;
    for (let frame = 170; frame < 205; frame += 1) frameDb[frame] = -57;

    const plan = planGainCurve({
      frameDb,
      speechRuns: [{ startFrame: 50, endFrame: 170 }],
      noiseFloorDb: -78,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.2,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.2,
    });

    const bodyGainDb = gainDbAtFrame(plan.gainCurve, 120);
    const softTailGainDb = gainDbAtFrame(plan.gainCurve, 200);
    const deepSilenceGainDb = gainDbAtFrame(plan.gainCurve, 258);

    assert.equal(plan.tailRescueRunCount, 1);
    assert.equal(plan.tailRescueFrameCount, 35);
    assert.equal(plan.tailRescueMaxMs, 350);
    assert.ok(
      bodyGainDb - softTailGainDb < 4,
      `soft spoken tail should stay near body gain, got body ${bodyGainDb.toFixed(2)} dB vs tail ${softTailGainDb.toFixed(2)} dB`,
    );
    const postTailReleaseGainDb = gainDbAtFrame(plan.gainCurve, 230);
    assert.ok(
      postTailReleaseGainDb > -8,
      `release should continue after rescued tail, got ${postTailReleaseGainDb.toFixed(2)} dB at 250 ms post-tail`,
    );
    assert.ok(
      deepSilenceGainDb <= 0.05 && deepSilenceGainDb >= -1.55,
      `real post-tail silence should return to the shallow source-stable trim, got ${deepSilenceGainDb.toFixed(2)} dB`,
    );
  });

  it("rescues very quiet real-world tails after a normal dialogue body", () => {
    const frameDb = new Array<number>(260).fill(-82);
    for (let frame = 40; frame < 140; frame += 1) frameDb[frame] = -28;
    for (let frame = 140; frame < 160; frame += 1) frameDb[frame] = -52;

    const plan = planGainCurve({
      frameDb,
      speechRuns: [{ startFrame: 40, endFrame: 140 }],
      noiseFloorDb: -82,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.2,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.2,
    });

    const bodyGainDb = gainDbAtFrame(plan.gainCurve, 100);
    const tailGains = Array.from({ length: 20 }, (_, index) => gainDbAtFrame(plan.gainCurve, 140 + index));
    const worstTailDipDb = bodyGainDb - Math.min(...tailGains);

    assert.equal(plan.tailRescueRunCount, 1);
    assert.ok(worstTailDipDb < 1, `quiet tail should hold body gain; worst dip ${worstTailDipDb.toFixed(2)} dB`);
  });

  it("does not let the next run attack ramp overwrite a rescued soft tail", () => {
    const frameDb = new Array<number>(280).fill(-78);
    for (let frame = 50; frame < 170; frame += 1) frameDb[frame] = -30;
    for (let frame = 170; frame < 195; frame += 1) frameDb[frame] = -57;
    for (let frame = 195; frame < 245; frame += 1) frameDb[frame] = -30;

    const plan = planGainCurve({
      frameDb,
      speechRuns: [
        { startFrame: 50, endFrame: 170 },
        { startFrame: 195, endFrame: 245 },
      ],
      noiseFloorDb: -78,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.2,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      instabilityHint: 0.2,
    });

    const firstBodyGainDb = gainDbAtFrame(plan.gainCurve, 120);
    const softTailNearNextRunGainDb = gainDbAtFrame(plan.gainCurve, 193);
    const secondBodyGainDb = gainDbAtFrame(plan.gainCurve, 220);

    assert.equal(plan.tailRescueRunCount, 1);
    assert.equal(plan.tailRescueFrameCount, 25);
    assert.equal(plan.tailRescueMaxMs, 250);
    assert.ok(
      firstBodyGainDb - softTailNearNextRunGainDb < 4,
      `next run attack should not repaint rescued tail, got first body ${firstBodyGainDb.toFixed(2)} dB vs near-next tail ${softTailNearNextRunGainDb.toFixed(2)} dB`,
    );
    assert.ok(
      Math.abs(secondBodyGainDb - firstBodyGainDb) < 1,
      `second speech run should still reach body gain, got first ${firstBodyGainDb.toFixed(2)} dB vs second ${secondBodyGainDb.toFixed(2)} dB`,
    );
  });

  it("preserves a louder below-ceiling final syllable without a run-edge dip", () => {
    const totalFrames = 180;
    const run = { startFrame: 20, endFrame: 150 };
    const tailStart = run.endFrame - 15;
    const frameDb = new Array<number>(totalFrames).fill(-82);
    const samples = new Float32Array(totalFrames * FRAME_SAMPLES);

    for (let frame = run.startFrame; frame < run.endFrame; frame += 1) {
      const rmsDb = frame >= tailStart ? -20 : -24;
      frameDb[frame] = rmsDb;
      const amp = dbToLin(rmsDb) * Math.SQRT2;
      const start = frame * FRAME_SAMPLES;
      for (let sample = 0; sample < FRAME_SAMPLES; sample += 1) {
        const sampleIndex = start + sample;
        samples[sampleIndex] = Math.sin((2 * Math.PI * 320 * sampleIndex) / SAMPLE_RATE) * amp;
      }
    }

    const plan = planGainCurve({
      frameDb,
      speechRuns: [run],
      noiseFloorDb: -82,
      speechThresholdDb: -58,
      pauseNoiseRisk: 0.05,
      frameMs: FRAME_MS,
      samples,
      sampleRate: SAMPLE_RATE,
      targetDb: -22,
      sourceTargetBlend: 0,
      peakCeilingDb: -3,
      instabilityHint: 0,
      speechSpikeTaming: 1,
    });

    const bodyGainDb = gainDbAtFrame(plan.gainCurve, 80);
    const edgeGains = Array.from(
      { length: 15 },
      (_, index) => gainDbAtFrame(plan.gainCurve, tailStart + index),
    );
    const worstTailDipDb = bodyGainDb - Math.min(...edgeGains);

    assert.ok(
      worstTailDipDb < 1,
      `below-ceiling source emphasis should remain stable at the tail; worst dip ${worstTailDipDb.toFixed(2)} dB`,
    );
  });
});

describe("trimmed-mean target", () => {
  it("trims loud and quiet outliers so the target tracks the typical sentence level", () => {
    // 10 sentences: 8 typical at -27 dB, one loud outlier at -10 dB, one
    // quiet outlier at -42 dB. A median would pick the middle of all 10 and
    // would sit at -27 too; but the mean without trimming would get dragged
    // up by the loud outlier. The trimmed mean should return exactly the
    // typical level.
    const levels = [-27, -27, -27, -10, -27, -42, -27, -27, -27, -27];
    const frameDb: number[] = [];
    const speechRuns: Array<{ startFrame: number; endFrame: number }> = [];
    for (let s = 0; s < levels.length; s += 1) {
      const gap = 30;
      const speechLen = 80;
      const start = frameDb.length + gap;
      for (let i = 0; i < gap; i += 1) frameDb.push(-70);
      for (let i = 0; i < speechLen; i += 1) frameDb.push(levels[s]);
      speechRuns.push({ startFrame: start, endFrame: start + speechLen });
    }

    const plan = planGainCurve({
      frameDb,
      speechRuns,
      noiseFloorDb: -70,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs: 10,
      targetDb: -22,
    });

    // Trimmed mean of [-42,-27,-27,-27,-27,-27,-27,-27,-27,-10] after
    // dropping 1 each end = mean([-27]*8) = -27.
    // The planner now follows the source lightly so actors converge toward
    // the shared house VO target instead of preserving original offsets.
    const expectedTarget = 0.15 * -27 + 0.85 * -22;
    assert.ok(
      Math.abs(plan.targetDb - expectedTarget) < 0.2,
      `target ${plan.targetDb.toFixed(2)} dB should track the trimmed mean (${expectedTarget.toFixed(2)} dB)`,
    );

    // The 8 typical sentences should all be lifted by ≈ +2.25 dB to hit
    // target. Outliers get clamped at the gain window.
    const typicalRun = plan.runs.find((r) => Math.abs(r.meanDb - -27) < 0.5);
    assert.ok(typicalRun, "expected a typical run in the plan");
    const expectedGain = expectedTarget - -27;
    assert.ok(
      Math.abs(typicalRun!.plannedGainDb - expectedGain) < 0.5,
      `typical sentence should get ≈ ${expectedGain.toFixed(2)} dB, got ${typicalRun!.plannedGainDb.toFixed(2)} dB`,
    );
  });
});

describe("adaptive micro-ride", () => {
  it("tightens the micro-ride on clean sources (low instabilityHint) and widens it on messy sources", () => {
    const frameDb: number[] = [];
    // 30 frames of silence at -70 dB
    for (let i = 0; i < 30; i += 1) frameDb.push(-70);
    // 120 frames of steady speech near -22 dB
    for (let i = 0; i < 120; i += 1) frameDb.push(-22);
    // 30 frames of silence
    for (let i = 0; i < 30; i += 1) frameDb.push(-70);
    const speechRuns = [{ startFrame: 30, endFrame: 150 }];

    const cleanPlan = planGainCurve({
      frameDb,
      speechRuns,
      noiseFloorDb: -70,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs: 10,
      instabilityHint: 0.05,
    });
    const messyPlan = planGainCurve({
      frameDb,
      speechRuns,
      noiseFloorDb: -70,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs: 10,
      instabilityHint: 0.95,
    });

    assert.ok(
      cleanPlan.microRideDb < messyPlan.microRideDb - 0.5,
      `clean micro-ride (${cleanPlan.microRideDb.toFixed(2)}) should be well below messy (${messyPlan.microRideDb.toFixed(2)})`,
    );
    assert.ok(cleanPlan.microRideDb <= 0.6, `clean micro-ride should be tight: ${cleanPlan.microRideDb.toFixed(2)}`);
    assert.ok(messyPlan.microRideDb >= 1.3, `messy micro-ride should stay wide: ${messyPlan.microRideDb.toFixed(2)}`);
  });
});

describe("house target and performance transients", () => {
  it("pulls different actor levels toward the same dialogue target", () => {
    const buildPlanForLevel = (speechDb: number) => {
      const frameDb: number[] = [];
      for (let i = 0; i < 40; i += 1) frameDb.push(-75);
      for (let i = 0; i < 140; i += 1) frameDb.push(speechDb);
      for (let i = 0; i < 40; i += 1) frameDb.push(-75);
      return planGainCurve({
        frameDb,
        speechRuns: [{ startFrame: 40, endFrame: 180 }],
        noiseFloorDb: -75,
        speechThresholdDb: -60,
        pauseNoiseRisk: 0.05,
        frameMs: FRAME_MS,
        targetDb: -22,
      });
    };

    const quietActor = buildPlanForLevel(-30);
    const loudActor = buildPlanForLevel(-16);
    const quietBody = quietActor.runs[0].meanDb + quietActor.runs[0].plannedGainDb;
    const loudBody = loudActor.runs[0].meanDb + loudActor.runs[0].plannedGainDb;

    assert.ok(
      Math.abs(quietBody - loudBody) < 3.5,
      `actors should converge materially without destructive attenuation: ${quietBody.toFixed(2)} vs ${loudBody.toFixed(2)} dB`,
    );
    assert.ok(Math.abs(quietActor.targetDb - -22) < 1.4, `quiet actor target should stay near house target: ${quietActor.targetDb.toFixed(2)}`);
    assert.ok(Math.abs(loudActor.targetDb - -22) < 1.4, `loud actor target should stay near house target: ${loudActor.targetDb.toFixed(2)}`);
  });

  it("tames short ah/ugh/hm-style spikes without dipping neighboring dialogue", () => {
    const sampleRate = 16000;
    const frameMs = 10;
    const samplesPerFrame = (sampleRate * frameMs) / 1000;
    const totalFrames = 520;
    const samples = new Float32Array(totalFrames * samplesPerFrame);
    const frameDb = new Array<number>(totalFrames).fill(-78);

    const paintTone = (startFrame: number, endFrame: number, rmsDb: number, hz: number) => {
      const amp = dbToLin(rmsDb) * Math.SQRT2;
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        frameDb[frame] = rmsDb;
        const start = frame * samplesPerFrame;
        const end = start + samplesPerFrame;
        for (let i = start; i < end; i += 1) {
          samples[i] += Math.sin((2 * Math.PI * hz * i) / sampleRate) * amp;
        }
      }
    };

    paintTone(100, 220, -22, 220);
    paintTone(245, 290, -20, 330);
    paintTone(320, 440, -22, 220);
    samples[260 * samplesPerFrame + 30] = 0.86;

    const plan = planGainCurve({
      frameDb,
      speechRuns: [
        { startFrame: 100, endFrame: 220 },
        { startFrame: 245, endFrame: 290 },
        { startFrame: 320, endFrame: 440 },
      ],
      noiseFloorDb: -78,
      speechThresholdDb: -62,
      pauseNoiseRisk: 0.08,
      frameMs,
      samples,
      sampleRate,
      targetDb: -22,
      peakCeilingDb: -3,
    });

    assert.equal(plan.runs[1].runClass, "transient-breath");
    assert.ok(
      plan.runs[1].plannedGainDb <= -3.5 && plan.runs[1].plannedGainDb >= -6.05,
      `performance transient should be subtly and boundedly tamed: ${plan.runs[1].plannedGainDb.toFixed(2)} dB`,
    );

    const leveled = applyGainCurveToSamples(samples, plan.gainCurve, sampleRate, 1, frameMs);
    const transientFrameStart = 260 * samplesPerFrame;
    let transientPeak = 0;
    for (let i = transientFrameStart; i < transientFrameStart + samplesPerFrame; i += 1) {
      transientPeak = Math.max(transientPeak, Math.abs(leveled[i]));
    }
    const transientPeakDb = 20 * Math.log10(transientPeak + 1e-9);
    assert.ok(
      transientPeakDb <= plan.targetDb + 15.5,
      `performance spike should be meaningfully tamed while retaining its native emphasis: ${transientPeakDb.toFixed(2)} dB`,
    );

    const beforeDialogueGainDb = 20 * Math.log10(plan.gainCurve[180] + 1e-9);
    const afterDialogueGainDb = 20 * Math.log10(plan.gainCurve[360] + 1e-9);
    assert.ok(Math.abs(beforeDialogueGainDb) < 0.8, `pre-transient dialogue should not be dipped: ${beforeDialogueGainDb.toFixed(2)} dB`);
    assert.ok(Math.abs(afterDialogueGainDb) < 0.8, `post-transient dialogue should not be dipped: ${afterDialogueGainDb.toFixed(2)} dB`);
  });
});

describe("emitSendcmdScript", () => {
  it("emits keyframes for a fluctuating curve and zeroes timestamps to windowStart", () => {
    // Curve: 1.0 for frames 0-9, 2.0 for frames 10-19, 0.5 for frames 20-29
    const curve = new Float32Array(30);
    for (let i = 0; i < 10; i += 1) curve[i] = 1.0;
    for (let i = 10; i < 20; i += 1) curve[i] = 2.0;
    for (let i = 20; i < 30; i += 1) curve[i] = 0.5;

    const script = emitSendcmdScript(curve, 10, 0, 0.3, 0.1);
    const lines = script.trim().split("\n");
    // Expect at least: t=0 (1.0), step to 2.0, step to 0.5, and a final-frame line.
    assert.ok(lines.length >= 3, `expected >=3 keyframes, got ${lines.length}: ${lines.join(" / ")}`);
    assert.ok(lines[0].startsWith("0.000"), `first line must anchor at t=0: ${lines[0]}`);
    const gains = lines.map((line) => Number(line.match(/volume\s+([\d.]+)/)![1]));
    assert.ok(gains.includes(1.0) && gains.some((g) => Math.abs(g - 2.0) < 0.01), "must cover both gain plateaus");
  });

  it("subtracts windowStartSec so per-segment scripts have 0-based timestamps", () => {
    const curve = new Float32Array(200);
    for (let i = 0; i < 100; i += 1) curve[i] = 1.0;
    for (let i = 100; i < 200; i += 1) curve[i] = 0.5;
    // Take the segment [1.0 s, 2.0 s] at 10 ms frames = [frame 100, frame 200].
    const script = emitSendcmdScript(curve, 10, 1.0, 2.0, 0.1);
    const lines = script.trim().split("\n");
    assert.ok(lines[0].startsWith("0.000"), `segment t=0 must be relative: ${lines[0]}`);
    const gains = lines.map((line) => Number(line.match(/volume\s+([\d.]+)/)![1]));
    // The segment starts in the 0.5-plateau.
    assert.ok(Math.abs(gains[0] - 0.5) < 0.01, `expected 0.5 at segment start, got ${gains[0]}`);
  });
});

describe("WAV codec", () => {
  it("round-trips pcm_f32le WAV", () => {
    const source = new Float32Array(16000);
    for (let i = 0; i < source.length; i += 1) source[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.5;
    const encoded = encodeWavFloat32(source, 16000, 1);
    const decoded = decodeWav(encoded);
    assert.equal(decoded.sampleRate, 16000);
    assert.equal(decoded.channels, 1);
    assert.equal(decoded.samples.length, source.length);
    for (let i = 0; i < 100; i += 1) {
      assert.ok(Math.abs(decoded.samples[i] - source[i]) < 1e-6);
    }
  });
});

describe("spectrum", () => {
  it("detects elevated high-frequency content as sibilance", () => {
    const sampleRate = 16000;
    const duration = 1;
    const total = sampleRate * duration;
    const low = new Float32Array(total);
    const high = new Float32Array(total);
    for (let i = 0; i < total; i += 1) {
      low[i] = Math.sin((2 * Math.PI * 500 * i) / sampleRate) * 0.3;
      high[i] = Math.sin((2 * Math.PI * 500 * i) / sampleRate) * 0.15 + Math.sin((2 * Math.PI * 6500 * i) / sampleRate) * 0.4;
    }
    const lowSib = computeSibilanceScore(computeLogBandSpectrumDb(low, sampleRate));
    const highSib = computeSibilanceScore(computeLogBandSpectrumDb(high, sampleRate));
    assert.ok(highSib > lowSib + 0.2, `expected sibilance score to rise with HF content: low=${lowSib.toFixed(2)} high=${highSib.toFixed(2)}`);
  });
});

describe("actor-decay regressions", () => {
  it("actor-decay: gives a verified quiet later onset its settled recovery without lifting detector-negative pre-roll", () => {
    const totalFrames = 300;
    const frameDb = new Array<number>(totalFrames).fill(-82);
    const loudnessFrameDb = new Array<number>(totalFrames).fill(-82);
    const speechBodyFrameDb = new Array<number>(totalFrames).fill(-82);
    const fricativeFrameDb = new Array<number>(totalFrames).fill(-82);
    const speechRuns = [
      { startFrame: 20, endFrame: 90 },
      { startFrame: 150, endFrame: 230 },
    ];

    for (let frame = 20; frame < 90; frame += 1) {
      frameDb[frame] = -22;
      loudnessFrameDb[frame] = -22;
      speechBodyFrameDb[frame] = -22;
    }
    // The detector starts the quiet line at frame 150, but the six preceding
    // frames carry contiguous raw, voiced-body, and consonant-band evidence.
    // They are speech ownership evidence, unlike the bed at frame 143.
    for (let frame = 144; frame < 150; frame += 1) {
      frameDb[frame] = -60;
      loudnessFrameDb[frame] = -58;
      speechBodyFrameDb[frame] = -52;
      fricativeFrameDb[frame] = -44;
    }
    for (let frame = 150; frame < 230; frame += 1) {
      frameDb[frame] = -38;
      loudnessFrameDb[frame] = -38;
      speechBodyFrameDb[frame] = -40;
      fricativeFrameDb[frame] = -75;
    }

    const frameSnapshot = [...frameDb];
    const loudnessSnapshot = [...loudnessFrameDb];
    const bodySnapshot = [...speechBodyFrameDb];
    const fricativeSnapshot = [...fricativeFrameDb];
    const runSnapshot = speechRuns.map((run) => ({ ...run }));
    const plan = planGainCurve({
      frameDb,
      loudnessFrameDb,
      speechBodyFrameDb,
      fricativeFrameDb,
      fricativeNoiseFloorDb: -82,
      speechRuns,
      noiseFloorDb: -82,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      maxGainDb: 14,
      instabilityHint: 0.1,
    });

    assert.equal(plan.runs[1].startFrame, 144, "contiguous source evidence should own the onset");
    assert.ok(
      plan.runs[1].plannedGainDb >= 12 && plan.runs[1].plannedGainDb <= 14.1,
      `fixture must request 12-14 dB of quiet-line recovery, got ${plan.runs[1].plannedGainDb.toFixed(2)} dB`,
    );
    const detectorNegativePreRollGainDb = gainDbAtFrame(plan.gainCurve, 143);
    const onsetGainDb = gainDbAtFrame(plan.gainCurve, 144);
    const settledBodyGainDb = gainDbAtFrame(plan.gainCurve, 180);
    assert.ok(
      detectorNegativePreRollGainDb <= 5.5,
      `detector-negative recording bed must stay conservative, got ${detectorNegativePreRollGainDb.toFixed(2)} dB`,
    );
    assert.ok(
      settledBodyGainDb - onsetGainDb <= 1.5,
      `verified onset must not spend hundreds of milliseconds climbing from ${onsetGainDb.toFixed(2)} to ${settledBodyGainDb.toFixed(2)} dB`,
    );
    assert.deepEqual(frameDb, frameSnapshot);
    assert.deepEqual(loudnessFrameDb, loudnessSnapshot);
    assert.deepEqual(speechBodyFrameDb, bodySnapshot);
    assert.deepEqual(fricativeFrameDb, fricativeSnapshot);
    assert.deepEqual(speechRuns, runSnapshot);
  });

  it("actor-decay: partially recovers an extreme voiced decrescendo while preserving an ordinary fade", () => {
    const planFade = (startDb: number, endDb: number) => {
      const totalFrames = 260;
      const frameDb = new Array<number>(totalFrames).fill(-82);
      const loudnessFrameDb = new Array<number>(totalFrames).fill(-82);
      const speechBodyFrameDb = new Array<number>(totalFrames).fill(-82);
      const speechRuns = [{ startFrame: 30, endFrame: 230 }];
      for (let frame = 30; frame < 230; frame += 1) {
        const progress = (frame - 30) / 199;
        const levelDb = startDb + (endDb - startDb) * progress;
        frameDb[frame] = levelDb;
        loudnessFrameDb[frame] = levelDb;
        speechBodyFrameDb[frame] = levelDb;
      }
      const frameSnapshot = [...frameDb];
      const loudnessSnapshot = [...loudnessFrameDb];
      const bodySnapshot = [...speechBodyFrameDb];
      const runSnapshot = speechRuns.map((run) => ({ ...run }));
      const plan = planGainCurve({
        frameDb,
        loudnessFrameDb,
        speechBodyFrameDb,
        speechRuns,
        noiseFloorDb: -82,
        speechThresholdDb: -60,
        pauseNoiseRisk: 0.1,
        frameMs: FRAME_MS,
        targetDb: -22,
        sourceTargetBlend: 0,
        maxGainDb: 14,
        instabilityHint: 0.1,
      });
      assert.deepEqual(frameDb, frameSnapshot);
      assert.deepEqual(loudnessFrameDb, loudnessSnapshot);
      assert.deepEqual(speechBodyFrameDb, bodySnapshot);
      assert.deepEqual(speechRuns, runSnapshot);
      return { frameDb, plan };
    };

    const measureFade = (
      frameDb: number[],
      gainCurve: Float32Array,
      headFrame = 50,
      tailFrame = 210,
    ) => {
      const sourceFadeDb = frameDb[headFrame] - frameDb[tailFrame];
      const outputHeadDb = frameDb[headFrame] + gainDbAtFrame(gainCurve, headFrame);
      const outputTailDb = frameDb[tailFrame] + gainDbAtFrame(gainCurve, tailFrame);
      return {
        sourceFadeDb,
        outputFadeDb: outputHeadDb - outputTailDb,
        recoveryDb: sourceFadeDb - (outputHeadDb - outputTailDb),
      };
    };

    const extreme = planFade(-16, -44);
    const extremeFade = measureFade(extreme.frameDb, extreme.plan.gainCurve);
    assert.ok(
      extremeFade.recoveryDb >= 4.5 && extremeFade.recoveryDb <= 7,
      `extreme monotonic body fade needs bounded partial recovery, got ${extremeFade.recoveryDb.toFixed(2)} dB`,
    );
    assert.ok(
      extremeFade.outputFadeDb >= 16,
      `intentional decrescendo must remain clearly descending, got ${extremeFade.outputFadeDb.toFixed(2)} dB`,
    );
    let largestGainStepDb = 0;
    for (let frame = 51; frame <= 210; frame += 1) {
      largestGainStepDb = Math.max(
        largestGainStepDb,
        Math.abs(
          gainDbAtFrame(extreme.plan.gainCurve, frame) -
            gainDbAtFrame(extreme.plan.gainCurve, frame - 1),
        ),
      );
    }
    assert.ok(
      largestGainStepDb <= 0.3,
      `decrescendo recovery must move as a smooth ride, largest 10 ms step ${largestGainStepDb.toFixed(3)} dB`,
    );

    const ordinary = planFade(-26, -31);
    const ordinaryFade = measureFade(ordinary.frameDb, ordinary.plan.gainCurve);
    assert.ok(
      ordinaryFade.recoveryDb <= 2,
      `an ordinary 3-5 dB performance fade should stay essentially intact, planner removed ${ordinaryFade.recoveryDb.toFixed(2)} dB`,
    );
    assert.ok(
      ordinaryFade.outputFadeDb >= 2,
      `ordinary fade must remain audible as a fade, got ${ordinaryFade.outputFadeDb.toFixed(2)} dB`,
    );
  });

  it("actor-decay: restores a body-dominant 400 ms event after phrase-wide absolute-peak handling", () => {
    const sampleRate = 16000;
    const frameMs = 10;
    const samplesPerFrame = (sampleRate * frameMs) / 1000;
    const totalFrames = 520;
    const frameDb = new Array<number>(totalFrames).fill(-82);
    const loudnessFrameDb = new Array<number>(totalFrames).fill(-82);
    const speechBodyFrameDb = new Array<number>(totalFrames).fill(-82);
    const fricativeFrameDb = new Array<number>(totalFrames).fill(-82);
    const speechRuns = [
      { startFrame: 20, endFrame: 100 },
      { startFrame: 130, endFrame: 210 },
      { startFrame: 240, endFrame: 320 },
      { startFrame: 400, endFrame: 440 },
    ];
    const samples = new Float32Array(totalFrames * samplesPerFrame);
    const paintVoicedFrame = (frame: number, rmsDb: number) => {
      const amplitude = dbToLin(rmsDb) * Math.SQRT2;
      const startSample = frame * samplesPerFrame;
      for (let offset = 0; offset < samplesPerFrame; offset += 1) {
        const sampleIndex = startSample + offset;
        samples[sampleIndex] =
          Math.sin((2 * Math.PI * 300 * sampleIndex) / sampleRate) * amplitude;
      }
    };

    for (const run of speechRuns.slice(0, 3)) {
      for (let frame = run.startFrame; frame < run.endFrame; frame += 1) {
        frameDb[frame] = -22;
        loudnessFrameDb[frame] = -22;
        speechBodyFrameDb[frame] = -22;
        paintVoicedFrame(frame, -22);
      }
    }
    // Ethan-derived short event: raw/body are about -20.9/-22.2 dB, with a
    // -4.5 dBFS crest in roughly one third of frames. The low fricative
    // envelope makes this explicitly voiced/body-dominant, not an HF burst.
    for (let frame = 400; frame < 440; frame += 1) {
      frameDb[frame] = -20.91;
      loudnessFrameDb[frame] = -20.1;
      speechBodyFrameDb[frame] = -22.15;
      fricativeFrameDb[frame] = -32.15;
      paintVoicedFrame(frame, -20.91);
      if ((frame - 400) % 3 === 0) {
        samples[frame * samplesPerFrame + 80] = dbToLin(-4.49);
      }
    }

    const frameSnapshot = [...frameDb];
    const loudnessSnapshot = [...loudnessFrameDb];
    const bodySnapshot = [...speechBodyFrameDb];
    const fricativeSnapshot = [...fricativeFrameDb];
    const runSnapshot = speechRuns.map((run) => ({ ...run }));
    const sampleSnapshot = new Float32Array(samples);
    const peakCeilingDb = -3;
    const plan = planGainCurve({
      frameDb,
      loudnessFrameDb,
      speechBodyFrameDb,
      fricativeFrameDb,
      fricativeNoiseFloorDb: -82,
      speechRuns,
      noiseFloorDb: -82,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs,
      targetDb: -22,
      sourceTargetBlend: 0,
      samples,
      sampleRate,
      peakCeilingDb,
      instabilityHint: 0.7,
    });

    const eventRun = plan.runs[3];
    assert.equal(eventRun.runClass, "transient-breath");
    assert.ok(
      eventRun.crestDb >= 16 && eventRun.crestDb <= 17,
      `fixture must reproduce the measured short-event crest, got ${eventRun.crestDb.toFixed(2)} dB`,
    );
    const legacyBreathGainDb = plan.targetDb - 3.2 - -20.1;
    assert.ok(
      eventRun.plannedGainDb >= legacyBreathGainDb + 1.5,
      `body-owned word must not inherit the full breath target: ${eventRun.plannedGainDb.toFixed(2)} vs legacy ${legacyBreathGainDb.toFixed(2)} dB`,
    );
    assert.ok(
      eventRun.peakReducedDb <= -3.5,
      `fixture must request phrase-wide absolute-peak handling, got ${eventRun.peakReducedDb.toFixed(2)} dB`,
    );

    const prePeakBodyPlanDb = -22.15 + eventRun.plannedGainDb;
    let projectedBodyPower = 0;
    for (let frame = 400; frame < 440; frame += 1) {
      const gainDb = gainDbAtFrame(plan.gainCurve, frame);
      projectedBodyPower += Math.pow(10, (-22.15 + gainDb) / 10);
      assert.ok(
        gainDb <= eventRun.plannedGainDb + 0.05,
        `peak restoration must be lift-only and never exceed the class plan at frame ${frame}`,
      );
    }
    const projectedBodyDb = 10 * Math.log10(projectedBodyPower / 40 + 1e-30);
    const projectedBodyLossDb = projectedBodyDb - -22.15;
    assert.ok(
      projectedBodyLossDb >= -4.8 && projectedBodyLossDb <= -1.5,
      `body-owned word must stay controlled without becoming a hole, got ${projectedBodyLossDb.toFixed(2)} dB`,
    );
    assert.ok(
      projectedBodyDb >= prePeakBodyPlanDb - 1,
      `body-dominant short event must finish within 1 dB of its own pre-peak plan, got ${projectedBodyDb.toFixed(2)} vs ${prePeakBodyPlanDb.toFixed(2)} dB (retained advantage ${eventRun.transientRetainedAdvantageDb.toFixed(2)} dB)`,
    );

    const rendered = applyGainCurveToSamples(
      samples,
      plan.gainCurve,
      sampleRate,
      1,
      frameMs,
    );
    let renderedEventPeak = 0;
    for (
      let sample = 400 * samplesPerFrame;
      sample < 440 * samplesPerFrame;
      sample += 1
    ) {
      renderedEventPeak = Math.max(renderedEventPeak, Math.abs(rendered[sample]));
    }
    const renderedEventPeakDb = 20 * Math.log10(renderedEventPeak + 1e-9);
    assert.ok(
      renderedEventPeakDb <= peakCeilingDb + 0.05,
      `restoration must retain the absolute peak ceiling, got ${renderedEventPeakDb.toFixed(2)} dBFS`,
    );
    assert.deepEqual(frameDb, frameSnapshot);
    assert.deepEqual(loudnessFrameDb, loudnessSnapshot);
    assert.deepEqual(speechBodyFrameDb, bodySnapshot);
    assert.deepEqual(fricativeFrameDb, fricativeSnapshot);
    assert.deepEqual(speechRuns, runSnapshot);
    assert.deepEqual(samples, sampleSnapshot);
  });

  it("actor-decay: continuously distinguishes a body-owned short word from a breath-shaped transient", () => {
    const sampleRate = 16000;
    const frameMs = 10;
    const samplesPerFrame = (sampleRate * frameMs) / 1000;
    const totalFrames = 520;
    const eventStartFrame = 400;
    const eventFrames = 54;
    const eventEndFrame = eventStartFrame + eventFrames;
    const rawDb = -18.755;
    const loudnessDb = -17.8;
    const peakDb = -2.465;
    const peakCeilingDb = -3;
    const speechRuns = [
      { startFrame: 20, endFrame: 100 },
      { startFrame: 130, endFrame: 210 },
      { startFrame: 240, endFrame: 320 },
      { startFrame: eventStartFrame, endFrame: eventEndFrame },
    ];

    const buildPlan = (
      bodyDb: number,
      fricativeDb: number,
      includeBodyEvidence = true,
      eventShape: "tone" | "lowpass-noise" = "tone",
    ) => {
      const frameDb = new Array<number>(totalFrames).fill(-82);
      const loudnessFrameDb = new Array<number>(totalFrames).fill(-82);
      const speechBodyFrameDb = new Array<number>(totalFrames).fill(-82);
      const fricativeFrameDb = new Array<number>(totalFrames).fill(-82);
      const samples = new Float32Array(totalFrames * samplesPerFrame);
      const paintTone = (frame: number, rmsDb: number, hz: number) => {
        const amplitude = dbToLin(rmsDb) * Math.SQRT2;
        const startSample = frame * samplesPerFrame;
        for (let offset = 0; offset < samplesPerFrame; offset += 1) {
          const sampleIndex = startSample + offset;
          samples[sampleIndex] =
            Math.sin((2 * Math.PI * hz * sampleIndex) / sampleRate) * amplitude;
        }
      };

      for (const run of speechRuns.slice(0, 3)) {
        for (let frame = run.startFrame; frame < run.endFrame; frame += 1) {
          frameDb[frame] = -22.3;
          loudnessFrameDb[frame] = -22.3;
          speechBodyFrameDb[frame] = -22.3;
          fricativeFrameDb[frame] = -38;
          paintTone(frame, -22.3, 260);
        }
      }
      const eventHz = bodyDb > fricativeDb ? 300 : 6000;
      let noiseState = 0x5eed1234;
      let lowpassState = 0;
      for (let frame = eventStartFrame; frame < eventEndFrame; frame += 1) {
        frameDb[frame] = rawDb;
        loudnessFrameDb[frame] = loudnessDb;
        speechBodyFrameDb[frame] = bodyDb;
        fricativeFrameDb[frame] = fricativeDb;
        if (eventShape === "tone") {
          paintTone(frame, rawDb, eventHz);
        } else {
          const startSample = frame * samplesPerFrame;
          const noiseFrame = new Float32Array(samplesPerFrame);
          let noisePower = 0;
          for (let offset = 0; offset < samplesPerFrame; offset += 1) {
            noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0;
            const white = (noiseState / 0xffffffff) * 2 - 1;
            lowpassState = lowpassState * 0.94 + white * 0.06;
            noiseFrame[offset] = lowpassState;
            noisePower += lowpassState * lowpassState;
          }
          const scale =
            dbToLin(rawDb) / Math.sqrt(noisePower / samplesPerFrame + 1e-30);
          for (let offset = 0; offset < samplesPerFrame; offset += 1) {
            samples[startSample + offset] = noiseFrame[offset] * scale;
          }
        }
        if ((frame - eventStartFrame) % 3 === 0) {
          samples[frame * samplesPerFrame + 80] = dbToLin(peakDb);
        }
      }

      const plan = planGainCurve({
        frameDb,
        loudnessFrameDb,
        ...(includeBodyEvidence ? { speechBodyFrameDb } : {}),
        fricativeFrameDb,
        fricativeNoiseFloorDb: -82,
        speechRuns,
        noiseFloorDb: -82,
        speechThresholdDb: -55,
        pauseNoiseRisk: 0.1,
        frameMs,
        targetDb: -22,
        sourceTargetBlend: 0,
        samples,
        sampleRate,
        peakCeilingDb,
        instabilityHint: 0.7,
      });
      const eventRun = plan.runs[3];
      let projectedBodyPower = 0;
      for (let frame = eventStartFrame; frame < eventEndFrame; frame += 1) {
        projectedBodyPower += Math.pow(
          10,
          (bodyDb + gainDbAtFrame(plan.gainCurve, frame)) / 10,
        );
      }
      return {
        plan,
        eventRun,
        projectedBodyLossDb:
          10 * Math.log10(projectedBodyPower / eventFrames + 1e-30) - bodyDb,
      };
    };

    const bodyOwned = buildPlan(-19.179, -29.13);
    const breathShaped = buildPlan(-33, -18);
    const lowpassBreath = buildPlan(
      rawDb + 10 * Math.log10(0.7),
      rawDb - 14,
      true,
      "lowpass-noise",
    );
    const missingBodyEvidence = buildPlan(-19.179, -29.13, false);
    const legacyBreathGainDb = bodyOwned.plan.targetDb - 3.2 - loudnessDb;

    assert.equal(bodyOwned.eventRun.runClass, "transient-breath");
    assert.equal(breathShaped.eventRun.runClass, "transient-breath");
    assert.ok(
      bodyOwned.eventRun.plannedGainDb >= legacyBreathGainDb + 2.25,
      `body-owned event needs bounded class-plan restoration, got ${bodyOwned.eventRun.plannedGainDb.toFixed(2)} vs legacy ${legacyBreathGainDb.toFixed(2)} dB`,
    );
    assert.ok(
      bodyOwned.eventRun.transientBodyRecoveryDb >= 0 &&
        bodyOwned.eventRun.transientBodyRecoveryDb <= 3.2 &&
        bodyOwned.eventRun.plannedGainDb <= 0,
      `transient restoration must only withdraw at most 3.2 dB of attenuation, got ${bodyOwned.eventRun.transientBodyRecoveryDb.toFixed(2)} dB recovery and ${bodyOwned.eventRun.plannedGainDb.toFixed(2)} dB plan`,
    );
    assert.ok(
      bodyOwned.projectedBodyLossDb >= -6.25 && bodyOwned.projectedBodyLossDb <= -2.5,
      `body-owned event must remain controlled without a 6-10 dB hole, got ${bodyOwned.projectedBodyLossDb.toFixed(2)} dB`,
    );
    assert.ok(
      breathShaped.eventRun.plannedGainDb <= legacyBreathGainDb + 0.5,
      `low-body HF transient must retain breath control, got ${breathShaped.eventRun.plannedGainDb.toFixed(2)} dB`,
    );
    assert.equal(lowpassBreath.eventRun.runClass, "transient-breath");
    assert.ok(
      lowpassBreath.eventRun.plannedGainDb <= legacyBreathGainDb + 0.5,
      `aperiodic low-passed breath must not borrow voiced-body recovery, got ${lowpassBreath.eventRun.plannedGainDb.toFixed(2)} dB (authority ${lowpassBreath.eventRun.bodyOwnershipAuthority.toFixed(3)}, recovery ${lowpassBreath.eventRun.transientBodyRecoveryDb.toFixed(2)} dB)`,
    );
    assert.ok(
      Math.abs(missingBodyEvidence.eventRun.plannedGainDb - legacyBreathGainDb) <= 0.05,
      `missing body evidence must fail soft to the legacy plan, got ${missingBodyEvidence.eventRun.plannedGainDb.toFixed(2)} dB`,
    );
    assert.ok(
      Math.abs(
        bodyOwned.eventRun.peakReducedDb -
          missingBodyEvidence.eventRun.peakReducedDb,
      ) <= 0.01,
      `paired ceiling lift must retain the original peak-owner reduction: ${bodyOwned.eventRun.peakReducedDb.toFixed(2)} vs ${missingBodyEvidence.eventRun.peakReducedDb.toFixed(2)} dB`,
    );

    const restorations: number[] = [];
    for (let step = 0; step <= 30; step += 1) {
      const progress = step / 30;
      const bodyDb = rawDb - (14 - 13.55 * progress);
      const fricativeDb = rawDb - (0.5 + 10 * progress);
      restorations.push(buildPlan(bodyDb, fricativeDb).eventRun.plannedGainDb - legacyBreathGainDb);
    }
    assert.ok(restorations[0] <= 0.5, `breath-shaped endpoint changed ${restorations[0].toFixed(2)} dB`);
    assert.ok(
      restorations.at(-1)! >= 2.25,
      `body-owned endpoint restored only ${restorations.at(-1)!.toFixed(2)} dB`,
    );
    for (let index = 1; index < restorations.length; index += 1) {
      assert.ok(
        restorations[index] >= restorations[index - 1] - 0.05,
        `body evidence response must be monotone at step ${index}`,
      );
      assert.ok(
        restorations[index] - restorations[index - 1] <= 0.6,
        `body evidence response must have no hard engagement jump at step ${index}: ${restorations[index - 1].toFixed(2)} -> ${restorations[index].toFixed(2)} dB`,
      );
    }
  });

  it("cinematic stability: symmetrically softens extreme rises and falls without flattening ordinary performance trends", () => {
    const planTrend = (startDb: number, endDb: number) => {
      const totalFrames = 260;
      const frameDb = new Array<number>(totalFrames).fill(-82);
      const loudnessFrameDb = new Array<number>(totalFrames).fill(-82);
      const speechBodyFrameDb = new Array<number>(totalFrames).fill(-82);
      const speechRuns = [{ startFrame: 30, endFrame: 230 }];
      for (let frame = 30; frame < 230; frame += 1) {
        const progress = (frame - 30) / 199;
        const levelDb = startDb + (endDb - startDb) * progress;
        frameDb[frame] = levelDb;
        loudnessFrameDb[frame] = levelDb;
        speechBodyFrameDb[frame] = levelDb;
      }

      const frameSnapshot = [...frameDb];
      const loudnessSnapshot = [...loudnessFrameDb];
      const bodySnapshot = [...speechBodyFrameDb];
      const runSnapshot = speechRuns.map((run) => ({ ...run }));
      const plan = planGainCurve({
        frameDb,
        loudnessFrameDb,
        speechBodyFrameDb,
        speechRuns,
        noiseFloorDb: -82,
        speechThresholdDb: -60,
        pauseNoiseRisk: 0.1,
        frameMs: FRAME_MS,
        targetDb: -22,
        sourceTargetBlend: 0,
        maxGainDb: 14,
        instabilityHint: 0.1,
      });

      assert.deepEqual(frameDb, frameSnapshot);
      assert.deepEqual(loudnessFrameDb, loudnessSnapshot);
      assert.deepEqual(speechBodyFrameDb, bodySnapshot);
      assert.deepEqual(speechRuns, runSnapshot);

      const headFrame = 50;
      const tailFrame = 210;
      const sourceDeltaDb = frameDb[tailFrame] - frameDb[headFrame];
      const outputHeadDb = frameDb[headFrame] + gainDbAtFrame(plan.gainCurve, headFrame);
      const outputTailDb = frameDb[tailFrame] + gainDbAtFrame(plan.gainCurve, tailFrame);
      const outputDeltaDb = outputTailDb - outputHeadDb;
      let largestGainStepDb = 0;
      for (let frame = headFrame + 1; frame <= tailFrame; frame += 1) {
        largestGainStepDb = Math.max(
          largestGainStepDb,
          Math.abs(
            gainDbAtFrame(plan.gainCurve, frame) -
              gainDbAtFrame(plan.gainCurve, frame - 1),
          ),
        );
      }
      return {
        sourceDeltaDb,
        outputDeltaDb,
        recoveryDb: Math.abs(sourceDeltaDb) - Math.abs(outputDeltaDb),
        largestGainStepDb,
      };
    };

    const extremeRise = planTrend(-44, -16);
    const extremeFall = planTrend(-16, -44);
    const ordinaryRise = planTrend(-31, -26);
    const ordinaryFall = planTrend(-26, -31);
    const trendLedger =
      `rise recovery ${extremeRise.recoveryDb.toFixed(2)}, fall recovery ${extremeFall.recoveryDb.toFixed(2)}, ` +
      `rise slew ${extremeRise.largestGainStepDb.toFixed(3)}, fall slew ${extremeFall.largestGainStepDb.toFixed(3)}, ` +
      `ordinary rise recovery ${ordinaryRise.recoveryDb.toFixed(2)}, ordinary fall recovery ${ordinaryFall.recoveryDb.toFixed(2)} dB`;
    for (const [direction, result] of [
      ["rise", extremeRise],
      ["fall", extremeFall],
    ] as const) {
      assert.ok(
        result.recoveryDb >= 4.5 && result.recoveryDb <= 7,
        `extreme ${direction} needs bounded partial correction, got ${result.recoveryDb.toFixed(2)} dB (${trendLedger})`,
      );
      assert.ok(
        Math.abs(result.outputDeltaDb) >= 16,
        `extreme ${direction} must remain an expressive trend, got ${result.outputDeltaDb.toFixed(2)} dB`,
      );
      assert.equal(
        Math.sign(result.outputDeltaDb),
        Math.sign(result.sourceDeltaDb),
        `extreme ${direction} must retain its source direction`,
      );
      assert.ok(
        result.largestGainStepDb <= 0.3,
        `extreme ${direction} correction must slew smoothly, largest 10 ms step ${result.largestGainStepDb.toFixed(3)} dB`,
      );
    }
    assert.ok(
      Math.abs(extremeRise.recoveryDb - extremeFall.recoveryDb) <= 1.5,
      `opposite extreme trends need comparable support, rise ${extremeRise.recoveryDb.toFixed(2)} vs fall ${extremeFall.recoveryDb.toFixed(2)} dB`,
    );

    for (const [direction, result] of [
      ["rise", ordinaryRise],
      ["fall", ordinaryFall],
    ] as const) {
      assert.ok(
        result.recoveryDb <= 2,
        `ordinary ${direction} should stay essentially intact, planner removed ${result.recoveryDb.toFixed(2)} dB`,
      );
      assert.ok(
        Math.abs(result.outputDeltaDb) >= 2,
        `ordinary ${direction} must remain audible, got ${result.outputDeltaDb.toFixed(2)} dB`,
      );
      assert.equal(
        Math.sign(result.outputDeltaDb),
        Math.sign(result.sourceDeltaDb),
        `ordinary ${direction} must retain its source direction`,
      );
    }
  });

  it("cinematic stability: partially supports both quiet flanks of an extreme head-mid-tail body arc", () => {
    const totalFrames = 360;
    const frameDb = new Array<number>(totalFrames).fill(-82);
    const loudnessFrameDb = new Array<number>(totalFrames).fill(-82);
    const speechBodyFrameDb = new Array<number>(totalFrames).fill(-82);
    const speechRuns = [{ startFrame: 30, endFrame: 330 }];
    for (let frame = 30; frame < 330; frame += 1) {
      const levelDb = frame < 120 || frame >= 240 ? -34 : -24;
      frameDb[frame] = levelDb;
      loudnessFrameDb[frame] = levelDb;
      speechBodyFrameDb[frame] = levelDb;
    }

    const frameSnapshot = [...frameDb];
    const loudnessSnapshot = [...loudnessFrameDb];
    const bodySnapshot = [...speechBodyFrameDb];
    const runSnapshot = speechRuns.map((run) => ({ ...run }));
    const plan = planGainCurve({
      frameDb,
      loudnessFrameDb,
      speechBodyFrameDb,
      speechRuns,
      noiseFloorDb: -82,
      speechThresholdDb: -60,
      pauseNoiseRisk: 0.1,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      maxGainDb: 14,
      instabilityHint: 0.9,
    });

    const measureLevelDb = (frame: number) =>
      frameDb[frame] + gainDbAtFrame(plan.gainCurve, frame);
    const sourceHeadToMidDb = frameDb[180] - frameDb[75];
    const sourceTailToMidDb = frameDb[180] - frameDb[285];
    const outputHeadToMidDb = measureLevelDb(180) - measureLevelDb(75);
    const outputTailToMidDb = measureLevelDb(180) - measureLevelDb(285);
    const headRecoveryDb = sourceHeadToMidDb - outputHeadToMidDb;
    const tailRecoveryDb = sourceTailToMidDb - outputTailToMidDb;
    let largestGainStepDb = 0;
    for (let frame = 31; frame < 330; frame += 1) {
      largestGainStepDb = Math.max(
        largestGainStepDb,
        Math.abs(
          gainDbAtFrame(plan.gainCurve, frame) -
            gainDbAtFrame(plan.gainCurve, frame - 1),
        ),
      );
    }

    const arcLedger =
      `head recovery ${headRecoveryDb.toFixed(2)}, tail recovery ${tailRecoveryDb.toFixed(2)}, ` +
      `retained head ${outputHeadToMidDb.toFixed(2)}, retained tail ${outputTailToMidDb.toFixed(2)}, ` +
      `slew ${largestGainStepDb.toFixed(3)} dB`;
    for (const [flank, recoveredDb, retainedDb] of [
      ["head", headRecoveryDb, outputHeadToMidDb],
      ["tail", tailRecoveryDb, outputTailToMidDb],
    ] as const) {
      assert.ok(
        recoveredDb >= 2.5 && recoveredDb <= 4.5,
        `extreme ${flank} arc needs bounded partial support (${arcLedger})`,
      );
      assert.ok(
        retainedDb >= 5.5,
        `head-mid-tail shape must remain clearly expressive on the ${flank} flank (${arcLedger})`,
      );
    }
    assert.ok(
      Math.abs(headRecoveryDb - tailRecoveryDb) <= 1,
      `opposite arc flanks need comparable support (${arcLedger})`,
    );
    assert.ok(
      largestGainStepDb <= 1.71,
      `arc support must not steepen the established planner edge (${arcLedger})`,
    );
    assert.deepEqual(frameDb, frameSnapshot);
    assert.deepEqual(loudnessFrameDb, loudnessSnapshot);
    assert.deepEqual(speechBodyFrameDb, bodySnapshot);
    assert.deepEqual(speechRuns, runSnapshot);
  });

  it("cinematic stability: caps residual word-scale authority when the established plan deepens a valley", () => {
    const totalFrames = 400;
    const frameDb = new Array<number>(totalFrames).fill(-82);
    const speechBodyFrameDb = new Array<number>(totalFrames).fill(-82);
    const establishedGainDb = new Float32Array(totalFrames);
    const speechRuns = [{ startFrame: 50, endFrame: 350 }];
    const unitLevelsDb = [-32, -23, -31, -22, -32, -23];
    for (let unit = 0; unit < unitLevelsDb.length; unit += 1) {
      const startFrame = 50 + unit * 50;
      const endFrame = startFrame + 50;
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        frameDb[frame] = unitLevelsDb[unit];
        speechBodyFrameDb[frame] = unitLevelsDb[unit];
        if (unit % 2 === 0) establishedGainDb[frame] = -6;
      }
    }

    const frameSnapshot = [...frameDb];
    const bodySnapshot = [...speechBodyFrameDb];
    const gainSnapshot = new Float32Array(establishedGainDb);
    const runSnapshot = speechRuns.map((run) => ({ ...run }));
    const stabilizedGainDb = stabilizeRecurrentWordScaleBody(
      establishedGainDb,
      frameDb,
      speechBodyFrameDb,
      speechRuns,
      -82,
      14,
      0.9,
      FRAME_MS,
    );

    let maximumAddedLiftDb = 0;
    let maximumAddedLocalContrastDb = Number.NEGATIVE_INFINITY;
    const addedLiftDb = Array.from(
      stabilizedGainDb,
      (valueDb, frame) => valueDb - establishedGainDb[frame],
    );
    for (let frame = 0; frame < totalFrames; frame += 1) {
      maximumAddedLiftDb = Math.max(
        maximumAddedLiftDb,
        addedLiftDb[frame],
      );
    }
    const shoulderFrames = Math.round(400 / FRAME_MS);
    const coreFrames = Math.round(60 / FRAME_MS);
    for (
      let frame = speechRuns[0].startFrame + shoulderFrames;
      frame + shoulderFrames < speechRuns[0].endFrame;
      frame += 1
    ) {
      const leftShoulder = addedLiftDb.slice(
        frame - shoulderFrames,
        frame - coreFrames,
      );
      const rightShoulder = addedLiftDb.slice(
        frame + coreFrames + 1,
        frame + shoulderFrames + 1,
      );
      const shoulderMeanDb = [...leftShoulder, ...rightShoulder].reduce(
        (sum, valueDb) => sum + valueDb,
        0,
      ) / (leftShoulder.length + rightShoulder.length);
      maximumAddedLocalContrastDb = Math.max(
        maximumAddedLocalContrastDb,
        addedLiftDb[frame] - shoulderMeanDb,
      );
    }
    assert.ok(
      maximumAddedLiftDb <= 3.6 + 1e-6,
      `residual authority must not exceed the documented 3.6 dB tier cap, got ${maximumAddedLiftDb.toFixed(3)} dB`,
    );
    const minimumValleyCenterLiftDb = Math.min(
      ...[75, 175, 275].map((frame) => addedLiftDb[frame]),
    );
    assert.ok(
      minimumValleyCenterLiftDb >= 2.6,
      `local-contrast projection must retain material recurrent recovery, got ${minimumValleyCenterLiftDb.toFixed(3)} dB`,
    );
    assert.ok(
      maximumAddedLocalContrastDb <= 1.43,
      `smooth lift must not create a new local word-body crest, got ${maximumAddedLocalContrastDb.toFixed(3)} dB`,
    );
    assert.deepEqual(frameDb, frameSnapshot);
    assert.deepEqual(speechBodyFrameDb, bodySnapshot);
    assert.deepEqual(establishedGainDb, gainSnapshot);
    assert.deepEqual(speechRuns, runSnapshot);
  });

  it("cinematic stability: narrows recurrent word-scale body deficits while retaining a hot voiced phrase", () => {
    const totalFrames = 500;
    const frameDb = new Array<number>(totalFrames).fill(-82);
    const loudnessFrameDb = new Array<number>(totalFrames).fill(-82);
    const speechBodyFrameDb = new Array<number>(totalFrames).fill(-82);
    const speechRuns = [{ startFrame: 50, endFrame: 450 }];
    const unitLevelsDb = [-32, -23, -31, -22, -32, -14, -30, -23];
    for (let unit = 0; unit < unitLevelsDb.length; unit += 1) {
      const startFrame = 50 + unit * 50;
      const endFrame = startFrame + 50;
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        frameDb[frame] = unitLevelsDb[unit];
        loudnessFrameDb[frame] = unitLevelsDb[unit];
        speechBodyFrameDb[frame] = unitLevelsDb[unit];
      }
    }

    const frameSnapshot = [...frameDb];
    const loudnessSnapshot = [...loudnessFrameDb];
    const bodySnapshot = [...speechBodyFrameDb];
    const runSnapshot = speechRuns.map((run) => ({ ...run }));
    const plan = planGainCurve({
      frameDb,
      loudnessFrameDb,
      speechBodyFrameDb,
      speechRuns,
      noiseFloorDb: -82,
      speechThresholdDb: -60,
      pauseNoiseRisk: 0.1,
      frameMs: FRAME_MS,
      targetDb: -22,
      sourceTargetBlend: 0,
      maxGainDb: 14,
      instabilityHint: 0.9,
    });

    const ordinaryUnitIndexes = [0, 1, 2, 3, 4, 6, 7];
    const sourceOrdinaryDb = ordinaryUnitIndexes.map((unit) => unitLevelsDb[unit]);
    const outputOrdinaryDb = ordinaryUnitIndexes.map((unit) => {
      const centerFrame = 50 + unit * 50 + 25;
      return frameDb[centerFrame] + gainDbAtFrame(plan.gainCurve, centerFrame);
    });
    const sourceOrdinarySpreadDb = Math.max(...sourceOrdinaryDb) - Math.min(...sourceOrdinaryDb);
    const outputOrdinarySpreadDb = Math.max(...outputOrdinaryDb) - Math.min(...outputOrdinaryDb);
    const narrowingDb = sourceOrdinarySpreadDb - outputOrdinarySpreadDb;
    const outputOrdinarySortedDb = [...outputOrdinaryDb].sort((left, right) => left - right);
    const outputOrdinaryMedianDb = outputOrdinarySortedDb[Math.floor(outputOrdinarySortedDb.length / 2)];
    const expressiveCenterFrame = 50 + 5 * 50 + 25;
    const expressiveOutputDb =
      frameDb[expressiveCenterFrame] + gainDbAtFrame(plan.gainCurve, expressiveCenterFrame);
    const retainedExpressiveAdvantageDb = expressiveOutputDb - outputOrdinaryMedianDb;
    const isolatedCorrectionDb = stabilizeRecurrentWordScaleBody(
      new Float32Array(totalFrames),
      frameDb,
      speechBodyFrameDb,
      speechRuns,
      -82,
      14,
      0.9,
      FRAME_MS,
    );
    let largestGainStepDb = 0;
    let largestCorrectionStepDb = 0;
    for (let frame = 50; frame <= 450; frame += 1) {
      largestGainStepDb = Math.max(
        largestGainStepDb,
        Math.abs(
          gainDbAtFrame(plan.gainCurve, frame) -
            gainDbAtFrame(plan.gainCurve, frame - 1),
        ),
      );
      largestCorrectionStepDb = Math.max(
        largestCorrectionStepDb,
        Math.abs(isolatedCorrectionDb[frame] - isolatedCorrectionDb[frame - 1]),
      );
    }

    const wordLedger =
      `source spread ${sourceOrdinarySpreadDb.toFixed(2)}, output spread ${outputOrdinarySpreadDb.toFixed(2)}, ` +
      `narrowing ${narrowingDb.toFixed(2)}, expressive advantage ${retainedExpressiveAdvantageDb.toFixed(2)}, ` +
      `planner slew ${largestGainStepDb.toFixed(3)}, correction slew ${largestCorrectionStepDb.toFixed(3)} dB`;
    assert.ok(
      narrowingDb >= 3.0 && narrowingDb <= 5.5,
      `recurrent 300-1000 ms body deficits need a material but bounded source-adaptive ride (${wordLedger})`,
    );
    assert.ok(
      retainedExpressiveAdvantageDb >= 8,
      `hot voiced expression must remain clearly dominant (${wordLedger})`,
    );
    assert.ok(
      largestCorrectionStepDb <= 0.24 + 1e-6,
      `the added word-scale lift must keep the safer 0.24 dB/10 ms slew contract (${wordLedger})`,
    );
    assert.ok(
      largestGainStepDb <= 0.9,
      `the new tier must not steepen the established planner edge (${wordLedger})`,
    );
    assert.deepEqual(frameDb, frameSnapshot);
    assert.deepEqual(loudnessFrameDb, loudnessSnapshot);
    assert.deepEqual(speechBodyFrameDb, bodySnapshot);
    assert.deepEqual(speechRuns, runSnapshot);
  });

  it("cinematic stability: does not spend phrase-wide trend recovery on a localized terminal fade", () => {
    const totalFrames = 260;
    const frameDb = new Array<number>(totalFrames).fill(-82);
    const loudnessFrameDb = new Array<number>(totalFrames).fill(-82);
    const speechBodyFrameDb = new Array<number>(totalFrames).fill(-82);
    const speechRuns = [{ startFrame: 30, endFrame: 230 }];
    for (let frame = 30; frame < 230; frame += 1) {
      const progress = (frame - 30) / 199;
      const terminalProgress = Math.max(0, (progress - 0.75) / 0.25);
      const levelDb = -20 - 28 * terminalProgress;
      frameDb[frame] = levelDb;
      loudnessFrameDb[frame] = levelDb;
      speechBodyFrameDb[frame] = levelDb;
    }

    const frameSnapshot = [...frameDb];
    const loudnessSnapshot = [...loudnessFrameDb];
    const bodySnapshot = [...speechBodyFrameDb];
    const runSnapshot = speechRuns.map((run) => ({ ...run }));
    const plan = planGainCurve({
      frameDb,
      loudnessFrameDb,
      speechBodyFrameDb,
      speechRuns,
      noiseFloorDb: -82,
      speechThresholdDb: -70,
      pauseNoiseRisk: 0.1,
      frameMs: FRAME_MS,
      targetDb: -60,
      sourceTargetBlend: 0,
      maxGainDb: 14,
      instabilityHint: 0.1,
      levelingConsistency: 0,
    });

    const headFrame = 50;
    const tailFrame = 210;
    const sourceFallDb = frameDb[headFrame] - frameDb[tailFrame];
    const outputHeadDb = frameDb[headFrame] + gainDbAtFrame(plan.gainCurve, headFrame);
    const outputTailDb = frameDb[tailFrame] + gainDbAtFrame(plan.gainCurve, tailFrame);
    const recoveredDb = sourceFallDb - (outputHeadDb - outputTailDb);

    assert.ok(
      recoveredDb <= 1.25,
      `a decay confined to the final quarter is an ending, not a sustained trend; recovered ${recoveredDb.toFixed(2)} dB`,
    );
    assert.ok(
      outputHeadDb - outputTailDb >= sourceFallDb - 1.25,
      `the localized terminal fade must remain source-shaped, got ${(outputHeadDb - outputTailDb).toFixed(2)} of ${sourceFallDb.toFixed(2)} dB`,
    );
    assert.deepEqual(frameDb, frameSnapshot);
    assert.deepEqual(loudnessFrameDb, loudnessSnapshot);
    assert.deepEqual(speechBodyFrameDb, bodySnapshot);
    assert.deepEqual(speechRuns, runSnapshot);
  });

  it("cinematic stability: fills recurrent 80 ms body micro-sags while preserving a sustained quiet passage", () => {
    const buildPlan = (mode: "recurrent-sags" | "intentional-passages") => {
      const totalFrames = 400;
      const frameDb = new Array<number>(totalFrames).fill(-82);
      const loudnessFrameDb = new Array<number>(totalFrames).fill(-82);
      const speechBodyFrameDb = new Array<number>(totalFrames).fill(-82);
      const speechRuns = [{ startFrame: 50, endFrame: 350 }];
      for (let frame = 50; frame < 350; frame += 1) {
        let levelDb = -26;
        if (mode === "recurrent-sags" && (frame - 50) % 24 < 8) levelDb = -36;
        if (mode === "intentional-passages" && frame >= 150 && frame < 190) levelDb = -32;
        if (frame >= 250 && frame < 290) levelDb = -14;
        frameDb[frame] = levelDb;
        loudnessFrameDb[frame] = levelDb;
        speechBodyFrameDb[frame] = levelDb;
      }

      const frameSnapshot = [...frameDb];
      const loudnessSnapshot = [...loudnessFrameDb];
      const bodySnapshot = [...speechBodyFrameDb];
      const runSnapshot = speechRuns.map((run) => ({ ...run }));
      const plan = planGainCurve({
        frameDb,
        loudnessFrameDb,
        speechBodyFrameDb,
        speechRuns,
        noiseFloorDb: -82,
        speechThresholdDb: -60,
        pauseNoiseRisk: 0.1,
        frameMs: FRAME_MS,
        targetDb: -22,
        sourceTargetBlend: 0,
        maxGainDb: 14,
        instabilityHint: 0.8,
      });

      assert.deepEqual(frameDb, frameSnapshot);
      assert.deepEqual(loudnessFrameDb, loudnessSnapshot);
      assert.deepEqual(speechBodyFrameDb, bodySnapshot);
      assert.deepEqual(speechRuns, runSnapshot);
      return { frameDb, plan };
    };
    const percentile = (values: readonly number[], proportion: number) => {
      const sorted = [...values].sort((a, b) => a - b);
      const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.floor(proportion * (sorted.length - 1))),
      );
      return sorted[index];
    };
    const levelsForFrames = (
      frameDb: readonly number[],
      curve: Float32Array,
      frames: readonly number[],
    ) => frames.map((frame) => frameDb[frame] + gainDbAtFrame(curve, frame));

    const recurrent = buildPlan("recurrent-sags");
    const recurrentFrames = Array.from({ length: 300 }, (_, index) => 50 + index);
    const sourceLevels = recurrentFrames.map((frame) => recurrent.frameDb[frame]);
    const outputLevels = levelsForFrames(
      recurrent.frameDb,
      recurrent.plan.gainCurve,
      recurrentFrames,
    );
    const sourceDeficitDb = percentile(sourceLevels, 0.5) - percentile(sourceLevels, 0.2);
    const outputDeficitDb = percentile(outputLevels, 0.5) - percentile(outputLevels, 0.2);
    assert.ok(
      sourceDeficitDb >= 9.5,
      `fixture needs recurrent source-body holes near 10 dB, got ${sourceDeficitDb.toFixed(2)} dB`,
    );
    const sourceExpressiveContrastDb =
      percentile(sourceLevels, 0.9) - percentile(sourceLevels, 0.5);
    const outputExpressiveContrastDb =
      percentile(outputLevels, 0.9) - percentile(outputLevels, 0.5);
    let largestGainStepDb = 0;
    // Measure the recurrent support itself. The source-owned +12 dB event at
    // frame 250 deliberately needs a faster gain-authority handoff and must
    // not be forced to borrow the quiet bed's positive gain.
    for (let frame = 60; frame < 230; frame += 1) {
      largestGainStepDb = Math.max(
        largestGainStepDb,
        Math.abs(
          gainDbAtFrame(recurrent.plan.gainCurve, frame) -
            gainDbAtFrame(recurrent.plan.gainCurve, frame - 1),
        ),
      );
    }
    const control = buildPlan("intentional-passages");
    const sourceQuietContrastDb = control.frameDb[120] - control.frameDb[170];
    const outputQuietContrastDb =
      control.frameDb[120] + gainDbAtFrame(control.plan.gainCurve, 120) -
      (control.frameDb[170] + gainDbAtFrame(control.plan.gainCurve, 170));
    const stabilityLedger =
      `source deficit ${sourceDeficitDb.toFixed(4)}, output deficit ${outputDeficitDb.toFixed(4)}, ` +
      `source expression ${sourceExpressiveContrastDb.toFixed(2)}, output expression ${outputExpressiveContrastDb.toFixed(2)}, ` +
      `slew ${largestGainStepDb.toFixed(3)}, quiet control ${outputQuietContrastDb.toFixed(2)} dB`;
    // With a 16-frame clean gap, the stricter 0.24 dB/frame two-sided slew can
    // supply roughly 2 dB of relative fill without creating a new gain step.
    assert.ok(
      outputDeficitDb >= 7.5 && outputDeficitDb <= 8.2,
      `recurrent 80 ms body holes need bounded fill without hard flattening (${stabilityLedger})`,
    );
    assert.ok(
      outputExpressiveContrastDb >= 9,
      `the intentional expressive passage must remain clearly dominant (${stabilityLedger})`,
    );
    assert.ok(
      sourceExpressiveContrastDb - outputExpressiveContrastDb <= 3,
      `planner may withdraw at most 3 dB of expressive contrast (${stabilityLedger})`,
    );
    assert.ok(
      largestGainStepDb <= 0.24 + 1e-6,
      `micro-sag support must remain a smooth ride (${stabilityLedger})`,
    );
    assert.ok(
      outputQuietContrastDb >= 4.5,
      `intentional 400 ms quiet passage must stay below ordinary body, retained drop ${outputQuietContrastDb.toFixed(2)} dB`,
    );
    assert.ok(
      Math.abs(outputQuietContrastDb - sourceQuietContrastDb) <= 1.5,
      `intentional quiet contrast may change by at most 1.5 dB, source ${sourceQuietContrastDb.toFixed(2)} vs output ${outputQuietContrastDb.toFixed(2)} dB`,
    );
  });

  it("cinematic stability: backs off recurrent lift on body-weak non-verbal reactions", () => {
    const totalFrames = 400;
    const frameDb = new Array<number>(totalFrames).fill(-82);
    const speechBodyFrameDb = new Array<number>(totalFrames).fill(-82);
    const speechRuns = [{ startFrame: 50, endFrame: 350 }];
    for (let unit = 0; unit < 6; unit += 1) {
      const startFrame = 50 + unit * 50;
      const isReaction = unit % 2 === 0;
      for (let frame = startFrame; frame < startFrame + 50; frame += 1) {
        frameDb[frame] = isReaction ? -36 : -23;
        speechBodyFrameDb[frame] = isReaction ? -46 : -23;
      }
    }

    const stabilizedGainDb = stabilizeRecurrentWordScaleBody(
      new Float32Array(totalFrames),
      frameDb,
      speechBodyFrameDb,
      speechRuns,
      -82,
      14,
      0.9,
      FRAME_MS,
    );
    const reactionLiftDb = [75, 175, 275].map((frame) => stabilizedGainDb[frame]);
    const maximumReactionLiftDb = Math.max(...reactionLiftDb);

    assert.ok(
      maximumReactionLiftDb <= 1.7,
      `body-weak sigh/laugh-like reactions must stay below dialogue gain, got ${maximumReactionLiftDb.toFixed(3)} dB`,
    );
  });

  it("cinematic stability: keeps a periodic voiced vocalization prominent, peak-safe, and isolated from dialogue", () => {
    const sampleRate = 16000;
    const frameMs = 10;
    const samplesPerFrame = (sampleRate * frameMs) / 1000;
    const totalFrames = 500;
    const frameDb = new Array<number>(totalFrames).fill(-82);
    const loudnessFrameDb = new Array<number>(totalFrames).fill(-82);
    const speechBodyFrameDb = new Array<number>(totalFrames).fill(-82);
    const fricativeFrameDb = new Array<number>(totalFrames).fill(-82);
    const speechRuns = [
      { startFrame: 20, endFrame: 100 },
      { startFrame: 130, endFrame: 210 },
      { startFrame: 240, endFrame: 320 },
      { startFrame: 380, endFrame: 425 },
    ];
    const samples = new Float32Array(totalFrames * samplesPerFrame);
    const paintVoicedFrame = (frame: number, rmsDb: number, frequencyHz: number) => {
      const amplitude = dbToLin(rmsDb) * Math.SQRT2;
      for (let offset = 0; offset < samplesPerFrame; offset += 1) {
        const sampleIndex = frame * samplesPerFrame + offset;
        samples[sampleIndex] =
          Math.sin((2 * Math.PI * frequencyHz * sampleIndex) / sampleRate) * amplitude;
      }
    };

    for (const run of speechRuns.slice(0, 3)) {
      for (let frame = run.startFrame; frame < run.endFrame; frame += 1) {
        frameDb[frame] = -22.3;
        loudnessFrameDb[frame] = -22.3;
        speechBodyFrameDb[frame] = -23.3;
        fricativeFrameDb[frame] = -34.3;
        paintVoicedFrame(frame, -22.3, 260);
      }
    }
    for (let frame = 380; frame < 425; frame += 1) {
      frameDb[frame] = -18.5;
      loudnessFrameDb[frame] = -18.5;
      speechBodyFrameDb[frame] = -19.5;
      fricativeFrameDb[frame] = -30.5;
      paintVoicedFrame(frame, -18.5, 300);
      if ((frame - 380) % 3 === 0) samples[frame * samplesPerFrame + 80] = dbToLin(-2.5);
    }

    const frameSnapshot = [...frameDb];
    const loudnessSnapshot = [...loudnessFrameDb];
    const bodySnapshot = [...speechBodyFrameDb];
    const fricativeSnapshot = [...fricativeFrameDb];
    const runSnapshot = speechRuns.map((run) => ({ ...run }));
    const sampleSnapshot = new Float32Array(samples);
    const peakCeilingDb = -3;
    const plan = planGainCurve({
      frameDb,
      loudnessFrameDb,
      speechBodyFrameDb,
      fricativeFrameDb,
      fricativeNoiseFloorDb: -82,
      speechRuns,
      noiseFloorDb: -82,
      speechThresholdDb: -55,
      pauseNoiseRisk: 0.1,
      frameMs,
      targetDb: -22,
      sourceTargetBlend: 0,
      samples,
      sampleRate,
      peakCeilingDb,
      instabilityHint: 0.7,
    });

    const eventRun = plan.runs[3];
    assert.equal(eventRun.runClass, "transient-breath");
    const dialogueOutputDb = frameDb[60] + gainDbAtFrame(plan.gainCurve, 60);
    const eventOutputDb = frameDb[400] + gainDbAtFrame(plan.gainCurve, 400);
    const eventAdvantageDb = eventOutputDb - dialogueOutputDb;
    const rendered = applyGainCurveToSamples(
      samples,
      plan.gainCurve,
      sampleRate,
      1,
      frameMs,
    );
    let renderedEventPeak = 0;
    for (let sample = 380 * samplesPerFrame; sample < 425 * samplesPerFrame; sample += 1) {
      renderedEventPeak = Math.max(renderedEventPeak, Math.abs(rendered[sample]));
    }
    const renderedEventPeakDb = 20 * Math.log10(renderedEventPeak + 1e-9);
    const dialogueGainsDb = [60, 170, 280].map((frame) =>
      gainDbAtFrame(plan.gainCurve, frame),
    );
    const eventLedger =
      `advantage ${eventAdvantageDb.toFixed(2)}, peak ${renderedEventPeakDb.toFixed(2)} dBFS, ` +
      `dialogue gains ${dialogueGainsDb.map((value) => value.toFixed(2)).join("/")} dB, ` +
      `event plan ${eventRun.plannedGainDb.toFixed(2)}, body authority ${eventRun.bodyOwnershipAuthority.toFixed(3)}, ` +
      `body recovery ${eventRun.transientBodyRecoveryDb.toFixed(2)} dB`;
    assert.ok(
      eventAdvantageDb >= 1.5 && eventAdvantageDb <= 4.3,
      `periodic voiced ah/ugh/hm event needs a controlled advantage (${eventLedger})`,
    );
    for (const [index, dialogueFrame] of [60, 170, 280].entries()) {
      const dialogueGainDb = dialogueGainsDb[index];
      assert.ok(
        Math.abs(dialogueGainDb) < 0.8,
        `neighboring dialogue at frame ${dialogueFrame} must stay stable, got ${dialogueGainDb.toFixed(2)} dB gain`,
      );
    }
    assert.ok(
      renderedEventPeakDb <= peakCeilingDb + 0.05,
      `voiced-event authority must retain the absolute peak ceiling, got ${renderedEventPeakDb.toFixed(2)} dBFS`,
    );
    assert.deepEqual(frameDb, frameSnapshot);
    assert.deepEqual(loudnessFrameDb, loudnessSnapshot);
    assert.deepEqual(speechBodyFrameDb, bodySnapshot);
    assert.deepEqual(fricativeFrameDb, fricativeSnapshot);
    assert.deepEqual(speechRuns, runSnapshot);
    assert.deepEqual(samples, sampleSnapshot);
  });

  describe("source-adaptive leveling consistency", () => {
    const buildSparseCinematicPlan = (
      levelingConsistency: number | undefined,
      levelNudgeDb = 0,
      instabilityHint = 0.5,
    ) => {
      const totalFrames = 620;
      const frameDb = new Array<number>(totalFrames).fill(-82);
      const loudnessFrameDb = new Array<number>(totalFrames).fill(-82);
      const speechBodyFrameDb = new Array<number>(totalFrames).fill(-82);
      const speechRuns = [
        { startFrame: 20, endFrame: 90 },
        { startFrame: 130, endFrame: 200 },
        { startFrame: 240, endFrame: 310 },
        { startFrame: 350, endFrame: 420 },
        { startFrame: 470, endFrame: 540 },
      ];
      // Keep the cold open representative, then place the cinematic whisper
      // and projected line later so the fixture measures the consistency
      // control rather than the independent cold-open repair policy.
      const runLevelsDb = [-24, -22, -23, -36 + levelNudgeDb, -14];
      for (let runIndex = 0; runIndex < speechRuns.length; runIndex += 1) {
        const run = speechRuns[runIndex];
        const levelDb = runLevelsDb[runIndex];
        for (let frame = run.startFrame; frame < run.endFrame; frame += 1) {
          frameDb[frame] = levelDb;
          loudnessFrameDb[frame] = levelDb;
          speechBodyFrameDb[frame] = levelDb;
        }
      }

      const frameSnapshot = [...frameDb];
      const loudnessSnapshot = [...loudnessFrameDb];
      const bodySnapshot = [...speechBodyFrameDb];
      const runSnapshot = speechRuns.map((run) => ({ ...run }));
      const plan = planGainCurve({
        frameDb,
        loudnessFrameDb,
        speechBodyFrameDb,
        speechRuns,
        noiseFloorDb: -82,
        speechThresholdDb: -55,
        pauseNoiseRisk: 0.1,
        frameMs: FRAME_MS,
        targetDb: -22,
        sourceTargetBlend: 0,
        maxGainDb: 14,
        minGainDb: -14,
        instabilityHint,
        ...(levelingConsistency === undefined ? {} : { levelingConsistency }),
      });

      assert.deepEqual(frameDb, frameSnapshot);
      assert.deepEqual(loudnessFrameDb, loudnessSnapshot);
      assert.deepEqual(speechBodyFrameDb, bodySnapshot);
      assert.deepEqual(speechRuns, runSnapshot);

      const outputLevelsDb = speechRuns.map((run, index) => {
        const centerFrame = Math.floor((run.startFrame + run.endFrame) / 2);
        return runLevelsDb[index] + gainDbAtFrame(plan.gainCurve, centerFrame);
      });
      return {
        plan,
        outputLevelsDb,
        sourceContrastDb: runLevelsDb[4] - runLevelsDb[3],
        outputContrastDb: outputLevelsDb[4] - outputLevelsDb[3],
      };
    };

    it("retains bounded whisper-to-projected line contrast at Balanced-like 0.65", () => {
      const legacy = buildSparseCinematicPlan(1);
      const balanced = buildSparseCinematicPlan(0.65);
      const ledger =
        `source ${balanced.sourceContrastDb.toFixed(3)} dB, ` +
        `consistency=1 ${legacy.outputContrastDb.toFixed(3)} dB, ` +
        `consistency=0.65 ${balanced.outputContrastDb.toFixed(3)} dB`;

      assert.ok(
        balanced.outputContrastDb >= legacy.outputContrastDb + 3,
        `lower consistency should retain meaningfully more actor contrast (${ledger})`,
      );
      assert.ok(
        balanced.outputContrastDb >= 5,
        `the whisper/projected distinction must not be flattened (${ledger})`,
      );
      assert.ok(
        balanced.outputContrastDb <= balanced.sourceContrastDb - 3,
        `Balanced should still reduce excessive source line contrast (${ledger})`,
      );
      assert.ok(
        balanced.outputLevelsDb[3] <= -25,
        `the later quiet-body floor must not undo intentionally retained whisper contrast, got ${balanced.outputLevelsDb[3].toFixed(3)} dB (${ledger})`,
      );
      assert.ok(
        balanced.outputLevelsDb[0] <= legacy.outputLevelsDb[0] - 0.1,
        `the independent cold-open repair must not add back reduced-consistency gain, got full ${legacy.outputLevelsDb[0].toFixed(3)} vs Balanced ${balanced.outputLevelsDb[0].toFixed(3)} dB (${ledger})`,
      );
    });

    it("continuously restores material audibility to extremely quiet body speech", () => {
      const totalFrames = 160;
      const frameDb = new Array<number>(totalFrames).fill(-90);
      const speechRuns = [{ startFrame: 30, endFrame: 130 }];
      for (let frame = 30; frame < 130; frame += 1) frameDb[frame] = -54;
      const frameSnapshot = [...frameDb];
      const runSnapshot = speechRuns.map((run) => ({ ...run }));

      const plan = planGainCurve({
        frameDb,
        loudnessFrameDb: [...frameDb],
        speechBodyFrameDb: [...frameDb],
        speechRuns,
        noiseFloorDb: -90,
        speechThresholdDb: -65,
        pauseNoiseRisk: 0.1,
        targetDb: -22,
        sourceTargetBlend: 0,
        maxGainDb: 14,
        levelingConsistency: 0,
      });
      const centerGainDb = gainDbAtFrame(plan.gainCurve, 80);

      assert.ok(Number.isFinite(centerGainDb), `quiet-body gain must be finite, got ${centerGainDb}`);
      assert.ok(
        centerGainDb >= 11,
        `near-inaudible body speech still needs material recovery at consistency 0, got ${centerGainDb.toFixed(3)} dB`,
      );
      assert.deepEqual(frameDb, frameSnapshot);
      assert.deepEqual(speechRuns, runSnapshot);
    });

    it("continuously returns stronger leveling authority only for severely unstable sources", () => {
      const ordinaryInstability = buildSparseCinematicPlan(0.35, 0, 0.86);
      const severeInstability = buildSparseCinematicPlan(0.35, 0, 0.95);
      const justBelowRecovery = buildSparseCinematicPlan(0.35, 0, 0.8699);
      const justInsideRecovery = buildSparseCinematicPlan(0.35, 0, 0.8701);
      const centerFrame = 385;
      const boundaryDeltaDb = Math.abs(
        gainDbAtFrame(justInsideRecovery.plan.gainCurve, centerFrame) -
          gainDbAtFrame(justBelowRecovery.plan.gainCurve, centerFrame),
      );

      assert.ok(
        severeInstability.outputContrastDb <= ordinaryInstability.outputContrastDb - 1.5,
        `severe instability should recover bounded leveling authority, ordinary ${ordinaryInstability.outputContrastDb.toFixed(3)} vs severe ${severeInstability.outputContrastDb.toFixed(3)} dB`,
      );
      assert.ok(
        severeInstability.outputContrastDb >= 3,
        `even severe instability must retain a clear whisper/projected distinction, got ${severeInstability.outputContrastDb.toFixed(3)} dB`,
      );
      assert.ok(
        boundaryDeltaDb <= 0.01,
        `instability recovery must enter continuously, boundary delta ${boundaryDeltaDb.toFixed(6)} dB`,
      );
    });

    it("preserves already-consistent cinematic line shape while still narrowing a genuinely uneven take", () => {
      const planRunLevels = (runLevelsDb: readonly number[]) => {
        const totalFrames = 620;
        const frameDb = new Array<number>(totalFrames).fill(-82);
        const speechRuns = runLevelsDb.map((_, index) => ({
          startFrame: 20 + index * 110,
          endFrame: 90 + index * 110,
        }));
        for (let index = 0; index < speechRuns.length; index += 1) {
          const run = speechRuns[index];
          for (let frame = run.startFrame; frame < run.endFrame; frame += 1) {
            frameDb[frame] = runLevelsDb[index];
          }
        }
        const plan = planGainCurve({
          frameDb,
          loudnessFrameDb: [...frameDb],
          speechBodyFrameDb: [...frameDb],
          speechRuns,
          noiseFloorDb: -82,
          speechThresholdDb: -55,
          pauseNoiseRisk: 0.1,
          frameMs: FRAME_MS,
          targetDb: -22,
          sourceTargetBlend: 0,
          maxGainDb: 14,
          instabilityHint: 0.86,
          levelingConsistency: 0.35,
        });
        const outputLevelsDb = speechRuns.map((run, index) =>
          runLevelsDb[index] +
          gainDbAtFrame(plan.gainCurve, Math.floor((run.startFrame + run.endFrame) / 2)),
        );
        return {
          sourceSpreadDb: Math.max(...runLevelsDb) - Math.min(...runLevelsDb),
          outputSpreadDb: Math.max(...outputLevelsDb) - Math.min(...outputLevelsDb),
        };
      };

      const alreadyConsistent = planRunLevels([-25.8, -28.9, -26.4, -27.6, -26.2]);
      const genuinelyUneven = planRunLevels([-32, -20, -36, -25, -17]);

      assert.ok(
        alreadyConsistent.outputSpreadDb >= 2.5,
        `an already-consistent 3 dB performance must not be collapsed, got ${alreadyConsistent.outputSpreadDb.toFixed(3)} of ${alreadyConsistent.sourceSpreadDb.toFixed(3)} dB`,
      );
      assert.ok(
        genuinelyUneven.outputSpreadDb <= genuinelyUneven.sourceSpreadDb - 4,
        `a genuinely uneven take still needs material macro narrowing, got ${genuinelyUneven.outputSpreadDb.toFixed(3)} of ${genuinelyUneven.sourceSpreadDb.toFixed(3)} dB`,
      );
    });

    it("keeps consistency=1 value-identical to the legacy omitted option", () => {
      const legacy = buildSparseCinematicPlan(undefined).plan;
      const explicitFull = buildSparseCinematicPlan(1).plan;
      assert.deepEqual(explicitFull, legacy);
    });

    it("responds continuously to tiny consistency and input changes without mutation", () => {
      const base = buildSparseCinematicPlan(0.65);
      const consistencyNudge = buildSparseCinematicPlan(0.6501);
      const nearFull = buildSparseCinematicPlan(0.999999);
      const full = buildSparseCinematicPlan(1);
      const inputNudge = buildSparseCinematicPlan(0.65, 0.001);
      const centerFrame = 385;
      const consistencyDeltaDb = Math.abs(
        gainDbAtFrame(consistencyNudge.plan.gainCurve, centerFrame) -
          gainDbAtFrame(base.plan.gainCurve, centerFrame),
      );
      const inputDeltaDb = Math.abs(
        gainDbAtFrame(inputNudge.plan.gainCurve, centerFrame) -
          gainDbAtFrame(base.plan.gainCurve, centerFrame),
      );
      let fullEndpointDeltaDb = 0;
      for (let frame = 0; frame < full.plan.gainCurve.length; frame += 1) {
        fullEndpointDeltaDb = Math.max(
          fullEndpointDeltaDb,
          Math.abs(
            gainDbAtFrame(nearFull.plan.gainCurve, frame) -
              gainDbAtFrame(full.plan.gainCurve, frame),
          ),
        );
      }

      assert.ok(
        consistencyDeltaDb > 0 && consistencyDeltaDb < 0.01,
        `tiny consistency change must produce a tiny nonzero response, got ${consistencyDeltaDb.toFixed(6)} dB`,
      );
      assert.ok(
        inputDeltaDb > 0 && inputDeltaDb < 0.01,
        `tiny source change must produce a tiny nonzero response, got ${inputDeltaDb.toFixed(6)} dB`,
      );
      assert.ok(
        fullEndpointDeltaDb < 0.01,
        `consistency must approach the value-identical full endpoint continuously, got ${fullEndpointDeltaDb.toFixed(6)} dB`,
      );
    });
  });
});
