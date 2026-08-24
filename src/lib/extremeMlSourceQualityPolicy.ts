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

export const buildExtremeMlSourceQualityPolicy = (
  report: ExtremeSourceReport | null | undefined,
): ExtremeMlSourceQualityPolicy => {
  if (!isSafeAdvisoryReport(report)) return fallbackPolicy();

  const usedMetricKeys = new Set<string>();
  const dnsmosBackground = metricValue(report, "dnsmos.bak", usedMetricKeys);
  const sigmosNoise = metricValue(report, "sigmos.noise", usedMetricKeys);
  const sigmosReverb = metricValue(report, "sigmos.reverb", usedMetricKeys);
  const sigmosLoud = metricValue(report, "sigmos.loud", usedMetricKeys);
  const sigmosDiscontinuity = metricValue(report, "sigmos.disc", usedMetricKeys);

  const noiseEvidence = Math.max(
    deficit(dnsmosBackground, 3.55, 2.15),
    deficit(sigmosNoise, 3.55, 2.2),
  );
  const roomEvidence = deficit(sigmosReverb, 3.45, 2.1);
  const stabilityEvidence = Math.max(
    deficit(sigmosLoud, 3.55, 2.25),
    deficit(sigmosDiscontinuity, 3.5, 2.2),
  );
  const strongestEvidence = Math.max(noiseEvidence, roomEvidence, stabilityEvidence);
  if (strongestEvidence < 0.18 || usedMetricKeys.size === 0) return fallbackPolicy();

  const orderedMetricKeys = Object.freeze([...usedMetricKeys].sort());
  return Object.freeze({
    advisoryOnly: true,
    canBlockDelivery: false,
    canChangeGainDb: false,
    reason: "ml-source-quality",
    noiseRiskFloor: floorFromEvidence(noiseEvidence),
    roomRiskFloor: floorFromEvidence(roomEvidence),
    pauseNoiseRiskFloor: clamp(0.22 + noiseEvidence * 0.62 + roomEvidence * 0.18 + stabilityEvidence * 0.12, 0, 0.84),
    denoiseBias: clamp(noiseEvidence * 0.34 + roomEvidence * 0.08, 0, 0.32),
    roomCleanupBias: clamp(roomEvidence * 0.44 + stabilityEvidence * 0.08, 0, 0.3),
    instabilityHintBoost: clamp(stabilityEvidence * 0.18 + roomEvidence * 0.06, 0, 0.24),
    speechSpikeTamingBoost: clamp(stabilityEvidence * 0.14, 0, 0.16),
    plannerMaxGainPenaltyDb: clamp(
      noiseEvidence * 1.05 + roomEvidence * 0.55 + stabilityEvidence * 0.36,
      0,
      1.5,
    ),
    usedMetricKeys: orderedMetricKeys,
  });
};
