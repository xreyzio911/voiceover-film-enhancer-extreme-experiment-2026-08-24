export const BATCH_SPEECH_ALIGN_TRIGGER_DB = 0.5;
export const BATCH_SPEECH_ALIGN_MAX_DB = 2.0;
export const BATCH_SPEECH_EVIDENCE_FULL_MAX_SECONDS = 180;
export const BATCH_SPEECH_EVIDENCE_WINDOW_SECONDS = 30;
export const BATCH_SPEECH_EVIDENCE_WINDOW_COUNT = 6;
export const BATCH_SPEECH_EVIDENCE_SCALED_MIN_SECONDS = 720;
export const BATCH_SPEECH_EVIDENCE_SCALED_WINDOW_SECONDS = 15;
export const BATCH_SPEECH_EVIDENCE_SCALED_MIN_WINDOWS = 13;
export const BATCH_SPEECH_EVIDENCE_SCALED_MAX_WINDOWS = 24;

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

/**
 * Keep exact full-output speech evidence for short renders and the established
 * six-window route for medium renders. Very long files receive proportionally
 * more, shorter windows without ever reducing the prior 180-second evidence
 * budget, capped at six minutes of decoded material.
 */
export const planDistributedSpeechEvidenceWindows = (
  durationSec: number,
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
  return Array.from(
    { length: windowCount },
    (_, index): SpeechEvidenceWindow => ({
      startSec: Number(
        ((finalStartSec * index) / (windowCount - 1)).toFixed(6),
      ),
      durationSec: Number(windowDurationSec.toFixed(6)),
    }),
  );
};
