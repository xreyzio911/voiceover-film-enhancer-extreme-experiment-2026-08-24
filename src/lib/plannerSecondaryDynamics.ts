export type PlannerSecondaryDynamicsEvidence = Readonly<{
  baseMaxGainFactor: number;
  speechDutyCyclePct: number | null;
  speechSegmentCount: number | null;
}>;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const smoothstep = (value: number) => {
  const bounded = clamp01(value);
  return bounded * bounded * (3 - 2 * bounded);
};

const finiteOrNull = (value: number | null) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Resolve the maximum lift available to dynaudnorm after the speech-aware
 * planner has already applied its source-relative gain curve.
 *
 * Duty cycle and run count are complementary evidence: a short dense sentence
 * can legitimately have one run, while a long sparse reel can still contain
 * enough independent runs to estimate dynamics safely. Combining their smooth
 * confidence curves avoids a binary "sparse" switch and tapers the possible
 * lift to a subtle range only when both signals are weak.
 */
export const resolvePlannerSecondaryMaxGainFactor = ({
  baseMaxGainFactor,
  speechDutyCyclePct,
  speechSegmentCount,
}: PlannerSecondaryDynamicsEvidence) => {
  const safeBaseFactor =
    Number.isFinite(baseMaxGainFactor) && baseMaxGainFactor > 1 ? baseMaxGainFactor : 1;
  const dutyCycle = finiteOrNull(speechDutyCyclePct);
  const segmentCount = finiteOrNull(speechSegmentCount);
  if (dutyCycle === null && segmentCount === null) return safeBaseFactor;

  const dutyConfidence = dutyCycle === null ? null : smoothstep(dutyCycle / 30);
  const runConfidence = segmentCount === null ? null : smoothstep(segmentCount / 12);
  const evidenceConfidence =
    dutyConfidence === null
      ? runConfidence ?? 1
      : runConfidence === null
        ? dutyConfidence
        : 1 - (1 - dutyConfidence) * (1 - runConfidence);

  const baseBoostDb = 20 * Math.log10(safeBaseFactor);
  const sparseBoostDb = Math.min(1.5, baseBoostDb);
  const resolvedBoostDb =
    sparseBoostDb + (baseBoostDb - sparseBoostDb) * clamp01(evidenceConfidence);
  return Math.min(safeBaseFactor, 10 ** (resolvedBoostDb / 20));
};
