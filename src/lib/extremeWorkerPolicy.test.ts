import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExtremeWorkerCorsHeaders,
  sanitizeExtremeWorkerFileName,
  validateExtremeWorkerUpload,
} from "./extremeWorkerPolicy.ts";

test("Extreme worker upload validation rejects unsafe names and unsupported audio early", () => {
  const unsafe = validateExtremeWorkerUpload({
    files: [
      {
        originalName: "../secret.wav",
        sizeBytes: 1024,
        mimeType: "audio/wav",
      },
    ],
  });
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.error, /Unsafe file name/);

  const unsupported = validateExtremeWorkerUpload({
    files: [
      {
        originalName: "voice.mp3",
        sizeBytes: 1024,
        mimeType: "audio/mpeg",
      },
    ],
  });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error, /WAV/);
});

test("Extreme worker upload validation bounds count, file bytes, and batch bytes", () => {
  assert.equal(
    validateExtremeWorkerUpload({
      files: [],
    }).ok,
    false,
  );

  assert.equal(
    validateExtremeWorkerUpload({
      files: Array.from({ length: 17 }, (_, index) => ({
        originalName: `voice-${index}.wav`,
        sizeBytes: 1024,
        mimeType: "audio/wav",
      })),
    }).ok,
    false,
  );

  assert.equal(
    validateExtremeWorkerUpload({
      files: [
        {
          originalName: "large.wav",
          sizeBytes: 1024 * 1024 * 1024 + 1,
          mimeType: "audio/wav",
        },
      ],
    }).ok,
    false,
  );
});

test("Extreme worker file-name sanitizer blocks traversal and Windows reserved names", () => {
  assert.equal(sanitizeExtremeWorkerFileName("CON.wav", 0), "CON_file.wav");
  assert.equal(sanitizeExtremeWorkerFileName("safe voice.wav", 0), "safe voice.wav");
  assert.throws(() => sanitizeExtremeWorkerFileName("..\\voice.wav", 0), /Unsafe file name/);
  assert.throws(() => sanitizeExtremeWorkerFileName("/tmp/voice.wav", 0), /Unsafe file name/);
});

test("Extreme worker CORS is explicit and never wildcard-with-credentials", () => {
  const denied = buildExtremeWorkerCorsHeaders({
    requestOrigin: "https://attacker.example",
    allowedOrigins: ["https://extreme.example"],
  });
  assert.equal(denied["Access-Control-Allow-Origin"], undefined);
  assert.equal(denied["Access-Control-Allow-Credentials"], undefined);

  const allowed = buildExtremeWorkerCorsHeaders({
    requestOrigin: "https://extreme.example",
    allowedOrigins: ["https://extreme.example"],
  });
  assert.equal(allowed["Access-Control-Allow-Origin"], "https://extreme.example");
  assert.equal(allowed["Access-Control-Allow-Credentials"], "true");
});
