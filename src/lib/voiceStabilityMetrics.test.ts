import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareVoiceStability,
  type VoiceEnvelopeEvidence,
} from "./voiceStabilityMetrics.ts";
import {
  discoverCorpusPairs,
  MAX_EXPLICIT_PAIRS,
  parseMeasureVoCorpusArguments,
  prepareLedgerOutputPath,
  resolveExplicitCorpusPairs,
  resolveLedgerOutputPath,
} from "../../scripts/measureVoCorpus.mts";

const FRAME_MS = 20;

const evidence = (
  frameDb: readonly number[],
  speechBodyDb: readonly number[] = frameDb.map((value) => value - 1),
  framePeakDb: readonly number[] = frameDb.map((value) => value + 8),
): VoiceEnvelopeEvidence => ({
  frameMs: FRAME_MS,
  frameDb,
  speechBodyDb,
  framePeakDb,
});

const speech = (count: number, db = -24) =>
  Array.from({ length: count }, (_, index) => db + Math.sin(index / 17) * 0.35);

test("static gain is invisible to drift, spike, and speech-body stability metrics", () => {
  const sourceFrameDb = speech(4_000);
  const source = evidence(sourceFrameDb);
  const candidate = evidence(
    source.frameDb.map((value) => value + 12),
    source.speechBodyDb.map((value) => value + 12),
    source.framePeakDb.map((value) => value + 12),
  );

  const report = compareVoiceStability(source, candidate);

  assert.ok(Math.abs(report.drift.signedSlopeDbPerMinute ?? Infinity) < 1e-9);
  assert.equal(report.spikes.up.countAboveAdvisoryContrast, 0);
  assert.equal(report.spikes.down.countAboveAdvisoryContrast, 0);
  assert.equal(report.bodySpikes.up.countAboveAdvisoryContrast, 0);
  assert.equal(report.bodySpikes.down.countAboveAdvisoryContrast, 0);
  assert.ok(Math.abs(report.body.floorFillDeltaDb ?? Infinity) < 1e-9);
  assert.ok(Math.abs(report.body.spreadDeltaDb ?? Infinity) < 1e-9);
  assert.ok(Math.abs(report.body.bodyBalanceDeltaDb ?? Infinity) < 1e-9);
  assert.ok(Math.abs(report.intraRunBody.spreadDeltaMedianDb ?? Infinity) < 1e-9);
  assert.ok(Math.abs(report.intraRunBody.spreadDeltaP90Db ?? Infinity) < 1e-9);
});

test("robust section slopes retain signed slow rise and fall despite one outlier", () => {
  const sourceFrameDb = speech(12_000);
  const risingFrameDb = sourceFrameDb.map((value, index) => value + (index / (sourceFrameDb.length - 1)) * 6);
  for (let index = 5_000; index < 5_100; index += 1) risingFrameDb[index] += 18;

  const rising = compareVoiceStability(evidence(sourceFrameDb), evidence(risingFrameDb));
  const falling = compareVoiceStability(
    evidence(sourceFrameDb),
    evidence(sourceFrameDb.map((value, index) => value - (index / (sourceFrameDb.length - 1)) * 6)),
  );

  assert.ok((rising.drift.signedSlopeDbPerMinute ?? 0) > 1);
  assert.ok((rising.drift.risingSlopeP75DbPerMinute ?? 0) > 1);
  assert.ok(Math.abs(rising.drift.sourceSignedSlopeDbPerMinute ?? Infinity) < 0.1);
  assert.ok((rising.drift.candidateSignedSlopeDbPerMinute ?? 0) > 1);
  assert.ok((falling.drift.signedSlopeDbPerMinute ?? 0) < -1);
  assert.ok((falling.drift.fallingSlopeP25DbPerMinute ?? 0) < -1);
  assert.ok((falling.drift.candidateSignedSlopeDbPerMinute ?? 0) < -1);
});

test("reports processing-added local upward and downward spike contrast", () => {
  const sourceFrameDb = speech(2_500);
  const candidateFrameDb = [...sourceFrameDb];
  candidateFrameDb[700] += 7;
  candidateFrameDb[701] += 7;
  candidateFrameDb[1_700] -= 6;
  candidateFrameDb[1_701] -= 6;

  const report = compareVoiceStability(evidence(sourceFrameDb), evidence(candidateFrameDb));

  assert.ok((report.spikes.up.p95AddedContrastDb ?? 0) > 5);
  assert.ok((report.spikes.down.p95AddedContrastDb ?? 0) > 4);
  assert.equal(report.spikes.up.countAboveAdvisoryContrast, 1);
  assert.equal(report.spikes.down.countAboveAdvisoryContrast, 1);
});

test("separates removed low-frequency artifacts from speech-body dropouts", () => {
  const sourceBodyDb = speech(2_500, -25);
  const candidateBodyDb = sourceBodyDb.map((value) => value + 8);
  const sourceFrameDb = sourceBodyDb.map((value) => value + 1);
  const candidateFrameDb = sourceFrameDb.map((value) => value + 8);
  for (let index = 1_200; index < 1_204; index += 1) {
    candidateFrameDb[index] -= 24;
  }

  const report = compareVoiceStability(
    evidence(sourceFrameDb, sourceBodyDb),
    evidence(candidateFrameDb, candidateBodyDb),
  );

  assert.ok((report.spikes.down.p95AddedContrastDb ?? 0) > 15);
  assert.equal(report.bodySpikes.down.countAboveAdvisoryContrast, 0);
  assert.equal(report.bodySpikes.up.countAboveAdvisoryContrast, 0);
});

test("speech-body spike lane still reports a genuine processing-added body dip", () => {
  const sourceFrameDb = speech(2_500);
  const sourceBodyDb = sourceFrameDb.map((value) => value - 1);
  const candidateFrameDb = sourceFrameDb.map((value) => value + 8);
  const candidateBodyDb = sourceBodyDb.map((value) => value + 8);
  for (let index = 1_200; index < 1_204; index += 1) {
    candidateBodyDb[index] -= 7;
  }

  const report = compareVoiceStability(
    evidence(sourceFrameDb, sourceBodyDb),
    evidence(candidateFrameDb, candidateBodyDb),
  );

  assert.ok((report.bodySpikes.down.p95AddedContrastDb ?? 0) > 5);
  assert.equal(report.bodySpikes.down.countAboveAdvisoryContrast, 1);
});

test("intra-run body metric exposes sustained word-scale worsening without using pause floor", () => {
  const sourceFrameDb = speech(500);
  const sourceBodyDb = sourceFrameDb.map((value) => value - 1);
  const candidateFrameDb = sourceFrameDb.map((value) => value + 8);
  const candidateBodyDb = sourceBodyDb.map((value) => value + 8);
  for (let index = 200; index < 250; index += 1) {
    candidateBodyDb[index] -= 6;
  }

  const report = compareVoiceStability(
    evidence(sourceFrameDb, sourceBodyDb),
    evidence(candidateFrameDb, candidateBodyDb),
  );

  assert.ok(report.intraRunBody.eligibleRunCount >= 1);
  assert.ok((report.intraRunBody.spreadDeltaMedianDb ?? 0) > 1);
  assert.ok((report.intraRunBody.spreadDeltaP90Db ?? 0) > 1);
  assert.ok(report.intraRunBody.worsenedRunCount >= 1);
});

test("reports deterministic top-five clustered spike windows for audition", () => {
  const sourceFrameDb = speech(5_000);
  const candidateFrameDb = [...sourceFrameDb];
  const upEvents = [
    { index: 500, addedDb: 3 },
    { index: 900, addedDb: 4 },
    { index: 1_300, addedDb: 5 },
    { index: 1_700, addedDb: 6 },
    { index: 2_100, addedDb: 7 },
    { index: 2_500, addedDb: 8 },
  ];
  const downEvents = [
    { index: 700, addedDb: 3.5 },
    { index: 1_100, addedDb: 4.5 },
    { index: 1_500, addedDb: 5.5 },
    { index: 1_900, addedDb: 6.5 },
    { index: 2_300, addedDb: 7.5 },
    { index: 2_700, addedDb: 8.5 },
  ];
  for (const event of upEvents) {
    candidateFrameDb[event.index] += event.addedDb;
    candidateFrameDb[event.index + 1] += event.addedDb;
  }
  for (const event of downEvents) {
    candidateFrameDb[event.index] -= event.addedDb;
    candidateFrameDb[event.index + 1] -= event.addedDb;
  }

  const report = compareVoiceStability(evidence(sourceFrameDb), evidence(candidateFrameDb));

  assert.equal(report.spikes.up.topEvents.length, 5);
  assert.equal(report.spikes.down.topEvents.length, 5);
  for (const events of [report.spikes.up.topEvents, report.spikes.down.topEvents]) {
    assert.ok(events.every((event) => event.startSec < event.centerSec));
    assert.ok(events.every((event) => event.centerSec < event.endSec));
    assert.ok(events.every((event) => event.peakAddedContrastDb >= report.spikes.advisoryContrastDb));
    assert.deepEqual(
      events.map((event) => event.peakAddedContrastDb),
      events.map((event) => event.peakAddedContrastDb).toSorted((left, right) => right - left),
    );
  }
  assert.ok(Math.abs(report.spikes.up.topEvents[0].startSec - 50) < 1e-9);
  assert.ok(Math.abs(report.spikes.up.topEvents[0].endSec - 50.04) < 1e-9);
  assert.ok(Math.abs(report.spikes.down.topEvents[0].startSec - 54) < 1e-9);
  assert.ok(Math.abs(report.spikes.down.topEvents[0].endSec - 54.04) < 1e-9);
});

test("spike windows remain in the original source timeline after global alignment", () => {
  const advanceFrames = 5;
  const sourceFrameDb = Array.from(
    { length: 4_000 },
    (_, index) => -28 + Math.sin(index / 9) * 2 + Math.sin(index / 41) * 3,
  );
  const candidateFrameDb = [
    ...sourceFrameDb.slice(advanceFrames).map((value) => value + 9),
    ...new Array<number>(advanceFrames).fill(-120),
  ];
  const sourceEventFrame = 300;
  candidateFrameDb[sourceEventFrame - advanceFrames] += 8;
  candidateFrameDb[sourceEventFrame - advanceFrames + 1] += 8;

  const report = compareVoiceStability(
    evidence(sourceFrameDb),
    evidence(candidateFrameDb),
  );

  assert.equal(report.alignment.candidateLagFrames, -advanceFrames);
  assert.equal(report.spikes.up.topEvents.length, 1);
  assert.ok(Math.abs(report.spikes.up.topEvents[0].startSec - 6) < 1e-9);
  assert.ok(Math.abs(report.spikes.up.topEvents[0].endSec - 6.04) < 1e-9);
});

test("source-body support keeps changed pause floors out of speech spike and fill evidence", () => {
  const sourceFrameDb = [
    ...speech(600),
    ...new Array<number>(100).fill(-62),
    ...speech(600),
  ];
  const sourceBodyDb = sourceFrameDb.map((value) => value <= -60 ? -110 : value - 1);
  const candidateFrameDb = sourceFrameDb.map((value) => value <= -60 ? -120 : value + 9);
  const candidateBodyDb = sourceBodyDb.map((value) => value <= -100 ? -120 : value + 9);

  const report = compareVoiceStability(
    evidence(sourceFrameDb, sourceBodyDb),
    evidence(candidateFrameDb, candidateBodyDb),
  );

  assert.equal(report.spikes.up.countAboveAdvisoryContrast, 0);
  assert.equal(report.spikes.down.countAboveAdvisoryContrast, 0);
  assert.ok(Math.abs(report.body.floorFillDeltaDb ?? Infinity) < 0.25);
});

test("sub-frame render timing movement is not misreported as a new spike or flattened emphasis", () => {
  const sourceFrameDb = speech(2_500);
  const sourcePeakDb = sourceFrameDb.map((value) => value + 7);
  sourceFrameDb[1_200] += 7;
  sourcePeakDb[1_200] += 10;
  const candidateFrameDb = sourceFrameDb.map((value) => value + 8);
  const candidatePeakDb = sourcePeakDb.map((value) => value + 8);
  for (const index of [1_200]) {
    candidateFrameDb[index] -= 7;
    candidatePeakDb[index] -= 10;
  }
  for (const index of [1_201]) {
    candidateFrameDb[index] += 7;
    candidatePeakDb[index] += 10;
  }

  const report = compareVoiceStability(
    evidence(sourceFrameDb, sourceFrameDb.map((value) => value - 1), sourcePeakDb),
    evidence(candidateFrameDb, candidateFrameDb.map((value) => value - 1), candidatePeakDb),
  );

  assert.equal(report.spikes.up.countAboveAdvisoryContrast, 0);
  assert.equal(report.spikes.down.countAboveAdvisoryContrast, 0);
  assert.ok((report.expressiveRetention.contrastRetentionP10Ratio ?? 0) > 0.9);
  assert.equal(report.expressiveRetention.flattenedEventCount, 0);
});

test("bounded global lag alignment makes a delayed static-gain render source-equivalent", () => {
  const delayFrames = 5;
  const sourceFrameDb = Array.from(
    { length: 4_000 },
    (_, index) => -28 + Math.sin(index / 9) * 2 + Math.sin(index / 41) * 3,
  );
  const sourceBodyDb = sourceFrameDb.map((value) => value - 1);
  const sourcePeakDb = sourceFrameDb.map((value) => value + 8);
  const delayed = (values: readonly number[], floor: number) => [
    ...new Array<number>(delayFrames).fill(floor),
    ...values.slice(0, -delayFrames).map((value) => value + 9),
  ];

  const report = compareVoiceStability(
    evidence(sourceFrameDb, sourceBodyDb, sourcePeakDb),
    evidence(
      delayed(sourceFrameDb, -120),
      delayed(sourceBodyDb, -120),
      delayed(sourcePeakDb, -120),
    ),
  );

  assert.equal(report.alignment.candidateLagFrames, delayFrames);
  assert.equal(report.alignment.candidateLagMs, delayFrames * FRAME_MS);
  assert.equal(report.spikes.up.countAboveAdvisoryContrast, 0);
  assert.equal(report.spikes.down.countAboveAdvisoryContrast, 0);
  assert.ok(Math.abs(report.body.floorFillDeltaDb ?? Infinity) < 1e-9);
});

test("bounded global lag alignment is symmetric for a candidate that starts early", () => {
  const advanceFrames = 5;
  const sourceFrameDb = Array.from(
    { length: 4_000 },
    (_, index) => -28 + Math.sin(index / 9) * 2 + Math.sin(index / 41) * 3,
  );
  const sourceBodyDb = sourceFrameDb.map((value) => value - 1);
  const sourcePeakDb = sourceFrameDb.map((value) => value + 8);
  const advanced = (values: readonly number[], floor: number) => [
    ...values.slice(advanceFrames).map((value) => value + 9),
    ...new Array<number>(advanceFrames).fill(floor),
  ];

  const report = compareVoiceStability(
    evidence(sourceFrameDb, sourceBodyDb, sourcePeakDb),
    evidence(
      advanced(sourceFrameDb, -120),
      advanced(sourceBodyDb, -120),
      advanced(sourcePeakDb, -120),
    ),
  );

  assert.equal(report.alignment.candidateLagFrames, -advanceFrames);
  assert.equal(report.alignment.candidateLagMs, -advanceFrames * FRAME_MS);
  assert.equal(report.spikes.up.countAboveAdvisoryContrast, 0);
  assert.equal(report.spikes.down.countAboveAdvisoryContrast, 0);
  assert.ok(Math.abs(report.body.floorFillDeltaDb ?? Infinity) < 1e-9);
});

test("speech-body floor, fill, and spread stay gain invariant and expose filled valleys", () => {
  const sourceFrameDb = speech(3_000);
  const sourceBodyDb = sourceFrameDb.map((value, index) => value - 2 - (index % 20 < 4 ? 5 : 0));
  const candidateBodyDb = sourceFrameDb.map((value, index) => value + 8 - 2 - (index % 20 < 4 ? 1 : 0));
  const candidateFrameDb = sourceFrameDb.map((value) => value + 8);

  const report = compareVoiceStability(
    evidence(sourceFrameDb, sourceBodyDb),
    evidence(candidateFrameDb, candidateBodyDb),
  );

  assert.ok((report.body.floorFillDeltaDb ?? 0) > 2);
  assert.ok((report.body.spreadDeltaDb ?? 0) < -2);
  assert.ok(Math.abs(report.body.bodyBalanceDeltaDb ?? Infinity) < 1);
});

test("source-derived expressive events independently expose flattened emphasis", () => {
  const sourceFrameDb = speech(3_000);
  const sourcePeakDb = sourceFrameDb.map((value) => value + 7);
  for (let index = 1_490; index <= 1_510; index += 1) {
    sourceFrameDb[index] += 7;
    sourcePeakDb[index] += 12;
  }
  const candidateFrameDb = [...sourceFrameDb];
  const candidatePeakDb = [...sourcePeakDb];
  for (let index = 1_490; index <= 1_510; index += 1) {
    candidateFrameDb[index] -= 5;
    candidatePeakDb[index] -= 7;
  }

  const report = compareVoiceStability(
    evidence(sourceFrameDb, sourceFrameDb.map((value) => value - 1), sourcePeakDb),
    evidence(candidateFrameDb, candidateFrameDb.map((value) => value - 1), candidatePeakDb),
  );

  assert.ok(report.expressiveRetention.sourceEventCount >= 1);
  assert.ok((report.expressiveRetention.contrastRetentionP10Ratio ?? 1) < 0.6);
  assert.ok(report.expressiveRetention.flattenedEventCount >= 1);
  assert.ok((report.expressiveRetention.crestDeltaP10Db ?? 0) < 0);
  assert.equal(report.expressiveRetention.topFlattenedEvents.length, 1);
  const flattened = report.expressiveRetention.topFlattenedEvents[0];
  assert.ok(flattened.startSec < flattened.centerSec);
  assert.ok(flattened.centerSec < flattened.endSec);
  assert.ok(flattened.sourceContrastDb > flattened.candidateContrastDb);
  assert.ok(flattened.retentionRatio < 0.6);
  assert.ok(flattened.contrastLossDb >= 2);
  assert.ok((flattened.crestDeltaDb ?? 0) < 0);
});

test("reports at most five flattened events by strongest loss with earlier ties first", () => {
  const sourceFrameDb = speech(3_200);
  const sourcePeakDb = sourceFrameDb.map((value) => value + 7);
  const eventSpecs = [
    { index: 400, lossDb: 3 },
    { index: 800, lossDb: 4 },
    { index: 1_200, lossDb: 5 },
    { index: 1_600, lossDb: 6 },
    { index: 2_000, lossDb: 8 },
    { index: 2_400, lossDb: 8 },
  ];
  for (const event of eventSpecs) {
    for (let index = event.index; index < event.index + 3; index += 1) {
      sourceFrameDb[index] += 8;
      sourcePeakDb[index] += 20;
    }
  }
  const candidateFrameDb = [...sourceFrameDb];
  const candidatePeakDb = [...sourcePeakDb];
  for (const event of eventSpecs) {
    for (let index = event.index; index < event.index + 3; index += 1) {
      candidateFrameDb[index] -= event.lossDb;
      candidatePeakDb[index] -= event.lossDb + 3;
    }
  }

  const report = compareVoiceStability(
    evidence(sourceFrameDb, sourceFrameDb.map((value) => value - 1), sourcePeakDb),
    evidence(candidateFrameDb, candidateFrameDb.map((value) => value - 1), candidatePeakDb),
  );

  const topEvents = report.expressiveRetention.topFlattenedEvents;
  assert.equal(report.expressiveRetention.flattenedEventCount, 6);
  assert.equal(topEvents.length, 5);
  assert.deepEqual(
    topEvents.map((event) => event.contrastLossDb),
    topEvents.map((event) => event.contrastLossDb).toSorted((left, right) => right - left),
  );
  assert.ok(Math.abs(topEvents[0].startSec - 40) < 1e-9);
  assert.ok(Math.abs(topEvents[1].startSec - 48) < 1e-9);
  assert.ok(topEvents.every((event) => Number.isFinite(event.sourceContrastDb)));
  assert.ok(topEvents.every((event) => Number.isFinite(event.candidateContrastDb)));
  assert.ok(topEvents.every((event) => Number.isFinite(event.retentionRatio)));
  assert.ok(topEvents.every((event) => Number.isFinite(event.contrastLossDb)));
});

test("flattened-event timestamps remain on the original source timeline after alignment", () => {
  const advanceFrames = 5;
  const sourceFrameDb = Array.from(
    { length: 4_000 },
    (_, index) => -28 + Math.sin(index / 9) * 2 + Math.sin(index / 41) * 3,
  );
  const sourcePeakDb = sourceFrameDb.map((value) => value + 7);
  const sourceEventFrame = 300;
  for (let index = sourceEventFrame; index < sourceEventFrame + 3; index += 1) {
    sourceFrameDb[index] += 8;
    sourcePeakDb[index] += 20;
  }
  const advance = (values: readonly number[], floor: number) => [
    ...values.slice(advanceFrames).map((value) => value + 9),
    ...new Array<number>(advanceFrames).fill(floor),
  ];
  const candidateFrameDb = advance(sourceFrameDb, -120);
  const candidatePeakDb = advance(sourcePeakDb, -120);
  for (
    let index = sourceEventFrame - advanceFrames;
    index < sourceEventFrame - advanceFrames + 3;
    index += 1
  ) {
    candidateFrameDb[index] -= 5;
    candidatePeakDb[index] -= 8;
  }

  const report = compareVoiceStability(
    evidence(sourceFrameDb, sourceFrameDb.map((value) => value - 1), sourcePeakDb),
    evidence(candidateFrameDb, candidateFrameDb.map((value) => value - 1), candidatePeakDb),
  );

  assert.equal(report.alignment.candidateLagFrames, -advanceFrames);
  assert.equal(report.expressiveRetention.topFlattenedEvents.length, 1);
  const event = report.expressiveRetention.topFlattenedEvents[0];
  assert.ok(Math.abs(event.startSec - 6) < 1e-9);
  assert.ok(Math.abs(event.endSec - 6.06) < 1e-9);
});

test("flattened events stay finite and report a null crest delta when crest evidence is absent", () => {
  const sourceFrameDb = speech(2_000);
  for (let index = 900; index < 903; index += 1) sourceFrameDb[index] += 7;
  const candidateFrameDb = [...sourceFrameDb];
  for (let index = 900; index < 903; index += 1) candidateFrameDb[index] -= 5;
  const unavailablePeaks = new Array<number>(sourceFrameDb.length).fill(Number.NaN);

  const report = compareVoiceStability(
    evidence(sourceFrameDb, sourceFrameDb.map((value) => value - 1), unavailablePeaks),
    evidence(candidateFrameDb, candidateFrameDb.map((value) => value - 1), unavailablePeaks),
  );

  assert.equal(report.expressiveRetention.topFlattenedEvents.length, 1);
  const event = report.expressiveRetention.topFlattenedEvents[0];
  assert.equal(event.crestDeltaDb, null);
  assert.ok([
    event.startSec,
    event.endSec,
    event.centerSec,
    event.sourceContrastDb,
    event.candidateContrastDb,
    event.retentionRatio,
    event.contrastLossDb,
  ].every(Number.isFinite));
});

test("missing and non-finite evidence fails soft without mutating either input", () => {
  const source = evidence(Object.freeze([-24, Number.NaN, -23, Number.POSITIVE_INFINITY]));
  const candidate = evidence(Object.freeze([-20]));
  const sourceSnapshot = [...source.frameDb];
  const candidateSnapshot = [...candidate.frameDb];

  const report = compareVoiceStability(source, candidate);

  assert.equal(report.drift.signedSlopeDbPerMinute, null);
  assert.equal(report.body.floorFillDeltaDb, null);
  assert.deepEqual(report.expressiveRetention.topFlattenedEvents, []);
  assert.ok(report.notes.length > 0);
  assert.deepEqual(source.frameDb, sourceSnapshot);
  assert.deepEqual(candidate.frameDb, candidateSnapshot);
});

test("corpus discovery pairs naming variants and reports every unmatched WAV", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vo-corpus-ledger-"));
  try {
    const paths = [
      "audio testing/Actor One.wav",
      "audio testing/the result/Actor_One_mixready.wav",
      "audio testing/Unmatched Source.wav",
      "bug/Actor Two.wav",
      "bug/result/Actor_Two_mixready.wav",
      "bug/result/Unmatched_Result_mixready.wav",
      "another testing/ori-preview Actor Three.wav",
      "another testing/result-preview_Actor_Three_mixready.wav",
    ];
    for (const relativePath of paths) {
      const absolutePath = path.join(root, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, new Uint8Array());
    }

    const discovery = await discoverCorpusPairs(root);

    assert.equal(discovery.pairs.length, 3);
    assert.deepEqual(
      discovery.unmatchedSources.map((item) => path.basename(item.path)),
      ["Unmatched Source.wav"],
    );
    assert.deepEqual(
      discovery.unmatchedResults.map((item) => path.basename(item.path)),
      ["Unmatched_Result_mixready.wav"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corpus discovery uses the optional local Arthur browser render when present", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vo-corpus-arthur-"));
  try {
    const source = path.join(root, "audio testing/Arthur_Batch1-10.wav");
    const result = path.join(
      root,
      "tasks/render-evidence/current-goal/browser/arthur-exact-24a2daa/Arthur_Batch1-10_patched-final-residual.wav",
    );
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(path.dirname(result), { recursive: true });
    await writeFile(source, new Uint8Array());
    await writeFile(result, new Uint8Array());

    const discovery = await discoverCorpusPairs(root);

    assert.equal(discovery.pairs.length, 1);
    assert.equal(discovery.pairs[0].source.relativePath, "audio testing/Arthur_Batch1-10.wav");
    assert.equal(
      discovery.pairs[0].result.relativePath,
      "tasks/render-evidence/current-goal/browser/arthur-exact-24a2daa/Arthur_Batch1-10_patched-final-residual.wav",
    );
    assert.equal(discovery.unmatchedSources.length, 0);
    assert.equal(discovery.unmatchedResults.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("measure CLI parses repeatable explicit pairs without changing its default mode", () => {
  assert.deepEqual(
    parseMeasureVoCorpusArguments([
      "--out",
      "tasks/render-evidence/current-goal/audition.json",
    ]),
    {
      output: "tasks/render-evidence/current-goal/audition.json",
      pairSpecs: [],
    },
  );
  assert.deepEqual(
    parseMeasureVoCorpusArguments([
      "--pair",
      "clips/a-source.wav|clips/a-result.wav|audition-a",
      "--out",
      "tasks/render-evidence/current-goal/audition.json",
      "--pair",
      "clips/b-source.wav|clips/b-result.wav|audition-b",
    ]),
    {
      output: "tasks/render-evidence/current-goal/audition.json",
      pairSpecs: [
        "clips/a-source.wav|clips/a-result.wav|audition-a",
        "clips/b-source.wav|clips/b-result.wav|audition-b",
      ],
    },
  );
});

test("explicit pairs resolve deterministically inside the repo and stay bounded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vo-explicit-pairs-"));
  try {
    const paths = [
      "clips/a-source.wav",
      "clips/a-result.wav",
      "clips/b-source.wav",
      "clips/b-result.wav",
    ];
    for (const relativePath of paths) {
      const absolutePath = path.join(root, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, new Uint8Array());
    }

    const pairs = await resolveExplicitCorpusPairs(root, [
      "clips/b-source.wav|clips/b-result.wav|audition-b",
      "clips/a-source.wav|clips/a-result.wav|audition-a",
    ]);

    assert.deepEqual(pairs.map((pair) => pair.id), ["audition-b", "audition-a"]);
    assert.deepEqual(pairs.map((pair) => pair.corpus), ["explicit", "explicit"]);
    assert.equal(pairs[0].source.relativePath, "clips/b-source.wav");
    assert.equal(pairs[0].result.relativePath, "clips/b-result.wav");
    await assert.rejects(
      () => resolveExplicitCorpusPairs(
        root,
        Array.from(
          { length: MAX_EXPLICIT_PAIRS + 1 },
          (_, index) => `clips/a-source.wav|clips/a-result.wav|audition-${index}`,
        ),
      ),
      /at most/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit pairs reject malformed, duplicate, non-WAV, and escaping inputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vo-explicit-pairs-invalid-"));
  try {
    const source = path.join(root, "clips/source.wav");
    const result = path.join(root, "clips/result.wav");
    const notWav = path.join(root, "clips/result.mp3");
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, new Uint8Array());
    await writeFile(result, new Uint8Array());
    await writeFile(notWav, new Uint8Array());

    await assert.rejects(
      () => resolveExplicitCorpusPairs(root, ["clips/source.wav|clips/result.wav"]),
      /source\|result\|id/i,
    );
    await assert.rejects(
      () => resolveExplicitCorpusPairs(root, [
        "clips/source.wav|clips/result.wav|same-id",
        "clips/source.wav|clips/result.wav|same-id",
      ]),
      /duplicate/i,
    );
    await assert.rejects(
      () => resolveExplicitCorpusPairs(root, ["clips/source.wav|clips/result.mp3|not-wav"]),
      /\.wav/i,
    );
    await assert.rejects(
      () => resolveExplicitCorpusPairs(root, ["../outside.wav|clips/result.wav|escape"]),
      /inside the repository/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger output is required to stay under the ignored render-evidence tree", () => {
  const root = path.resolve("C:/repo");
  assert.equal(
    resolveLedgerOutputPath(root, "tasks/render-evidence/current-goal/voice-ledger.json"),
    path.resolve(root, "tasks/render-evidence/current-goal/voice-ledger.json"),
  );
  assert.throws(
    () => resolveLedgerOutputPath(root, "tasks/voice-ledger.json"),
    /tasks[\\/]render-evidence/i,
  );
  assert.throws(
    () => resolveLedgerOutputPath(root, "tasks/render-evidence/current-goal/voice-ledger.txt"),
    /\.json/i,
  );
});

test("ledger output rejects a junction or symlink that redirects its parent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vo-ledger-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "vo-ledger-outside-"));
  try {
    const evidenceRoot = path.join(root, "tasks", "render-evidence");
    await mkdir(evidenceRoot, { recursive: true });
    await symlink(outside, path.join(evidenceRoot, "redirect"), process.platform === "win32" ? "junction" : "dir");

    await assert.rejects(
      () => prepareLedgerOutputPath(root, "tasks/render-evidence/redirect/voice-ledger.json"),
      /junction|symbolic link|reparse/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
