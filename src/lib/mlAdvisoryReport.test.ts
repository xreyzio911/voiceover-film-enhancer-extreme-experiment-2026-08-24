import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExtremeMlAdvisoryReport,
  normalizeExtremeMlAdvisoryReport,
} from "./mlAdvisoryReport.ts";

test("Extreme ML report is advisory-only and cannot encode a delivery gate", () => {
  const report = buildExtremeMlAdvisoryReport({
    jobId: "job_123",
    sourceSha256: "a".repeat(64),
    resultSha256: "b".repeat(64),
    models: [
      {
        id: "silero-vad-protection",
        version: "6.2.1",
        sha256: "c".repeat(64),
      },
    ],
    metrics: {
      vadSpeechRatio: 0.42,
      dnsmosOvrl: 3.7,
      speakerSimilarity: 0.91,
    },
    findings: [
      {
        code: "quiet-tail-protected",
        severity: "info",
        message: "bounded VAD evidence protected an adjacent quiet tail",
      },
    ],
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.advisoryOnly, true);
  assert.equal(report.deliveryGate, "never");
  assert.equal(report.rawAudioLogged, false);
  assert.equal(report.transcriptLogged, false);
  assert.equal(report.findings[0].severity, "info");
});

test("Extreme ML report normalizer clamps untrusted worker output to advisory fields", () => {
  const report = normalizeExtremeMlAdvisoryReport({
    schemaVersion: 1,
    advisoryOnly: false,
    deliveryGate: "block-download",
    rawAudioLogged: true,
    transcriptLogged: true,
    jobId: "job_unsafe",
    sourceSha256: "x",
    resultSha256: "y",
    models: [{ id: "bad", version: 17, sha256: "bad" }],
    metrics: { vadSpeechRatio: 99, speakerSimilarity: -2, dnsmosOvrl: Number.NaN },
    findings: [{ code: "", severity: "critical", message: "" }],
  });

  assert.equal(report.advisoryOnly, true);
  assert.equal(report.deliveryGate, "never");
  assert.equal(report.rawAudioLogged, false);
  assert.equal(report.transcriptLogged, false);
  assert.deepEqual(report.models, []);
  assert.equal(report.metrics.vadSpeechRatio, 1);
  assert.equal(report.metrics.speakerSimilarity, 0);
  assert.equal(report.metrics.dnsmosOvrl, null);
  assert.deepEqual(report.findings, []);
});
