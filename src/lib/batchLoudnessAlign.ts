export const BATCH_SPEECH_ALIGN_TRIGGER_DB = 0.5;
export const BATCH_SPEECH_ALIGN_MAX_DB = 2.0;
export const BATCH_SPEECH_EVIDENCE_FULL_MAX_SECONDS = 180;
export const BATCH_SPEECH_EVIDENCE_WINDOW_SECONDS = 30;
export const BATCH_SPEECH_EVIDENCE_WINDOW_COUNT = 6;

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
 * Keep exact full-output speech evidence for short renders while bounding
 * long-output decoding to six evenly distributed 30-second windows.
 */
export const planDistributedSpeechEvidenceWindows = (
  durationSec: number,
): readonly SpeechEvidenceWindow[] => {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  if (durationSec <= BATCH_SPEECH_EVIDENCE_FULL_MAX_SECONDS) {
    return [{ startSec: 0, durationSec }];
  }

  const windowDurationSec = Math.min(BATCH_SPEECH_EVIDENCE_WINDOW_SECONDS, durationSec);
  const finalStartSec = Math.max(0, durationSec - windowDurationSec);
  return Array.from(
    { length: BATCH_SPEECH_EVIDENCE_WINDOW_COUNT },
    (_, index): SpeechEvidenceWindow => ({
      startSec: Number(
        ((finalStartSec * index) / (BATCH_SPEECH_EVIDENCE_WINDOW_COUNT - 1)).toFixed(6),
      ),
      durationSec: Number(windowDurationSec.toFixed(6)),
    }),
  );
};
