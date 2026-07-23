import assert from "node:assert/strict";
import test from "node:test";
import {
  FINAL_POLISH_LIMITER_FILTER,
  buildFinalPolishFilter,
} from "./finalPolishFilter.ts";

const activeTone = {
  fourKhzExcessDb: 2.4,
  eightKhzExcessDb: 3.2,
  topOctaveExcessDb: 3.7,
  fourKhzTrimDb: -0.62,
  eightKhzTrimDb: -0.78,
  topOctaveTrimDb: -1.74,
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
    stages.every(
      (stage) =>
        stage.startsWith("equalizer=") ||
        stage.startsWith("highshelf=") ||
        stage.startsWith("volume=") ||
        stage === FINAL_POLISH_LIMITER_FILTER,
    ),
    `final polish must stay static-EQ/static-gain-only before the limiter: ${filter}`,
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
      sourceSafe: false,
      makeupGainDb: 0,
    }),
    FINAL_POLISH_LIMITER_FILTER,
  );
  assert.equal(
    buildFinalPolishFilter(activeTone, {
      sourceSafe: true,
      makeupGainDb: 9,
    }),
    FINAL_POLISH_LIMITER_FILTER,
  );
});

test("final polish emits only measured source-relative trims, static makeup, and one limiter", () => {
  const filter = buildFinalPolishFilter(activeTone, {
    sourceSafe: false,
    makeupGainDb: 7.45,
  });

  assertLinearDeliveryChain(filter);
  assert.match(filter, /equalizer=f=4000:width_type=q:width=1\.0:g=-0\.62/);
  assert.match(filter, /equalizer=f=8000:width_type=q:width=0\.9:g=-0\.78/);
  assert.match(filter, /highshelf=f=8000:width_type=q:width=0\.7:g=-1\.74/);
  assert.match(filter, /volume=7\.450dB/);
});

test("final polish cannot replay the primary tone profile or add dynamics", () => {
  const filter = buildFinalPolishFilter(activeTone, {
    sourceSafe: false,
    makeupGainDb: 99,
  });

  assertLinearDeliveryChain(filter);
  assert.doesNotMatch(filter, /equalizer=f=250:/);
  assert.doesNotMatch(filter, /equalizer=f=3500:/);
  assert.doesNotMatch(filter, /equalizer=f=11200:/);
  assert.doesNotMatch(filter, /equalizer=f=180:/);
  assert.doesNotMatch(filter, /equalizer=f=4500:/);
  assert.doesNotMatch(filter, /equalizer=f=10000:/);
  assert.match(filter, /volume=10\.500dB/);
});
