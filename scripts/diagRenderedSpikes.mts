/**
 * Rendered consonant-spike diagnostic.
 *
 * Compares a mix-ready WAV against its source and reports narrow rendered
 * peaks that sit far above the local speech body. It also runs the same
 * full-rate consonant tamer used by the app in-memory and reports the
 * before/after reduction.
 *
 * Usage:
 *   node --experimental-strip-types --max-old-space-size=6144 scripts/diagRenderedSpikes.mts [source.wav rendered.wav]
 *
 * Exit codes: 0 = PASS, 1 = FAIL, 2 = INCONCLUSIVE (source comparison unavailable).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRenderedConsonantReference,
  RENDERED_CONSONANT_SOURCE_FRAME_MS,
  tameRenderedConsonantPeaks,
} from "../src/lib/gainPlanner.ts";
import { decodeWav } from "../src/lib/webAudioRender.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_SOURCE = path.join(ROOT, "end spiked down", "Lucas Martin_batchvideo1-10.wav");
const DEFAULT_RENDER = path.join(ROOT, "end spiked down", "Lucas_Martin_batchvideo1-10_mixready.wav");
const FRAME_MS = RENDERED_CONSONANT_SOURCE_FRAME_MS;
const SOURCE_FRAME_MS = RENDERED_CONSONANT_SOURCE_FRAME_MS;
const LOCAL_WINDOW_MS = 280;
const FAIL_ABSOLUTE_PEAK_DB = -6.5;
const FAIL_VISIBLE_OVER_BODY_DB = 12;
const FAIL_NARROW_OVER_BODY_DB = 17;
const MIN_SPEECH_RMS_DB = -70;
const MIN_CANDIDATE_PEAK_DB = -14;
const REFERENCE_MATCH_WINDOW_MS = 20;
const SOURCE_ALLOWED_GROWTH_DB = 1.5;
const SOURCE_STRONG_MAX_REDUCTION_DB = 2.5;
const SOURCE_WEAK_MAX_REDUCTION_DB = 1.25;
const REDUCTION_DELIVERY_TOLERANCE_DB = 0.15;
const CONSERVATIVE_SPEECH_BODY_MOVEMENT_DB = 0.5;

const [, , sourceArg, renderArg] = process.argv;
const sourcePath = sourceArg ? path.resolve(sourceArg) : DEFAULT_SOURCE;
const renderPath = renderArg ? path.resolve(renderArg) : DEFAULT_RENDER;

type LoadedAudio = {
  name: string;
  samples: Float32Array;
  sampleRate: number;
};

export type FrameMetrics = {
  rmsDb: ArrayLike<number>;
  peakDb: ArrayLike<number>;
  samplesPerFrame: number;
};

export type SourceEvidenceLane = "strong" | "weak";

type SourceMatch = {
  frame: number;
  peakDb: number;
  rmsDb: number;
  bodyDb: number;
  peakOverBodyDb: number;
  lane: SourceEvidenceLane;
  maxReductionDb: number;
};

export type SpikeGroup = {
  startFrame: number;
  endFrame: number;
  frame: number;
  peakDb: number;
  rmsDb: number;
  bodyDb: number;
  peakOverBodyDb: number;
  crestDb: number;
  sourcePeakDb: number | null;
  sourceRmsDb: number | null;
  sourceBodyDb: number | null;
  sourcePeakOverBodyDb: number | null;
  sourceEvidenceLane: SourceEvidenceLane | null;
  sourceMaxReductionDb: number | null;
  contrastGrowthDb: number | null;
  sourcePeakDeltaDb: number | null;
};

export type TamerAssessment = {
  group: SpikeGroup;
  afterPeakDb: number;
  afterPeakOverBodyDb: number;
  initialGrowthDb: number;
  remainingGrowthDb: number;
  expectedReductionDb: number;
  deliveredReductionDb: number;
  visibleAfter: boolean;
  visibleResidual: boolean;
  conservativeBoundaryUnderDelivery: boolean;
  ownerCapViolation: boolean;
  advisory: boolean;
};

const dbToPower = (db: number) => Math.pow(10, db / 10);

const powerToDb = (power: number) => 10 * Math.log10(power + 1e-30);

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const loadMono = (filePath: string): LoadedAudio => {
  const bytes = readFileSync(filePath);
  const decoded = decodeWav(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (decoded.channels <= 1) {
    return { name: path.basename(filePath), samples: decoded.samples, sampleRate: decoded.sampleRate };
  }

  const frameCount = Math.floor(decoded.samples.length / decoded.channels);
  const mono = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < decoded.channels; channel += 1) {
      sum += decoded.samples[frame * decoded.channels + channel];
    }
    mono[frame] = sum / decoded.channels;
  }
  return { name: path.basename(filePath), samples: mono, sampleRate: decoded.sampleRate };
};

const measureFrames = (samples: Float32Array, sampleRate: number): FrameMetrics => {
  const samplesPerFrame = Math.max(1, (sampleRate * FRAME_MS) / 1000);
  const frameCount = Math.ceil(samples.length / samplesPerFrame);
  const rmsDb = new Array<number>(frameCount);
  const peakDb = new Array<number>(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = Math.min(samples.length, Math.round(frame * samplesPerFrame));
    const end = Math.min(
      samples.length,
      Math.max(start + 1, Math.round((frame + 1) * samplesPerFrame)),
    );
    let power = 0;
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      const value = samples[index];
      power += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    const rms = Math.sqrt(power / Math.max(1, end - start));
    rmsDb[frame] = rms > 0 ? 20 * Math.log10(rms) : -120;
    peakDb[frame] = peak > 0 ? 20 * Math.log10(peak) : -120;
  }

  return { rmsDb, peakDb, samplesPerFrame };
};

const localBodyDb = (
  frameDb: ArrayLike<number>,
  centerFrame: number,
  frameMs = FRAME_MS,
) => {
  const windowFrames = Math.max(1, Math.round(LOCAL_WINDOW_MS / frameMs));
  const values: number[] = [];
  const start = Math.max(0, centerFrame - windowFrames);
  const end = Math.min(frameDb.length, centerFrame + windowFrames + 1);
  for (let frame = start; frame < end; frame += 1) {
    const value = frameDb[frame];
    if (Number.isFinite(value) && value >= -58) values.push(value);
  }
  if (values.length === 0) return frameDb[centerFrame] ?? -120;
  values.sort((left, right) => left - right);
  const trimmed = values.slice(0, Math.max(1, Math.ceil(values.length * 0.72)));
  return trimmed[Math.floor(trimmed.length * 0.6)] ?? values[Math.floor(values.length / 2)] ?? -120;
};

const resolveMatchedSourceFrame = (
  source: FrameMetrics,
  renderedFrame: number,
  renderedReferenceLagMs: number,
  sourceSampleRate: number,
  renderedSampleRate: number,
) => {
  const centerTimeMs = (renderedFrame + 0.5) * FRAME_MS;
  const referenceCenterFrame = Math.round(
    (centerTimeMs - renderedReferenceLagMs) / SOURCE_FRAME_MS - 0.5,
  );
  const referenceMatchFrames = Math.max(0, Math.round(REFERENCE_MATCH_WINDOW_MS / SOURCE_FRAME_MS));
  const startFrame = Math.max(0, referenceCenterFrame - referenceMatchFrames);
  const endFrame = Math.min(source.rmsDb.length - 1, referenceCenterFrame + referenceMatchFrames);
  if (startFrame > endFrame) return null;

  let nearestMatch: SourceMatch | null = null;
  let nearestDistanceFrames = Number.POSITIVE_INFINITY;
  let nearestMatchAmbiguous = false;
  const canUseWeakFullBandwidthEvidence = sourceSampleRate >= renderedSampleRate * 0.9;
  for (let sourceFrame = startFrame; sourceFrame <= endFrame; sourceFrame += 1) {
    const peakDb = source.peakDb[sourceFrame] ?? -120;
    const rmsDb = source.rmsDb[sourceFrame] ?? -120;
    const bodyDb = localBodyDb(source.rmsDb, sourceFrame, SOURCE_FRAME_MS);
    const contrastDb = peakDb - bodyDb;
    const crestDb = peakDb - rmsDb;
    const hasStrongLocalizedSourceContrast = contrastDb >= 12 || crestDb >= 18;
    const hasWeakFullBandwidthSourceContrast =
      canUseWeakFullBandwidthEvidence && (contrastDb >= 8 || crestDb >= 12);
    const hasLocalizedSourceContrast =
      hasStrongLocalizedSourceContrast || hasWeakFullBandwidthSourceContrast;
    if (!hasLocalizedSourceContrast) continue;

    const match: SourceMatch = {
      frame: sourceFrame,
      peakDb,
      rmsDb,
      bodyDb,
      peakOverBodyDb: contrastDb,
      lane: hasStrongLocalizedSourceContrast ? "strong" : "weak",
      maxReductionDb: hasStrongLocalizedSourceContrast
        ? SOURCE_STRONG_MAX_REDUCTION_DB
        : SOURCE_WEAK_MAX_REDUCTION_DB,
    };

    const distanceFrames = Math.abs(sourceFrame - referenceCenterFrame);
    if (distanceFrames < nearestDistanceFrames) {
      nearestMatch = match;
      nearestDistanceFrames = distanceFrames;
      nearestMatchAmbiguous = false;
    } else if (distanceFrames === nearestDistanceFrames) {
      nearestMatchAmbiguous = true;
    }
  }

  // Match the production tamer's fail-open behavior when two source events
  // are equally close. Choosing the louder neighbor would hide dense /st/ or
  // /ts/ render growth; choosing the quieter one could overstate it.
  if (nearestMatchAmbiguous) return null;
  if (nearestMatch !== null) return nearestMatch;
  // Match the optional production tamer: without positive time-local source
  // evidence, preserve the rendered frame instead of borrowing the aligned
  // speech body as authorization for a source-relative decision.
  return null;
};

const buildSpikeGroups = (
  render: FrameMetrics,
  source: FrameMetrics | null,
  renderedReferenceLagMs: number,
  sourceSampleRate: number,
  renderedSampleRate: number,
): SpikeGroup[] => {
  const candidateFrames: number[] = [];
  for (let frame = 0; frame < render.rmsDb.length; frame += 1) {
    const peakDb = render.peakDb[frame] ?? -120;
    const rmsDb = render.rmsDb[frame] ?? -120;
    if (peakDb < MIN_CANDIDATE_PEAK_DB || rmsDb < MIN_SPEECH_RMS_DB) continue;

    const bodyDb = localBodyDb(render.rmsDb, frame);
    const peakOverBodyDb = peakDb - bodyDb;
    const crestDb = peakDb - rmsDb;
    const strongVisiblePeak = peakDb >= FAIL_ABSOLUTE_PEAK_DB && peakOverBodyDb >= FAIL_VISIBLE_OVER_BODY_DB;
    const narrowConsonantPeak = peakOverBodyDb >= FAIL_NARROW_OVER_BODY_DB || crestDb >= 18;
    if (strongVisiblePeak || narrowConsonantPeak) candidateFrames.push(frame);
  }

  const groups: SpikeGroup[] = [];
  let index = 0;
  while (index < candidateFrames.length) {
    const startFrame = candidateFrames[index];
    let endFrame = startFrame + 1;
    index += 1;
    while (index < candidateFrames.length && candidateFrames[index] <= endFrame + 1) {
      endFrame = candidateFrames[index] + 1;
      index += 1;
    }

    let best: SpikeGroup | null = null;
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const peakDb = render.peakDb[frame] ?? -120;
      const rmsDb = render.rmsDb[frame] ?? -120;
      const bodyDb = localBodyDb(render.rmsDb, frame);
      const sourceMatch = source
        ? resolveMatchedSourceFrame(
            source,
            frame,
            renderedReferenceLagMs,
            sourceSampleRate,
            renderedSampleRate,
          )
        : null;
      const sourcePeakDb = sourceMatch?.peakDb ?? null;
      const sourceRmsDb = sourceMatch?.rmsDb ?? null;
      const sourceBodyDb = sourceMatch?.bodyDb ?? null;
      const sourcePeakOverBodyDb = sourceMatch?.peakOverBodyDb ?? null;
      const candidate: SpikeGroup = {
        startFrame,
        endFrame,
        frame,
        peakDb,
        rmsDb,
        bodyDb,
        peakOverBodyDb: peakDb - bodyDb,
        crestDb: peakDb - rmsDb,
        sourcePeakDb,
        sourceRmsDb,
        sourceBodyDb,
        sourcePeakOverBodyDb,
        sourceEvidenceLane: sourceMatch?.lane ?? null,
        sourceMaxReductionDb: sourceMatch?.maxReductionDb ?? null,
        contrastGrowthDb:
          sourcePeakOverBodyDb === null ? null : peakDb - bodyDb - sourcePeakOverBodyDb,
        sourcePeakDeltaDb: sourcePeakDb === null ? null : peakDb - sourcePeakDb,
      };
      if (!best || candidate.peakDb > best.peakDb || candidate.peakOverBodyDb > best.peakOverBodyDb) {
        best = candidate;
      }
    }
    if (best) groups.push(best);
  }

  return groups.sort(
    (left, right) =>
      (right.contrastGrowthDb ?? Number.NEGATIVE_INFINITY) -
        (left.contrastGrowthDb ?? Number.NEGATIVE_INFINITY) ||
      right.peakDb - left.peakDb,
  );
};

const speechBodyDeltaDb = (before: FrameMetrics, after: FrameMetrics, groups: SpikeGroup[]) => {
  const affected = new Set<number>();
  for (const group of groups) {
    for (let frame = group.startFrame - 3; frame <= group.endFrame + 3; frame += 1) affected.add(frame);
  }

  let beforePower = 0;
  let afterPower = 0;
  let count = 0;
  for (let frame = 0; frame < before.rmsDb.length; frame += 1) {
    const rmsDb = before.rmsDb[frame] ?? -120;
    if (affected.has(frame) || rmsDb < -58 || rmsDb > -12) continue;
    beforePower += dbToPower(rmsDb);
    afterPower += dbToPower(after.rmsDb[frame] ?? -120);
    count += 1;
  }

  return {
    frameCount: count,
    deltaDb: count > 0 ? powerToDb(afterPower / count) - powerToDb(beforePower / count) : 0,
  };
};

export const assessTamerDelivery = (
  beforeGroups: SpikeGroup[],
  after: FrameMetrics,
): TamerAssessment[] => {
  const assessments: TamerAssessment[] = [];
  for (const group of beforeGroups) {
    if (
      group.contrastGrowthDb === null ||
      group.sourcePeakOverBodyDb === null ||
      group.sourceMaxReductionDb === null ||
      group.sourceEvidenceLane === null
    ) {
      continue;
    }

    const afterPeakDb = after.peakDb[group.frame] ?? -120;
    const afterBodyDb = localBodyDb(after.rmsDb, group.frame);
    const afterPeakOverBodyDb = afterPeakDb - afterBodyDb;
    const remainingGrowthDb = afterPeakOverBodyDb - group.sourcePeakOverBodyDb;
    const expectedReductionDb = clamp(
      group.contrastGrowthDb - SOURCE_ALLOWED_GROWTH_DB,
      0,
      group.sourceMaxReductionDb,
    );
    // The tamer's authorization is a peak-gain dip. The surrounding body can
    // move slightly inside the short cosine shoulder, so compare peak
    // attenuation for delivery and retain body-relative growth for residual QC.
    const deliveredReductionDb = group.peakDb - afterPeakDb;
    const visibleAfter =
      afterPeakDb >= FAIL_ABSOLUTE_PEAK_DB &&
      afterPeakOverBodyDb >= FAIL_VISIBLE_OVER_BODY_DB;
    const conservativeBoundaryUnderDelivery =
      expectedReductionDb > 0 &&
      deliveredReductionDb + REDUCTION_DELIVERY_TOLERANCE_DB < expectedReductionDb;
    const visibleResidual =
      visibleAfter &&
      remainingGrowthDb > SOURCE_ALLOWED_GROWTH_DB + REDUCTION_DELIVERY_TOLERANCE_DB;
    // The smooth production envelope may deliver less than the owning frame's
    // cap near a boundary, but it must never attenuate a sample beyond that
    // owner cap. Less attenuation is advisory; excess attenuation is a safety
    // invariant violation the diagnostic can measure without demanding a more
    // destructive repair.
    const ownerCapViolation =
      deliveredReductionDb > expectedReductionDb + REDUCTION_DELIVERY_TOLERANCE_DB;
    const advisory = visibleResidual || conservativeBoundaryUnderDelivery;

    assessments.push({
      group,
      afterPeakDb,
      afterPeakOverBodyDb,
      initialGrowthDb: group.contrastGrowthDb,
      remainingGrowthDb,
      expectedReductionDb,
      deliveredReductionDb,
      visibleAfter,
      visibleResidual,
      conservativeBoundaryUnderDelivery,
      ownerCapViolation,
      advisory,
    });
  }
  return assessments;
};

const formatDb = (value: number | null) => (value === null ? "n/a" : `${value.toFixed(1)}dB`);

const printGroups = (label: string, groups: SpikeGroup[], limit = 10) => {
  console.log(`[${label}] groups=${groups.length}`);
  for (const group of groups.slice(0, limit)) {
    console.log(
      `  ${((group.frame * FRAME_MS) / 1000).toFixed(2)}s peak=${group.peakDb.toFixed(1)}dB ` +
        `rms=${group.rmsDb.toFixed(1)}dB body=${group.bodyDb.toFixed(1)}dB ` +
        `overBody=${group.peakOverBodyDb.toFixed(1)}dB crest=${group.crestDb.toFixed(1)}dB ` +
        `srcPeak=${formatDb(group.sourcePeakDb)} srcRms=${formatDb(group.sourceRmsDb)} ` +
        `srcOverBody=${formatDb(group.sourcePeakOverBodyDb)} contrastGrowth=${formatDb(group.contrastGrowthDb)} ` +
        `lane=${group.sourceEvidenceLane ?? "n/a"} ` +
        `peakDelta=${formatDb(group.sourcePeakDeltaDb)}`,
    );
  }
};

const printAssessments = (
  label: string,
  assessments: TamerAssessment[],
  limit = 10,
) => {
  console.log(`[${label}] count=${assessments.length}`);
  for (const assessment of assessments.slice(0, limit)) {
    const { group } = assessment;
    console.log(
      `  ${((group.frame * FRAME_MS) / 1000).toFixed(2)}s lane=${group.sourceEvidenceLane} ` +
        `growth=${assessment.initialGrowthDb.toFixed(2)}dB ` +
        `ownerCap=${assessment.expectedReductionDb.toFixed(2)}dB ` +
        `deliveredReduction=${assessment.deliveredReductionDb.toFixed(2)}dB ` +
        `remainingGrowth=${assessment.remainingGrowthDb.toFixed(2)}dB ` +
        `afterPeak=${assessment.afterPeakDb.toFixed(1)}dB ` +
        `afterOverBody=${assessment.afterPeakOverBodyDb.toFixed(1)}dB ` +
        `reason=${[
          assessment.visibleResidual ? "visible-residual" : null,
          assessment.conservativeBoundaryUnderDelivery ? "boundary-under-delivery" : null,
          assessment.ownerCapViolation ? "owner-cap-exceeded" : null,
        ].filter(Boolean).join(",") || "none"}`,
    );
  }
};

const main = () => {
const source = loadMono(sourcePath);
const rendered = loadMono(renderPath);

console.log(
  `[Files] source=${source.name} rendered=${rendered.name} sourceSr=${source.sampleRate}Hz ` +
    `renderedSr=${rendered.sampleRate}Hz ` +
    `duration=${(rendered.samples.length / rendered.sampleRate).toFixed(2)}s`,
);

const sourceReference = buildRenderedConsonantReference(
  source.samples,
  source.sampleRate,
  RENDERED_CONSONANT_SOURCE_FRAME_MS,
);
const beforeMetrics = measureFrames(rendered.samples, rendered.sampleRate);
const tamed = sourceReference
  ? tameRenderedConsonantPeaks(rendered.samples, rendered.sampleRate, FRAME_MS, {
      reference: sourceReference,
      referenceMatchWindowMs: REFERENCE_MATCH_WINDOW_MS,
      maxReductionDb: 2.5,
    })
  : {
      samples: new Float32Array(rendered.samples),
      stats: {
        tamedFrameCount: 0,
        maxReductionDb: 0,
        referenceLagMs: 0,
        referenceUsed: false,
        referenceConfidence: 0,
      },
    };
const sourceComparisonAvailable = Boolean(sourceReference && tamed.stats.referenceUsed);
const sourceMetrics: FrameMetrics | null = sourceComparisonAvailable
  ? {
      rmsDb: sourceReference!.rmsDb,
      peakDb: sourceReference!.peakDb,
      samplesPerFrame: Math.max(1, (source.sampleRate * SOURCE_FRAME_MS) / 1000),
    }
  : null;
const beforeGroups = buildSpikeGroups(
  beforeMetrics,
  sourceMetrics,
  tamed.stats.referenceLagMs,
  source.sampleRate,
  rendered.sampleRate,
);
printGroups("Before", beforeGroups);
const afterMetrics = measureFrames(tamed.samples, rendered.sampleRate);
const afterGroups = buildSpikeGroups(
  afterMetrics,
  sourceMetrics,
  tamed.stats.referenceLagMs,
  source.sampleRate,
  rendered.sampleRate,
);
const bodyDelta = speechBodyDeltaDb(beforeMetrics, afterMetrics, beforeGroups);
printGroups("AfterTamer", afterGroups);

const worstBefore = beforeGroups.reduce((peak, group) => Math.max(peak, group.peakDb), -120);
const worstAfter = afterGroups.reduce((peak, group) => Math.max(peak, group.peakDb), -120);
const assessments = assessTamerDelivery(beforeGroups, afterMetrics);
const ownerCapViolations = assessments.filter((assessment) => assessment.ownerCapViolation);
const advisories = assessments.filter((assessment) => assessment.advisory);
const speechBodyMovementViolation = Math.abs(bodyDelta.deltaDb) > CONSERVATIVE_SPEECH_BODY_MOVEMENT_DB;
const globalCapViolation =
  tamed.stats.maxReductionDb > SOURCE_STRONG_MAX_REDUCTION_DB + REDUCTION_DELIVERY_TOLERANCE_DB;
const inconclusiveAfter = !sourceComparisonAvailable;

printAssessments("OwnerCapViolation", ownerCapViolations);
printAssessments("ConservativeAdvisory", advisories);

console.log(
  `[Tamer] touched=${tamed.stats.tamedFrameCount} maxReduction=${tamed.stats.maxReductionDb.toFixed(1)}dB ` +
    `sourceLag=${tamed.stats.referenceLagMs.toFixed(1)}ms ` +
    `sourceConfidence=${tamed.stats.referenceConfidence.toFixed(2)} ` +
    `worstPeak ${worstBefore.toFixed(1)}dB -> ${worstAfter.toFixed(1)}dB ` +
    `speechBodyDelta=${bodyDelta.deltaDb.toFixed(3)}dB over ${bodyDelta.frameCount} frame(s)`,
);

if (inconclusiveAfter) {
  console.log("[Verdict] INCONCLUSIVE - source comparison is globally unavailable or untrusted");
  process.exit(2);
}
if (ownerCapViolations.length > 0 || speechBodyMovementViolation || globalCapViolation) {
  console.log(
    `[Verdict] FAIL - source-aware tamer safety invariant violated ` +
      `(ownerCap=${ownerCapViolations.length}, bodyMovement=${speechBodyMovementViolation}, ` +
      `globalCap=${globalCapViolation})`,
  );
  process.exit(1);
}
if (advisories.length > 0) {
  console.log(
    `[Verdict] PASS - ${advisories.length} conservative boundary/residual advisory event(s); safety invariants preserved`,
  );
  process.exit(0);
}
console.log("[Verdict] PASS - source-aware tamer safety invariants preserved");
process.exit(0);
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
