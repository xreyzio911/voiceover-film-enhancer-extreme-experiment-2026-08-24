export type AudibilityDropoutCluster = {
  startFrame: number;
  endFrame: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  minDropDb: number;
  medianDropDb: number;
  maxSourceDb: number;
  minRenderedDb: number;
};

export type AudibilityDropoutReport = {
  severe: boolean;
  sourceSpeechThresholdDb: number;
  badFrameCount: number;
  badSeconds: number;
  clusterCount: number;
  worstDropDb: number;
  clusters: AudibilityDropoutCluster[];
};

export type AudibilityDropoutInput = {
  sourceFrameDb: number[];
  renderedFrameDb: number[];
  frameMs?: number;
  minClusterMs?: number;
  bridgeGapMs?: number;
  missingTailToleranceMs?: number;
  severeBadSeconds?: number;
  severeClusterSeconds?: number;
};

export type AlignedAudibilityDropoutInput = AudibilityDropoutInput & {
  /** Maximum global render latency considered before comparing speech frames. */
  maxAlignmentMs?: number;
  /** Minimum correlation evidence required before a non-zero offset is used. */
  minAlignmentConfidence?: number;
};

export type AlignedAudibilityDropoutResult = {
  rawReport: AudibilityDropoutReport;
  alignedReport: AudibilityDropoutReport;
  finalReport: AudibilityDropoutReport;
  /** Positive means the rendered envelope arrives later than the source. */
  alignmentOffsetMs: number;
  alignmentConfidence: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const normalizeFrameMs = (value: number | undefined, fallback = 20) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
const LOCAL_SPEECH_CONTEXT_MS = 200;

const median = (values: number[]) => {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return 0;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? (finite[mid - 1] + finite[mid]) / 2 : finite[mid];
};

const percentile = (values: number[], pct: number) => {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const index = clamp(Math.round((pct / 100) * (finite.length - 1)), 0, finite.length - 1);
  return finite[index];
};

const estimateSourceSpeechThresholdDb = (sourceFrameDb: number[]) => {
  const finite = sourceFrameDb.filter((db) => Number.isFinite(db));
  const nonDigital = finite.filter((db) => db > -130);
  const quiet = percentile(nonDigital.length > 0 ? nonDigital : finite, 20) ?? -90;
  return clamp(Math.max(quiet + 12, -58), -58, -30);
};

const bridgeMaskGaps = (mask: boolean[], maxGapFrames: number) => {
  if (maxGapFrames <= 0) return mask;
  const bridged = [...mask];
  let index = 0;
  while (index < bridged.length) {
    if (bridged[index]) {
      index += 1;
      continue;
    }
    const gapStart = index;
    while (index < bridged.length && !bridged[index]) index += 1;
    const gapEnd = index;
    if (gapStart > 0 && gapEnd < bridged.length && gapEnd - gapStart <= maxGapFrames) {
      for (let cursor = gapStart; cursor < gapEnd; cursor += 1) bridged[cursor] = true;
    }
  }
  return bridged;
};

const collectClusters = (
  bad: boolean[],
  sourceFrameDb: number[],
  renderedFrameDb: number[],
  frameMs: number,
  minClusterFrames: number,
  gapFrames: number,
) => {
  const clusters: AudibilityDropoutCluster[] = [];
  let index = 0;
  while (index < bad.length) {
    if (!bad[index]) {
      index += 1;
      continue;
    }

    const start = index;
    let end = index + 1;
    let gap = 0;
    index += 1;
    while (index < bad.length) {
      if (bad[index]) {
        end = index + 1;
        gap = 0;
      } else {
        gap += 1;
        if (gap > gapFrames) break;
      }
      index += 1;
    }

    if (end - start < minClusterFrames) continue;

    const drops: number[] = [];
    let maxSourceDb = -240;
    let minRenderedDb = 240;
    for (let frame = start; frame < end; frame += 1) {
      const sourceDb = sourceFrameDb[frame] ?? -240;
      const renderedDb = renderedFrameDb[frame] ?? -240;
      drops.push(renderedDb - sourceDb);
      maxSourceDb = Math.max(maxSourceDb, sourceDb);
      minRenderedDb = Math.min(minRenderedDb, renderedDb);
    }

    clusters.push({
      startFrame: start,
      endFrame: end,
      startSec: (start * frameMs) / 1000,
      endSec: (end * frameMs) / 1000,
      durationSec: ((end - start) * frameMs) / 1000,
      minDropDb: Math.min(...drops),
      medianDropDb: median(drops),
      maxSourceDb,
      minRenderedDb,
    });
  }
  return clusters;
};

export const frameDbFromFloatSamples = (samples: Float32Array, sampleRate: number, frameMs = 20) => {
  const frameSize = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frameCount = Math.floor(samples.length / frameSize);
  const frames = new Array<number>(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    const offset = frame * frameSize;
    for (let sample = 0; sample < frameSize; sample += 1) {
      const value = samples[offset + sample] ?? 0;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / frameSize);
    frames[frame] = rms > 1e-12 ? 20 * Math.log10(rms) : -240;
  }
  return frames;
};

export const detectAudibilityDropouts = (input: AudibilityDropoutInput): AudibilityDropoutReport => {
  const frameMs = normalizeFrameMs(input.frameMs);
  const frameCount = input.sourceFrameDb.length;
  const renderedFrameCount = input.renderedFrameDb.length;
  const missingTailToleranceFrames = Math.max(0, Math.round((input.missingTailToleranceMs ?? 60) / frameMs));
  const sourceFrameDb = input.sourceFrameDb.slice(0, frameCount);
  const renderedFrameDb = new Array<number>(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    renderedFrameDb[frame] = input.renderedFrameDb[frame] ?? -240;
  }
  const sourceSpeechThresholdDb = estimateSourceSpeechThresholdDb(sourceFrameDb);
  const speechLikeThresholdDb = Math.min(sourceSpeechThresholdDb, -50);
  const localWindowFrames = Math.max(1, Math.round(LOCAL_SPEECH_CONTEXT_MS / frameMs));
  const clusteredSpeechMask = bridgeMaskGaps(
    sourceFrameDb.map((db) => db >= speechLikeThresholdDb),
    Math.max(0, Math.round(120 / frameMs)),
  );
  const bad = new Array<boolean>(frameCount).fill(false);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const sourceDb = sourceFrameDb[frame] ?? -240;
    if (sourceDb < speechLikeThresholdDb) continue;
    if (frame >= renderedFrameCount && frame - renderedFrameCount < missingTailToleranceFrames) continue;
    const renderedDb = renderedFrameDb[frame] ?? -240;
    const dropDb = renderedDb - sourceDb;
    const collapsedToSilence = renderedDb <= -68 && sourceDb >= -50;
    const severeRelativeDrop = dropDb <= -24 && renderedDb <= -58;
    const localRenderedMedianDb = median(renderedFrameDb.slice(Math.max(0, frame - localWindowFrames), frame + 1));
    const collapsedVsLocal = renderedDb <= localRenderedMedianDb - 18;
    const strongSpeechMissing = sourceDb >= -38 && renderedDb <= -54;
    bad[frame] =
      clusteredSpeechMask[frame] && (collapsedToSilence || (severeRelativeDrop && collapsedVsLocal) || strongSpeechMissing);
  }

  const minClusterFrames = Math.max(1, Math.round((input.minClusterMs ?? 80) / frameMs));
  const clusters = collectClusters(
    bad,
    sourceFrameDb,
    renderedFrameDb,
    frameMs,
    minClusterFrames,
    Math.max(0, Math.round((input.bridgeGapMs ?? 60) / frameMs)),
  );
  const badFrameCount = clusters.reduce((sum, cluster) => sum + (cluster.endFrame - cluster.startFrame), 0);
  const badSeconds = (badFrameCount * frameMs) / 1000;
  const severeBadSeconds = input.severeBadSeconds ?? 0.35;
  const severeClusterSeconds = input.severeClusterSeconds ?? 0.18;
  const worstDropDb = clusters.length > 0 ? Math.min(...clusters.map((cluster) => cluster.minDropDb)) : 0;
  const severe =
    badSeconds >= severeBadSeconds ||
    clusters.some((cluster) => cluster.durationSec >= severeClusterSeconds) ||
    (clusters.length >= 3 && badSeconds >= 0.24);

  return {
    severe,
    sourceSpeechThresholdDb,
    badFrameCount,
    badSeconds,
    clusterCount: clusters.length,
    worstDropDb,
    clusters,
  };
};

const audibilityAlignmentActivity = (db: number) => {
  if (!Number.isFinite(db) || db <= -90) return 0;
  return Math.pow(10, clamp(db, -90, 0) / 20);
};

const estimateAudibilityAlignment = (
  sourceFrameDb: number[],
  renderedFrameDb: number[],
  maxLagFrames: number,
) => {
  if (maxLagFrames <= 0 || sourceFrameDb.length === 0 || renderedFrameDb.length === 0) {
    return { lagFrames: 0, confidence: 0 };
  }

  let bestLagFrames = 0;
  let bestCorrelation = Number.NEGATIVE_INFINITY;
  let secondBestCorrelation = Number.NEGATIVE_INFINITY;
  let zeroLagCorrelation = Number.NEGATIVE_INFINITY;

  for (let lagFrames = -maxLagFrames; lagFrames <= maxLagFrames; lagFrames += 1) {
    let dot = 0;
    let sourceEnergy = 0;
    let renderedEnergy = 0;
    let activePairs = 0;
    for (let sourceFrame = 0; sourceFrame < sourceFrameDb.length; sourceFrame += 1) {
      const renderedFrame = sourceFrame + lagFrames;
      if (renderedFrame < 0 || renderedFrame >= renderedFrameDb.length) continue;
      const sourceActivity = audibilityAlignmentActivity(sourceFrameDb[sourceFrame] ?? -240);
      const renderedActivity = audibilityAlignmentActivity(renderedFrameDb[renderedFrame] ?? -240);
      if (sourceActivity <= 0 && renderedActivity <= 0) continue;
      dot += sourceActivity * renderedActivity;
      sourceEnergy += sourceActivity * sourceActivity;
      renderedEnergy += renderedActivity * renderedActivity;
      activePairs += 1;
    }

    const correlation =
      activePairs > 0 && sourceEnergy > 1e-12 && renderedEnergy > 1e-12
        ? dot / Math.sqrt(sourceEnergy * renderedEnergy)
        : 0;
    if (lagFrames === 0) zeroLagCorrelation = correlation;

    // A tiny zero-lag prior prevents flat or repetitive envelopes from
    // inventing movement, while clear speech-edge evidence still wins.
    const adjustedCorrelation = correlation - Math.abs(lagFrames) * 0.002;
    const bestAdjustedCorrelation =
      bestCorrelation - Math.abs(bestLagFrames) * 0.002;
    if (
      adjustedCorrelation > bestAdjustedCorrelation + 1e-9 ||
      (Math.abs(adjustedCorrelation - bestAdjustedCorrelation) <= 1e-9 &&
        Math.abs(lagFrames) < Math.abs(bestLagFrames))
    ) {
      secondBestCorrelation = bestCorrelation;
      bestCorrelation = correlation;
      bestLagFrames = lagFrames;
    } else if (correlation > secondBestCorrelation) {
      secondBestCorrelation = correlation;
    }
  }

  const improvementOverZero = Math.max(0, bestCorrelation - Math.max(0, zeroLagCorrelation));
  const separation = Math.max(0, bestCorrelation - Math.max(0, secondBestCorrelation));
  const confidence = clamp(bestCorrelation * 0.35 + improvementOverZero * 3 + separation * 4, 0, 1);
  return { lagFrames: bestLagFrames, confidence };
};

const alignRenderedAudibilityFrames = (renderedFrameDb: number[], lagFrames: number) => {
  if (lagFrames > 0) return renderedFrameDb.slice(lagFrames);
  if (lagFrames < 0) {
    return [...new Array<number>(-lagFrames).fill(-240), ...renderedFrameDb];
  }
  return renderedFrameDb.slice();
};

/**
 * Compensates for small, measured DSP latency before running the existing
 * speech-loss detector. This changes no quality threshold: it prevents normal
 * filter delay from masquerading as missing consonants, while real deletion or
 * truncation remains subject to the same audibility fallback policy.
 */
export const detectAlignedAudibilityDropouts = (
  input: AlignedAudibilityDropoutInput,
): AlignedAudibilityDropoutResult => {
  const frameMs = normalizeFrameMs(input.frameMs);
  const normalizedInput = { ...input, frameMs };
  const rawReport = detectAudibilityDropouts(normalizedInput);
  const requestedMaxAlignmentMs =
    typeof input.maxAlignmentMs === "number" && Number.isFinite(input.maxAlignmentMs)
      ? input.maxAlignmentMs
      : 60;
  const maxAlignmentMs = clamp(requestedMaxAlignmentMs, 0, 120);
  const maxLagFrames = Math.max(0, Math.round(maxAlignmentMs / frameMs));
  const estimated = estimateAudibilityAlignment(input.sourceFrameDb, input.renderedFrameDb, maxLagFrames);
  const requestedMinAlignmentConfidence =
    typeof input.minAlignmentConfidence === "number" && Number.isFinite(input.minAlignmentConfidence)
      ? input.minAlignmentConfidence
      : 0.5;
  const minAlignmentConfidence = clamp(requestedMinAlignmentConfidence, 0, 1);
  const useAlignment = estimated.lagFrames !== 0 && estimated.confidence >= minAlignmentConfidence;
  const alignmentOffsetMs = useAlignment ? estimated.lagFrames * frameMs : 0;
  const alignedReport = useAlignment
    ? detectAudibilityDropouts({
        ...normalizedInput,
        renderedFrameDb: alignRenderedAudibilityFrames(input.renderedFrameDb, estimated.lagFrames),
      })
    : rawReport;

  return {
    rawReport,
    alignedReport,
    finalReport: alignedReport,
    alignmentOffsetMs,
    alignmentConfidence: estimated.confidence,
  };
};
