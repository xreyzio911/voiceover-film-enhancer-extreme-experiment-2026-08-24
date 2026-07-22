import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isAiAutoPilotEnabled } from "./aiAutoPilotPolicy.ts";
import { shouldEmitMixReadyOutput } from "./outputDeliveryPolicy.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readProjectFile = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

test("VO UI keeps the mix-ready target without the three retired controls", () => {
  const source = readProjectFile("src/components/VoLeveler.tsx");

  assert.match(source, /Mix-ready only \(no loudness normalize\)/);
  assert.equal(source.includes("<strong>Keep mix-ready file</strong>"), false);
  assert.equal(source.includes("<strong>Neural speech enhancement</strong>"), false);
  assert.equal(source.includes("<strong>AI Auto Pilot</strong>"), false);
  assert.equal(source.includes("keepMixReady"), false);
});

test("neural speech enhancement implementation is removed", () => {
  const retiredPaths = [
    "src/app/api/neural-repair/route.ts",
    "src/lib/neuralRepairPolicy.ts",
    "src/lib/neuralRepairRuntime.ts",
    "src/lib/neuralRepairClient.ts",
    "src/lib/neuralRepairChunkPolicy.ts",
    "scripts/neural_repair_worker.py",
    "scripts/neural_repair_http_worker.py",
  ];

  for (const path of retiredPaths) {
    assert.equal(existsSync(resolve(ROOT, path)), false, `${path} should not exist`);
  }

  assert.doesNotMatch(readProjectFile(".env.example"), /VO_NEURAL|NEXT_PUBLIC_VO_NEURAL/);
  assert.doesNotMatch(readProjectFile("package.json"), /neuralRepair/);
  assert.doesNotMatch(readProjectFile("eslint.config.mjs"), /.venv-neural/);
  assert.equal(existsSync(resolve(process.cwd(), "tasks/vo-enhancement-production-research-2026-06-19.md")), false);
});

test("AI review backend remains available while Auto Pilot defaults off", () => {
  assert.equal(existsSync(resolve(ROOT, "src/app/api/audio-review/route.ts")), true);
  assert.equal(existsSync(resolve(ROOT, "src/lib/aiAudioReview.ts")), true);
  assert.match(readProjectFile(".env.example"), /^VO_AI_AUTO_PILOT_ENABLED=off$/m);
});

test("manual AI Review UI is absent while the opt-in processing integration remains available", () => {
  const source = readProjectFile("src/components/VoLeveler.tsx");

  assert.doesNotMatch(source, />\s*AI Review\s*</);
  assert.doesNotMatch(source, /id="ai-review-title"/);
  assert.doesNotMatch(source, /aiReviewOpen/);
  assert.match(source, /runAiAudioReview/);
  assert.match(source, /runAiAudioReview\(sourceReviewFiles,\s*\{[\s\S]*?source: "source-auto"/);
  assert.match(source, /runAiAudioReview\(\[postReviewFile\],\s*\{[\s\S]*?source: "post-render"/);
});

test("all automatic Gemini audio-review paths stay off until Auto Pilot is explicitly enabled", () => {
  const source = readProjectFile("src/components/VoLeveler.tsx");
  const route = readProjectFile("src/app/api/audio-review/route.ts");

  assert.match(source, /if \(aiAutoPilotEnabled && sourceReviewFiles\.length > 0\)/);
  assert.match(
    source,
    /if \(aiAutoPilotEnabled && postRenderReviewRequests < POST_RENDER_REVIEW_MAX_REQUESTS\)/,
  );
  assert.match(route, /!isAiAutoPilotEnabled\(process\.env\.VO_AI_AUTO_PILOT_ENABLED\)/);
});

test("AI Auto Pilot is optional and disabled unless explicitly enabled", () => {
  assert.equal(isAiAutoPilotEnabled(undefined), false);
  assert.equal(isAiAutoPilotEnabled(""), false);
  assert.equal(isAiAutoPilotEnabled("off"), false);
  assert.equal(isAiAutoPilotEnabled("false"), false);
  assert.equal(isAiAutoPilotEnabled("unexpected"), false);
  assert.equal(isAiAutoPilotEnabled("on"), true);
  assert.equal(isAiAutoPilotEnabled("true"), true);
  assert.equal(isAiAutoPilotEnabled("1"), true);
});

test("mix-ready is emitted only when no loudness-normalized export is selected", () => {
  assert.equal(shouldEmitMixReadyOutput(false), true);
  assert.equal(shouldEmitMixReadyOutput(true), false);
});
