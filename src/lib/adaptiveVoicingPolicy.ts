export type AdaptiveVoicingPolicyInput = {
  cinematicColorRequested: boolean;
  /**
   * Formerly the early-reflection "Scene blend" control. The experiment keeps
   * the intent as a smaller, dry-safe spectral fit and never synthesizes delay.
   */
  sceneFitRequested: boolean;
  drynessScore: number;
  roomScore: number;
  echoScore: number;
  analysisConfidence: number;
  emotionProtection: number;
  profileLowMidGainDb: number;
  profilePresenceGainDb: number;
  profileAirGainDb: number;
  toneMatchDeltaDb: readonly number[] | null;
};

export type AdaptiveVoicingDecision = {
  warmthGainDb: number;
  presenceGainDb: number;
  airGainDb: number;
  colorAuthority: number;
  sceneFitAuthority: number;
  /**
   * Retained explicitly so callers cannot accidentally revive the legacy
   * delayed-reflection path while adapting this policy.
   */
  syntheticReflectionIndoorGain: 0;
  syntheticReflectionOutdoorGain: 0;
  syntheticReflectionIndoorDelayMs: 0;
  syntheticReflectionOutdoorDelayMs: 0;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
const clamp01 = (value: number) => clamp(value, 0, 1);

const toneMoveAt = (moves: readonly number[] | null, index: number) => {
  const value = moves?.[index];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const sameDirectionDamping = (profileMoveDb: number, toneMoveDb: number) => {
  const pressure = Math.max(0, profileMoveDb) / 0.75 + Math.max(0, toneMoveDb) / 0.75;
  return 1 / (1 + pressure);
};

export const resolveAdaptiveVoicingPolicy = (
  input: AdaptiveVoicingPolicyInput,
): AdaptiveVoicingDecision => {
  const dryness = clamp01(input.drynessScore);
  const room = clamp01(input.roomScore);
  const echo = clamp01(input.echoScore);
  const confidence = clamp01(input.analysisConfidence);
  const emotion = clamp01(input.emotionProtection);

  // Moderate neutral sources have the most room for a tiny house voicing.
  // Already-dry sources keep most of their native tone, while room and echo
  // evidence can only reduce authority.
  const neutralSourceFit = clamp01(1 - Math.abs(dryness - 0.66) / 0.72);
  const sourceNeed = 0.24 + neutralSourceFit * 0.36;
  const roomPreservation = Math.pow(1 - room, 1.35) * Math.pow(1 - echo, 1.5);
  const confidenceAuthority = 0.18 + confidence * 0.82;
  const emotionPreservation = 1 - emotion * 0.55;
  const sourceAuthority =
    sourceNeed * roomPreservation * confidenceAuthority * emotionPreservation;

  const cinematicAuthority = input.cinematicColorRequested ? sourceAuthority : 0;
  const sceneFitAuthority = input.sceneFitRequested ? sourceAuthority * 0.32 : 0;
  const colorAuthority = clamp01(cinematicAuthority + sceneFitAuthority);

  const warmToneMove = Math.max(toneMoveAt(input.toneMatchDeltaDb, 1), toneMoveAt(input.toneMatchDeltaDb, 2));
  const presenceToneMove = Math.max(
    toneMoveAt(input.toneMatchDeltaDb, 5),
    toneMoveAt(input.toneMatchDeltaDb, 6),
  );
  const airCutToneMove = Math.max(
    -toneMoveAt(input.toneMatchDeltaDb, 6),
    -toneMoveAt(input.toneMatchDeltaDb, 7),
  );

  const warmthDamping = sameDirectionDamping(input.profileLowMidGainDb, warmToneMove);
  const presenceDamping = sameDirectionDamping(input.profilePresenceGainDb, presenceToneMove);
  const airDamping = sameDirectionDamping(-input.profileAirGainDb, airCutToneMove);

  return {
    warmthGainDb: clamp(0.34 * colorAuthority * warmthDamping, 0, 0.34),
    presenceGainDb: clamp(0.24 * colorAuthority * presenceDamping, 0, 0.24),
    airGainDb: colorAuthority === 0 ? 0 : clamp(-0.18 * colorAuthority * airDamping, -0.18, 0),
    colorAuthority,
    sceneFitAuthority,
    syntheticReflectionIndoorGain: 0,
    syntheticReflectionOutdoorGain: 0,
    syntheticReflectionIndoorDelayMs: 0,
    syntheticReflectionOutdoorDelayMs: 0,
  };
};
