import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveAdaptiveVoicingPolicy } from "./adaptiveVoicingPolicy.ts";

const voLevelerSource = readFileSync(new URL("../components/VoLeveler.tsx", import.meta.url), "utf8");

const baseInput = {
  cinematicColorRequested: true,
  sceneFitRequested: false,
  drynessScore: 0.68,
  roomScore: 0.08,
  echoScore: 0.06,
  analysisConfidence: 0.92,
  emotionProtection: 0.15,
  profileLowMidGainDb: 0,
  profilePresenceGainDb: 0,
  profileAirGainDb: 0,
  toneMatchDeltaDb: null,
} as const;

test("disabled voicing controls leave the source unchanged", () => {
  const decision = resolveAdaptiveVoicingPolicy({
    ...baseInput,
    cinematicColorRequested: false,
    sceneFitRequested: false,
  });

  assert.equal(decision.warmthGainDb, 0);
  assert.equal(decision.presenceGainDb, 0);
  assert.equal(decision.airGainDb, 0);
  assert.equal(decision.syntheticReflectionIndoorGain, 0);
  assert.equal(decision.syntheticReflectionOutdoorGain, 0);
});

test("clean dry VO never receives synthetic delayed reflections even when scene fit is requested", () => {
  const decision = resolveAdaptiveVoicingPolicy({
    ...baseInput,
    sceneFitRequested: true,
    drynessScore: 0.96,
    roomScore: 0.03,
    echoScore: 0.02,
  });

  assert.equal(decision.syntheticReflectionIndoorGain, 0);
  assert.equal(decision.syntheticReflectionOutdoorGain, 0);
  assert.equal(decision.syntheticReflectionIndoorDelayMs, 0);
  assert.equal(decision.syntheticReflectionOutdoorDelayMs, 0);
  assert.ok(decision.sceneFitAuthority > 0, "the control should remain useful through dry-safe tone");
});

test("room and echo evidence can only reduce tone authority and never enable a delayed reflection", () => {
  const clean = resolveAdaptiveVoicingPolicy(baseInput);
  const roomy = resolveAdaptiveVoicingPolicy({
    ...baseInput,
    sceneFitRequested: true,
    drynessScore: 0.35,
    roomScore: 0.72,
    echoScore: 0.64,
  });

  assert.ok(roomy.colorAuthority < clean.colorAuthority);
  assert.equal(roomy.syntheticReflectionIndoorGain, 0);
  assert.equal(roomy.syntheticReflectionOutdoorGain, 0);
});

test("moderate sources retain subtle bounded cinematic color", () => {
  const decision = resolveAdaptiveVoicingPolicy(baseInput);

  assert.ok(decision.warmthGainDb > 0);
  assert.ok(decision.presenceGainDb > 0);
  assert.ok(decision.airGainDb < 0);
  assert.ok(decision.warmthGainDb <= 0.34);
  assert.ok(decision.presenceGainDb <= 0.24);
  assert.ok(Math.abs(decision.airGainDb) <= 0.18);
});

test("existing profile and tone-match moves continuously reduce same-direction stacking", () => {
  const unstacked = resolveAdaptiveVoicingPolicy(baseInput);
  const stacked = resolveAdaptiveVoicingPolicy({
    ...baseInput,
    profileLowMidGainDb: 1.2,
    profilePresenceGainDb: 1.1,
    profileAirGainDb: -0.9,
    toneMatchDeltaDb: [0, 0.8, 1.1, 0, 0, 0.7, 1.2, -1],
  });

  assert.ok(stacked.warmthGainDb < unstacked.warmthGainDb * 0.65);
  assert.ok(stacked.presenceGainDb < unstacked.presenceGainDb * 0.65);
  assert.ok(Math.abs(stacked.airGainDb) < Math.abs(unstacked.airGainDb) * 0.65);
});

test("emotion and room adaptation remain continuous around former binary boundaries", () => {
  const emotionSweep = [0.48, 0.49, 0.5, 0.51, 0.52].map((emotionProtection) =>
    resolveAdaptiveVoicingPolicy({ ...baseInput, emotionProtection }).warmthGainDb,
  );
  const roomSweep = Array.from({ length: 51 }, (_, index) =>
    resolveAdaptiveVoicingPolicy({ ...baseInput, roomScore: index / 50 }).warmthGainDb,
  );

  assert.ok(emotionSweep.every((gain) => gain > 0));
  assert.ok(
    emotionSweep.slice(1).every((gain, index) => Math.abs(gain - emotionSweep[index]) < 0.01),
    "the old emotionProtection 0.5 hard switch must not survive",
  );
  assert.ok(
    roomSweep.slice(1).every((gain, index) => gain <= roomSweep[index] && roomSweep[index] - gain < 0.02),
    "room evidence should taper authority without a hard step",
  );
});

test("scene fit remains a subtle spectral option without creating a second echo path", () => {
  const cinematicOnly = resolveAdaptiveVoicingPolicy(baseInput);
  const sceneFit = resolveAdaptiveVoicingPolicy({
    ...baseInput,
    cinematicColorRequested: false,
    sceneFitRequested: true,
  });
  const combined = resolveAdaptiveVoicingPolicy({
    ...baseInput,
    sceneFitRequested: true,
  });

  assert.ok(sceneFit.warmthGainDb > 0);
  assert.ok(sceneFit.warmthGainDb < cinematicOnly.warmthGainDb);
  assert.ok(combined.warmthGainDb > cinematicOnly.warmthGainDb);
  assert.ok(combined.warmthGainDb <= 0.34);
  assert.equal(combined.syntheticReflectionIndoorGain, 0);
  assert.equal(combined.syntheticReflectionOutdoorGain, 0);
});

test("the app uses the adaptive policy and tells users scene fit is reflection-free", () => {
  const blendFilterStart = voLevelerSource.indexOf("const buildBlendFilter =");
  const blendFilterEnd = voLevelerSource.indexOf("const writeOutput =", blendFilterStart);

  assert.ok(blendFilterStart >= 0 && blendFilterEnd > blendFilterStart);
  assert.match(voLevelerSource, /resolveAdaptiveVoicingPolicy\(\{/);
  assert.match(voLevelerSource, /cinematicWarmthGainDb: voicingDecision\.warmthGainDb/);
  assert.match(voLevelerSource, /blendIndoorGain: voicingDecision\.syntheticReflectionIndoorGain/);
  assert.match(voLevelerSource, /Scene fit \(dry-safe tone\)/);
  assert.match(voLevelerSource, /never adds\s+delayed reflections/i);
  assert.doesNotMatch(voLevelerSource, /\(profile\?\.emotionProtection \?\? 0\) < 0\.5/);
  assert.doesNotMatch(voLevelerSource.slice(blendFilterStart, blendFilterEnd), /adelay=/);
});

test("soften harshness only enables measured adaptive cuts and has no fixed clean-source tilt", () => {
  assert.doesNotMatch(voLevelerSource, /basePresenceCut/);
  assert.doesNotMatch(voLevelerSource, /baseAirCut/);
  assert.match(
    voLevelerSource,
    /const harshPresenceCut = controls\.softenHarshness\s+\? profile\?\.emotionalHarshnessCutDb \?\? 0\s+: 0/,
  );
  assert.match(
    voLevelerSource,
    /const harshAirCut = controls\.softenHarshness\s+\? profile\?\.topEndHarshnessCutDb \?\? 0\s+: 0/,
  );
  assert.match(voLevelerSource, /Cuts only measured presence and top-end harshness/i);
});

test("matched low-mid tone stays neutral instead of receiving a fixed two-decibel cut", () => {
  assert.doesNotMatch(voLevelerSource, /-2\s*-\s*lowTiltDiff/);
  assert.match(
    voLevelerSource,
    /const lowMidGainDb = clamp\(\s*-lowTiltDiff \* 0\.28 \* toneFactor \+ directives\.warmthDb/,
  );
  assert.match(
    voLevelerSource,
    /sourceSafeMode\s+\? clamp\(profile\?\.lowMidGainDb \?\? -0\.8, -1\.2, 0\)\s+: \(profile\?\.lowMidGainDb \?\? 0\)/,
  );
  assert.match(voLevelerSource, /continuously adapts to the\s+measured source/i);
});
