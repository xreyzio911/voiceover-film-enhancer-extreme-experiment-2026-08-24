export type SegmentRenderWindowInput = Readonly<{
  sourceDurationSec: number;
  sampleRate: number;
  segmentStartSec: number;
  segmentEndSec: number;
  isInitialSegment: boolean;
  stateHistorySec?: number;
  leadingContextSec?: number;
  trailingContextSec?: number;
  outputOverlapSec?: number;
  trimPadSec?: number;
}>;

export type SegmentRenderWindow = Readonly<{
  readStartSample: number;
  readEndSample: number;
  readSampleCount: number;
  trimStartSample: number;
  trimEndSample: number;
  outputStartSample: number;
  outputEndSample: number;
  outputSampleCount: number;
  historySampleCount: number;
  trailingContextSampleCount: number;
  readStartSec: number;
  readEndSec: number;
  readDurationSec: number;
  trimStartSec: number;
  trimEndSec: number;
  outputStartSec: number;
  outputEndSec: number;
  outputDurationSec: number;
  historyDurationSec: number;
  trailingContextDurationSec: number;
}>;

const requireFinite = (label: string, value: number) => {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite.`);
  }
  return value;
};

const requireNonNegative = (label: string, value: number) => {
  requireFinite(label, value);
  if (value < 0) {
    throw new RangeError(`${label} must be non-negative.`);
  }
  return value;
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

/**
 * Resolves the source-read and post-filter trim windows for one render segment.
 *
 * Noninitial segments read real source audio before their exported interval so
 * stateful filters warm up on continuous program material. That history is
 * removed after filtering, leaving the requested source timeline, trim pad,
 * and crossfade overlap sample-exact.
 */
export const resolveSegmentRenderWindow = (
  input: SegmentRenderWindowInput,
): SegmentRenderWindow => {
  const sampleRate = requireFinite("sampleRate", input.sampleRate);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError("sampleRate must be a positive integer.");
  }

  const sourceDurationSec = requireNonNegative("sourceDurationSec", input.sourceDurationSec);
  const segmentStartSec = requireNonNegative("segmentStartSec", input.segmentStartSec);
  const segmentEndSec = requireNonNegative("segmentEndSec", input.segmentEndSec);
  const stateHistorySec = requireNonNegative("stateHistorySec", input.stateHistorySec ?? 1);
  const leadingContextSec = requireNonNegative("leadingContextSec", input.leadingContextSec ?? 0);
  const trailingContextSec = requireNonNegative("trailingContextSec", input.trailingContextSec ?? 0);
  const outputOverlapSec = requireNonNegative("outputOverlapSec", input.outputOverlapSec ?? 0);
  const trimPadSec = requireNonNegative("trimPadSec", input.trimPadSec ?? 0);

  const toSamples = (seconds: number) => Math.round(seconds * sampleRate);
  const toSeconds = (samples: number) => samples / sampleRate;
  const sourceEndSample = toSamples(sourceDurationSec);
  const segmentStartSample = clamp(toSamples(segmentStartSec), 0, sourceEndSample);
  const segmentEndSample = clamp(toSamples(segmentEndSec), segmentStartSample, sourceEndSample);
  if (segmentEndSample <= segmentStartSample) {
    throw new RangeError("segmentEndSec must resolve after segmentStartSec within the source.");
  }

  const stateHistorySamples = toSamples(stateHistorySec);
  const leadingContextSamples = toSamples(leadingContextSec);
  const trailingContextSamples = toSamples(trailingContextSec);
  const outputOverlapSamples = toSamples(outputOverlapSec);
  const trimPadSamples = toSamples(trimPadSec);
  if (trimPadSamples * 2 >= segmentEndSample - segmentStartSample) {
    throw new RangeError("trimPadSec must leave at least one source sample in the segment.");
  }

  const outputStartSample = segmentStartSample + trimPadSamples;
  const outputEndSample = Math.min(
    sourceEndSample,
    segmentEndSample - trimPadSamples + outputOverlapSamples,
  );
  const existingReadStartSample = Math.max(0, segmentStartSample - leadingContextSamples);
  const historyReadStartSample = Math.max(0, outputStartSample - stateHistorySamples);
  const readStartSample = input.isInitialSegment
    ? existingReadStartSample
    : Math.min(existingReadStartSample, historyReadStartSample);
  const readEndSample = Math.min(
    sourceEndSample,
    segmentEndSample + trailingContextSamples + outputOverlapSamples,
  );
  const readSampleCount = readEndSample - readStartSample;
  const trimStartSample = outputStartSample - readStartSample;
  const trimEndSample = outputEndSample - readStartSample;
  const outputSampleCount = outputEndSample - outputStartSample;
  const historySampleCount = trimStartSample;
  const trailingContextSampleCount = readEndSample - outputEndSample;

  return Object.freeze({
    readStartSample,
    readEndSample,
    readSampleCount,
    trimStartSample,
    trimEndSample,
    outputStartSample,
    outputEndSample,
    outputSampleCount,
    historySampleCount,
    trailingContextSampleCount,
    readStartSec: toSeconds(readStartSample),
    readEndSec: toSeconds(readEndSample),
    readDurationSec: toSeconds(readSampleCount),
    trimStartSec: toSeconds(trimStartSample),
    trimEndSec: toSeconds(trimEndSample),
    outputStartSec: toSeconds(outputStartSample),
    outputEndSec: toSeconds(outputEndSample),
    outputDurationSec: toSeconds(outputSampleCount),
    historyDurationSec: toSeconds(historySampleCount),
    trailingContextDurationSec: toSeconds(trailingContextSampleCount),
  });
};
