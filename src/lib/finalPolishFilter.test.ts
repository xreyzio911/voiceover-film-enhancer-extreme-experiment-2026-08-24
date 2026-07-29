import assert from "node:assert/strict";
import test from "node:test";
import {
  FINAL_POLISH_LIMITER_FILTER,
  buildFinalPolishFilter,
} from "./finalPolishFilter.ts";

const activeTone = {
  bodyPreservationTiltDb: 0,
  fourKhzExcessDb: 2.4,
  eightKhzExcessDb: 3.2,
  topOctaveExcessDb: 3.7,
  fourKhzTrimDb: -0.62,
  eightKhzTrimDb: -0.78,
  topOctaveTrimDb: -1.74,
};

test("delivery limiter compensates its own lookahead latency", () => {
  assert.match(
    FINAL_POLISH_LIMITER_FILTER,
    /:latency=1(?:$|:)/,
    "the delivered waveform must not inherit the limiter's lookahead delay",
  );
});

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

test("final polish preserves measured body loss with one gentle subtractive high shelf", () => {
  const filter = buildFinalPolishFilter(
    {
      ...activeTone,
      bodyPreservationTiltDb: -0.56,
      fourKhzTrimDb: 0,
      eightKhzTrimDb: 0,
      topOctaveTrimDb: 0,
    },
    {
      sourceSafe: false,
      makeupGainDb: 0,
    },
  );

  assertLinearDeliveryChain(filter);
  const shelfStages = filter
    .split(",")
    .filter((stage) => stage.startsWith("highshelf="));
  assert.equal(
    shelfStages.length,
    1,
    `body preservation should emit one high shelf, got ${filter}`,
  );
  assert.match(
    shelfStages[0],
    /^highshelf=f=(?:9\d{2}|1000):width_type=q:width=(?:0\.\d+|1(?:\.0)?):g=-0\.56$/,
  );
  assert.doesNotMatch(
    filter,
    /(?:equalizer|lowshelf)=f=(?:[0-7]\d{0,2}|800):[^,]*:g=\+?[0-9]/,
    "body preservation must not add low-frequency gain",
  );
  assert.doesNotMatch(
    filter,
    /(?:equalizer|highshelf)=f=(?:8\d{2}|9\d{2}|[1-9]\d{3,}):[^,]*:g=\+?[0-9]/,
    "body preservation must not add positive gain above 800 Hz",
  );
});

test("final polish emits no body shelf when source-relative body is preserved", () => {
  const filter = buildFinalPolishFilter(
    {
      ...activeTone,
      bodyPreservationTiltDb: 0,
      fourKhzTrimDb: 0,
      eightKhzTrimDb: 0,
      topOctaveTrimDb: 0,
    },
    {
      sourceSafe: false,
      makeupGainDb: 0,
    },
  );

  assert.equal(filter, FINAL_POLISH_LIMITER_FILTER);
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
