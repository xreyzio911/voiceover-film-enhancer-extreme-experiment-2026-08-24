import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  normalizeFfmpegProgressRatio,
  runFfmpegOperationWithOneResetRetry,
  shouldPublishGenericFfmpegProgress,
  shouldRecycleFfmpegBeforeOperation,
  shouldRetryFfmpegOperationAfterReset,
} from "./ffmpegLifecyclePolicy.ts";

test("generic FFmpeg progress rejects non-finite values and clamps untrusted ratios", () => {
  assert.equal(normalizeFfmpegProgressRatio(0.42), 0.42);
  assert.equal(normalizeFfmpegProgressRatio(1.4), 1);
  assert.equal(normalizeFfmpegProgressRatio(7_686_015_263.79), 1);
  assert.equal(normalizeFfmpegProgressRatio(0), null);
  assert.equal(normalizeFfmpegProgressRatio(-0.1), null);
  assert.equal(normalizeFfmpegProgressRatio(Number.NaN), null);
  assert.equal(normalizeFfmpegProgressRatio(Number.POSITIVE_INFINITY), null);
});

test("generic FFmpeg progress only updates an active file queue item", () => {
  assert.equal(shouldPublishGenericFfmpegProgress("episode-01"), true);
  assert.equal(shouldPublishGenericFfmpegProgress(""), false);
  assert.equal(shouldPublishGenericFfmpegProgress(null), false);
});

test("FFmpeg recycling is decided before pending work, never after the final operation", () => {
  assert.equal(shouldRecycleFfmpegBeforeOperation(2399, 2400), false);
  assert.equal(shouldRecycleFfmpegBeforeOperation(2400, 2400), true);
  assert.equal(shouldRecycleFfmpegBeforeOperation(2767, 2400), true);
  assert.equal(shouldRecycleFfmpegBeforeOperation(Number.NaN, 2400), false);
  assert.equal(shouldRecycleFfmpegBeforeOperation(2767, 0), false);
});

test("a resettable FFmpeg operation receives exactly one fresh-worker retry", () => {
  assert.equal(shouldRetryFfmpegOperationAfterReset(true, 0), true);
  assert.equal(shouldRetryFfmpegOperationAfterReset(true, 1), false);
  assert.equal(shouldRetryFfmpegOperationAfterReset(false, 0), false);
  assert.equal(shouldRetryFfmpegOperationAfterReset(true, -1), false);
  assert.equal(shouldRetryFfmpegOperationAfterReset(true, Number.NaN), false);
});

test("one-reset retry reruns the complete operation on the fresh worker", async () => {
  const events: string[] = [];
  const outcome = await runFfmpegOperationWithOneResetRetry({
    worker: "worker-1",
    operation: async (worker, attempt) => {
      events.push(`write:${worker}:${attempt}`);
      events.push(`analyze:${worker}:${attempt}`);
      if (attempt === 0) throw new WebAssembly.RuntimeError("memory access out of bounds");
      return "measured";
    },
    shouldReset: (error) => error instanceof WebAssembly.RuntimeError,
    reset: async (worker) => {
      events.push(`reset:${worker}`);
      return "worker-2";
    },
  });

  assert.deepEqual(outcome, {
    result: "measured",
    worker: "worker-2",
    retried: true,
  });
  assert.deepEqual(events, [
    "write:worker-1:0",
    "analyze:worker-1:0",
    "reset:worker-1",
    "write:worker-2:1",
    "analyze:worker-2:1",
  ]);
});

test("a failed reset retry is surfaced without a third operation attempt", async () => {
  let operationCalls = 0;
  let resetCalls = 0;

  await assert.rejects(
    runFfmpegOperationWithOneResetRetry({
      worker: "worker-1",
      operation: async (_worker, attempt) => {
        operationCalls += 1;
        throw new Error(attempt === 0 ? "fatal first attempt" : "retry failed");
      },
      shouldReset: () => true,
      reset: async () => {
        resetCalls += 1;
        return "worker-2";
      },
    }),
    /retry failed/,
  );

  assert.equal(operationCalls, 2);
  assert.equal(resetCalls, 1);
});

test("a non-resettable operation failure is surfaced without resetting or retrying", async () => {
  let operationCalls = 0;
  let resetCalls = 0;

  await assert.rejects(
    runFfmpegOperationWithOneResetRetry({
      worker: "worker-1",
      operation: async () => {
        operationCalls += 1;
        throw new Error("unsupported source");
      },
      shouldReset: () => false,
      reset: async () => {
        resetCalls += 1;
        return "worker-2";
      },
    }),
    /unsupported source/,
  );

  assert.equal(operationCalls, 1);
  assert.equal(resetCalls, 0);
});

test("source analysis rewrites the input and retries once before using empty evidence", () => {
  const source = readFileSync(new URL("../components/VoLeveler.tsx", import.meta.url), "utf8");
  const analysisStart = source.indexOf("const analyses: FileAnalysis[] = [];");
  const analysisEnd = source.indexOf("batchReference = buildBatchReference(analyses);", analysisStart);
  const analysisSource = source.slice(analysisStart, analysisEnd);

  assert.match(
    analysisSource,
    /runFfmpegOperationWithOneResetRetry\(\{[\s\S]*?operation: async \(activeFfmpeg\)[\s\S]*?await writeJobInput\(activeFfmpeg, job\)[\s\S]*?return analyzeFile\(activeFfmpeg, job\.inputName\)[\s\S]*?shouldReset: shouldResetFfmpegForError[\s\S]*?reset: async[\s\S]*?refreshFfmpeg\(`analysis retry on \$\{job\.base\}`\)[\s\S]*?createEmptyAnalysis\(\)/,
  );
});

test("VoLeveler applies lifecycle policies at the listener and before alignment operations", () => {
  const source = readFileSync(new URL("../components/VoLeveler.tsx", import.meta.url), "utf8");
  const alignmentStart = source.indexOf("const alignBatchMixReadyOutputs");
  const alignmentEnd = source.indexOf("const processFiles", alignmentStart);
  const alignmentSource = source.slice(alignmentStart, alignmentEnd);

  assert.match(source, /shouldPublishGenericFfmpegProgress\(activeBase\)/);
  assert.match(alignmentSource, /await recycleBeforeOperation\("measure"\)[\s\S]*?writeFile\(inputName/);
  assert.match(
    alignmentSource,
    /const recycleBeforeFullBlobCopy[\s\S]*?await recycleBeforeOperation\(stage\)[\s\S]*?refreshFfmpeg\([\s\S]*?await recycleBeforeFullBlobCopy\(target\.entry, "render"\)[\s\S]*?writeFile\(inputName/,
  );
  assert.doesNotMatch(alignmentSource, /await noteProcessedAudio/);
});
