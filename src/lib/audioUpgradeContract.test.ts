import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const voLevelerSource = readFileSync(new URL("../components/VoLeveler.tsx", import.meta.url), "utf8");

const sourceBetween = (startMarker: string, endMarker: string) => {
  const start = voLevelerSource.indexOf(startMarker);
  const end = voLevelerSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker after ${startMarker}: ${endMarker}`);
  return voLevelerSource.slice(start, end);
};

test("final app polish uses the isolated linear filter instead of rerunning the mix chain", () => {
  const finalPolishBlock = sourceBetween(
    "const runFinalAppPolishPass = async",
    "const analyzeIntegratedLoudness = async",
  );

  assert.match(finalPolishBlock, /buildFinalPolishFilter\(/);
  assert.match(finalPolishBlock, /"-af",\s*finalPolishFilter/);
  assert.match(finalPolishBlock, /"Linear final app polish"/);
  assert.doesNotMatch(finalPolishBlock, /runMixReady\(/);
});

test("speech-only tone selection reuses the analyzer's p25 activity floor without changing QC", () => {
  const envelopeBlock = sourceBetween(
    "const computeEnvelopeMetrics = (samples: Float32Array)",
    "const parseSilencedetectSpans =",
  );

  assert.match(envelopeBlock, /const activityNoiseFloorDb = percentile\(frameDb, 25\) \?\? -72/);
  assert.match(envelopeBlock, /buildSpeechMask\(frameDb, activityNoiseFloorDb/);
  assert.match(envelopeBlock, /sibilanceScore = computeSibilanceScore\(bandSpectrumDb\)/);
});
