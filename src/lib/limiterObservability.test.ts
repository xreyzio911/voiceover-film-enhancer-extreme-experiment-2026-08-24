import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLimiterObservabilityStage,
  formatLimiterObservabilityStage,
} from "./limiterObservability.ts";

test("limiter observability reports ceiling pressure without claiming gain reduction", () => {
  const stage = buildLimiterObservabilityStage({
    stageId: "final-polish",
    limiterKind: "alimiter",
    ceilingDb: -2,
    inputTruePeakDb: -5,
    outputTruePeakDb: -2.1,
    plannedStaticGainDb: 4,
    notes: ["Advisory measurement only."],
  });

  assert.equal(stage.advisoryOnly, true);
  assert.equal(stage.measurementStatus, "measured");
  assert.equal(stage.predictedPreLimiterPeakDb, -1);
  assert.equal(stage.estimatedCeilingDriveDb, 1);
  assert.ok(Math.abs((stage.outputCeilingMarginDb ?? 0) - 0.1) < 1e-9);
  const serialized = JSON.stringify(stage);
  assert.doesNotMatch(serialized, /gainReduction|verdict|accepted|rejected|hardGate/);
});

test("limiter observability keeps drive unknown without a known static gain", () => {
  const stage = buildLimiterObservabilityStage({
    stageId: "primary-mix-composite",
    limiterKind: "composite",
    ceilingDb: -2,
    inputTruePeakDb: -8,
    outputTruePeakDb: -2.4,
    plannedStaticGainDb: null,
  });

  assert.equal(stage.predictedPreLimiterPeakDb, null);
  assert.equal(stage.estimatedCeilingDriveDb, null);
  assert.ok(Math.abs((stage.outputCeilingMarginDb ?? 0) - 0.4) < 1e-9);
});

test("limiter observability fails open when peak evidence is unavailable", () => {
  const stage = buildLimiterObservabilityStage({
    stageId: "batch-align",
    limiterKind: "alimiter",
    ceilingDb: -2,
    inputTruePeakDb: null,
    outputTruePeakDb: null,
    plannedStaticGainDb: 1.5,
  });

  assert.equal(stage.measurementStatus, "unavailable");
  assert.equal(stage.predictedPreLimiterPeakDb, null);
  assert.equal(stage.outputCeilingMarginDb, null);
  assert.match(formatLimiterObservabilityStage(stage), /unavailable; advisory only/);
});
