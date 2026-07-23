import { applyKWeighting } from "./gainPlanner.ts";

export const PLANNER_DELIVERY_TARGET_OFFSET_DB = 1.35;
export const PLANNER_DELIVERY_MAX_MAKEUP_DB = 10.5;
export const FINAL_TONE_FOUR_KHZ_MAX_TRIM_DB = 0.7;
export const FINAL_TONE_EIGHT_KHZ_MAX_TRIM_DB = 0.9;
export const FINAL_TONE_COMBINED_MAX_TRIM_DB = 1.4;
export const FINAL_TONE_TOP_OCTAVE_MAX_TRIM_DB = 2;
const FINAL_TONE_TOP_OCTAVE_KNEE_DB = 1.65;

export type SourceRelativeFinalTone = Readonly<{
  fourKhzExcessDb: number;
  eightKhzExcessDb: number;
  topOctaveExcessDb: number;
  fourKhzTrimDb: number;
  eightKhzTrimDb: number;
  topOctaveTrimDb: number;
}>;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const finiteNumber = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const resolvePlannerGainFrameRange = ({
  planStartSec,
  durationSec,
  frameMs,
  totalFrames,
}: Readonly<{
  planStartSec: number;
  durationSec: number;
  frameMs: number;
  totalFrames: number;
}>) => {
  if (
    !finiteNumber(planStartSec) ||
    !finiteNumber(durationSec) ||
    !finiteNumber(frameMs) ||
    frameMs <= 0 ||
    !finiteNumber(totalFrames) ||
    totalFrames <= 0 ||
    durationSec <= 0
  ) {
    return { frameStart: 0, frameEnd: 0, frameOffsetFrames: 0 };
  }
  const safeTotalFrames = Math.max(0, Math.floor(totalFrames));
  const startFramePosition = Math.max(
    0,
    (Math.max(0, planStartSec) * 1000) / frameMs,
  );
  if (startFramePosition >= safeTotalFrames) {
    return {
      frameStart: safeTotalFrames,
      frameEnd: safeTotalFrames,
      frameOffsetFrames: 0,
    };
  }
  const owningFrameStart = Math.floor(startFramePosition);
  const frameStart = Math.max(0, owningFrameStart - 1);
  const endFramePosition =
    ((Math.max(0, planStartSec) + durationSec) * 1000) / frameMs;
  return {
    frameStart,
    frameEnd: clamp(
      Math.ceil(endFramePosition - 0.5) + 1,
      0,
      safeTotalFrames,
    ),
    frameOffsetFrames: startFramePosition - frameStart,
  };
};

/**
 * Measure K-weighted energy over speech-selected samples only.
 *
 * The caller supplies the same activity mask already used for speech-gated
 * spectrum analysis, so pauses never dilute the result and no additional
 * decode or alignment pass is needed.
 */
export const computeSpeechKWeightedEnergyDb = (
  samples: Float32Array,
  sampleRate: number,
  activityMask: readonly boolean[],
  activityFrameMs: number,
): number | null => {
  if (
    samples.length === 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(activityFrameMs) ||
    activityFrameMs <= 0 ||
    activityMask.length === 0
  ) {
    return null;
  }

  const weighted = applyKWeighting(samples, sampleRate);
  let sumPower = 0;
  let selectedSampleCount = 0;
  for (let frame = 0; frame < activityMask.length; frame += 1) {
    if (!activityMask[frame]) continue;
    const start = clamp(
      Math.round((frame * sampleRate * activityFrameMs) / 1000),
      0,
      weighted.length,
    );
    const end = clamp(
      Math.round(((frame + 1) * sampleRate * activityFrameMs) / 1000),
      start,
      weighted.length,
    );
    for (let index = start; index < end; index += 1) {
      const value = weighted[index];
      if (!Number.isFinite(value)) return null;
      sumPower += value * value;
      selectedSampleCount += 1;
    }
  }

  if (selectedSampleCount === 0) return null;
  return 10 * Math.log10(sumPower / selectedSampleCount + 1e-30);
};

/**
 * Resolve one file-wide scalar after the planner and primary chain finish.
 *
 * This restores the planner's delivered speech target without changing any
 * within-word or sentence contrast. It is continuous, never attenuates, and
 * fails open when the post-chain speech measurement is unavailable.
 */
export const resolvePlannerDeliveryMakeupDb = ({
  plannerTargetDb,
  speechKWeightedEnergyDb,
}: Readonly<{
  plannerTargetDb: number | null | undefined;
  speechKWeightedEnergyDb: number | null | undefined;
}>): number => {
  if (!finiteNumber(plannerTargetDb) || !finiteNumber(speechKWeightedEnergyDb)) {
    return 0;
  }
  return clamp(
    plannerTargetDb + PLANNER_DELIVERY_TARGET_OFFSET_DB - speechKWeightedEnergyDb,
    0,
    PLANNER_DELIVERY_MAX_MAKEUP_DB,
  );
};

const meanBodyDb = (spectrumDb: readonly number[]) =>
  (spectrumDb[2] + spectrumDb[3] + spectrumDb[4] + spectrumDb[5]) / 4;

const meanNativeBodyDb = (spectrumDb: readonly number[]) =>
  (spectrumDb[0] + spectrumDb[1] + spectrumDb[2] + spectrumDb[3]) / 4;

const normalizedZero = (value: number) => (Math.abs(value) < 1e-12 ? 0 : value);

const hasFiniteNativeFinalToneDomain = (
  spectrumDb: readonly number[] | null | undefined,
): spectrumDb is readonly number[] =>
  Boolean(
    spectrumDb &&
      spectrumDb.length === 7 &&
      spectrumDb.every((value) => Number.isFinite(value)),
  );

/**
 * Reconcile only high-frequency tone that the app added relative to source.
 *
 * The response starts continuously at zero, never brightens, saturates
 * smoothly, and shares a small combined budget across 4 and 8 kHz. Natural
 * actor brightness therefore remains untouched.
 */
export const resolveSourceRelativeFinalTone = (
  sourceSpeechBandSpectrumDb: readonly number[] | null | undefined,
  renderedSpeechBandSpectrumDb: readonly number[] | null | undefined,
  sourceNativeFinalToneSpectrumDb?: readonly number[] | null,
  renderedNativeFinalToneSpectrumDb?: readonly number[] | null,
): SourceRelativeFinalTone | null => {
  if (
    !sourceSpeechBandSpectrumDb ||
    !renderedSpeechBandSpectrumDb ||
    sourceSpeechBandSpectrumDb.length !== 8 ||
    renderedSpeechBandSpectrumDb.length !== 8 ||
    sourceSpeechBandSpectrumDb.some((value) => !Number.isFinite(value)) ||
    renderedSpeechBandSpectrumDb.some((value) => !Number.isFinite(value))
  ) {
    return null;
  }

  const sourceBodyDb = meanBodyDb(sourceSpeechBandSpectrumDb);
  const renderedBodyDb = meanBodyDb(renderedSpeechBandSpectrumDb);
  const fourKhzExcessDb = Math.max(
    0,
    renderedSpeechBandSpectrumDb[6] -
      renderedBodyDb -
      (sourceSpeechBandSpectrumDb[6] - sourceBodyDb),
  );
  const eightKhzExcessDb = Math.max(
    0,
    renderedSpeechBandSpectrumDb[7] -
      renderedBodyDb -
      (sourceSpeechBandSpectrumDb[7] - sourceBodyDb),
  );

  const rawFourKhzTrimDb =
    FINAL_TONE_FOUR_KHZ_MAX_TRIM_DB *
    Math.tanh((0.6 * fourKhzExcessDb) / FINAL_TONE_FOUR_KHZ_MAX_TRIM_DB);
  const rawEightKhzTrimDb =
    FINAL_TONE_EIGHT_KHZ_MAX_TRIM_DB *
    Math.tanh((0.6 * eightKhzExcessDb) / FINAL_TONE_EIGHT_KHZ_MAX_TRIM_DB);
  const combinedTrimDb = rawFourKhzTrimDb + rawEightKhzTrimDb;
  const budgetScale =
    combinedTrimDb > 0
      ? Math.min(1, FINAL_TONE_COMBINED_MAX_TRIM_DB / combinedTrimDb)
      : 1;
  let topOctaveExcessDb = 0;
  let topOctaveTrimDb = 0;
  if (
    hasFiniteNativeFinalToneDomain(sourceNativeFinalToneSpectrumDb) &&
    hasFiniteNativeFinalToneDomain(renderedNativeFinalToneSpectrumDb)
  ) {
    const sourceNativeBodyDb = meanNativeBodyDb(sourceNativeFinalToneSpectrumDb);
    const renderedNativeBodyDb = meanNativeBodyDb(renderedNativeFinalToneSpectrumDb);
    topOctaveExcessDb = Math.max(
      0,
      renderedNativeFinalToneSpectrumDb[6] -
        renderedNativeBodyDb -
        (sourceNativeFinalToneSpectrumDb[6] - sourceNativeBodyDb),
    );
    // A high-order soft knee keeps sub-dB measurement variance effectively
    // untouched while remaining mathematically continuous from zero. The
    // measured 2.8 dB production excess receives ~1.9 dB of static correction.
    const ratio = topOctaveExcessDb / FINAL_TONE_TOP_OCTAVE_KNEE_DB;
    const ratioPower = ratio ** 6;
    topOctaveTrimDb =
      -FINAL_TONE_TOP_OCTAVE_MAX_TRIM_DB *
      (ratioPower / (1 + ratioPower));
  }

  return {
    fourKhzExcessDb: normalizedZero(fourKhzExcessDb),
    eightKhzExcessDb: normalizedZero(eightKhzExcessDb),
    topOctaveExcessDb: normalizedZero(topOctaveExcessDb),
    fourKhzTrimDb: normalizedZero(-rawFourKhzTrimDb * budgetScale),
    eightKhzTrimDb: normalizedZero(-rawEightKhzTrimDb * budgetScale),
    topOctaveTrimDb:
      topOctaveExcessDb > 0
        ? topOctaveTrimDb
        : 0,
  };
};
