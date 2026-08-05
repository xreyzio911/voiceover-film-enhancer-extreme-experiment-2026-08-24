import assert from "node:assert/strict";
import test from "node:test";
import {
  planBatchSpeechAlignment,
  planDistributedSpeechEvidenceWindows,
} from "./batchLoudnessAlign.ts";

test("batch speech alignment anchors to the median and clamps offsets", () => {
  const result = planBatchSpeechAlignment([
    { id: "quiet", speechLevelDb: -25.2 },
    { id: "anchor", speechLevelDb: -22.8 },
    { id: "loud", speechLevelDb: -20.2 },
  ]);

  assert.equal(result.anchorDb, -22.8);
  assert.deepEqual(
    result.plans.map((plan) => ({ id: plan.id, offsetDb: plan.offsetDb })),
    [
      { id: "quiet", offsetDb: 2 },
      { id: "anchor", offsetDb: 0 },
      { id: "loud", offsetDb: -2 },
    ],
  );
});

test("batch speech alignment no-ops single-file, missing, and in-threshold evidence", () => {
  assert.deepEqual(planBatchSpeechAlignment([{ id: "solo", speechLevelDb: -22.4 }]).plans, [
    { id: "solo", speechLevelDb: -22.4, offsetDb: 0, shouldAlign: false },
  ]);

  const result = planBatchSpeechAlignment([
    { id: "a", speechLevelDb: -22.7 },
    { id: "b", speechLevelDb: -22.3 },
    { id: "missing", speechLevelDb: null },
  ]);

  assert.equal(result.anchorDb, -22.5);
  assert.ok(result.plans.every((plan) => !plan.shouldAlign));
  assert.deepEqual(result.plans.at(-1), {
    id: "missing",
    speechLevelDb: null,
    offsetDb: 0,
    shouldAlign: false,
  });
});

test("batch speech evidence stays full for short outputs and bounded for long outputs", () => {
  assert.deepEqual(planDistributedSpeechEvidenceWindows(180), [
    { startSec: 0, durationSec: 180 },
  ]);

  const windows = planDistributedSpeechEvidenceWindows(600);
  assert.equal(windows.length, 6);
  assert.deepEqual(windows[0], { startSec: 0, durationSec: 30 });
  assert.deepEqual(windows.at(-1), { startSec: 570, durationSec: 30 });
  assert.ok(windows.every((window) => window.durationSec <= 30));
  assert.ok(
    windows.reduce((total, window) => total + window.durationSec, 0) <= 180,
    "long-file batch evidence must keep a fixed decode budget",
  );
});

test("very long batch speech evidence grows duration-proportionally without overlapping", () => {
  const windows = planDistributedSpeechEvidenceWindows(1_828.7);

  assert.equal(windows.length, 24);
  assert.ok(windows.every((window) => window.durationSec === 15));
  assert.deepEqual(windows[0], { startSec: 0, durationSec: 15 });
  assert.deepEqual(windows.at(-1), { startSec: 1_813.7, durationSec: 15 });
  assert.ok(
    windows.every((window, index) => (
      index === 0 || window.startSec >= windows[index - 1].startSec + windows[index - 1].durationSec
    )),
    "distributed evidence windows must be deterministic and non-overlapping",
  );
  assert.equal(
    windows.reduce((total, window) => total + window.durationSec, 0),
    360,
    "the 24-window cap must bound a very long file to six minutes of decoded evidence",
  );
});

test("duration-proportional evidence never reduces coverage at the medium-file boundary", () => {
  const boundaryWindows = planDistributedSpeechEvidenceWindows(720);
  assert.equal(boundaryWindows.length, 6);
  assert.ok(boundaryWindows.every((window) => window.durationSec === 30));
  assert.equal(
    boundaryWindows.reduce((total, window) => total + window.durationSec, 0),
    180,
  );

  const firstScaledDurationSec = 720.001;
  const scaledWindows = planDistributedSpeechEvidenceWindows(firstScaledDurationSec);
  assert.equal(scaledWindows.length, 13);
  assert.ok(scaledWindows.every((window) => window.durationSec === 15));
  assert.deepEqual(scaledWindows.at(-1), { startSec: 705.001, durationSec: 15 });
  assert.ok(
    scaledWindows.reduce((total, window) => total + window.durationSec, 0) >= 180,
  );
  assert.deepEqual(
    planDistributedSpeechEvidenceWindows(firstScaledDurationSec),
    scaledWindows,
    "the same duration must always produce the same distributed windows",
  );
});

test("batch speech evidence window planning fails soft on invalid durations", () => {
  assert.deepEqual(planDistributedSpeechEvidenceWindows(Number.NaN), []);
  assert.deepEqual(planDistributedSpeechEvidenceWindows(0), []);
  assert.deepEqual(planDistributedSpeechEvidenceWindows(-1), []);
});
