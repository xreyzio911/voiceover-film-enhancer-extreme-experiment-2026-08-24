export type LimiterObservabilityKind = "alimiter" | "loudnorm" | "composite";

export type LimiterObservabilityStage = Readonly<{
  schemaVersion: 1;
  /** This evidence may inform later tuning but never accepts or rejects audio. */
  advisoryOnly: true;
  measurementStatus: "measured" | "unavailable";
  stageId: string;
  limiterKind: LimiterObservabilityKind;
  ceilingDb: number | null;
  inputTruePeakDb: number | null;
  outputTruePeakDb: number | null;
  plannedStaticGainDb: number | null;
  /** Input true peak plus a known static gain, before the limiter ceiling. */
  predictedPreLimiterPeakDb: number | null;
  /** Predicted amount above the ceiling; this is not measured gain reduction. */
  estimatedCeilingDriveDb: number | null;
  /** Positive means the measured output remains below the configured ceiling. */
  outputCeilingMarginDb: number | null;
  notes: readonly string[];
}>;

const finiteOrNull = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const buildLimiterObservabilityStage = ({
  stageId,
  limiterKind,
  ceilingDb,
  inputTruePeakDb,
  outputTruePeakDb,
  plannedStaticGainDb,
  notes = [],
}: Readonly<{
  stageId: string;
  limiterKind: LimiterObservabilityKind;
  ceilingDb: number | null | undefined;
  inputTruePeakDb: number | null | undefined;
  outputTruePeakDb: number | null | undefined;
  plannedStaticGainDb: number | null | undefined;
  notes?: readonly string[];
}>): LimiterObservabilityStage => {
  const safeCeilingDb = finiteOrNull(ceilingDb);
  const safeInputTruePeakDb = finiteOrNull(inputTruePeakDb);
  const safeOutputTruePeakDb = finiteOrNull(outputTruePeakDb);
  const safePlannedStaticGainDb = finiteOrNull(plannedStaticGainDb);
  const predictedPreLimiterPeakDb =
    safeCeilingDb !== null &&
    safeInputTruePeakDb !== null &&
    safePlannedStaticGainDb !== null
      ? safeInputTruePeakDb + safePlannedStaticGainDb
      : null;
  const estimatedCeilingDriveDb =
    predictedPreLimiterPeakDb !== null && safeCeilingDb !== null
      ? Math.max(0, predictedPreLimiterPeakDb - safeCeilingDb)
      : null;
  const outputCeilingMarginDb =
    safeOutputTruePeakDb !== null && safeCeilingDb !== null
      ? safeCeilingDb - safeOutputTruePeakDb
      : null;

  return Object.freeze({
    schemaVersion: 1,
    advisoryOnly: true,
    measurementStatus:
      safeInputTruePeakDb !== null || safeOutputTruePeakDb !== null
        ? "measured"
        : "unavailable",
    stageId,
    limiterKind,
    ceilingDb: safeCeilingDb,
    inputTruePeakDb: safeInputTruePeakDb,
    outputTruePeakDb: safeOutputTruePeakDb,
    plannedStaticGainDb: safePlannedStaticGainDb,
    predictedPreLimiterPeakDb,
    estimatedCeilingDriveDb,
    outputCeilingMarginDb,
    notes: Object.freeze([...notes]),
  });
};

const formatDb = (value: number | null) =>
  value === null ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(2)} dB`;

export const formatLimiterObservabilityStage = (
  stage: LimiterObservabilityStage,
) => {
  if (stage.measurementStatus === "unavailable") {
    return `[LimiterAudit] ${stage.stageId}: peak evidence unavailable; advisory only.`;
  }
  return `[LimiterAudit] ${stage.stageId}: input TP ${formatDb(
    stage.inputTruePeakDb,
  )}, planned static ${formatDb(stage.plannedStaticGainDb)}, predicted pre-limit ${formatDb(
    stage.predictedPreLimiterPeakDb,
  )}, ceiling drive ${formatDb(stage.estimatedCeilingDriveDb)}, output TP ${formatDb(
    stage.outputTruePeakDb,
  )}, output margin ${formatDb(stage.outputCeilingMarginDb)}; advisory only.`;
};
