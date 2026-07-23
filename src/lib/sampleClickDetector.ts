const CLICK_EDGE_ABSOLUTE_FLOOR = 0.012;
const CLICK_LOCAL_RMS_MULTIPLIER = 1.35;
const CLICK_LOCAL_SHARPNESS_MULTIPLIER = 5.5;
const CLICK_SURROUNDING_ISOLATION_RATIO = 2.8;
const CLICK_LONG_PULSE_EXTRA_ISOLATION_RATIO = 1.2;
const CLICK_SINGLE_EDGE_ISOLATION_RATIO = 4;
const CLICK_SINGLE_EDGE_CORE_MS = 0.3;
const CLICK_SINGLE_EDGE_LOCAL_CONTEXT_MS = 0.75;
const CLICK_SINGLE_EDGE_CONTEXT_MS = 30;
const CLICK_SINGLE_EDGE_RECURRENCE_RATIO = 0.75;
const CLICK_PERSISTENT_OFFSET_CONTEXT_MS = 30;
const CLICK_PERSISTENT_OFFSET_RATIO = 0.35;
const CLICK_PHASE_SEAM_MIN_FUNDAMENTAL_HZ = 50;
const CLICK_PHASE_SEAM_MAX_FUNDAMENTAL_HZ = 350;
const CLICK_PHASE_SEAM_PERIOD_SAMPLES = 24;
const CLICK_PHASE_SEAM_MIN_SIDE_ENERGY_RATIO = 0.2;
const CLICK_PHASE_SEAM_MAX_SIDE_ERROR = 0.22;
const CLICK_PHASE_SEAM_MIN_CROSS_ERROR = 0.75;
const CLICK_PHASE_SEAM_MIN_ERROR_RATIO = 8;
const CLICK_PHASE_SEAM_MIN_CONCENTRATION = 0.7;
const CLICK_PHASE_SEAM_MIN_CURVATURE_RATIO = 0.8;

export type SampleClickDetectorState = Readonly<{
  lastDiscontinuityGlobalIndex: number;
}>;

export type AdaptiveSampleClickRangeOptions = Readonly<{
  /** Loaded mono samples. The buffer may include context outside the core. */
  samples: Float32Array;
  sampleRate: number;
  frameSize: number;
  /** Whole-file 10 ms frame measurements, not measurements local to this window. */
  frameRms: ArrayLike<number>;
  /** Whole-file sharpness measurements in dB, aligned with `frameRms`. */
  frameSharpness: ArrayLike<number>;
  /** Whole-file sample index represented by `samples[0]`. */
  globalSampleOffset?: number;
  /** Inclusive local start of the non-overlapping core. */
  coreStartSample?: number;
  /** Exclusive local end of the non-overlapping core. */
  coreEndSample?: number;
  /** State returned by the immediately preceding core. */
  priorState?: SampleClickDetectorState | null;
}>;

export type AdaptiveSampleClickDetectionResult = Readonly<{
  count: number;
  state: SampleClickDetectorState;
}>;

export type AdaptiveSampleClickBoundedOptions = Readonly<{
  totalSamples: number;
  sampleRate: number;
  frameSize: number;
  frameRms: ArrayLike<number>;
  frameSharpness: ArrayLike<number>;
  /** Non-overlapping core size. Frame-aligned sizes avoid redundant decoder work. */
  alignedCoreSamples: number;
  /** Loads the exact half-open whole-file sample range `[startSample, endSample)`. */
  loadSamples: (
    startSample: number,
    endSample: number,
  ) => Float32Array | Promise<Float32Array>;
}>;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const samplesForMilliseconds = (sampleRate: number, milliseconds: number) =>
  Math.round((sampleRate * milliseconds) / 1000);

const resolveDetectorDimensions = (sampleRate: number) => {
  const refractorySamples = Math.max(1, samplesForMilliseconds(sampleRate, 4));
  const maxImpulseWidth = Math.max(1, samplesForMilliseconds(sampleRate, 4));
  const isolationRadiusSamples = Math.max(
    maxImpulseWidth + 3,
    samplesForMilliseconds(sampleRate, 2),
  );
  const singleEdgeExcludedCoreSamples = Math.max(
    2,
    samplesForMilliseconds(sampleRate, CLICK_SINGLE_EDGE_CORE_MS),
  );
  const singleEdgeIsolationRadiusSamples = Math.max(
    singleEdgeExcludedCoreSamples + 1,
    samplesForMilliseconds(sampleRate, CLICK_SINGLE_EDGE_LOCAL_CONTEXT_MS),
  );
  const singleEdgeContextSamples = Math.max(
    singleEdgeIsolationRadiusSamples,
    samplesForMilliseconds(sampleRate, CLICK_SINGLE_EDGE_CONTEXT_MS),
  );
  const persistentOffsetContextSamples = Math.max(
    1,
    samplesForMilliseconds(sampleRate, CLICK_PERSISTENT_OFFSET_CONTEXT_MS),
  );
  const phaseSeamMaximumLag = Math.max(
    Math.max(2, Math.round(sampleRate / CLICK_PHASE_SEAM_MAX_FUNDAMENTAL_HZ)),
    Math.round(sampleRate / CLICK_PHASE_SEAM_MIN_FUNDAMENTAL_HZ),
  );

  return {
    refractorySamples,
    maxImpulseWidth,
    isolationRadiusSamples,
    singleEdgeExcludedCoreSamples,
    singleEdgeIsolationRadiusSamples,
    singleEdgeContextSamples,
    persistentOffsetContextSamples,
    phaseSeamMaximumLag,
  };
};

/**
 * Context required to make a bounded core exactly equivalent to a full-buffer
 * scan. The extra sample preserves the full detector's conservative right-edge
 * availability check for periodic phase evidence.
 */
export const resolveAdaptiveSampleClickContextSamples = (sampleRate: number) => {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  const dimensions = resolveDetectorDimensions(sampleRate);
  return Math.max(
    dimensions.phaseSeamMaximumLag * 2 + 1,
    dimensions.singleEdgeContextSamples,
    dimensions.singleEdgeExcludedCoreSamples + dimensions.persistentOffsetContextSamples,
    dimensions.maxImpulseWidth + dimensions.isolationRadiusSamples + 1,
  );
};

const adjacentFrameMax = (values: ArrayLike<number>, frame: number) =>
  Math.max(
    values[Math.max(0, frame - 1)] ?? 0,
    values[frame] ?? 0,
    values[Math.min(values.length - 1, frame + 1)] ?? 0,
  );

const hasIsolatedDiscontinuityReturn = (
  samples: Float32Array,
  index: number,
  entryDelta: number,
  adaptiveEdgeFloor: number,
  localRms: number,
  maxImpulseWidth: number,
  isolationRadiusSamples: number,
) => {
  const finalReturnIndex = Math.min(samples.length - 1, index + maxImpulseWidth);
  for (let returnIndex = index + 1; returnIndex <= finalReturnIndex; returnIndex += 1) {
    const exitDelta = (samples[returnIndex] ?? 0) - (samples[returnIndex - 1] ?? 0);
    if (entryDelta * exitDelta >= 0 || Math.abs(exitDelta) < adaptiveEdgeFloor) continue;

    const edgeStrength = Math.min(Math.abs(entryDelta), Math.abs(exitDelta));
    const recoveredDistance = Math.abs((samples[returnIndex] ?? 0) - (samples[index - 1] ?? 0));
    if (recoveredDistance > edgeStrength * 0.45 + localRms * 0.2) continue;

    let surroundingDeltaPeak = 0;
    const neighborhoodStart = Math.max(1, index - isolationRadiusSamples);
    const neighborhoodEnd = Math.min(samples.length - 1, returnIndex + isolationRadiusSamples);
    for (let cursor = neighborhoodStart; cursor <= neighborhoodEnd; cursor += 1) {
      if (cursor >= index - 2 && cursor <= returnIndex + 2) continue;
      surroundingDeltaPeak = Math.max(
        surroundingDeltaPeak,
        Math.abs((samples[cursor] ?? 0) - (samples[cursor - 1] ?? 0)),
      );
    }
    const pulseWidthRatio = (returnIndex - index) / Math.max(maxImpulseWidth, 1);
    const requiredIsolationRatio =
      CLICK_SURROUNDING_ISOLATION_RATIO +
      pulseWidthRatio * CLICK_LONG_PULSE_EXTRA_ISOLATION_RATIO;
    if (edgeStrength >= surroundingDeltaPeak * requiredIsolationRatio) return true;
  }

  return false;
};

const hasConcentratedSampleSeamEvidence = (
  samples: Float32Array,
  index: number,
  entryDelta: number,
) => {
  if (index < 2 || index + 3 >= samples.length) return false;
  const entryStrength = Math.abs(entryDelta);
  if (entryStrength <= 0) return false;

  let threeSampleChangePeak = 0;
  for (let start = index - 2; start <= index; start += 1) {
    threeSampleChangePeak = Math.max(
      threeSampleChangePeak,
      Math.abs((samples[start + 3] ?? 0) - (samples[start] ?? 0)),
    );
  }
  const concentration = entryStrength / Math.max(threeSampleChangePeak, 1e-9);
  if (concentration < CLICK_PHASE_SEAM_MIN_CONCENTRATION) return false;

  const leftDelta = (samples[index - 1] ?? 0) - (samples[index - 2] ?? 0);
  const rightDelta = (samples[index + 1] ?? 0) - (samples[index] ?? 0);
  const curvatureRatio =
    Math.min(Math.abs(entryDelta - leftDelta), Math.abs(rightDelta - entryDelta)) /
    entryStrength;
  return curvatureRatio >= CLICK_PHASE_SEAM_MIN_CURVATURE_RATIO;
};

const hasPeriodicPhaseSeamEvidence = (
  samples: Float32Array,
  index: number,
  sampleRate: number,
) => {
  const minLag = Math.max(2, Math.round(sampleRate / CLICK_PHASE_SEAM_MAX_FUNDAMENTAL_HZ));
  const maxLag = Math.max(minLag, Math.round(sampleRate / CLICK_PHASE_SEAM_MIN_FUNDAMENTAL_HZ));
  if (index < maxLag * 2 || index + maxLag * 2 >= samples.length) return false;

  const lagStep = Math.max(1, Math.round(sampleRate / 4000));
  let bestSideError = Number.POSITIVE_INFINITY;
  let bestLeftError = Number.POSITIVE_INFINITY;
  let bestRightError = Number.POSITIVE_INFINITY;
  let bestCrossError = 0;

  const gainInvariantError = (
    dotProduct: number,
    firstPower: number,
    secondPower: number,
  ) => {
    const correlation = clamp(
      dotProduct / Math.sqrt(Math.max(firstPower * secondPower, 1e-18)),
      0,
      1,
    );
    return 1 - correlation * correlation;
  };

  for (let lag = minLag; lag <= maxLag; lag += lagStep) {
    const sampleStep = Math.max(1, Math.floor(lag / CLICK_PHASE_SEAM_PERIOD_SAMPLES));
    let leftDotProduct = 0;
    let rightDotProduct = 0;
    let crossDotProduct = 0;
    let leftEarlierPower = 0;
    let leftLaterPower = 0;
    let rightEarlierPower = 0;
    let rightLaterPower = 0;
    let count = 0;

    for (let offset = 0; offset < lag; offset += sampleStep) {
      const leftEarlier = samples[index - lag * 2 + offset] ?? 0;
      const leftLater = samples[index - lag + offset] ?? 0;
      const rightEarlier = samples[index + offset] ?? 0;
      const rightLater = samples[index + lag + offset] ?? 0;
      leftDotProduct += leftEarlier * leftLater;
      rightDotProduct += rightEarlier * rightLater;
      crossDotProduct += leftLater * rightEarlier;
      leftEarlierPower += leftEarlier ** 2;
      leftLaterPower += leftLater ** 2;
      rightEarlierPower += rightEarlier ** 2;
      rightLaterPower += rightLater ** 2;
      count += 1;
    }

    const normalizedLeftPower = (leftEarlierPower + leftLaterPower) / Math.max(count * 2, 1);
    const normalizedRightPower =
      (rightEarlierPower + rightLaterPower) / Math.max(count * 2, 1);
    const sideEnergyRatio =
      Math.min(normalizedLeftPower, normalizedRightPower) /
      Math.max(normalizedLeftPower, normalizedRightPower, 1e-9);
    if (sideEnergyRatio < CLICK_PHASE_SEAM_MIN_SIDE_ENERGY_RATIO) continue;

    const normalizedLeftError = gainInvariantError(
      leftDotProduct,
      leftEarlierPower,
      leftLaterPower,
    );
    const normalizedRightError = gainInvariantError(
      rightDotProduct,
      rightEarlierPower,
      rightLaterPower,
    );
    const normalizedSideError = (normalizedLeftError + normalizedRightError) / 2;
    if (normalizedSideError >= bestSideError) continue;

    bestSideError = normalizedSideError;
    bestLeftError = normalizedLeftError;
    bestRightError = normalizedRightError;
    bestCrossError = gainInvariantError(crossDotProduct, leftLaterPower, rightEarlierPower);
  }

  return (
    bestLeftError <= CLICK_PHASE_SEAM_MAX_SIDE_ERROR &&
    bestRightError <= CLICK_PHASE_SEAM_MAX_SIDE_ERROR &&
    bestCrossError >= CLICK_PHASE_SEAM_MIN_CROSS_ERROR &&
    bestCrossError /
      Math.max(bestSideError, 1 / (CLICK_PHASE_SEAM_MIN_ERROR_RATIO * 1000)) >=
      CLICK_PHASE_SEAM_MIN_ERROR_RATIO
  );
};

const hasIsolatedSingleEdgeDiscontinuity = (
  samples: Float32Array,
  index: number,
  entryDelta: number,
  localSharpRms: number,
  sampleRate: number,
  excludedCoreSamples: number,
  isolationRadiusSamples: number,
  recurrenceContextSamples: number,
  persistentOffsetContextSamples: number,
) => {
  const entryStrength = Math.abs(entryDelta);
  const preliminaryFloor = Math.max(
    CLICK_EDGE_ABSOLUTE_FLOOR,
    localSharpRms * CLICK_LOCAL_SHARPNESS_MULTIPLIER,
  );
  if (entryStrength < preliminaryFloor) return false;

  let nearbyDeltaPeak = 0;
  const neighborhoodStart = Math.max(1, index - isolationRadiusSamples);
  const neighborhoodEnd = Math.min(samples.length - 1, index + isolationRadiusSamples);
  for (let cursor = neighborhoodStart; cursor <= neighborhoodEnd; cursor += 1) {
    if (cursor >= index - excludedCoreSamples && cursor <= index + excludedCoreSamples) {
      continue;
    }
    const candidateStrength = Math.abs(
      (samples[cursor] ?? 0) - (samples[cursor - 1] ?? 0),
    );
    if (candidateStrength > nearbyDeltaPeak) nearbyDeltaPeak = candidateStrength;
  }

  const hasStrictLocalIsolation =
    entryStrength >= nearbyDeltaPeak * CLICK_SINGLE_EDGE_ISOLATION_RATIO;
  const hasConcentratedSampleSeam = hasConcentratedSampleSeamEvidence(
    samples,
    index,
    entryDelta,
  );
  let hasPersistentOffsetEvidence = false;
  const beforeStart = index - excludedCoreSamples - persistentOffsetContextSamples;
  const afterStart = index + excludedCoreSamples;
  const afterEnd = index + excludedCoreSamples + persistentOffsetContextSamples;
  if (!hasStrictLocalIsolation && beforeStart >= 0 && afterEnd <= samples.length) {
    let beforeSum = 0;
    let afterSum = 0;
    for (let cursor = 0; cursor < persistentOffsetContextSamples; cursor += 1) {
      beforeSum += samples[beforeStart + cursor] ?? 0;
      afterSum += samples[afterStart + cursor] ?? 0;
    }
    const persistentOffset = Math.abs(
      afterSum / persistentOffsetContextSamples -
        beforeSum / persistentOffsetContextSamples,
    );
    hasPersistentOffsetEvidence =
      persistentOffset >=
      Math.max(CLICK_EDGE_ABSOLUTE_FLOOR, entryStrength * CLICK_PERSISTENT_OFFSET_RATIO);
  }

  if (!hasStrictLocalIsolation && !hasPersistentOffsetEvidence) {
    return (
      hasConcentratedSampleSeam &&
      hasPeriodicPhaseSeamEvidence(samples, index, sampleRate)
    );
  }

  const recurrenceStart = Math.max(1, index - recurrenceContextSamples);
  const recurrenceEnd = Math.min(samples.length - 1, index + recurrenceContextSamples);
  const recurrenceFloor = entryStrength * CLICK_SINGLE_EDGE_RECURRENCE_RATIO;
  let comparableRecurrenceCount = 0;
  for (let cursor = recurrenceStart; cursor <= recurrenceEnd; cursor += 1) {
    if (cursor >= index - isolationRadiusSamples && cursor <= index + isolationRadiusSamples) {
      continue;
    }
    const candidateDelta = (samples[cursor] ?? 0) - (samples[cursor - 1] ?? 0);
    const candidateStrength = Math.abs(candidateDelta);
    if (candidateStrength < recurrenceFloor) continue;
    if (entryDelta * candidateDelta > 0) {
      return (
        hasConcentratedSampleSeam &&
        hasPeriodicPhaseSeamEvidence(samples, index, sampleRate)
      );
    }
    comparableRecurrenceCount += 1;
    if (comparableRecurrenceCount >= 2) {
      return (
        hasConcentratedSampleSeam &&
        hasPeriodicPhaseSeamEvidence(samples, index, sampleRate)
      );
    }
  }

  return true;
};

const initialState = (sampleRate: number): SampleClickDetectorState => ({
  lastDiscontinuityGlobalIndex: -resolveDetectorDimensions(sampleRate).refractorySamples,
});

const sharpnessLinearAt = (values: ArrayLike<number>, index: number) => {
  if (index < 0 || index >= values.length) return 0;
  return Math.pow(10, (values[index] ?? 0) / 20);
};

/**
 * Counts adaptive sample discontinuities in a half-open local core while using
 * surrounding samples as read-only evidence. Returned state must be passed to
 * the next monotonically increasing core to preserve global refractory parity.
 */
export const countAdaptiveSampleClickDiscontinuities = (
  options: AdaptiveSampleClickRangeOptions,
): AdaptiveSampleClickDetectionResult => {
  const {
    samples,
    sampleRate,
    frameSize,
    frameRms,
    frameSharpness,
    priorState = null,
  } = options;
  if (
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(frameSize) ||
    frameSize <= 0 ||
    samples.length < 3 ||
    frameRms.length === 0
  ) {
    return {
      count: 0,
      state: priorState ?? { lastDiscontinuityGlobalIndex: Number.NEGATIVE_INFINITY },
    };
  }
  const dimensions = resolveDetectorDimensions(sampleRate);
  const fallbackState = priorState ?? initialState(sampleRate);

  const globalSampleOffset = Math.trunc(options.globalSampleOffset ?? 0);
  const requestedCoreStart = Math.trunc(options.coreStartSample ?? 0);
  const requestedCoreEnd = Math.trunc(options.coreEndSample ?? samples.length);
  const coreStartSample = clamp(requestedCoreStart, 0, samples.length);
  const coreEndSample = clamp(requestedCoreEnd, coreStartSample, samples.length);
  const scanStart = Math.max(1, coreStartSample);
  const scanEnd = Math.min(samples.length - 1, coreEndSample);
  let lastDiscontinuityGlobalIndex = fallbackState.lastDiscontinuityGlobalIndex;
  let count = 0;

  for (let index = scanStart; index < scanEnd; index += 1) {
    const globalIndex = globalSampleOffset + index;
    if (globalIndex - lastDiscontinuityGlobalIndex < dimensions.refractorySamples) continue;
    const frame = Math.min(frameRms.length - 1, Math.floor(globalIndex / frameSize));
    const localRms = adjacentFrameMax(frameRms, frame);
    const localSharpRms = Math.max(
      sharpnessLinearAt(frameSharpness, Math.max(0, frame - 1)),
      sharpnessLinearAt(frameSharpness, frame),
      sharpnessLinearAt(frameSharpness, Math.min(frameSharpness.length - 1, frame + 1)),
    );
    const pulseEdgeFloor = Math.max(
      CLICK_EDGE_ABSOLUTE_FLOOR,
      localRms * CLICK_LOCAL_RMS_MULTIPLIER,
      localSharpRms * CLICK_LOCAL_SHARPNESS_MULTIPLIER,
    );
    const entryDelta = (samples[index] ?? 0) - (samples[index - 1] ?? 0);
    const isolatedPulse =
      Math.abs(entryDelta) >= pulseEdgeFloor &&
      hasIsolatedDiscontinuityReturn(
        samples,
        index,
        entryDelta,
        pulseEdgeFloor,
        localRms,
        dimensions.maxImpulseWidth,
        dimensions.isolationRadiusSamples,
      );
    const isolatedSingleEdge = hasIsolatedSingleEdgeDiscontinuity(
      samples,
      index,
      entryDelta,
      localSharpRms,
      sampleRate,
      dimensions.singleEdgeExcludedCoreSamples,
      dimensions.singleEdgeIsolationRadiusSamples,
      dimensions.singleEdgeContextSamples,
      dimensions.persistentOffsetContextSamples,
    );
    if (!isolatedPulse && !isolatedSingleEdge) continue;

    count += 1;
    lastDiscontinuityGlobalIndex = globalIndex;
  }

  return {
    count,
    state: { lastDiscontinuityGlobalIndex },
  };
};

/** Counts a full source using bounded overlapping reads with exact core parity. */
export const countAdaptiveSampleClickDiscontinuitiesBounded = async (
  options: AdaptiveSampleClickBoundedOptions,
): Promise<AdaptiveSampleClickDetectionResult> => {
  const totalSamples = Math.trunc(options.totalSamples);
  const alignedCoreSamples = Math.trunc(options.alignedCoreSamples);
  if (!Number.isFinite(options.totalSamples) || totalSamples < 0) {
    throw new RangeError("totalSamples must be a finite non-negative integer.");
  }
  if (!Number.isFinite(options.alignedCoreSamples) || alignedCoreSamples <= 0) {
    throw new RangeError("alignedCoreSamples must be a finite positive integer.");
  }
  if (!Number.isFinite(options.sampleRate) || options.sampleRate <= 0) {
    throw new RangeError("sampleRate must be finite and positive.");
  }
  if (!Number.isFinite(options.frameSize) || options.frameSize <= 0) {
    throw new RangeError("frameSize must be finite and positive.");
  }

  let state = initialState(options.sampleRate);
  if (totalSamples < 3 || options.frameRms.length === 0) return { count: 0, state };

  const contextSamples = resolveAdaptiveSampleClickContextSamples(options.sampleRate);
  let count = 0;
  for (let coreStart = 0; coreStart < totalSamples; coreStart += alignedCoreSamples) {
    const coreEnd = Math.min(totalSamples, coreStart + alignedCoreSamples);
    const loadStart = Math.max(0, coreStart - contextSamples);
    const loadEnd = Math.min(totalSamples, coreEnd + contextSamples);
    const samples = await options.loadSamples(loadStart, loadEnd);
    const expectedLength = loadEnd - loadStart;
    if (samples.length !== expectedLength) {
      throw new RangeError(
        `loadSamples(${loadStart}, ${loadEnd}) returned ${samples.length} samples; expected ${expectedLength}.`,
      );
    }
    const result = countAdaptiveSampleClickDiscontinuities({
      samples,
      sampleRate: options.sampleRate,
      frameSize: options.frameSize,
      frameRms: options.frameRms,
      frameSharpness: options.frameSharpness,
      globalSampleOffset: loadStart,
      coreStartSample: coreStart - loadStart,
      coreEndSample: coreEnd - loadStart,
      priorState: state,
    });
    count += result.count;
    state = result.state;
  }

  return { count, state };
};
