import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveAuditionBookmarks,
  resolveAuditionLevelMatch,
  resolveAuditionTrackTime,
} from "./reviewAudition.ts";

test("audition matching prefers complete speech-K evidence and only attenuates", () => {
  const plan = resolveAuditionLevelMatch([
    { id: "source", speechKWeightedEnergyDb: -24, integratedLoudnessDb: -23 },
    { id: "winner", speechKWeightedEnergyDb: -20, integratedLoudnessDb: -21 },
    { id: "challenger", speechKWeightedEnergyDb: -27, integratedLoudnessDb: -24 },
  ]);

  assert.equal(plan.metric, "speech-k-weighted");
  assert.equal(plan.targetDb, -27);
  assert.deepEqual(plan.tracks, [
    { id: "source", trimDb: -3 },
    { id: "winner", trimDb: -7 },
    { id: "challenger", trimDb: 0 },
  ]);
  assert.ok(plan.tracks.every((track) => track.trimDb <= 0));
});

test("audition matching falls back as one complete lane and never mixes metrics", () => {
  const plan = resolveAuditionLevelMatch([
    { id: "source", speechKWeightedEnergyDb: -24, integratedLoudnessDb: -22 },
    { id: "winner", speechKWeightedEnergyDb: null, integratedLoudnessDb: -20 },
  ]);

  assert.equal(plan.metric, "integrated-loudness");
  assert.deepEqual(plan.tracks, [
    { id: "source", trimDb: 0 },
    { id: "winner", trimDb: -2 },
  ]);

  assert.equal(
    resolveAuditionLevelMatch([
      { id: "source", speechKWeightedEnergyDb: -24, integratedLoudnessDb: null },
      { id: "winner", speechKWeightedEnergyDb: null, integratedLoudnessDb: -20 },
    ]).metric,
    "unavailable",
  );
});

test("audition track time applies candidate alignment and clamps to its duration", () => {
  assert.equal(resolveAuditionTrackTime(12, 0.18, 30), 12.18);
  assert.equal(resolveAuditionTrackTime(0.05, -0.2, 30), 0);
  assert.equal(resolveAuditionTrackTime(29.9, 0.4, 30), 30);
});

test("audition bookmarks combine spike and flattened evidence on the source timeline", () => {
  const bookmarks = resolveAuditionBookmarks([
    {
      trackId: "winner",
      voiceStability: {
        report: {
          spikes: {
            up: { topEvents: [{ centerSec: 5, peakAddedContrastDb: 3.2 }] },
            down: { topEvents: [{ centerSec: 8, peakAddedContrastDb: 2.7 }] },
          },
          bodySpikes: {
            up: { topEvents: [{ centerSec: 5.03, peakAddedContrastDb: 2.2 }] },
            down: { topEvents: [] },
          },
          expressiveRetention: {
            topFlattenedEvents: [{ centerSec: 13, contrastLossDb: 4.1 }],
          },
        },
      },
    },
    { trackId: "challenger", voiceStability: null },
  ]);

  assert.deepEqual(bookmarks, [
    { trackId: "winner", sourceTimeSec: 5, kind: "up-spike", severityDb: 3.2 },
    { trackId: "winner", sourceTimeSec: 8, kind: "down-spike", severityDb: 2.7 },
    { trackId: "winner", sourceTimeSec: 13, kind: "flattened", severityDb: 4.1 },
  ]);
});

test("audition bookmarks ignore malformed legacy evidence and cap the result", () => {
  const topEvents = Array.from({ length: 20 }, (_, index) => ({
    centerSec: index + 1,
    peakAddedContrastDb: index / 10,
  }));
  const bookmarks = resolveAuditionBookmarks([
    {
      trackId: "winner",
      voiceStability: {
        report: {
          spikes: { up: { topEvents }, down: { topEvents: [] } },
          bodySpikes: { up: { topEvents: [] }, down: { topEvents: [] } },
          expressiveRetention: { topFlattenedEvents: [] },
        },
      },
    },
    {
      trackId: "challenger",
      voiceStability: { report: { spikes: null } },
    },
  ]);

  assert.equal(bookmarks.length, 12);
  assert.ok(bookmarks.every((bookmark) => Number.isFinite(bookmark.sourceTimeSec)));
});
