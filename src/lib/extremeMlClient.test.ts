import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeSourceWithExtremeWorker,
  normalizeExtremeSourceReport,
  normalizeExtremeWorkerBaseUrl,
  type ExtremeSourceReport,
} from "./extremeMlClient.ts";

const validReport = (): unknown => ({
  schemaVersion: 1,
  advisoryOnly: true,
  canBlockDelivery: false,
  canChangeGainDb: false,
  levelAuthority: "gainPlanner",
  modelSetId: "extreme-core-2026-08-24",
  source: {
    sha256: "a".repeat(64),
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
});

test("worker URL accepts HTTPS and local development only", () => {
  assert.equal(
    normalizeExtremeWorkerBaseUrl("https://extreme-worker.onrender.com/"),
    "https://extreme-worker.onrender.com",
  );
  assert.equal(normalizeExtremeWorkerBaseUrl("http://localhost:8787"), "http://localhost:8787");
  assert.equal(normalizeExtremeWorkerBaseUrl("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
  for (const value of [
    "http://extreme-worker.onrender.com",
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com?redirect=evil",
    "javascript:alert(1)",
    "",
  ]) {
    assert.equal(normalizeExtremeWorkerBaseUrl(value), null, value);
  }
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
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.vad.frames), true);
});

test("source analysis sends only metadata through Vercel and WAV bytes directly to Render", async () => {
  const sourceBytes = Uint8Array.from({ length: 10 }, (_, index) => index + 1);
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
    if (url.endsWith("/report")) return Response.json(validReport());
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
  });

  const uploadCalls = calls.filter((call) => call.url.endsWith("/input") && call.init.method === "PATCH");
  assert.deepEqual(uploadCalls.map((call) => Number(new Headers(call.init.headers).get("Upload-Offset"))), [0, 4, 8]);
  assert.deepEqual(uploadCalls.map((call) => (call.init.body as Blob).size), [4, 4, 2]);
  assert.equal(uploadCalls.every((call) => call.url.startsWith("https://extreme-worker.onrender.com/")), true);
  assert.equal(uploadCalls.every((call) => new Headers(call.init.headers).get("Authorization") === "Bearer job_secret"), true);
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
  });
  assert.deepEqual(timedOut, { status: "unavailable", reason: "poll-timeout" });
});
