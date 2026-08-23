import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ExtremeAnalysisOutcome, ExtremeSourceReport } from "./extremeMlClient.ts";
import {
  EXTREME_ML_MAX_CONCURRENT_ANALYSES,
  analyzeExtremeSourcesBounded,
  buildPlannerMlProtection,
  resolvePlannerVadFrames,
} from "./extremeMlVoPolicy.ts";

const SHA256 = "a".repeat(64);
const REVISION = "b".repeat(40);

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

test("VoLeveler exposes opt-in upload disclosure and keeps energy speech authoritative", async () => {
  const source = await readFile(new URL("../components/VoLeveler.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /const \[extremeMlEnabled, setExtremeMlEnabled\] = useState\(false\)/,
  );
  assert.match(source, /<strong>Extreme ML speech protection \(optional\)<\/strong>/);
  assert.match(source, /source WAVs? (?:are |will be )?uploaded directly to (?:the )?isolated Extreme worker/i);
  assert.match(source, /If (?:the )?worker (?:is )?unavailable or late[\s\S]{0,120}browser pipeline/i);
  assert.match(source, /const mask = buildSpeechMask\(/);
  assert.match(source, /speechRunsFromMask\(mask\)/);
  assert.match(source, /buildPlannerMlProtection\(/);
  assert.match(source, /protectedSpeechFrameMask:\s*mlProtection\.protectedSpeechFrameMask \?\? undefined/);
  assert.match(
    source,
    /acceptingExtremeMlEvidence = false;[\s\S]{0,500}let hadErrors = false/,
  );
  assert.doesNotMatch(source, /mlProtection\.(?:gainDb|eq|compressor|limiter|selectedCandidate)/i);
});
