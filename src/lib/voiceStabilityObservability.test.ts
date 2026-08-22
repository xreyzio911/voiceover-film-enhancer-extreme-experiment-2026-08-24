import assert from "node:assert/strict";
import test from "node:test";
import {
  VOICE_STABILITY_RUNTIME_FRAME_MS,
  VOICE_STABILITY_RUNTIME_MAX_DURATION_SECONDS,
  VOICE_STABILITY_RUNTIME_MAX_SAMPLE_RATE,
  VOICE_STABILITY_RUNTIME_MAX_SAMPLE_COUNT,
  buildVoiceStabilityObservabilitySnapshot,
  createVoiceStabilityObservabilitySourceSession,
  resolveVoiceStabilityRuntimeBoundsIssue,
  sanitizeVoiceStabilitySamples,
} from "./voiceStabilityObservability.ts";

const buildVoicedSamples = (
  sampleRate: number,
  durationSec: number,
  gain = 1,
) => {
  const samples = new Float32Array(Math.round(sampleRate * durationSec));
  for (let index = 0; index < samples.length; index += 1) {
    const timeSec = index / sampleRate;
    const phraseScale = timeSec < 0.3 || timeSec > durationSec - 0.3 ? 0.08 : 0.16;
    samples[index] =
      Math.sin((2 * Math.PI * 220 * index) / sampleRate) * phraseScale * gain;
  }
  return samples;
};

test("runtime stability observability measures a static-gain pair without creating a decision gate", () => {
  const sampleRate = 16_000;
  const sourceSamples = buildVoicedSamples(sampleRate, 4);
  const candidateSamples = Float32Array.from(sourceSamples, (sample) => sample * 2);

  const snapshot = buildVoiceStabilityObservabilitySnapshot({
    source: { samples: sourceSamples, sampleRate },
    candidate: { samples: candidateSamples, sampleRate },
    frameMs: 10,
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.advisoryOnly, true);
  assert.equal(snapshot.measurementStatus, "measured");
  assert.ok(snapshot.report);
  assert.ok(snapshot.report.alignedFrameCount >= 390);
  assert.equal(snapshot.report.spikes.up.countAboveAdvisoryContrast, 0);
  assert.equal(snapshot.report.spikes.down.countAboveAdvisoryContrast, 0);

  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /"(?:verdict|gate|accepted|rejected|cancelled|shouldApply)"/i);
  assert.doesNotMatch(serialized, /"(?:frameDb|framePeakDb|speechBodyDb)"/);
});

test("runtime stability observability defaults to the corpus ledger's 20 ms frame resolution", () => {
  const sampleRate = 16_000;
  const sourceSamples = buildVoicedSamples(sampleRate, 2);
  const candidateSamples = Float32Array.from(sourceSamples, (sample) => sample * 1.1);
  const snapshot = buildVoiceStabilityObservabilitySnapshot({
    source: { samples: sourceSamples, sampleRate },
    candidate: { samples: candidateSamples, sampleRate },
  });

  assert.equal(VOICE_STABILITY_RUNTIME_FRAME_MS, 20);
  assert.equal(snapshot.measurementStatus, "measured");
  assert.equal(snapshot.report?.frameMs, VOICE_STABILITY_RUNTIME_FRAME_MS);
});

test("a per-job source session reuses prepared source evidence across candidates", () => {
  const sampleRate = 16_000;
  const sourceSamples = buildVoicedSamples(sampleRate, 3);
  const firstCandidate = Float32Array.from(sourceSamples, (sample) => sample * 1.1);
  const secondCandidate = Float32Array.from(sourceSamples, (sample) => sample * 0.9);
  const session = createVoiceStabilityObservabilitySourceSession({
    source: { samples: sourceSamples, sampleRate },
  });

  const first = session.compare({ samples: firstCandidate, sampleRate });
  const second = session.compare({ samples: secondCandidate, sampleRate });

  assert.equal(first.measurementStatus, "measured");
  assert.equal(second.measurementStatus, "measured");
  assert.ok(first.report);
  assert.ok(second.report);
  assert.deepEqual(
    first,
    buildVoiceStabilityObservabilitySnapshot({
      source: { samples: sourceSamples, sampleRate },
      candidate: { samples: firstCandidate, sampleRate },
    }),
  );
});

test("runtime stability observability labels native sample-rate mismatch", () => {
  const sourceRate = 16_000;
  const candidateRate = 48_000;
  const snapshot = buildVoiceStabilityObservabilitySnapshot({
    source: {
      samples: buildVoicedSamples(sourceRate, 2),
      sampleRate: sourceRate,
    },
    candidate: {
      samples: buildVoicedSamples(candidateRate, 2),
      sampleRate: candidateRate,
    },
  });

  assert.equal(snapshot.measurementStatus, "measured");
  assert.match(
    snapshot.notes.join(" "),
    /native sample rates.*16000.*48000.*body-balance/i,
  );
});

test("runtime stability observability explicitly labels non-ledger frame overrides", () => {
  const sampleRate = 16_000;
  const samples = buildVoicedSamples(sampleRate, 2);
  const snapshot = buildVoiceStabilityObservabilitySnapshot({
    source: { samples, sampleRate },
    candidate: { samples: new Float32Array(samples), sampleRate },
    frameMs: 10,
  });

  assert.equal(snapshot.measurementStatus, "measured");
  assert.equal(snapshot.report?.frameMs, 10);
  assert.match(snapshot.notes.join(" "), /10 ms.*20 ms.*not directly comparable/i);
});

test("sample sanitization reuses finite input and copies only when replacement is required", () => {
  const finite = new Float32Array([0.25, -0.5, 0]);
  const finiteResult = sanitizeVoiceStabilitySamples(finite);
  assert.strictEqual(finiteResult.samples, finite);
  assert.equal(finiteResult.sanitized, false);

  const nonFinite = new Float32Array([0.25, Number.NaN, -0.5, Number.POSITIVE_INFINITY]);
  const nonFiniteResult = sanitizeVoiceStabilitySamples(nonFinite);
  assert.notStrictEqual(nonFiniteResult.samples, nonFinite);
  assert.deepEqual(Array.from(nonFiniteResult.samples), [0.25, 0, -0.5, 0]);
  assert.equal(Number.isNaN(nonFinite[1]), true, "the advisory pass must not mutate decoded audio");
  assert.equal(nonFinite[3], Number.POSITIVE_INFINITY);
  assert.equal(nonFiniteResult.sanitized, true);
});

test("runtime stability observability bounds duration and sample work before envelope allocation", () => {
  assert.equal(
    VOICE_STABILITY_RUNTIME_MAX_SAMPLE_COUNT,
    (96 * 1024 * 1024) / Float32Array.BYTES_PER_ELEMENT,
    "the analysis ceiling must retain its 96 MiB mono-sample budget",
  );
  assert.equal(
    VOICE_STABILITY_RUNTIME_MAX_DURATION_SECONDS,
    VOICE_STABILITY_RUNTIME_MAX_SAMPLE_COUNT / VOICE_STABILITY_RUNTIME_MAX_SAMPLE_RATE,
    "the duration route must switch at the same 48 kHz boundary as the sample ceiling",
  );
  assert.ok(VOICE_STABILITY_RUNTIME_MAX_DURATION_SECONDS < 600);
  assert.equal(
    resolveVoiceStabilityRuntimeBoundsIssue(
      Math.floor(VOICE_STABILITY_RUNTIME_MAX_DURATION_SECONDS) + 1,
      1,
    ),
    "duration-limit",
  );
  assert.equal(
    resolveVoiceStabilityRuntimeBoundsIssue(
      VOICE_STABILITY_RUNTIME_MAX_SAMPLE_COUNT + 1,
      48_000,
    ),
    "sample-limit",
  );

  const overDurationSamples = new Float32Array(
    Math.floor(VOICE_STABILITY_RUNTIME_MAX_DURATION_SECONDS) + 1,
  );
  const valid = {
    samples: buildVoicedSamples(16_000, 2),
    sampleRate: 16_000,
  };
  const snapshot = buildVoiceStabilityObservabilitySnapshot({
    source: { samples: overDurationSamples, sampleRate: 1 },
    candidate: valid,
  });

  assert.equal(snapshot.advisoryOnly, true);
  assert.equal(snapshot.measurementStatus, "unavailable");
  assert.equal(snapshot.report, null);
  assert.match(snapshot.notes.join(" "), /duration ceiling/i);
});

test("runtime stability observability accepts the same duration boundary as bounded candidate QC", () => {
  assert.equal(
    resolveVoiceStabilityRuntimeBoundsIssue(
      VOICE_STABILITY_RUNTIME_MAX_SAMPLE_COUNT,
      VOICE_STABILITY_RUNTIME_MAX_SAMPLE_RATE,
    ),
    null,
  );
  assert.equal(
    resolveVoiceStabilityRuntimeBoundsIssue(
      VOICE_STABILITY_RUNTIME_MAX_SAMPLE_COUNT + 1,
      VOICE_STABILITY_RUNTIME_MAX_SAMPLE_RATE,
    ),
    "sample-limit",
  );
});

test("runtime stability observability fails open when exact paired audio is unavailable", () => {
  const valid = {
    samples: buildVoicedSamples(16_000, 2),
    sampleRate: 16_000,
  };

  const missingSource = buildVoiceStabilityObservabilitySnapshot({
    source: null,
    candidate: valid,
  });
  const invalidRate = buildVoiceStabilityObservabilitySnapshot({
    source: valid,
    candidate: { samples: valid.samples, sampleRate: 0 },
  });

  for (const snapshot of [missingSource, invalidRate]) {
    assert.equal(snapshot.advisoryOnly, true);
    assert.equal(snapshot.measurementStatus, "unavailable");
    assert.equal(snapshot.report, null);
    assert.ok(snapshot.notes.length > 0);
  }
});

test("runtime stability observability keeps its report compact for long sample arrays", () => {
  const sampleRate = 8_000;
  const sourceSamples = buildVoicedSamples(sampleRate, 65);
  const candidateSamples = Float32Array.from(sourceSamples, (sample) => sample * 1.1);
  const snapshot = buildVoiceStabilityObservabilitySnapshot({
    source: { samples: sourceSamples, sampleRate },
    candidate: { samples: candidateSamples, sampleRate },
    frameMs: 10,
  });

  assert.equal(snapshot.measurementStatus, "measured");
  assert.ok(snapshot.report);
  assert.ok(snapshot.report.drift.sections.length <= 7);
  assert.ok(snapshot.report.spikes.up.topEvents.length <= 5);
  assert.ok(snapshot.report.bodySpikes.down.topEvents.length <= 5);
  assert.ok(JSON.stringify(snapshot).length < 20_000);
});
