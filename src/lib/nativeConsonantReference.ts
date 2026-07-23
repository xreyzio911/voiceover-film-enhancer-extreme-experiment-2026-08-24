import {
  RENDERED_CONSONANT_SOURCE_FRAME_MS,
  type RenderedConsonantReference,
} from "./gainPlanner.ts";

const MIN_REFERENCE_TO_RENDERED_SAMPLE_RATE_RATIO = 0.9;

/**
 * A source-relative final residual must compare like bandwidth with like.
 * Lower-rate planner evidence cannot describe consonant energy above its
 * Nyquist limit, so using it against a 48 kHz delivery can manufacture
 * apparent contrast growth. In that fallback the optional residual fails
 * open and preserves the rendered bytes.
 */
export const isConsonantReferenceBandwidthCompatible = (
  referenceSampleRate: number,
  renderedSampleRate: number,
) => (
  Number.isFinite(referenceSampleRate)
  && referenceSampleRate > 0
  && Number.isFinite(renderedSampleRate)
  && renderedSampleRate > 0
  && referenceSampleRate >= renderedSampleRate * MIN_REFERENCE_TO_RENDERED_SAMPLE_RATE_RATIO
);

export type NativeConsonantReferenceAccumulatorOptions = Readonly<{
  /** Decode sample rate. Keep this equal to the native planner-apply rate. */
  sampleRate: number;
  /** Exact number of unique source samples represented by the reference. */
  totalSampleCount: number;
  /** Analysis-frame width. The production consonant reference uses 2 ms. */
  frameMs?: number;
  /** Absolute source position represented by reference frame zero. */
  referenceStartSample?: number;
}>;

export type NativeConsonantReferenceChunk = Readonly<{
  samples: Float32Array;
  /** Absolute source position represented by samples[0]. */
  sourceStartSample: number;
  /**
   * Inclusive absolute start of unique evidence inside this decoded chunk.
   * Prefix context before this position is ignored.
   */
  uniqueStartSample?: number;
  /**
   * Exclusive absolute end of unique evidence inside this decoded chunk.
   * Crossfade/look-ahead samples at or after this position are ignored.
   */
  uniqueEndSample?: number;
}>;

export type NativeConsonantReferenceFinalizeOptions = Readonly<{
  /**
   * Permit the final decoded source range to end before rounded duration
   * metadata. Earlier gaps remain invalid; only the contiguous trailing edge
   * is trimmed to the samples that actually reached the planner.
   */
  allowTrailingShortfall?: boolean;
}>;

export type NativeConsonantReferenceAccumulator = Readonly<{
  sampleRate: number;
  frameMs: number;
  referenceStartSample: number;
  totalSampleCount: number;
  frameCount: number;
  /** Bytes reserved for the two compact Float32 frame envelopes. */
  allocatedBytes: number;
  append: (chunk: NativeConsonantReferenceChunk) => void;
  finalize: (options?: NativeConsonantReferenceFinalizeOptions) => RenderedConsonantReference;
}>;

const requirePositiveFinite = (value: number, label: string) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number.`);
  }
};

const requireNonNegativeInteger = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
};

const resolveFrameCount = (totalSampleCount: number, samplesPerFrame: number) => {
  const frameBoundary = (frame: number) => Math.round(frame * samplesPerFrame);
  let frameCount = Math.max(1, Math.ceil(totalSampleCount / samplesPerFrame));
  while (frameCount > 1 && frameBoundary(frameCount - 1) >= totalSampleCount) {
    frameCount -= 1;
  }
  while (frameBoundary(frameCount) < totalSampleCount) {
    frameCount += 1;
  }
  return frameCount;
};

/**
 * Incrementally measures a source-relative consonant reference while native
 * planner-apply chunks are already in memory. Only two 2 ms Float32 envelopes
 * are retained; decoded PCM never survives `append`.
 *
 * Chunks must contribute one contiguous sequence of unique source samples.
 * Explicit unique bounds let callers discard duplicated overlap/crossfade
 * context without guessing from amplitudes or applying an audio gate.
 */
export const createNativeConsonantReferenceAccumulator = (
  options: NativeConsonantReferenceAccumulatorOptions,
): NativeConsonantReferenceAccumulator => {
  const sampleRate = options.sampleRate;
  const totalSampleCount = options.totalSampleCount;
  requirePositiveFinite(sampleRate, "sampleRate");
  requireNonNegativeInteger(totalSampleCount, "totalSampleCount");
  if (totalSampleCount === 0) {
    throw new RangeError("totalSampleCount must contain at least one sample.");
  }
  const frameMs = options.frameMs ?? RENDERED_CONSONANT_SOURCE_FRAME_MS;
  requirePositiveFinite(frameMs, "frameMs");
  const referenceStartSample = options.referenceStartSample ?? 0;
  requireNonNegativeInteger(referenceStartSample, "referenceStartSample");

  const referenceEndSample = referenceStartSample + totalSampleCount;
  if (!Number.isSafeInteger(referenceEndSample)) {
    throw new RangeError("reference sample range exceeds safe integer precision.");
  }
  const samplesPerFrame = (sampleRate * frameMs) / 1000;
  requirePositiveFinite(samplesPerFrame, "samples per frame");
  if (samplesPerFrame < 1) {
    throw new RangeError("frameMs must span at least one decoded sample.");
  }
  const frameCount = resolveFrameCount(totalSampleCount, samplesPerFrame);
  const rmsDb = new Float32Array(frameCount);
  const peakDb = new Float32Array(frameCount);
  rmsDb.fill(-120);
  peakDb.fill(-120);

  const relativeFrameBoundary = (frame: number) => Math.round(frame * samplesPerFrame);
  const absoluteFrameEnd = (frame: number) => (
    referenceStartSample
    + Math.min(
      totalSampleCount,
      Math.max(relativeFrameBoundary(frame) + 1, relativeFrameBoundary(frame + 1)),
    )
  );

  let nextSourceSample = referenceStartSample;
  let nextFrame = 0;
  let frameSquareSum = 0;
  let framePeak = 0;
  let frameSampleCount = 0;
  let finalizedReference: RenderedConsonantReference | null = null;

  const commitFrame = () => {
    const rms = Math.sqrt(frameSquareSum / Math.max(1, frameSampleCount));
    rmsDb[nextFrame] = rms > 0 ? 20 * Math.log10(rms) : -120;
    peakDb[nextFrame] = framePeak > 0 ? 20 * Math.log10(framePeak) : -120;
    nextFrame += 1;
    frameSquareSum = 0;
    framePeak = 0;
    frameSampleCount = 0;
  };

  const append = (chunk: NativeConsonantReferenceChunk) => {
    if (finalizedReference) {
      throw new Error("Cannot append source evidence after the reference was finalized.");
    }
    requireNonNegativeInteger(chunk.sourceStartSample, "sourceStartSample");
    const decodedEndSample = chunk.sourceStartSample + chunk.samples.length;
    if (!Number.isSafeInteger(decodedEndSample)) {
      throw new RangeError("decoded chunk sample range exceeds safe integer precision.");
    }
    const uniqueStartSample = chunk.uniqueStartSample ?? chunk.sourceStartSample;
    const uniqueEndSample = chunk.uniqueEndSample ?? decodedEndSample;
    requireNonNegativeInteger(uniqueStartSample, "uniqueStartSample");
    requireNonNegativeInteger(uniqueEndSample, "uniqueEndSample");
    if (
      uniqueStartSample < chunk.sourceStartSample
      || uniqueEndSample < uniqueStartSample
      || uniqueEndSample > decodedEndSample
    ) {
      throw new RangeError("Unique source bounds must stay inside the decoded chunk.");
    }
    if (uniqueStartSample !== nextSourceSample) {
      throw new RangeError(
        `Native source chunks must be contiguous: expected sample ${nextSourceSample}, received ${uniqueStartSample}.`,
      );
    }
    if (uniqueEndSample > referenceEndSample) {
      throw new RangeError("Unique source evidence exceeds the declared reference duration.");
    }

    let localIndex = uniqueStartSample - chunk.sourceStartSample;
    let absoluteSample = uniqueStartSample;
    while (absoluteSample < uniqueEndSample) {
      if (nextFrame >= frameCount) {
        throw new RangeError("Unique source evidence exceeds the allocated frame envelope.");
      }
      const frameEndSample = absoluteFrameEnd(nextFrame);
      const takeCount = Math.min(uniqueEndSample, frameEndSample) - absoluteSample;
      const localEnd = localIndex + takeCount;
      for (; localIndex < localEnd; localIndex += 1) {
        const sample = chunk.samples[localIndex];
        frameSquareSum += sample * sample;
        framePeak = Math.max(framePeak, Math.abs(sample));
      }
      frameSampleCount += takeCount;
      absoluteSample += takeCount;
      if (absoluteSample === frameEndSample) {
        commitFrame();
      }
    }
    nextSourceSample = uniqueEndSample;
  };

  const finalize = (finalizeOptions: NativeConsonantReferenceFinalizeOptions = {}) => {
    if (finalizedReference) return finalizedReference;
    const actualTotalSampleCount = nextSourceSample - referenceStartSample;
    const hasAllowedTrailingShortfall =
      finalizeOptions.allowTrailingShortfall === true &&
      actualTotalSampleCount > 0 &&
      nextSourceSample < referenceEndSample;
    if (nextSourceSample !== referenceEndSample && !hasAllowedTrailingShortfall) {
      throw new Error(
        `Cannot finalize an incomplete reference: expected through sample ${referenceEndSample}, received through ${nextSourceSample}.`,
      );
    }
    if (frameSampleCount > 0) commitFrame();
    const actualFrameCount = resolveFrameCount(actualTotalSampleCount, samplesPerFrame);
    if (nextFrame !== actualFrameCount) {
      throw new Error(`Reference frame coverage mismatch: expected ${actualFrameCount}, measured ${nextFrame}.`);
    }
    finalizedReference = {
      sampleRate,
      frameMs,
      durationSec: actualTotalSampleCount / sampleRate,
      rmsDb: actualFrameCount === frameCount ? rmsDb : rmsDb.slice(0, actualFrameCount),
      peakDb: actualFrameCount === frameCount ? peakDb : peakDb.slice(0, actualFrameCount),
    };
    return finalizedReference;
  };

  return Object.freeze({
    sampleRate,
    frameMs,
    referenceStartSample,
    totalSampleCount,
    frameCount,
    allocatedBytes: rmsDb.byteLength + peakDb.byteLength,
    append,
    finalize,
  });
};
