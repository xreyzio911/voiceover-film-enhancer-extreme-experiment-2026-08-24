import assert from "node:assert/strict";
import test from "node:test";

import type { ExtremeSourceReport } from "./extremeMlClient.ts";
import { buildExtremeMlSourceQualityPolicy } from "./extremeMlSourceQualityPolicy.ts";

const SHA256 = "a".repeat(64);
const REVISION = "b".repeat(40);

const reportWithMetrics = (
  metrics: ExtremeSourceReport["metrics"],
  overrides: Partial<ExtremeSourceReport> = {},
): ExtremeSourceReport => ({
  schemaVersion: 1,
  advisoryOnly: true,
  canBlockDelivery: false,
  canChangeGainDb: false,
  levelAuthority: "gainPlanner",
  modelSetId: "extreme-advisory-test",
  source: {
    sha256: SHA256,
    durationMs: 1000,
    sampleRate: 48_000,
    channels: 1,
  },
  vad: { frameMs: 10, frames: [] },
  metrics,
  models: [{ id: "sigmos", version: "test", revision: REVISION, sha256: SHA256 }],
  telemetry: {
    runtimeStatus: "ready",
    reason: "ok",
    audioMutation: false,
    candidateSelected: false,
    gainDbChanged: false,
  },
  ...overrides,
});

test("poor neural source metrics produce bounded cleanup and stability hints", () => {
  const policy = buildExtremeMlSourceQualityPolicy(
    reportWithMetrics({
      "dnsmos.bak": { value: 2.35, available: true, higherIsBetter: true },
      "sigmos.noise": { value: 2.55, available: true, higherIsBetter: true },
      "sigmos.reverb": { value: 2.4, available: true, higherIsBetter: true },
      "sigmos.loud": { value: 2.6, available: true, higherIsBetter: true },
      "sigmos.disc": { value: 2.75, available: true, higherIsBetter: true },
    }),
  );

  assert.equal(policy.reason, "ml-source-quality");
  assert.equal(policy.advisoryOnly, true);
  assert.equal(policy.canBlockDelivery, false);
  assert.equal(policy.canChangeGainDb, false);
  assert.equal(policy.noiseRiskFloor, "high");
  assert.equal(policy.roomRiskFloor, "high");
  assert.ok(policy.pauseNoiseRiskFloor >= 0.56);
  assert.ok(policy.denoiseBias >= 0.18);
  assert.ok(policy.roomCleanupBias >= 0.18);
  assert.ok(policy.instabilityHintBoost >= 0.08);
  assert.ok(policy.plannerMaxGainPenaltyDb >= 0.5);
  assert.deepEqual(policy.usedMetricKeys, [
    "dnsmos.bak",
    "sigmos.disc",
    "sigmos.loud",
    "sigmos.noise",
    "sigmos.reverb",
  ]);
});

test("moderately poor perceptual noise and room evidence is promoted to a decisive cleanup hint", () => {
  const policy = buildExtremeMlSourceQualityPolicy(
    reportWithMetrics({
      "dnsmos.bak": { value: 3.0, available: true, higherIsBetter: true },
      "sigmos.noise": { value: 3.15, available: true, higherIsBetter: true },
      "sigmos.reverb": { value: 3.0, available: true, higherIsBetter: true },
      "sigmos.loud": { value: 3.25, available: true, higherIsBetter: true },
      "sigmos.disc": { value: 3.35, available: true, higherIsBetter: true },
    }),
  );

  assert.equal(policy.reason, "ml-source-quality");
  assert.equal(policy.noiseRiskFloor, "medium");
  assert.equal(policy.roomRiskFloor, "medium");
  assert.ok(policy.pauseNoiseRiskFloor >= 0.44);
  assert.ok(policy.denoiseBias >= 0.16);
  assert.ok(policy.roomCleanupBias >= 0.16);
  assert.ok(policy.plannerMaxGainPenaltyDb >= 0.55);
});

test("optional naturalness and overall MOS widen cleanup when artifact scores are incomplete", () => {
  const policy = buildExtremeMlSourceQualityPolicy(
    reportWithMetrics({
      "dnsmos.ovrl": { value: 2.7, available: true, higherIsBetter: true },
      "dnsmos.sig": { value: 3.55, available: true, higherIsBetter: true },
      "dnsmos_p808": { value: 2.85, available: true, higherIsBetter: true },
      "sigmos.ovrl": { value: 2.8, available: true, higherIsBetter: true },
      "sigmos.sig": { value: 3.6, available: true, higherIsBetter: true },
      "utmos": { value: 2.9, available: true, higherIsBetter: true },
    }),
  );

  assert.equal(policy.reason, "ml-source-quality");
  assert.equal(policy.noiseRiskFloor, "medium");
  assert.equal(policy.roomRiskFloor, null);
  assert.ok(policy.pauseNoiseRiskFloor >= 0.4);
  assert.ok(policy.denoiseBias >= 0.12);
  assert.ok(policy.plannerMaxGainPenaltyDb >= 0.35);
  assert.deepEqual(policy.usedMetricKeys, [
    "dnsmos.ovrl",
    "dnsmos.sig",
    "dnsmos_p808",
    "sigmos.ovrl",
    "sigmos.sig",
    "utmos",
  ]);
});

test("poor speech/signal MOS damps cleanup authority instead of authorizing overprocessing", () => {
  const report = {
    "dnsmos.bak": { value: 2.35, available: true, higherIsBetter: true },
    "dnsmos.sig": { value: 1.65, available: true, higherIsBetter: true },
    "sigmos.noise": { value: 2.4, available: true, higherIsBetter: true },
    "sigmos.sig": { value: 1.7, available: true, higherIsBetter: true },
    "sigmos.reverb": { value: 2.3, available: true, higherIsBetter: true },
  } satisfies ExtremeSourceReport["metrics"];
  const damagedSpeech = buildExtremeMlSourceQualityPolicy(reportWithMetrics(report));
  const intactSpeech = buildExtremeMlSourceQualityPolicy(
    reportWithMetrics({
      ...report,
      "dnsmos.sig": { value: 3.65, available: true, higherIsBetter: true },
      "sigmos.sig": { value: 3.7, available: true, higherIsBetter: true },
    }),
  );

  assert.equal(damagedSpeech.reason, "ml-source-quality");
  assert.equal(intactSpeech.reason, "ml-source-quality");
  assert.ok(damagedSpeech.denoiseBias < intactSpeech.denoiseBias);
  assert.ok(damagedSpeech.roomCleanupBias < intactSpeech.roomCleanupBias);
  assert.ok(damagedSpeech.instabilityHintBoost < intactSpeech.instabilityHintBoost);
  assert.ok(damagedSpeech.plannerMaxGainPenaltyDb >= intactSpeech.plannerMaxGainPenaltyDb);
});

test("good, unavailable, or unsafe source reports are ignored", () => {
  const good = buildExtremeMlSourceQualityPolicy(
    reportWithMetrics({
      "dnsmos.bak": { value: 4.25, available: true, higherIsBetter: true },
      "sigmos.noise": { value: 4.3, available: true, higherIsBetter: true },
      "sigmos.reverb": { value: 4.2, available: true, higherIsBetter: true },
      "sigmos.loud": { value: 4.15, available: true, higherIsBetter: true },
      "sigmos.disc": { value: 4.35, available: true, higherIsBetter: true },
    }),
  );
  const missing = buildExtremeMlSourceQualityPolicy(
    reportWithMetrics({
      "sigmos.noise": { value: null, available: false, higherIsBetter: true },
    }),
  );
  const unsafe = buildExtremeMlSourceQualityPolicy(
    reportWithMetrics(
      {
        "sigmos.noise": { value: 1.5, available: true, higherIsBetter: true },
      },
      { canChangeGainDb: true as false },
    ),
  );

  for (const policy of [good, missing, unsafe]) {
    assert.equal(policy.reason, "legacy-fallback");
    assert.equal(policy.noiseRiskFloor, null);
    assert.equal(policy.roomRiskFloor, null);
    assert.equal(policy.denoiseBias, 0);
    assert.equal(policy.roomCleanupBias, 0);
    assert.equal(policy.plannerMaxGainPenaltyDb, 0);
    assert.deepEqual(policy.usedMetricKeys, []);
  }
});

test("policy clamps hostile metric magnitudes and never exposes worker authority", () => {
  const policy = buildExtremeMlSourceQualityPolicy(
    reportWithMetrics({
      "dnsmos.bak": { value: -999 as number, available: true, higherIsBetter: true },
      "sigmos.noise": { value: 999 as number, available: true, higherIsBetter: true },
      "sigmos.reverb": { value: 1.0, available: true, higherIsBetter: true },
      "sigmos.loud": { value: 0.5, available: true, higherIsBetter: true },
      "sigmos.disc": { value: 0.25, available: true, higherIsBetter: true },
    }),
  );

  assert.equal(policy.reason, "ml-source-quality");
  assert.equal(policy.canBlockDelivery, false);
  assert.equal(policy.canChangeGainDb, false);
  assert.equal(policy.plannerMaxGainPenaltyDb <= 1.5, true);
  assert.equal(policy.denoiseBias <= 0.4, true);
  assert.equal(policy.roomCleanupBias <= 0.42, true);
});
