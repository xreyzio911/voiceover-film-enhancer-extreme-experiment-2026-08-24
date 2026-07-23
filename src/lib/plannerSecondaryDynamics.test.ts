import assert from "node:assert/strict";
import test from "node:test";
import { resolvePlannerSecondaryMaxGainFactor } from "./plannerSecondaryDynamics.ts";

const gainDb = (factor: number) => 20 * Math.log10(factor);

test("ultra-sparse one-run planner output receives only a subtle continuous secondary lift", () => {
  const factor = resolvePlannerSecondaryMaxGainFactor({
    baseMaxGainFactor: 5,
    speechDutyCyclePct: 0.4,
    speechSegmentCount: 1,
  });

  assert.ok(factor > 1, "sparse evidence should taper the stabilizer instead of hard-disabling it");
  assert.ok(gainDb(factor) <= 2, `expected no more than 2 dB of lift, got ${gainDb(factor).toFixed(2)} dB`);
});

test("dense or well-sampled speech preserves the existing secondary dynamics range", () => {
  assert.equal(
    resolvePlannerSecondaryMaxGainFactor({
      baseMaxGainFactor: 5,
      speechDutyCyclePct: 36,
      speechSegmentCount: 24,
    }),
    5,
  );
  assert.equal(
    resolvePlannerSecondaryMaxGainFactor({
      baseMaxGainFactor: 5,
      speechDutyCyclePct: 85,
      speechSegmentCount: 1,
    }),
    5,
    "a short dense sentence must not be treated as sparse merely because it is one run",
  );
  assert.equal(
    resolvePlannerSecondaryMaxGainFactor({
      baseMaxGainFactor: 5,
      speechDutyCyclePct: 1.5,
      speechSegmentCount: 12,
    }),
    5,
    "many measured runs remain well sampled even when a long file has low duty cycle",
  );
  const scaledDenseFactor = resolvePlannerSecondaryMaxGainFactor({
    baseMaxGainFactor: 7,
    speechDutyCyclePct: 36,
    speechSegmentCount: 24,
  });
  assert.ok(
    Math.abs(scaledDenseFactor - 7) < 1e-12,
    "well-sampled speech must retain the caller's existing adaptive ceiling",
  );
});

test("secondary lift changes continuously and fails open when density evidence is unavailable", () => {
  assert.equal(
    resolvePlannerSecondaryMaxGainFactor({
      baseMaxGainFactor: 5,
      speechDutyCyclePct: null,
      speechSegmentCount: null,
    }),
    5,
  );

  const below = resolvePlannerSecondaryMaxGainFactor({
    baseMaxGainFactor: 5,
    speechDutyCyclePct: 4.9,
    speechSegmentCount: 2,
  });
  const above = resolvePlannerSecondaryMaxGainFactor({
    baseMaxGainFactor: 5,
    speechDutyCyclePct: 5.1,
    speechSegmentCount: 2,
  });

  assert.ok(above >= below);
  assert.ok(
    gainDb(above / below) < 0.2,
    "nearby speech densities must not cross a hard processing cliff",
  );
});

test("either available evidence signal contributes smoothly and invalid values stay bounded", () => {
  const dutyOnly = resolvePlannerSecondaryMaxGainFactor({
    baseMaxGainFactor: 5,
    speechDutyCyclePct: 15,
    speechSegmentCount: null,
  });
  const runsOnly = resolvePlannerSecondaryMaxGainFactor({
    baseMaxGainFactor: 5,
    speechDutyCyclePct: null,
    speechSegmentCount: 6,
  });

  assert.ok(dutyOnly > 1 && dutyOnly < 5);
  assert.ok(runsOnly > 1 && runsOnly < 5);
  assert.equal(
    resolvePlannerSecondaryMaxGainFactor({
      baseMaxGainFactor: Number.NaN,
      speechDutyCyclePct: Number.NaN,
      speechSegmentCount: Number.NaN,
    }),
    1,
  );
});
