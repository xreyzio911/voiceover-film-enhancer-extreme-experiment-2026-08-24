import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedJson } from "./boundedRequestJson.ts";

const requestWithStream = (
  chunks: readonly Uint8Array[],
  headers: Readonly<Record<string, string>> = {},
) => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request("http://localhost/api/extreme-ml/ticket", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
};

test("readBoundedJson parses a valid streamed JSON payload within the byte cap", async () => {
  const encoder = new TextEncoder();
  const result = await readBoundedJson(
    requestWithStream([
      encoder.encode('{"sizeBytes":123,'),
      encoder.encode('"scope":"source_analysis"}'),
    ]),
    128,
  );

  assert.deepEqual(result, {
    ok: true,
    value: { sizeBytes: 123, scope: "source_analysis" },
  });
});

test("readBoundedJson rejects actual streamed bytes above the cap without Content-Length", async () => {
  const encoder = new TextEncoder();
  const result = await readBoundedJson(
    requestWithStream([
      encoder.encode('{"padding":"'),
      encoder.encode("x".repeat(64)),
      encoder.encode('"}'),
    ]),
    32,
  );

  assert.deepEqual(result, { ok: false, error: "too_large" });
});

test("readBoundedJson enforces actual bytes when Content-Length understates the body", async () => {
  const encoder = new TextEncoder();
  const result = await readBoundedJson(
    requestWithStream(
      [encoder.encode(`{"padding":"${"x".repeat(64)}"}`)],
      { "content-length": "2" },
    ),
    32,
  );

  assert.deepEqual(result, { ok: false, error: "too_large" });
});

test("readBoundedJson rejects an oversized declared Content-Length before parsing", async () => {
  const result = await readBoundedJson(
    new Request("http://localhost/api/extreme-ml/ticket", {
      method: "POST",
      headers: { "content-length": "4096", "content-type": "application/json" },
      body: "{}",
    }),
    128,
  );

  assert.deepEqual(result, { ok: false, error: "too_large" });
});

test("readBoundedJson rejects malformed JSON and an absent body", async () => {
  const malformed = await readBoundedJson(
    new Request("http://localhost/api/extreme-ml/ticket", {
      method: "POST",
      body: "{not-json",
    }),
    128,
  );
  const absent = await readBoundedJson(
    new Request("http://localhost/api/extreme-ml/ticket", { method: "POST" }),
    128,
  );

  assert.deepEqual(malformed, { ok: false, error: "invalid_json" });
  assert.deepEqual(absent, { ok: false, error: "invalid_json" });
});
