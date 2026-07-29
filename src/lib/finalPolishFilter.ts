import {
  PLANNER_DELIVERY_MAX_MAKEUP_DB,
  type SourceRelativeFinalTone,
} from "./plannerDelivery.ts";

export const FINAL_POLISH_LIMITER_FILTER =
  "alimiter=limit=-2dB:level=disabled:latency=1";

export type FinalPolishFilterOptions = Readonly<{
  sourceSafe: boolean;
  makeupGainDb?: number;
}>;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

/**
 * Build the deliberately linear final delivery pass.
 *
 * Earlier render stages own cleanup, voicing, and time-varying dynamics. This
 * pass applies only measured source-relative body/HF reconciliation plus one
 * file-wide planner makeup scalar, then the latency-compensated delivery
 * limiter. It never replays the primary tone profile.
 */
export const buildFinalPolishFilter = (
  tone: SourceRelativeFinalTone | null,
  options: FinalPolishFilterOptions,
): string => {
  if (options.sourceSafe) return FINAL_POLISH_LIMITER_FILTER;

  const filters: string[] = [];
  const bodyPreservationTiltDb = tone
    ? clamp(finiteOr(tone.bodyPreservationTiltDb, 0), -0.75, 0)
    : 0;
  if (bodyPreservationTiltDb < -0.005) {
    filters.push(
      `highshelf=f=950:width_type=q:width=0.7:g=${bodyPreservationTiltDb.toFixed(2)}`,
    );
  }
  const fourKhzTrimDb = tone ? clamp(finiteOr(tone.fourKhzTrimDb, 0), -0.7, 0) : 0;
  const eightKhzTrimDb = tone ? clamp(finiteOr(tone.eightKhzTrimDb, 0), -0.9, 0) : 0;
  const topOctaveTrimDb = tone ? clamp(finiteOr(tone.topOctaveTrimDb, 0), -2, 0) : 0;
  if (fourKhzTrimDb < -0.005) {
    filters.push(`equalizer=f=4000:width_type=q:width=1.0:g=${fourKhzTrimDb.toFixed(2)}`);
  }
  if (eightKhzTrimDb < -0.005) {
    filters.push(`equalizer=f=8000:width_type=q:width=0.9:g=${eightKhzTrimDb.toFixed(2)}`);
  }
  if (topOctaveTrimDb < -0.005) {
    filters.push(`highshelf=f=8000:width_type=q:width=0.7:g=${topOctaveTrimDb.toFixed(2)}`);
  }

  const makeupGainDb = clamp(
    finiteOr(options.makeupGainDb ?? 0, 0),
    0,
    PLANNER_DELIVERY_MAX_MAKEUP_DB,
  );
  if (makeupGainDb > 0.005) {
    filters.push(`volume=${makeupGainDb.toFixed(3)}dB`);
  }

  filters.push(FINAL_POLISH_LIMITER_FILTER);
  return filters.join(",");
};
