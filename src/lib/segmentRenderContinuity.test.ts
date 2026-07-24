import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveSegmentRenderWindow } from "./segmentRenderContinuity.ts";

const SAMPLE_RATE = 48_000;

describe("resolveSegmentRenderWindow", () => {
  it("feeds every noninitial fixed segment one second of real source history without exporting it", () => {
    const window = resolveSegmentRenderWindow({
      sourceDurationSec: 200,
      sampleRate: SAMPLE_RATE,
      segmentStartSec: 75,
      segmentEndSec: 150,
      isInitialSegment: false,
      stateHistorySec: 1,
      outputOverlapSec: 0.02,
    });

    assert.equal(window.readStartSec, 74);
    assert.equal(window.readEndSec, 150.02);
    assert.equal(window.readDurationSec, 76.02);
    assert.equal(window.trimStartSec, 1);
    assert.equal(window.trimEndSec, 76.02);
    assert.equal(window.outputStartSec, 75);
    assert.equal(window.outputEndSec, 150.02);
    assert.equal(window.outputDurationSec, 75.02);
    assert.equal(window.historyDurationSec, 1);
    assert.equal(window.outputSampleCount, 75.02 * SAMPLE_RATE);
  });

  it("preserves larger existing context and trailing lookahead while trimming both from output", () => {
    const window = resolveSegmentRenderWindow({
      sourceDurationSec: 120,
      sampleRate: SAMPLE_RATE,
      segmentStartSec: 60,
      segmentEndSec: 90,
      isInitialSegment: false,
      stateHistorySec: 1,
      leadingContextSec: 1.4,
      trailingContextSec: 0.4,
      outputOverlapSec: 0.02,
      trimPadSec: 0.015,
    });

    assert.equal(window.readStartSec, 58.6);
    assert.equal(window.readEndSec, 90.42);
    assert.equal(window.outputStartSec, 60.015);
    assert.equal(window.outputEndSec, 90.005);
    assert.equal(window.outputDurationSec, 29.99);
    assert.equal(window.historyDurationSec, 1.415);
    assert.equal(window.trailingContextDurationSec, 0.415);
    assert.equal(window.trimStartSec, 1.415);
    assert.equal(window.trimEndSec, 31.405);
  });

  it("extends short existing context only enough to provide the requested state history", () => {
    const window = resolveSegmentRenderWindow({
      sourceDurationSec: 120,
      sampleRate: SAMPLE_RATE,
      segmentStartSec: 60,
      segmentEndSec: 90,
      isInitialSegment: false,
      stateHistorySec: 1,
      leadingContextSec: 0.35,
      trailingContextSec: 0.4,
      outputOverlapSec: 0.02,
      trimPadSec: 0.015,
    });

    assert.equal(window.readStartSec, 59.015);
    assert.equal(window.outputStartSec - window.readStartSec, 1);
    assert.equal(window.outputDurationSec, 29.99);
  });

  it("uses all available source history near zero and never reads outside physical bounds", () => {
    const window = resolveSegmentRenderWindow({
      sourceDurationSec: 2,
      sampleRate: SAMPLE_RATE,
      segmentStartSec: 0.4,
      segmentEndSec: 1.4,
      isInitialSegment: false,
      stateHistorySec: 1,
      trailingContextSec: 1,
      outputOverlapSec: 0.02,
    });

    assert.equal(window.readStartSec, 0);
    assert.equal(window.historyDurationSec, 0.4);
    assert.equal(window.readEndSec, 2);
    assert.equal(window.outputEndSec, 1.42);
    assert.equal(window.trailingContextDurationSec, 0.58);
  });

  it("does not invent history before the initial segment but keeps its explicit context", () => {
    const window = resolveSegmentRenderWindow({
      sourceDurationSec: 30,
      sampleRate: SAMPLE_RATE,
      segmentStartSec: 10,
      segmentEndSec: 20,
      isInitialSegment: true,
      stateHistorySec: 1,
      leadingContextSec: 0.25,
    });

    assert.equal(window.readStartSec, 9.75);
    assert.equal(window.historyDurationSec, 0.25);
    assert.equal(window.outputDurationSec, 10);
  });

  it("keeps the final segment exact and omits crossfade overlap at the physical tail", () => {
    const window = resolveSegmentRenderWindow({
      sourceDurationSec: 155.25,
      sampleRate: SAMPLE_RATE,
      segmentStartSec: 150,
      segmentEndSec: 155.25,
      isInitialSegment: false,
      stateHistorySec: 1,
    });

    assert.equal(window.readStartSec, 149);
    assert.equal(window.readEndSec, 155.25);
    assert.equal(window.trimStartSec, 1);
    assert.equal(window.trimEndSec, 6.25);
    assert.equal(window.outputDurationSec, 5.25);
    assert.equal(window.outputEndSample, Math.round(155.25 * SAMPLE_RATE));
  });

  it("preserves the exact source timeline after every output overlap is consumed", () => {
    const durationSec = 155.25;
    const boundaries = [
      [0, 75, true, 0.02],
      [75, 150, false, 0.02],
      [150, durationSec, false, 0],
    ] as const;
    const windows = boundaries.map(([start, end, initial, overlap]) =>
      resolveSegmentRenderWindow({
        sourceDurationSec: durationSec,
        sampleRate: SAMPLE_RATE,
        segmentStartSec: start,
        segmentEndSec: end,
        isInitialSegment: initial,
        stateHistorySec: 1,
        outputOverlapSec: overlap,
      }),
    );
    const concatenatedSamples =
      windows.reduce((sum, window) => sum + window.outputSampleCount, 0)
      - Math.round(0.04 * SAMPLE_RATE);

    assert.equal(concatenatedSamples, Math.round(durationSec * SAMPLE_RATE));
  });

  it("moves continuously at sample precision when a segment boundary moves", () => {
    const base = resolveSegmentRenderWindow({
      sourceDurationSec: 200,
      sampleRate: SAMPLE_RATE,
      segmentStartSec: 75,
      segmentEndSec: 150,
      isInitialSegment: false,
      stateHistorySec: 1,
      outputOverlapSec: 0.02,
    });
    const shifted = resolveSegmentRenderWindow({
      sourceDurationSec: 200,
      sampleRate: SAMPLE_RATE,
      segmentStartSec: 75.001,
      segmentEndSec: 150.001,
      isInitialSegment: false,
      stateHistorySec: 1,
      outputOverlapSec: 0.02,
    });

    assert.equal(shifted.readStartSample - base.readStartSample, 48);
    assert.equal(shifted.outputStartSample - base.outputStartSample, 48);
    assert.equal(shifted.outputEndSample - base.outputEndSample, 48);
    assert.equal(shifted.outputSampleCount, base.outputSampleCount);
    assert.equal(shifted.trimStartSample, base.trimStartSample);
  });

  it("does not mutate caller input and returns an immutable result", () => {
    const input = Object.freeze({
      sourceDurationSec: 30,
      sampleRate: SAMPLE_RATE,
      segmentStartSec: 10,
      segmentEndSec: 20,
      isInitialSegment: false,
      stateHistorySec: 1,
      outputOverlapSec: 0.02,
    });
    const before = { ...input };

    const window = resolveSegmentRenderWindow(input);

    assert.deepEqual(input, before);
    assert.equal(Object.isFrozen(window), true);
    assert.throws(
      () => Object.assign(window, { readStartSec: 0 }),
      /read only|readonly|extensible|assign/i,
    );
  });

  it("rejects invalid timeline inputs as programming errors", () => {
    const valid = {
      sourceDurationSec: 30,
      sampleRate: SAMPLE_RATE,
      segmentStartSec: 10,
      segmentEndSec: 20,
      isInitialSegment: false,
    } as const;

    assert.throws(
      () => resolveSegmentRenderWindow({ ...valid, sourceDurationSec: Number.NaN }),
      /sourceDurationSec must be finite/i,
    );
    assert.throws(
      () => resolveSegmentRenderWindow({ ...valid, stateHistorySec: -1 }),
      /stateHistorySec must be non-negative/i,
    );
    assert.throws(
      () => resolveSegmentRenderWindow({ ...valid, sampleRate: 48_000.5 }),
      /sampleRate must be a positive integer/i,
    );
    assert.throws(
      () => resolveSegmentRenderWindow({ ...valid, segmentEndSec: 10 }),
      /segmentEndSec must resolve after segmentStartSec/i,
    );
    assert.throws(
      () => resolveSegmentRenderWindow({ ...valid, trimPadSec: 5 }),
      /trimPadSec must leave at least one source sample/i,
    );
  });
});
