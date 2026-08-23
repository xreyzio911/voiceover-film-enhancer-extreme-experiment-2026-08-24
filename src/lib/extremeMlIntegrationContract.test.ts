import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const voLevelerSource = () => readFileSync(resolve("src/components/VoLeveler.tsx"), "utf8");

test("Extreme worker VAD is wired as advisory gain-planner tail protection only", () => {
  const source = voLevelerSource();
  assert.match(source, /analyzeSourceWithExtremeWorker/);
  assert.match(source, /buildPlannerMlProtection/);
  assert.match(source, /protectedSpeechFrameMask:\s*mlProtection\.protectedSpeechFrameMask \?\? undefined/);
  assert.match(source, /acceptingExtremeMlEvidence = false/);
  assert.match(source, /browser processing remains unchanged/);
  assert.match(source, /ExtremeML.*advisory/i);
  assert.doesNotMatch(source, /throw new Error\([^)]*ExtremeML/i);
});
