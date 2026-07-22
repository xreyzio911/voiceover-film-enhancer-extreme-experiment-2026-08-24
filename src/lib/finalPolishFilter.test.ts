import assert from "node:assert/strict";
import test from "node:test";
import {
  FINAL_POLISH_LIMITER_FILTER,
  buildFinalPolishFilter,
  type FinalPolishProfile,
} from "./finalPolishFilter.ts";

const activeProfile: FinalPolishProfile = {
  lowMidGainDb: -1.2,
  presenceGainDb: 0.4,
  airGainDb: 0.2,
  emotionalHarshnessCutDb: 0.3,
  topEndHarshnessCutDb: 0.5,
  toneMatchDeltaDb: [0.8, -0.7, 0.1, 0, -0.6, 0.5, 0, -0.9],
  cinematicColorEnabled: true,
  emotionProtection: 0.2,
};

const assertLinearDeliveryChain = (filter: string) => {
  const stages = filter.split(",");
  assert.equal(
    stages.filter((stage) => stage === FINAL_POLISH_LIMITER_FILTER).length,
    1,
    "the delivery limiter must appear exactly once",
  );
  assert.equal(stages.at(-1), FINAL_POLISH_LIMITER_FILTER, "the delivery limiter must remain last");
  assert.ok(
    stages.every((stage) => stage.startsWith("equalizer=") || stage === FINAL_POLISH_LIMITER_FILTER),
    `final polish must stay static-EQ-only before the limiter: ${filter}`,
  );

  for (const prohibited of [
    "highpass",
    "dynaudnorm",
    "acompressor",
    "compand",
    "agate",
    "afftdn",
    "anlmdn",
    "adeclick",
    "deesser",
    "transient",
  ]) {
    assert.doesNotMatch(filter, new RegExp(prohibited, "i"));
  }
};

test("null and source-safe final polish are limiter-only", () => {
  assert.equal(
    buildFinalPolishFilter(null, {
      eqCleanupEnabled: true,
      softenHarshnessEnabled: true,
      sourceSafe: false,
    }),
    FINAL_POLISH_LIMITER_FILTER,
  );
  assert.equal(
    buildFinalPolishFilter(activeProfile, {
      eqCleanupEnabled: true,
      softenHarshnessEnabled: true,
      sourceSafe: true,
    }),
    FINAL_POLISH_LIMITER_FILTER,
  );
});

test("final polish emits bounded static tone EQ and one delivery limiter", () => {
  const filter = buildFinalPolishFilter(activeProfile, {
    eqCleanupEnabled: true,
    softenHarshnessEnabled: true,
    sourceSafe: false,
  });

  assertLinearDeliveryChain(filter);
  assert.match(filter, /equalizer=f=250:width_type=q:width=1\.0:g=-1\.20/);
  assert.match(filter, /equalizer=f=3500:width_type=q:width=1\.15:g=-1\.90/);
  assert.match(filter, /equalizer=f=8000:width_type=q:width=0\.75:g=-1\.40/);
  assert.match(filter, /equalizer=f=11200:width_type=q:width=0\.7:g=-0\.63/);

  // Only the three largest eligible tone deltas are retained.
  assert.match(filter, /equalizer=f=8000:width_type=q:width=0\.9:g=-0\.90/);
  assert.match(filter, /equalizer=f=60:width_type=q:width=0\.9:g=0\.80/);
  assert.match(filter, /equalizer=f=120:width_type=q:width=0\.9:g=-0\.70/);
  assert.doesNotMatch(filter, /equalizer=f=1000:width_type=q:width=1\.1:g=-0\.60/);

  assert.match(filter, /equalizer=f=180:width_type=q:width=1\.1:g=0\.8/);
  assert.match(filter, /equalizer=f=4500:width_type=q:width=1\.2:g=0\.6/);
  assert.match(filter, /equalizer=f=10000:width_type=q:width=0\.7:g=-0\.5/);
});

test("final polish respects optional cleanup and emotion-preserving color policy", () => {
  const filter = buildFinalPolishFilter(
    {
      ...activeProfile,
      presenceGainDb: 9,
      airGainDb: -9,
      emotionalHarshnessCutDb: 0,
      topEndHarshnessCutDb: 0,
      toneMatchDeltaDb: [9, -9, 0, 0, 0, 0, 0, 0],
      emotionProtection: 0.5,
    },
    {
      eqCleanupEnabled: false,
      softenHarshnessEnabled: false,
      sourceSafe: false,
    },
  );

  assertLinearDeliveryChain(filter);
  assert.doesNotMatch(filter, /equalizer=f=250:/);
  assert.match(filter, /equalizer=f=3500:width_type=q:width=1\.15:g=0\.70/);
  assert.match(filter, /equalizer=f=8000:width_type=q:width=0\.75:g=-2\.70/);
  assert.match(filter, /equalizer=f=60:width_type=q:width=0\.9:g=3\.00/);
  assert.match(filter, /equalizer=f=120:width_type=q:width=0\.9:g=-3\.00/);
  assert.doesNotMatch(filter, /equalizer=f=180:/);
  assert.doesNotMatch(filter, /equalizer=f=4500:/);
  assert.doesNotMatch(filter, /equalizer=f=10000:/);
});
