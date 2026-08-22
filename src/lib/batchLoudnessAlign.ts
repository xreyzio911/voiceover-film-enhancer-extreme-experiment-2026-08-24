export const BATCH_SPEECH_ALIGN_TRIGGER_DB = 0.5;
export const BATCH_SPEECH_ALIGN_MAX_DB = 2.0;
export const BATCH_SPEECH_EVIDENCE_FULL_MAX_SECONDS = 180;
export const BATCH_SPEECH_EVIDENCE_WINDOW_SECONDS = 30;
export const BATCH_SPEECH_EVIDENCE_WINDOW_COUNT = 6;
export const BATCH_SPEECH_EVIDENCE_SCALED_MIN_SECONDS = 720;
export const BATCH_SPEECH_EVIDENCE_SCALED_WINDOW_SECONDS = 15;
export const BATCH_SPEECH_EVIDENCE_SCALED_MIN_WINDOWS = 13;
export const BATCH_SPEECH_EVIDENCE_SCALED_MAX_WINDOWS = 24;
export const BATCH_SPEECH_EVIDENCE_MAX_DECODE_SECONDS = 360;
export const BATCH_SPEECH_EVIDENCE_MIN_USABLE_WINDOWS = 4;
export const BATCH_SPEECH_PLATEAU_BLEND_START_SECONDS = 1;
export const BATCH_SPEECH_PLATEAU_BLEND_FULL_SECONDS = 15;

export type BatchSpeechLevelMeasurement = Readonly<{
  id: string;
  speechLevelDb: number | null;
  speechPlateauDb?: number | null;
  /** Direct 0..1 authority for blending the robust body plateau over speech power. */
  plateauBlendAuthority?: number | null;
  /** Positive, bounded-confidence vote used only when locating the batch anchor. */
  anchorVoteWeight?: number | null;
  /** @deprecated Legacy combined confidence; retained as a fail-open import/caller fallback. */
  evidenceWeight?: number | null;
}>;

export type BatchSpeechLevelEvidenceSummary = Readonly<{
  speechLevelDb: number;
  speechPlateauDb: number;
  plateauBlendAuthority: number;
  anchorVoteWeight: number;
  speechDurationSec: number;
  /** @deprecated Alias of anchorVoteWeight for older evidence consumers. */
  evidenceWeight: number;
  speechFrameCount: number;
}>;

export type BatchSpeechWindowEvidence = Readonly<{
  /** Historical K-weighted speech power for the bounded window. */
  speechLevelDb: number;
  /** Median speech-body frame level for the same window, when measurable. */
  speechBodyPlateauDb: number | null;
  /** Number of speech-body frames supporting the plateau estimate. */
  speechFrameCount: number;
  /** Explicit analysis-frame duration; prevents hidden coupling to a 10 ms caller. */
  speechFrameMs?: number | null;
  /** Optional direct duration for evidence producers that do not retain frame geometry. */
  speechDurationSec?: number | null;
}>;

export type BatchSpeechAlignmentPlan = Readonly<{
  id: string;
  speechLevelDb: number | null;
  /** Exact evidence lane used to compute this plan's offset. */
  alignmentLevelDb: number | null;
  offsetDb: number;
  shouldAlign: boolean;
}>;

export type SpeechEvidenceWindow = Readonly<{
  startSec: number;
  durationSec: number;
}>;

export type SpeechEvidenceSpan = Readonly<{
  startSec: number;
  endSec: number;
}>;

export type RankedSpeechEvidenceWindow = SpeechEvidenceWindow & Readonly<{
  occupancyPct: number;
}>;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const smoothUnitRamp = (value: number, start: number, full: number) => {
  const normalized = clamp((value - start) / Math.max(full - start, Number.EPSILON), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
};

const median = (values: readonly number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const percentileOfSorted = (values: readonly number[], fraction: number) => {
  if (values.length === 0) return null;
  const position = clamp(fraction, 0, 1) * (values.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (values[lower] === values[upper]) return values[lower];
  const mix = position - lower;
  return values[lower] * (1 - mix) + values[upper] * mix;
};

const finiteNumber = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const resolveBatchSpeechAlignmentLevelDb = (
  measurement: Readonly<{
    speechLevelDb: number | null;
    speechPlateauDb?: number | null;
    plateauBlendAuthority?: number | null;
    anchorVoteWeight?: number | null;
    evidenceWeight?: number | null;
  }>,
) =>
  finiteNumber(measurement.speechPlateauDb) && finiteNumber(measurement.speechLevelDb)
    ? measurement.speechLevelDb +
      (finiteNumber(measurement.plateauBlendAuthority)
        ? clamp(measurement.plateauBlendAuthority, 0, 1)
        : smoothUnitRamp(measurement.evidenceWeight ?? 1, 0.5, 1)) *
        (measurement.speechPlateauDb - measurement.speechLevelDb)
    : finiteNumber(measurement.speechPlateauDb)
      ? measurement.speechPlateauDb
      : measurement.speechLevelDb;

/**
 * Interpolate through normalized weighted-CDF midpoints. Unlike a stepwise
 * weighted median, a tiny vote change produces a tiny anchor change rather
 * than selecting one file's level wholesale.
 */
const interpolatedWeightedQuantile = (
  entries: readonly Readonly<{ value: number; weight: number }>[],
  fraction = 0.5,
) => {
  const finiteEntries = entries.filter(
    (entry) => finiteNumber(entry.value) && finiteNumber(entry.weight) && entry.weight > 0,
  );
  if (finiteEntries.length === 0) {
    return median(
      entries
        .map((entry) => entry.value)
        .filter((value): value is number => finiteNumber(value)),
    );
  }
  const ordered = [...finiteEntries].sort((left, right) => left.value - right.value);
  if (ordered.length === 1) return ordered[0].value;
  const totalWeight = ordered.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(totalWeight > 0)) return median(ordered.map((entry) => entry.value));
  const target = clamp(fraction, 0, 1);
  let cumulativeWeight = 0;
  const positioned = ordered.map((entry) => {
    const position = (cumulativeWeight + entry.weight / 2) / totalWeight;
    cumulativeWeight += entry.weight;
    return { value: entry.value, position };
  });
  if (target <= positioned[0].position) return positioned[0].value;
  for (let index = 1; index < positioned.length; index += 1) {
    const upper = positioned[index];
    if (target > upper.position) continue;
    const lower = positioned[index - 1];
    if (lower.value === upper.value) return lower.value;
    const mix = clamp(
      (target - lower.position) /
        Math.max(upper.position - lower.position, Number.EPSILON),
      0,
      1,
    );
    return lower.value * (1 - mix) + upper.value * mix;
  }
  return positioned.at(-1)?.value ?? null;
};

const resolveWindowSpeechDurationSec = (window: BatchSpeechWindowEvidence) => {
  if (finiteNumber(window.speechDurationSec) && window.speechDurationSec > 0) {
    return window.speechDurationSec;
  }
  if (
    finiteNumber(window.speechFrameCount) &&
    window.speechFrameCount > 0 &&
    finiteNumber(window.speechFrameMs) &&
    window.speechFrameMs > 0
  ) {
    return (window.speechFrameCount * window.speechFrameMs) / 1000;
  }
  return null;
};

const resolvePlateauBlendAuthority = (
  speechDurationSec: number,
  fallbackEvidenceWeight: number,
) => speechDurationSec > 0
  ? smoothUnitRamp(
      speechDurationSec,
      BATCH_SPEECH_PLATEAU_BLEND_START_SECONDS,
      BATCH_SPEECH_PLATEAU_BLEND_FULL_SECONDS,
    )
  : smoothUnitRamp(fallbackEvidenceWeight, 0.5, 1);

const resolveAnchorVoteWeightFromDuration = (
  speechDurationSec: number,
  fallbackEvidenceWeight: number,
) => speechDurationSec > 0
  ? clamp(Math.sqrt(speechDurationSec / 120), 0.5, 2)
  : clamp(fallbackEvidenceWeight, 0.5, 2);

const resolveMeasurementAnchorVoteWeight = (measurement: BatchSpeechLevelMeasurement) => {
  if (finiteNumber(measurement.anchorVoteWeight) && measurement.anchorVoteWeight > 0) {
    return measurement.anchorVoteWeight;
  }
  if (finiteNumber(measurement.evidenceWeight) && measurement.evidenceWeight > 0) {
    return measurement.evidenceWeight;
  }
  return 1;
};

export const summarizeBatchSpeechLevelEvidence = (
  windows: readonly BatchSpeechWindowEvidence[],
): BatchSpeechLevelEvidenceSummary | null => {
  const finiteWindows = windows.filter((window) => finiteNumber(window.speechLevelDb));
  if (finiteWindows.length === 0) return null;
  const orderedSpeechLevelsDb = finiteWindows
    .map((window) => window.speechLevelDb)
    .sort((left, right) => left - right);
  const speechLevelDb = percentileOfSorted(orderedSpeechLevelsDb, 0.5);
  if (!finiteNumber(speechLevelDb)) return null;
  const plateauWindows = finiteWindows
    .filter(
      (window) =>
        finiteNumber(window.speechBodyPlateauDb) &&
        finiteNumber(window.speechFrameCount) &&
        window.speechFrameCount > 0,
    );
  const plateauEvidence = plateauWindows.map((window) => ({
    window,
    speechDurationSec: resolveWindowSpeechDurationSec(window),
  }));
  const hasCompleteDurationEvidence =
    plateauEvidence.length > 0 &&
    plateauEvidence.every(
      (entry) => finiteNumber(entry.speechDurationSec) && entry.speechDurationSec > 0,
    );
  const plateauEntries = plateauEvidence
    .map(({ window, speechDurationSec }) => {
      return {
        value: window.speechBodyPlateauDb as number,
        weight: hasCompleteDurationEvidence ? (speechDurationSec as number) : 1,
        speechFrameCount: window.speechFrameCount,
      };
    });
  const speechPlateauDb = interpolatedWeightedQuantile(plateauEntries) ?? speechLevelDb;
  const speechDurationSec = hasCompleteDurationEvidence
    ? plateauEvidence.reduce(
        (total, entry) => total + (entry.speechDurationSec as number),
        0,
      )
    : 0;
  const speechFrameCount = plateauEntries.reduce(
    (total, entry) => total + entry.speechFrameCount,
    0,
  );
  const fallbackEvidenceWeight = clamp(
    finiteWindows.length / BATCH_SPEECH_EVIDENCE_MIN_USABLE_WINDOWS,
    0.5,
    2,
  );
  const plateauBlendAuthority = resolvePlateauBlendAuthority(
    speechDurationSec,
    fallbackEvidenceWeight,
  );
  const anchorVoteWeight = resolveAnchorVoteWeightFromDuration(
    speechDurationSec,
    fallbackEvidenceWeight,
  );
  return {
    speechLevelDb,
    speechPlateauDb,
    plateauBlendAuthority,
    anchorVoteWeight,
    speechDurationSec,
    evidenceWeight: anchorVoteWeight,
    speechFrameCount,
  };
};

export const summarizeBatchSpeechGroupEvidence = (
  measurements: readonly BatchSpeechLevelEvidenceSummary[],
): BatchSpeechLevelEvidenceSummary | null => {
  const finiteMeasurements = measurements.filter(
    (measurement) =>
      finiteNumber(measurement.speechLevelDb) &&
      finiteNumber(measurement.speechPlateauDb),
  );
  if (finiteMeasurements.length === 0) return null;
  const hasCompleteDurationEvidence = finiteMeasurements.every(
    (measurement) =>
      finiteNumber(measurement.speechDurationSec) && measurement.speechDurationSec > 0,
  );
  const hasNoDurationEvidence = finiteMeasurements.every(
    (measurement) =>
      !finiteNumber(measurement.speechDurationSec) || measurement.speechDurationSec <= 0,
  );
  const hasCompleteLegacyFrameEvidence = finiteMeasurements.every(
    (measurement) =>
      finiteNumber(measurement.speechFrameCount) && measurement.speechFrameCount > 0,
  );
  const measurementWeight = (measurement: BatchSpeechLevelEvidenceSummary) =>
    hasCompleteDurationEvidence
      ? measurement.speechDurationSec
      : hasNoDurationEvidence && hasCompleteLegacyFrameEvidence
        ? measurement.speechFrameCount
        : 1;
  const speechLevelDb = interpolatedWeightedQuantile(
    finiteMeasurements.map((measurement) => ({
      value: measurement.speechLevelDb,
      weight: measurementWeight(measurement),
    })),
  );
  if (!finiteNumber(speechLevelDb)) return null;
  const plateauEntries = finiteMeasurements
    .filter(
      (measurement) =>
        finiteNumber(measurement.speechFrameCount) &&
        measurement.speechFrameCount > 0,
    )
    .map((measurement) => ({
      value: measurement.speechPlateauDb,
      weight: measurementWeight(measurement),
    }));
  const speechFrameCount = finiteMeasurements.reduce(
    (total, measurement) => total + (
      finiteNumber(measurement.speechFrameCount) && measurement.speechFrameCount > 0
        ? measurement.speechFrameCount
        : 0
    ),
    0,
  );
  const speechPlateauDb =
    interpolatedWeightedQuantile(plateauEntries) ??
    median(finiteMeasurements.map((measurement) => measurement.speechPlateauDb)) ??
    speechLevelDb;
  const speechDurationSec = hasCompleteDurationEvidence
    ? finiteMeasurements.reduce(
        (total, measurement) => total + measurement.speechDurationSec,
        0,
      )
    : 0;
  const fallbackAnchorVoteWeight =
    finiteMeasurements.reduce(
      (total, measurement) =>
        total + (
          finiteNumber(measurement.anchorVoteWeight)
            ? measurement.anchorVoteWeight
            : finiteNumber(measurement.evidenceWeight)
              ? measurement.evidenceWeight
              : 1
        ),
      0,
    ) / finiteMeasurements.length;
  const fallbackPlateauBlendAuthority =
    finiteMeasurements.reduce(
      (total, measurement) =>
        total + (
          finiteNumber(measurement.plateauBlendAuthority)
            ? clamp(measurement.plateauBlendAuthority, 0, 1)
            : smoothUnitRamp(measurement.evidenceWeight ?? 1, 0.5, 1)
        ),
      0,
    ) / finiteMeasurements.length;
  const plateauBlendAuthority = hasCompleteDurationEvidence
    ? resolvePlateauBlendAuthority(speechDurationSec, fallbackAnchorVoteWeight)
    : hasNoDurationEvidence
      ? clamp(fallbackPlateauBlendAuthority, 0, 1)
      : 0;
  const anchorVoteWeight = resolveAnchorVoteWeightFromDuration(
    speechDurationSec,
    fallbackAnchorVoteWeight,
  );
  return {
    speechLevelDb,
    speechPlateauDb,
    plateauBlendAuthority,
    anchorVoteWeight,
    speechDurationSec,
    evidenceWeight: anchorVoteWeight,
    speechFrameCount,
  };
};

export const planBatchSpeechAlignment = (
  measurements: readonly BatchSpeechLevelMeasurement[],
  options?: {
    triggerDb?: number;
    maxOffsetDb?: number;
  },
): {
  anchorDb: number | null;
  plans: readonly BatchSpeechAlignmentPlan[];
} => {
  const triggerDb = options?.triggerDb ?? BATCH_SPEECH_ALIGN_TRIGGER_DB;
  const maxOffsetDb = options?.maxOffsetDb ?? BATCH_SPEECH_ALIGN_MAX_DB;
  const measured = measurements
    .map((measurement) => {
      const value = resolveBatchSpeechAlignmentLevelDb(measurement);
      if (!finiteNumber(value)) return null;
      return {
        value,
        weight: resolveMeasurementAnchorVoteWeight(measurement),
      };
    })
    .filter((value): value is Readonly<{ value: number; weight: number }> => value !== null);
  const anchorDb = measured.length >= 2
    ? interpolatedWeightedQuantile(measured)
    : null;

  return {
    anchorDb,
    plans: measurements.map((measurement) => {
      const alignmentLevelDb = resolveBatchSpeechAlignmentLevelDb(measurement);
      if (
        anchorDb === null ||
        !finiteNumber(alignmentLevelDb)
      ) {
        return {
          id: measurement.id,
          speechLevelDb: measurement.speechLevelDb,
          alignmentLevelDb: finiteNumber(alignmentLevelDb) ? alignmentLevelDb : null,
          offsetDb: 0,
          shouldAlign: false,
        };
      }
      const rawOffsetDb = anchorDb - alignmentLevelDb;
      const shouldAlign = Math.abs(rawOffsetDb) > triggerDb;
      return {
        id: measurement.id,
        speechLevelDb: measurement.speechLevelDb,
        alignmentLevelDb,
        offsetDb: shouldAlign ? clamp(rawOffsetDb, -maxOffsetDb, maxOffsetDb) : 0,
        shouldAlign,
      };
    }),
  };
};

const overlapSeconds = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

const speechOccupancyPctInWindow = (
  speechSpans: readonly SpeechEvidenceSpan[],
  startSec: number,
  durationSec: number,
) => {
  const endSec = startSec + durationSec;
  const speechSeconds = speechSpans.reduce((total, span) => (
    total + overlapSeconds(startSec, endSec, span.startSec, span.endSec)
  ), 0);
  return (speechSeconds / Math.max(durationSec, 1e-6)) * 100;
};

/**
 * Rank bounded windows by known speech occupancy while retaining broad
 * timeline coverage. This is shared by analysis and final batch alignment so
 * both paths use the same deterministic speech-aware placement.
 */
export const selectDistributedSpeechEvidenceWindowsWithConfig = (
  speechSpans: readonly SpeechEvidenceSpan[],
  durationSec: number,
  windowSec: number,
  targetCount: number,
): readonly RankedSpeechEvidenceWindow[] => {
  if (
    !Number.isFinite(durationSec) ||
    durationSec <= 0 ||
    !Number.isFinite(windowSec) ||
    windowSec <= 0 ||
    !Number.isFinite(targetCount) ||
    targetCount < 1
  ) {
    return [];
  }

  const safeWindowSec = Math.min(windowSec, durationSec);
  const safeTargetCount = Math.max(1, Math.floor(targetCount));
  const maxStart = Math.max(0, durationSec - safeWindowSec);

  type Candidate = Readonly<{
    startSec: number;
    occupancyPct: number;
    centerSec: number;
    spanLenSec: number;
  }>;
  const candidates: Candidate[] = [];
  for (const span of speechSpans) {
    if (!Number.isFinite(span.startSec) || !Number.isFinite(span.endSec)) continue;
    const spanLenSec = span.endSec - span.startSec;
    if (spanLenSec <= 0.05) continue;
    const stepSec = spanLenSec > safeWindowSec
      ? Math.max(10, safeWindowSec * 0.75)
      : spanLenSec;
    const centerStart = span.startSec + spanLenSec / 2;
    for (let timeSec = span.startSec; timeSec <= span.endSec; timeSec += stepSec) {
      const centerSec = clamp(timeSec, span.startSec, span.endSec);
      const startSec = clamp(centerSec - safeWindowSec / 2, 0, maxStart);
      candidates.push({
        startSec,
        occupancyPct: speechOccupancyPctInWindow(speechSpans, startSec, safeWindowSec),
        centerSec,
        spanLenSec,
      });
    }
    const centeredStart = clamp(centerStart - safeWindowSec / 2, 0, maxStart);
    candidates.push({
      startSec: centeredStart,
      occupancyPct: speechOccupancyPctInWindow(speechSpans, centeredStart, safeWindowSec),
      centerSec: centerStart,
      spanLenSec,
    });
  }

  if (candidates.length === 0) {
    const count = Math.min(
      safeTargetCount,
      Math.max(1, Math.ceil(durationSec / safeWindowSec)),
    );
    return Array.from({ length: count }, (_, index) => {
      const ratio = count === 1 ? 0 : index / (count - 1);
      const startSec = clamp(ratio * maxStart, 0, maxStart);
      return {
        startSec: Number(startSec.toFixed(6)),
        durationSec: Number(Math.min(safeWindowSec, durationSec - startSec).toFixed(6)),
        occupancyPct: 0,
      };
    });
  }

  const buckets = new Map<number, Candidate[]>();
  for (const candidate of candidates) {
    const bucketIndex = clamp(
      Math.floor((candidate.centerSec / Math.max(durationSec, 1e-6)) * safeTargetCount),
      0,
      safeTargetCount - 1,
    );
    const bucket = buckets.get(bucketIndex) ?? [];
    bucket.push(candidate);
    buckets.set(bucketIndex, bucket);
  }

  const selected: Candidate[] = [];
  for (let bucketIndex = 0; bucketIndex < safeTargetCount; bucketIndex += 1) {
    const bucket = buckets.get(bucketIndex);
    if (!bucket || bucket.length === 0) continue;
    bucket.sort((a, b) => b.occupancyPct - a.occupancyPct || a.startSec - b.startSec);
    selected.push(bucket[0]);
  }

  const selectedKeys = new Set(selected.map((candidate) => candidate.startSec.toFixed(2)));
  const remaining = [...candidates]
    .filter((candidate) => !selectedKeys.has(candidate.startSec.toFixed(2)))
    .sort((a, b) => b.occupancyPct - a.occupancyPct || a.startSec - b.startSec);
  for (const candidate of remaining) {
    if (selected.length >= safeTargetCount) break;
    if (
      selected.some((picked) => Math.abs(picked.startSec - candidate.startSec) < safeWindowSec * 0.35)
    ) {
      continue;
    }
    selected.push(candidate);
  }

  const speechBearing = selected.filter((candidate) => candidate.occupancyPct >= 12);
  const finalCandidates = speechBearing.length > 0 ? speechBearing : selected;
  finalCandidates.sort((a, b) => a.startSec - b.startSec);
  return finalCandidates
    .slice(0, safeTargetCount)
    .map((candidate) => ({
      startSec: candidate.startSec,
      durationSec: Math.min(safeWindowSec, Math.max(1, durationSec - candidate.startSec)),
      occupancyPct: candidate.occupancyPct,
    }));
};

/**
 * Keep exact full-output speech evidence for short renders. Without a known
 * speech map, preserve the established uniform medium/very-long routes. When
 * full-file speech spans are available, prefer occupancy-ranked 30 s windows,
 * still capped at six minutes of decoded material.
 */
export const planDistributedSpeechEvidenceWindows = (
  durationSec: number,
  speechSpans: readonly SpeechEvidenceSpan[] = [],
): readonly SpeechEvidenceWindow[] => {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  if (durationSec <= BATCH_SPEECH_EVIDENCE_FULL_MAX_SECONDS) {
    return [{ startSec: 0, durationSec }];
  }

  const useScaledEvidence = durationSec > BATCH_SPEECH_EVIDENCE_SCALED_MIN_SECONDS;
  const windowDurationSec = useScaledEvidence
    ? BATCH_SPEECH_EVIDENCE_SCALED_WINDOW_SECONDS
    : BATCH_SPEECH_EVIDENCE_WINDOW_SECONDS;
  const windowCount = useScaledEvidence
    ? Math.min(
      BATCH_SPEECH_EVIDENCE_SCALED_MAX_WINDOWS,
      Math.max(
        BATCH_SPEECH_EVIDENCE_SCALED_MIN_WINDOWS,
        Math.ceil(durationSec / 60),
      ),
    )
    : BATCH_SPEECH_EVIDENCE_WINDOW_COUNT;
  const finalStartSec = Math.max(0, durationSec - windowDurationSec);
  const uniformWindows = Array.from(
    { length: windowCount },
    (_, index): SpeechEvidenceWindow => ({
      startSec: Number(
        ((finalStartSec * index) / (windowCount - 1)).toFixed(6),
      ),
      durationSec: Number(windowDurationSec.toFixed(6)),
    }),
  );

  if (speechSpans.length === 0) return uniformWindows;
  const speechAwareWindowSec = BATCH_SPEECH_EVIDENCE_WINDOW_SECONDS;
  const speechAwareTargetCount = Math.min(
    Math.floor(BATCH_SPEECH_EVIDENCE_MAX_DECODE_SECONDS / speechAwareWindowSec),
    windowCount,
  );
  const speechAwareWindows = selectDistributedSpeechEvidenceWindowsWithConfig(
    speechSpans,
    durationSec,
    speechAwareWindowSec,
    speechAwareTargetCount,
  );
  return speechAwareWindows.length > 0 ? speechAwareWindows : uniformWindows;
};

export const hasSufficientBatchSpeechEvidence = (
  windows: readonly SpeechEvidenceWindow[],
  usableWindowCount: number,
  durationSec: number,
) => {
  if (!Number.isFinite(usableWindowCount) || usableWindowCount < 1) return false;
  const fullFileCoverage =
    windows.length === 1 &&
    windows[0].startSec <= 0.001 &&
    windows[0].startSec + windows[0].durationSec >= durationSec - 0.001;
  return fullFileCoverage || usableWindowCount >= BATCH_SPEECH_EVIDENCE_MIN_USABLE_WINDOWS;
};
