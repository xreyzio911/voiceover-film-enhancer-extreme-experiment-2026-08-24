import { buildSpeechMask, percentile } from "./audioQc.ts";

const SECTION_SECONDS = 10;
const MAX_SECTION_LAG = 6;
const LOCAL_SHOULDER_MS = 400;
const LOCAL_CORE_MS = 60;
const LOCAL_ALIGNMENT_TOLERANCE_MS = 20;
const GLOBAL_ALIGNMENT_LIMIT_MS = 250;
const GLOBAL_ALIGNMENT_MIN_IMPROVEMENT_DB = 0.05;
const GLOBAL_ALIGNMENT_MAX_SAMPLES = 20_000;
const SPIKE_ADVISORY_CONTRAST_DB = 1.5;
const MAX_REPORTED_SPIKE_EVENTS = 5;
const MAX_REPORTED_FLATTENED_EVENTS = 5;
const EXPRESSIVE_MIN_CONTRAST_DB = 2.5;
const EXPRESSIVE_MIN_CREST_DB = 6;
const EXPRESSIVE_FLATTENED_RATIO = 0.55;
const EXPRESSIVE_FLATTENED_LOSS_DB = 2;
const MIN_BODY_FRAMES = 20;

/**
 * Pre-computed, fixed-duration mono envelope evidence. All level arrays use
 * dBFS and one value per `frameMs`; no array is modified by this module.
 */
export type VoiceEnvelopeEvidence = Readonly<{
  frameMs: number;
  /** Broadband RMS in dBFS. */
  frameDb: readonly number[];
  /** Sample peak in dBFS for the same frame. */
  framePeakDb: readonly number[];
  /** 180-3000 Hz RMS in dBFS, used as a voiced-body proxy. */
  speechBodyDb: readonly number[];
}>;

export type DriftSection = Readonly<{
  startSec: number;
  endSec: number;
  speechFrameCount: number;
  /** Median candidate-minus-source level in dB. */
  processingDeltaDb: number;
}>;

export type SpikeEventWindow = Readonly<{
  /** First qualifying frame boundary in the original source timeline. */
  startSec: number;
  /** End boundary after the final qualifying frame in the original source timeline. */
  endSec: number;
  /** Center of the frame with the greatest processing-added contrast. */
  centerSec: number;
  peakAddedContrastDb: number;
}>;

export type FlattenedExpressiveEvent = Readonly<{
  /** Source-derived event boundaries in the original source timeline. */
  startSec: number;
  endSec: number;
  /** Center of the source frame that defines this expressive event. */
  centerSec: number;
  sourceContrastDb: number;
  candidateContrastDb: number;
  retentionRatio: number;
  /** Positive dB lost from the source event's local contrast. */
  contrastLossDb: number;
  /** Candidate-minus-source crest change, or null without paired crest evidence. */
  crestDeltaDb: number | null;
}>;

export type VoiceStabilityReport = Readonly<{
  schemaVersion: 1;
  /** These measurements are comparative evidence and never a delivery gate. */
  advisoryOnly: true;
  frameMs: number | null;
  alignedFrameCount: number;
  sourceSpeechFrameCount: number;
  alignment: Readonly<{
    /** Positive means the candidate envelope starts later than the source. */
    candidateLagFrames: number;
    candidateLagMs: number;
    searchLimitMs: number;
    /** Reduction in gain-centered median absolute envelope error, in dB. */
    scoreImprovementDb: number | null;
  }>;
  drift: Readonly<{
    /** Robust median processing-delta slope; positive rises, negative falls. */
    signedSlopeDbPerMinute: number | null;
    /** Positive 75th-percentile robust section slope, in dB/min. */
    risingSlopeP75DbPerMinute: number | null;
    /** Negative 25th-percentile robust section slope, in dB/min. */
    fallingSlopeP25DbPerMinute: number | null;
    sectionDeltaSpreadDb: number | null;
    sections: readonly DriftSection[];
  }>;
  spikes: Readonly<{
    /** Local contrast uses 400 ms shoulders and +/-20 ms source timing tolerance. */
    advisoryContrastDb: number;
    supportedFrameCount: number;
    up: Readonly<{
      /** P95 of each above-advisory event's peak processing-added contrast. */
      p95AddedContrastDb: number | null;
      countAboveAdvisoryContrast: number;
      /** Strongest events first; equal peaks use earlier source time first. */
      topEvents: readonly SpikeEventWindow[];
    }>;
    down: Readonly<{
      /** P95 of each above-advisory event's peak processing-added contrast. */
      p95AddedContrastDb: number | null;
      countAboveAdvisoryContrast: number;
      /** Strongest events first; equal peaks use earlier source time first. */
      topEvents: readonly SpikeEventWindow[];
    }>;
  }>;
  body: Readonly<{
    eligibleFrameCount: number;
    /** P10 body level relative to that file's speech-body median, in dB. */
    sourceFloorRelativeDb: number | null;
    candidateFloorRelativeDb: number | null;
    /** Positive means the candidate filled source-relative body valleys. */
    floorFillDeltaDb: number | null;
    /** P90-P10 body spread in dB after removing each file's static level. */
    sourceSpreadDb: number | null;
    candidateSpreadDb: number | null;
    /** Negative means a narrower candidate body distribution. */
    spreadDeltaDb: number | null;
    /** Change in median (180-3000 Hz body minus broadband RMS), in dB. */
    bodyBalanceDeltaDb: number | null;
  }>;
  expressiveRetention: Readonly<{
    /** Events are located from source-only local contrast and crest evidence. */
    sourceEventCount: number;
    evaluatedEventCount: number;
    contrastRetentionP10Ratio: number | null;
    medianContrastDeltaDb: number | null;
    crestDeltaP10Db: number | null;
    flattenedEventCount: number;
    flattenedRatioAdvisory: number;
    flattenedLossAdvisoryDb: number;
    /** Strongest contrast losses first; equal losses use earlier source time first. */
    topFlattenedEvents: readonly FlattenedExpressiveEvent[];
  }>;
  notes: readonly string[];
}>;

type LocalContrast = Readonly<{
  index: number;
  sourceContrastDb: number;
  candidateContrastDb: number;
  sourceCrestDb: number | null;
  candidateCrestDb: number | null;
}>;

type Prefix = Readonly<{
  sums: Float64Array;
  counts: Uint32Array;
}>;

const finite = (value: number | null | undefined): value is number => Number.isFinite(value);

const finitePercentile = (values: readonly number[], percent: number) =>
  percentile(values.filter(finite), percent);

const finiteMedian = (values: readonly number[]) => finitePercentile(values, 50);

const makePrefix = (values: readonly number[], include: readonly boolean[]): Prefix => {
  const sums = new Float64Array(values.length + 1);
  const counts = new Uint32Array(values.length + 1);
  for (let index = 0; index < values.length; index += 1) {
    const accepted = include[index] === true && finite(values[index]);
    sums[index + 1] = sums[index] + (accepted ? values[index] : 0);
    counts[index + 1] = counts[index] + (accepted ? 1 : 0);
  }
  return { sums, counts };
};

const rangeMean = (prefix: Prefix, start: number, end: number) => {
  const safeStart = Math.max(0, Math.min(prefix.sums.length - 1, start));
  const safeEnd = Math.max(safeStart, Math.min(prefix.sums.length - 1, end));
  const count = prefix.counts[safeEnd] - prefix.counts[safeStart];
  if (count <= 0) return null;
  return (prefix.sums[safeEnd] - prefix.sums[safeStart]) / count;
};

const deriveSpeechMask = (sourceFrameDb: readonly number[], frameMs: number) => {
  const finiteSource = sourceFrameDb.filter(finite);
  const noiseFloorDb = percentile(finiteSource, 25);
  if (noiseFloorDb === null) return new Array<boolean>(sourceFrameDb.length).fill(false);
  const sanitized = sourceFrameDb.map((value) => finite(value) ? value : -120);
  return buildSpeechMask(sanitized, noiseFloorDb, { frameMs });
};

const deriveSourceBodySupportMask = (
  source: VoiceEnvelopeEvidence,
  speechMask: readonly boolean[],
  alignedFrameCount: number,
) => {
  const bodyValues: number[] = [];
  const bodyFrameCount = Math.min(alignedFrameCount, source.speechBodyDb.length);
  for (let index = 0; index < bodyFrameCount; index += 1) {
    if (speechMask[index] && finite(source.speechBodyDb[index])) {
      bodyValues.push(source.speechBodyDb[index]);
    }
  }
  const bodyMedianDb = finiteMedian(bodyValues);
  if (bodyMedianDb === null || bodyValues.length < MIN_BODY_FRAMES) {
    return speechMask.slice(0, alignedFrameCount);
  }

  // Relative to the source's own body median, so this support boundary is
  // invariant to static gain. Its wide 24 dB allowance retains quiet words
  // while removing held speech-mask frames that are actually pause floor.
  const supportFloorDb = bodyMedianDb - 24;
  return Array.from(
    { length: alignedFrameCount },
    (_, index) => (
      speechMask[index] === true &&
      finite(source.speechBodyDb[index]) &&
      source.speechBodyDb[index] >= supportFloorDb
    ),
  );
};

const alignmentDispersionDb = (
  source: VoiceEnvelopeEvidence,
  candidate: VoiceEnvelopeEvidence,
  sourceSupportMask: readonly boolean[],
  candidateLagFrames: number,
) => {
  const sourceStart = Math.max(0, -candidateLagFrames);
  const sourceEnd = Math.min(
    source.frameDb.length,
    candidate.frameDb.length - candidateLagFrames,
  );
  if (sourceEnd <= sourceStart) return null;
  const stride = Math.max(
    1,
    Math.floor((sourceEnd - sourceStart) / GLOBAL_ALIGNMENT_MAX_SAMPLES),
  );
  const deltas: number[] = [];
  for (let sourceIndex = sourceStart; sourceIndex < sourceEnd; sourceIndex += stride) {
    const candidateIndex = sourceIndex + candidateLagFrames;
    if (
      sourceSupportMask[sourceIndex] !== true ||
      !finite(source.frameDb[sourceIndex]) ||
      !finite(candidate.frameDb[candidateIndex])
    ) continue;
    deltas.push(candidate.frameDb[candidateIndex] - source.frameDb[sourceIndex]);
  }
  if (deltas.length < 20) return null;
  const centerDb = finiteMedian(deltas);
  if (centerDb === null) return null;
  return finiteMedian(deltas.map((value) => Math.abs(value - centerDb)));
};

const estimateGlobalAlignment = (
  source: VoiceEnvelopeEvidence,
  candidate: VoiceEnvelopeEvidence,
  sourceSupportMask: readonly boolean[],
) => {
  const maximumLagFrames = Math.max(0, Math.floor(GLOBAL_ALIGNMENT_LIMIT_MS / source.frameMs));
  const zeroScoreDb = alignmentDispersionDb(source, candidate, sourceSupportMask, 0);
  if (zeroScoreDb === null || maximumLagFrames === 0) {
    return { candidateLagFrames: 0, scoreImprovementDb: null };
  }
  let bestLagFrames = 0;
  let bestScoreDb = zeroScoreDb;
  for (let lagFrames = -maximumLagFrames; lagFrames <= maximumLagFrames; lagFrames += 1) {
    if (lagFrames === 0) continue;
    const scoreDb = alignmentDispersionDb(source, candidate, sourceSupportMask, lagFrames);
    if (scoreDb === null) continue;
    const materiallyBetter = scoreDb < bestScoreDb - GLOBAL_ALIGNMENT_MIN_IMPROVEMENT_DB;
    const tiedButCloser =
      Math.abs(scoreDb - bestScoreDb) <= 1e-9 &&
      Math.abs(lagFrames) < Math.abs(bestLagFrames);
    if (materiallyBetter || tiedButCloser) {
      bestLagFrames = lagFrames;
      bestScoreDb = scoreDb;
    }
  }
  return {
    candidateLagFrames: bestLagFrames,
    scoreImprovementDb: Math.max(0, zeroScoreDb - bestScoreDb),
  };
};

const alignEvidence = (
  source: VoiceEnvelopeEvidence,
  candidate: VoiceEnvelopeEvidence,
  candidateLagFrames: number,
) => {
  const sourceStart = Math.max(0, -candidateLagFrames);
  const candidateStart = Math.max(0, candidateLagFrames);
  const frameCount = Math.max(
    0,
    Math.min(
      source.frameDb.length - sourceStart,
      candidate.frameDb.length - candidateStart,
    ),
  );
  const sliceEvidence = (
    input: VoiceEnvelopeEvidence,
    start: number,
  ): VoiceEnvelopeEvidence => ({
    frameMs: input.frameMs,
    frameDb: input.frameDb.slice(start, start + frameCount),
    framePeakDb: input.framePeakDb.slice(start, start + frameCount),
    speechBodyDb: input.speechBodyDb.slice(start, start + frameCount),
  });
  return {
    source: sliceEvidence(source, sourceStart),
    candidate: sliceEvidence(candidate, candidateStart),
  };
};

const deriveLocalContrasts = (
  source: VoiceEnvelopeEvidence,
  candidate: VoiceEnvelopeEvidence,
  speechMask: readonly boolean[],
  alignedFrameCount: number,
) => {
  const include = Array.from(
    { length: alignedFrameCount },
    (_, index) => speechMask[index] === true,
  );
  const sourcePrefix = makePrefix(source.frameDb.slice(0, alignedFrameCount), include);
  const candidatePrefix = makePrefix(candidate.frameDb.slice(0, alignedFrameCount), include);
  const radiusFrames = Math.max(5, Math.round(LOCAL_SHOULDER_MS / source.frameMs));
  const coreFrames = Math.max(1, Math.round(LOCAL_CORE_MS / source.frameMs));
  const minimumShoulderFrames = Math.max(2, Math.round(80 / source.frameMs));
  const contrasts: LocalContrast[] = [];

  for (let index = radiusFrames; index + radiusFrames < alignedFrameCount; index += 1) {
    if (!speechMask[index] || !finite(source.frameDb[index]) || !finite(candidate.frameDb[index])) continue;
    const leftStart = index - radiusFrames;
    const leftEnd = index - coreFrames;
    const rightStart = index + coreFrames + 1;
    const rightEnd = index + radiusFrames + 1;
    const leftCount = sourcePrefix.counts[leftEnd] - sourcePrefix.counts[leftStart];
    const rightCount = sourcePrefix.counts[rightEnd] - sourcePrefix.counts[rightStart];
    const candidateLeftCount = candidatePrefix.counts[leftEnd] - candidatePrefix.counts[leftStart];
    const candidateRightCount = candidatePrefix.counts[rightEnd] - candidatePrefix.counts[rightStart];
    if (
      leftCount < minimumShoulderFrames ||
      rightCount < minimumShoulderFrames ||
      candidateLeftCount < minimumShoulderFrames ||
      candidateRightCount < minimumShoulderFrames
    ) continue;

    const sourceLeft = rangeMean(sourcePrefix, leftStart, leftEnd);
    const sourceRight = rangeMean(sourcePrefix, rightStart, rightEnd);
    const candidateLeft = rangeMean(candidatePrefix, leftStart, leftEnd);
    const candidateRight = rangeMean(candidatePrefix, rightStart, rightEnd);
    if (
      sourceLeft === null ||
      sourceRight === null ||
      candidateLeft === null ||
      candidateRight === null
    ) continue;

    const sourceCrestDb =
      finite(source.framePeakDb[index])
        ? source.framePeakDb[index] - source.frameDb[index]
        : null;
    const candidateCrestDb =
      finite(candidate.framePeakDb[index])
        ? candidate.framePeakDb[index] - candidate.frameDb[index]
        : null;
    contrasts.push({
      index,
      sourceContrastDb: source.frameDb[index] - (sourceLeft + sourceRight) / 2,
      candidateContrastDb: candidate.frameDb[index] - (candidateLeft + candidateRight) / 2,
      sourceCrestDb: finite(sourceCrestDb ?? undefined) ? sourceCrestDb : null,
      candidateCrestDb: finite(candidateCrestDb ?? undefined) ? candidateCrestDb : null,
    });
  }
  return contrasts;
};

const clusterIndices = (indices: readonly number[], maximumGapFrames: number) => {
  if (indices.length === 0) return [];
  const clusters: number[][] = [];
  let current = [indices[0]];
  for (let cursor = 1; cursor < indices.length; cursor += 1) {
    const index = indices[cursor];
    if (index - current[current.length - 1] <= maximumGapFrames) {
      current.push(index);
    } else {
      clusters.push(current);
      current = [index];
    }
  }
  clusters.push(current);
  return clusters;
};

const selectExpressiveEvents = (contrasts: readonly LocalContrast[], frameMs: number) => {
  const positiveContrasts = contrasts
    .map((item) => item.sourceContrastDb)
    .filter((value) => value > 0);
  const sourceCrests = contrasts
    .map((item) => item.sourceCrestDb)
    .filter(finite);
  const contrastThresholdDb = Math.max(
    EXPRESSIVE_MIN_CONTRAST_DB,
    finitePercentile(positiveContrasts, 90) ?? EXPRESSIVE_MIN_CONTRAST_DB,
  );
  const crestThresholdDb = Math.max(
    EXPRESSIVE_MIN_CREST_DB,
    finitePercentile(sourceCrests, 90) ?? EXPRESSIVE_MIN_CREST_DB,
  );
  const selected = contrasts.filter((item) =>
    item.sourceContrastDb >= contrastThresholdDb ||
    (
      item.sourceContrastDb >= EXPRESSIVE_MIN_CONTRAST_DB * 0.5 &&
      item.sourceCrestDb !== null &&
      item.sourceCrestDb >= crestThresholdDb
    )
  );
  const byIndex = new Map(selected.map((item) => [item.index, item]));
  const maximumGapFrames = Math.max(1, Math.round(80 / frameMs));
  return clusterIndices(selected.map((item) => item.index), maximumGapFrames).map((cluster) => {
    let strongest = byIndex.get(cluster[0])!;
    for (const index of cluster.slice(1)) {
      const item = byIndex.get(index)!;
      if (item.sourceContrastDb > strongest.sourceContrastDb) strongest = item;
    }
    return { frames: cluster, strongest };
  });
};

const summarizeSpikeDirection = (
  contrasts: readonly LocalContrast[],
  frameMs: number,
  direction: "up" | "down",
  sourceFrameOffset: number,
) => {
  const byIndex = new Map(contrasts.map((item) => [item.index, item]));
  const toleranceFrames = Math.max(1, Math.round(LOCAL_ALIGNMENT_TOLERANCE_MS / frameMs));
  const addedByIndex = new Map<number, number>();
  for (const item of contrasts) {
    const nearbySourceContrasts: number[] = [];
    for (let offset = -toleranceFrames; offset <= toleranceFrames; offset += 1) {
      const nearby = byIndex.get(item.index + offset);
      if (nearby) nearbySourceContrasts.push(nearby.sourceContrastDb);
    }
    if (nearbySourceContrasts.length === 0) continue;
    const sourceBound = direction === "up"
      ? Math.max(...nearbySourceContrasts)
      : Math.min(...nearbySourceContrasts);
    const added = direction === "up"
      ? item.candidateContrastDb - sourceBound
      : sourceBound - item.candidateContrastDb;
    addedByIndex.set(item.index, Math.max(0, added));
  }
  const qualifying = contrasts.filter(
    (item) => (addedByIndex.get(item.index) ?? 0) >= SPIKE_ADVISORY_CONTRAST_DB,
  );
  const clusters = clusterIndices(
    qualifying.map((item) => item.index),
    Math.max(1, Math.round(100 / frameMs)),
  );
  const timelineSec = (frame: number) =>
    Number((((sourceFrameOffset + frame) * frameMs) / 1_000).toFixed(6));
  const events = clusters.map((cluster): SpikeEventWindow => {
    let peakAddedContrastDb = 0;
    let peakIndex = cluster[0];
    for (const index of cluster) {
      const addedContrastDb = addedByIndex.get(index) ?? 0;
      if (addedContrastDb > peakAddedContrastDb) {
        peakAddedContrastDb = addedContrastDb;
        peakIndex = index;
      }
    }
    return {
      startSec: timelineSec(cluster[0]),
      endSec: timelineSec(cluster[cluster.length - 1] + 1),
      centerSec: timelineSec(peakIndex + 0.5),
      peakAddedContrastDb,
    };
  });
  const eventPeakContrasts = events.map((event) => event.peakAddedContrastDb);
  const eventRanksBefore = (left: SpikeEventWindow, right: SpikeEventWindow) =>
    left.peakAddedContrastDb > right.peakAddedContrastDb ||
    (
      left.peakAddedContrastDb === right.peakAddedContrastDb &&
      left.startSec < right.startSec
    );
  let topEvents: readonly SpikeEventWindow[] = [];
  for (const event of events) {
    const insertionIndex = topEvents.findIndex((existing) => eventRanksBefore(event, existing));
    if (insertionIndex < 0) {
      if (topEvents.length < MAX_REPORTED_SPIKE_EVENTS) topEvents = [...topEvents, event];
      continue;
    }
    topEvents = [
      ...topEvents.slice(0, insertionIndex),
      event,
      ...topEvents.slice(insertionIndex, MAX_REPORTED_SPIKE_EVENTS - 1),
    ];
  }
  return {
    p95AddedContrastDb: finitePercentile(eventPeakContrasts, 95),
    countAboveAdvisoryContrast: clusters.length,
    topEvents,
  };
};

const buildDrift = (
  source: VoiceEnvelopeEvidence,
  candidate: VoiceEnvelopeEvidence,
  speechMask: readonly boolean[],
  alignedFrameCount: number,
) => {
  const sectionFrames = Math.max(1, Math.round((SECTION_SECONDS * 1_000) / source.frameMs));
  const sections: DriftSection[] = [];
  for (let start = 0; start < alignedFrameCount; start += sectionFrames) {
    const end = Math.min(alignedFrameCount, start + sectionFrames);
    const deltas: number[] = [];
    for (let index = start; index < end; index += 1) {
      if (!speechMask[index] || !finite(source.frameDb[index]) || !finite(candidate.frameDb[index])) continue;
      deltas.push(candidate.frameDb[index] - source.frameDb[index]);
    }
    const processingDeltaDb = finiteMedian(deltas);
    if (processingDeltaDb === null || deltas.length < 5) continue;
    sections.push({
      startSec: (start * source.frameMs) / 1_000,
      endSec: (end * source.frameMs) / 1_000,
      speechFrameCount: deltas.length,
      processingDeltaDb,
    });
  }

  const slopes: number[] = [];
  const minimumLag = sections.length >= 3 ? 2 : 1;
  for (let left = 0; left < sections.length; left += 1) {
    const maximumRight = Math.min(sections.length - 1, left + MAX_SECTION_LAG);
    for (let right = left + minimumLag; right <= maximumRight; right += 1) {
      const leftMidSec = (sections[left].startSec + sections[left].endSec) / 2;
      const rightMidSec = (sections[right].startSec + sections[right].endSec) / 2;
      const elapsedMinutes = (rightMidSec - leftMidSec) / 60;
      if (elapsedMinutes <= 0) continue;
      slopes.push((sections[right].processingDeltaDb - sections[left].processingDeltaDb) / elapsedMinutes);
    }
  }
  const signedSlopeDbPerMinute = finiteMedian(slopes);
  const p75 = finitePercentile(slopes, 75);
  const p25 = finitePercentile(slopes, 25);
  const sectionValues = sections.map((section) => section.processingDeltaDb);
  const sectionP90 = finitePercentile(sectionValues, 90);
  const sectionP10 = finitePercentile(sectionValues, 10);
  return {
    signedSlopeDbPerMinute,
    risingSlopeP75DbPerMinute: p75 === null ? null : Math.max(0, p75),
    fallingSlopeP25DbPerMinute: p25 === null ? null : Math.min(0, p25),
    sectionDeltaSpreadDb:
      sectionP90 === null || sectionP10 === null ? null : sectionP90 - sectionP10,
    sections,
  };
};

const buildBody = (
  source: VoiceEnvelopeEvidence,
  candidate: VoiceEnvelopeEvidence,
  speechMask: readonly boolean[],
  expressiveFrames: ReadonlySet<number>,
  alignedFrameCount: number,
) => {
  const sourceBody: number[] = [];
  const candidateBody: number[] = [];
  const sourceBalance: number[] = [];
  const candidateBalance: number[] = [];
  const bodyFrameCount = Math.min(
    alignedFrameCount,
    source.speechBodyDb.length,
    candidate.speechBodyDb.length,
  );
  for (let index = 0; index < bodyFrameCount; index += 1) {
    if (!speechMask[index] || expressiveFrames.has(index)) continue;
    const sourceBodyDb = source.speechBodyDb[index];
    const candidateBodyDb = candidate.speechBodyDb[index];
    const sourceFrameDb = source.frameDb[index];
    const candidateFrameDb = candidate.frameDb[index];
    if (
      !finite(sourceBodyDb) ||
      !finite(candidateBodyDb) ||
      !finite(sourceFrameDb) ||
      !finite(candidateFrameDb)
    ) continue;
    sourceBody.push(sourceBodyDb);
    candidateBody.push(candidateBodyDb);
    sourceBalance.push(sourceBodyDb - sourceFrameDb);
    candidateBalance.push(candidateBodyDb - candidateFrameDb);
  }

  if (sourceBody.length < MIN_BODY_FRAMES) {
    return {
      eligibleFrameCount: sourceBody.length,
      sourceFloorRelativeDb: null,
      candidateFloorRelativeDb: null,
      floorFillDeltaDb: null,
      sourceSpreadDb: null,
      candidateSpreadDb: null,
      spreadDeltaDb: null,
      bodyBalanceDeltaDb: null,
    };
  }

  const sourceMedianDb = finiteMedian(sourceBody)!;
  const candidateMedianDb = finiteMedian(candidateBody)!;
  const sourceRelative = sourceBody.map((value) => value - sourceMedianDb);
  const candidateRelative = candidateBody.map((value) => value - candidateMedianDb);
  const sourceFloorRelativeDb = finitePercentile(sourceRelative, 10)!;
  const candidateFloorRelativeDb = finitePercentile(candidateRelative, 10)!;
  const sourceSpreadDb = finitePercentile(sourceRelative, 90)! - sourceFloorRelativeDb;
  const candidateSpreadDb = finitePercentile(candidateRelative, 90)! - candidateFloorRelativeDb;
  const sourceBalanceDb = finiteMedian(sourceBalance);
  const candidateBalanceDb = finiteMedian(candidateBalance);
  return {
    eligibleFrameCount: sourceBody.length,
    sourceFloorRelativeDb,
    candidateFloorRelativeDb,
    floorFillDeltaDb: candidateFloorRelativeDb - sourceFloorRelativeDb,
    sourceSpreadDb,
    candidateSpreadDb,
    spreadDeltaDb: candidateSpreadDb - sourceSpreadDb,
    bodyBalanceDeltaDb:
      sourceBalanceDb === null || candidateBalanceDb === null
        ? null
        : candidateBalanceDb - sourceBalanceDb,
  };
};

const emptyReport = (notes: readonly string[]): VoiceStabilityReport => ({
  schemaVersion: 1,
  advisoryOnly: true,
  frameMs: null,
  alignedFrameCount: 0,
  sourceSpeechFrameCount: 0,
  alignment: {
    candidateLagFrames: 0,
    candidateLagMs: 0,
    searchLimitMs: GLOBAL_ALIGNMENT_LIMIT_MS,
    scoreImprovementDb: null,
  },
  drift: {
    signedSlopeDbPerMinute: null,
    risingSlopeP75DbPerMinute: null,
    fallingSlopeP25DbPerMinute: null,
    sectionDeltaSpreadDb: null,
    sections: [],
  },
  spikes: {
    advisoryContrastDb: SPIKE_ADVISORY_CONTRAST_DB,
    supportedFrameCount: 0,
    up: { p95AddedContrastDb: null, countAboveAdvisoryContrast: 0, topEvents: [] },
    down: { p95AddedContrastDb: null, countAboveAdvisoryContrast: 0, topEvents: [] },
  },
  body: {
    eligibleFrameCount: 0,
    sourceFloorRelativeDb: null,
    candidateFloorRelativeDb: null,
    floorFillDeltaDb: null,
    sourceSpreadDb: null,
    candidateSpreadDb: null,
    spreadDeltaDb: null,
    bodyBalanceDeltaDb: null,
  },
  expressiveRetention: {
    sourceEventCount: 0,
    evaluatedEventCount: 0,
    contrastRetentionP10Ratio: null,
    medianContrastDeltaDb: null,
    crestDeltaP10Db: null,
    flattenedEventCount: 0,
    flattenedRatioAdvisory: EXPRESSIVE_FLATTENED_RATIO,
    flattenedLossAdvisoryDb: EXPRESSIVE_FLATTENED_LOSS_DB,
    topFlattenedEvents: [],
  },
  notes: [...notes],
});

/**
 * Compare aligned source/candidate envelope evidence. Every threshold is
 * descriptive/advisory; this function has no accept, reject, or cancel path.
 */
export const compareVoiceStability = (
  source: VoiceEnvelopeEvidence,
  candidate: VoiceEnvelopeEvidence,
): VoiceStabilityReport => {
  const notes: string[] = [];
  if (
    !finite(source.frameMs) ||
    !finite(candidate.frameMs) ||
    source.frameMs <= 0 ||
    candidate.frameMs <= 0 ||
    Math.abs(source.frameMs - candidate.frameMs) > 1e-6
  ) {
    return emptyReport(["Source and candidate require the same finite positive frame duration."]);
  }

  const rawAlignedFrameCount = Math.min(source.frameDb.length, candidate.frameDb.length);
  if (rawAlignedFrameCount < 2) {
    return {
      ...emptyReport(["Fewer than two aligned broadband frames were available."]),
      frameMs: source.frameMs,
      alignedFrameCount: rawAlignedFrameCount,
    };
  }
  const rawSpeechMask = deriveSpeechMask(source.frameDb, source.frameMs);
  const rawBodySupportMask = deriveSourceBodySupportMask(
    source,
    rawSpeechMask,
    source.frameDb.length,
  );
  const alignment = estimateGlobalAlignment(source, candidate, rawBodySupportMask);
  const aligned = alignEvidence(source, candidate, alignment.candidateLagFrames);
  const alignedSource = aligned.source;
  const alignedCandidate = aligned.candidate;
  const alignedFrameCount = Math.min(
    alignedSource.frameDb.length,
    alignedCandidate.frameDb.length,
  );
  if (alignment.candidateLagFrames !== 0) {
    notes.push(
      `Candidate envelope aligned by ${alignment.candidateLagFrames} frames before comparison.`,
    );
  }
  if (source.frameDb.length !== candidate.frameDb.length) {
    notes.push("Source and candidate frame counts differ; metrics use their aligned overlap.");
  }
  let finitePairCount = 0;
  for (let index = 0; index < alignedFrameCount; index += 1) {
    if (finite(alignedSource.frameDb[index]) && finite(alignedCandidate.frameDb[index])) {
      finitePairCount += 1;
    }
  }
  if (finitePairCount < 2) {
    return {
      ...emptyReport(["Fewer than two finite aligned broadband frames were available."]),
      frameMs: source.frameMs,
      alignedFrameCount,
    };
  }
  if (finitePairCount < alignedFrameCount) {
    notes.push("Non-finite broadband frames were omitted from comparative evidence.");
  }

  const speechMask = deriveSpeechMask(
    alignedSource.frameDb.slice(0, alignedFrameCount),
    alignedSource.frameMs,
  );
  const sourceSpeechFrameCount = speechMask.reduce((count, active) => count + Number(active), 0);
  if (sourceSpeechFrameCount === 0) notes.push("No source-supported speech frames were found.");
  const bodySupportMask = deriveSourceBodySupportMask(
    alignedSource,
    speechMask,
    alignedFrameCount,
  );
  const contrasts = deriveLocalContrasts(
    alignedSource,
    alignedCandidate,
    bodySupportMask,
    alignedFrameCount,
  );
  const expressiveEvents = selectExpressiveEvents(contrasts, alignedSource.frameMs);
  const expressiveFrames = new Set(expressiveEvents.flatMap((event) => event.frames));
  const sourceFrameOffset = Math.max(0, -alignment.candidateLagFrames);

  const upSpikes = summarizeSpikeDirection(
    contrasts,
    alignedSource.frameMs,
    "up",
    sourceFrameOffset,
  );
  const downSpikes = summarizeSpikeDirection(
    contrasts,
    alignedSource.frameMs,
    "down",
    sourceFrameOffset,
  );

  const retentionRatios: number[] = [];
  const contrastDeltas: number[] = [];
  const crestDeltas: number[] = [];
  let flattenedEventCount = 0;
  let topFlattenedEvents: readonly FlattenedExpressiveEvent[] = [];
  const timelineSec = (frame: number) =>
    Number((((sourceFrameOffset + frame) * alignedSource.frameMs) / 1_000).toFixed(6));
  const flattenedEventRanksBefore = (
    left: FlattenedExpressiveEvent,
    right: FlattenedExpressiveEvent,
  ) =>
    left.contrastLossDb > right.contrastLossDb ||
    (
      left.contrastLossDb === right.contrastLossDb &&
      left.startSec < right.startSec
    );
  const contrastByIndex = new Map(contrasts.map((item) => [item.index, item]));
  const retentionToleranceFrames = Math.max(
    1,
    Math.round(LOCAL_ALIGNMENT_TOLERANCE_MS / alignedSource.frameMs),
  );
  for (const event of expressiveEvents) {
    const sourceItem = event.strongest;
    if (!finite(sourceItem.sourceContrastDb) || sourceItem.sourceContrastDb <= 0) continue;
    let candidateItem: LocalContrast | null = null;
    for (let offset = -retentionToleranceFrames; offset <= retentionToleranceFrames; offset += 1) {
      const nearby = contrastByIndex.get(sourceItem.index + offset);
      if (nearby && (candidateItem === null || nearby.candidateContrastDb > candidateItem.candidateContrastDb)) {
        candidateItem = nearby;
      }
    }
    if (candidateItem === null || !finite(candidateItem.candidateContrastDb)) continue;
    const retentionRatio = Math.max(0, candidateItem.candidateContrastDb) / sourceItem.sourceContrastDb;
    const contrastDeltaDb = candidateItem.candidateContrastDb - sourceItem.sourceContrastDb;
    const crestDeltaDb =
      sourceItem.sourceCrestDb !== null && candidateItem.candidateCrestDb !== null
        ? candidateItem.candidateCrestDb - sourceItem.sourceCrestDb
        : null;
    retentionRatios.push(retentionRatio);
    contrastDeltas.push(contrastDeltaDb);
    if (crestDeltaDb !== null) crestDeltas.push(crestDeltaDb);
    if (
      retentionRatio < EXPRESSIVE_FLATTENED_RATIO ||
      contrastDeltaDb <= -EXPRESSIVE_FLATTENED_LOSS_DB
    ) {
      flattenedEventCount += 1;
      const firstFrame = event.frames[0];
      const finalFrame = event.frames[event.frames.length - 1];
      const contrastLossDb = -contrastDeltaDb;
      if (
        finite(retentionRatio) &&
        finite(contrastLossDb) &&
        contrastLossDb >= 0 &&
        (crestDeltaDb === null || finite(crestDeltaDb))
      ) {
        const flattenedEvent: FlattenedExpressiveEvent = {
          startSec: timelineSec(firstFrame),
          endSec: timelineSec(finalFrame + 1),
          centerSec: timelineSec(sourceItem.index + 0.5),
          sourceContrastDb: sourceItem.sourceContrastDb,
          candidateContrastDb: candidateItem.candidateContrastDb,
          retentionRatio,
          contrastLossDb,
          crestDeltaDb,
        };
        const insertionIndex = topFlattenedEvents.findIndex(
          (existing) => flattenedEventRanksBefore(flattenedEvent, existing),
        );
        if (insertionIndex < 0) {
          if (topFlattenedEvents.length < MAX_REPORTED_FLATTENED_EVENTS) {
            topFlattenedEvents = [...topFlattenedEvents, flattenedEvent];
          }
        } else {
          topFlattenedEvents = [
            ...topFlattenedEvents.slice(0, insertionIndex),
            flattenedEvent,
            ...topFlattenedEvents.slice(
              insertionIndex,
              MAX_REPORTED_FLATTENED_EVENTS - 1,
            ),
          ];
        }
      }
    }
  }

  if (contrasts.length === 0) notes.push("No frames had two-sided source-speech shoulders for local contrast.");
  if (expressiveEvents.length === 0) notes.push("No source-derived expressive emphasis events were detected.");

  return {
    schemaVersion: 1,
    advisoryOnly: true,
    frameMs: alignedSource.frameMs,
    alignedFrameCount,
    sourceSpeechFrameCount,
    alignment: {
      candidateLagFrames: alignment.candidateLagFrames,
      candidateLagMs: alignment.candidateLagFrames * alignedSource.frameMs,
      searchLimitMs: GLOBAL_ALIGNMENT_LIMIT_MS,
      scoreImprovementDb: alignment.scoreImprovementDb,
    },
    drift: buildDrift(
      alignedSource,
      alignedCandidate,
      speechMask,
      alignedFrameCount,
    ),
    spikes: {
      advisoryContrastDb: SPIKE_ADVISORY_CONTRAST_DB,
      supportedFrameCount: contrasts.length,
      up: upSpikes,
      down: downSpikes,
    },
    body: buildBody(
      alignedSource,
      alignedCandidate,
      bodySupportMask,
      expressiveFrames,
      alignedFrameCount,
    ),
    expressiveRetention: {
      sourceEventCount: expressiveEvents.length,
      evaluatedEventCount: retentionRatios.length,
      contrastRetentionP10Ratio: finitePercentile(retentionRatios, 10),
      medianContrastDeltaDb: finiteMedian(contrastDeltas),
      crestDeltaP10Db: finitePercentile(crestDeltas, 10),
      flattenedEventCount,
      flattenedRatioAdvisory: EXPRESSIVE_FLATTENED_RATIO,
      flattenedLossAdvisoryDb: EXPRESSIVE_FLATTENED_LOSS_DB,
      topFlattenedEvents,
    },
    notes,
  };
};
