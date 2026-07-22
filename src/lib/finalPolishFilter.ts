import { SPECTRUM_BANDS_HZ } from "./spectrum.ts";

export const FINAL_POLISH_LIMITER_FILTER = "alimiter=limit=-2dB:level=disabled";

export type FinalPolishProfile = Readonly<{
  lowMidGainDb: number;
  presenceGainDb: number;
  airGainDb: number;
  emotionalHarshnessCutDb: number;
  topEndHarshnessCutDb: number;
  toneMatchDeltaDb: readonly number[] | null;
  cinematicColorEnabled: boolean;
  emotionProtection: number;
}>;

export type FinalPolishFilterOptions = Readonly<{
  eqCleanupEnabled: boolean;
  softenHarshnessEnabled: boolean;
  sourceSafe: boolean;
}>;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

const buildToneMatchFilters = (toneMatchDeltaDb: readonly number[] | null): string[] => {
  if (!toneMatchDeltaDb || toneMatchDeltaDb.length !== SPECTRUM_BANDS_HZ.length) return [];

  return toneMatchDeltaDb
    .map((gainDb, index) => ({
      gainDb: finiteOr(gainDb, 0),
      hz: SPECTRUM_BANDS_HZ[index],
    }))
    .filter(({ gainDb }) => Math.abs(gainDb) >= 0.6)
    .sort((left, right) => Math.abs(right.gainDb) - Math.abs(left.gainDb))
    .slice(0, 3)
    .map(({ gainDb, hz }) => {
      const widthQ = hz <= 250 || hz >= 4000 ? 0.9 : 1.1;
      return `equalizer=f=${hz}:width_type=q:width=${widthQ}:g=${clamp(gainDb, -3, 3).toFixed(2)}`;
    });
};

/**
 * Build the deliberately linear final delivery pass.
 *
 * Earlier render stages own cleanup and time-varying dynamics. This pass only
 * applies the already-scaled static tone profile, then a single delivery
 * limiter. Source-safe and unprofiled renders remain limiter-only.
 */
export const buildFinalPolishFilter = (
  profile: FinalPolishProfile | null,
  options: FinalPolishFilterOptions,
): string => {
  if (!profile || options.sourceSafe) return FINAL_POLISH_LIMITER_FILTER;

  const filters: string[] = [];

  if (options.eqCleanupEnabled) {
    const lowMidGainDb = clamp(finiteOr(profile.lowMidGainDb, 0), -1.35, 0.65);
    filters.push(`equalizer=f=250:width_type=q:width=1.0:g=${lowMidGainDb.toFixed(2)}`);
  }

  const basePresenceCut = options.softenHarshnessEnabled ? -2 : 0;
  const baseAirCut = options.softenHarshnessEnabled ? -1.1 : 0;
  const emotionalHarshnessCutDb = clamp(finiteOr(profile.emotionalHarshnessCutDb, 0), 0, 1.15);
  const topEndHarshnessCutDb = clamp(finiteOr(profile.topEndHarshnessCutDb, 0), 0, 0.85);
  const netPresenceGain = clamp(
    basePresenceCut + finiteOr(profile.presenceGainDb, 0) - emotionalHarshnessCutDb,
    -4,
    0.7,
  );
  const netAirGain = clamp(baseAirCut + finiteOr(profile.airGainDb, 0) - topEndHarshnessCutDb, -2.7, 0.45);

  if (Math.abs(netPresenceGain) >= 0.2) {
    filters.push(`equalizer=f=3500:width_type=q:width=1.15:g=${netPresenceGain.toFixed(2)}`);
  }
  if (Math.abs(netAirGain) >= 0.2) {
    filters.push(`equalizer=f=8000:width_type=q:width=0.75:g=${netAirGain.toFixed(2)}`);
  }
  if (topEndHarshnessCutDb >= 0.45) {
    const topShelfCutDb = clamp(-0.35 - topEndHarshnessCutDb * 0.55, -1.1, -0.35);
    filters.push(`equalizer=f=11200:width_type=q:width=0.7:g=${topShelfCutDb.toFixed(2)}`);
  }

  filters.push(...buildToneMatchFilters(profile.toneMatchDeltaDb));

  if (profile.cinematicColorEnabled && finiteOr(profile.emotionProtection, 0) < 0.5) {
    filters.push("equalizer=f=180:width_type=q:width=1.1:g=0.8");
    filters.push("equalizer=f=4500:width_type=q:width=1.2:g=0.6");
    filters.push("equalizer=f=10000:width_type=q:width=0.7:g=-0.5");
  }

  filters.push(FINAL_POLISH_LIMITER_FILTER);
  return filters.join(",");
};
