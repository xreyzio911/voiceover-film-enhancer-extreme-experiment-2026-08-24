import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const voLevelerSource = () => readFileSync(resolve("src/components/VoLeveler.tsx"), "utf8");

test("Extreme worker VAD is wired as advisory gain-planner tail protection only", () => {
  const source = voLevelerSource();
  assert.match(source, /enhanceSourceWithExtremeWorker/);
  assert.match(source, /startExtremeMlProgressiveEnhancementBatch/);
  assert.match(source, /getExtremeMlMaxPollsForSourceBytes/);
  assert.match(source, /getExtremeMlPerFileWaitMs/);
  assert.match(source, /buildPlannerMlProtection/);
  assert.match(source, /protectedSpeechFrameMask:\s*mlProtection\.protectedSpeechFrameMask \?\? undefined/);
  assert.match(source, /source report reused/);
  assert.match(source, /original source stays active/);
  assert.match(source, /original source render starts/);
  assert.match(source, /runtimeStatus === "degraded"/);
  assert.match(source, /source quality evidence/);
  assert.match(source, /ExtremeML.*advisory/i);
  assert.doesNotMatch(source, /\banalyzeSourceWithExtremeWorker\b/);
  assert.doesNotMatch(source, /\bacceptingExtremeMlEvidence\b/);
  assert.doesNotMatch(source, /\bgetExtremeMlSnapshotGraceMs\b/);
  assert.doesNotMatch(source, /throw new Error\([^)]*ExtremeML/i);
});
