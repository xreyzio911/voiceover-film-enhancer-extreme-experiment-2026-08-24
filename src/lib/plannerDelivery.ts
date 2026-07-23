import { applyKWeighting } from "./gainPlanner.ts";

export const PLANNER_DELIVERY_TARGET_OFFSET_DB = 1.35;
export const PLANNER_DELIVERY_MAX_MAKEUP_DB = 10.5;
export const FINAL_TONE_FOUR_KHZ_MAX_TRIM_DB = 0.7;
export const FINAL_TONE_EIGHT_KHZ_MAX_TRIM_DB = 0.9;
export const FINAL_TONE_COMBINED_MAX_TRIM_DB = 1.4;

export type SourceRelativeFinalTone = Readonly<{
  fourKhzExcessDb: number;
  eightKhzExcessDb: number;
  fourKhzTrimDb: number;
  eightKhzTrimDb: number;
}>;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const finiteNumber = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

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

const normalizedZero = (value: number) => (Math.abs(value) < 1e-12 ? 0 : value);

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

  return {
    fourKhzExcessDb: normalizedZero(fourKhzExcessDb),
    eightKhzExcessDb: normalizedZero(eightKhzExcessDb),
    fourKhzTrimDb: normalizedZero(-rawFourKhzTrimDb * budgetScale),
    eightKhzTrimDb: normalizedZero(-rawEightKhzTrimDb * budgetScale),
  };
};
