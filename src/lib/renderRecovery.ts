"use client";

export type RenderPath =
  | "speech-pause-segmented"
  | "speech-aligned-segmented"
  | "fixed-segmented"
  | "single-pass"
  | "single-pass-recovered";

export type DegradeReason =
  | "segment-render-memory-fault"
  | "analysis-window-retry"
  | "analysis-window-drop"
  | "qc-unavailable"
  | "planner-required"
  | "planner-apply-failed"
  | "audibility-dropout-guard"
  | "source-safe-recovery"
  | "single-pass-recovery";

export type CandidateScore = {
  stability: number;
  pause: number;
  compression: number;
  echo: number;
  total: number;
  /** False means the numeric value is only an internal ranking fallback and must not be presented as measured. */
  metricAvailability?: CandidateScoreMetricAvailability;
  /** Whether the acoustic metrics were actually observed. Missing means measured for legacy callers. */
  measurementStatus?: CandidateMeasurementStatus;
  hardGatePenalty?: number;
  learnedAdjustment?: number;
  rankingScore?: number;
  gateReasons?: string[];
};

export type CandidateMeasurementStatus = "measured" | "partial" | "unavailable";

export type CandidateScoreMetric = "stability" | "pause" | "compression" | "echo";

export type CandidateScoreMetricAvailability = Readonly<Record<CandidateScoreMetric, boolean>>;

export type CandidateMeasurementWindowSummary = Readonly<{
  analysisWindowsAttempted?: number | null;
  analysisWindowsSucceeded?: number | null;
  analysisWindowsDropped?: number | null;
}>;

export type CandidateAcousticMeasurement = CandidateMeasurementWindowSummary & Readonly<{
  instabilityScore?: number | null;
  lineSwingScore?: number | null;
  sentenceJumpScore?: number | null;
  breathSpikeRisk?: number | null;
  onsetOvershootScore?: number | null;
  midLineSagScore?: number | null;
  endFadeRiskScore?: number | null;
  pauseNoiseRisk?: number | null;
  pauseNoiseFloorDb?: number | null;
  compressionScore?: number | null;
  echoScore?: number | null;
}>;

const CANDIDATE_ACOUSTIC_FIELDS = [
  "instabilityScore",
  "lineSwingScore",
  "sentenceJumpScore",
  "breathSpikeRisk",
  "onsetOvershootScore",
  "midLineSagScore",
  "endFadeRiskScore",
  "pauseNoiseRisk",
  "pauseNoiseFloorDb",
  "compressionScore",
  "echoScore",
] as const satisfies ReadonlyArray<keyof CandidateAcousticMeasurement>;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

const weightedObservedMean = (
  components: ReadonlyArray<readonly [value: number | null | undefined, weight: number]>,
): number | null => {
  let weightedTotal = 0;
  let observedWeight = 0;
  for (const [value, weight] of components) {
    if (!isFiniteNumber(value)) continue;
    weightedTotal += clampUnit(value) * weight;
    observedWeight += weight;
  }
  return observedWeight > 0 ? weightedTotal / observedWeight : null;
};

/**
 * Whole-file measurements may describe the file as measured. Any distributed
 * window plan is sampled evidence, even when every planned window succeeds,
 * so it remains partial instead of gaining file-wide corrective authority.
 */
export const resolveCandidateMeasurementStatus = (
  summary: CandidateAcousticMeasurement,
): Exclude<CandidateMeasurementStatus, "unavailable"> => {
  const hasSampledWindows = [
    summary.analysisWindowsAttempted,
    summary.analysisWindowsSucceeded,
    summary.analysisWindowsDropped,
  ].some((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
  const hasCompleteAcousticEvidence = CANDIDATE_ACOUSTIC_FIELDS.every((field) =>
    isFiniteNumber(summary[field])
  );
  return hasSampledWindows || !hasCompleteAcousticEvidence ? "partial" : "measured";
};

/**
 * Scores only evidence that was actually measured. A partial composite is
 * renormalized over its observed members; absent categories receive a masked
 * neutral fallback solely so legacy scalar ranking remains total.
 */
export const buildCandidateScoreFromAnalysis = (
  analysis: CandidateAcousticMeasurement | null,
): CandidateScore => {
  if (!analysis) {
    return {
      stability: 1,
      pause: 1,
      compression: 1,
      echo: 1,
      total: 1111,
      metricAvailability: {
        stability: false,
        pause: false,
        compression: false,
        echo: false,
      },
      measurementStatus: "unavailable",
    };
  }

  const stabilityMeasured = weightedObservedMean([
    [analysis.instabilityScore, 0.24],
    [analysis.lineSwingScore, 0.16],
    [analysis.sentenceJumpScore, 0.2],
    [analysis.breathSpikeRisk, 0.12],
    [analysis.onsetOvershootScore, 0.12],
    [analysis.midLineSagScore, 0.1],
    [analysis.endFadeRiskScore, 0.06],
  ]);
  const pauseFloorRisk = isFiniteNumber(analysis.pauseNoiseFloorDb)
    ? clampUnit((analysis.pauseNoiseFloorDb + 62) / 18)
    : null;
  const pauseMeasured = weightedObservedMean([
    [analysis.pauseNoiseRisk, 0.58],
    [analysis.breathSpikeRisk, 0.24],
    [pauseFloorRisk, 0.18],
  ]);
  const compressionMeasured = isFiniteNumber(analysis.compressionScore)
    ? clampUnit(analysis.compressionScore)
    : null;
  const echoMeasured = isFiniteNumber(analysis.echoScore) ? clampUnit(analysis.echoScore) : null;
  const measuredCategories = [
    stabilityMeasured,
    pauseMeasured,
    compressionMeasured,
    echoMeasured,
  ].filter(isFiniteNumber);
  const maskedFallback = measuredCategories.length > 0
    ? measuredCategories.reduce((sum, value) => sum + value, 0) / measuredCategories.length
    : 0.5;

  const stability = stabilityMeasured ?? maskedFallback;
  const pause = pauseMeasured ?? maskedFallback;
  const compression = compressionMeasured ?? maskedFallback;
  const echo = echoMeasured ?? maskedFallback;
  const total = stability * 1000 + pause * 100 + compression * 10 + echo;
  return {
    stability,
    pause,
    compression,
    echo,
    total,
    metricAvailability: {
      stability: stabilityMeasured !== null,
      pause: pauseMeasured !== null,
      compression: compressionMeasured !== null,
      echo: echoMeasured !== null,
    },
    measurementStatus: resolveCandidateMeasurementStatus(analysis),
  };
};

export const summarizeCandidateScore = (score: CandidateScore) => {
  const rankingSuffix =
    typeof score.rankingScore === "number" && Number.isFinite(score.rankingScore)
      ? ` / rank ${score.rankingScore.toFixed(1)}`
      : "";
  const gateSuffix = score.gateReasons && score.gateReasons.length > 0
    ? ` / gates ${score.gateReasons.join("+")}`
    : "";

  if (score.measurementStatus === "unavailable") {
    return `QC unavailable${rankingSuffix}${gateSuffix}`;
  }

  const formatMetric = (metric: CandidateScoreMetric, value: number) =>
    score.metricAvailability?.[metric] === false ? "n/a" : (value * 100).toFixed(0);
  const metrics = `stability ${formatMetric("stability", score.stability)} / pause ${formatMetric(
    "pause",
    score.pause,
  )} / compression ${formatMetric("compression", score.compression)} / echo ${formatMetric(
    "echo",
    score.echo,
  )}`;
  const riskLabel = score.measurementStatus === "partial"
    ? "QC partial risks (lower is better): "
    : "QC risks (lower is better): ";
  return `${riskLabel}${metrics}${rankingSuffix}${gateSuffix}`;
};

export type CandidateRenderMeta = {
  strategyLabel: string;
  renderPath: RenderPath;
  segmentedHealthy: boolean;
  degraded: boolean;
  degradeReasons: DegradeReason[];
  analysisWindowsAttempted: number;
  analysisWindowsSucceeded: number;
  analysisWindowsDropped: number;
};

const normalizedWindowCount = (value: number | null | undefined, fallback: number) =>
  isFiniteNumber(value) ? Math.max(0, Math.trunc(value)) : fallback;

export const applyCandidateMeasurementWindowSummary = (
  meta: CandidateRenderMeta,
  summary: CandidateMeasurementWindowSummary,
): CandidateRenderMeta => ({
  ...meta,
  analysisWindowsAttempted: normalizedWindowCount(
    summary.analysisWindowsAttempted,
    meta.analysisWindowsAttempted,
  ),
  analysisWindowsSucceeded: normalizedWindowCount(
    summary.analysisWindowsSucceeded,
    meta.analysisWindowsSucceeded,
  ),
  analysisWindowsDropped: normalizedWindowCount(
    summary.analysisWindowsDropped,
    meta.analysisWindowsDropped,
  ),
});

export type RenderRiskProfile = {
  level: "normal" | "high";
  durationSeconds: number;
  longSparseMode: boolean;
  plannedSegmentCount: number;
  speechSpanCount: number;
  candidateVariant: "cinematic-stable" | "continuity-safe" | "pause-safe" | "source-safe";
  useRoomCleanup: boolean;
  useAdaptiveNoiseReduction: boolean;
  priorFatalRenderError: boolean;
  targetProcessedSegmentCount: number;
  mergePauseThresholdSec: number;
  disableSegmentGainMatch: boolean;
  recycleWorkerBeforeRender: boolean;
  shouldUseFixedSegmentation: boolean;
};

export type QcUnavailableFallbackCandidate<TVariant extends string = string> = {
  variant: TVariant;
  index: number;
  hasAudio: boolean;
  meta: CandidateRenderMeta;
  score: CandidateScore;
};

export type QcUnavailableFallbackSelection<TVariant extends string = string> = {
  candidate: QcUnavailableFallbackCandidate<TVariant>;
  reason: string;
};

export type RenderFallbackStrategyLike = {
  label: string;
};

export const PLANNER_TAIL_SAFE_STRATEGY_LABEL = "planner-tail-safe single-pass";
export const AUDIBILITY_SAFE_STRATEGY_LABEL = "audibility-safe single-pass";
export const ENHANCED_LINEAR_RECOVERY_STRATEGY_LABEL = "peak-safe linear recovery";

type RenderRiskInput = {
  durationSeconds: number;
  longSparseMode: boolean;
  plannedSegmentCount: number;
  speechSpanCount: number;
  candidateVariant: "cinematic-stable" | "continuity-safe" | "pause-safe" | "source-safe";
  useRoomCleanup: boolean;
  useAdaptiveNoiseReduction: boolean;
  priorFatalRenderError: boolean;
  sentenceJumpScore: number;
  mergedSegmentCount?: number | null;
};

const HEALTHY_SEGMENTED_STABILITY_DELTA = 0.03;
const HEALTHY_SEGMENTED_PAUSE_DELTA = 0.03;
const HEALTHY_SEGMENTED_COMPRESSION_DELTA = 0.05;
const QC_ONLY_DEGRADE_REASONS = new Set<DegradeReason>([
  "analysis-window-retry",
  "analysis-window-drop",
  "qc-unavailable",
]);
const TECHNICAL_SAFETY_GATE_REASONS = new Set([
  "duration-mismatch",
  "timing-offset",
  "peak-violation",
  "planner-required",
  "planner-apply-failed",
]);
const RECOVERABLE_RENDER_SAFETY_GATE_REASONS = new Set([
  "duration-mismatch",
  "timing-offset",
  "peak-violation",
]);
const ENHANCED_LINEAR_RECOVERY_QUALITY_REASONS = Object.freeze([
  "ending-damage",
  "end-edge-dip",
  "source-regression",
]);

export const partitionCandidateGateReasons = (gateReasons: readonly string[]) => {
  const technicalSafetyReasons: string[] = [];
  const qualityAdvisoryReasons: string[] = [];
  for (const reason of gateReasons) {
    if (TECHNICAL_SAFETY_GATE_REASONS.has(reason)) technicalSafetyReasons.push(reason);
    else qualityAdvisoryReasons.push(reason);
  }
  return Object.freeze({
    technicalSafetyReasons: Object.freeze(technicalSafetyReasons),
    qualityAdvisoryReasons: Object.freeze(qualityAdvisoryReasons),
  });
};

export const shouldRequestEnhancedLinearRecoveryForCandidate = (
  gateReasons: readonly string[],
) =>
  ENHANCED_LINEAR_RECOVERY_QUALITY_REASONS.every((reason) =>
    gateReasons.includes(reason),
  );

export const resolveRequestedEnhancedLinearRecoverySelection = ({
  recoveryRequested,
  recoveryGateReasons,
}: Readonly<{
  recoveryRequested: boolean;
  recoveryGateReasons: readonly string[];
}>) => {
  const { technicalSafetyReasons, qualityAdvisoryReasons } =
    partitionCandidateGateReasons(recoveryGateReasons);
  return Object.freeze({
    select: recoveryRequested && technicalSafetyReasons.length === 0,
    technicalSafetyReasons,
    qualityAdvisoryReasons,
  });
};

export const resolveEnhancedDeliveryDecision = ({
  gateReasons,
  previousRankingScore,
  enhancedRankingScore,
}: Readonly<{
  gateReasons: readonly string[];
  previousRankingScore: number;
  enhancedRankingScore: number;
}>) => {
  const { technicalSafetyReasons, qualityAdvisoryReasons } =
    partitionCandidateGateReasons(gateReasons);
  const advisoryPreferredCandidate =
    Number.isFinite(previousRankingScore) && Number.isFinite(enhancedRankingScore)
      ? enhancedRankingScore < previousRankingScore
        ? "enhanced"
        : enhancedRankingScore > previousRankingScore
          ? "previous"
          : "tie"
      : "unavailable";
  return Object.freeze({
    deliverEnhanced: technicalSafetyReasons.length === 0,
    advisoryPreferredCandidate,
    technicalSafetyReasons,
    qualityAdvisoryReasons,
  });
};

const roundedScore = (value: number) => Math.round(value * 100);

export const isHealthySegmentedRender = (meta: CandidateRenderMeta) =>
  meta.segmentedHealthy &&
  (meta.renderPath === "speech-pause-segmented" ||
    meta.renderPath === "speech-aligned-segmented" ||
    meta.renderPath === "fixed-segmented");

export const shouldRunSourceSafeRecoveryForCandidate = (input: {
  meta: CandidateRenderMeta;
  gateReasons: readonly string[];
}) => {
  const hasRecoverableStructuralFailure = input.gateReasons.some((reason) =>
    RECOVERABLE_RENDER_SAFETY_GATE_REASONS.has(reason),
  );
  const hasObjectiveAudibilityFailure = input.meta.degradeReasons.includes(
    "audibility-dropout-guard",
  );
  return hasRecoverableStructuralFailure || hasObjectiveAudibilityFailure;
};

const isRecoveredSinglePass = (meta: CandidateRenderMeta) => meta.renderPath === "single-pass-recovered";

const withinHealthySegmentedTolerance = (challenger: CandidateScore, recovered: CandidateScore) =>
  challenger.stability <= recovered.stability + HEALTHY_SEGMENTED_STABILITY_DELTA &&
  challenger.pause <= recovered.pause + HEALTHY_SEGMENTED_PAUSE_DELTA &&
  challenger.compression <= recovered.compression + HEALTHY_SEGMENTED_COMPRESSION_DELTA;

const materiallyBetterThanHealthySegmented = (recovered: CandidateScore, healthy: CandidateScore) =>
  recovered.stability + HEALTHY_SEGMENTED_STABILITY_DELTA < healthy.stability &&
  recovered.pause + HEALTHY_SEGMENTED_PAUSE_DELTA < healthy.pause &&
  recovered.compression + HEALTHY_SEGMENTED_COMPRESSION_DELTA < healthy.compression;

const hasUnselectableGate = (score: CandidateScore) =>
  (score.gateReasons ?? []).some((reason) =>
    reason === "planner-required" ||
    reason === "planner-apply-failed"
  );

const hasPlannerGate = (score: CandidateScore) =>
  (score.gateReasons ?? []).some((reason) => reason === "planner-required" || reason === "planner-apply-failed");

const hasQcUnavailableGate = (score: CandidateScore) =>
  (score.gateReasons ?? []).includes("qc-unavailable");

const hasRenderDegradeReason = (meta: CandidateRenderMeta) =>
  meta.degradeReasons.some((reason) => !QC_ONLY_DEGRADE_REASONS.has(reason));

const fallbackVariantPriority = (variant: string) => {
  if (variant === "cinematic-stable") return 0;
  if (variant === "continuity-safe") return 1;
  if (variant === "pause-safe") return 2;
  if (variant === "source-safe" || variant === "core-safe") return 3;
  return 4;
};

const fallbackRenderPathPriority = (meta: CandidateRenderMeta) => {
  if (meta.renderPath === "fixed-segmented") return 0;
  if (meta.renderPath === "speech-pause-segmented" || meta.renderPath === "speech-aligned-segmented") return 1;
  if (meta.renderPath === "single-pass") return 2;
  return 3;
};

export const resolveNextAudibilityFallbackIndex = (
  strategies: RenderFallbackStrategyLike[],
  currentIndex: number,
) => {
  if (currentIndex < 0 || currentIndex >= strategies.length - 1) return null;
  const plannerTailSafeIndex = strategies.findIndex((item) => item.label === PLANNER_TAIL_SAFE_STRATEGY_LABEL);
  if (plannerTailSafeIndex > currentIndex) return plannerTailSafeIndex;
  const audibilitySafeIndex = strategies.findIndex((item) => item.label === AUDIBILITY_SAFE_STRATEGY_LABEL);
  if (audibilitySafeIndex > currentIndex) return audibilitySafeIndex;
  return currentIndex + 1;
};

const compareQcUnavailableFallbackCandidates = <TVariant extends string>(
  left: QcUnavailableFallbackCandidate<TVariant>,
  right: QcUnavailableFallbackCandidate<TVariant>,
) => {
  const leftRenderDegraded = hasRenderDegradeReason(left.meta);
  const rightRenderDegraded = hasRenderDegradeReason(right.meta);
  if (leftRenderDegraded !== rightRenderDegraded) return leftRenderDegraded ? 1 : -1;

  const leftHealthy = isHealthySegmentedRender(left.meta);
  const rightHealthy = isHealthySegmentedRender(right.meta);
  if (leftHealthy !== rightHealthy) return leftHealthy ? -1 : 1;

  const leftRecovered = isRecoveredSinglePass(left.meta);
  const rightRecovered = isRecoveredSinglePass(right.meta);
  if (leftRecovered !== rightRecovered) return leftRecovered ? 1 : -1;

  const variantDelta = fallbackVariantPriority(left.variant) - fallbackVariantPriority(right.variant);
  if (variantDelta !== 0) return variantDelta;

  const pathDelta = fallbackRenderPathPriority(left.meta) - fallbackRenderPathPriority(right.meta);
  if (pathDelta !== 0) return pathDelta;

  const scoreDelta = compareCandidateScores(left.score, right.score);
  if (scoreDelta !== 0) return scoreDelta;

  return left.index - right.index;
};

export const selectQcUnavailableFallbackCandidate = <TVariant extends string>(
  candidates: QcUnavailableFallbackCandidate<TVariant>[],
): QcUnavailableFallbackSelection<TVariant> | null => {
  const eligible = candidates.filter(
    (candidate) => candidate.hasAudio && hasQcUnavailableGate(candidate.score) && !hasPlannerGate(candidate.score),
  );
  if (eligible.length === 0) return null;

  const [candidate] = [...eligible].sort(compareQcUnavailableFallbackCandidates);
  const reason = hasRenderDegradeReason(candidate.meta)
    ? "QC-unavailable fallback with render degradation because no cleaner rendered candidate was available"
    : isHealthySegmentedRender(candidate.meta)
      ? "QC-unavailable fallback from healthy rendered segmented audio"
      : "QC-unavailable fallback from rendered audio";
  return { candidate, reason };
};

export const buildRenderRiskProfile = (input: RenderRiskInput): RenderRiskProfile => {
  const highRisk =
    input.plannedSegmentCount >= 24 ||
    (input.durationSeconds >= 480 && input.longSparseMode) ||
    (input.speechSpanCount >= 18 && (input.useRoomCleanup || input.useAdaptiveNoiseReduction)) ||
    input.priorFatalRenderError;
  const mergedSegmentCount = input.mergedSegmentCount ?? input.plannedSegmentCount;
  return {
    level: highRisk ? "high" : "normal",
    durationSeconds: input.durationSeconds,
    longSparseMode: input.longSparseMode,
    plannedSegmentCount: input.plannedSegmentCount,
    speechSpanCount: input.speechSpanCount,
    candidateVariant: input.candidateVariant,
    useRoomCleanup: input.useRoomCleanup,
    useAdaptiveNoiseReduction: input.useAdaptiveNoiseReduction,
    priorFatalRenderError: input.priorFatalRenderError,
    targetProcessedSegmentCount: 18,
    mergePauseThresholdSec: 0.6,
    disableSegmentGainMatch: highRisk && input.sentenceJumpScore < 0.4,
    recycleWorkerBeforeRender: highRisk,
    shouldUseFixedSegmentation: highRisk && mergedSegmentCount > 18,
  };
};

export const compareCandidateScores = (left: CandidateScore, right: CandidateScore) => {
  if (
    typeof left.rankingScore === "number" &&
    Number.isFinite(left.rankingScore) &&
    typeof right.rankingScore === "number" &&
    Number.isFinite(right.rankingScore) &&
    left.rankingScore !== right.rankingScore
  ) {
    return left.rankingScore - right.rankingScore;
  }
  if (left.stability !== right.stability) return left.stability - right.stability;
  if (left.pause !== right.pause) return left.pause - right.pause;
  if (left.compression !== right.compression) return left.compression - right.compression;
  if (left.echo !== right.echo) return left.echo - right.echo;
  return left.total - right.total;
};

export const explainCandidateDelta = (winner: CandidateScore, loser: CandidateScore) => {
  if (
    typeof winner.rankingScore === "number" &&
    typeof loser.rankingScore === "number" &&
    winner.rankingScore !== loser.rankingScore
  ) {
    return "winner by learned ranking";
  }
  if (winner.stability !== loser.stability) return "winner by raw stability delta";
  if (winner.pause !== loser.pause) return "winner by raw pause delta";
  if (winner.compression !== loser.compression) return "winner by raw compression delta";
  if (winner.echo !== loser.echo) return "winner by raw echo delta";
  return "winner by raw total delta";
};

export const shouldPreferCandidate = (
  challengerScore: CandidateScore,
  challengerMeta: CandidateRenderMeta,
  currentScore: CandidateScore | null,
  currentMeta: CandidateRenderMeta | null
) => {
  if (hasUnselectableGate(challengerScore)) {
    return { select: false, reason: "candidate unavailable for selection" };
  }

  if (currentScore === null || currentMeta === null) {
    return { select: true, reason: "first completed candidate" };
  }

  const challengerHealthySegmented = isHealthySegmentedRender(challengerMeta);
  const currentHealthySegmented = isHealthySegmentedRender(currentMeta);
  const challengerRecovered = isRecoveredSinglePass(challengerMeta);
  const currentRecovered = isRecoveredSinglePass(currentMeta);

  if (
    challengerHealthySegmented &&
    currentRecovered &&
    withinHealthySegmentedTolerance(challengerScore, currentScore)
  ) {
    return { select: true, reason: "prefer healthy segmented" };
  }

  if (
    challengerRecovered &&
    currentHealthySegmented &&
    !materiallyBetterThanHealthySegmented(challengerScore, currentScore)
  ) {
    return { select: false, reason: "protected healthy segmented" };
  }

  const compare = compareCandidateScores(challengerScore, currentScore);
  if (compare < 0) {
    const roundedTie =
      roundedScore(challengerScore.stability) === roundedScore(currentScore.stability) &&
      roundedScore(challengerScore.pause) === roundedScore(currentScore.pause) &&
      roundedScore(challengerScore.compression) === roundedScore(currentScore.compression) &&
      roundedScore(challengerScore.echo) === roundedScore(currentScore.echo);
    return {
      select: true,
      reason: roundedTie ? explainCandidateDelta(challengerScore, currentScore) : "better score",
    };
  }

  return { select: false, reason: "kept current winner" };
};
