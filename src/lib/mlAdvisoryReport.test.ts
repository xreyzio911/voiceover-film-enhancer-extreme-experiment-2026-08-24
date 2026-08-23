import assert from "node:assert/strict";
import test from "node:test";
import { buildMlAdvisoryReport } from "./mlAdvisoryReport.ts";

test("ML advisory reports cannot block delivery or change gain", () => {
  const report = buildMlAdvisoryReport({
    modelIds: ["speechonnxmetrics", "speakeronnx"],
    metrics: [
      { id: "dnsmos.ovrl", value: 3.8, higherIsBetter: true, available: true },
      { id: "speaker.cosine", value: Number.NaN, higherIsBetter: true, available: true },
    ],
    notes: ["Exact WAV audition remains required."],
  });

  assert.equal(report.advisoryOnly, true);
  assert.equal(report.blocksDelivery, false);
  assert.equal(report.changesGainDb, false);
  assert.deepEqual(report.modelIds, ["speechonnxmetrics", "speakeronnx"]);
  assert.deepEqual(report.metrics.map((metric) => metric.available), [true, false]);
});
