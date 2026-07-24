import { applyKWeighting } from "./gainPlanner.ts";

export const PLANNER_DELIVERY_TARGET_OFFSET_DB = 1.35;
export const PLANNER_DELIVERY_MAX_MAKEUP_DB = 10.5;
export const FINAL_TONE_FOUR_KHZ_MAX_TRIM_DB = 0.7;
export const FINAL_TONE_EIGHT_KHZ_MAX_TRIM_DB = 0.9;
export const FINAL_TONE_COMBINED_MAX_TRIM_DB = 1.4;
export const FINAL_TONE_TOP_OCTAVE_MAX_TRIM_DB = 2;
const FINAL_TONE_TOP_OCTAVE_KNEE_DB = 1.65;
export const PLANNER_DELIVERY_SOURCE_RELATIVE_NOISE_BUDGET_DB = 0.85;
export const PLANNER_DELIVERY_CLEAN_FLOOR_DB = -60;
export const PLANNER_DELIVERY_LIMITER_CEILING_DB = -2;
export const PLANNER_DELIVERY_ALLOWED_LIMITER_DRIVE_DB = 1.5;

export type SourceRelativeFinalTone = Readonly<{
  fourKhzExcessDb: number;
  eightKhzExcessDb: number;
  topOctaveExcessDb: number;
  fourKhzTrimDb: number;
  eightKhzTrimDb: number;
  topOctaveTrimDb: number;
}>;

export type PlannerDeliverySafetyEvidence = Readonly<{
  /** Low, persistent nonzero energy; exact digital-zero frames are excluded. */
  nonzeroQuietBedDb: number | null;
  /** Continuous 0..1 confidence that the low-energy mode is a distinct bed. */
  nonzeroQuietBedConfidence: number;
  /** Low-energy mode weighted toward frames in or near the supplied speech mask. */
  nearSpeechFloorDb: number | null;
  /** Continuous 0..1 confidence in the near-speech floor estimate. */
  nearSpeechFloorConfidence: number;
  /**
   * Exact decoded sample peak, or a conservative upper envelope derived from a
   * later bounded linear render. Null denotes a mathematically silent buffer.
   */
  samplePeakDb: number | null;
}>;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const finiteNumber = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

const EMPTY_PLANNER_DELIVERY_SAFETY_EVIDENCE: PlannerDeliverySafetyEvidence =
  Object.freeze({
    nonzeroQuietBedDb: null,
    nonzeroQuietBedConfidence: 0,
    nearSpeechFloorDb: null,
    nearSpeechFloorConfidence: 0,
    samplePeakDb: null,
  });

const percentileOfSorted = (values: readonly number[], fraction: number) => {
  const position = clamp(fraction, 0, 1) * (values.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const mix = position - lower;
  return values[lower] * (1 - mix) + values[upper] * mix;
};

const weightedPercentile = (
  entries: readonly Readonly<{ value: number; weight: number }>[],
  fraction: number,
) => {
  const ordered = [...entries].sort((left, right) => left.value - right.value);
  const totalWeight = ordered.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(totalWeight > 0)) return null;
  const targetWeight = clamp(fraction, 0, 1) * totalWeight;
  let cumulativeWeight = 0;
  for (const entry of ordered) {
    cumulativeWeight += entry.weight;
    if (cumulativeWeight >= targetWeight) return entry.value;
  }
  return ordered.at(-1)?.value ?? null;
};

const resolveActivityDistances = (activityMask: readonly boolean[]) => {
  const distances = new Float64Array(activityMask.length);
  distances.fill(Number.POSITIVE_INFINITY);
  let lastActive = Number.NEGATIVE_INFINITY;
  for (let frame = 0; frame < activityMask.length; frame += 1) {
    if (activityMask[frame]) lastActive = frame;
    distances[frame] = frame - lastActive;
  }
  lastActive = Number.POSITIVE_INFINITY;
  for (let frame = activityMask.length - 1; frame >= 0; frame -= 1) {
    if (activityMask[frame]) lastActive = frame;
    distances[frame] = Math.min(distances[frame], lastActive - frame);
  }
  return distances;
};

type NonzeroDeliveryFrame = Readonly<{
  frame: number;
  energyDb: number;
}>;

const measureDecodedSamplePeak = (samples: Float32Array) => {
  let samplePeak = 0;
  for (const value of samples) {
    if (!Number.isFinite(value)) return null;
    samplePeak = Math.max(samplePeak, Math.abs(value));
  }
  return samplePeak;
};

const measureNonzeroDeliveryFrames = (
  samples: Float32Array,
  sampleRate: number,
  frameMs: number,
  frameCount: number,
) => {
  const frames: NonzeroDeliveryFrame[] = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = Math.round((frame * sampleRate * frameMs) / 1000);
    const end = Math.min(
      samples.length,
      Math.round(((frame + 1) * sampleRate * frameMs) / 1000),
    );
    let sumPower = 0;
    for (let index = start; index < end; index += 1) {
      const value = samples[index];
      if (!Number.isFinite(value)) return null;
      sumPower += value * value;
    }
    if (sumPower > 0 && end > start) {
      frames.push({
        frame,
        energyDb: 10 * Math.log10(sumPower / (end - start)),
      });
    }
  }
  return frames;
};

const resolveQuietBedConfidence = (
  frames: readonly NonzeroDeliveryFrame[],
  quietBedDb: number,
  frameMs: number,
) => {
  const orderedDb = frames.map((frame) => frame.energyDb).sort((a, b) => a - b);
  const contrastDb =
    percentileOfSorted(orderedDb, 0.8) - percentileOfSorted(orderedDb, 0.2);
  const lowerModeSpreadDb =
    percentileOfSorted(orderedDb, 0.35) - percentileOfSorted(orderedDb, 0.1);
  const contrastAuthority = contrastDb ** 2 / (contrastDb ** 2 + 8 ** 2);
  const plateauAuthority = 1 / (1 + (lowerModeSpreadDb / 5) ** 2);
  const observedSeconds = (frames.length * frameMs) / 1000;
  const durationAuthority = 1 - Math.exp(-observedSeconds);
  let quietWeight = 0;
  let adjacentQuietWeight = 0;
  let previousFrame = Number.NEGATIVE_INFINITY;
  let previousWeight = 0;
  for (const frame of frames) {
    const weight = 1 / (1 + Math.exp((frame.energyDb - quietBedDb) / 2));
    quietWeight += weight;
    if (frame.frame === previousFrame + 1) {
      adjacentQuietWeight += Math.min(weight, previousWeight);
    }
    previousFrame = frame.frame;
    previousWeight = weight;
  }
  const persistenceAuthority =
    quietWeight > 0 ? clamp(adjacentQuietWeight / quietWeight, 0, 1) : 0;
  return clamp(
    contrastAuthority *
      plateauAuthority *
      durationAuthority *
      (0.65 + 0.35 * persistenceAuthority),
    0,
    1,
  );
};

/**
 * Measure evidence that can safely bound a later positive, file-wide scalar.
 *
 * Exact digital zero is omitted mathematically rather than assigned an
 * arbitrary floor. All other authority varies continuously with distribution
 * separation, persistence, duration, and proximity to the existing speech
 * mask, including when that mask merges a recorded bed into one long run.
 */
export const measurePlannerDeliverySafetyEvidence = (
  samples: Float32Array,
  sampleRate: number,
  activityMask: readonly boolean[],
  activityFrameMs: number,
): PlannerDeliverySafetyEvidence => {
  if (
    samples.length === 0 ||
    !finiteNumber(sampleRate) ||
    sampleRate <= 0 ||
    !finiteNumber(activityFrameMs) ||
    activityFrameMs <= 0 ||
    activityMask.length === 0
  ) {
    return EMPTY_PLANNER_DELIVERY_SAFETY_EVIDENCE;
  }
  const possibleFrameCount = Math.ceil(
    (samples.length * 1000) / (sampleRate * activityFrameMs),
  );
  const frameCount = Math.min(activityMask.length, possibleFrameCount);
  const samplePeak = measureDecodedSamplePeak(samples);
  const measuredFrames = measureNonzeroDeliveryFrames(
    samples,
    sampleRate,
    activityFrameMs,
    frameCount,
  );
  if (!measuredFrames || measuredFrames.length === 0 || !samplePeak || samplePeak <= 0) {
    return EMPTY_PLANNER_DELIVERY_SAFETY_EVIDENCE;
  }

  const orderedDb = measuredFrames
    .map((frame) => frame.energyDb)
    .sort((left, right) => left - right);
  const nonzeroQuietBedDb = percentileOfSorted(orderedDb, 0.2);
  const nonzeroQuietBedConfidence = resolveQuietBedConfidence(
    measuredFrames,
    nonzeroQuietBedDb,
    activityFrameMs,
  );
  const activityDistances = resolveActivityDistances(activityMask.slice(0, frameCount));
  const nearSpeechEntries = measuredFrames.map((frame) => {
    const quietWeight =
      1 / (1 + Math.exp((frame.energyDb - nonzeroQuietBedDb) / 2));
    const distanceMs = activityDistances[frame.frame] * activityFrameMs;
    const proximityWeight = Number.isFinite(distanceMs)
      ? Math.exp(-distanceMs / 250)
      : 0;
    return {
      value: frame.energyDb,
      weight: quietWeight * proximityWeight,
      quietWeight,
    };
  });
  const totalQuietWeight = nearSpeechEntries.reduce(
    (sum, entry) => sum + entry.quietWeight,
    0,
  );
  const totalNearWeight = nearSpeechEntries.reduce(
    (sum, entry) => sum + entry.weight,
    0,
  );
  const nearSpeechFloorDb = weightedPercentile(nearSpeechEntries, 0.6);
  const proximityAuthority =
    totalQuietWeight > 0 ? clamp(totalNearWeight / totalQuietWeight, 0, 1) : 0;

  return {
    nonzeroQuietBedDb,
    nonzeroQuietBedConfidence,
    nearSpeechFloorDb,
    nearSpeechFloorConfidence:
      nearSpeechFloorDb === null
        ? 0
        : nonzeroQuietBedConfidence * Math.sqrt(proximityAuthority),
    samplePeakDb: 20 * Math.log10(samplePeak),
  };
};

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

type FinitePlannerDeliverySafetyEvidence = Readonly<{
  nonzeroQuietBedDb: number;
  nonzeroQuietBedConfidence: number;
  nearSpeechFloorDb: number;
  nearSpeechFloorConfidence: number;
  samplePeakDb: number;
}>;

const hasFinitePlannerDeliverySafetyEvidence = (
  evidence: PlannerDeliverySafetyEvidence | null | undefined,
): evidence is PlannerDeliverySafetyEvidence & FinitePlannerDeliverySafetyEvidence =>
  Boolean(
    evidence &&
      finiteNumber(evidence.nonzeroQuietBedDb) &&
      finiteNumber(evidence.nonzeroQuietBedConfidence) &&
      finiteNumber(evidence.nearSpeechFloorDb) &&
      finiteNumber(evidence.nearSpeechFloorConfidence) &&
      finiteNumber(evidence.samplePeakDb),
  );

/**
 * Propagate exact mix evidence through the bounded Scene-blend topology without
 * decoding a second full-size WAV.
 *
 * The dry and wet coefficients provide a continuous upper envelope for floor
 * movement. Peak evidence includes a small wet-path transient allowance and is
 * still bounded by the blend limiter. This is intentionally conservative:
 * downstream positive batch gain may be reduced, but cannot be increased by
 * pretending the derived envelope is quieter than the rendered blend.
 */
export const resolveBlendDeliverySafetyEvidence = ({
  inputSafetyEvidence,
  indoorGain,
  outdoorGain,
  limiterCeilingDb = PLANNER_DELIVERY_LIMITER_CEILING_DB,
}: Readonly<{
  inputSafetyEvidence: PlannerDeliverySafetyEvidence | null | undefined;
  indoorGain: number;
  outdoorGain: number;
  limiterCeilingDb?: number;
}>): PlannerDeliverySafetyEvidence | null => {
  if (
    !hasFinitePlannerDeliverySafetyEvidence(inputSafetyEvidence) ||
    !finiteNumber(indoorGain) ||
    !finiteNumber(outdoorGain) ||
    !finiteNumber(limiterCeilingDb)
  ) {
    return null;
  }
  const boundedIndoorGain = clamp(indoorGain, 0, 1);
  const boundedOutdoorGain = clamp(outdoorGain, 0, 1);
  const wetTotal = boundedIndoorGain + boundedOutdoorGain;
  const dryGain = clamp(1 - wetTotal * 0.55, 0.93, 1);
  const maximumLinearSum = Math.max(Number.EPSILON, dryGain + wetTotal);
  const floorEnvelopeGainDb = 20 * Math.log10(maximumLinearSum);
  const wetTransientAllowanceDb = wetTotal * 2;
  const peakEnvelopeDb = Math.min(
    limiterCeilingDb,
    inputSafetyEvidence.samplePeakDb +
      floorEnvelopeGainDb +
      wetTransientAllowanceDb,
  );

  return Object.freeze({
    nonzeroQuietBedDb:
      inputSafetyEvidence.nonzeroQuietBedDb + floorEnvelopeGainDb,
    nonzeroQuietBedConfidence:
      inputSafetyEvidence.nonzeroQuietBedConfidence,
    nearSpeechFloorDb:
      inputSafetyEvidence.nearSpeechFloorDb + floorEnvelopeGainDb,
    nearSpeechFloorConfidence:
      inputSafetyEvidence.nearSpeechFloorConfidence,
    samplePeakDb: peakEnvelopeDb,
  });
};

const resolveNoiseLaneGainDb = ({
  requestedGainDb,
  sourceFloorDb,
  sourceConfidence,
  renderedFloorDb,
  renderedConfidence,
}: Readonly<{
  requestedGainDb: number;
  sourceFloorDb: number;
  sourceConfidence: number;
  renderedFloorDb: number;
  renderedConfidence: number;
}>) => {
  const allowedFloorDb = Math.max(
    PLANNER_DELIVERY_CLEAN_FLOOR_DB,
    sourceFloorDb + PLANNER_DELIVERY_SOURCE_RELATIVE_NOISE_BUDGET_DB,
  );
  const measuredHeadroomDb = Math.max(0, allowedFloorDb - renderedFloorDb);
  const measuredLimitDb = Math.min(requestedGainDb, measuredHeadroomDb);
  const pairedConfidence = Math.sqrt(
    clamp(sourceConfidence, 0, 1) * clamp(renderedConfidence, 0, 1),
  );
  return requestedGainDb +
    pairedConfidence * (measuredLimitDb - requestedGainDb);
};

/**
 * Bound positive static delivery gain with exact source-relative noise and
 * rendered-peak evidence. This is a gain authority, never an output gate.
 *
 * Low-confidence floor classifications interpolate continuously back toward
 * the requested scalar; high-confidence floors spend only the clean-floor or
 * denoise-earned source-relative headroom. The peak lane independently limits
 * how far the final limiter may be driven.
 */
export const resolveSafePositiveDeliveryGainDb = ({
  requestedGainDb,
  sourceSafetyEvidence,
  renderedSafetyEvidence,
  limiterCeilingDb = PLANNER_DELIVERY_LIMITER_CEILING_DB,
  allowedLimiterDriveDb = PLANNER_DELIVERY_ALLOWED_LIMITER_DRIVE_DB,
}: Readonly<{
  requestedGainDb: number;
  sourceSafetyEvidence: PlannerDeliverySafetyEvidence | null | undefined;
  renderedSafetyEvidence: PlannerDeliverySafetyEvidence | null | undefined;
  limiterCeilingDb?: number;
  allowedLimiterDriveDb?: number;
}>): number => {
  if (
    !finiteNumber(requestedGainDb) ||
    !hasFinitePlannerDeliverySafetyEvidence(sourceSafetyEvidence) ||
    !hasFinitePlannerDeliverySafetyEvidence(renderedSafetyEvidence) ||
    !finiteNumber(limiterCeilingDb) ||
    !finiteNumber(allowedLimiterDriveDb) ||
    allowedLimiterDriveDb < 0
  ) {
    return 0;
  }
  const requestedPositiveGainDb = Math.max(0, requestedGainDb);
  const quietBedLimitedGainDb = resolveNoiseLaneGainDb({
    requestedGainDb: requestedPositiveGainDb,
    sourceFloorDb: sourceSafetyEvidence.nonzeroQuietBedDb,
    sourceConfidence: sourceSafetyEvidence.nonzeroQuietBedConfidence,
    renderedFloorDb: renderedSafetyEvidence.nonzeroQuietBedDb,
    renderedConfidence: renderedSafetyEvidence.nonzeroQuietBedConfidence,
  });
  const nearSpeechLimitedGainDb = resolveNoiseLaneGainDb({
    requestedGainDb: requestedPositiveGainDb,
    sourceFloorDb: sourceSafetyEvidence.nearSpeechFloorDb,
    sourceConfidence: sourceSafetyEvidence.nearSpeechFloorConfidence,
    renderedFloorDb: renderedSafetyEvidence.nearSpeechFloorDb,
    renderedConfidence: renderedSafetyEvidence.nearSpeechFloorConfidence,
  });
  const limiterHeadroomDb = Math.max(
    0,
    limiterCeilingDb +
      allowedLimiterDriveDb -
      renderedSafetyEvidence.samplePeakDb,
  );
  return Math.min(
    requestedPositiveGainDb,
    quietBedLimitedGainDb,
    nearSpeechLimitedGainDb,
    limiterHeadroomDb,
  );
};

/**
 * Evidence-aware form of planner makeup. The legacy two-measurement resolver
 * remains available to existing callers, while this path never converts absent
 * optional safety evidence into the legacy +10.5 dB authority.
 */
export const resolveEvidenceAwarePlannerDeliveryMakeupDb = ({
  plannerTargetDb,
  speechKWeightedEnergyDb,
  sourceSafetyEvidence,
  renderedSafetyEvidence,
  limiterCeilingDb = PLANNER_DELIVERY_LIMITER_CEILING_DB,
  allowedLimiterDriveDb = PLANNER_DELIVERY_ALLOWED_LIMITER_DRIVE_DB,
}: Readonly<{
  plannerTargetDb: number | null | undefined;
  speechKWeightedEnergyDb: number | null | undefined;
  sourceSafetyEvidence: PlannerDeliverySafetyEvidence | null | undefined;
  renderedSafetyEvidence: PlannerDeliverySafetyEvidence | null | undefined;
  limiterCeilingDb?: number;
  allowedLimiterDriveDb?: number;
}>): number =>
  resolveSafePositiveDeliveryGainDb({
    requestedGainDb: resolvePlannerDeliveryMakeupDb({
      plannerTargetDb,
      speechKWeightedEnergyDb,
    }),
    sourceSafetyEvidence,
    renderedSafetyEvidence,
    limiterCeilingDb,
    allowedLimiterDriveDb,
  });

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
