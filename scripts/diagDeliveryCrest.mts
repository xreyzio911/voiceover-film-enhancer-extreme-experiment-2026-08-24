/**
 * Read-only calibration ledger for expressive delivery-crest evidence.
 *
 * Measures the same P95 activity-frame peak and median activity plateau used
 * by the delivery planner across repo-local source WAVs. It never renders or
 * writes audio.
 *
 * Usage: node --experimental-strip-types scripts/diagDeliveryCrest.mts
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildSpeechMask, percentile } from "../src/lib/audioQc.ts";
import { frameDbFromFloatSamples } from "../src/lib/audibilityDropout.ts";
import { measurePlannerDeliverySafetyEvidence } from "../src/lib/plannerDelivery.ts";
import { decodeWav } from "../src/lib/webAudioRender.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE_DIR = path.join(ROOT, "audio testing");
const FRAME_MS = 10;

const downmixToMono = (
  samples: Float32Array,
  channels: number,
) => {
  if (channels === 1) return samples;
  const frameCount = Math.floor(samples.length / channels);
  const mono = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += samples[frame * channels + channel] ?? 0;
    }
    mono[frame] = sum / channels;
  }
  return mono;
};

type CrestRow = Readonly<{
  file: string;
  durationSec: number;
  activityPeakDb: number;
  activityPlateauDb: number;
  crestProminenceDb: number;
}>;

const rows: CrestRow[] = [];
const files = readdirSync(SOURCE_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right));

for (const file of files) {
  try {
    const decoded = decodeWav(readFileSync(path.join(SOURCE_DIR, file)));
    const mono = downmixToMono(decoded.samples, decoded.channels);
    const frameDb = frameDbFromFloatSamples(mono, decoded.sampleRate, FRAME_MS);
    const noiseFloorDb = percentile(frameDb, 20) ?? -72;
    const activityMask = buildSpeechMask(frameDb, noiseFloorDb, {
      frameMs: FRAME_MS,
    });
    const evidence = measurePlannerDeliverySafetyEvidence(
      mono,
      decoded.sampleRate,
      activityMask,
      FRAME_MS,
    );
    if (
      evidence.activityPeakDb === null ||
      evidence.activityPeakDb === undefined ||
      evidence.activityPlateauDb === null ||
      evidence.activityPlateauDb === undefined
    ) {
      console.log(`SKIP ${file}: insufficient activity evidence`);
      continue;
    }
    rows.push({
      file,
      durationSec: mono.length / decoded.sampleRate,
      activityPeakDb: evidence.activityPeakDb,
      activityPlateauDb: evidence.activityPlateauDb,
      crestProminenceDb:
        evidence.activityPeakDb - evidence.activityPlateauDb,
    });
  } catch (error) {
    console.log(`SKIP ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

rows.sort((left, right) =>
  left.crestProminenceDb - right.crestProminenceDb ||
  left.file.localeCompare(right.file),
);
for (const row of rows) {
  console.log(
    `${row.crestProminenceDb.toFixed(2)} dB | peak ${row.activityPeakDb.toFixed(2)} | plateau ${row.activityPlateauDb.toFixed(2)} | ${row.durationSec.toFixed(1)} s | ${row.file}`,
  );
}

const prominence = rows.map((row) => row.crestProminenceDb);
console.log(
  `SUMMARY files=${rows.length} p10=${(percentile(prominence, 10) ?? 0).toFixed(2)} p25=${(percentile(prominence, 25) ?? 0).toFixed(2)} p50=${(percentile(prominence, 50) ?? 0).toFixed(2)} p75=${(percentile(prominence, 75) ?? 0).toFixed(2)} p90=${(percentile(prominence, 90) ?? 0).toFixed(2)} p95=${(percentile(prominence, 95) ?? 0).toFixed(2)}`,
);
