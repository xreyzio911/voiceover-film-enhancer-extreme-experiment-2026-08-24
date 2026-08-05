/**
 * Speech-aware gain planner.
 *
 * Produces a per-frame linear gain curve that:
 *  - brings every speech run to a common target RMS (kills sentence-to-sentence jumps),
 *  - gently rides intra-sentence swing with a slew-limited curve (no pumping),
 *  - ducks silences below a noise-risk-driven expander depth (no noise lift),
 *  - guards peaks so the downstream limiter never has to clamp hard (no spikes).
 *
 * This replaces ffmpeg's blind `dynaudnorm` for the core leveling role.
 * Pure JS so it is fully testable in Node and reusable on any Float32Array.
 */

export type SpeechRun = {
  /** inclusive start frame index (10ms-per-frame convention) */
  startFrame: number;
  /** exclusive end frame index */
  endFrame: number;
};

export type GainPlannerInput = {
  /** 10ms-frame RMS in dB (e.g. from analyzeFloatSamples envelope). */
  frameDb: number[];
  /**
   * Optional same-length 3.5-7.4 kHz envelope. This is edge evidence only:
   * it may attach immediately contiguous consonant frames to an existing
   * speech run, but it never creates a speech run by itself.
   */
  fricativeFrameDb?: number[];
  /** Independently measured floor for fricativeFrameDb. */
  fricativeNoiseFloorDb?: number;
  /**
   * Optional same-length perceptual loudness envelope. Target/gain math can
   * use this, but raw frameDb stays authoritative for masks, peaks, crest,
   * and body-relative spike guards whose thresholds were tuned in raw RMS.
   */
  loudnessFrameDb?: number[];
  /**
   * Optional same-length 180-3000 Hz speech-body envelope. Embedded-event
   * recovery uses this narrower evidence so LF impacts or bright consonants
   * cannot withdraw gain from a steady voiced body.
   */
  speechBodyFrameDb?: number[];
  /** Speech runs (frame index ranges) already detected by the analyzer. */
  speechRuns: SpeechRun[];
  /** Noise floor of the source in dB (pauseNoiseFloorDb). */
  noiseFloorDb: number;
  /** Speech-vs-noise boundary (speechThresholdDb). */
  speechThresholdDb: number;
  /** 0..1 pause noise risk — drives expander depth. */
  pauseNoiseRisk: number;
  /** Frame duration in ms. Defaults to 10. */
  frameMs?: number;
  /** Target integrated RMS dB for speech runs. Defaults to -22 dBFS RMS (maps roughly to -24 LKFS). */
  targetDb?: number;
  /**
   * How much the planner may follow the source's typical speech RMS when
   * choosing its target. 0 = fixed house target, 1 = source target.
   */
  sourceTargetBlend?: number;
  /** Max gain applied to a single run, in dB. Defaults to +14. */
  maxGainDb?: number;
  /** Max attenuation applied to a single run, in dB. Defaults to -14. */
  minGainDb?: number;
  /** Optional Float32 samples + sampleRate. If supplied, peak-guard pass simulates the applied gain. */
  samples?: Float32Array;
  sampleRate?: number;
  coldOpenLiftToleranceDb?: number;
  coldOpenLiftMaxDb?: number;
  /** Ceiling in dBFS for samples after gain is applied (limiter has margin beyond this). Default -4. */
  peakCeilingDb?: number;
  /**
   * 0..1 signal describing how unstable the source is (frame-to-frame RMS
   * deltas inside speech + line swing). On CLEAN takes we want almost no
   * micro-ride so sentences come out glass-flat; on MESSY takes we want the
   * full ±1.5 dB correction. Defaults to 0.5 (midpoint) when unknown.
   */
  instabilityHint?: number;
  /**
   * 0..1 strength for the uniform residual correction of a whole body-speech
   * run that remains materially hot after planning. This does not authorize
   * source-blind localized attenuation inside a word.
   */
  speechSpikeTaming?: number;
  /**
   * 0..1 authority for equalizing normal body-speech runs. Lower values
   * retain more source line-to-line contrast; very quiet speech continuously
   * earns back enough authority for audibility. Defaults to 1.
   */
  levelingConsistency?: number;
};

/**
 * How a detected speech run is treated by the planner.
 *
 * - `body-speech`: normal dialogue. Targeted to the batch level, full
 *   micro-ride, peak guard at the usual ceiling.
 * - `transient-breath`: a short, high-crest run — a character gasp, laugh,
 *   grunt, or similar onomatopoeic performance beat. Targeted a little
 *   below dialogue so the breath SITS WITH the character rather than
 *   poking above, tight gain clamp (no big swings), no micro-ride (too
 *   short to ride).
 * - `edge-fragment`: too short to process (< 100 ms). Left at body target
 *   unclamped but gets no special handling — too little data to plan on.
 */
export type SpeechRunClass = "body-speech" | "transient-breath" | "edge-fragment";

export type GainPlannerOutput = {
  /** One linear gain per frame. Length = frameDb.length. */
  gainCurve: Float32Array;
  /** Per-run diagnostic info. */
  runs: Array<{
    startFrame: number;
    endFrame: number;
    meanDb: number;
    crestDb: number;
    plannedGainDb: number;
    peakReducedDb: number;
    runClass: SpeechRunClass;
    /** Continuous body-plus-periodicity authority used only by transient attenuation recovery. */
    bodyOwnershipAuthority: number;
    /** Attenuation withdrawn from the legacy transient plan; always 0..3.2 dB. */
    transientBodyRecoveryDb: number;
    /** Source emphasis retained only by periodic, body-owned transient speech. */
    transientRetainedAdvantageDb: number;
  }>;
  /** Computed expander depth in dB used for silences. */
  expanderDepthDb: number;
  /** Target RMS dB that all speech runs were aimed at. */
  targetDb: number;
  /** Effective micro-ride amplitude in dB (peak-to-peak / 2). Diagnostic. */
  microRideDb: number;
  /** Count of runs classified as transient-breath. Diagnostic. */
  breathRunCount: number;
  /** Legacy localized-planner diagnostic; retained for telemetry compatibility and now always zero. */
  speechSpikeFrameCount: number;
  /** Legacy localized-planner diagnostic; retained for telemetry compatibility and now always zero. */
  speechSpikeMaxReductionDb: number;
  /** Count of sustained-loud clusters (onomatopoeia / yells) tamed inside body-speech runs. */
  sustainedLoudClusterCount: number;
  /** Largest uniform attenuation applied to a sustained-loud cluster in dB. Diagnostic. */
  sustainedLoudMaxReductionDb: number;
  /** Count of early dialogue runs capped against later dialogue body. */
  earlyRunCapCount: number;
  /** Largest early-dialogue cap in dB. Diagnostic. */
  earlyRunMaxReductionDb: number;
  /** Count of early dialogue runs lifted toward later dialogue body. */
  coldOpenLiftCount: number;
  /** Largest cold-open lift in dB. Diagnostic. */
  coldOpenLiftMaxDb: number;
  /** Count of body-speech runs whose soft post-run tail stayed at speech gain. */
  tailRescueRunCount: number;
  /** Total number of post-run frames held at speech gain for soft spoken tails. */
  tailRescueFrameCount: number;
  /** Longest soft-tail rescue in milliseconds. */
  tailRescueMaxMs: number;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothUnitRamp = (value: number, start: number, full: number) => {
  const t = clamp((value - start) / Math.max(1e-9, full - start), 0, 1);
  return t * t * (3 - 2 * t);
};
const softLimitNegativePlannerGainDb = (gainDb: number, limitDb: number) => {
  if (!Number.isFinite(gainDb)) return 0;
  if (gainDb >= 0) return gainDb;
  const safeLimitDb = Math.max(0.1, Math.abs(limitDb));
  return -safeLimitDb * Math.tanh(-gainDb / safeLimitDb);
};
const dbToLin = (db: number) => Math.pow(10, db / 20);
const COLD_OPEN_WINDOW_MS = 2500;
const COLD_OPEN_RUN_COUNT = 3;
const COLD_OPEN_TRANSIENT_CREST_DB = 15;
const COLD_OPEN_TRANSIENT_PEAK_OVER_TARGET_DB = 8;
const COLD_OPEN_LIFT_TOLERANCE_DB = 1.5;
const COLD_OPEN_LIFT_MAX_DB = 5;
const RUN_ONSET_BACKTRACK_MS = 60;
const COLD_OPEN_ATTACK_LEAD_MS = 40;
// A detector-negative pre-roll may contain the recording bed, so it can borrow
// only a small amount of positive body gain. Any additional lift is eased into
// the evidence-backed run at a speech-rate time scale instead of arriving as
// an 80 ms +10..15 dB handoff.
const POSITIVE_ATTACK_ENTRY_GAIN_DB = 4;
const POSITIVE_ATTACK_FRICATIVE_ENTRY_BONUS_DB = 1.25;
const POSITIVE_ATTACK_EXCESS_SLEW_DB_PER_100_MS = 4;
const FRICATIVE_BAND_LOW_HZ = 3500;
const FRICATIVE_BAND_HIGH_HZ = 7400;
const SPEECH_BODY_BAND_LOW_HZ = 180;
const SPEECH_BODY_BAND_HIGH_HZ = 3000;
const FRICATIVE_EVIDENCE_MARGIN_DB = 10;
const FRICATIVE_TAIL_RESCUE_MAX_MS = 240;
const SOFT_TAIL_RESCUE_MAX_MS = 500;
const SOFT_TAIL_RESCUE_NOISY_MAX_MS = 240;
const SOFT_TAIL_RESCUE_NOISY_RISK = 0.55;
const SOFT_TAIL_RESCUE_MIN_ACTIVE_MS = 10;
const SOFT_TAIL_RESCUE_BRIDGE_MS = 40;
const SOFT_TAIL_RESCUE_NOISE_MARGIN_DB = 8;
const SOFT_TAIL_RESCUE_SPEECH_MARGIN_DB = 14;
const SOFT_TAIL_RESCUE_BODY_DROP_DB = 18;
const SOFT_TAIL_RESCUE_HARD_NOISE_MARGIN_DB = 4;
const QUIET_BODY_FLOOR_OFFSET_DB = 2.4;
const QUIET_BODY_FLOOR_LOUDNESS_OFFSET_DB = 1.0;
const QUIET_BODY_FLOOR_MAX_LIFT_DB = 3.5;
const QUIET_BODY_FLOOR_HIGH_CREST_DB = 20;
const QUIET_BODY_FLOOR_EXTREME_CREST_DB = 24;
// The audibility return is deliberately logistic: every source level has a
// continuous response, while body speech around 18 dB below target begins to
// recover most of the consistency deliberately withheld for actor contrast.
const BODY_LEVELING_AUDIBILITY_CENTER_BELOW_TARGET_DB = 18;
const BODY_LEVELING_AUDIBILITY_WIDTH_DB = 2.5;
// Phrase-scale gain may legitimately exceed 6 dB on extremely uneven takes.
// This budget applies only to additional time-local peak/residual decisions so
// a narrow detector response cannot stack into a broadband hole.
const LOCAL_PLANNER_DIP_SOFT_LIMIT_DB = 6;
const BODY_SPIKE_MAX_RUN_LOSS_DB = 10;
const BODY_SPIKE_RUN_FLOOR_OFFSET_DB = 9;
// Absolute peak safety is useful, but its frame-wide envelope must not turn a
// sample peak into a broadband body hole. The delivery limiter still owns the
// remaining sample-level excess.
const BODY_SPIKE_MAX_CREATED_ENVELOPE_LOSS_DB = 0.6;
// A short/high-crest word can share the transient class without being a
// breath. Explicit speech-body power may continuously withdraw only the
// class's 3.2 dB under-target bias; it never adds gain above the source.
const TRANSIENT_BODY_RECOVERY_MAX_DB = 3.2;
const TRANSIENT_BODY_RETAINED_ADVANTAGE_FRACTION = 0.6;
const TRANSIENT_BODY_RETAINED_ADVANTAGE_MAX_DB = 2.5;
const TRANSIENT_BODY_SHARE_AUTHORITY_EXPONENT = 1.1;
const TRANSIENT_VOICING_ANALYSIS_RATE_HZ = 8_000;
const TRANSIENT_VOICING_WINDOW_MS = 30;
const TRANSIENT_VOICING_HOP_MS = 10;
const TRANSIENT_VOICING_MIN_PITCH_HZ = 80;
const TRANSIENT_VOICING_MAX_PITCH_HZ = 400;
const TRANSIENT_VOICING_CONFIDENCE_KNEE = 0.42;
const RENDERED_CONSONANT_FRAME_MS = 10;
/** Evidence resolution required to separate adjacent source-relative consonant events. */
export const RENDERED_CONSONANT_SOURCE_FRAME_MS = 2;
const RENDERED_CONSONANT_LOCAL_WINDOW_MS = 280;
const RENDERED_CONSONANT_ALLOWED_PEAK_OVER_BODY_DB = 15.5;
const RENDERED_CONSONANT_ABSOLUTE_PEAK_DB = -6.5;
const RENDERED_CONSONANT_MIN_TARGET_PEAK_DB = -12.5;
const RENDERED_CONSONANT_MAX_REDUCTION_DB = 7.5;
const RENDERED_CONSONANT_DIP_RADIUS_MS = 14;
// Small alignment/resampling variance belongs to the native event. Authority
// begins continuously only beyond this margin; there is no minimum output cut.
const RENDERED_CONSONANT_SOURCE_ALLOWED_GROWTH_DB = 1.5;
// The final source-relative stage is a residual polish, not another dynamics
// processor. A 2.5 dB cut over a 2 ms owner is visible and can sound like the
// exact down-up instability this stage is meant to prevent. Keep the evidence
// response continuous, but bound even fully supported repairs to a subtle
// 1.5 dB touch.
const RENDERED_CONSONANT_SOURCE_MAX_REDUCTION_DB = 1.5;
// A single 2 ms full-band owner can sound like a volume dropout even when its
// source-relative decision is correct. Deeper repair needs adjacent evidence;
// an isolated owner remains a subtle touch rather than a down-up notch.
const RENDERED_CONSONANT_ISOLATED_OWNER_MAX_REDUCTION_DB = 0.6;
const RENDERED_CONSONANT_ADJACENT_SUPPORT_SCALE = 0.4;
const RENDERED_CONSONANT_REFERENCE_MATCH_WINDOW_MS = 20;
const RENDERED_CONSONANT_REFERENCE_ALIGNMENT_MAX_MS = 120;
const RENDERED_CONSONANT_REFERENCE_MIN_CONFIDENCE = 0.5;
const RENDERED_CONSONANT_RENDERED_CONTRAST_START_DB = 8;
const RENDERED_CONSONANT_RENDERED_CREST_START_DB = 12;
const RENDERED_CONSONANT_SOURCE_CONTRAST_START_DB = 4;
const RENDERED_CONSONANT_SOURCE_CONTRAST_WEAK_DB = 8;
const RENDERED_CONSONANT_SOURCE_CONTRAST_STRONG_START_DB = 10;
const RENDERED_CONSONANT_SOURCE_CONTRAST_FULL_DB = 12;
const RENDERED_CONSONANT_SOURCE_CREST_START_DB = 6;
const RENDERED_CONSONANT_SOURCE_CREST_WEAK_DB = 12;
const RENDERED_CONSONANT_SOURCE_CREST_STRONG_START_DB = 16;
const RENDERED_CONSONANT_SOURCE_CREST_FULL_DB = 18;
const RENDERED_CONSONANT_WEAK_BANDWIDTH_START_RATIO = 0.75;
const RENDERED_CONSONANT_FULL_BANDWIDTH_RATIO = 0.9;
const RENDERED_CONSONANT_AUDIBILITY_PEAK_START_DB = -24;
const RENDERED_CONSONANT_AUDIBILITY_RMS_START_DB = -80;
const PLANNER_ENVELOPE_FLOOR_PERCENTILE = 25;
const PLANNER_ANALYSIS_FLOOR_HEADROOM_DB = 20;
const PLANNER_ACTIVE_RELIABILITY_CENTER_DB = -100;
const PLANNER_ACTIVE_RELIABILITY_SOFTNESS_DB = 6;
const PLANNER_RECORDING_BED_LOW_PERCENTILE = 10;
const PLANNER_RECORDING_BED_UPPER_PERCENTILE = 90;
const PLANNER_RECORDING_BED_CONTRAST_KNEE_DB = 4;
const PLANNER_RECORDING_BED_COVERAGE_KNEE = 0.15;
const PLANNER_RECORDING_BED_LOW_MODE_WIDTH_DB = 6;
const PLANNER_RECORDING_BED_PERSISTENCE_WINDOW_FRAMES = 101;
const PLANNER_RECORDING_BED_PERSISTENCE_KNEE = 0.25;
const K_WEIGHT_STAGE1_HIGH_SHELF_HZ = 1681.974450955533;
const K_WEIGHT_STAGE1_GAIN_DB = 4;
const K_WEIGHT_STAGE2_HIGH_PASS_HZ = 38.13547087602444;
const K_WEIGHT_STAGE2_Q = 0.5;
const BODY_GAIN_VALLEY_INNER_SHOULDER_MS = 60;
const BODY_GAIN_VALLEY_OUTER_SHOULDER_MS = 140;
const BODY_GAIN_VALLEY_RELAXATION_BLEND = 0.7;
const EMBEDDED_PERFORMANCE_CONTEXT_MS = 240;
const EMBEDDED_PERFORMANCE_CONTEXT_LENDING = 0.25;
const EMBEDDED_PERFORMANCE_SPECTRAL_OFFSET_SOFT_LIMIT_DB = 4;
const EMBEDDED_PERFORMANCE_GAIN_KNEE_DB = 0.35;
const EMBEDDED_PERFORMANCE_GAIN_AUTHORITY_KNEE_DB = 6;
const EMBEDDED_PERFORMANCE_RECOVERY_HEADROOM_DB = 0.5;
const DECRESCENDO_TREND_WINDOW_MS = 100;
const DECRESCENDO_MAX_RESIDUAL_LIFT_DB = 3.2;
const DECRESCENDO_ORDINARY_FADE_CENTER_DB = 9;
const DECRESCENDO_FADE_SOFTNESS_DB = 4;
const DECRESCENDO_MIN_RECOVERY_FRACTION = 0.12;
const DECRESCENDO_MAX_RECOVERY_FRACTION = 0.28;
const DECRESCENDO_RESIDUAL_KNEE_DB = 0.18;
const RECURRENT_BODY_VALLEY_INNER_SHOULDER_MS = 90;
const RECURRENT_BODY_VALLEY_OUTER_SHOULDER_MS = 240;
const RECURRENT_BODY_VALLEY_CENTER_MS = 40;
const RECURRENT_BODY_VALLEY_FILL_FRACTION = 0.6;
const RECURRENT_BODY_VALLEY_MAX_LIFT_DB = 4;
const RECURRENT_BODY_VALLEY_EVIDENCE_KNEE_DB = 0.5;
// A 300 ms center follows word-scale body rather than individual pitch cycles.
// The upper-body percentile is deliberately below the expressive tail: quiet
// words move toward the ordinary dialogue plateau, not toward the hottest line.
const WORD_SCALE_BODY_WINDOW_MS = 300;
const WORD_SCALE_BODY_REFERENCE_PERCENTILE = 70;
const WORD_SCALE_BODY_RECOVERY_FRACTION = 0.62;
const WORD_SCALE_BODY_MAX_LIFT_DB = 4.5;
const WORD_SCALE_BODY_EVIDENCE_KNEE_DB = 0.6;
const WORD_SCALE_BODY_LONG_UNIT_START_MS = 1_000;
const WORD_SCALE_BODY_LONG_UNIT_FULL_MS = 1_800;
// Leave a small Float32/linear-conversion margin under the 0.3 dB contract.
const BODY_DYNAMICS_MAX_GAIN_STEP_DB = 0.295;
const DENSE_BODY_PEAK_RELAXATION_CURVE = 24;

/**
 * Relax millisecond-scale attenuation caps without widening their ownership.
 *
 * The fixed triangular average keeps a five-frame consonant plateau intact,
 * but continuously reduces isolated or very short cap peaks. Raising the
 * normalized temporal support to the fourth power is the minimum measured
 * curve that removes the audible down-up shape from one- and two-frame
 * plateaus while retaining the center of sustained events. Taking the minimum
 * with the original cap makes this strictly non-additive: a native
 * zero-authority frame stays exactly zero and no frame can receive more
 * attenuation than its source-relative evidence already authorized.
 *
 * The first and last two file frames are preserved because they have no
 * symmetric context. Chunked delivery supplies overlap context, so this
 * exception applies only to the true file edges.
 */
export const relaxNarrowConsonantOwnerCaps = (
  ownerCapsDb: Float32Array,
  requestedReductionDbByFrame?: Float32Array,
): Float32Array => {
  const relaxedCapsDb = new Float32Array(ownerCapsDb);
  if (ownerCapsDb.length < 5) return relaxedCapsDb;
  const evidenceDbByFrame =
    requestedReductionDbByFrame?.length === ownerCapsDb.length
      ? requestedReductionDbByFrame
      : ownerCapsDb;

  const weights = [1, 2, 3, 2, 1] as const;
  const weightSum = 9;
  for (let frame = 2; frame + 2 < ownerCapsDb.length; frame += 1) {
    const originalCapDb = ownerCapsDb[frame];
    if (!(originalCapDb > 0) || !Number.isFinite(originalCapDb)) {
      relaxedCapsDb[frame] = 0;
      continue;
    }
    let weightedCapDb = 0;
    for (let offset = -2; offset <= 2; offset += 1) {
      const neighborCapDb = ownerCapsDb[frame + offset];
      if (Number.isFinite(neighborCapDb) && neighborCapDb > 0) {
        weightedCapDb += neighborCapDb * weights[offset + 2];
      }
    }
    const temporalSupportRatio = clamp(
      weightedCapDb / (weightSum * originalCapDb),
      0,
      1,
    );
    const durationSupportedCapDb =
      originalCapDb * (temporalSupportRatio ** 4);
    relaxedCapsDb[frame] = Math.min(
      originalCapDb,
      durationSupportedCapDb,
    );
  }

  const bridgeReconciledCapsDb = new Float32Array(relaxedCapsDb);
  for (let frame = 1; frame + 1 < ownerCapsDb.length; frame += 1) {
    if (
      (evidenceDbByFrame[frame] ?? 0) > 0
      || (evidenceDbByFrame[frame - 1] ?? 0) <= 0
      || (evidenceDbByFrame[frame + 1] ?? 0) <= 0
    ) {
      continue;
    }
    bridgeReconciledCapsDb[frame] = Math.min(
      relaxedCapsDb[frame],
      Math.min(
        relaxedCapsDb[frame - 1],
        relaxedCapsDb[frame + 1],
      ) * RENDERED_CONSONANT_ADJACENT_SUPPORT_SCALE,
    );
  }
  return bridgeReconciledCapsDb;
};

type BiquadCoefficients = {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
};

const normalizeBiquad = (b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) => ({
  b0: b0 / a0,
  b1: b1 / a0,
  b2: b2 / a0,
  a1: a1 / a0,
  a2: a2 / a0,
});

const percentileDb = (values: number[], percent: number) => {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const index = clamp(Math.round((percent / 100) * (finite.length - 1)), 0, finite.length - 1);
  return finite[index];
};

const plannerActiveReliability = (db: number) =>
  1 /
  (1 +
    Math.pow(
      10,
      (PLANNER_ACTIVE_RELIABILITY_CENTER_DB - db) /
        PLANNER_ACTIVE_RELIABILITY_SOFTNESS_DB,
    ));

const weightedPercentileDb = (
  entries: ReadonlyArray<{ db: number; weight: number }>,
  percent: number,
) => {
  const sorted = entries
    .filter(({ db, weight }) => Number.isFinite(db) && Number.isFinite(weight) && weight > 0)
    .sort((a, b) => a.db - b.db);
  if (sorted.length === 0) return null;
  const totalWeight = sorted.reduce((sum, { weight }) => sum + weight, 0);
  const targetWeight = totalWeight * clamp(percent / 100, 0, 1);
  let cumulativeWeight = 0;
  for (const entry of sorted) {
    cumulativeWeight += entry.weight;
    if (cumulativeWeight >= targetWeight) return entry.db;
  }
  return sorted[sorted.length - 1].db;
};

const estimatePlannerRecordingBedEvidence = (frameDb: number[]) => {
  const weightedFrames = frameDb
    .filter(Number.isFinite)
    .map((db) => ({ db, weight: plannerActiveReliability(db) }));
  const frameCount = Math.max(1, weightedFrames.length);
  const activeCoverage =
    weightedFrames.reduce((sum, { weight }) => sum + weight, 0) / frameCount;
  const quietBedDb =
    weightedPercentileDb(weightedFrames, PLANNER_RECORDING_BED_LOW_PERCENTILE) ?? -110;
  const upperActiveDb =
    weightedPercentileDb(weightedFrames, PLANNER_RECORDING_BED_UPPER_PERCENTILE) ??
    quietBedDb;
  const contrastDb = Math.max(0, upperActiveDb - quietBedDb);
  const contrastPower = contrastDb * contrastDb;
  const contrastKneePower =
    PLANNER_RECORDING_BED_CONTRAST_KNEE_DB *
    PLANNER_RECORDING_BED_CONTRAST_KNEE_DB;
  const contrastAuthority =
    contrastPower / (contrastPower + contrastKneePower + Number.EPSILON);
  const coveragePower = activeCoverage ** 4;
  const coverageKneePower = PLANNER_RECORDING_BED_COVERAGE_KNEE ** 4;
  const coverageAuthority =
    coveragePower / (coveragePower + coverageKneePower + Number.EPSILON);
  const lowModeMembership = weightedFrames.map(({ db, weight }) => {
    const distance = (db - quietBedDb) / PLANNER_RECORDING_BED_LOW_MODE_WIDTH_DB;
    return weight * Math.exp(-(distance * distance));
  });
  const lowModePrefix = new Float64Array(lowModeMembership.length + 1);
  for (let index = 0; index < lowModeMembership.length; index += 1) {
    lowModePrefix[index + 1] = lowModePrefix[index] + lowModeMembership[index];
  }
  const persistenceRadiusFrames = Math.floor(
    PLANNER_RECORDING_BED_PERSISTENCE_WINDOW_FRAMES / 2,
  );
  let persistenceWeightedSum = 0;
  let persistenceWeight = 0;
  for (let index = 0; index < lowModeMembership.length; index += 1) {
    const startFrame = Math.max(0, index - persistenceRadiusFrames);
    const endFrame = Math.min(
      lowModeMembership.length,
      index + persistenceRadiusFrames + 1,
    );
    const localLowModeDensity =
      (lowModePrefix[endFrame] - lowModePrefix[startFrame]) /
      Math.max(1, endFrame - startFrame);
    persistenceWeightedSum += lowModeMembership[index] * localLowModeDensity;
    persistenceWeight += lowModeMembership[index];
  }
  const temporalPersistence =
    persistenceWeightedSum / (persistenceWeight + Number.EPSILON);
  const persistencePower = temporalPersistence ** 6;
  const persistenceKneePower = PLANNER_RECORDING_BED_PERSISTENCE_KNEE ** 6;
  const persistenceAuthority =
    persistencePower / (persistencePower + persistenceKneePower + Number.EPSILON);

  return {
    quietBedDb: clamp(quietBedDb, -110, -48),
    authority: contrastAuthority * coverageAuthority * persistenceAuthority,
  };
};

export const estimatePlannerEnvelopeNoiseFloorDb = (frameDb: number[]) => {
  const quietFloorDb = percentileDb(frameDb, PLANNER_ENVELOPE_FLOOR_PERCENTILE) ?? -70;
  return clamp(quietFloorDb, -110, -48);
};

export const resolvePlannerCalibration = (
  frameDb: number[],
  analysisNoiseFloorDb: number | null | undefined,
  analysisSpeechThresholdDb: number | null | undefined,
) => {
  const envelopeNoiseFloorDb = estimatePlannerEnvelopeNoiseFloorDb(frameDb);
  const suppliedNoiseFloorDb = Number.isFinite(analysisNoiseFloorDb)
    ? (analysisNoiseFloorDb as number)
    : envelopeNoiseFloorDb;
  const baselineNoiseFloorDb = Math.min(
    suppliedNoiseFloorDb,
    envelopeNoiseFloorDb + PLANNER_ANALYSIS_FLOOR_HEADROOM_DB,
  );
  const recordingBedEvidence = estimatePlannerRecordingBedEvidence(frameDb);
  const noiseFloorDb = clamp(
    baselineNoiseFloorDb +
      (recordingBedEvidence.quietBedDb - baselineNoiseFloorDb) *
        recordingBedEvidence.authority,
    -110,
    -48,
  );
  const baselineEnvelopeSpeechThresholdDb = clamp(
    baselineNoiseFloorDb + 11,
    -58,
    -24,
  );
  const suppliedSpeechThresholdDb = Number.isFinite(analysisSpeechThresholdDb)
    ? (analysisSpeechThresholdDb as number)
    : baselineEnvelopeSpeechThresholdDb;
  const permissiveSpeechThresholdDb = Math.min(
    suppliedSpeechThresholdDb,
    baselineEnvelopeSpeechThresholdDb,
  );
  const refinedEnvelopeSpeechThresholdDb = clamp(noiseFloorDb + 11, -58, -24);
  return {
    noiseFloorDb,
    speechThresholdDb:
      permissiveSpeechThresholdDb +
      (refinedEnvelopeSpeechThresholdDb - permissiveSpeechThresholdDb) *
        recordingBedEvidence.authority,
    envelopeNoiseFloorDb,
  };
};

const buildHighPassBiquad = (sampleRate: number, frequencyHz: number, q: number): BiquadCoefficients => {
  const w0 = (2 * Math.PI * frequencyHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = (1 + cosW0) / 2;
  const b1 = -(1 + cosW0);
  const b2 = (1 + cosW0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha;
  return normalizeBiquad(b0, b1, b2, a0, a1, a2);
};

const buildLowPassBiquad = (sampleRate: number, frequencyHz: number, q: number): BiquadCoefficients => {
  const w0 = (2 * Math.PI * frequencyHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = (1 - cosW0) / 2;
  const b1 = 1 - cosW0;
  const b2 = (1 - cosW0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha;
  return normalizeBiquad(b0, b1, b2, a0, a1, a2);
};

const buildHighShelfBiquad = (sampleRate: number, frequencyHz: number, gainDb: number): BiquadCoefficients => {
  const a = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * frequencyHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = (sinW0 / 2) * Math.SQRT2;
  const sqrtAAlpha2 = 2 * Math.sqrt(a) * alpha;
  const b0 = a * ((a + 1) + (a - 1) * cosW0 + sqrtAAlpha2);
  const b1 = -2 * a * ((a - 1) + (a + 1) * cosW0);
  const b2 = a * ((a + 1) + (a - 1) * cosW0 - sqrtAAlpha2);
  const a0 = (a + 1) - (a - 1) * cosW0 + sqrtAAlpha2;
  const a1 = 2 * ((a - 1) - (a + 1) * cosW0);
  const a2 = (a + 1) - (a - 1) * cosW0 - sqrtAAlpha2;
  return normalizeBiquad(b0, b1, b2, a0, a1, a2);
};

const applyBiquad = (samples: Float32Array, coeffs: BiquadCoefficients) => {
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const x0 = samples[i];
    const y0 = coeffs.b0 * x0 + coeffs.b1 * x1 + coeffs.b2 * x2 - coeffs.a1 * y1 - coeffs.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
};

export const applyKWeighting = (samples: Float32Array, sampleRate: number) => {
  if (!Number.isFinite(sampleRate) || sampleRate <= K_WEIGHT_STAGE1_HIGH_SHELF_HZ * 2) {
    return new Float32Array(samples);
  }
  const shelf = buildHighShelfBiquad(sampleRate, K_WEIGHT_STAGE1_HIGH_SHELF_HZ, K_WEIGHT_STAGE1_GAIN_DB);
  const highPass = buildHighPassBiquad(sampleRate, K_WEIGHT_STAGE2_HIGH_PASS_HZ, K_WEIGHT_STAGE2_Q);
  return applyBiquad(applyBiquad(samples, shelf), highPass);
};

/** Stream a two-pole-per-edge band-pass directly into frame RMS bins. */
const computeBandFrameDb = (
  samples: Float32Array,
  sampleRate: number,
  frameMs: number,
  lowFrequencyHz: number,
  highFrequencyHz: number,
): number[] => {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(frameMs) || frameMs <= 0) {
    return [];
  }

  const samplesPerFrame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frameCount = Math.floor(samples.length / samplesPerFrame);
  const frameDb = new Array<number>(frameCount).fill(-120);
  if (frameCount === 0) return frameDb;

  const upperFrequencyHz = Math.min(highFrequencyHz, sampleRate * 0.4625);
  if (upperFrequencyHz <= lowFrequencyHz * 1.05) return frameDb;

  const highPass = buildHighPassBiquad(sampleRate, lowFrequencyHz, Math.SQRT1_2);
  const lowPass = buildLowPassBiquad(sampleRate, upperFrequencyHz, Math.SQRT1_2);
  let hpX1 = 0;
  let hpX2 = 0;
  let hpY1 = 0;
  let hpY2 = 0;
  let lpX1 = 0;
  let lpX2 = 0;
  let lpY1 = 0;
  let lpY2 = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * samplesPerFrame;
    const end = start + samplesPerFrame;
    let sumPower = 0;
    for (let index = start; index < end; index += 1) {
      const inputSample = samples[index];
      const highPassed =
        highPass.b0 * inputSample +
        highPass.b1 * hpX1 +
        highPass.b2 * hpX2 -
        highPass.a1 * hpY1 -
        highPass.a2 * hpY2;
      hpX2 = hpX1;
      hpX1 = inputSample;
      hpY2 = hpY1;
      hpY1 = highPassed;

      const bandPassed =
        lowPass.b0 * highPassed +
        lowPass.b1 * lpX1 +
        lowPass.b2 * lpX2 -
        lowPass.a1 * lpY1 -
        lowPass.a2 * lpY2;
      lpX2 = lpX1;
      lpX1 = highPassed;
      lpY2 = lpY1;
      lpY1 = bandPassed;
      sumPower += bandPassed * bandPassed;
    }
    frameDb[frame] = 10 * Math.log10(sumPower / samplesPerFrame + 1e-30);
  }

  return frameDb;
};

/**
 * Measure a narrow high-frequency envelope for unvoiced consonant evidence.
 *
 * The result is edge evidence only: it may extend an existing speech run, but
 * it never creates a speech run or a quality decision by itself.
 */
export const computeFricativeFrameDb = (
  samples: Float32Array,
  sampleRate: number,
  frameMs = 10,
): number[] =>
  computeBandFrameDb(
    samples,
    sampleRate,
    frameMs,
    FRICATIVE_BAND_LOW_HZ,
    FRICATIVE_BAND_HIGH_HZ,
  );

/**
 * Measure the voiced speech-body band used only for embedded-event gain
 * ownership. This prevents energy outside the intelligible body from opening
 * a millisecond-scale recovery notch.
 */
export const computeSpeechBodyFrameDb = (
  samples: Float32Array,
  sampleRate: number,
  frameMs = 10,
): number[] =>
  computeBandFrameDb(
    samples,
    sampleRate,
    frameMs,
    SPEECH_BODY_BAND_LOW_HZ,
    SPEECH_BODY_BAND_HIGH_HZ,
  );

const rmsDbOfSlice = (
  frameDb: ArrayLike<number>,
  start: number,
  end: number,
): number => {
  const a = Math.max(0, start);
  const b = Math.min(frameDb.length, end);
  if (b <= a) return -120;
  // RMS-in-dB over a slice. Each frame is already 20*log10(rms).
  // We want 10*log10(mean(rms^2)) = 10*log10(mean(10^(frameDb/10))).
  let sumPower = 0;
  for (let i = a; i < b; i += 1) {
    sumPower += Math.pow(10, frameDb[i] / 10);
  }
  return 10 * Math.log10(sumPower / (b - a) + 1e-30);
};

const meanDbOfSlice = (
  frameDb: ArrayLike<number>,
  start: number,
  end: number,
): number => {
  const a = Math.max(0, start);
  const b = Math.min(frameDb.length, end);
  if (b <= a) return Number.NaN;
  let sumDb = 0;
  for (let frame = a; frame < b; frame += 1) {
    const value = frameDb[frame];
    if (!Number.isFinite(value)) return Number.NaN;
    sumDb += value;
  }
  return sumDb / (b - a);
};

/**
 * Continuously relax short processing-added output valleys inside body speech.
 *
 * A centered micro-ride can turn energy in nearby phonemes into a brief gain
 * notch at the current phoneme. Source plus gain is compared with the source
 * alone, so an intentional correction of a loud phoneme, an unchanged natural
 * dip, and a sustained or monotonic low passage all veto their own lift.
 * Independent left/right shoulder means also keep trends from looking like a
 * valley. There is no engagement threshold: even an arbitrarily shallow
 * processing-added valley gets an arbitrarily shallow correction. The
 * response is lift-only, and missing two-sided body context fails open so
 * attacks, releases, and run edges remain untouched.
 */
export const relaxNarrowBodySpeechGainValleys = (
  gainDbCurve: Float32Array,
  sourceFrameDb: ArrayLike<number>,
  bodySpeechRuns: readonly SpeechRun[],
  frameMs = 10,
): Float32Array => {
  const relaxedGainDbCurve = new Float32Array(gainDbCurve);
  if (sourceFrameDb.length !== gainDbCurve.length) return relaxedGainDbCurve;
  const effectiveFrameMs = Number.isFinite(frameMs) && frameMs > 0 ? frameMs : 10;
  const innerShoulderFrames = Math.max(
    1,
    Math.round(BODY_GAIN_VALLEY_INNER_SHOULDER_MS / effectiveFrameMs),
  );
  const outerShoulderFrames = Math.max(
    innerShoulderFrames,
    Math.round(BODY_GAIN_VALLEY_OUTER_SHOULDER_MS / effectiveFrameMs),
  );

  for (const run of bodySpeechRuns) {
    const startFrame = clamp(Math.trunc(run.startFrame), 0, gainDbCurve.length);
    const endFrame = clamp(Math.trunc(run.endFrame), startFrame, gainDbCurve.length);
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      if (
        frame - outerShoulderFrames < startFrame ||
        frame + outerShoulderFrames >= endFrame
      ) {
        continue;
      }

      let leftSourceShoulderSumDb = 0;
      let rightSourceShoulderSumDb = 0;
      let leftOutputShoulderSumDb = 0;
      let rightOutputShoulderSumDb = 0;
      let shoulderFrameCount = 0;
      let hasValidEvidence = Number.isFinite(sourceFrameDb[frame]) &&
        Number.isFinite(gainDbCurve[frame]);
      for (
        let offset = innerShoulderFrames;
        offset <= outerShoulderFrames;
        offset += 1
      ) {
        const leftFrame = frame - offset;
        const rightFrame = frame + offset;
        const leftSourceDb = sourceFrameDb[leftFrame];
        const rightSourceDb = sourceFrameDb[rightFrame];
        const leftGainDb = gainDbCurve[leftFrame];
        const rightGainDb = gainDbCurve[rightFrame];
        if (
          !Number.isFinite(leftSourceDb) ||
          !Number.isFinite(rightSourceDb) ||
          !Number.isFinite(leftGainDb) ||
          !Number.isFinite(rightGainDb)
        ) {
          hasValidEvidence = false;
          break;
        }
        leftSourceShoulderSumDb += leftSourceDb;
        rightSourceShoulderSumDb += rightSourceDb;
        leftOutputShoulderSumDb += leftSourceDb + leftGainDb;
        rightOutputShoulderSumDb += rightSourceDb + rightGainDb;
        shoulderFrameCount += 1;
      }
      if (!hasValidEvidence || shoulderFrameCount === 0) continue;

      const sourceShoulderDb = Math.min(
        leftSourceShoulderSumDb / shoulderFrameCount,
        rightSourceShoulderSumDb / shoulderFrameCount,
      );
      const outputShoulderDb = Math.min(
        leftOutputShoulderSumDb / shoulderFrameCount,
        rightOutputShoulderSumDb / shoulderFrameCount,
      );
      const sourceCenterDb = sourceFrameDb[frame];
      const originalGainDb = gainDbCurve[frame];
      const sourceConcavityDb = sourceShoulderDb - sourceCenterDb;
      const outputConcavityDb =
        outputShoulderDb - (sourceCenterDb + originalGainDb);
      const processingAddedConcavityDb =
        outputConcavityDb - sourceConcavityDb;
      const repairableConcavityDb = Math.max(
        0,
        Math.min(outputConcavityDb, processingAddedConcavityDb),
      );
      const proportionalLiftDb =
        repairableConcavityDb * BODY_GAIN_VALLEY_RELAXATION_BLEND;
      relaxedGainDbCurve[frame] = Math.max(
        relaxedGainDbCurve[frame],
        originalGainDb + proportionalLiftDb,
      );
    }
  }

  return relaxedGainDbCurve;
};

const softPositiveDb = (value: number, kneeDb: number) => {
  const scaled = value / Math.max(kneeDb, Number.EPSILON);
  if (scaled >= 40) return value;
  if (scaled <= -40) return kneeDb * Math.exp(scaled);
  return kneeDb * Math.log1p(Math.exp(scaled));
};

/**
 * Give an energetic event embedded in a broad body-speech run only the
 * positive gain it still needs to reach the dialogue target.
 *
 * Long edited regions can occasionally arrive as one speech run: a quiet
 * recorded bed sets the run gain while sparse laughs, calls, impacts, or
 * onomatopoeic voice events already carry their own level. A cosine-weighted
 * source envelope transfers ownership over roughly a phoneme/short-event
 * window, so the response cannot form a one-frame down/up notch. Soft-positive
 * recovery and excess curves make the mapping continuous at every level:
 * ordinary quiet voice retains its planned lift, an already-loud event tends
 * toward source gain, and no frame is ever attenuated below its native level.
 */
export const limitEmbeddedPerformancePositiveGainAuthority = (
  gainDbCurve: Float32Array,
  sourceFrameDb: ArrayLike<number>,
  bodySpeechRuns: readonly SpeechRun[],
  targetDb: number,
  frameMs = 10,
): Float32Array => {
  const limitedGainDbCurve = new Float32Array(gainDbCurve);
  if (sourceFrameDb.length !== gainDbCurve.length) return limitedGainDbCurve;
  const effectiveFrameMs = Number.isFinite(frameMs) && frameMs > 0 ? frameMs : 10;
  const contextRadiusFrames = Math.max(
    2,
    Math.round(EMBEDDED_PERFORMANCE_CONTEXT_MS / (2 * effectiveFrameMs)),
  );
  const sourcePower = new Float64Array(sourceFrameDb.length);
  for (let frame = 0; frame < sourceFrameDb.length; frame += 1) {
    const sourceDb = sourceFrameDb[frame];
    sourcePower[frame] = Number.isFinite(sourceDb)
      ? Math.pow(10, sourceDb / 10)
      : Number.NaN;
  }
  const contextWeights = new Float64Array(contextRadiusFrames * 2 + 1);
  for (
    let offset = -contextRadiusFrames;
    offset <= contextRadiusFrames;
    offset += 1
  ) {
    const normalizedOffset = Math.abs(offset) / (contextRadiusFrames + 1);
    contextWeights[offset + contextRadiusFrames] =
      Math.cos((normalizedOffset * Math.PI) / 2) ** 2;
  }

  for (const run of bodySpeechRuns) {
    const startFrame = clamp(Math.trunc(run.startFrame), 0, gainDbCurve.length);
    const endFrame = clamp(Math.trunc(run.endFrame), startFrame, gainDbCurve.length);
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const originalGainDb = gainDbCurve[frame];
      if (!Number.isFinite(originalGainDb)) continue;

      let weightedPower = 0;
      let totalWeight = 0;
      for (let offset = -contextRadiusFrames; offset <= contextRadiusFrames; offset += 1) {
        const sourceFrame = frame + offset;
        if (sourceFrame < startFrame || sourceFrame >= endFrame) continue;
        const framePower = sourcePower[sourceFrame];
        if (!Number.isFinite(framePower)) continue;
        const weight = contextWeights[offset + contextRadiusFrames];
        weightedPower += weight * framePower;
        totalWeight += weight;
      }
      if (totalWeight <= 0) continue;

      const localEventDb = 10 * Math.log10(weightedPower / totalWeight + 1e-30);
      const currentSourceDb = sourceFrameDb[frame];
      // Context establishes that an event exists, but the current frame keeps
      // most of the recovery decision. This prevents a future loud syllable
      // from pre-ducking its quiet voiced lead-in while still controlling the
      // loud syllable itself. The fixed blend is continuous at every source
      // level and leaves sustained events unchanged because current≈context.
      const frameSupportedEventDb =
        currentSourceDb +
        (localEventDb - currentSourceDb)
          * EMBEDDED_PERFORMANCE_CONTEXT_LENDING;
      const positiveGainDb = Math.max(0, originalGainDb);
      const negativeGainDb = Math.min(0, originalGainDb);
      const recoveryBudgetDb = softPositiveDb(
        targetDb
          + EMBEDDED_PERFORMANCE_RECOVERY_HEADROOM_DB
          - frameSupportedEventDb,
        EMBEDDED_PERFORMANCE_GAIN_KNEE_DB,
      );
      const unauthorizedPositiveGainDb = softPositiveDb(
        positiveGainDb - recoveryBudgetDb,
        EMBEDDED_PERFORMANCE_GAIN_KNEE_DB,
      );
      const positiveGainPower = positiveGainDb ** 4;
      const gainAuthorityKneePower =
        EMBEDDED_PERFORMANCE_GAIN_AUTHORITY_KNEE_DB ** 4;
      const broadRunAuthority =
        positiveGainPower /
        (positiveGainPower + gainAuthorityKneePower + Number.EPSILON);
      limitedGainDbCurve[frame] =
        negativeGainDb +
        Math.max(0, positiveGainDb - unauthorizedPositiveGainDb * broadRunAuthority);
    }
  }

  return limitedGainDbCurve;
};

/**
 * Add only the residual lift needed by a sustained, body-owned extreme trend.
 *
 * The run's source trend remains authoritative: ordinary actor fades receive
 * little or no additional ride, while an extreme monotonic rise or fall can
 * recover only a bounded fraction of its travel. Falling speech gets a smooth
 * tail lift; rising speech gets the mirrored head lift. Both are positive-only
 * so the balancer never creates a new attenuation event, and body evidence is
 * continuously damped as it approaches the recording floor.
 */
const balanceExtremeBodySpeechTrends = (
  gainDbCurve: Float32Array,
  speechBodyFrameDb: ArrayLike<number>,
  bodySpeechRuns: readonly SpeechRun[],
  noiseFloorDb: number,
  maxGainDb: number,
  frameMs = 10,
): Float32Array => {
  const recoveredGainDbCurve = new Float32Array(gainDbCurve);
  if (speechBodyFrameDb.length !== gainDbCurve.length) return recoveredGainDbCurve;

  const effectiveFrameMs = Number.isFinite(frameMs) && frameMs > 0 ? frameMs : 10;
  const preferredTrendWindowFrames = Math.max(
    1,
    Math.round(DECRESCENDO_TREND_WINDOW_MS / effectiveFrameMs),
  );
  const meanGainDb = (startFrame: number, endFrame: number) => {
    let sumDb = 0;
    let count = 0;
    for (
      let frame = Math.max(0, startFrame);
      frame < Math.min(gainDbCurve.length, endFrame);
      frame += 1
    ) {
      if (!Number.isFinite(gainDbCurve[frame])) continue;
      sumDb += gainDbCurve[frame];
      count += 1;
    }
    return count > 0 ? sumDb / count : 0;
  };

  for (const run of bodySpeechRuns) {
    const startFrame = clamp(Math.trunc(run.startFrame), 0, gainDbCurve.length);
    const endFrame = clamp(Math.trunc(run.endFrame), startFrame, gainDbCurve.length);
    const runFrames = endFrame - startFrame;
    if (runFrames < 2) continue;
    const trendWindowFrames = Math.max(
      1,
      Math.min(preferredTrendWindowFrames, Math.floor(runFrames / 4)),
    );

    const headCenterFrame = startFrame + Math.round(runFrames * 0.1);
    const tailCenterFrame = startFrame + Math.round(runFrames * 0.9);
    const halfTrendWindowFrames = Math.max(1, Math.floor(trendWindowFrames / 2));
    const headStartFrame = Math.max(startFrame, headCenterFrame - halfTrendWindowFrames);
    const headEndFrame = Math.min(endFrame, headCenterFrame + halfTrendWindowFrames + 1);
    const tailStartFrame = Math.max(startFrame, tailCenterFrame - halfTrendWindowFrames);
    const tailEndFrame = Math.min(endFrame, tailCenterFrame + halfTrendWindowFrames + 1);
    const headBodyDb = rmsDbOfSlice(
      speechBodyFrameDb,
      headStartFrame,
      headEndFrame,
    );
    const tailBodyDb = rmsDbOfSlice(
      speechBodyFrameDb,
      tailStartFrame,
      tailEndFrame,
    );
    if (!Number.isFinite(headBodyDb) || !Number.isFinite(tailBodyDb)) continue;

    const signedSourceTrendDb = tailBodyDb - headBodyDb;
    const sourceTrendDb = Math.max(
      0,
      softPositiveDb(
        Math.abs(signedSourceTrendDb),
        DECRESCENDO_RESIDUAL_KNEE_DB,
      ) - softPositiveDb(0, DECRESCENDO_RESIDUAL_KNEE_DB),
    );
    if (!(sourceTrendDb > 0)) continue;
    const rising = signedSourceTrendDb > 0;

    // Directionality is continuous. A clean monotonic decline approaches one;
    // a locally animated or rising delivery spends proportionally less of the
    // bounded recovery budget.
    const trendSampleCount = Math.max(4, Math.min(20, Math.floor(runFrames / trendWindowFrames)));
    let downwardTravelDb = 0;
    let upwardTravelDb = 0;
    let earlyDirectionalTravelDb = 0;
    let lateDirectionalTravelDb = 0;
    let previousTrendDb = Number.NaN;
    for (let sample = 0; sample < trendSampleCount; sample += 1) {
      const progress = trendSampleCount > 1 ? sample / (trendSampleCount - 1) : 0;
      const centerFrame = startFrame + Math.round(progress * Math.max(0, runFrames - 1));
      const localBodyDb = rmsDbOfSlice(
        speechBodyFrameDb,
        Math.max(startFrame, centerFrame - halfTrendWindowFrames),
        Math.min(endFrame, centerFrame + halfTrendWindowFrames + 1),
      );
      if (!Number.isFinite(localBodyDb)) continue;
      if (Number.isFinite(previousTrendDb)) {
        const deltaDb = previousTrendDb - localBodyDb;
        const downwardStepDb = Math.max(0, deltaDb);
        const upwardStepDb = Math.max(0, -deltaDb);
        downwardTravelDb += downwardStepDb;
        upwardTravelDb += upwardStepDb;
        const directionalStepDb = rising ? upwardStepDb : downwardStepDb;
        const intervalCenterProgress =
          trendSampleCount > 1
            ? (sample - 0.5) / (trendSampleCount - 1)
            : 0;
        if (intervalCenterProgress <= 0.5) {
          earlyDirectionalTravelDb += directionalStepDb;
        } else {
          lateDirectionalTravelDb += directionalStepDb;
        }
      }
      previousTrendDb = localBodyDb;
    }
    const travelDb = downwardTravelDb + upwardTravelDb;
    const directionalTravelDb = rising ? upwardTravelDb : downwardTravelDb;
    const directionAuthority =
      directionalTravelDb / (travelDb + DECRESCENDO_RESIDUAL_KNEE_DB);
    // A phrase-wide correction requires directionally consistent travel in
    // both halves of the run. A localized onset or terminal fade can still
    // look monotonic at the endpoints, but it has near-zero distributed
    // coverage and therefore keeps the actor's source-shaped edge intact.
    const directionalCoverageAuthority = clamp(
      (2 * Math.min(earlyDirectionalTravelDb, lateDirectionalTravelDb)) /
        (earlyDirectionalTravelDb + lateDirectionalTravelDb +
          DECRESCENDO_RESIDUAL_KNEE_DB),
      0,
      1,
    );
    const spendAuthority = directionAuthority * directionalCoverageAuthority;
    const trendAuthority =
      0.5 +
      0.5 *
        Math.tanh(
          (sourceTrendDb - DECRESCENDO_ORDINARY_FADE_CENTER_DB) /
            DECRESCENDO_FADE_SOFTNESS_DB,
        );
    const recoveryFraction =
      (DECRESCENDO_MIN_RECOVERY_FRACTION +
        (DECRESCENDO_MAX_RECOVERY_FRACTION -
          DECRESCENDO_MIN_RECOVERY_FRACTION) *
          trendAuthority) *
      spendAuthority;
    const desiredRecoveryDb = Math.min(
      sourceTrendDb * recoveryFraction,
      sourceTrendDb * DECRESCENDO_MAX_RECOVERY_FRACTION,
    );
    const headGainDb = meanGainDb(headStartFrame, headEndFrame);
    const tailGainDb = meanGainDb(tailStartFrame, tailEndFrame);
    const currentRecoveryDb = rising
      ? headGainDb - tailGainDb
      : tailGainDb - headGainDb;
    const residualRecoveryDb = Math.min(
      DECRESCENDO_MAX_RESIDUAL_LIFT_DB,
      softPositiveDb(
        desiredRecoveryDb - currentRecoveryDb,
        DECRESCENDO_RESIDUAL_KNEE_DB,
      ) * spendAuthority,
    );
    if (!(residualRecoveryDb > 0)) continue;

    const headProgress = (headCenterFrame - startFrame) / Math.max(1, runFrames - 1);
    const tailProgress = (tailCenterFrame - startFrame) / Math.max(1, runFrames - 1);
    const headShape = smoothUnitRamp(headProgress, 0, 1);
    const tailShape = smoothUnitRamp(tailProgress, 0, 1);
    const shapeDifference = Math.max(0.1, tailShape - headShape);
    const fullLiftDb = Math.min(
      DECRESCENDO_MAX_RESIDUAL_LIFT_DB,
      residualRecoveryDb / shapeDifference,
    );

    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const bodyDb = speechBodyFrameDb[frame];
      if (!Number.isFinite(bodyDb)) continue;
      const runProgress = (frame - startFrame) / Math.max(1, runFrames - 1);
      const trendShape = smoothUnitRamp(runProgress, 0, 1);
      const shape = rising ? 1 - trendShape : trendShape;
      const floorMarginDb = bodyDb - (noiseFloorDb + 8);
      const evidenceAuthority = 1 / (1 + Math.exp(-floorMarginDb / 4));
      const liftDb = fullLiftDb * shape * evidenceAuthority;
      recoveredGainDbCurve[frame] = Math.min(
        maxGainDb,
        gainDbCurve[frame] + Math.max(0, liftDb),
      );
    }
  }

  return recoveredGainDbCurve;
};

/**
 * Partially fill recurrent, short, body-owned source valleys without treating
 * a sustained quiet passage as a defect. Both the voiced-body and broadband
 * envelopes must form the same two-sided concavity, which prevents bright
 * consonants and LF impacts from borrowing body authority. A run-level
 * evidence density supplies continuous recurrence confidence, and the lift
 * envelope is widened only enough to keep its control motion below 0.3 dB per
 * 10 ms. Missing or inconsistent evidence returns a distinct unchanged copy.
 */
export const recoverRecurrentBodySpeechValleys = (
  gainDbCurve: Float32Array,
  sourceFrameDb: ArrayLike<number>,
  speechBodyFrameDb: ArrayLike<number>,
  bodySpeechRuns: readonly SpeechRun[],
  maxGainDb: number,
  frameMs = 10,
): Float32Array => {
  const recoveredGainDbCurve = new Float32Array(gainDbCurve);
  if (
    sourceFrameDb.length !== gainDbCurve.length ||
    speechBodyFrameDb.length !== gainDbCurve.length ||
    !Number.isFinite(frameMs) ||
    frameMs <= 0 ||
    !Number.isFinite(maxGainDb)
  ) {
    return recoveredGainDbCurve;
  }
  for (let frame = 0; frame < gainDbCurve.length; frame += 1) {
    if (
      !Number.isFinite(gainDbCurve[frame]) ||
      !Number.isFinite(sourceFrameDb[frame]) ||
      !Number.isFinite(speechBodyFrameDb[frame])
    ) {
      return recoveredGainDbCurve;
    }
  }

  const innerShoulderFrames = Math.max(
    1,
    Math.round(RECURRENT_BODY_VALLEY_INNER_SHOULDER_MS / frameMs),
  );
  const outerShoulderFrames = Math.max(
    innerShoulderFrames + 1,
    Math.round(RECURRENT_BODY_VALLEY_OUTER_SHOULDER_MS / frameMs),
  );
  const centerHalfFrames = Math.max(
    1,
    Math.round(RECURRENT_BODY_VALLEY_CENTER_MS / (2 * frameMs)),
  );

  for (const run of bodySpeechRuns) {
    const startFrame = clamp(Math.trunc(run.startFrame), 0, gainDbCurve.length);
    const endFrame = clamp(Math.trunc(run.endFrame), startFrame, gainDbCurve.length);
    if (endFrame - startFrame <= outerShoulderFrames * 2) continue;

    const requestedLiftDb = new Float32Array(endFrame - startFrame);
    let evidenceWeight = 0;
    for (
      let frame = startFrame + outerShoulderFrames;
      frame < endFrame - outerShoulderFrames;
      frame += 1
    ) {
      const bodyCenterDb = meanDbOfSlice(
        speechBodyFrameDb,
        frame - centerHalfFrames,
        frame + centerHalfFrames + 1,
      );
      const sourceCenterDb = meanDbOfSlice(
        sourceFrameDb,
        frame - centerHalfFrames,
        frame + centerHalfFrames + 1,
      );
      const bodyShoulderDb = Math.min(
        meanDbOfSlice(
          speechBodyFrameDb,
          frame - outerShoulderFrames,
          frame - innerShoulderFrames,
        ),
        meanDbOfSlice(
          speechBodyFrameDb,
          frame + innerShoulderFrames + 1,
          frame + outerShoulderFrames + 1,
        ),
      );
      const sourceShoulderDb = Math.min(
        meanDbOfSlice(
          sourceFrameDb,
          frame - outerShoulderFrames,
          frame - innerShoulderFrames,
        ),
        meanDbOfSlice(
          sourceFrameDb,
          frame + innerShoulderFrames + 1,
          frame + outerShoulderFrames + 1,
        ),
      );
      if (
        !Number.isFinite(bodyCenterDb) ||
        !Number.isFinite(sourceCenterDb) ||
        !Number.isFinite(bodyShoulderDb) ||
        !Number.isFinite(sourceShoulderDb)
      ) {
        continue;
      }

      const alignedConcavityDb = Math.min(
        bodyShoulderDb - bodyCenterDb,
        sourceShoulderDb - sourceCenterDb,
      );
      const continuousConcavityDb = Math.max(
        0,
        softPositiveDb(
          alignedConcavityDb,
          RECURRENT_BODY_VALLEY_EVIDENCE_KNEE_DB,
        ) - softPositiveDb(0, RECURRENT_BODY_VALLEY_EVIDENCE_KNEE_DB),
      );
      evidenceWeight += smoothUnitRamp(continuousConcavityDb, 0.75, 6);
      requestedLiftDb[frame - startFrame] = Math.min(
        RECURRENT_BODY_VALLEY_MAX_LIFT_DB,
        continuousConcavityDb * RECURRENT_BODY_VALLEY_FILL_FRACTION,
      );
    }

    const runFrames = endFrame - startFrame;
    const recurrenceAuthority =
      evidenceWeight / (evidenceWeight + runFrames * 0.04 + Number.EPSILON);
    for (let index = 0; index < requestedLiftDb.length; index += 1) {
      requestedLiftDb[index] *= recurrenceAuthority;
    }

    // Least 0.3 dB/frame Lipschitz majorant: preserve each requested valley
    // lift while extending only the minimum smooth shoulder around it.
    for (let index = 1; index < requestedLiftDb.length; index += 1) {
      requestedLiftDb[index] = Math.max(
        requestedLiftDb[index],
        requestedLiftDb[index - 1] - BODY_DYNAMICS_MAX_GAIN_STEP_DB,
      );
    }
    for (let index = requestedLiftDb.length - 2; index >= 0; index -= 1) {
      requestedLiftDb[index] = Math.max(
        requestedLiftDb[index],
        requestedLiftDb[index + 1] - BODY_DYNAMICS_MAX_GAIN_STEP_DB,
      );
    }
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      recoveredGainDbCurve[frame] = Math.min(
        maxGainDb,
        recoveredGainDbCurve[frame] + requestedLiftDb[frame - startFrame],
      );
    }

  }

  return recoveredGainDbCurve;
};

/**
 * Partially support repeated word-scale body deficits inside one speech run.
 *
 * This is a source-relative planner tier, not a compressor. A 300 ms body
 * envelope is compared with the run's ordinary (P70) body plateau, while the
 * same comparison in broadband rejects spectral-only movement. The requested
 * lift also subtracts recovery already present in the candidate gain curve.
 *
 * Positive-deficit regions form continuous valley units. Recurrence authority
 * comes from how much evidence exists outside the strongest single unit, so a
 * lone whisper, localized terminal fade, or one dramatic pause keeps its
 * source shape. Multiple independent low words earn a bounded lift. The stage
 * is lift-only, immutable, and continuously damped near the recording floor.
 */
export const stabilizeRecurrentWordScaleBody = (
  gainDbCurve: Float32Array,
  sourceFrameDb: ArrayLike<number>,
  speechBodyFrameDb: ArrayLike<number>,
  bodySpeechRuns: readonly SpeechRun[],
  noiseFloorDb: number,
  maxGainDb: number,
  instabilityHint: number,
  frameMs = 10,
): Float32Array => {
  const stabilizedGainDbCurve = new Float32Array(gainDbCurve);
  if (
    sourceFrameDb.length !== gainDbCurve.length ||
    speechBodyFrameDb.length !== gainDbCurve.length ||
    !Number.isFinite(noiseFloorDb) ||
    !Number.isFinite(maxGainDb) ||
    !Number.isFinite(frameMs) ||
    frameMs <= 0
  ) {
    return stabilizedGainDbCurve;
  }

  const windowFrames = Math.max(1, Math.round(WORD_SCALE_BODY_WINDOW_MS / frameMs));
  const halfWindowFrames = Math.max(1, Math.floor(windowFrames / 2));
  const continuousPositiveDb = (valueDb: number) => Math.max(
    0,
    softPositiveDb(valueDb, WORD_SCALE_BODY_EVIDENCE_KNEE_DB) -
      softPositiveDb(0, WORD_SCALE_BODY_EVIDENCE_KNEE_DB),
  );

  for (const run of bodySpeechRuns) {
    const startFrame = clamp(Math.trunc(run.startFrame), 0, gainDbCurve.length);
    const endFrame = clamp(Math.trunc(run.endFrame), startFrame, gainDbCurve.length);
    const runFrames = endFrame - startFrame;
    if (runFrames < windowFrames) continue;

    const localSourceDb = new Array<number>(runFrames);
    const localBodyDb = new Array<number>(runFrames);
    const localOutputBodyDb = new Array<number>(runFrames);
    const outputBodyFrameDb = new Float32Array(runFrames);
    for (let index = 0; index < runFrames; index += 1) {
      const frame = startFrame + index;
      const bodyDb = speechBodyFrameDb[frame];
      const gainDb = gainDbCurve[frame];
      if (!Number.isFinite(bodyDb) || !Number.isFinite(gainDb)) {
        outputBodyFrameDb[index] = Number.NaN;
      } else {
        outputBodyFrameDb[index] = bodyDb + gainDb;
      }
    }
    for (let index = 0; index < runFrames; index += 1) {
      const frame = startFrame + index;
      const localStartFrame = Math.max(startFrame, frame - halfWindowFrames);
      const localEndFrame = Math.min(endFrame, frame + halfWindowFrames + 1);
      localSourceDb[index] = rmsDbOfSlice(
        sourceFrameDb,
        localStartFrame,
        localEndFrame,
      );
      localBodyDb[index] = rmsDbOfSlice(
        speechBodyFrameDb,
        localStartFrame,
        localEndFrame,
      );
      localOutputBodyDb[index] = rmsDbOfSlice(
        outputBodyFrameDb,
        localStartFrame - startFrame,
        localEndFrame - startFrame,
      );
    }

    const sourceReferenceDb = percentileDb(
      localSourceDb,
      WORD_SCALE_BODY_REFERENCE_PERCENTILE,
    );
    const bodyReferenceDb = percentileDb(
      localBodyDb,
      WORD_SCALE_BODY_REFERENCE_PERCENTILE,
    );
    const outputReferenceDb = percentileDb(
      localOutputBodyDb,
      WORD_SCALE_BODY_REFERENCE_PERCENTILE,
    );
    const sourceP10Db = percentileDb(localBodyDb, 10);
    const sourceP90Db = percentileDb(localBodyDb, 90);
    const rawSourceReferenceDb = percentileDb(
      Array.from(
        { length: runFrames },
        (_, index) => sourceFrameDb[startFrame + index],
      ),
      WORD_SCALE_BODY_REFERENCE_PERCENTILE,
    );
    const rawBodyReferenceDb = percentileDb(
      Array.from(
        { length: runFrames },
        (_, index) => speechBodyFrameDb[startFrame + index],
      ),
      WORD_SCALE_BODY_REFERENCE_PERCENTILE,
    );
    if (
      sourceReferenceDb === null ||
      bodyReferenceDb === null ||
      outputReferenceDb === null ||
      sourceP10Db === null ||
      sourceP90Db === null ||
      rawSourceReferenceDb === null ||
      rawBodyReferenceDb === null
    ) {
      continue;
    }

    const requestedLiftDb = new Float32Array(runFrames);
    const unitEvidenceDb = new Float32Array(runFrames);
    for (let index = 0; index < runFrames; index += 1) {
      const frame = startFrame + index;
      unitEvidenceDb[index] = Math.min(
        continuousPositiveDb(rawSourceReferenceDb - sourceFrameDb[frame]),
        continuousPositiveDb(rawBodyReferenceDb - speechBodyFrameDb[frame]),
      );
      const sourceDeficitDb = continuousPositiveDb(
        sourceReferenceDb - localSourceDb[index],
      );
      const bodyDeficitDb = continuousPositiveDb(
        bodyReferenceDb - localBodyDb[index],
      );
      const alignedDeficitDb = Math.min(sourceDeficitDb, bodyDeficitDb);
      if (!(alignedDeficitDb > 0)) continue;

      const outputDeficitDb = continuousPositiveDb(
        outputReferenceDb - localOutputBodyDb[index],
      );
      const currentRecoveryDb = alignedDeficitDb - outputDeficitDb;
      const desiredRecoveryDb = Math.min(
        WORD_SCALE_BODY_MAX_LIFT_DB,
        alignedDeficitDb * WORD_SCALE_BODY_RECOVERY_FRACTION,
      );
      const residualLiftDb = continuousPositiveDb(
        desiredRecoveryDb - currentRecoveryDb,
      );
      const floorMarginDb = localBodyDb[index] - (noiseFloorDb + 8);
      const floorAuthority = 1 / (1 + Math.exp(-floorMarginDb / 4));
      requestedLiftDb[index] =
        Math.min(WORD_SCALE_BODY_MAX_LIFT_DB, residualLiftDb) * floorAuthority;
    }

    type ValleyUnit = Readonly<{
      startIndex: number;
      endIndex: number;
      weight: number;
      durationAuthority: number;
    }>;
    const units: ValleyUnit[] = [];
    let unitStartIndex: number | null = null;
    for (let index = 0; index <= runFrames; index += 1) {
      const active = index < runFrames && unitEvidenceDb[index] > 0;
      if (active && unitStartIndex === null) unitStartIndex = index;
      if ((!active || index === runFrames) && unitStartIndex !== null) {
        const endIndex = index;
        let weight = 0;
        for (let unitIndex = unitStartIndex; unitIndex < endIndex; unitIndex += 1) {
          weight += requestedLiftDb[unitIndex];
        }
        const durationMs = (endIndex - unitStartIndex) * frameMs;
        const wordScaleDurationAuthority = smoothUnitRamp(
          durationMs,
          0,
          WORD_SCALE_BODY_WINDOW_MS,
        );
        const durationAuthority =
          wordScaleDurationAuthority ** 4 *
          (1 -
            0.75 *
              smoothUnitRamp(
                durationMs,
                WORD_SCALE_BODY_LONG_UNIT_START_MS,
                WORD_SCALE_BODY_LONG_UNIT_FULL_MS,
              ));
        units.push({ startIndex: unitStartIndex, endIndex, weight, durationAuthority });
        unitStartIndex = null;
      }
    }

    const totalUnitWeight = units.reduce(
      (sum, unit) => sum + unit.weight * unit.durationAuthority,
      0,
    );
    const strongestUnitWeight = units.reduce(
      (strongest, unit) => Math.max(strongest, unit.weight * unit.durationAuthority),
      0,
    );
    const recurrenceDiversity = totalUnitWeight > 0
      ? clamp(1 - strongestUnitWeight / totalUnitWeight, 0, 1)
      : 0;
    const recurrenceAuthority = smoothUnitRamp(recurrenceDiversity, 0, 0.5);
    const runSpreadDb = Math.max(0, sourceP90Db - sourceP10Db);
    const spreadAuthority = 1 / (1 + Math.exp(-(runSpreadDb - 5) / 2));
    const sourceAdaptationAuthority =
      (0.7 + 0.3 * clamp(instabilityHint, 0, 1)) * spreadAuthority;
    const unitAuthorityByFrame = new Float32Array(runFrames);
    for (const unit of units) {
      const unitAuthority =
        recurrenceAuthority * sourceAdaptationAuthority * unit.durationAuthority;
      for (let index = unit.startIndex; index < unit.endIndex; index += 1) {
        unitAuthorityByFrame[index] = unitAuthority;
      }
    }
    for (let index = 0; index < requestedLiftDb.length; index += 1) {
      requestedLiftDb[index] *= unitAuthorityByFrame[index];
    }

    // Least 0.295 dB/frame majorant: the lift itself cannot introduce a word
    // edge, even when the source envelope has an abrupt valley boundary.
    for (let index = 1; index < requestedLiftDb.length; index += 1) {
      requestedLiftDb[index] = Math.max(
        requestedLiftDb[index],
        requestedLiftDb[index - 1] - BODY_DYNAMICS_MAX_GAIN_STEP_DB,
      );
    }
    for (let index = requestedLiftDb.length - 2; index >= 0; index -= 1) {
      requestedLiftDb[index] = Math.max(
        requestedLiftDb[index],
        requestedLiftDb[index + 1] - BODY_DYNAMICS_MAX_GAIN_STEP_DB,
      );
    }
    for (let index = 0; index < runFrames; index += 1) {
      stabilizedGainDbCurve[startFrame + index] = Math.min(
        maxGainDb,
        stabilizedGainDbCurve[startFrame + index] + requestedLiftDb[index],
      );
    }
  }

  return stabilizedGainDbCurve;
};

/**
 * Keep the added word-scale tier from making any existing planner edge steeper.
 * The edge allowance is the larger of the established curve's movement and
 * the 0.295 dB body-motion contract. This preserves source-owned transient and
 * onset authority, while the projection can only lower candidate gain and can
 * therefore never introduce a new headroom risk.
 */
const projectWordScaleGainWithoutWorseningEdges = (
  establishedGainDbCurve: Float32Array,
  candidateGainDbCurve: Float32Array,
  bodySpeechRuns: readonly SpeechRun[],
): Float32Array => {
  const projectedGainDbCurve = new Float32Array(candidateGainDbCurve);
  if (establishedGainDbCurve.length !== candidateGainDbCurve.length) {
    return projectedGainDbCurve;
  }
  for (const run of bodySpeechRuns) {
    const startFrame = clamp(
      Math.trunc(run.startFrame),
      0,
      candidateGainDbCurve.length,
    );
    const endFrame = clamp(
      Math.trunc(run.endFrame),
      startFrame,
      candidateGainDbCurve.length,
    );
    for (let frame = startFrame + 1; frame < endFrame; frame += 1) {
      const establishedStepDb = Math.abs(
        establishedGainDbCurve[frame] - establishedGainDbCurve[frame - 1],
      );
      const allowedStepDb = Math.max(
        BODY_DYNAMICS_MAX_GAIN_STEP_DB,
        establishedStepDb,
      );
      projectedGainDbCurve[frame] = Math.min(
        projectedGainDbCurve[frame],
        projectedGainDbCurve[frame - 1] + allowedStepDb,
      );
    }
    for (let frame = endFrame - 2; frame >= startFrame; frame -= 1) {
      const establishedStepDb = Math.abs(
        establishedGainDbCurve[frame + 1] - establishedGainDbCurve[frame],
      );
      const allowedStepDb = Math.max(
        BODY_DYNAMICS_MAX_GAIN_STEP_DB,
        establishedStepDb,
      );
      projectedGainDbCurve[frame] = Math.min(
        projectedGainDbCurve[frame],
        projectedGainDbCurve[frame + 1] + allowedStepDb,
      );
    }
  }
  return projectedGainDbCurve;
};

const resolveTransientPeriodicity = (
  samples: Float32Array,
  sampleRate: number,
  startSample: number,
  endSample: number,
) => {
  const downsample = Math.max(
    1,
    Math.floor(sampleRate / TRANSIENT_VOICING_ANALYSIS_RATE_HZ),
  );
  const analysisRate = sampleRate / downsample;
  const sampleCount = Math.max(
    0,
    Math.floor((Math.min(samples.length, endSample) - Math.max(0, startSample)) / downsample),
  );
  const windowSamples = Math.max(
    1,
    Math.round((analysisRate * TRANSIENT_VOICING_WINDOW_MS) / 1000),
  );
  const hopSamples = Math.max(
    1,
    Math.round((analysisRate * TRANSIENT_VOICING_HOP_MS) / 1000),
  );
  const minLag = Math.max(
    1,
    Math.floor(analysisRate / TRANSIENT_VOICING_MAX_PITCH_HZ),
  );
  const maxLag = Math.max(
    minLag + 1,
    Math.ceil(analysisRate / TRANSIENT_VOICING_MIN_PITCH_HZ),
  );
  const sourceStartSample = Math.max(0, startSample);
  let weightedPeriodicity = 0;
  let totalPower = 0;

  for (
    let windowStart = 0;
    windowStart + windowSamples <= sampleCount;
    windowStart += hopSamples
  ) {
    let mean = 0;
    for (let index = 0; index < windowSamples; index += 1) {
      const value = samples[sourceStartSample + (windowStart + index) * downsample];
      mean += Number.isFinite(value) ? value : 0;
    }
    mean /= windowSamples;

    let windowPower = 0;
    for (let index = 0; index < windowSamples; index += 1) {
      const value = samples[sourceStartSample + (windowStart + index) * downsample];
      const centered = (Number.isFinite(value) ? value : 0) - mean;
      windowPower += centered * centered;
    }

    let bestCorrelation = 0;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let crossPower = 0;
      let leftPower = 0;
      let rightPower = 0;
      for (let index = lag; index < windowSamples; index += 1) {
        const leftValue =
          samples[sourceStartSample + (windowStart + index) * downsample];
        const rightValue =
          samples[sourceStartSample + (windowStart + index - lag) * downsample];
        const left = (Number.isFinite(leftValue) ? leftValue : 0) - mean;
        const right = (Number.isFinite(rightValue) ? rightValue : 0) - mean;
        crossPower += left * right;
        leftPower += left * left;
        rightPower += right * right;
      }
      const correlation =
        crossPower / Math.sqrt(leftPower * rightPower + 1e-30);
      bestCorrelation = Math.max(bestCorrelation, correlation);
    }
    weightedPeriodicity += bestCorrelation * windowPower;
    totalPower += windowPower;
  }

  return clamp(weightedPeriodicity / (totalPower + 1e-30), 0, 1);
};

const resolveTransientVoicingConfidence = (periodicity: number) => {
  const periodicityPower = clamp(periodicity, 0, 1) ** 6;
  const kneePower = TRANSIENT_VOICING_CONFIDENCE_KNEE ** 6;
  return (
    ((1 + kneePower) * periodicityPower) /
    (periodicityPower + kneePower)
  );
};

/**
 * Plan a gain curve for speech-aware leveling.
 */
export const planGainCurve = (input: GainPlannerInput): GainPlannerOutput => {
  const frameMs = input.frameMs ?? 10;
  const targetDbBase = input.targetDb ?? -22;
  const sourceTargetBlend = clamp(input.sourceTargetBlend ?? 0.15, 0, 1);
  const maxGainDb = input.maxGainDb ?? 14;
  const minGainDb = input.minGainDb ?? -14;
  const instabilityHint = clamp(input.instabilityHint ?? 0.5, 0, 1);
  const selectedLevelingConsistency = Number.isFinite(input.levelingConsistency)
    ? clamp(input.levelingConsistency as number, 0, 1)
    : 1;
  // A cinematic preset is the baseline authority, not a blind fixed amount.
  // Only a severely unstable source earns more phrase equalization, and the
  // return is continuous across the same measured instability signal that
  // controls the micro-ride. Multiplicative headroom preserves the ordering
  // of Minimal/Gentle/Balanced/Firm while default consistency=1 remains exact.
  const severeInstabilityAuthority =
    selectedLevelingConsistency < 1
      ? smoothUnitRamp(instabilityHint, 0.87, 0.95)
      : 0;
  const severeInstabilityConsistencyCeiling = Math.min(
    1,
    selectedLevelingConsistency * 1.86,
  );
  let levelingConsistency =
    selectedLevelingConsistency +
    (severeInstabilityConsistencyCeiling - selectedLevelingConsistency) *
      severeInstabilityAuthority;
  const coldOpenLiftToleranceDb = input.coldOpenLiftToleranceDb ?? COLD_OPEN_LIFT_TOLERANCE_DB;
  const coldOpenLiftMaxAllowedDb = input.coldOpenLiftMaxDb ?? COLD_OPEN_LIFT_MAX_DB;
  // -4 dBFS ceiling gives the downstream `alimiter=limit=-2dB` genuine
  // headroom — peaks that nearly kiss our ceiling leave 2 dB for the
  // limiter to shape transients without clipping.
  const peakCeilingDb = input.peakCeilingDb ?? -4;

  const frameCount = input.frameDb.length;
  const loudnessFrameDb =
    input.loudnessFrameDb?.length === frameCount ? input.loudnessFrameDb : input.frameDb;
  const speechBodyFrameDb =
    input.speechBodyFrameDb?.length === frameCount
      ? input.speechBodyFrameDb
      : loudnessFrameDb;
  const hasExplicitSpeechBodyEvidence =
    input.speechBodyFrameDb?.length === frameCount;
  // K-weighted energy still owns broadband event control, but its offset from
  // the voiced body is soft-saturated. This continuously preserves genuine
  // emotional energy while preventing an LF impact or bright consonant from
  // withdrawing the full body recovery in one 10 ms frame.
  const embeddedPerformanceFrameDb =
    speechBodyFrameDb === loudnessFrameDb
      ? loudnessFrameDb
      : Array.from({ length: frameCount }, (_, frame) => {
          const loudnessDb = loudnessFrameDb[frame];
          const speechBodyDb = speechBodyFrameDb[frame];
          if (!Number.isFinite(loudnessDb)) return speechBodyDb;
          if (!Number.isFinite(speechBodyDb)) return loudnessDb;
          const spectralOffsetDb = loudnessDb - speechBodyDb;
          return speechBodyDb
            + EMBEDDED_PERFORMANCE_SPECTRAL_OFFSET_SOFT_LIMIT_DB
              * Math.tanh(
                spectralOffsetDb
                  / EMBEDDED_PERFORMANCE_SPECTRAL_OFFSET_SOFT_LIMIT_DB,
              );
        });
  const fricativeFrameDb =
    input.fricativeFrameDb?.length === frameCount && Number.isFinite(input.fricativeNoiseFloorDb)
      ? input.fricativeFrameDb
      : null;
  const fricativeEvidenceFloorDb =
    fricativeFrameDb && Number.isFinite(input.fricativeNoiseFloorDb)
      ? (input.fricativeNoiseFloorDb as number) + FRICATIVE_EVIDENCE_MARGIN_DB
      : Number.POSITIVE_INFINITY;
  const hasFricativeEvidence = (frame: number) =>
    fricativeFrameDb !== null && (fricativeFrameDb[frame] ?? -120) >= fricativeEvidenceFloorDb;
  const gainDbCurve = new Float32Array(frameCount);

  // Adaptive micro-ride amplitude. The micro-ride applies small corrective
  // gain inside each speech run so the sliding RMS hugs the target. On a
  // clean take that's already smooth, a large micro-ride introduces its own
  // residual variance that downstream QC flags as "sentence jumps" when the
  // post-processing speech detector splits a sentence at breath gaps. On
  // messy takes, we need the full ride to keep the body level stable.
  //
  // Scale: ±0.4 dB at instabilityHint=0, ±1.5 dB at instabilityHint=1.
  const microRideDb = 0.4 + instabilityHint * 1.1;
  // This controls only the uniform residual correction for a whole hot run.
  // Time-local consonant repair is source-relative later in the delivery path;
  // the planner must not infer within-word attenuation from source level alone.
  const speechSpikeTaming = clamp(
    Math.max(input.speechSpikeTaming ?? clamp(0.3 + (instabilityHint - 0.05) * 0.85, 0.3, 1), 0.3),
    0,
    1,
  );

  // 1) Per-run body RMS + classification.
  //
  // Each detected run is tagged as body-speech / transient-breath / edge.
  // Classification uses run duration and the peak-to-body crest ratio — a
  // sub-400 ms run with > 15 dB crest is almost always a gasp / laugh /
  // grunt / plosive-dominated syllable, not a normal dialogue sentence.
  //
  // When `input.samples` is provided we compute a per-frame peak from the
  // actual waveform (accurate); otherwise we approximate peak ~= body + 12
  // dB which is the typical speech crest factor.
  const runRmsDb: number[] = []; // body-speech loudness-domain runs ONLY — these drive the target
  type RunEntry = {
    detectedStartFrame: number;
    startFrame: number;
    endFrame: number;
    meanDb: number;
    loudnessMeanDb: number;
    peakDb: number;
    crestDb: number;
    /**
     * Fraction of frames within the run whose peak sits more than 6 dB
     * above the run's body mean. A real screamed/yelled passage has a
     * high ratio (most frames hot); a single plosive in a calm sentence
     * has a near-zero ratio.
     */
    hotFrameRatio: number;
    /**
     * Continuous run-level ownership by the 180-3000 Hz speech body.
     * Zero means no explicit body envelope; no signal threshold engages it.
     */
    bodyOwnershipAuthority: number;
    runClass: SpeechRunClass;
    isColdOpen: boolean;
  };
  const runMeta: RunEntry[] = [];

  const samplesPerFrame = input.sampleRate && input.sampleRate > 0
    ? Math.max(1, Math.round((input.sampleRate * frameMs) / 1000))
    : 0;
  const framePeakDb: number[] | null = input.samples && samplesPerFrame > 0
    ? new Array<number>(frameCount).fill(-120)
    : null;
  if (framePeakDb && input.samples) {
    for (let f = 0; f < frameCount; f += 1) {
      const start = f * samplesPerFrame;
      const end = Math.min(input.samples.length, start + samplesPerFrame);
      let peak = 0;
      for (let i = start; i < end; i += 1) {
        const abs = Math.abs(input.samples[i]);
        if (abs > peak) peak = abs;
      }
      framePeakDb[f] = peak > 0 ? 20 * Math.log10(peak) : -120;
    }
  }

  for (let runIndex = 0; runIndex < input.speechRuns.length; runIndex += 1) {
    const run = input.speechRuns[runIndex];
    let startFrame = run.startFrame;
    const backtrackFrames = Math.max(0, Math.round(RUN_ONSET_BACKTRACK_MS / frameMs));
    const backtrackFloorDb = input.speechThresholdDb - 6;
    const previousRunEndFrame = runIndex > 0 ? input.speechRuns[runIndex - 1].endFrame : 0;
    let walkedFrames = 0;
    while (startFrame > previousRunEndFrame && walkedFrames < backtrackFrames) {
      const candidateFrame = startFrame - 1;
      const hasRawEnvelopeEvidence = input.frameDb[candidateFrame] >= backtrackFloorDb;
      if (!hasRawEnvelopeEvidence && !hasFricativeEvidence(candidateFrame)) break;
      startFrame = candidateFrame;
      walkedFrames += 1;
    }
    const runFrames = run.endFrame - startFrame;
    if (runFrames < 6) continue;
    const trim = Math.max(2, Math.floor(runFrames * 0.12));
    const bodyStart = startFrame + trim;
    const bodyEnd = Math.max(bodyStart + 1, run.endFrame - trim);
    const meanDb = rmsDbOfSlice(input.frameDb, bodyStart, bodyEnd);
    const loudnessMeanDb = rmsDbOfSlice(loudnessFrameDb, bodyStart, bodyEnd);
    if (!Number.isFinite(meanDb) || meanDb <= -100) continue;
    if (!Number.isFinite(loudnessMeanDb) || loudnessMeanDb <= -100) continue;
    const bodyMeanDb = hasExplicitSpeechBodyEvidence
      ? rmsDbOfSlice(speechBodyFrameDb, bodyStart, bodyEnd)
      : -120;
    const bodyPowerShare =
      hasExplicitSpeechBodyEvidence && Number.isFinite(bodyMeanDb)
        ? clamp(Math.pow(10, (bodyMeanDb - meanDb) / 10), 0, 1)
        : 0;

    // Peak over the ENTIRE run (including edges — that's where plosives
    // live). Fall back to frameDb + 12 dB when samples are unavailable.
    let peakDb = -120;
    if (framePeakDb) {
      for (let f = startFrame; f < run.endFrame; f += 1) {
        if (framePeakDb[f] > peakDb) peakDb = framePeakDb[f];
      }
    } else {
      for (let f = startFrame; f < run.endFrame; f += 1) {
        if (input.frameDb[f] > peakDb) peakDb = input.frameDb[f];
      }
      peakDb += 12;
    }
    const crestDb = peakDb - meanDb;
    const runLenMs = runFrames * frameMs;

    // SUSTAINED-CREST ratio: how many frames inside the run sit > 6 dB
    // above body. This distinguishes a real screamed/yelled passage
    // (high ratio — most frames hot) from a single-sample plosive in an
    // otherwise calm sentence (very low ratio). Used by the high-crest
    // sub-targeting decision below so we don't psycho-acoustically
    // duck a sentence just because one consonant has a sharp peak.
    let hotFrameCount = 0;
    for (let f = startFrame; f < run.endFrame; f += 1) {
      const framePeakAtF = framePeakDb ? framePeakDb[f] : input.frameDb[f] + 12;
      if (framePeakAtF > meanDb + 6) hotFrameCount += 1;
    }
    const hotFrameRatio = hotFrameCount / runFrames;
    const previousEndFrame = runIndex > 0 ? input.speechRuns[runIndex - 1].endFrame : 0;
    const nextStartFrame =
      runIndex + 1 < input.speechRuns.length ? input.speechRuns[runIndex + 1].startFrame : frameCount;
    const preGapMs = Math.max(0, startFrame - previousEndFrame) * frameMs;
    const postGapMs = Math.max(0, nextStartFrame - run.endFrame) * frameMs;
    const isolatedOrLeadIn = preGapMs >= 70 || postGapMs >= 70;
    const isColdOpen = runIndex < COLD_OPEN_RUN_COUNT || startFrame * frameMs <= COLD_OPEN_WINDOW_MS;
    const shortHotPerformance =
      runLenMs < 650 &&
      isolatedOrLeadIn &&
      (crestDb >= 13.5 ||
        peakDb >= targetDbBase + 10.5 ||
        (runLenMs < 360 && peakDb >= targetDbBase + 8 && meanDb <= targetDbBase + 1.5));

    let runClass: SpeechRunClass;
    if (isColdOpen && runLenMs < 100) {
      runClass = "edge-fragment";
    } else if (
      isColdOpen &&
      (shortHotPerformance || runLenMs < 400) &&
      framePeakDb &&
      crestDb >= COLD_OPEN_TRANSIENT_CREST_DB &&
      peakDb >= targetDbBase + COLD_OPEN_TRANSIENT_PEAK_OVER_TARGET_DB
    ) {
      runClass = "transient-breath";
    } else if (isColdOpen) {
      runClass = "body-speech";
    } else if (shortHotPerformance) {
      runClass = "transient-breath";
    } else if (runLenMs < 100) {
      runClass = "edge-fragment";
    } else if (runLenMs < 400 && crestDb >= 15) {
      runClass = "transient-breath";
    } else {
      runClass = "body-speech";
    }
    const periodicity =
      runClass === "transient-breath" &&
      input.samples &&
      samplesPerFrame > 0 &&
      input.sampleRate &&
      input.sampleRate > 0
        ? resolveTransientPeriodicity(
            input.samples,
            input.sampleRate,
            startFrame * samplesPerFrame,
            run.endFrame * samplesPerFrame,
          )
        : 0;
    // Body energy and periodic voicing are both continuous evidence. Their
    // product rejects low-passed aperiodic inhales without a binary detector,
    // while strongly voiced short words can recover misplaced breath bias.
    const bodyOwnershipAuthority =
      bodyPowerShare ** TRANSIENT_BODY_SHARE_AUTHORITY_EXPONENT *
      resolveTransientVoicingConfidence(periodicity);

    runMeta.push({
      detectedStartFrame: run.startFrame,
      startFrame,
      endFrame: run.endFrame,
      meanDb,
      loudnessMeanDb,
      peakDb,
      crestDb,
      hotFrameRatio,
      bodyOwnershipAuthority,
      runClass,
      isColdOpen,
    });
    // Only body-speech runs drive the batch target — a single loud gasp
    // must NOT pull the dialogue target level up.
    if (runClass === "body-speech") runRmsDb.push(loudnessMeanDb);
  }

  // Do not spend phrase equalization merely because it is available. When
  // at least three body runs already live within a narrow cinematic range,
  // continuously return most macro authority to the actor. Genuinely uneven
  // takes regain the selected (and severe-instability-adjusted) authority by
  // 8 dB of source spread. Local spike, valley, tail, and peak repair remain
  // independent, so an already-consistent take can still lose defects.
  if (levelingConsistency < 1 && runRmsDb.length >= 3) {
    const sourceBodyRunSpreadDb = Math.max(...runRmsDb) - Math.min(...runRmsDb);
    const sourceSpreadAuthority = smoothUnitRamp(sourceBodyRunSpreadDb, 2, 8);
    levelingConsistency *= 0.15 + 0.85 * sourceSpreadAuthority;
  }

  // 2) Target = TRIMMED MEAN of run body RMS (drop extreme sentences as
  //    outliers), blended toward targetDbBase. Trimmed mean resists the
  //    single-loud-sentence skew the median had: median tracks the middle
  //    of the distribution, so one very loud line pulled the target up and
  //    left every quiet line under-amplified. Trimmed mean lands in the
  //    actual "typical" level of the take. For files with ≥ 7 runs we
  //    trim 15 % each end (min 1); for shorter takes we don't trim
  //    because the sample is already statistically small.
  let targetDb = targetDbBase;
  if (runRmsDb.length >= 1) {
    const sorted = [...runRmsDb].sort((a, b) => a - b);
    const trimCount =
      sorted.length >= 7 ? Math.max(1, Math.floor(sorted.length * 0.15)) : 0;
    const trimmed = sorted.slice(trimCount, Math.max(trimCount + 1, sorted.length - trimCount));
    const trimmedMean = trimmed.reduce((sum, v) => sum + v, 0) / trimmed.length;
    targetDb = clamp(
      sourceTargetBlend * trimmedMean + (1 - sourceTargetBlend) * targetDbBase,
      targetDbBase - 3,
      targetDbBase + 3
    );
  }

  // 3) Per-run planned gain — class-aware.
  //
  // body-speech: target the batch level, full ±maxGainDb clamp.
  // transient-breath: target 2.5 dB BELOW dialogue so the character beat
  //   sits with the performance instead of poking above it. Tight ±6 dB
  //   clamp so a loud gasp can't be amplified into a scream, and a very
  //   quiet gasp can't be lifted to full dialogue level.
  // edge-fragment: target batch level with tight ±4 dB clamp (not enough
  //   body to plan on, but still contribute to continuity).
  // Asymmetric clamp for breaths: allow up to -12 dB attenuation but only
  // +4 dB boost. A very loud yell/scream can now be brought 12 dB DOWN
  // instead of being clamped at -5 and still poking 7 dB above dialogue.
  // Quiet breaths stay tight (+4 max) so a silent inhale isn't amplified
  // into audibility.
  //
  // SOURCE-ADAPTIVE PERFORMANCE RETENTION for body-speech runs.
  //
  // A loud emotional phrase must be controlled without being flattened to
  // ordinary dialogue. Retained emphasis grows continuously with source
  // excess and sustained-performance evidence (crest, hot-frame density and
  // duration), then saturates at a modest 5.5 dB. There is no detector
  // engagement threshold. The same evidence continuously widens the body
  // attenuation window from the configured minimum toward -18 dB.
  const breathTargetDb = targetDb - 3.2;
  const resolveBodyPerformanceAuthority = (m: RunEntry) => {
    const runLenMs = (m.endFrame - m.startFrame) * frameMs;
    const crestAuthority = smoothUnitRamp(m.crestDb, 11, 21);
    const hotFrameAuthority = smoothUnitRamp(m.hotFrameRatio, 0, 0.75);
    const durationAuthority = smoothUnitRamp(runLenMs, 200, 1_200);
    return clamp(
      crestAuthority * Math.sqrt(hotFrameAuthority * durationAuthority),
      0,
      1,
    );
  };
  const resolveFullConsistencyBodyPlannedGainDb = (m: RunEntry) => {
    const performanceAuthority = resolveBodyPerformanceAuthority(m);
    const sourceExcessDb = Math.max(0, m.loudnessMeanDb - targetDb);
    const retainedEmphasisDb = clamp(
      sourceExcessDb * (0.16 + 0.06 * performanceAuthority) +
        2 * performanceAuthority,
      0,
      5.5,
    );
    const adjustedTarget = targetDb + retainedEmphasisDb;
    const widestLowerClamp = Math.min(minGainDb, -18);
    const lowerClamp =
      minGainDb + (widestLowerClamp - minGainDb) * performanceAuthority;
    return clamp(adjustedTarget - m.loudnessMeanDb, lowerClamp, maxGainDb);
  };
  const resolveBodyLevelingAuthority = (m: RunEntry) => {
    if (m.runClass !== "body-speech" || levelingConsistency >= 1) return 1;
    const belowTargetDb = targetDb - m.loudnessMeanDb;
    const audibilityReturn =
      1 /
      (1 +
        Math.exp(
          -(belowTargetDb - BODY_LEVELING_AUDIBILITY_CENTER_BELOW_TARGET_DB) /
            BODY_LEVELING_AUDIBILITY_WIDTH_DB,
        ));
    return levelingConsistency + (1 - levelingConsistency) * audibilityReturn;
  };
  const bodyPerformanceAuthority = runMeta.map((m) =>
    m.runClass === "body-speech" ? resolveBodyPerformanceAuthority(m) : 0
  );
  const bodyLevelingAuthority = runMeta.map(resolveBodyLevelingAuthority);
  const fullConsistencyBodyPlannedGainDb = runMeta.map(
    resolveFullConsistencyBodyPlannedGainDb,
  );
  const transientBodyRecoveryDb = new Array<number>(runMeta.length).fill(0);
  const transientRetainedAdvantageDb = new Array<number>(runMeta.length).fill(0);
  const plannedRunGainDb: number[] = runMeta.map((m, runIndex) => {
    if (m.runClass === "transient-breath") {
      const targetClassGain = breathTargetDb - m.loudnessMeanDb;
      const positiveClamp =
        m.isColdOpen && targetClassGain > 0 ? Math.min(maxGainDb, Math.max(4, targetClassGain)) : 4;
      const breathPlanGainDb = clamp(targetClassGain, -12, positiveClamp);
      const bodyPlanGainDb = fullConsistencyBodyPlannedGainDb[runIndex];
      const recoverableAttenuationDb = Math.max(
        0,
        Math.min(0, bodyPlanGainDb) - breathPlanGainDb,
      );
      const recoveryDb = Math.min(
        TRANSIENT_BODY_RECOVERY_MAX_DB,
        recoverableAttenuationDb * m.bodyOwnershipAuthority,
      );
      transientBodyRecoveryDb[runIndex] = recoveryDb;
      const retainedAdvantageDb = Math.min(
        TRANSIENT_BODY_RETAINED_ADVANTAGE_MAX_DB,
        Math.max(0, m.loudnessMeanDb - targetDb) *
          TRANSIENT_BODY_RETAINED_ADVANTAGE_FRACTION *
          m.bodyOwnershipAuthority,
      );
      transientRetainedAdvantageDb[runIndex] = retainedAdvantageDb;
      return breathPlanGainDb + recoveryDb + retainedAdvantageDb;
    }
    if (m.runClass === "edge-fragment") {
      const targetClassGain = targetDb - m.loudnessMeanDb;
      const positiveClamp =
        m.isColdOpen && targetClassGain > 0 ? Math.min(maxGainDb, Math.max(4, targetClassGain)) : 4;
      return clamp(targetClassGain, -4, positiveClamp);
    }
    return fullConsistencyBodyPlannedGainDb[runIndex] * bodyLevelingAuthority[runIndex];
  });
  // Cross-run smoothing on adjacent body-speech pairs only.
  //
  // Transient/edge classes retain their intentionally different targets.
  // Body pairs influence each other continuously: similarity decays with
  // source-level distance, large planned differences earn more smoothing,
  // and emotional evidence continuously protects the retained contour.
  const smoothAdjacentBodyRunGains = (runGainDb: number[]) => {
    for (let i = 1; i < runGainDb.length; i += 1) {
      const cur = runMeta[i];
      const prev = runMeta[i - 1];
      if (cur.runClass !== "body-speech" || prev.runClass !== "body-speech") continue;
      const diff = runGainDb[i] - runGainDb[i - 1];
      const sourceDeltaDb = Math.abs(cur.loudnessMeanDb - prev.loudnessMeanDb);
      const sourceSimilarity = 1 / (1 + (sourceDeltaDb / 8) ** 2);
      const differenceAuthority = Math.abs(diff) / (Math.abs(diff) + 3);
      const performanceProtection =
        1 - 0.9 * Math.max(bodyPerformanceAuthority[i], bodyPerformanceAuthority[i - 1]);
      const blend =
        0.35 * sourceSimilarity * differenceAuthority * performanceProtection;
      const mid = (runGainDb[i] + runGainDb[i - 1]) / 2;
      runGainDb[i - 1] =
        runGainDb[i - 1] + (mid - runGainDb[i - 1]) * blend;
      runGainDb[i] = runGainDb[i] + (mid - runGainDb[i]) * blend;
    }
  };
  const fullConsistencyReferenceGainDb = levelingConsistency < 1
    ? [...fullConsistencyBodyPlannedGainDb]
    : plannedRunGainDb;
  smoothAdjacentBodyRunGains(plannedRunGainDb);
  if (fullConsistencyReferenceGainDb !== plannedRunGainDb) {
    smoothAdjacentBodyRunGains(fullConsistencyReferenceGainDb);
  }

  // Conservative opener guard. It only acts when the first few body-speech
  // runs are materially hotter than the later dialogue anchor. Normal actor
  // emphasis of ~1-2 dB is preserved; severe openers are capped so the file
  // does not start loud and then settle down.
  let earlyRunCapCount = 0;
  let earlyRunMaxReductionDb = 0;
  let coldOpenLiftCount = 0;
  let coldOpenLiftMaxDb = 0;
  const bodyRunIndexes = runMeta
    .map((meta, index) => (meta.runClass === "body-speech" ? index : -1))
    .filter((index) => index >= 0);
  if (bodyRunIndexes.length >= 3) {
    // Reduced consistency must not make this independent opener repair chase
    // the intentionally less-equalized later runs. Judge the guard against a
    // full-consistency counterfactual, then spend only this run's authority.
    // At consistency=1 the live array remains the reference, preserving the
    // legacy operation order and values exactly.
    const usesCounterfactualReference =
      fullConsistencyReferenceGainDb !== plannedRunGainDb;
    const coldOpenReferenceGainDb = fullConsistencyReferenceGainDb;
    const earlyRunIndexes = bodyRunIndexes.slice(0, Math.min(3, bodyRunIndexes.length - 2));
    const earlySet = new Set(earlyRunIndexes);
    const laterAppliedBodies = bodyRunIndexes
      .filter((index) => !earlySet.has(index))
      .map(
        (index) =>
          runMeta[index].loudnessMeanDb +
          (coldOpenReferenceGainDb[index] ?? 0),
      )
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const laterAnchorDb = laterAppliedBodies[Math.floor(laterAppliedBodies.length / 2)];
    if (Number.isFinite(laterAnchorDb)) {
      const toleranceDb = 1.5;
      const triggerDb = 2.75;
      for (const index of earlyRunIndexes) {
        const appliedBodyDb =
          runMeta[index].loudnessMeanDb +
          (coldOpenReferenceGainDb[index] ?? 0);
        const overLaterDb = appliedBodyDb - laterAnchorDb;
        if (overLaterDb < triggerDb) continue;
        const reductionDb = clamp(overLaterDb - toleranceDb, 0, 5);
        if (reductionDb <= 0) continue;
        const authorizedReductionDb =
          reductionDb * (bodyLevelingAuthority[index] ?? 1);
        plannedRunGainDb[index] -= authorizedReductionDb;
        if (usesCounterfactualReference) {
          coldOpenReferenceGainDb[index] -= reductionDb;
        }
        earlyRunCapCount += 1;
        earlyRunMaxReductionDb = Math.max(
          earlyRunMaxReductionDb,
          authorizedReductionDb,
        );
      }
      for (const index of earlyRunIndexes) {
        const appliedBodyDb =
          runMeta[index].loudnessMeanDb +
          (coldOpenReferenceGainDb[index] ?? 0);
        const underLaterDb = laterAnchorDb - appliedBodyDb;
        if (underLaterDb <= coldOpenLiftToleranceDb) continue;
        const maxAllowedByGain =
          maxGainDb - (coldOpenReferenceGainDb[index] ?? 0);
        const liftDb = clamp(
          underLaterDb - coldOpenLiftToleranceDb,
          0,
          Math.min(coldOpenLiftMaxAllowedDb, maxAllowedByGain),
        );
        if (liftDb <= 0) continue;
        const authorizedLiftDb = Math.min(
          liftDb * (bodyLevelingAuthority[index] ?? 1),
          maxGainDb - (plannedRunGainDb[index] ?? 0),
        );
        if (authorizedLiftDb <= 0) continue;
        plannedRunGainDb[index] += authorizedLiftDb;
        if (usesCounterfactualReference) {
          coldOpenReferenceGainDb[index] += liftDb;
        }
        coldOpenLiftCount += 1;
        coldOpenLiftMaxDb = Math.max(coldOpenLiftMaxDb, authorizedLiftDb);
      }
    }
  }

  // Perceived loudness stays primary, but sparse high-crest dialogue can
  // measure "loud enough" in the K-weighted envelope while its raw body
  // still lands as an untreated soft line. Give those body-speech runs a
  // small floor lift, capped by loudness headroom and crest, so recovery
  // renders do not become pass-through on genuinely quiet dialogue bodies.
  const quietBodyRawFloorDb = targetDb - QUIET_BODY_FLOOR_OFFSET_DB;
  const quietBodyLoudnessFloorDb = targetDb - QUIET_BODY_FLOOR_LOUDNESS_OFFSET_DB;
  for (let index = 0; index < runMeta.length; index += 1) {
    const meta = runMeta[index];
    if (meta.runClass !== "body-speech") continue;

    const currentGainDb = plannedRunGainDb[index] ?? 0;
    // At reduced consistency the floor judges the full-consistency plan, not
    // the deliberately contrast-preserving gain. Otherwise this later pass
    // would simply add back the equalization that the caller withheld.
    const floorReferenceGainDb = levelingConsistency >= 1
      ? currentGainDb
      : fullConsistencyReferenceGainDb[index] ?? currentGainDb;
    const rawAppliedDb = meta.meanDb + floorReferenceGainDb;
    const loudnessAppliedDb = meta.loudnessMeanDb + floorReferenceGainDb;
    const rawLiftNeededDb = quietBodyRawFloorDb - rawAppliedDb;
    const loudnessHeadroomDb = quietBodyLoudnessFloorDb - loudnessAppliedDb;
    if (rawLiftNeededDb <= 0 || loudnessHeadroomDb <= 0) continue;

    const crestScale =
      meta.crestDb >= QUIET_BODY_FLOOR_EXTREME_CREST_DB
        ? 0.35
        : meta.crestDb >= QUIET_BODY_FLOOR_HIGH_CREST_DB
          ? 0.65
          : 1;
    const gainHeadroomDb = maxGainDb - currentGainDb;
    const liftAuthority = bodyLevelingAuthority[index] ?? 1;
    const liftDb = clamp(
      Math.min(
        rawLiftNeededDb,
        loudnessHeadroomDb,
        QUIET_BODY_FLOOR_MAX_LIFT_DB * crestScale,
      ) * liftAuthority,
      0,
      gainHeadroomDb,
    );
    if (liftDb > 0) {
      plannedRunGainDb[index] += liftDb;
    }
  }

  // 4) Unclassified-frame trim. Detector misses are uncertainty, not proof of
  // silence, so pause-noise risk earns only a shallow continuous reduction.
  const expanderDepthDb = clamp(input.pauseNoiseRisk * 1.5, 0, 1.5);

  // 5) Paint the curve.
  //
  // The old algorithm ramped INSIDE the speech run (first/last 80-200 ms of
  // each sentence got reduced gain), which clipped the first syllable's
  // attack and killed soft word endings (trailing "s", "m", "n" tails). The
  // new algorithm keeps the entire detected run at full body gain and ramps
  // into/out of silence BEFORE/AFTER the run using a cos² equal-power curve.
  //
  //   …silence… ——attack↗ [body at full body gain] release↘—— …silence…
  //               (80 ms in                         (500 ms in
  //                preceding silence)                following silence)
  //
  // Result: ending consonants and soft tails survive. First syllables are
  // not ducked. Unclassified frames retain their native level with at most a
  // subtle trim; dedicated cleanup owns actual room-bed reduction.
  const silenceGainDefaultDb = -expanderDepthDb;
  for (let i = 0; i < frameCount; i += 1) gainDbCurve[i] = silenceGainDefaultDb;

  // 80 ms attack (short, so speech onset is crisp) and 500 ms release
  // (long, so trailing phonemes survive). Release is equal-power cos² — the
  // perceptual loudness decays linearly, not exponentially, so soft tails
  // don't vanish abruptly.
  const attackFrames = Math.max(1, Math.round(80 / frameMs));
  const releaseFrames = Math.max(1, Math.round(500 / frameMs));
  const softTailRescueMaxFrames = Math.max(
    1,
    Math.round(
      (input.pauseNoiseRisk >= SOFT_TAIL_RESCUE_NOISY_RISK
        ? SOFT_TAIL_RESCUE_NOISY_MAX_MS
        : SOFT_TAIL_RESCUE_MAX_MS) / frameMs,
    ),
  );
  const softTailRescueMinActiveFrames = Math.max(1, Math.round(SOFT_TAIL_RESCUE_MIN_ACTIVE_MS / frameMs));
  const softTailRescueBridgeFrames = Math.max(0, Math.round(SOFT_TAIL_RESCUE_BRIDGE_MS / frameMs));
  const fricativeTailRescueMaxFrames = Math.max(1, Math.round(FRICATIVE_TAIL_RESCUE_MAX_MS / frameMs));
  let tailRescueRunCount = 0;
  let tailRescueFrameCount = 0;
  let tailRescueMaxFrames = 0;
  const protectedEndFrameByRun = new Array<number>(runMeta.length).fill(0);

  const resolveSoftTailRescueEndFrame = (meta: RunEntry, nextRunStart: number) => {
    if (meta.runClass !== "body-speech") return meta.endFrame;

    const scanEnd = Math.min(nextRunStart, meta.endFrame + softTailRescueMaxFrames, frameCount);
    const tailFloorDb = Math.max(
      input.noiseFloorDb + SOFT_TAIL_RESCUE_NOISE_MARGIN_DB,
      Math.min(
        input.speechThresholdDb - SOFT_TAIL_RESCUE_SPEECH_MARGIN_DB,
        meta.meanDb - SOFT_TAIL_RESCUE_BODY_DROP_DB,
      ),
    );
    const hardNoiseFloorDb = input.noiseFloorDb + SOFT_TAIL_RESCUE_HARD_NOISE_MARGIN_DB;

    let rescueEndFrame = meta.endFrame;
    let activeFrames = 0;
    let quietBridgeFrames = 0;

    for (let f = meta.endFrame; f < scanEnd; f += 1) {
      const frameDb = input.frameDb[f] ?? -120;
      const attachedFricativeTailEvidence =
        f - meta.endFrame < fricativeTailRescueMaxFrames &&
        frameDb >= hardNoiseFloorDb &&
        hasFricativeEvidence(f);
      if (frameDb >= tailFloorDb || attachedFricativeTailEvidence) {
        activeFrames += 1;
        quietBridgeFrames = 0;
        rescueEndFrame = f + 1;
        continue;
      }

      if (activeFrames > 0 && frameDb >= hardNoiseFloorDb && quietBridgeFrames < softTailRescueBridgeFrames) {
        quietBridgeFrames += 1;
        rescueEndFrame = f + 1;
        continue;
      }

      break;
    }

    return activeFrames >= softTailRescueMinActiveFrames ? rescueEndFrame : meta.endFrame;
  };

  for (let r = 0; r < runMeta.length; r += 1) {
    const { startFrame, endFrame, loudnessMeanDb, runClass, crestDb } = runMeta[r];
    const bodyGainDb = plannedRunGainDb[r];

    // Micro-ride policy per class:
    // - transient-breath / edge-fragment: NO micro-ride. Too short to
    //   benefit and any local amplification raises the transient peak.
    // - body-speech with high crest (≥ 16 dB — consonant-heavy, shouty, or
    //   whispery lines): reduce micro-ride amplitude by 50 % so we don't
    //   amplify the consonant peaks in a body frame that happens to be
    //   locally quiet.
    // - body-speech normal: full micro-ride.
    const runEffectiveMicroRideDb = runClass !== "body-speech"
      ? 0
      : crestDb >= 16
        ? microRideDb * 0.5
        : microRideDb;

    const slideFrames = Math.max(4, Math.round(200 / frameMs));
    for (let i = startFrame; i < endFrame; i += 1) {
      if (runEffectiveMicroRideDb <= 0) {
        gainDbCurve[i] = bodyGainDb;
        continue;
      }
      const winStart = Math.max(startFrame, i - Math.floor(slideFrames / 2));
      const winEnd = Math.min(endFrame, i + Math.ceil(slideFrames / 2));
      const localDb = rmsDbOfSlice(loudnessFrameDb, winStart, winEnd);
      // Reduced consistency retains the run's macro output level, while the
      // existing micro-ride still stabilizes deviations inside that run. If
      // this continued to chase the house target it could add back up to the
      // full micro-ride after macro equalization had been withheld.
      const retainedMacroOutputDb = loudnessMeanDb + bodyGainDb;
      const microRideTargetDb = levelingConsistency >= 1
        ? targetDb
        : retainedMacroOutputDb +
          (targetDb - retainedMacroOutputDb) * levelingConsistency;
      const microGainDb = clamp(
        microRideTargetDb - (localDb + bodyGainDb),
        -runEffectiveMicroRideDb,
        runEffectiveMicroRideDb,
      );
      gainDbCurve[i] = bodyGainDb + microGainDb;
    }

    // Attack ramp — lives in the silence BEFORE the run, never inside it.
    // We walk back from startFrame, bounded by the previous protected end so
    // we don't trample that run's release or rescued tail.
    const prevRunEnd = r > 0
      ? Math.max(runMeta[r - 1].endFrame, protectedEndFrameByRun[r - 1] ?? runMeta[r - 1].endFrame)
      : 0;
    const attackStart = Math.max(startFrame - attackFrames, prevRunEnd, 0);
    const attackLeadFrames = r === 0 ? Math.max(0, Math.round(COLD_OPEN_ATTACK_LEAD_MS / frameMs)) : 0;
    const attackEnd = r === 0 ? Math.max(attackStart, startFrame - attackLeadFrames) : startFrame;
    const attackLen = attackEnd - attackStart;
    const bodyGainAtStart = gainDbCurve[startFrame];
    const isFileHeadRun = r === 0 && startFrame <= attackFrames;
    const precedingGainDb =
      startFrame > 0 ? gainDbCurve[startFrame - 1] : silenceGainDefaultDb;
    const fricativeAttackAuthority = fricativeFrameDb
      ? smoothUnitRamp(
          (fricativeFrameDb[startFrame] ?? -120) - fricativeEvidenceFloorDb,
          0,
          12,
        )
      : 0;
    const positiveAttackEntryBudgetDb =
      POSITIVE_ATTACK_ENTRY_GAIN_DB +
      POSITIVE_ATTACK_FRICATIVE_ENTRY_BONUS_DB * fricativeAttackAuthority;
    const positiveAttackEntryGainDb = Math.min(
      bodyGainAtStart,
      Math.max(
        precedingGainDb,
        Math.min(bodyGainAtStart, positiveAttackEntryBudgetDb),
      ),
    );
    const attackTargetGainDb = isFileHeadRun
      ? bodyGainAtStart
      : positiveAttackEntryGainDb;
    for (let k = 0; k < attackLen; k += 1) {
      const t = (k + 1) / (attackLen + 1); // 0 → 1 as we approach run start
      const weight = Math.sin((t * Math.PI) / 2) ** 2; // cos² rising
      gainDbCurve[attackStart + k] =
        silenceGainDefaultDb + (attackTargetGainDb - silenceGainDefaultDb) * weight;
    }
    if (r === 0) {
      for (let f = attackEnd; f < startFrame; f += 1) {
        gainDbCurve[f] = attackTargetGainDb;
      }
    }

    // Release ramp — lives in the silence AFTER the run, never inside it.
    // Bounded by the NEXT run's start so we don't overwrite its attack.
    // The preceding run keeps ownership of its already-bounded soft-tail
    // window up to the detector's original next-run boundary. A later run's
    // optional onset backtrack must not shorten that established protection.
    // The run itself remains the only owner of large positive recovery. Ease
    // just the excess above the conservative onset budget into its already
    // planned per-frame curve. The duration derives continuously from the gain
    // distance, so there is no short/long-run engagement gate.
    const positiveAttackExcessDb = Math.max(
      0,
      bodyGainAtStart - attackTargetGainDb,
    );
    if (positiveAttackExcessDb > 0) {
      const slewDbPerFrame = Math.max(
        Number.EPSILON,
        POSITIVE_ATTACK_EXCESS_SLEW_DB_PER_100_MS * (frameMs / 100),
      );
      const handoffFrames = Math.max(
        1,
        Math.ceil(positiveAttackExcessDb / slewDbPerFrame),
      );
      const handoffEndFrame = Math.min(endFrame, startFrame + handoffFrames);
      const hasAttachedOnsetEvidence = startFrame < runMeta[r].detectedStartFrame;
      for (let frame = startFrame; frame < handoffEndFrame; frame += 1) {
        const progress = (frame - startFrame + 1) / handoffFrames;
        const weight = Math.sin((Math.min(1, progress) * Math.PI) / 2) ** 2;
        const plannedFrameGainDb = gainDbCurve[frame];
        const rawAuthority = hasAttachedOnsetEvidence
          ? smoothUnitRamp(
              input.frameDb[frame] ?? -120,
              input.speechThresholdDb - 8,
              input.speechThresholdDb + 2,
            )
          : 0;
        const bodyAuthority =
          hasAttachedOnsetEvidence && input.speechBodyFrameDb?.length === frameCount
            ? smoothUnitRamp(
                speechBodyFrameDb[frame] ?? -120,
                input.speechThresholdDb - 8,
                input.speechThresholdDb + 2,
              )
            : 0;
        const fricativeAuthority =
          hasAttachedOnsetEvidence && fricativeFrameDb
            ? smoothUnitRamp(
                (fricativeFrameDb[frame] ?? -120) - fricativeEvidenceFloorDb,
                0,
                12,
              )
            : 0;
        const speechOwnershipAuthority =
          1 -
          (1 - rawAuthority) *
            (1 - bodyAuthority) *
            (1 - fricativeAuthority);
        const handoffAuthority = Math.max(weight, speechOwnershipAuthority);
        gainDbCurve[frame] =
          attackTargetGainDb +
          (plannedFrameGainDb - attackTargetGainDb) * handoffAuthority;
      }
    }

    const nextRunStart = r + 1 < runMeta.length ? runMeta[r + 1].detectedStartFrame : frameCount;
    const bodyGainAtEnd = gainDbCurve[endFrame - 1];
    const softTailEndFrame = resolveSoftTailRescueEndFrame(runMeta[r], nextRunStart);
    protectedEndFrameByRun[r] = softTailEndFrame;
    if (softTailEndFrame > endFrame) {
      for (let f = endFrame; f < softTailEndFrame; f += 1) {
        gainDbCurve[f] = bodyGainAtEnd;
      }
      const rescuedFrames = softTailEndFrame - endFrame;
      tailRescueRunCount += 1;
      tailRescueFrameCount += rescuedFrames;
      tailRescueMaxFrames = Math.max(tailRescueMaxFrames, rescuedFrames);
    }

    const releaseStart = softTailEndFrame;
    const releaseEnd = Math.min(softTailEndFrame + releaseFrames, nextRunStart);
    const releaseLen = releaseEnd - releaseStart;
    for (let k = 0; k < releaseLen; k += 1) {
      const t = (k + 1) / (releaseLen + 1); // 0 just after run → 1 deep in silence
      const weight = Math.cos((t * Math.PI) / 2) ** 2; // cos² falling
      gainDbCurve[releaseStart + k] =
        silenceGainDefaultDb + (bodyGainAtEnd - silenceGainDefaultDb) * weight;
    }
  }

  // 6) Preserve the explicit attack/release shapes, then continuously relax
  //    only short downward concavities created by the centered micro-ride.
  //    Symmetric context rejects a simple level trend, and lift-only response
  //    cannot create a new dip or attenuate a performance transient.
  const valleyRelaxed = relaxNarrowBodySpeechGainValleys(
    gainDbCurve,
    input.frameDb,
    runMeta
      .filter(({ runClass }) => runClass === "body-speech")
      .map(({ startFrame, endFrame }) => ({ startFrame, endFrame })),
    frameMs,
  );
  // 6b) A detector can still merge a recorded bed and sparse performance
  //      moments into one body run. Continuously return only excessive
  //      positive gain to the source-owned event; never apply negative gain.
  const embeddedLimited = limitEmbeddedPerformancePositiveGainAuthority(
    valleyRelaxed,
    embeddedPerformanceFrameDb,
    runMeta
      .filter(({ runClass }) => runClass === "body-speech")
      .map(({ startFrame, endFrame }) => ({ startFrame, endFrame })),
    targetDb,
    frameMs,
  );
  const trendBalanced = balanceExtremeBodySpeechTrends(
    embeddedLimited,
    speechBodyFrameDb,
    runMeta
      .filter(({ runClass }) => runClass === "body-speech")
      .map(({ startFrame, endFrame }) => ({ startFrame, endFrame })),
    input.noiseFloorDb,
    maxGainDb,
    frameMs,
  );
  const recurrentSupported = recoverRecurrentBodySpeechValleys(
    trendBalanced,
    input.frameDb,
    speechBodyFrameDb,
    runMeta
      .filter(({ runClass }) => runClass === "body-speech")
      .map(({ startFrame, endFrame }) => ({ startFrame, endFrame })),
    maxGainDb,
    frameMs,
  );
  const bodySpeechRuns = runMeta
    .filter(({ runClass }) => runClass === "body-speech")
    .map(({ startFrame, endFrame }) => ({ startFrame, endFrame }));
  const wordScaleSupported = stabilizeRecurrentWordScaleBody(
    recurrentSupported,
    input.frameDb,
    speechBodyFrameDb,
    bodySpeechRuns,
    input.noiseFloorDb,
    maxGainDb,
    input.instabilityHint,
    frameMs,
  );
  const slewed = projectWordScaleGainWithoutWorseningEdges(
    recurrentSupported,
    wordScaleSupported,
    bodySpeechRuns,
  );

  // 7) LOCALIZED absolute-peak guard.
  //
  // The former body-relative branch made source-blind 6-10 dB decisions on
  // short syllables and created the reported intra-word down/up movement. It
  // is intentionally absent: processing-added consonant contrast is judged
  // later against the native-rate source. Here we retain only absolute peak
  // safety and continuously limit its broadband envelope by real RMS headroom.
  const peakDipFrames = Math.max(1, Math.round(40 / frameMs));
  const peakReductionDbByRun = new Array<number>(runMeta.length).fill(0);
  const runIndexByFrame = new Array<number>(frameCount).fill(-1);
  for (let r = 0; r < runMeta.length; r += 1) {
    for (let f = runMeta[r].startFrame; f < runMeta[r].endFrame; f += 1) {
      runIndexByFrame[f] = r;
    }
  }
  const dipDbByFrame = new Float32Array(frameCount);
  const peakOwnerDipDbByFrame = new Float32Array(frameCount);
  const speechSpikeFrameCount = 0;
  const speechSpikeMaxReductionDb = 0;
  let sustainedClusterTamedCount = 0;
  let sustainedClusterMaxReductionDbOut = 0;
  if (framePeakDb) {
    for (let f = 0; f < frameCount; f += 1) {
      const currentGainDb = slewed[f];
      const runIdx = runIndexByFrame[f];
      const runMetaForFrame = runIdx >= 0 ? runMeta[runIdx] : null;
      const isPerformanceTransient = runMetaForFrame?.runClass === "transient-breath";
      // The transient ceiling follows exactly the body-owned macro recovery.
      // Applied gain and ceiling therefore rise together: the existing peak
      // reduction is retained rather than self-cancelling the restored word
      // or loosening its spike contrast.
      const transientBodyRecoveryForFrameDb =
        isPerformanceTransient && runIdx >= 0
          ? transientBodyRecoveryDb[runIdx] ?? 0
          : 0;
      const transientRetainedAdvantageForFrameDb =
        isPerformanceTransient && runIdx >= 0
          ? transientRetainedAdvantageDb[runIdx] ?? 0
          : 0;
      const localPeakCeilingDb = isPerformanceTransient
        ? Math.min(
            peakCeilingDb,
            targetDb +
              8 +
              transientBodyRecoveryForFrameDb +
              transientRetainedAdvantageForFrameDb,
          )
        : peakCeilingDb;
      const appliedPeakDb = framePeakDb[f] + currentGainDb;
      const reductionDb = Math.max(0, appliedPeakDb - localPeakCeilingDb);

      if (reductionDb <= 0) continue;
      peakOwnerDipDbByFrame[f] = Math.max(
        peakOwnerDipDbByFrame[f],
        reductionDb,
      );
      // Apply cosine dip from -peakDipFrames..+peakDipFrames around f.
      for (let k = -peakDipFrames; k <= peakDipFrames; k += 1) {
        const idx = f + k;
        if (idx < 0 || idx >= frameCount) continue;
        if (
          runMetaForFrame &&
          (isPerformanceTransient || runMetaForFrame.runClass === "body-speech") &&
          (idx < runMetaForFrame.startFrame || idx >= runMetaForFrame.endFrame)
        ) {
          continue;
        }
        // Cosine weight peaks at k=0 (full reduction) and falls to 0 at edges.
        const t = Math.abs(k) / (peakDipFrames + 1);
        const weight = Math.cos((t * Math.PI) / 2) ** 2;
        dipDbByFrame[idx] = Math.max(dipDbByFrame[idx], reductionDb * weight);
      }
      // Track for diagnostics: the worst dip applied within each run.
      if (runIdx >= 0) {
        peakReductionDbByRun[runIdx] = Math.min(peakReductionDbByRun[runIdx], -reductionDb);
      }
    }

  }

  // Dense body-owned peaks can make neighboring peak envelopes overlap into
  // a phrase-wide broadband dip. Continuously relax only that overlap toward
  // each real peak owner's required dip; the owner itself, the class-plan
  // ceiling, and the absolute global peak ceiling remain intact.
  if (framePeakDb && input.speechBodyFrameDb?.length === frameCount) {
    for (let r = 0; r < runMeta.length; r += 1) {
      const meta = runMeta[r];
      let bodyShareSum = 0;
      let bodyShareCount = 0;
      for (let frame = meta.startFrame; frame < meta.endFrame; frame += 1) {
        const rawDb = input.frameDb[frame];
        const bodyDb = speechBodyFrameDb[frame];
        if (!Number.isFinite(rawDb) || !Number.isFinite(bodyDb)) continue;
        bodyShareSum += clamp(Math.pow(10, (bodyDb - rawDb) / 10), 0, 1);
        bodyShareCount += 1;
      }
      const bodyShare = bodyShareCount > 0 ? bodyShareSum / bodyShareCount : 0;
      const relaxationAuthority =
        1 -
        Math.exp(
          -DENSE_BODY_PEAK_RELAXATION_CURVE *
            bodyShare *
            clamp(meta.hotFrameRatio, 0, 1),
        );
      const plannedGainDb = plannedRunGainDb[r] ?? 0;
      for (let frame = meta.startFrame; frame < meta.endFrame; frame += 1) {
        const requestedDipDb = dipDbByFrame[frame];
        if (!(requestedDipDb > 0)) continue;
        const globalPeakSafetyDipDb = Math.max(
          0,
          framePeakDb[frame] + slewed[frame] - peakCeilingDb,
        );
        const classPlanCapDipDb = Math.max(0, slewed[frame] - plannedGainDb);
        const requiredDipDb = Math.max(
          peakOwnerDipDbByFrame[frame],
          globalPeakSafetyDipDb,
          classPlanCapDipDb,
        );
        dipDbByFrame[frame] =
          requestedDipDb +
          (Math.min(requestedDipDb, requiredDipDb) - requestedDipDb) *
            relaxationAuthority;
      }
    }
  }

  // A frame-wide absolute-peak correction can spend only its RMS headroom
  // above the planned body. Flat speech therefore receives at most 0.6 dB of
  // broadband movement, while a genuinely hot frame can still protect the
  // ceiling. This has no event-duration or percentile engagement boundary.
  for (let r = 0; r < runMeta.length; r += 1) {
    const meta = runMeta[r];
    if (meta.runClass !== "body-speech") continue;
    const plannedBodyDb = meta.meanDb + (plannedRunGainDb[r] ?? 0);
    for (let f = meta.startFrame; f < meta.endFrame; f += 1) {
      const requestedDipDb = dipDbByFrame[f];
      if (requestedDipDb <= 0) continue;
      const preDipAppliedDb = input.frameDb[f] + slewed[f];
      const envelopeSupportedDipDb = Math.max(
        0,
        preDipAppliedDb - (plannedBodyDb - BODY_SPIKE_MAX_CREATED_ENVELOPE_LOSS_DB),
      );
      dipDbByFrame[f] = Math.min(requestedDipDb, envelopeSupportedDipDb);
    }
  }

  // 7b) POST-CLAMP RESIDUAL pass for body-speech runs.
  //
  // Runs OUTSIDE the framePeakDb branch above so it fires whether or not
  // the caller supplied raw samples — the residual check only needs the
  // planned gain and raw-domain frame body, both of which are always
  // available.
  //
  // The source-adaptive macro target plus its continuously widened attenuation
  // window catches MOST loud vocalizations, but for an EXTREMELY loud source
  // the class-aware clamp can still saturate. This pass detects
  // post-clamp residual loudness per-run and applies a uniform
  // additional attenuation (with cosine fade at run edges).
  //
  // Only triggers when:
  //   - body-speech run (transient-breath has its own asymmetric clamp)
  //   - applied body exceeds target by ≥ 3 dB after planning
  //   - speechSpikeTaming ≥ 0.3 (always true under the raised floor)
  //
  // Capped at 5 dB to stay subtle. Goal is "sit with dialogue", not
  // "duck below".
  let sustainedClusterCount = 0;
  let sustainedMaxReductionDb = 0;
  if (speechSpikeTaming >= 0.3) {
    const fadeFrames = Math.max(2, Math.round(50 / frameMs));
    for (let r = 0; r < runMeta.length; r += 1) {
      const meta = runMeta[r];
      if (meta.runClass !== "body-speech") continue;
      const plannedGain = plannedRunGainDb[r] ?? 0;
      const appliedBodyDb = meta.meanDb + plannedGain;
      const residualOverDb = appliedBodyDb - targetDb;
      if (residualOverDb < 3) continue;
      // Scale: residual 3 dB → ~0.7 dB cut, residual 10 dB → ~4.7 dB cut.
      const reductionDb = clamp(
        (residualOverDb - 1.5) * (0.55 + speechSpikeTaming * 0.2),
        0,
        5,
      );
      if (reductionDb < 0.4) continue;
      for (let f = meta.startFrame; f < meta.endFrame; f += 1) {
        let weight = 1;
        const distFromStart = f - meta.startFrame;
        const distFromEnd = meta.endFrame - 1 - f;
        const distFromEdge = Math.min(distFromStart, distFromEnd);
        if (distFromEdge < fadeFrames) {
          const t = (distFromEdge + 1) / (fadeFrames + 1);
          weight = Math.sin((t * Math.PI) / 2) ** 2;
        }
        dipDbByFrame[f] = Math.max(dipDbByFrame[f], reductionDb * weight);
      }
      sustainedClusterCount += 1;
      sustainedMaxReductionDb = Math.max(sustainedMaxReductionDb, reductionDb);
      if (peakReductionDbByRun[r] > -reductionDb) {
        peakReductionDbByRun[r] = -reductionDb;
      }
    }
  }

  const projectedRunRmsDb = (meta: RunEntry) => {
    let sumPower = 0;
    let count = 0;
    for (let f = meta.startFrame; f < meta.endFrame; f += 1) {
      const appliedFrameDb = input.frameDb[f] + slewed[f] - dipDbByFrame[f];
      if (!Number.isFinite(appliedFrameDb)) continue;
      sumPower += Math.pow(10, appliedFrameDb / 10);
      count += 1;
    }
    return count > 0 ? 10 * Math.log10(sumPower / count + 1e-30) : -120;
  };

  // Local spike dips should not make a whole dialogue body sound crushed.
  // Keep enough of the dip to remove visible/audible spikes, but relax it
  // when the run-level RMS would fall below both the source-relative floor
  // and the house dialogue floor.
  for (let r = 0; r < runMeta.length; r += 1) {
    const meta = runMeta[r];
    if (meta.runClass !== "body-speech") continue;

    const projectedDb = projectedRunRmsDb(meta);
    const sourceRunDb = rmsDbOfSlice(input.frameDb, meta.startFrame, meta.endFrame);
    const runFloorDb = Math.max(
      sourceRunDb - BODY_SPIKE_MAX_RUN_LOSS_DB,
      targetDb - BODY_SPIKE_RUN_FLOOR_OFFSET_DB,
    );
    if (projectedDb >= runFloorDb) continue;

    const restoreDb = runFloorDb - projectedDb;
    let maxRemainingDipDb = 0;
    for (let f = meta.startFrame; f < meta.endFrame; f += 1) {
      if (dipDbByFrame[f] > 0) {
        dipDbByFrame[f] = Math.max(0, dipDbByFrame[f] - restoreDb);
      }
      maxRemainingDipDb = Math.max(maxRemainingDipDb, dipDbByFrame[f]);
    }
    peakReductionDbByRun[r] = maxRemainingDipDb > 0 ? -maxRemainingDipDb : 0;
  }

  // Recompute run diagnostics after every non-destructive relaxation.
  for (let r = 0; r < runMeta.length; r += 1) {
    let maxAppliedDipDb = 0;
    for (let f = runMeta[r].startFrame; f < runMeta[r].endFrame; f += 1) {
      maxAppliedDipDb = Math.max(maxAppliedDipDb, dipDbByFrame[f]);
    }
    peakReductionDbByRun[r] = maxAppliedDipDb > 0 ? -maxAppliedDipDb : 0;
  }

  // Final dip application covers absolute-peak safety and the uniform residual
  // pass. Phrase-scale gain is already bounded by its class-aware run clamp.
  // Soft-limit only the additional local/residual decision so the former 6 dB
  // safety budget cannot accidentally cap an entire loud phrase.
  for (let f = 0; f < frameCount; f += 1) {
    const boundedAdditionalDipDb = -softLimitNegativePlannerGainDb(
      -Math.max(0, dipDbByFrame[f]),
      LOCAL_PLANNER_DIP_SOFT_LIMIT_DB,
    );
    slewed[f] -= boundedAdditionalDipDb;
  }

  // Stash diagnostics for the caller (logged via PlannedGain output).
  sustainedClusterTamedCount = sustainedClusterCount;
  sustainedClusterMaxReductionDbOut = sustainedMaxReductionDb;

  // 8) Convert to linear.
  const gainCurve = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) gainCurve[i] = dbToLin(slewed[i]);

  const breathRunCount = runMeta.filter((m) => m.runClass === "transient-breath").length;
  return {
    gainCurve,
    runs: runMeta.map((m, i) => ({
      startFrame: m.startFrame,
      endFrame: m.endFrame,
      meanDb: m.meanDb,
      crestDb: m.crestDb,
      plannedGainDb: plannedRunGainDb[i] ?? 0,
      peakReducedDb: peakReductionDbByRun[i] ?? 0,
      runClass: m.runClass,
      bodyOwnershipAuthority: m.bodyOwnershipAuthority,
      transientBodyRecoveryDb: transientBodyRecoveryDb[i] ?? 0,
      transientRetainedAdvantageDb: transientRetainedAdvantageDb[i] ?? 0,
    })),
    expanderDepthDb,
    targetDb,
    microRideDb,
    breathRunCount,
    speechSpikeFrameCount,
    speechSpikeMaxReductionDb,
    sustainedLoudClusterCount: sustainedClusterTamedCount,
    sustainedLoudMaxReductionDb: sustainedClusterMaxReductionDbOut,
    earlyRunCapCount,
    earlyRunMaxReductionDb,
    coldOpenLiftCount,
    coldOpenLiftMaxDb,
    tailRescueRunCount,
    tailRescueFrameCount,
    tailRescueMaxMs: tailRescueMaxFrames * frameMs,
  };
};

/**
 * Apply a per-frame linear gain curve directly to samples.
 * Works in place if `outSamples` is `samples`, otherwise writes into `outSamples`.
 * Linearly interpolates gain between frame midpoints so there are no zipper artifacts.
 */
export const applyGainCurveToSamples = (
  samples: Float32Array,
  gainCurve: Float32Array,
  sampleRate: number,
  channels: number,
  frameMs: number,
  outSamples?: Float32Array,
  frameOffsetFrames = 0,
): Float32Array => {
  const out = outSamples ?? new Float32Array(samples.length);
  const samplesPerFrame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const framesPerSec = 1000 / frameMs;
  const centerOffset = samplesPerFrame / 2;
  const safeFrameOffsetFrames = Number.isFinite(frameOffsetFrames)
    ? frameOffsetFrames
    : 0;
  const totalFrames = gainCurve.length;
  const sampleCount = samples.length;
  const frameCountByChannel = Math.floor(sampleCount / channels);

  for (let sIdx = 0; sIdx < frameCountByChannel; sIdx += 1) {
    // position in frame units, offset so gains line up at frame midpoints
    const framePos =
      (sIdx - centerOffset) / samplesPerFrame + safeFrameOffsetFrames;
    const f0 = Math.max(0, Math.min(totalFrames - 1, Math.floor(framePos)));
    const f1 = Math.max(0, Math.min(totalFrames - 1, f0 + 1));
    const mix = Math.max(0, Math.min(1, framePos - f0));
    const gainLin = gainCurve[f0] * (1 - mix) + gainCurve[f1] * mix;
    for (let c = 0; c < channels; c += 1) {
      const i = sIdx * channels + c;
      out[i] = samples[i] * gainLin;
    }
  }
  // unused var kept for API clarity
  void framesPerSec;
  return out;
};

export type RenderedConsonantTamerStats = {
  tamedFrameCount: number;
  maxReductionDb: number;
  referenceLagMs: number;
  /** True only when source alignment was trustworthy enough to authorize the optional tamer. */
  referenceUsed: boolean;
  /** Alignment confidence in [0, 1]; low or ambiguous evidence always fails open. */
  referenceConfidence: number;
};

export type RenderedConsonantReference = Readonly<{
  /** Sample rate of the source evidence used to build this compact envelope. */
  sampleRate: number;
  frameMs: number;
  durationSec: number;
  rmsDb: Float32Array;
  peakDb: Float32Array;
}>;

export type RenderedConsonantTamerOptions = Readonly<{
  /** Time-aligned source samples used to distinguish native articulation from render-created contrast. */
  referenceSamples?: Float32Array;
  referenceSampleRate?: number;
  /** Compact source envelope for reuse across final delivery transforms. */
  reference?: RenderedConsonantReference;
  /** Small timing tolerance for filter or resample latency; defaults to 20 ms. */
  referenceMatchWindowMs?: number;
  /** Optional cap for residual passes after a later delivery transform. */
  maxReductionDb?: number;
  /** Absolute analysis-frame offset used by bounded chunk processing. */
  analysisFrameOffset?: number;
}>;

const measureFrameRmsAndPeak = (
  samples: Float32Array,
  sampleRate: number,
  frameMs: number,
  frameOffset = 0,
) => {
  const samplesPerFrame = Math.max(1, (sampleRate * frameMs) / 1000);
  const baseSample = Math.round(frameOffset * samplesPerFrame);
  const frameBoundary = (frame: number) => (
    Math.round((frameOffset + frame) * samplesPerFrame) - baseSample
  );
  let frameCount = Math.max(1, Math.ceil(samples.length / samplesPerFrame));
  while (frameCount > 1 && frameBoundary(frameCount - 1) >= samples.length) {
    frameCount -= 1;
  }
  while (frameBoundary(frameCount) < samples.length) {
    frameCount += 1;
  }
  const rmsDb = new Array<number>(frameCount);
  const peakDb = new Array<number>(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    // Derive every boundary from absolute time. Rounding 88.2 samples to a
    // fixed 88-sample stride at 44.1 kHz would drift by more than 120 ms in a
    // minute; absolute boundaries distribute the fractional samples without
    // accumulating timing error.
    const start = Math.min(samples.length, frameBoundary(frame));
    const end = Math.min(
      samples.length,
      Math.max(start + 1, frameBoundary(frame + 1)),
    );
    let sum = 0;
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      const sample = samples[index];
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const count = Math.max(1, end - start);
    const rms = Math.sqrt(sum / count);
    rmsDb[frame] = rms > 0 ? 20 * Math.log10(rms) : -120;
    peakDb[frame] = peak > 0 ? 20 * Math.log10(peak) : -120;
  }

  return { rmsDb, peakDb, samplesPerFrame, frameCount };
};

const renderedLocalBodyDb = (
  frameDb: ArrayLike<number>,
  centerFrame: number,
  windowFrames: number,
) => {
  const values: number[] = [];
  const start = Math.max(0, centerFrame - windowFrames);
  const end = Math.min(frameDb.length, centerFrame + windowFrames + 1);
  for (let frame = start; frame < end; frame += 1) {
    const value = frameDb[frame];
    if (Number.isFinite(value) && value >= -58) {
      values.push(value);
    }
  }
  if (values.length === 0) return frameDb[centerFrame] ?? -120;
  values.sort((left, right) => left - right);
  const trimmedEnd = Math.max(1, Math.ceil(values.length * 0.72));
  const trimmed = values.slice(0, trimmedEnd);
  return trimmed[Math.floor(trimmed.length * 0.6)] ?? values[Math.floor(values.length / 2)] ?? frameDb[centerFrame] ?? -120;
};

export const buildRenderedConsonantReference = (
  samples: Float32Array,
  sampleRate: number,
  frameMs = RENDERED_CONSONANT_SOURCE_FRAME_MS,
): RenderedConsonantReference | null => {
  if (
    samples.length === 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(frameMs) ||
    frameMs <= 0
  ) {
    return null;
  }
  const measured = measureFrameRmsAndPeak(samples, sampleRate, frameMs);
  return {
    sampleRate,
    frameMs,
    durationSec: samples.length / sampleRate,
    rmsDb: Float32Array.from(measured.rmsDb),
    peakDb: Float32Array.from(measured.peakDb),
  };
};

const estimateRenderedReferenceLagFrames = (
  renderedRmsDb: ArrayLike<number>,
  renderedPeakDb: ArrayLike<number>,
  referenceRmsDb: ArrayLike<number>,
  referencePeakDb: ArrayLike<number>,
  frameMs: number,
): { lagFrames: number; confidence: number; ambiguous: boolean } => {
  const maxLagFrames = Math.min(
    Math.max(0, Math.round(RENDERED_CONSONANT_REFERENCE_ALIGNMENT_MAX_MS / frameMs)),
    Math.max(0, Math.floor(Math.min(renderedRmsDb.length, referenceRmsDb.length) / 4)),
  );
  if (maxLagFrames <= 0) return { lagFrames: 0, confidence: 0, ambiguous: true };

  // Remove the stable voice body's crest baseline before correlation. This
  // retains the timing fingerprint of short consonants without allowing two
  // unrelated tonal beds to look confidently aligned.
  const renderedActivity = new Float32Array(renderedRmsDb.length);
  const referenceActivity = new Float32Array(referenceRmsDb.length);
  const localWindowFrames = Math.max(1, Math.round(RENDERED_CONSONANT_LOCAL_WINDOW_MS / frameMs));
  let renderedEnergy = 0;
  let referenceEnergy = 0;
  for (let frame = 0; frame < renderedActivity.length; frame += 1) {
    const peak = renderedPeakDb[frame] ?? -120;
    const rms = renderedRmsDb[frame] ?? -120;
    const contrastDb = peak - renderedLocalBodyDb(renderedRmsDb, frame, localWindowFrames);
    const crestDb = peak - rms;
    const activity = clamp(
      Math.max(0, contrastDb - 6) + Math.max(0, crestDb - 10) * 0.35,
      0,
      30,
    );
    renderedActivity[frame] = activity;
    renderedEnergy += activity * activity;
  }
  for (let frame = 0; frame < referenceActivity.length; frame += 1) {
    const peak = referencePeakDb[frame] ?? -120;
    const rms = referenceRmsDb[frame] ?? -120;
    const contrastDb = peak - renderedLocalBodyDb(referenceRmsDb, frame, localWindowFrames);
    const crestDb = peak - rms;
    const activity = clamp(
      Math.max(0, contrastDb - 6) + Math.max(0, crestDb - 10) * 0.35,
      0,
      30,
    );
    referenceActivity[frame] = activity;
    referenceEnergy += activity * activity;
  }
  if (renderedEnergy <= 1e-6 || referenceEnergy <= 1e-6) {
    return { lagFrames: 0, confidence: 0, ambiguous: true };
  }

  const correlationByLag = new Map<number, number>();
  let bestLag = 0;
  let bestCorrelation = 0;
  let bestAdjustedScore = Number.NEGATIVE_INFINITY;
  for (let lag = -maxLagFrames; lag <= maxLagFrames; lag += 1) {
    let dot = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let referenceFrame = 0; referenceFrame < referenceActivity.length; referenceFrame += 1) {
      const renderedFrame = referenceFrame + lag;
      if (renderedFrame < 0 || renderedFrame >= renderedActivity.length) continue;
      const left = referenceActivity[referenceFrame];
      const right = renderedActivity[renderedFrame];
      if (left <= 0 && right <= 0) continue;
      dot += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const correlation = leftEnergy > 1e-9 && rightEnergy > 1e-9
      ? dot / Math.sqrt(leftEnergy * rightEnergy)
      : 0;
    correlationByLag.set(lag, correlation);
    // A light zero-lag prior avoids inventing timing movement when the crest
    // pattern is flat or repetitive; strong matching evidence still wins.
    const adjustedScore = correlation - (Math.abs(lag) / Math.max(maxLagFrames, 1)) * 0.025;
    if (
      adjustedScore > bestAdjustedScore + 1e-9 ||
      (Math.abs(adjustedScore - bestAdjustedScore) <= 1e-9 && Math.abs(lag) < Math.abs(bestLag))
    ) {
      bestAdjustedScore = adjustedScore;
      bestLag = lag;
      bestCorrelation = correlation;
    }
  }

  // Adjacent lag bins commonly describe the same 10-20 ms event. Compare the
  // winner only with non-local alternatives so a broad consonant does not look
  // ambiguous, while two distinct equally plausible alignments still do.
  const sameEventRadiusFrames = Math.max(
    1,
    Math.round(RENDERED_CONSONANT_REFERENCE_MATCH_WINDOW_MS / frameMs),
  );
  let competingCorrelation = 0;
  for (const [lag, correlation] of correlationByLag) {
    if (Math.abs(lag - bestLag) <= sameEventRadiusFrames) continue;
    competingCorrelation = Math.max(competingCorrelation, correlation);
  }
  const separation = bestCorrelation - competingCorrelation;
  const separationConfidence = clamp((separation + 0.05) / 0.2, 0, 1);
  const confidence = clamp(bestCorrelation * separationConfidence, 0, 1);
  const ambiguous = bestCorrelation < 0.35 || separation < 0.03;
  return { lagFrames: bestLag, confidence, ambiguous };
};

/**
 * Full-rate consonant peak polish for planner-leveled audio.
 *
 * The planner computes its gain curve from a low-rate envelope to keep long
 * files memory-safe. That envelope can under-represent single-sample or
 * high-frequency consonant peaks that survive in the 48 kHz render. This
 * pass runs after planner gain is applied, using the actual render samples,
 * and only applies short local dips to isolated peak frames whose peak sits
 * far above the surrounding speech body. It intentionally avoids broadband
 * compression, so actor tone and sentence dynamics stay intact.
 */
export const tameRenderedConsonantPeaks = (
  samples: Float32Array,
  sampleRate: number,
  frameMs = RENDERED_CONSONANT_FRAME_MS,
  options: RenderedConsonantTamerOptions = {},
): { samples: Float32Array; stats: RenderedConsonantTamerStats } => {
  const out = new Float32Array(samples);
  const noOpStats = (
    referenceLagMs = 0,
    referenceUsed = false,
    referenceConfidence = 0,
  ): RenderedConsonantTamerStats => ({
    tamedFrameCount: 0,
    maxReductionDb: 0,
    referenceLagMs,
    referenceUsed,
    referenceConfidence,
  });
  if (
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(frameMs) ||
    frameMs <= 0 ||
    samples.length === 0
  ) {
    return { samples: out, stats: noOpStats() };
  }

  const requestedMaxReductionDb = Number.isFinite(options.maxReductionDb)
    ? clamp(options.maxReductionDb as number, 0, RENDERED_CONSONANT_MAX_REDUCTION_DB)
    : RENDERED_CONSONANT_MAX_REDUCTION_DB;
  const referenceRequested = options.reference !== undefined || options.referenceSamples !== undefined;
  const referenceSampleRate = options.referenceSampleRate ?? sampleRate;
  const inlineReference = options.referenceSamples
    ? buildRenderedConsonantReference(
        options.referenceSamples,
        referenceSampleRate,
        RENDERED_CONSONANT_SOURCE_FRAME_MS,
      )
    : null;
  const suppliedReference = options.reference ?? inlineReference;
  const referenceDurationSec = suppliedReference?.durationSec ?? 0;
  const renderedDurationSec = samples.length / sampleRate;
  const referenceDurationToleranceSec = Math.max(
    0.05,
    ((options.referenceMatchWindowMs ?? RENDERED_CONSONANT_REFERENCE_MATCH_WINDOW_MS) * 2) / 1000,
  );
  const referenceMetrics =
    suppliedReference &&
    Number.isFinite(suppliedReference.sampleRate) &&
    suppliedReference.sampleRate > 0 &&
    Number.isFinite(suppliedReference.frameMs) &&
    suppliedReference.frameMs > 0 &&
    suppliedReference.frameMs <= RENDERED_CONSONANT_SOURCE_FRAME_MS &&
    Number.isFinite(referenceDurationSec) &&
    referenceDurationSec > 0 &&
    suppliedReference.rmsDb.length > 0 &&
    suppliedReference.peakDb.length > 0 &&
    suppliedReference.rmsDb.length === suppliedReference.peakDb.length &&
    Math.abs(referenceDurationSec - renderedDurationSec) <= referenceDurationToleranceSec
      ? suppliedReference
      : null;
  // A caller that supplied a source asked for source-relative behavior. If that
  // source cannot be compared safely, preserve the render instead of silently
  // falling back to the more aggressive source-blind legacy tamer.
  if (referenceRequested && !referenceMetrics) {
    return { samples: out, stats: noOpStats() };
  }
  // Keep the 10 ms legacy analysis for source-blind callers. Source-relative
  // decisions use the compact reference's finer event resolution so adjacent
  // consonants cannot share one attenuation decision.
  const analysisFrameMs = referenceMetrics?.frameMs ?? frameMs;
  const analysisFrameOffset = Number.isSafeInteger(options.analysisFrameOffset)
    && (options.analysisFrameOffset ?? 0) >= 0
    ? options.analysisFrameOffset ?? 0
    : 0;
  const { rmsDb, peakDb, samplesPerFrame, frameCount } = measureFrameRmsAndPeak(
    samples,
    sampleRate,
    analysisFrameMs,
    analysisFrameOffset,
  );
  const localWindowFrames = Math.max(
    1,
    Math.round(RENDERED_CONSONANT_LOCAL_WINDOW_MS / analysisFrameMs),
  );
  const dipRadiusFrames = Math.max(
    1,
    Math.round(RENDERED_CONSONANT_DIP_RADIUS_MS / analysisFrameMs),
  );
  const referenceFrameMs = referenceMetrics?.frameMs ?? frameMs;
  const referenceAlignment = referenceMetrics
    ? estimateRenderedReferenceLagFrames(
        rmsDb,
        peakDb,
        referenceMetrics.rmsDb,
        referenceMetrics.peakDb,
        referenceFrameMs,
      )
    : { lagFrames: 0, confidence: 0, ambiguous: false };
  const renderedReferenceLagFrames = referenceAlignment.lagFrames;
  const referenceLagMs = renderedReferenceLagFrames * referenceFrameMs;
  const referenceUsed = Boolean(
    referenceMetrics &&
    !referenceAlignment.ambiguous &&
    referenceAlignment.confidence >= RENDERED_CONSONANT_REFERENCE_MIN_CONFIDENCE
  );
  if (referenceRequested && !referenceUsed) {
    return {
      samples: out,
      stats: noOpStats(referenceLagMs, false, referenceAlignment.confidence),
    };
  }
  const referenceMatchFrames = Math.max(
    0,
    Math.round(
      (options.referenceMatchWindowMs ?? RENDERED_CONSONANT_REFERENCE_MATCH_WINDOW_MS) / referenceFrameMs,
    ),
  );
  const sourceEvidenceAuthority = (contrastDb: number, crestDb: number) => {
    const continuousWeakToStrong = (
      value: number,
      start: number,
      weak: number,
      strongStart: number,
      full: number,
    ) => {
      if (value <= weak) return 0.5 * smoothUnitRamp(value, start, weak);
      if (value <= strongStart) return 0.5;
      return 0.5 + 0.5 * smoothUnitRamp(value, strongStart, full);
    };
    const fullBandwidthEvidence = Math.max(
      continuousWeakToStrong(
        contrastDb,
        RENDERED_CONSONANT_SOURCE_CONTRAST_START_DB,
        RENDERED_CONSONANT_SOURCE_CONTRAST_WEAK_DB,
        RENDERED_CONSONANT_SOURCE_CONTRAST_STRONG_START_DB,
        RENDERED_CONSONANT_SOURCE_CONTRAST_FULL_DB,
      ),
      continuousWeakToStrong(
        crestDb,
        RENDERED_CONSONANT_SOURCE_CREST_START_DB,
        RENDERED_CONSONANT_SOURCE_CREST_WEAK_DB,
        RENDERED_CONSONANT_SOURCE_CREST_STRONG_START_DB,
        RENDERED_CONSONANT_SOURCE_CREST_FULL_DB,
      ),
    );
    const bandwidthLimitedStrongEvidence = Math.max(
      smoothUnitRamp(
        contrastDb,
        RENDERED_CONSONANT_SOURCE_CONTRAST_STRONG_START_DB,
        RENDERED_CONSONANT_SOURCE_CONTRAST_FULL_DB,
      ),
      smoothUnitRamp(
        crestDb,
        RENDERED_CONSONANT_SOURCE_CREST_STRONG_START_DB,
        RENDERED_CONSONANT_SOURCE_CREST_FULL_DB,
      ),
    );
    const weakEvidenceBandwidthAuthority = referenceMetrics
      ? smoothUnitRamp(
          referenceMetrics.sampleRate / sampleRate,
          RENDERED_CONSONANT_WEAK_BANDWIDTH_START_RATIO,
          RENDERED_CONSONANT_FULL_BANDWIDTH_RATIO,
        )
      : 0;
    return Math.max(
      bandwidthLimitedStrongEvidence,
      fullBandwidthEvidence * weakEvidenceBandwidthAuthority,
    );
  };
  const referenceEvidenceCache: Array<
    { contrastDb: number; crestDb: number; maxReductionDb: number } | undefined
  > = referenceMetrics ? new Array(referenceMetrics.rmsDb.length) : [];
  const resolveReferencePeakOverBodyDb = (
    renderedFrame: number,
    renderedContrastDb: number,
  ) => {
    if (!referenceMetrics || referenceMetrics.rmsDb.length <= 0 || referenceMetrics.peakDb.length <= 0) return null;
    const centerTimeSec = ((renderedFrame + 0.5) * analysisFrameMs) / 1000;
    const referenceCenterFrame = Math.round(
      (centerTimeSec * 1000) / referenceFrameMs - 0.5 - renderedReferenceLagFrames,
    );
    const startFrame = Math.max(0, referenceCenterFrame - referenceMatchFrames);
    const endFrame = Math.min(referenceMetrics.rmsDb.length - 1, referenceCenterFrame + referenceMatchFrames);
    if (startFrame > endFrame) return null;
    const referenceLocalWindowFrames = Math.max(
      1,
      Math.round(RENDERED_CONSONANT_LOCAL_WINDOW_MS / referenceFrameMs),
    );
    const contrastAtReferenceFrame = (referenceFrame: number) => {
      const cached = referenceEvidenceCache[referenceFrame];
      if (cached) return cached;
      const referencePeakDb = referenceMetrics.peakDb[referenceFrame] ?? -120;
      const referenceRmsDb = referenceMetrics.rmsDb[referenceFrame] ?? -120;
      const referenceBodyDb = renderedLocalBodyDb(
        referenceMetrics.rmsDb,
        referenceFrame,
        referenceLocalWindowFrames,
      );
      const contrastDb = referencePeakDb - referenceBodyDb;
      const crestDb = referencePeakDb - referenceRmsDb;
      const measured = {
        contrastDb,
        crestDb,
        maxReductionDb:
          RENDERED_CONSONANT_SOURCE_MAX_REDUCTION_DB
          * sourceEvidenceAuthority(contrastDb, crestDb),
      };
      referenceEvidenceCache[referenceFrame] = measured;
      return measured;
    };

    // Assign the first trusted time-local match continuously. Exact native
    // evidence consumes the match and protects its owner from neighboring
    // consonants; weak evidence only partially owns it, so an epsilon change
    // cannot replace a trusted adjacent timing match. The unassigned remainder
    // is an explicit no-repair prior, and distance tapers rapidly inside the
    // bounded alignment window so a remote event cannot lend its full budget.
    let unassignedAuthority = 1;
    let blendedReductionDb = 0;
    const potentialReductionDb = (match: { contrastDb: number; maxReductionDb: number }) => clamp(
      renderedContrastDb - match.contrastDb - RENDERED_CONSONANT_SOURCE_ALLOWED_GROWTH_DB,
      0,
      match.maxReductionDb,
    );
    for (let distanceFrames = 0; distanceFrames <= referenceMatchFrames; distanceFrames += 1) {
      let groupMissAuthority = 1;
      let groupEvidenceSum = 0;
      let groupWeightedReductionSum = 0;
      const groupFrames = distanceFrames === 0
        ? [referenceCenterFrame]
        : [referenceCenterFrame - distanceFrames, referenceCenterFrame + distanceFrames];
      for (const referenceFrame of groupFrames) {
        if (referenceFrame < startFrame || referenceFrame > endFrame) continue;
        const { contrastDb, maxReductionDb } = contrastAtReferenceFrame(referenceFrame);
        const evidenceAuthority = clamp(
          maxReductionDb / RENDERED_CONSONANT_SOURCE_MAX_REDUCTION_DB,
          0,
          1,
        );
        groupMissAuthority *= 1 - evidenceAuthority;
        groupEvidenceSum += evidenceAuthority;
        groupWeightedReductionSum += potentialReductionDb({ contrastDb, maxReductionDb })
          * evidenceAuthority;
      }
      if (groupEvidenceSum <= 0) continue;

      const groupAuthority = 1 - groupMissAuthority;
      const groupReductionDb = groupWeightedReductionSum / groupEvidenceSum;
      // The weak-evidence plateau is already a trusted localized source event,
      // so it owns its exact frame fully. Below that plateau ownership fades in
      // smoothly; this is what prevents epsilon evidence from masking a nearby
      // match without letting a native weak consonant borrow from its neighbor.
      const ownershipAuthority = smoothUnitRamp(groupAuthority, 0, 0.5);
      const edgeAuthority = 1 - smoothUnitRamp(
        distanceFrames,
        0,
        referenceMatchFrames + 1,
      );
      const baseLocalityAuthority = edgeAuthority / ((distanceFrames + 1) ** 2);
      // Strong source evidence can absorb one-frame resample/filter movement.
      // Its extra timing trust also fades continuously across the wider search
      // window, so a distant consonant never receives full ownership.
      const strongEvidenceTrust = smoothUnitRamp(groupAuthority, 0.5, 1);
      const nearbyStrongAllowance = 1 - smoothUnitRamp(
        distanceFrames,
        1,
        referenceMatchFrames + 1,
      );
      const localityAuthority = baseLocalityAuthority
        + (1 - baseLocalityAuthority) * strongEvidenceTrust * nearbyStrongAllowance;
      const assignedAuthority = unassignedAuthority * ownershipAuthority * localityAuthority;
      blendedReductionDb += assignedAuthority * groupReductionDb;
      unassignedAuthority *= 1 - ownershipAuthority * localityAuthority;
    }
    if (blendedReductionDb > 0) {
      return { reductionDb: blendedReductionDb };
    }
    // An optional final tamer needs positive, time-local source evidence. A
    // missing event can be a bandwidth-limited reference rather than a defect,
    // so preserve the render instead of inferring authorization from the body.
    return null;
  };
  const dipDbByFrame = new Float32Array(frameCount);
  const sourceRelativeReductionDbByFrame = referenceMetrics ? new Float32Array(frameCount) : null;
  let tamedFrameCount = 0;
  let maxReductionDb = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const peak = peakDb[frame] ?? -120;
    const rms = rmsDb[frame] ?? -120;
    const sourceRelativeAudibilityAuthority = referenceMetrics
      ? Math.min(
          smoothUnitRamp(peak, RENDERED_CONSONANT_AUDIBILITY_PEAK_START_DB, -14),
          smoothUnitRamp(rms, RENDERED_CONSONANT_AUDIBILITY_RMS_START_DB, -70),
        )
      : 1;
    if (referenceMetrics) {
      // This is a zero-authority performance screen, not an engagement gate:
      // quiet evidence fades in smoothly before the former -14/-70 limits.
      if (sourceRelativeAudibilityAuthority <= 0) continue;
    } else if (peak < -14 || rms < -70) {
      continue;
    }

    const bodyDb = renderedLocalBodyDb(rmsDb, frame, localWindowFrames);
    const peakOverBodyDb = peak - bodyDb;
    const crestDb = peak - rms;
    const strongVisiblePeak = peak >= RENDERED_CONSONANT_ABSOLUTE_PEAK_DB && peakOverBodyDb >= 12;
    const narrowConsonantPeak = peakOverBodyDb >= 17 || crestDb >= 18;
    let reductionDb = 0;
    if (referenceMetrics) {
      const renderedEvidenceAuthority = Math.max(
        smoothUnitRamp(
          peakOverBodyDb,
          RENDERED_CONSONANT_RENDERED_CONTRAST_START_DB,
          RENDERED_CONSONANT_SOURCE_CONTRAST_FULL_DB,
        ),
        smoothUnitRamp(
          crestDb,
          RENDERED_CONSONANT_RENDERED_CREST_START_DB,
          RENDERED_CONSONANT_SOURCE_CREST_FULL_DB,
        ),
      );
      // Ordinary voice frames have mathematically zero repair authority and
      // still avoid the source scan. Above that point authority rises smoothly.
      if (renderedEvidenceAuthority <= 0) continue;
      const referenceMatch = resolveReferencePeakOverBodyDb(frame, peakOverBodyDb);
      // A source-relative request never falls through to the source-blind
      // absolute tamer. Ambiguous local matches preserve the rendered frame.
      if (referenceMatch === null) continue;
      // Compare articulation shape instead of absolute level. A naturally strong
      // /s/, /z/, /f/, or similar consonant is preserved when the source already
      // contains it; only contrast added by processing receives a short soft dip.
      const sourceRelativeReductionDb = Math.min(
        requestedMaxReductionDb,
        referenceMatch.reductionDb,
      );
      reductionDb = sourceRelativeReductionDb
        * renderedEvidenceAuthority
        * sourceRelativeAudibilityAuthority;
      sourceRelativeReductionDbByFrame![frame] = reductionDb;
    } else {
      if (!strongVisiblePeak && !narrowConsonantPeak) continue;
      const targetPeakDb = Math.min(
        RENDERED_CONSONANT_ABSOLUTE_PEAK_DB,
        Math.max(
          RENDERED_CONSONANT_MIN_TARGET_PEAK_DB,
          bodyDb + RENDERED_CONSONANT_ALLOWED_PEAK_OVER_BODY_DB,
        ),
      );
      reductionDb = clamp(peak - targetPeakDb, 0, requestedMaxReductionDb);
    }
    // Preserve continuity at the quiet end of the curve. A minimum audible
    // cutoff turns a tiny evidence change into a millisecond gain jump.
    if (reductionDb <= 0) continue;

    tamedFrameCount += 1;
    maxReductionDb = Math.max(maxReductionDb, reductionDb);
    for (let offset = -dipRadiusFrames; offset <= dipRadiusFrames; offset += 1) {
      const targetFrame = frame + offset;
      if (targetFrame < 0 || targetFrame >= frameCount) continue;
      const distance = Math.abs(offset) / (dipRadiusFrames + 1);
      const weight = Math.cos((distance * Math.PI) / 2) ** 2;
      dipDbByFrame[targetFrame] = Math.max(dipDbByFrame[targetFrame], reductionDb * weight);
    }
  }

  let sourceRelativeOwnerCapDbByFrame: Float32Array | null =
    sourceRelativeReductionDbByFrame;
  if (sourceRelativeReductionDbByFrame) {
    const evidenceSupportedCapDbByFrame = new Float32Array(frameCount);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const requestedReductionDb = sourceRelativeReductionDbByFrame[frame];
      const previousSupportDb = frame > 0
        ? sourceRelativeReductionDbByFrame[frame - 1]
        : 0;
      const nextSupportDb = frame + 1 < frameCount
        ? sourceRelativeReductionDbByFrame[frame + 1]
        : 0;
      // Grow depth continuously with evidence on each side. Geometric support
      // keeps the relationship symmetric (a weak lane cannot lend a stronger
      // budget than it owns), avoids a one-cell -> two-cell depth cliff,
      // cliff, while sustained multi-cell evidence can accumulate more depth.
      const previousEvidenceSupportDb = Math.sqrt(
        requestedReductionDb * previousSupportDb,
      );
      const nextEvidenceSupportDb = Math.sqrt(
        requestedReductionDb * nextSupportDb,
      );
      evidenceSupportedCapDbByFrame[frame] = Math.min(
        requestedReductionDb,
        RENDERED_CONSONANT_ISOLATED_OWNER_MAX_REDUCTION_DB
          + RENDERED_CONSONANT_ADJACENT_SUPPORT_SCALE
            * (previousEvidenceSupportDb + nextEvidenceSupportDb),
      );
    }
    const eventContiguousCapDbByFrame = new Float32Array(
      evidenceSupportedCapDbByFrame,
    );
    for (let frame = 1; frame + 1 < frameCount; frame += 1) {
      const requestedReductionDb = sourceRelativeReductionDbByFrame[frame];
      const previousSupportDb = sourceRelativeReductionDbByFrame[frame - 1];
      const nextSupportDb = sourceRelativeReductionDbByFrame[frame + 1];
      const boundedBridgeEvidenceDb = Math.min(previousSupportDb, nextSupportDb);
      const missingBridgeEvidenceDb = Math.max(
        0,
        boundedBridgeEvidenceDb - requestedReductionDb,
      );
      const missingAuthority = boundedBridgeEvidenceDb > 0
        ? smoothUnitRamp(
            missingBridgeEvidenceDb / boundedBridgeEvidenceDb,
            0,
            1,
          )
        : 0;
      const boundedBridgeCapDb = Math.min(
        evidenceSupportedCapDbByFrame[frame - 1],
        evidenceSupportedCapDbByFrame[frame + 1],
      ) * RENDERED_CONSONANT_ADJACENT_SUPPORT_SCALE;
      const missingBridgeCapDb = Math.max(
        0,
        boundedBridgeCapDb - evidenceSupportedCapDbByFrame[frame],
      );
      // Reconcile only a one-frame valley bounded by original evidence on both
      // sides. Neighbor caps come from the untouched decision array, so a wider
      // gap stays at zero and a bridge cannot deepen either evidence owner.
      // Smooth missing-evidence authority avoids introducing an engagement step;
      // the existing adjacent-support scale keeps a fully missing cell shallow.
      eventContiguousCapDbByFrame[frame] =
        evidenceSupportedCapDbByFrame[frame]
        + missingBridgeCapDb * missingAuthority;
    }
    const continuityRelaxedCapDbByFrame =
      relaxNarrowConsonantOwnerCaps(
        eventContiguousCapDbByFrame,
        sourceRelativeReductionDbByFrame,
      );
    sourceRelativeOwnerCapDbByFrame = continuityRelaxedCapDbByFrame;
    tamedFrameCount = 0;
    maxReductionDb = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      // Keep the cosine shoulder from spilling onto an adjacent source-native
      // consonant. The relaxed owner cap can only remove narrow attenuation;
      // unsupported frames stay at zero and sustained evidence keeps its
      // interior depth.
      dipDbByFrame[frame] = Math.min(
        dipDbByFrame[frame],
        continuityRelaxedCapDbByFrame[frame],
      );
      if (dipDbByFrame[frame] > 0) {
        tamedFrameCount += 1;
        maxReductionDb = Math.max(maxReductionDb, dipDbByFrame[frame]);
      }
    }
  }

  if (tamedFrameCount === 0) {
    return {
      samples: out,
      stats: noOpStats(referenceLagMs, referenceUsed, referenceAlignment.confidence),
    };
  }

  // Keep the centered envelope so a boundary-straddling fricative does not keep
  // its peak while diagnostics report touched frames. Source-relative repair is
  // additionally bounded by the frame that owns each sample: a weak or native
  // lane cannot borrow a stronger neighbor's budget. Higher-cap lanes ease in
  // from a lower previous cap and ease out toward a lower next cap within their
  // own frame, keeping the transition smooth without crossing either boundary.
  const centerOffset = samplesPerFrame / 2;
  const analysisSampleOffset = Math.round(analysisFrameOffset * samplesPerFrame);
  for (let sampleIndex = 0; sampleIndex < out.length; sampleIndex += 1) {
    const absoluteSampleIndex = analysisSampleOffset + sampleIndex;
    const framePos = (absoluteSampleIndex - centerOffset) / samplesPerFrame
      - analysisFrameOffset;
    const frame0 = Math.max(0, Math.min(frameCount - 1, Math.floor(framePos)));
    const frame1 = Math.max(0, Math.min(frameCount - 1, frame0 + 1));
    const mix = clamp(framePos - frame0, 0, 1);
    let dipDb: number;
    if (sourceRelativeOwnerCapDbByFrame) {
      const centeredDipDb = Math.max(dipDbByFrame[frame0], dipDbByFrame[frame1]);
      // Analysis owns integer samples through rounded absolute frame bounds:
      // [round(f*S), round((f+1)*S)). Use the equivalent closed form here so
      // fractional rates such as 44.1 kHz cannot disagree by one sample.
      const absoluteOwnerFrame = Math.ceil(
        (absoluteSampleIndex + 0.5) / samplesPerFrame,
      ) - 1;
      const ownerFrame = Math.max(
        0,
        Math.min(frameCount - 1, absoluteOwnerFrame - analysisFrameOffset),
      );
      const ownerStartSample = Math.round(
        (analysisFrameOffset + ownerFrame) * samplesPerFrame,
      ) - analysisSampleOffset;
      const ownerEndSample = Math.round(
        (analysisFrameOffset + ownerFrame + 1) * samplesPerFrame,
      ) - analysisSampleOffset;
      const ownerPhase = clamp(
        (sampleIndex - ownerStartSample) / Math.max(1, ownerEndSample - ownerStartSample),
        0,
        1,
      );
      const ownerCapDb = sourceRelativeOwnerCapDbByFrame[ownerFrame];
      const previousCapDb = ownerFrame > 0
        ? sourceRelativeOwnerCapDbByFrame[ownerFrame - 1]
        : ownerCapDb;
      const nextCapDb = ownerFrame + 1 < frameCount
        ? sourceRelativeOwnerCapDbByFrame[ownerFrame + 1]
        : ownerCapDb;
      let smoothOwnerCapDb = ownerCapDb;
      if (ownerPhase < 0.5 && previousCapDb < ownerCapDb) {
        smoothOwnerCapDb = previousCapDb
          + (ownerCapDb - previousCapDb) * (ownerPhase / 0.5);
      } else if (ownerPhase >= 0.5 && nextCapDb < ownerCapDb) {
        smoothOwnerCapDb = ownerCapDb
          + (nextCapDb - ownerCapDb) * ((ownerPhase - 0.5) / 0.5);
      }
      dipDb = Math.min(centeredDipDb, smoothOwnerCapDb);
    } else {
      dipDb = dipDbByFrame[frame0] * (1 - mix) + dipDbByFrame[frame1] * mix;
    }
    if (dipDb > 0) {
      out[sampleIndex] *= dbToLin(-dipDb);
    }
  }

  return {
    samples: out,
    stats: {
      tamedFrameCount,
      maxReductionDb,
      referenceLagMs,
      referenceUsed,
      referenceConfidence: referenceAlignment.confidence,
    },
  };
};

/**
 * Emit a `sendcmd` script that drives ffmpeg's `volume` filter through the
 * planned gain curve for an arbitrary time window.
 *
 * `sendcmd` format: `timestamp command filter arg;`. Timestamps here are
 * **relative** to the sub-stream the script is applied to — for a segmented
 * render using `-ss START -t DUR`, the segment's input timeline starts at 0,
 * so we subtract `windowStartSec` from every keyframe timestamp.
 *
 * Keyframes are decimated: we only emit a new line when the linear gain
 * changes by more than `minDeltaLin` vs the last emitted keyframe. Typical
 * 15-minute file with fast-tracking curve yields ~2-5k lines.
 */
export const emitSendcmdScript = (
  gainCurve: Float32Array,
  frameMs: number,
  windowStartSec: number,
  windowEndSec: number,
  minDeltaLin = 0.015,
): string => {
  const frameSec = frameMs / 1000;
  const startFrame = Math.max(0, Math.floor(windowStartSec / frameSec));
  const endFrame = Math.min(gainCurve.length, Math.ceil(windowEndSec / frameSec));
  if (endFrame <= startFrame) return "";

  const lines: string[] = [];
  let lastEmittedLin = Number.NaN;
  let lastEmittedFrame = -1;
  const emit = (frameIdx: number, lin: number) => {
    const relSec = frameIdx * frameSec - windowStartSec;
    const t = Math.max(0, relSec);
    lines.push(`${t.toFixed(3)} volume volume ${lin.toFixed(5)};`);
    lastEmittedLin = lin;
    lastEmittedFrame = frameIdx;
  };

  // Always emit the first keyframe at t=0 so the filter starts at the right gain.
  emit(startFrame, gainCurve[startFrame]);

  for (let f = startFrame + 1; f < endFrame; f += 1) {
    const lin = gainCurve[f];
    if (Math.abs(lin - lastEmittedLin) >= minDeltaLin) {
      emit(f, lin);
    }
  }
  // Ensure the final gain applies until the end of the window.
  if (lastEmittedFrame !== endFrame - 1) {
    emit(endFrame - 1, gainCurve[endFrame - 1]);
  }

  return lines.join("\n") + "\n";
};

/**
 * Build speech runs from an already-computed speech mask.
 * Exposed for tests; the VoLeveler uses its existing span detection.
 */
export const speechRunsFromMask = (mask: boolean[]): SpeechRun[] => {
  const runs: SpeechRun[] = [];
  let runStart = -1;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] && runStart < 0) runStart = i;
    if (!mask[i] && runStart >= 0) {
      runs.push({ startFrame: runStart, endFrame: i });
      runStart = -1;
    }
  }
  if (runStart >= 0) runs.push({ startFrame: runStart, endFrame: mask.length });
  return runs;
};
