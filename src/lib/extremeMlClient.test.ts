import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  enhanceSourceWithExtremeWorker,
  analyzeRenderedWithExtremeWorker,
  analyzeSourceWithExtremeWorker,
  normalizeExtremeSourceReport,
  normalizeExtremeWorkerBaseUrl,
  type ExtremeSourceReport,
} from "./extremeMlClient.ts";

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const validReport = (sourceSha256 = "a".repeat(64)): unknown => ({
  schemaVersion: 1,
  advisoryOnly: true,
  canBlockDelivery: false,
  canChangeGainDb: false,
  levelAuthority: "gainPlanner",
  modelSetId: "extreme-core-2026-08-24",
  source: {
    sha256: sourceSha256,
    durationMs: 120,
    sampleRate: 48_000,
    channels: 1,
  },
  vad: {
    frameMs: 10,
    frames: [
      { startMs: 0, endMs: 10, speechProbability: 0.1 },
      { startMs: 10, endMs: 20, speechProbability: 0.92 },
      { startMs: 20, endMs: 30, speechProbability: 0.9 },
    ],
  },
  metrics: {
    "dnsmos.ovrl": { value: 3.8, available: true, higherIsBetter: true },
    "speaker.cosine": { value: null, available: false, higherIsBetter: true },
  },
  models: [
    {
      id: "silero-vad",
      version: "6.2.1",
      revision: "pypi:6.2.1",
      sha256: "c".repeat(64),
    },
  ],
  telemetry: {
    runtimeStatus: "ready",
    reason: "ok",
    audioMutation: false,
    candidateSelected: false,
    gainDbChanged: false,
  },
});

test("worker URL accepts only an exact configured HTTPS origin or explicit local development", () => {
  const trustedOrigins = ["https://extreme-worker.onrender.com"];
  assert.equal(
    normalizeExtremeWorkerBaseUrl(
      "https://extreme-worker.onrender.com/",
      trustedOrigins,
    ),
    "https://extreme-worker.onrender.com",
  );
  assert.equal(
    normalizeExtremeWorkerBaseUrl(
      "https://attacker.example",
      trustedOrigins,
    ),
    null,
  );
  assert.equal(
    normalizeExtremeWorkerBaseUrl("http://localhost:8787", [], true),
    "http://localhost:8787",
  );
  assert.equal(
    normalizeExtremeWorkerBaseUrl("http://127.0.0.1:8787/", [], false),
    null,
  );
  for (const loopback of [
    "https://localhost:8787",
    "https://127.0.0.1:8787",
    "https://[::1]:8787",
  ]) {
    const loopbackOrigin = new URL(loopback).origin;
    assert.equal(
      normalizeExtremeWorkerBaseUrl(loopback, [loopbackOrigin], false),
      null,
      `production loopback must remain denied: ${loopback}`,
    );
    assert.equal(
      normalizeExtremeWorkerBaseUrl(loopback, [], true),
      loopbackOrigin,
      `development loopback should remain available: ${loopback}`,
    );
  }
  for (const value of [
    "http://extreme-worker.onrender.com",
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com?redirect=evil",
    "javascript:alert(1)",
    "",
  ]) {
    assert.equal(normalizeExtremeWorkerBaseUrl(value, trustedOrigins, false), null, value);
  }
});

test("a forged ticket cannot send job credentials or audio to an arbitrary HTTPS origin", async () => {
  const source = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const outcome = await analyzeSourceWithExtremeWorker({
    source,
    contentType: "audio/wav",
    idempotencyKey: "forged-worker-origin",
    allowedWorkerOrigins: ["https://trusted-worker.example"],
    fetchImpl: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/extreme-ml/ticket") {
        return Response.json({
          workerBaseUrl: "https://attacker.example",
          ticket: "stolen-if-forwarded",
          expiresAt: "2026-08-24T01:00:00.000Z",
        });
      }
      return Response.json({
        jobId: "attacker-job",
        accessToken: "attacker-token",
        uploadOffset: 0,
        maxChunkBytes: 16,
      });
    },
    sleep: async () => undefined,
  });

  assert.deepEqual(outcome, { status: "unavailable", reason: "ticket-unavailable" });
  assert.deepEqual(calls.map((call) => call.url), ["/api/extreme-ml/ticket"]);
  assert.equal(calls.some((call) => call.init.body instanceof Blob), false);
  assert.equal(calls.some((call) => new Headers(call.init.headers).has("Authorization")), false);
});

test("untrusted worker reports cannot gain authority, gate delivery, or smuggle invalid frames", () => {
  const unsafe = {
    ...(validReport() as Record<string, unknown>),
    canBlockDelivery: true,
    canChangeGainDb: true,
    levelAuthority: "worker",
  };
  assert.equal(normalizeExtremeSourceReport(unsafe), null);

  const malformedFrames = validReport() as {
    vad: { frameMs: number; frames: Array<{ startMs: number; endMs: number; speechProbability: number }> };
  };
  malformedFrames.vad.frames[1].startMs = -1;
  assert.equal(normalizeExtremeSourceReport(malformedFrames), null);

  const report = normalizeExtremeSourceReport(validReport());
  assert.ok(report);
  assert.equal(report.advisoryOnly, true);
  assert.equal(report.canBlockDelivery, false);
  assert.equal(report.canChangeGainDb, false);
  assert.equal(report.levelAuthority, "gainPlanner");
  assert.equal(report.telemetry.runtimeStatus, "ready");
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.vad.frames), true);
});

test("worker telemetry must prove advisory execution without audio mutation or hidden gain changes", () => {
  const unsafe = validReport() as { telemetry: { gainDbChanged: boolean } };
  unsafe.telemetry.gainDbChanged = true;
  assert.equal(normalizeExtremeSourceReport(unsafe), null);

  const degraded = validReport() as {
    telemetry: {
      runtimeStatus: string;
      reason: string;
      audioMutation: boolean;
      candidateSelected: boolean;
      gainDbChanged: boolean;
    };
  };
  degraded.telemetry.runtimeStatus = "degraded";
  degraded.telemetry.reason = "model-unavailable";
  const normalized = normalizeExtremeSourceReport(degraded);
  assert.ok(normalized);
  assert.equal(normalized.telemetry.runtimeStatus, "degraded");
  assert.equal(normalized.telemetry.reason, "model-unavailable");
});

test("source analysis sends only metadata through Vercel and WAV bytes directly to Render", async () => {
  const sourceBytes = Uint8Array.from({ length: 10 }, (_, index) => index + 1);
  const sourceSha256 = sha256Hex(sourceBytes);
  const source = new Blob([sourceBytes], { type: "audio/wav" });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let statusPolls = 0;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (url === "/api/extreme-ml/ticket") {
      return Response.json({
        workerBaseUrl: "https://extreme-worker.onrender.com",
        ticket: "ticket_opaque",
        expiresAt: "2026-08-24T01:00:00.000Z",
      });
    }
    if (url.endsWith("/v1/jobs")) {
      return Response.json({ jobId: "job_123", accessToken: "job_secret", uploadOffset: 0, maxChunkBytes: 4 });
    }
    if (url.endsWith("/input") && init.method === "PATCH") {
      return new Response(null, {
        status: 204,
        headers: { "Upload-Offset": String(Number(new Headers(init.headers).get("Upload-Offset")) + (init.body as Blob).size) },
      });
    }
    if (url.endsWith("/input/complete")) return Response.json({ state: "queued" });
    if (url.endsWith("/report")) return Response.json(validReport(sourceSha256));
    if (url.endsWith("/v1/jobs/job_123")) {
      statusPolls += 1;
      return Response.json({ state: statusPolls < 2 ? "running" : "succeeded", progress: statusPolls < 2 ? 0.5 : 1 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const outcome = await analyzeSourceWithExtremeWorker({
    source,
    contentType: "audio/wav",
    idempotencyKey: "batch-1-file-1",
    fetchImpl,
    sleep: async () => undefined,
    chunkBytes: 4,
    maxPolls: 4,
    allowedWorkerOrigins: ["https://extreme-worker.onrender.com"],
  });

  assert.equal(outcome.status, "succeeded");
  assert.equal((outcome as { report: ExtremeSourceReport }).report.levelAuthority, "gainPlanner");
  const ticketCall = calls.find((call) => call.url === "/api/extreme-ml/ticket");
  assert.ok(ticketCall);
  assert.equal(typeof ticketCall.init.body, "string");
  assert.doesNotMatch(ticketCall.init.body as string, /job_secret|RIFF|sourceBytes/);
  assert.deepEqual(JSON.parse(ticketCall.init.body as string), {
    sizeBytes: 10,
    contentType: "audio/wav",
    idempotencyKey: "batch-1-file-1",
    scope: "source_analysis",
    sha256: sourceSha256,
  });

  const uploadCalls = calls.filter((call) => call.url.endsWith("/input") && call.init.method === "PATCH");
  assert.deepEqual(uploadCalls.map((call) => Number(new Headers(call.init.headers).get("Upload-Offset"))), [0, 4, 8]);
  assert.deepEqual(uploadCalls.map((call) => (call.init.body as Blob).size), [4, 4, 2]);
  assert.equal(uploadCalls.every((call) => call.url.startsWith("https://extreme-worker.onrender.com/")), true);
  assert.equal(uploadCalls.every((call) => new Headers(call.init.headers).get("Authorization") === "Bearer job_secret"), true);
  assert.equal(
    calls
      .filter((call) => call.url.startsWith("https://extreme-worker.onrender.com/"))
      .every((call) => call.init.redirect === "error"),
    true,
  );
});

test("source reports must match the exact uploaded source hash before becoming evidence", async () => {
  const sourceBytes = Uint8Array.from([10, 20, 30, 40]);
  const source = new Blob([sourceBytes], { type: "audio/wav" });
  let statusPolls = 0;
  const outcome = await analyzeSourceWithExtremeWorker({
    source,
    contentType: "audio/wav",
    idempotencyKey: "source-hash-mismatch",
    fetchImpl: async (input, init = {}) => {
      const url = String(input);
      if (url === "/api/extreme-ml/ticket") {
        return Response.json({
          workerBaseUrl: "https://worker.example",
          ticket: "ticket_opaque",
          expiresAt: "2026-08-24T01:00:00.000Z",
        });
      }
      if (url.endsWith("/v1/jobs")) {
        return Response.json({ jobId: "hash_job", accessToken: "hash_secret", uploadOffset: 0, maxChunkBytes: 16 });
      }
      if (url.endsWith("/input") && init.method === "PATCH") {
        return new Response(null, { status: 204, headers: { "Upload-Offset": String(source.size) } });
      }
      if (url.endsWith("/input/complete")) return Response.json({ state: "queued" });
      if (url.endsWith("/v1/jobs/hash_job")) {
        statusPolls += 1;
        return Response.json({ state: statusPolls < 2 ? "running" : "succeeded" });
      }
      if (url.endsWith("/report")) return Response.json(validReport("f".repeat(64)));
      throw new Error(`Unexpected request: ${url}`);
    },
    sleep: async () => undefined,
    maxPolls: 4,
    allowedWorkerOrigins: ["https://worker.example"],
  });

  assert.deepEqual(outcome, { status: "unavailable", reason: "report-invalid" });
});

test("render analysis keeps its distinct least-privilege scope through ticket and job admission", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const sourceBytes = new Uint8Array([1, 2, 3]);
  const sourceSha256 = sha256Hex(sourceBytes);
  const outcome = await analyzeRenderedWithExtremeWorker({
    source: new Blob([sourceBytes], { type: "audio/wav" }),
    contentType: "audio/wav",
    idempotencyKey: "render-1",
    fetchImpl: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/extreme-ml/ticket") {
        return Response.json({
          workerBaseUrl: "https://worker.example",
          ticket: "ticket_opaque",
          expiresAt: "2026-08-24T01:00:00.000Z",
        });
      }
      if (url.endsWith("/v1/jobs")) {
        return Response.json({
          jobId: "render_job",
          accessToken: "render_secret",
          uploadOffset: 0,
          maxChunkBytes: 16,
        });
      }
      if (url.endsWith("/input") && init.method === "PATCH") {
        return new Response(null, { status: 204, headers: { "Upload-Offset": "3" } });
      }
      if (url.endsWith("/input/complete")) return Response.json({ state: "queued" });
      if (url.endsWith("/report")) return Response.json(validReport(sourceSha256));
      if (url.endsWith("/v1/jobs/render_job")) return Response.json({ state: "succeeded" });
      throw new Error(`Unexpected request: ${url}`);
    },
    sleep: async () => undefined,
    allowedWorkerOrigins: ["https://worker.example"],
  });

  assert.equal(outcome.status, "succeeded");
  if (outcome.status === "succeeded") {
    assert.equal(outcome.renderedReport.analysisRole, "rendered-deliverable");
    assert.equal(outcome.renderedReport.report.levelAuthority, "gainPlanner");
    assert.equal(Object.isFrozen(outcome.renderedReport), true);
  }
  for (const call of calls) {
    if (typeof call.init.body !== "string") continue;
    if (call.url.endsWith("/input/complete")) continue;
    assert.equal(JSON.parse(call.init.body as string).scope, "render_analysis");
  }
});

test("enhancement candidate downloads optional WAV bytes without granting gain authority", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const enhancedBytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
  const sourceBytes = new Uint8Array([1, 2, 3]);
  const sourceSha256 = sha256Hex(sourceBytes);
  const candidateSha256 = sha256Hex(enhancedBytes);
  const outcome = await enhanceSourceWithExtremeWorker({
    source: new Blob([sourceBytes], { type: "audio/wav" }),
    contentType: "audio/wav",
    idempotencyKey: "enhance-1",
    fetchImpl: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/extreme-ml/ticket") {
        return Response.json({
          workerBaseUrl: "https://worker.example",
          ticket: "ticket_opaque",
          expiresAt: "2026-08-24T01:00:00.000Z",
        });
      }
      if (url.endsWith("/v1/jobs")) {
        return Response.json({
          jobId: "enhance_job",
          accessToken: "enhance_secret",
          uploadOffset: 0,
          maxChunkBytes: 16,
        });
      }
      if (url.endsWith("/input") && init.method === "PATCH") {
        return new Response(null, { status: 204, headers: { "Upload-Offset": "3" } });
      }
      if (url.endsWith("/input/complete")) return Response.json({ state: "queued" });
      if (url.endsWith("/report")) {
        return Response.json({
          ...(validReport(sourceSha256) as Record<string, unknown>),
          candidate: {
            role: "enhancement_candidate",
            sha256: candidateSha256,
            durationMs: 120,
            sampleRate: 48_000,
            channels: 1,
          },
          telemetry: {
            ...(validReport(sourceSha256) as { telemetry: Record<string, unknown> }).telemetry,
            candidateSelected: true,
          },
        });
      }
      if (url.endsWith("/candidate")) return new Response(enhancedBytes, { headers: { "Content-Type": "audio/wav" } });
      if (url.endsWith("/v1/jobs/enhance_job")) return Response.json({ state: "succeeded" });
      throw new Error(`Unexpected request: ${url}`);
    },
    sleep: async () => undefined,
    allowedWorkerOrigins: ["https://worker.example"],
  });

  assert.equal(outcome.status, "succeeded");
  if (outcome.status === "succeeded") {
    assert.equal(outcome.report.levelAuthority, "gainPlanner");
    assert.equal(outcome.report.canChangeGainDb, false);
    assert.deepEqual(new Uint8Array(await outcome.candidate.arrayBuffer()), enhancedBytes);
  }
  const ticketCall = calls.find((call) => call.url === "/api/extreme-ml/ticket");
  assert.ok(ticketCall);
  assert.deepEqual(JSON.parse(ticketCall.init.body as string), {
    sizeBytes: 3,
    contentType: "audio/wav",
    idempotencyKey: "enhance-1",
    scope: "enhancement_candidate",
    sha256: sourceSha256,
  });
  assert.ok(calls.some((call) => call.url.endsWith("/candidate")));
});

test("enhancement candidate hash mismatch fails open before returning candidate bytes", async () => {
  const candidateBytes = new Uint8Array([82, 73, 70, 70, 9, 8, 7]);
  const sourceBytes = new Uint8Array([7, 8, 9]);
  const sourceSha256 = sha256Hex(sourceBytes);
  let statusPolls = 0;
  const outcome = await enhanceSourceWithExtremeWorker({
    source: new Blob([sourceBytes], { type: "audio/wav" }),
    contentType: "audio/wav",
    idempotencyKey: "enhance-hash-mismatch",
    fetchImpl: async (input, init = {}) => {
      const url = String(input);
      if (url === "/api/extreme-ml/ticket") {
        return Response.json({
          workerBaseUrl: "https://worker.example",
          ticket: "ticket_opaque",
          expiresAt: "2026-08-24T01:00:00.000Z",
        });
      }
      if (url.endsWith("/v1/jobs")) {
        return Response.json({ jobId: "candidate_hash_job", accessToken: "candidate_hash_secret", uploadOffset: 0, maxChunkBytes: 16 });
      }
      if (url.endsWith("/input") && init.method === "PATCH") {
        return new Response(null, { status: 204, headers: { "Upload-Offset": String(sourceBytes.byteLength) } });
      }
      if (url.endsWith("/input/complete")) return Response.json({ state: "queued" });
      if (url.endsWith("/v1/jobs/candidate_hash_job")) {
        statusPolls += 1;
        return Response.json({ state: statusPolls < 2 ? "running" : "succeeded" });
      }
      if (url.endsWith("/report")) {
        return Response.json({
          ...(validReport(sourceSha256) as Record<string, unknown>),
          candidate: {
            role: "enhancement_candidate",
            sha256: "e".repeat(64),
            durationMs: 120,
            sampleRate: 48_000,
            channels: 1,
          },
          telemetry: {
            ...(validReport(sourceSha256) as { telemetry: Record<string, unknown> }).telemetry,
            candidateSelected: true,
          },
        });
      }
      if (url.endsWith("/candidate")) return new Response(candidateBytes, { headers: { "Content-Type": "audio/wav" } });
      throw new Error(`Unexpected request: ${url}`);
    },
    sleep: async () => undefined,
    allowedWorkerOrigins: ["https://worker.example"],
    maxPolls: 4,
  });

  assert.deepEqual(outcome, { status: "unavailable", reason: "candidate-unavailable" });
});

test("worker failures and exhausted polling fail open without throwing", async () => {
  const source = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
  const failedTicket = await analyzeSourceWithExtremeWorker({
    source,
    contentType: "audio/wav",
    idempotencyKey: "safe-fallback",
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
    sleep: async () => undefined,
  });
  assert.deepEqual(failedTicket, { status: "unavailable", reason: "ticket-unavailable" });

  let call = 0;
  const timedOut = await analyzeSourceWithExtremeWorker({
    source,
    contentType: "audio/wav",
    idempotencyKey: "safe-timeout",
    maxPolls: 1,
    sleep: async () => undefined,
    fetchImpl: async (input) => {
      call += 1;
      const url = String(input);
      if (call === 1) return Response.json({ workerBaseUrl: "https://worker.example", ticket: "ticket", expiresAt: "soon" });
      if (url.endsWith("/v1/jobs")) return Response.json({ jobId: "job", accessToken: "secret", uploadOffset: 0, maxChunkBytes: 16 });
      if (url.endsWith("/input")) return new Response(null, { status: 204, headers: { "Upload-Offset": "3" } });
      if (url.endsWith("/input/complete")) return Response.json({ state: "queued" });
      return Response.json({ state: "running", progress: 0.1 });
    },
    allowedWorkerOrigins: ["https://worker.example"],
  });
  assert.deepEqual(timedOut, { status: "unavailable", reason: "poll-timeout" });
});

test("poll timeout requests best-effort worker cancellation without changing fail-open delivery", async () => {
  const source = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const outcome = await analyzeSourceWithExtremeWorker({
    source,
    contentType: "audio/wav",
    idempotencyKey: "cancel-on-timeout",
    maxPolls: 1,
    sleep: async () => undefined,
    fetchImpl: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/extreme-ml/ticket") {
        return Response.json({ workerBaseUrl: "https://worker.example", ticket: "ticket", expiresAt: "soon" });
      }
      if (url.endsWith("/v1/jobs")) {
        return Response.json({ jobId: "job", accessToken: "secret", uploadOffset: 0, maxChunkBytes: 16 });
      }
      if (url.endsWith("/input")) {
        return new Response(null, { status: 204, headers: { "Upload-Offset": "3" } });
      }
      if (url.endsWith("/input/complete")) return Response.json({ state: "queued" });
      if (init.method === "DELETE") return Response.json({ state: "cancel_requested" }, { status: 202 });
      return Response.json({ state: "running" });
    },
    allowedWorkerOrigins: ["https://worker.example"],
  });

  assert.deepEqual(outcome, { status: "unavailable", reason: "poll-timeout" });
  const cancellation = calls.find((call) => call.init.method === "DELETE");
  assert.ok(cancellation);
  assert.match(cancellation.url, /\/v1\/jobs\/job$/);
  assert.equal(new Headers(cancellation.init.headers).get("Authorization"), "Bearer secret");
});
