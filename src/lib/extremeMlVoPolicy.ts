import type { ExtremeAnalysisOutcome, ExtremeSourceReport } from "./extremeMlClient.ts";
import { buildMlSpeechProtectionMask, type MlVadFrame } from "./mlSpeechProtection.ts";

export const EXTREME_ML_MAX_CONCURRENT_ANALYSES = 2;

export type ExtremeMlSourceJob = Readonly<{
  key: string;
  source: Blob;
  contentType: string;
  idempotencyKey: string;
}>;

type AnalyzeExtremeSource = (input: Readonly<{
  source: Blob;
  contentType: string;
  idempotencyKey: string;
}>) => Promise<ExtremeAnalysisOutcome>;

type ExtremeMlSourceOutcome = Readonly<{
  key: string;
  outcome: ExtremeAnalysisOutcome;
}>;

const unavailableOutcome = (): ExtremeAnalysisOutcome =>
  Object.freeze({ status: "unavailable", reason: "worker-unavailable" });

/**
 * Starts at most two source uploads at once. Each lane is independent, so a
 * failed worker request cannot cancel later files or become a delivery gate.
 */
export const analyzeExtremeSourcesBounded = async ({
  jobs,
  analyze,
  onOutcome,
}: Readonly<{
  jobs: readonly ExtremeMlSourceJob[];
  analyze: AnalyzeExtremeSource;
  onOutcome: (result: ExtremeMlSourceOutcome) => void;
}>): Promise<void> => {
  const laneCount = Math.min(EXTREME_ML_MAX_CONCURRENT_ANALYSES, jobs.length);

  const runLane = async (index: number): Promise<void> => {
    if (index >= jobs.length) return;
    const job = jobs[index];
    let outcome: ExtremeAnalysisOutcome;
    try {
      outcome = await analyze({
        source: job.source,
        contentType: job.contentType,
        idempotencyKey: job.idempotencyKey,
      });
    } catch {
      // Never expose thrown provider details because they can contain access
      // tokens or infrastructure metadata.
      outcome = unavailableOutcome();
    }
    onOutcome(Object.freeze({ key: job.key, outcome }));
    await runLane(index + laneCount);
  };

  await Promise.all(Array.from({ length: laneCount }, (_, lane) => runLane(lane)));
};

const isAdvisoryReport = (report: ExtremeSourceReport | null): report is ExtremeSourceReport =>
  report !== null &&
  report.schemaVersion === 1 &&
  report.advisoryOnly === true &&
  report.canBlockDelivery === false &&
  report.canChangeGainDb === false &&
  report.levelAuthority === "gainPlanner";

/**
 * Projects a full-source 10 ms worker timeline onto a planner range. Any
 * cadence, length, or timestamp mismatch fails open instead of shifting ML
 * evidence onto a neighboring sound.
 */
export const resolvePlannerVadFrames = ({
  report,
  plannerFrameCount,
  plannerFrameMs,
  rangeStartSec,
}: Readonly<{
  report: ExtremeSourceReport | null;
  plannerFrameCount: number;
  plannerFrameMs: number;
  rangeStartSec: number;
}>): readonly MlVadFrame[] | null => {
  if (
    !isAdvisoryReport(report) ||
    !Number.isInteger(plannerFrameCount) ||
    plannerFrameCount <= 0 ||
    !Number.isFinite(plannerFrameMs) ||
    plannerFrameMs <= 0 ||
    !Number.isFinite(rangeStartSec) ||
    rangeStartSec < 0 ||
    !Number.isFinite(report.vad.frameMs) ||
    Math.abs(report.vad.frameMs - plannerFrameMs) > 0.001
  ) {
    return null;
  }

  const rangeStartFrameExact = (rangeStartSec * 1_000) / plannerFrameMs;
  const rangeStartFrame = Math.round(rangeStartFrameExact);
  if (Math.abs(rangeStartFrameExact - rangeStartFrame) > 0.25) return null;
  const rangeEndFrame = rangeStartFrame + plannerFrameCount;
  if (
    rangeEndFrame > report.vad.frames.length ||
    rangeEndFrame * plannerFrameMs > report.source.durationMs + plannerFrameMs
  ) {
    return null;
  }

  const timestampToleranceMs = plannerFrameMs * 0.25;
  const projectedFrames: MlVadFrame[] = [];
  for (let localFrame = 0; localFrame < plannerFrameCount; localFrame += 1) {
    const sourceFrame = rangeStartFrame + localFrame;
    const frame = report.vad.frames[sourceFrame];
    const expectedSourceStartMs = sourceFrame * plannerFrameMs;
    const expectedSourceEndMs = expectedSourceStartMs + plannerFrameMs;
    if (
      !frame ||
      !Number.isFinite(frame.startMs) ||
      !Number.isFinite(frame.endMs) ||
      !Number.isFinite(frame.speechProbability) ||
      frame.speechProbability < 0 ||
      frame.speechProbability > 1 ||
      Math.abs(frame.startMs - expectedSourceStartMs) > timestampToleranceMs ||
      Math.abs(frame.endMs - expectedSourceEndMs) > timestampToleranceMs
    ) {
      return null;
    }
    projectedFrames.push(
      Object.freeze({
        startMs: localFrame * plannerFrameMs,
        endMs: (localFrame + 1) * plannerFrameMs,
        speechProbability: frame.speechProbability,
      }),
    );
  }

  return Object.freeze(projectedFrames);
};

export type PlannerMlProtection = Readonly<{
  reason: "ml-protection" | "legacy-fallback";
  protectedSpeechFrameMask: readonly boolean[] | null;
  addedFrameCount: number;
  isolatedMlFrameCount: number;
}>;

const legacyProtection = (): PlannerMlProtection =>
  Object.freeze({
    reason: "legacy-fallback",
    protectedSpeechFrameMask: null,
    addedFrameCount: 0,
    isolatedMlFrameCount: 0,
  });

/**
 * Converts valid VAD into protective tail/gap evidence only. Returning null
 * for the mask is intentional: the caller then omits the planner field and
 * executes the exact legacy browser path.
 */
export const buildPlannerMlProtection = ({
  report,
  energySpeechMask,
  plannerFrameMs,
  rangeStartSec,
}: Readonly<{
  report: ExtremeSourceReport | null;
  energySpeechMask: readonly boolean[];
  plannerFrameMs: number;
  rangeStartSec: number;
}>): PlannerMlProtection => {
  if (!energySpeechMask.every((value) => typeof value === "boolean")) {
    return legacyProtection();
  }
  const vadFrames = resolvePlannerVadFrames({
    report,
    plannerFrameCount: energySpeechMask.length,
    plannerFrameMs,
    rangeStartSec,
  });
  if (!vadFrames) return legacyProtection();

  const protection = buildMlSpeechProtectionMask({
    frameCount: energySpeechMask.length,
    frameMs: plannerFrameMs,
    energySpeechMask,
    vadFrames,
  });
  if (protection.reason !== "ml-protection" || protection.addedFrameCount <= 0) {
    return legacyProtection();
  }
  return Object.freeze({
    reason: "ml-protection",
    protectedSpeechFrameMask: protection.protectedSpeechMask,
    addedFrameCount: protection.addedFrameCount,
    isolatedMlFrameCount: protection.isolatedMlFrameCount,
  });
};
