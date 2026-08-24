import type { ExtremeSourceReport } from "./extremeMlClient.ts";

export type ExtremeMlSourceRiskFloor = "medium" | "high";

export type ExtremeMlSourceQualityPolicy = Readonly<{
  advisoryOnly: true;
  canBlockDelivery: false;
  canChangeGainDb: false;
  reason: "ml-source-quality" | "legacy-fallback";
  noiseRiskFloor: ExtremeMlSourceRiskFloor | null;
  roomRiskFloor: ExtremeMlSourceRiskFloor | null;
  pauseNoiseRiskFloor: number;
  denoiseBias: number;
  roomCleanupBias: number;
  instabilityHintBoost: number;
  speechSpikeTamingBoost: number;
  /** 0..1 learned loudness/discontinuity risk; gainPlanner alone decides any dB movement. */
  perceptualStabilityRisk: number;
  plannerMaxGainPenaltyDb: number;
  usedMetricKeys: readonly string[];
}>;

const fallbackPolicy = (): ExtremeMlSourceQualityPolicy =>
  Object.freeze({
    advisoryOnly: true,
    canBlockDelivery: false,
    canChangeGainDb: false,
    reason: "legacy-fallback",
    noiseRiskFloor: null,
    roomRiskFloor: null,
    pauseNoiseRiskFloor: 0,
    denoiseBias: 0,
    roomCleanupBias: 0,
    instabilityHintBoost: 0,
    speechSpikeTamingBoost: 0,
    perceptualStabilityRisk: 0,
    plannerMaxGainPenaltyDb: 0,
    usedMetricKeys: Object.freeze([]),
  });

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const isSafeAdvisoryReport = (
  report: ExtremeSourceReport | null | undefined,
): report is ExtremeSourceReport =>
  report !== null &&
  report !== undefined &&
  report.schemaVersion === 1 &&
  report.advisoryOnly === true &&
  report.canBlockDelivery === false &&
  report.canChangeGainDb === false &&
  report.levelAuthority === "gainPlanner" &&
  report.telemetry.audioMutation === false &&
  report.telemetry.candidateSelected === false &&
  report.telemetry.gainDbChanged === false;

const metricValue = (
  report: ExtremeSourceReport,
  key: string,
  usedMetricKeys: Set<string>,
) => {
  const metric = report.metrics[key];
  if (
    metric?.available !== true ||
    metric.higherIsBetter !== true ||
    typeof metric.value !== "number" ||
    !Number.isFinite(metric.value)
  ) {
    return null;
  }
  usedMetricKeys.add(key);
  return clamp(metric.value, 0, 5);
};

const deficit = (value: number | null, cautionAt: number, severeAt: number) => {
  if (value === null || cautionAt <= severeAt) return 0;
  return clamp((cautionAt - value) / (cautionAt - severeAt), 0, 1);
};

const floorFromEvidence = (evidence: number): ExtremeMlSourceRiskFloor | null =>
  evidence >= 0.55 ? "high" : evidence >= 0.28 ? "medium" : null;

const speechCoverageAuthority = (report: ExtremeSourceReport) => {
  const frames = report.vad.frames;
  if (frames.length === 0) return 0;
  const speechFrames = frames.reduce(
    (count, frame) => count + (frame.speechProbability >= 0.5 ? 1 : 0),
    0,
  );
  return clamp((speechFrames / frames.length - 0.08) / 0.22, 0, 1);
};

const speechDurationAuthority = (report: ExtremeSourceReport) => {
  const speechFrames = report.vad.frames.reduce(
    (count, frame) => count + (frame.speechProbability >= 0.5 ? 1 : 0),
    0,
  );
  const speechSeconds = speechFrames * report.vad.frameMs / 1_000;
  return clamp((speechSeconds - 2) / 8, 0, 1);
};

export const buildExtremeMlSourceQualityPolicy = (
  report: ExtremeSourceReport | null | undefined,
): ExtremeMlSourceQualityPolicy => {
  if (!isSafeAdvisoryReport(report)) return fallbackPolicy();

  const usedMetricKeys = new Set<string>();
  const dnsmosOverall = metricValue(report, "dnsmos.ovrl", usedMetricKeys);
  const dnsmosSignal = metricValue(report, "dnsmos.sig", usedMetricKeys);
  const dnsmosBackground = metricValue(report, "dnsmos.bak", usedMetricKeys);
  const dnsmosP808 = metricValue(report, "dnsmos_p808", usedMetricKeys);
  const sigmosOverall = metricValue(report, "sigmos.ovrl", usedMetricKeys);
  const sigmosSignal = metricValue(report, "sigmos.sig", usedMetricKeys);
  const sigmosNoise = metricValue(report, "sigmos.noise", usedMetricKeys);
  const sigmosReverb = metricValue(report, "sigmos.reverb", usedMetricKeys);
  const sigmosLoud = metricValue(report, "sigmos.loud", usedMetricKeys);
  const sigmosDiscontinuity = metricValue(report, "sigmos.disc", usedMetricKeys);
  const utmos = metricValue(report, "utmos", usedMetricKeys);
  const cleanupSpeechAuthority = speechCoverageAuthority(report);
  const stabilitySpeechAuthority = Math.max(
    cleanupSpeechAuthority,
    speechDurationAuthority(report),
  );

  const broadQualityEvidence = Math.max(
    deficit(dnsmosOverall, 3.55, 2.25),
    deficit(dnsmosP808, 3.65, 2.45),
    deficit(sigmosOverall, 3.55, 2.2),
    deficit(utmos, 3.55, 2.35),
  ) * stabilitySpeechAuthority;
  const speechFragilityEvidence = Math.max(
    deficit(dnsmosSignal, 3.25, 1.85),
    deficit(sigmosSignal, 3.25, 1.85),
  ) * stabilitySpeechAuthority;
  const cleanupConfidence = clamp(1 - speechFragilityEvidence * 0.38, 0.62, 1);
  const rawNoiseEvidence = Math.max(
    deficit(dnsmosBackground, 3.55, 2.15),
    deficit(sigmosNoise, 3.55, 2.2),
  );
  const rawRoomEvidence = deficit(sigmosReverb, 3.45, 2.1);
  const rawStabilityEvidence = Math.max(
    deficit(sigmosLoud, 3.55, 2.25),
    deficit(sigmosDiscontinuity, 3.5, 2.2),
    broadQualityEvidence * 0.58,
  );
  const noiseEvidence = rawNoiseEvidence * cleanupConfidence * cleanupSpeechAuthority;
  const roomEvidence = rawRoomEvidence * cleanupConfidence * cleanupSpeechAuthority;
  const stabilityEvidence = rawStabilityEvidence * cleanupConfidence * stabilitySpeechAuthority;
  const strongestEvidence = Math.max(
    noiseEvidence,
    roomEvidence,
    stabilityEvidence,
    speechFragilityEvidence,
  );
  if (strongestEvidence < 0.18 || usedMetricKeys.size === 0) return fallbackPolicy();

  const orderedMetricKeys = Object.freeze([...usedMetricKeys].sort());
  return Object.freeze({
    advisoryOnly: true,
    canBlockDelivery: false,
    canChangeGainDb: false,
    reason: "ml-source-quality",
    noiseRiskFloor: floorFromEvidence(noiseEvidence),
    roomRiskFloor: floorFromEvidence(roomEvidence),
    pauseNoiseRiskFloor:
      Math.max(noiseEvidence, roomEvidence) >= 0.18
        ? clamp(0.18 + noiseEvidence * 0.62 + roomEvidence * 0.18, 0, 0.84)
        : 0,
    denoiseBias: clamp(noiseEvidence * 0.34 + roomEvidence * 0.08, 0, 0.4),
    roomCleanupBias: clamp(roomEvidence * 0.5, 0, 0.42),
    instabilityHintBoost: clamp(stabilityEvidence * 0.18 + roomEvidence * 0.06, 0, 0.24),
    speechSpikeTamingBoost: clamp(stabilityEvidence * 0.14, 0, 0.16),
    perceptualStabilityRisk: clamp(stabilityEvidence, 0, 1),
    plannerMaxGainPenaltyDb: clamp(
      noiseEvidence * 1.05 +
        roomEvidence * 0.55 +
        speechFragilityEvidence * 0.8,
      0,
      1.5,
    ),
    usedMetricKeys: orderedMetricKeys,
  });
};
