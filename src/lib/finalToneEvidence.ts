import { buildSpeechMask, percentile } from "./audioQc.ts";
import { frameDbFromFloatSamples } from "./audibilityDropout.ts";
import { computeLogBandSpectrumDb } from "./spectrum.ts";

export const NATIVE_FINAL_TONE_BANDS_HZ = [
  250,
  500,
  1000,
  2000,
  4000,
  8000,
  12000,
] as const;

const NATIVE_FINAL_TONE_MIN_SAMPLE_RATE = 32_000;
const NATIVE_FINAL_TONE_FRAME_MS = 10;

/**
 * Measure the missing top octave in the decoded delivery domain.
 *
 * This reuses the established speech mask, performs no classification, and
 * fails open when the decode cannot represent 12 kHz cleanly. The compact
 * 16 kHz evidence remains authoritative for planner makeup and the existing
 * 4/8 kHz reconciliation.
 */
export const measureNativeFinalToneSpectrumDb = (
  samples: Float32Array,
  sampleRate: number,
): number[] | null => {
  if (
    samples.length === 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate < NATIVE_FINAL_TONE_MIN_SAMPLE_RATE
  ) {
    return null;
  }

  try {
    const frameDb = frameDbFromFloatSamples(
      samples,
      sampleRate,
      NATIVE_FINAL_TONE_FRAME_MS,
    );
    if (frameDb.length < 20) return null;
    const noiseFloorDb = percentile(frameDb, 25) ?? -72;
    const activityMask = buildSpeechMask(frameDb, noiseFloorDb, {
      frameMs: NATIVE_FINAL_TONE_FRAME_MS,
    });
    if (!activityMask.some(Boolean)) return null;

    const spectrumDb = computeLogBandSpectrumDb(samples, sampleRate, {
      bands: NATIVE_FINAL_TONE_BANDS_HZ,
      activityMask,
      activityFrameMs: NATIVE_FINAL_TONE_FRAME_MS,
    });
    return spectrumDb.length === NATIVE_FINAL_TONE_BANDS_HZ.length &&
      spectrumDb.every(Number.isFinite)
      ? spectrumDb
      : null;
  } catch {
    return null;
  }
};
