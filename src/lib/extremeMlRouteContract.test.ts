import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const routePath = resolve(ROOT, "src/app/api/extreme-ml/ticket/route.ts");
const envExamplePath = resolve(ROOT, ".env.example");
const nextConfigPath = resolve(ROOT, "next.config.js");

test("Extreme ML ticket route authenticates metadata-only direct-to-Render uploads", () => {
  assert.equal(existsSync(routePath), true);
  const source = readFileSync(routePath, "utf8");
  assert.match(source, /getServerAuthSession/);
  assert.match(source, /isAllowedEmail/);
  assert.match(source, /isLocalHost\(request\.nextUrl\.hostname\)/);
  assert.match(source, /EXTREME_ML_WORKER_URL/);
  assert.match(source, /EXTREME_ML_ALLOWED_WORKER_ORIGINS/);
  assert.match(source, /EXTREME_ML_INTERNAL_SECRET/);
  assert.match(source, /internal\/v1\/tickets/);
  assert.match(source, /sizeBytes/);
  assert.match(source, /idempotencyKey/);
  assert.match(source, /source_analysis/);
  assert.match(source, /render_analysis/);
  assert.match(source, /readBoundedJson/);
  assert.match(source, /consumeFixedWindowRateLimit/);
  assert.match(source, /normalizeExtremeWorkerAllowedOrigins/);
  assert.match(source, /redirect:\s*["']error["']/);
  assert.doesNotMatch(source, /formData\s*\(/);
  assert.doesNotMatch(source, /arrayBuffer\s*\(/);
  assert.doesNotMatch(source, /request\.json\s*\(/);
  assert.doesNotMatch(source, /request\.body/);
  assert.doesNotMatch(source, /x-forwarded-for/);
  assert.doesNotMatch(source, /x-forwarded-host/);
});

test("Extreme worker config documents one exact HTTPS origin for server and browser trust", () => {
  const values = Object.fromEntries(
    readFileSync(envExamplePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  const workerUrl = values.EXTREME_ML_WORKER_URL;
  assert.match(workerUrl, /^https:\/\//);
  assert.equal(values.EXTREME_ML_ALLOWED_WORKER_ORIGINS, workerUrl);
  assert.equal(values.NEXT_PUBLIC_EXTREME_ML_ALLOWED_WORKER_ORIGINS, workerUrl);
});

test("Next config never derives the public worker allowlist from a server-only setting", () => {
  const source = readFileSync(nextConfigPath, "utf8");
  assert.doesNotMatch(source, /process\.env\.EXTREME_ML_ALLOWED_WORKER_ORIGINS/);
  assert.doesNotMatch(source, /EXTREME_ML_INTERNAL_SECRET/);
  assert.doesNotMatch(source, /GOOGLE_CLIENT_SECRET/);
  assert.doesNotMatch(source, /AUTH_SECRET/);
});
