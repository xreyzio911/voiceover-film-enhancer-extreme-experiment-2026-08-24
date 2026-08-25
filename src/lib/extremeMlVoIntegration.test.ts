import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  ExtremeAnalysisOutcome,
  ExtremeEnhancementOutcome,
  ExtremeRenderedAnalysisOutcome,
  ExtremeRenderedReport,
  ExtremeSourceReport,
} from "./extremeMlClient.ts";
import * as extremeMlVoPolicy from "./extremeMlVoPolicy.ts";
import {
  EXTREME_ML_MAX_CONCURRENT_ANALYSES,
  analyzeExtremeRenderedOutputsBounded,
  analyzeExtremeSourcesBounded,
  enhanceExtremeSourcesBounded,
  buildPlannerMlProtection,
  compareExtremeQualityMetrics,
  resolvePlannerVadFrames,
} from "./extremeMlVoPolicy.ts";

const SHA256 = "a".repeat(64);
const REVISION = "b".repeat(40);

type ProgressiveEnhancementBatch = Readonly<{
  waitForOutcome: (key: string, timeoutMs: number) => Promise<ExtremeEnhancementOutcome>;
  completion: Promise<ReadonlyMap<string, ExtremeEnhancementOutcome>>;
}>;

type ProgressiveEnhancementPolicy = typeof extremeMlVoPolicy & Readonly<{
  startExtremeMlProgressiveEnhancementBatch?: (input: Readonly<{
    jobs: readonly Readonly<{
      key: string;
      source: Blob;
      contentType: string;
      idempotencyKey: string;
    }>[];
    enhance: (input: Readonly<{
      source: Blob;
      contentType: string;
      idempotencyKey: string;
    }>) => Promise<ExtremeEnhancementOutcome>;
    onOutcome?: (result: Readonly<{
      key: string;
      outcome: ExtremeEnhancementOutcome;
    }>) => void;
  }>) => ProgressiveEnhancementBatch;
  getExtremeMlPerFileWaitMs?: (sourceSizeBytes: number) => number;
  getExtremeMlMaxPollsForSourceBytes?: (sourceSizeBytes: number) => number;
}>;

const requireProgressiveEnhancementPolicy = () => {
  const policy = extremeMlVoPolicy as ProgressiveEnhancementPolicy;
  assert.equal(
    typeof policy.startExtremeMlProgressiveEnhancementBatch,
    "function",
    "long batches need a progressive two-lane controller instead of a global snapshot cutoff",
  );
  assert.equal(
    typeof policy.getExtremeMlPerFileWaitMs,
    "function",
    "each file needs its own source-size-aware render wait",
  );
  assert.equal(
    typeof policy.getExtremeMlMaxPollsForSourceBytes,
    "function",
    "long files need more worker polls than short files",
  );
  return {
    start: policy.startExtremeMlProgressiveEnhancementBatch!,
    getPerFileWaitMs: policy.getExtremeMlPerFileWaitMs!,
    getMaxPolls: policy.getExtremeMlMaxPollsForSourceBytes!,
  };
};

const makeReport = (
  probabilities: readonly number[],
  overrides: Partial<ExtremeSourceReport> = {},
): ExtremeSourceReport => ({
  schemaVersion: 1,
  advisoryOnly: true,
  canBlockDelivery: false,
  canChangeGainDb: false,
  levelAuthority: "gainPlanner",
  modelSetId: "silero-vad-test",
  source: {
    sha256: SHA256,
    durationMs: probabilities.length * 10,
    sampleRate: 16_000,
    channels: 1,
  },
  vad: {
    frameMs: 10,
    frames: probabilities.map((speechProbability, frame) => ({
      startMs: frame * 10,
      endMs: (frame + 1) * 10,
      speechProbability,
    })),
  },
  metrics: {},
  models: [{ id: "silero-vad", version: "6.2.1", revision: REVISION, sha256: SHA256 }],
  telemetry: {
    runtimeStatus: "ready",
    reason: "ok",
    audioMutation: false,
    candidateSelected: false,
    gainDbChanged: false,
  },
  ...overrides,
});

test("valid VAD can protect only a short region attached to energy speech", () => {
  const protection = buildPlannerMlProtection({
    report: makeReport([0.95, 0.9, 0.92, 0.1, 0.9]),
    energySpeechMask: [true, true, false, false, false],
    plannerFrameMs: 10,
    rangeStartSec: 0,
  });

  assert.equal(protection.reason, "ml-protection");
  assert.equal(protection.addedFrameCount, 1);
  assert.equal(protection.isolatedMlFrameCount, 1);
  assert.deepEqual(protection.protectedSpeechFrameMask, [true, true, true, false, false]);
});

test("missing, unsafe, or misaligned evidence returns a null planner mask for exact legacy behavior", () => {
  const energySpeechMask = [true, true, false, false];
  const unsafe = makeReport([0.9, 0.9, 0.9, 0.9], {
    canChangeGainDb: true as false,
  });
  const misaligned = makeReport([0.9, 0.9, 0.9, 0.9], {
    vad: {
      frameMs: 20,
      frames: [
        { startMs: 0, endMs: 20, speechProbability: 0.9 },
        { startMs: 20, endMs: 40, speechProbability: 0.9 },
      ],
    },
  });

  for (const report of [null, unsafe, misaligned]) {
    const protection = buildPlannerMlProtection({
      report,
      energySpeechMask,
      plannerFrameMs: 10,
      rangeStartSec: 0,
    });
    assert.equal(protection.reason, "legacy-fallback");
    assert.equal(protection.protectedSpeechFrameMask, null);
    assert.equal(protection.addedFrameCount, 0);
    assert.deepEqual(energySpeechMask, [true, true, false, false]);
  }
});

test("full-source VAD is translated onto an aligned long-form planner range", () => {
  const report = makeReport([0.1, 0.1, 0.1, 0.8, 0.9, 0.7, 0.2, 0.1]);
  const frames = resolvePlannerVadFrames({
    report,
    plannerFrameCount: 4,
    plannerFrameMs: 10,
    rangeStartSec: 0.03,
  });

  assert.deepEqual(frames, [
    { startMs: 0, endMs: 10, speechProbability: 0.8 },
    { startMs: 10, endMs: 20, speechProbability: 0.9 },
    { startMs: 20, endMs: 30, speechProbability: 0.7 },
    { startMs: 30, endMs: 40, speechProbability: 0.2 },
  ]);
  assert.equal(Object.isFrozen(frames), true);
  assert.equal(Object.isFrozen(frames?.[0]), true);
});

test("unaligned range boundaries fail open instead of shifting worker evidence", () => {
  assert.equal(
    resolvePlannerVadFrames({
      report: makeReport([0.9, 0.9, 0.9, 0.9]),
      plannerFrameCount: 2,
      plannerFrameMs: 10,
      rangeStartSec: 0.004,
    }),
    null,
  );
});

test("worker source analysis is bounded to two concurrent uploads", async () => {
  const jobs = Array.from({ length: 7 }, (_, index) => ({
    key: `source-${index}`,
    source: new Blob([String(index)], { type: "audio/wav" }),
    contentType: "audio/wav",
    idempotencyKey: `batch-${index}`,
  }));
  let active = 0;
  let maximumActive = 0;
  const seen: string[] = [];

  await analyzeExtremeSourcesBounded({
    jobs,
    analyze: async (): Promise<ExtremeAnalysisOutcome> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { status: "succeeded", report: makeReport([0.1]) };
    },
    onOutcome: ({ key }) => {
      seen.push(key);
    },
  });

  assert.equal(EXTREME_ML_MAX_CONCURRENT_ANALYSES, 2);
  assert.ok(maximumActive <= 2);
  assert.deepEqual([...seen].sort(), jobs.map(({ key }) => key).sort());
});

test("a thrown worker request becomes unavailable and does not stop later sources", async () => {
  const outcomes: ExtremeAnalysisOutcome[] = [];
  await analyzeExtremeSourcesBounded({
    jobs: [
      { key: "first", source: new Blob(["1"]), contentType: "audio/wav", idempotencyKey: "first" },
      { key: "second", source: new Blob(["2"]), contentType: "audio/wav", idempotencyKey: "second" },
      { key: "third", source: new Blob(["3"]), contentType: "audio/wav", idempotencyKey: "third" },
    ],
    analyze: async ({ idempotencyKey }) => {
      if (idempotencyKey === "first") throw new Error("secret-token-must-not-escape");
      return { status: "unavailable", reason: "poll-timeout" } as const;
    },
    onOutcome: ({ outcome }) => outcomes.push(outcome),
  });

  assert.equal(outcomes.length, 3);
  assert.deepEqual(outcomes[0], { status: "unavailable", reason: "worker-unavailable" });
  assert.equal(JSON.stringify(outcomes).includes("secret-token-must-not-escape"), false);
});

test("rendered-deliverable analysis has its own bounded fail-open lane", async () => {
  const jobs = Array.from({ length: 5 }, (_, index) => ({
    key: `render-${index}`,
    source: new Blob([String(index)], { type: "audio/wav" }),
    contentType: "audio/wav",
    idempotencyKey: `render:batch:${index}`,
  }));
  let active = 0;
  let maximumActive = 0;
  const outcomes: ExtremeRenderedAnalysisOutcome[] = [];

  await analyzeExtremeRenderedOutputsBounded({
    jobs,
    analyze: async ({ idempotencyKey }): Promise<ExtremeRenderedAnalysisOutcome> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (idempotencyKey.endsWith(":0")) throw new Error("private-worker-detail");
      return {
        status: "succeeded",
        renderedReport: {
          analysisRole: "rendered-deliverable",
          report: makeReport([0.1]),
        },
      };
    },
    onOutcome: ({ outcome }) => outcomes.push(outcome),
  });

  assert.equal(outcomes.length, jobs.length);
  assert.ok(maximumActive <= EXTREME_ML_MAX_CONCURRENT_ANALYSES);
  assert.equal(
    outcomes.some(
      (outcome) => outcome.status === "unavailable" && outcome.reason === "worker-unavailable",
    ),
    true,
  );
  assert.equal(JSON.stringify(outcomes).includes("private-worker-detail"), false);
});

test("source enhancement uses the same bounded fail-open lane instead of serial pre-render gating", async () => {
  const jobs = Array.from({ length: 5 }, (_, index) => ({
    key: `enhance-${index}`,
    source: new Blob([String(index)], { type: "audio/wav" }),
    contentType: "audio/wav",
    idempotencyKey: `enhance:batch:${index}`,
  }));
  let active = 0;
  let maximumActive = 0;
  const outcomes: ExtremeEnhancementOutcome[] = [];

  await enhanceExtremeSourcesBounded({
    jobs,
    enhance: async ({ idempotencyKey }): Promise<ExtremeEnhancementOutcome> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (idempotencyKey.endsWith(":0")) throw new Error("private-enhancer-detail");
      return { status: "unavailable", reason: "poll-timeout" };
    },
    onOutcome: ({ outcome }) => outcomes.push(outcome),
  });

  assert.equal(outcomes.length, jobs.length);
  assert.ok(maximumActive <= EXTREME_ML_MAX_CONCURRENT_ANALYSES);
  assert.equal(
    outcomes.some(
      (outcome) => outcome.status === "unavailable" && outcome.reason === "worker-unavailable",
    ),
    true,
  );
  assert.equal(JSON.stringify(outcomes).includes("private-enhancer-detail"), false);
});

test("six-file enhancement keeps draining two lanes after a synthetic global snapshot", async () => {
  const { start } = requireProgressiveEnhancementPolicy();
  const jobs = Array.from({ length: 6 }, (_, index) => ({
    key: `long-batch-${index}`,
    source: new Blob([String(index)], { type: "audio/wav" }),
    contentType: "audio/wav",
    idempotencyKey: `enhance:long-batch:${index}`,
  }));
  const launched: string[] = [];
  let active = 0;
  let maximumActive = 0;
  let markFirstTwoStarted: () => void = () => undefined;
  const firstTwoStarted = new Promise<void>((resolve) => {
    markFirstTwoStarted = resolve;
  });
  let releaseFirstTwo: () => void = () => undefined;
  const firstTwoRelease = new Promise<void>((resolve) => {
    releaseFirstTwo = resolve;
  });

  const batch = start({
    jobs,
    enhance: async ({ idempotencyKey }): Promise<ExtremeEnhancementOutcome> => {
      launched.push(idempotencyKey);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (launched.length === EXTREME_ML_MAX_CONCURRENT_ANALYSES) markFirstTwoStarted();
      const index = Number(idempotencyKey.split(":").at(-1));
      if (index < EXTREME_ML_MAX_CONCURRENT_ANALYSES) await firstTwoRelease;
      active -= 1;
      return { status: "unavailable", reason: "poll-timeout" };
    },
  });

  await firstTwoStarted;
  const syntheticSnapshot = await Promise.race([
    batch.completion.then(() => "batch-completed" as const),
    Promise.resolve("global-snapshot-elapsed" as const),
  ]);
  assert.equal(syntheticSnapshot, "global-snapshot-elapsed");
  assert.equal(launched.length, EXTREME_ML_MAX_CONCURRENT_ANALYSES);
  assert.equal(maximumActive, EXTREME_ML_MAX_CONCURRENT_ANALYSES);

  releaseFirstTwo();
  const outcomesByKey = await batch.completion;

  assert.deepEqual(
    [...launched].sort(),
    jobs.map(({ idempotencyKey }) => idempotencyKey).sort(),
    "a synthetic global snapshot must not starve the four later files",
  );
  assert.deepEqual([...outcomesByKey.keys()].sort(), jobs.map(({ key }) => key).sort());
  for (const { key } of jobs) {
    assert.deepEqual(outcomesByKey.get(key), { status: "unavailable", reason: "poll-timeout" });
  }
});

test("six-file enhancement preserves every advisory ML report when RNNoise has no candidate", async () => {
  const { start } = requireProgressiveEnhancementPolicy();
  const jobs = Array.from({ length: 6 }, (_, index) => ({
    key: `report-only-${index}`,
    source: new Blob([String(index)], { type: "audio/wav" }),
    contentType: "audio/wav",
    idempotencyKey: `enhance:report-only:${index}`,
  }));

  const batch = start({
    jobs,
    enhance: async ({ idempotencyKey }): Promise<ExtremeEnhancementOutcome> => {
      const index = Number(idempotencyKey.split(":").at(-1));
      const report = makeReport([0.91, 0.87], {
        modelSetId: `silero-dnsmos-sigmos-${index}`,
        metrics: {
          "dnsmos.ovrl": { value: 3.1 + index / 100, available: true, higherIsBetter: true },
          "sigmos.ovrl": { value: 3.0 + index / 100, available: true, higherIsBetter: true },
        },
      });
      return { status: "report-only", report, reason: "rnnoise-model-unavailable" };
    },
  });

  const outcomesByKey = await batch.completion;
  assert.equal(outcomesByKey.size, jobs.length);
  for (const [index, job] of jobs.entries()) {
    const outcome = outcomesByKey.get(job.key);
    assert.equal(outcome?.status, "report-only");
    if (outcome?.status !== "report-only") continue;
    assert.equal(outcome.report.modelSetId, `silero-dnsmos-sigmos-${index}`);
    assert.equal(outcome.report.metrics["dnsmos.ovrl"]?.available, true);
    assert.equal(outcome.report.metrics["sigmos.ovrl"]?.available, true);
  }
});

test("a per-file timeout keeps the original render path while a late report remains observable", async () => {
  const { start } = requireProgressiveEnhancementPolicy();
  const job = {
    key: "long-file-wait",
    source: new Blob(["long"], { type: "audio/wav" }),
    contentType: "audio/wav",
    idempotencyKey: "enhance:long-file-wait",
  };
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let finishEnhancement: () => void = () => undefined;
  const enhancementFinished = new Promise<void>((resolve) => {
    finishEnhancement = resolve;
  });
  const lateReport = makeReport([0.1, 0.9], {
    modelSetId: "late-silero-dnsmos-sigmos",
  });
  let reportsByKey: ReadonlyMap<string, ExtremeSourceReport> = new Map();
  const batch = start({
    jobs: [job],
    enhance: async (): Promise<ExtremeEnhancementOutcome> => {
      markStarted();
      await enhancementFinished;
      return { status: "report-only", report: lateReport, reason: "candidate-unavailable" };
    },
    onOutcome: ({ key, outcome }) => {
      if (!("report" in outcome)) return;
      reportsByKey = new Map([...reportsByKey, [key, outcome.report]]);
    },
  });

  await started;
  assert.deepEqual(await batch.waitForOutcome(job.key, 1), {
    status: "unavailable",
    reason: "per-file-timeout",
  });

  finishEnhancement();
  const completedOutcome = (await batch.completion).get(job.key);
  assert.equal(completedOutcome?.status, "report-only");
  assert.equal(reportsByKey.get(job.key), lateReport);
});

test("per-file render waits and worker polls expand for long sources", () => {
  const { getPerFileWaitMs, getMaxPolls } = requireProgressiveEnhancementPolicy();
  const shortSourceBytes = 1 * 1024 * 1024;
  const longSourceBytes = 512 * 1024 * 1024;

  assert.ok(getPerFileWaitMs(longSourceBytes) > getPerFileWaitMs(shortSourceBytes));
  assert.ok(getMaxPolls(longSourceBytes) > getMaxPolls(shortSourceBytes));
  assert.ok(Number.isFinite(getPerFileWaitMs(longSourceBytes)));
  assert.ok(Number.isInteger(getMaxPolls(longSourceBytes)));
});

test("poll budget does not underestimate a thirty-minute 16 kHz mono PCM16 source", () => {
  const { getMaxPolls } = requireProgressiveEnhancementPolicy();
  const durationSeconds = 30 * 60;
  const sourceBytes = durationSeconds * 16_000 * 2;

  assert.ok(
    getMaxPolls(sourceBytes) >= durationSeconds,
    "the smallest supported lossless layout must not be mistaken for a short file",
  );
});

test("render/source quality comparison exposes only finite paired advisory deltas", () => {
  const source = makeReport([0.1], {
    metrics: {
      "dnsmos.ovrl": { value: 3.5, available: true, higherIsBetter: true },
      "sigmos.disc": { value: 4.1, available: true, higherIsBetter: true },
      unavailable: { value: null, available: false, higherIsBetter: true },
    },
  });
  const rendered = makeReport([0.1], {
    metrics: {
      "dnsmos.ovrl": { value: 3.8, available: true, higherIsBetter: true },
      "sigmos.disc": { value: 3.9, available: true, higherIsBetter: true },
      unavailable: { value: 9, available: true, higherIsBetter: true },
    },
  });

  assert.deepEqual(compareExtremeQualityMetrics(source, {
    analysisRole: "rendered-deliverable",
    report: rendered,
  }), [
    { key: "dnsmos.ovrl", sourceValue: 3.5, renderedValue: 3.8, delta: 0.3, higherIsBetter: true },
    { key: "sigmos.disc", sourceValue: 4.1, renderedValue: 3.9, delta: -0.2, higherIsBetter: true },
  ]);
});

test("a rendered report wrapper cannot become gain-planner source evidence", () => {
  const rendered: ExtremeRenderedReport = {
    analysisRole: "rendered-deliverable",
    report: makeReport([0.95, 0.9, 0.92]),
  };
  const protection = buildPlannerMlProtection({
    report: rendered as unknown as ExtremeSourceReport,
    energySpeechMask: [true, true, false],
    plannerFrameMs: 10,
    rangeStartSec: 0,
  });

  assert.equal(protection.reason, "legacy-fallback");
  assert.equal(protection.protectedSpeechFrameMask, null);
});

test("VoLeveler exposes opt-in upload disclosure and keeps energy speech authoritative", async () => {
  const source = await readFile(new URL("../components/VoLeveler.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /const \[extremeMlEnabled, setExtremeMlEnabled\] = useState\(false\)/,
  );
  assert.match(source, /<strong>Extreme ML cleanup and speech protection \(optional\)<\/strong>/);
  assert.match(
    source,
    /Source, RNNoise candidate, and one final clean rendered WAV are uploaded directly to the isolated\s+Extreme worker/i,
  );
  assert.match(source, /enhanceSourceWithExtremeWorker/);
  assert.match(source, /startExtremeMlProgressiveEnhancementBatch/);
  assert.match(source, /getExtremeMlPerFileWaitMs/);
  assert.match(source, /getExtremeMlMaxPollsForSourceBytes/);
  assert.match(source, /const enhancementJobs = jobs\.map/);
  assert.match(source, /onOutcome:\s*\(\{ key, outcome \}\) =>/);
  assert.match(source, /retainLateExtremeMlReport/);
  assert.doesNotMatch(source, /\banalyzeExtremeSourcesBounded\b/);
  assert.doesNotMatch(source, /\banalyzeSourceWithExtremeWorker\b/);
  assert.doesNotMatch(source, /\bacceptingExtremeMl(?:Evidence|Enhancements)\b/);
  assert.doesNotMatch(source, /\bextremeMl(?:Analysis|Enhancement)Promise\b/);
  assert.doesNotMatch(source, /\bgetExtremeMlSnapshotGraceMs\b/);
  assert.doesNotMatch(source, /Render snapshot accepted|snapshot-timeout/i);
  assert.doesNotMatch(source, /maxPolls:\s*30\b/);
  assert.match(
    source,
    /activeExtremeMlSourceBatchRef\.current\s*===\s*extremeMlBatchId[\s\S]*?activeExtremeMlSourceBatchRef\.current\s*=\s*null/,
    "finished or failed runs must reject stale source-ML callbacks",
  );
  assert.match(
    source,
    /maxPolls:\s*getExtremeMlMaxPollsForSourceBytes\(input\.source\.size\)/,
  );

  const renderLoopIndex = source.indexOf("while (i < jobs.length)");
  const writeJobInputIndex = source.indexOf("await writeJobInput(ffmpeg", renderLoopIndex);
  assert.ok(renderLoopIndex >= 0);
  assert.ok(writeJobInputIndex > renderLoopIndex);
  const perFileAdoptionSource = source.slice(renderLoopIndex, writeJobInputIndex);
  assert.match(
    perFileAdoptionSource,
    /await\s+\w+\.waitForOutcome\(\s*job\.inputName,\s*getExtremeMlPerFileWaitMs\(job\.file\.size\)\s*\)/,
  );
  assert.match(perFileAdoptionSource, /\[job\.inputName,\s*outcome\.report\]/);
  assert.match(perFileAdoptionSource, /new File\(\s*\[outcome\.candidate\]/);
  assert.match(source, /RNNoise candidate/i);
  assert.match(source, /analyzeRenderedWithExtremeWorker/);
  assert.match(source, /If the worker is unavailable\s+or late, the browser pipeline runs unchanged/i);
  assert.match(source, /const mask = buildSpeechMask\(/);
  assert.match(source, /speechRunsFromMask\(mask\)/);
  assert.match(source, /buildPlannerMlProtection\(/);
  assert.match(source, /protectedSpeechFrameMask:\s*mlProtection\.protectedSpeechFrameMask \?\? undefined/);
  assert.match(source, /speechSpikeTamingBoost: mlSourceQualityPolicy\.speechSpikeTamingBoost/);
  assert.match(source, /perceptualStabilityRisk: mlSourceQualityPolicy\.perceptualStabilityRisk/);
  assert.match(source, /const mlSpeechSpikeTamingBoost =\s+profile\?\.speechSpikeTamingBoost \?\? mlSourceQualityPolicy\.speechSpikeTamingBoost/);
  assert.match(source, /const perceptualStabilityRisk =\s+profile\?\.perceptualStabilityRisk \?\? mlSourceQualityPolicy\.perceptualStabilityRisk/);
  assert.match(source, /\+\s+mlSpeechSpikeTamingBoost/);
  assert.match(source, /perceptualStabilityRisk,/);
  assert.doesNotMatch(source, /profile\?\.speechSpikeTamingBoost[\s\S]{0,160}\+\s+mlSourceQualityPolicy\.speechSpikeTamingBoost/);
  const exposeOutputsIndex = source.indexOf("setOutputs([...finalOutputEntries])");
  const postRenderAnalysisIndex = source.indexOf(
    "analyzeExtremeRenderedOutputsBounded",
    exposeOutputsIndex,
  );
  assert.ok(exposeOutputsIndex >= 0);
  assert.ok(postRenderAnalysisIndex > exposeOutputsIndex);
  assert.doesNotMatch(
    source.slice(exposeOutputsIndex, postRenderAnalysisIndex + 80),
    /await\s+analyzeExtremeRenderedOutputsBounded/,
  );
  assert.doesNotMatch(source, /mlProtection\.(?:gainDb|eq|compressor|limiter|selectedCandidate)/i);
  assert.doesNotMatch(source, /enhanceSourceWithExtremeWorker[\s\S]{0,1200}(?:gainDb|targetLufs|loudnorm|dynaudnorm)/i);
});
