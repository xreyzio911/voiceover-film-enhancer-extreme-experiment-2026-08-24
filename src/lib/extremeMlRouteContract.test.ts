import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const routePath = resolve(ROOT, "src/app/api/extreme-ml/ticket/route.ts");

test("Extreme ML ticket route authenticates metadata-only direct-to-Render uploads", () => {
  assert.equal(existsSync(routePath), true);
  const source = readFileSync(routePath, "utf8");
  assert.match(source, /getServerAuthSession/);
  assert.match(source, /isAllowedEmail/);
  assert.match(source, /isLocalHost/);
  assert.match(source, /EXTREME_ML_WORKER_URL/);
  assert.match(source, /EXTREME_ML_INTERNAL_SECRET/);
  assert.match(source, /internal\/v1\/tickets/);
  assert.match(source, /sizeBytes/);
  assert.match(source, /idempotencyKey/);
  assert.match(source, /source_analysis/);
  assert.match(source, /render_analysis/);
  assert.doesNotMatch(source, /formData\s*\(/);
  assert.doesNotMatch(source, /arrayBuffer\s*\(/);
  assert.doesNotMatch(source, /request\.body/);
});
