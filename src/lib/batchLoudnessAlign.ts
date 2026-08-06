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

export type BatchSpeechLevelMeasurement = Readonly<{
  id: string;
  speechLevelDb: number | null;
}>;

export type BatchSpeechAlignmentPlan = Readonly<{
  id: string;
  speechLevelDb: number | null;
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

const median = (values: readonly number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
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
    .map((measurement) => measurement.speechLevelDb)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const anchorDb = measured.length >= 2 ? median(measured) : null;

  return {
    anchorDb,
    plans: measurements.map((measurement) => {
      if (
        anchorDb === null ||
        typeof measurement.speechLevelDb !== "number" ||
        !Number.isFinite(measurement.speechLevelDb)
      ) {
        return {
          id: measurement.id,
          speechLevelDb: measurement.speechLevelDb,
          offsetDb: 0,
          shouldAlign: false,
        };
      }
      const rawOffsetDb = anchorDb - measurement.speechLevelDb;
      const shouldAlign = Math.abs(rawOffsetDb) > triggerDb;
      return {
        id: measurement.id,
        speechLevelDb: measurement.speechLevelDb,
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
