import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessTamerDelivery,
  type FrameMetrics,
  type SpikeGroup,
} from "./diagRenderedSpikes.mts";

const processingGrownGroup = (): SpikeGroup => ({
  startFrame: 4,
  endFrame: 5,
  frame: 4,
  peakDb: -4,
  rmsDb: -12,
  bodyDb: -20,
  peakOverBodyDb: 16,
  crestDb: 8,
  sourcePeakDb: -6,
  sourceRmsDb: -14,
  sourceBodyDb: -20.02,
  sourcePeakOverBodyDb: 14.02,
  sourceEvidenceLane: "strong",
  sourceMaxReductionDb: 2.5,
  contrastGrowthDb: 1.98,
  sourcePeakDeltaDb: 2,
});

const afterMetrics = (peakDb: number): FrameMetrics => ({
  peakDb: [-20, -20, -20, -20, peakDb, -20, -20, -20, -20],
  rmsDb: [-20, -20, -20, -20, -20, -20, -20, -20, -20],
  samplesPerFrame: 96,
});

describe("rendered-spike diagnostic safety verdict inputs", () => {
  it("keeps conservative boundary under-delivery advisory instead of treating it as failure", () => {
    const [assessment] = assessTamerDelivery(
      [processingGrownGroup()],
      afterMetrics(-4.01),
    );

    assert.equal(assessment.expectedReductionDb, 0.48);
    assert.ok(assessment.deliveredReductionDb < 0.02);
    assert.equal(assessment.conservativeBoundaryUnderDelivery, true);
    assert.equal(assessment.advisory, true);
    assert.equal(assessment.ownerCapViolation, false);
  });

  it("still identifies attenuation beyond the mapped owning-frame cap", () => {
    const [assessment] = assessTamerDelivery(
      [processingGrownGroup()],
      afterMetrics(-4.8),
    );

    assert.equal(assessment.ownerCapViolation, true);
  });
});
