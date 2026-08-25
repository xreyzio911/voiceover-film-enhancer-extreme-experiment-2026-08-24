import type {
  ExtremeAnalysisOutcome,
  ExtremeEnhancementOutcome,
  ExtremeRenderedAnalysisOutcome,
  ExtremeRenderedReport,
  ExtremeSourceReport,
} from "./extremeMlClient.ts";
import { buildMlSpeechProtectionMask, type MlVadFrame } from "./mlSpeechProtection.ts";

export const EXTREME_ML_MAX_CONCURRENT_ANALYSES = 2;
const EXTREME_ML_PER_FILE_WAIT_BASE_MS = 4_000;
const EXTREME_ML_PER_FILE_WAIT_MAX_MS = 45_000;
const EXTREME_ML_ESTIMATED_UPLOAD_BYTES_PER_SECOND = 8 * 1024 * 1024;
const EXTREME_ML_POLL_BASE_SECONDS = 120;
const EXTREME_ML_MAX_POLL_COUNT = 2_400;
// Assume the compact 48 kHz mono PCM16 layout so float, 24-bit, and stereo WAVs
// receive an equal or longer background inference window rather than being
// mistaken for a shorter recording from byte size alone.
const EXTREME_ML_ESTIMATED_AUDIO_BYTES_PER_SECOND = 48_000 * 2;
const EXTREME_ML_LONG_FILE_RUNTIME_FACTOR = 1.25;

const normalizeSourceSizeBytes = (sourceSizeBytes: number) =>
  Number.isFinite(sourceSizeBytes) && sourceSizeBytes > 0
    ? Math.floor(sourceSizeBytes)
    : 0;

/**
 * Bounds only the wait immediately before one file enters the browser render.
 * Enhancement keeps running in the background after this wait, so a slow or
 * unavailable worker can never cancel delivery or hold the entire batch.
 */
export const getExtremeMlPerFileWaitMs = (sourceSizeBytes: number) => {
  const normalizedBytes = normalizeSourceSizeBytes(sourceSizeBytes);
  const estimatedUploadMs =
    (normalizedBytes / EXTREME_ML_ESTIMATED_UPLOAD_BYTES_PER_SECOND) * 1_000;
  return Math.min(
    EXTREME_ML_PER_FILE_WAIT_MAX_MS,
    Math.ceil(EXTREME_ML_PER_FILE_WAIT_BASE_MS + estimatedUploadMs),
  );
};

/**
 * Keeps polling alive for long-file inference instead of applying the old
 * short-file fixed count. At one poll per second this gives roughly 11 minutes
 * to a seven-minute mono PCM16 WAV and about 35 minutes to a 26-minute WAV;
 * larger lossless layouts receive more time up to the 40-minute cap.
 */
export const getExtremeMlMaxPollsForSourceBytes = (sourceSizeBytes: number) => {
  const normalizedBytes = normalizeSourceSizeBytes(sourceSizeBytes);
  const estimatedAudioSeconds =
    normalizedBytes / EXTREME_ML_ESTIMATED_AUDIO_BYTES_PER_SECOND;
  return Math.min(
    EXTREME_ML_MAX_POLL_COUNT,
    Math.ceil(
      EXTREME_ML_POLL_BASE_SECONDS +
        estimatedAudioSeconds * EXTREME_ML_LONG_FILE_RUNTIME_FACTOR,
    ),
  );
};

export type ExtremeMlSourceJob = Readonly<{
  key: string;
  source: Blob;
  contentType: string;
  idempotencyKey: string;
}>;

export type ExtremeMlRenderedJob = Readonly<{
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

type EnhanceExtremeSource = (input: Readonly<{
  source: Blob;
  contentType: string;
  idempotencyKey: string;
}>) => Promise<ExtremeEnhancementOutcome>;

type ExtremeMlEnhancementOutcome = Readonly<{
  key: string;
  outcome: ExtremeEnhancementOutcome;
}>;

type AnalyzeExtremeRendered = (input: Readonly<{
  source: Blob;
  contentType: string;
  idempotencyKey: string;
}>) => Promise<ExtremeRenderedAnalysisOutcome>;

type ExtremeMlRenderedOutcome = Readonly<{
  key: string;
  outcome: ExtremeRenderedAnalysisOutcome;
}>;

const unavailableOutcome = (): ExtremeAnalysisOutcome =>
  Object.freeze({ status: "unavailable", reason: "worker-unavailable" });

const unavailableRenderedOutcome = (): ExtremeRenderedAnalysisOutcome =>
  Object.freeze({ status: "unavailable", reason: "worker-unavailable" });

const unavailableEnhancementOutcome = (reason = "worker-unavailable"): ExtremeEnhancementOutcome =>
  Object.freeze({ status: "unavailable", reason });

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

/**
 * Runs optional waveform cleanup candidates through the same bounded lane as
 * advisory source analysis. Late or failed candidates are ignored by callers,
 * so enhancement cannot become a serial pre-render gate.
 */
export const enhanceExtremeSourcesBounded = async ({
  jobs,
  enhance,
  onOutcome,
}: Readonly<{
  jobs: readonly ExtremeMlSourceJob[];
  enhance: EnhanceExtremeSource;
  onOutcome: (result: ExtremeMlEnhancementOutcome) => void;
}>): Promise<void> => {
  const laneCount = Math.min(EXTREME_ML_MAX_CONCURRENT_ANALYSES, jobs.length);

  const runLane = async (index: number): Promise<void> => {
    if (index >= jobs.length) return;
    const job = jobs[index];
    let outcome: ExtremeEnhancementOutcome;
    try {
      outcome = await enhance({
        source: job.source,
        contentType: job.contentType,
        idempotencyKey: job.idempotencyKey,
      });
    } catch {
      outcome = unavailableEnhancementOutcome();
    }
    onOutcome(Object.freeze({ key: job.key, outcome }));
    await runLane(index + laneCount);
  };

  await Promise.all(Array.from({ length: laneCount }, (_, lane) => runLane(lane)));
};

export type ExtremeMlProgressiveEnhancementBatch = Readonly<{
  waitForOutcome: (key: string, timeoutMs: number) => Promise<ExtremeEnhancementOutcome>;
  completion: Promise<ReadonlyMap<string, ExtremeEnhancementOutcome>>;
}>;

type ProgressiveEnhancementDeferred = Readonly<{
  promise: Promise<ExtremeEnhancementOutcome>;
  resolve: (outcome: ExtremeEnhancementOutcome) => void;
}>;

const createProgressiveEnhancementDeferred = (): ProgressiveEnhancementDeferred => {
  let resolveOutcome: (outcome: ExtremeEnhancementOutcome) => void = () => undefined;
  const promise = new Promise<ExtremeEnhancementOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  return Object.freeze({ promise, resolve: resolveOutcome });
};

/**
 * Starts every enhancement job immediately through the shared two-lane queue.
 * Callers may wait for only the file they are about to render; timing out that
 * wait returns an explicit fail-open outcome without cancelling the background
 * upload, the later queue entries, or the browser delivery.
 */
export const startExtremeMlProgressiveEnhancementBatch = ({
  jobs,
  enhance,
  onOutcome,
}: Readonly<{
  jobs: readonly ExtremeMlSourceJob[];
  enhance: EnhanceExtremeSource;
  onOutcome?: (result: ExtremeMlEnhancementOutcome) => void;
}>): ExtremeMlProgressiveEnhancementBatch => {
  const deferredByKey = new Map<string, ProgressiveEnhancementDeferred>(
    jobs.map((job) => [job.key, createProgressiveEnhancementDeferred()]),
  );
  let outcomesByKey: ReadonlyMap<string, ExtremeEnhancementOutcome> = new Map();

  const completion = enhanceExtremeSourcesBounded({
    jobs,
    enhance,
    onOutcome: (result) => {
      outcomesByKey = new Map([...outcomesByKey, [result.key, result.outcome]]);
      deferredByKey.get(result.key)?.resolve(result.outcome);
      try {
        onOutcome?.(result);
      } catch {
        // UI telemetry must never stop a worker lane or later batch entries.
      }
    },
  }).then(() => new Map(
    jobs.map((job) => [
      job.key,
      outcomesByKey.get(job.key) ?? unavailableEnhancementOutcome(),
    ]),
  ));

  const waitForOutcome = async (key: string, timeoutMs: number) => {
    const outcomePromise = deferredByKey.get(key)?.promise;
    if (!outcomePromise) return unavailableEnhancementOutcome("per-file-timeout");
    const boundedTimeoutMs = Number.isFinite(timeoutMs)
      ? Math.max(0, Math.floor(timeoutMs))
      : 0;
    return new Promise<ExtremeEnhancementOutcome>((resolve) => {
      let settled = false;
      const timer = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(unavailableEnhancementOutcome("per-file-timeout"));
      }, boundedTimeoutMs);
      void outcomePromise.then((outcome) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(outcome);
      });
    });
  };

  return Object.freeze({ waitForOutcome, completion });
};

/**
 * Keeps post-render measurement in its own bounded lane and result type. It is
 * intentionally separate from source analysis so rendered VAD can never be
 * inserted into the gain planner's source-evidence map.
 */
export const analyzeExtremeRenderedOutputsBounded = async ({
  jobs,
  analyze,
  onOutcome,
}: Readonly<{
  jobs: readonly ExtremeMlRenderedJob[];
  analyze: AnalyzeExtremeRendered;
  onOutcome: (result: ExtremeMlRenderedOutcome) => void;
}>): Promise<void> => {
  const laneCount = Math.min(EXTREME_ML_MAX_CONCURRENT_ANALYSES, jobs.length);

  const runLane = async (index: number): Promise<void> => {
    if (index >= jobs.length) return;
    const job = jobs[index];
    let outcome: ExtremeRenderedAnalysisOutcome;
    try {
      outcome = await analyze({
        source: job.source,
        contentType: job.contentType,
        idempotencyKey: job.idempotencyKey,
      });
    } catch {
      outcome = unavailableRenderedOutcome();
    }
    onOutcome(Object.freeze({ key: job.key, outcome }));
    await runLane(index + laneCount);
  };

  await Promise.all(Array.from({ length: laneCount }, (_, lane) => runLane(lane)));
};

const EXTREME_QUALITY_METRIC_KEYS = Object.freeze([
  "dnsmos.ovrl",
  "dnsmos.sig",
  "dnsmos.bak",
  "dnsmos_p808",
  "sigmos.ovrl",
  "sigmos.sig",
  "sigmos.disc",
  "sigmos.col",
  "sigmos.loud",
  "sigmos.noise",
  "sigmos.reverb",
  "utmos",
] as const);

export type ExtremeQualityMetricDelta = Readonly<{
  key: (typeof EXTREME_QUALITY_METRIC_KEYS)[number];
  sourceValue: number;
  renderedValue: number;
  delta: number;
  higherIsBetter: boolean;
}>;

/**
 * Compares only known, finite, like-for-like advisory metrics. No delta is a
 * quality gate and the function has no audio, selection, or gain authority.
 */
export const compareExtremeQualityMetrics = (
  sourceReport: ExtremeSourceReport,
  renderedReport: ExtremeRenderedReport,
): readonly ExtremeQualityMetricDelta[] => Object.freeze(
  EXTREME_QUALITY_METRIC_KEYS.flatMap((key) => {
    const sourceMetric = sourceReport.metrics[key];
    const renderedMetric = renderedReport.report.metrics[key];
    if (
      sourceMetric?.available !== true ||
      renderedMetric?.available !== true ||
      typeof sourceMetric.value !== "number" ||
      typeof renderedMetric.value !== "number" ||
      !Number.isFinite(sourceMetric.value) ||
      !Number.isFinite(renderedMetric.value) ||
      sourceMetric.higherIsBetter !== renderedMetric.higherIsBetter
    ) {
      return [];
    }
    return [Object.freeze({
      key,
      sourceValue: sourceMetric.value,
      renderedValue: renderedMetric.value,
      delta: Math.round((renderedMetric.value - sourceMetric.value) * 1_000_000) / 1_000_000,
      higherIsBetter: sourceMetric.higherIsBetter,
    })];
  }),
);

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
