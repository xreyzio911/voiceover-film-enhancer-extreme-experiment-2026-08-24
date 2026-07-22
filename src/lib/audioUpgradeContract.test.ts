import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const voLevelerSource = readFileSync(new URL("../components/VoLeveler.tsx", import.meta.url), "utf8");
const chunkedConsonantTamerSource = readFileSync(
  new URL("./chunkedConsonantTamer.ts", import.meta.url),
  "utf8",
);

const textBetween = (source: string, startMarker: string, endMarker: string) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
};

const sourceBetween = (startMarker: string, endMarker: string) =>
  textBetween(voLevelerSource, startMarker, endMarker);

const assertMarkersInOrder = (source: string, markers: string[]) => {
  let cursor = 0;
  for (const marker of markers) {
    const index = source.indexOf(marker, cursor);
    assert.ok(index >= cursor, `missing or out-of-order marker: ${marker}`);
    cursor = index + marker.length;
  }
};

test("final app polish uses the isolated linear filter instead of rerunning the mix chain", () => {
  const finalPolishBlock = sourceBetween(
    "const runFinalAppPolishPass = async",
    "const analyzeIntegratedLoudness = async",
  );

  assert.match(finalPolishBlock, /buildFinalPolishFilter\(/);
  assert.match(finalPolishBlock, /"-af",\s*finalPolishFilter/);
  assert.match(finalPolishBlock, /"Linear final app polish"/);
  assert.doesNotMatch(finalPolishBlock, /runMixReady\(/);
});

test("speech-only spectrum drives tone, tilts, and de-essing without changing the QC speech mask", () => {
  const envelopeBlock = sourceBetween(
    "const computeEnvelopeMetrics = (samples: Float32Array)",
    "const parseSilencedetectSpans =",
  );
  const adaptiveProfileBlock = sourceBetween(
    "const buildAdaptiveProfile = (analysis: FileAnalysis | undefined, reference: BatchReference | null)",
    "const buildOnsetTamerFilter =",
  );

  assert.match(envelopeBlock, /const activityNoiseFloorDb = percentile\(frameDb, 25\) \?\? -72/);
  assert.match(envelopeBlock, /buildSpeechMask\(frameDb, activityNoiseFloorDb/);
  assert.match(envelopeBlock, /const spectralDecisionDb = speechBandSpectrumDb \?\? bandSpectrumDb/);
  assert.match(envelopeBlock, /computeSibilanceScore\(spectralDecisionDb\)/);
  assert.match(adaptiveProfileBlock, /deriveSpectrumTiltsDb\(analysis\.speechBandSpectrumDb \?\? \[\]\)/);
  assert.match(adaptiveProfileBlock, /const deEsserSpectrumDb = analysis\.speechBandSpectrumDb \?\? analysis\.bandSpectrumDb/);
  assert.match(adaptiveProfileBlock, /bandSpectrumDb: deEsserSpectrumDb/);
});

test("audibility recovery aligns measured DSP latency before judging speech loss", () => {
  const guardBlock = sourceBetween(
    "const assertRenderedAudibility = async",
    "// Candidate renders normally receive a file-level planner context",
  );

  assertMarkersInOrder(guardBlock, [
    "sourceAudibilityFrameDb = await renderAudibilityFrameDb(",
    "const renderedFrameDb = await renderAudibilityFrameDb(",
    "detectAlignedAudibilityDropouts({",
    "maxAlignmentMs: 60",
    "const report = alignedResult.finalReport",
  ]);
  assert.match(guardBlock, /aligned render latency/);
  assert.doesNotMatch(
    guardBlock,
    /const report = detectAudibilityDropouts\(/,
    "production recovery must not judge unaligned frame timestamps",
  );
});

test("normal output variants keep their source key for the one final source-relative sweep", () => {
  const plannedGainBlock = sourceBetween(
    "type PlannedGain = {",
    "const planGainForInput = async",
  );
  const plannerBlock = sourceBetween(
    "const planGainForInput = async",
    "const PLANNER_APPLY_CHUNK_SECONDS_DEFAULT",
  );
  const processFilesBlock = sourceBetween(
    "const processFiles = async () =>",
    "const downloadOutputsSequentially = async",
  );

  assert.match(plannedGainBlock, /sourceConsonantReference: RenderedConsonantReference \| null/);
  assertMarkersInOrder(plannerBlock, [
    "const samples = decoded.samples",
    "const sourceConsonantReference = buildRenderedConsonantReference(",
    "samples,",
    "GAIN_PLANNER_ANALYSIS_SAMPLE_RATE,",
    "sourceConsonantReference,",
  ]);
  assert.match(
    processFilesBlock,
    /consonantReferencesByOutputKey\.set\(job\.base, sourceConsonantReference\)/,
    "the source reference must be retained until final delivery",
  );
  assert.match(
    processFilesBlock,
    /if \(!sourceConsonantReference && plannerContext\.plan\?\.sourceConsonantReference\)[\s\S]*?consonantReferencesByOutputKey\.set\(job\.base, plannerContext\.plan\.sourceConsonantReference\)/,
    "20-80 minute files must reuse the compact 16 kHz planner reference when full-rate review decode is skipped",
  );
  assert.equal(
    voLevelerSource.match(/RENDERED_CONSONANT_SOURCE_FRAME_MS/g)?.length ?? 0,
    4,
    "all three production source-reference builders must use the 2 ms event-local evidence resolution",
  );
  assert.doesNotMatch(
    voLevelerSource,
    /buildRenderedConsonantReference\([\s\S]{0,180}GAIN_PLANNER_FRAME_MS/,
    "a 10 ms compact reference can merge adjacent consonants into one destructive decision",
  );
  assert.ok(
    (processFilesBlock.match(/sourceBase: job\.base/g)?.length ?? 0) >= 4,
    "clean, blend, and loudness outputs must retain the source lookup key",
  );
});

test("long-form output variants retain each chunk-local source reference for final delivery", () => {
  const longFormBlock = sourceBetween(
    "const renderLongFormSafeMode = async",
    "const safeDeleteFile = async",
  );

  assert.ok(
    (longFormBlock.match(/stagedConsonantReferences\.push\(\[[^\]]+\.name, chunkConsonantReference\]\)/g)?.length ?? 0) >= 4,
    "every emitted long-form variant must stage its exact output name with the matching chunk reference",
  );
  assertMarkersInOrder(longFormBlock, [
    "const stagedOutputs: OutputEntry[] = []",
    "const stagedConsonantReferences: Array<readonly [string, RenderedConsonantReference]> = []",
    "stagedOutputs.push(mixOutput)",
    "stagedConsonantReferences.push([mixOutput.name, chunkConsonantReference])",
    "outputEntries.push(...stagedOutputs)",
    "for (const [outputName, reference] of stagedConsonantReferences)",
    "consonantReferencesByOutputKey.set(outputName, reference)",
  ]);
  assert.ok(
    (longFormBlock.match(/sourceBase: job\.base/g)?.length ?? 0) >= 4,
    "long-form output metadata must retain the parent source key",
  );
});

test("final residual sweep covers every output after optional batch alignment and before exposure", () => {
  const batchAlignmentBlock = sourceBetween(
    "const alignBatchMixReadyOutputs = async",
    "const applyFinalConsonantResidualToOutputs = async",
  );
  const residualSweepBlock = sourceBetween(
    "const applyFinalConsonantResidualToOutputs = async",
    "const runLoudnorm = async",
  );
  const processFilesBlock = sourceBetween(
    "const processFiles = async () =>",
    "const downloadOutputsSequentially = async",
  );
  const longFormRendererBlock = sourceBetween(
    "const renderLongFormSafeMode = async",
    "const safeDeleteFile = async",
  );
  const finalDeliveryBlock = textBetween(
    processFilesBlock,
    "if (loudnessConfig === null) {",
    "setReviewBundles(finalReviewBundles)",
  );

  assert.match(
    voLevelerSource,
    /const FINAL_CONSONANT_TAMER_MAX_BYTES = 64 \* 1024 \* 1024/,
    "direct whole-WAV processing must stay below a bounded allocation budget; larger WAVs take the chunked path",
  );
  assertMarkersInOrder(residualSweepBlock, [
    "for (let index = 0; index < outputEntries.length; index += 1)",
    "const entry = outputEntries[index]",
    "consonantReferencesByOutputKey.get(entry.name)",
    "byteLength > FINAL_CONSONANT_TAMER_MAX_BYTES",
    "tameCanonicalMonoFloat32WavBlobInChunks(",
    "entry.blob,",
    "sourceReference,",
    "await applyFinalConsonantPeakPolish(",
    "new Uint8Array(await entry.blob.arrayBuffer())",
    "reference: sourceReference",
    "outputEntries[index] = { ...entry, blob: finalBlob, size: finalBlob.size }",
    "return outputEntries",
  ]);
  assert.match(
    residualSweepBlock,
    /final source-relative residual skipped; original bytes kept/,
    "a residual-pass failure must preserve the already-rendered output",
  );
  assert.doesNotMatch(
    residualSweepBlock,
    /exceeds .*memory guard/,
    "large final outputs must use bounded chunks instead of losing the optional source-relative pass",
  );
  assert.doesNotMatch(
    batchAlignmentBlock,
    /applyFinalConsonantPeakPolish\(/,
    "batch alignment must not duplicate the shared final residual sweep",
  );
  assertMarkersInOrder(finalDeliveryBlock, [
    "alignBatchMixReadyOutputs(",
    "applyFinalConsonantResidualToOutputs(",
    "buildFinalReviewBundles(",
    "setOutputs([...finalOutputEntries])",
  ]);
  assert.match(
    finalDeliveryBlock,
    /finalization failed; completed original outputs kept/,
    "late optional-finalizer failures must publish completed original outputs instead of losing them",
  );

  const outputPublishMatches = [
    ...processFilesBlock.matchAll(/setOutputs\(\[\.\.\.finalOutputEntries\]\)/g),
  ];
  assert.equal(
    outputPublishMatches.length,
    1,
    "provisional per-file bytes must stay internal until the shared finalizer finishes",
  );
  assert.ok(
    (outputPublishMatches[0]?.index ?? -1) >
      processFilesBlock.indexOf("applyFinalConsonantResidualToOutputs("),
    "the only output publication must follow the shared final residual sweep",
  );
  assert.doesNotMatch(
    longFormRendererBlock,
    /setOutputs\(/,
    "long-form chunks must not publish provisional bytes before shared finalization",
  );
});

test("a late worker failure still finalizes and publishes already completed outputs", () => {
  const processFilesBlock = sourceBetween(
    "const processFiles = async () =>",
    "const downloadOutputsSequentially = async",
  );
  const outerCatchBlock = textBetween(
    processFilesBlock,
    "} catch (err) {",
    "} finally {",
  );

  assertMarkersInOrder(processFilesBlock, [
    "const outputEntries: OutputEntry[] = []",
    "try {",
  ]);
  assertMarkersInOrder(outerCatchBlock, [
    "if (outputEntries.length > 0)",
    "applyFinalConsonantResidualToOutputs(",
    "buildFinalReviewBundles(",
    "setOutputs(",
    "setReviewBundles(",
    'setStatus("Done with warnings")',
  ]);
});

test("a recoverable per-file retry discards only that failed attempt's provisional artifacts", () => {
  const processFilesBlock = sourceBetween(
    "const processFiles = async () =>",
    "const downloadOutputsSequentially = async",
  );
  const retryBlock = textBetween(
    processFilesBlock,
    "if (retryAttempt < PER_FILE_MAX_RETRIES",
    "// Permanent failure",
  );

  assertMarkersInOrder(processFilesBlock, [
    "const attemptOutputCount = outputEntries.length",
    "const attemptReviewBundleCount = nextReviewBundles.length",
    "const attemptReferenceKeys = new Set(consonantReferencesByOutputKey.keys())",
    "try {",
  ]);
  assertMarkersInOrder(retryBlock, [
    "outputEntries.splice(attemptOutputCount)",
    "nextReviewBundles.splice(attemptReviewBundleCount)",
    "for (const key of consonantReferencesByOutputKey.keys())",
    "if (!attemptReferenceKeys.has(key))",
    "consonantReferencesByOutputKey.delete(key)",
    "continue",
  ]);
});

test("source-relative consonant polish has one cumulative-capped delivery call site", () => {
  const levelInputRangeBlock = sourceBetween(
    "const levelInputRange = async",
    "const applyPlannerToFullInput = async",
  );
  const finalizerBlock = sourceBetween(
    "const applyFinalConsonantResidualToOutputs = async",
    "const runLoudnorm = async",
  );
  const directPolishBlock = sourceBetween(
    "const applyFinalConsonantPeakPolish = async",
    "const toFloatSamples =",
  );

  assert.equal(
    voLevelerSource.match(/await applyFinalConsonantPeakPolish\(/g)?.length ?? 0,
    1,
    "the 2.5 dB source-relative cap must be cumulative, not reset by stacked passes",
  );
  assert.doesNotMatch(
    levelInputRangeBlock,
    /tameRenderedConsonantPeaks\(/,
    "planner output must wait for the single exact-byte delivery comparison",
  );
  assert.match(finalizerBlock, /await applyFinalConsonantPeakPolish\(/);
  assert.equal(
    directPolishBlock.match(/tameRenderedConsonantPeaks\(/g)?.length ?? 0,
    1,
    "direct final polish must invoke the source-relative tamer exactly once so lane caps stay cumulative",
  );
  assert.doesNotMatch(
    directPolishBlock,
    /followup|follow-up/i,
    "direct final polish must not hide a second residual pass that resets weak or strong lane budgets",
  );
  assert.doesNotMatch(voLevelerSource, /FINAL_CONSONANT_RESIDUAL_FOLLOWUP_MAX_REDUCTION_DB/);
  assert.doesNotMatch(
    chunkedConsonantTamerSource,
    /tameSourceRelativeConsonantsWithFollowup|SOURCE_RELATIVE_FOLLOWUP_MAX_REDUCTION_DB/,
    "the chunk implementation must expose only its actual one-pass delivery path",
  );
});

test("QC review winner bytes and metrics are rebuilt after exact final output mutation", () => {
  const processFilesBlock = sourceBetween(
    "const processFiles = async () =>",
    "const downloadOutputsSequentially = async",
  );
  const reviewBuilderBlock = sourceBetween(
    "const buildFinalReviewBundles = async",
    "const runLoudnorm = async",
  );
  const manifestBuilderBlock = sourceBetween(
    "const buildSingleWinnerManifest = (",
    "if (MAX_CORRECTIVE_PASSES > 0",
  );

  assertMarkersInOrder(reviewBuilderBlock, [
    "entry.sourceBase === pending.jobBase",
    'entry.kind === "mixready"',
    'entry.variant === "clean"',
    "entry.partIndex === undefined",
    "finalOutput.blob.size > FINAL_CONSONANT_TAMER_MAX_BYTES",
    "await pending.buildFromFinalOutput(finalOutput)",
  ]);
  assert.match(reviewBuilderBlock, /audio outputs continue/);
  assert.match(processFilesBlock, /const nextReviewBundles: PendingReviewBundleEntry\[\] = \[\]/);
  assert.match(
    processFilesBlock,
    /buildFromFinalOutput: async \(finalOutput\)[\s\S]*?new Uint8Array\(await finalOutput\.blob\.arrayBuffer\(\)\)[\s\S]*?buildArtifactForRenderedMix\([\s\S]*?buildSingleWinnerManifest\(finalArtifact, finalReviewChallengerArtifact, finalReason\)[\s\S]*?path: "winner\.wav", blob: finalOutput\.blob/,
    "winner metrics and winner.wav must both describe the exact post-tamer final Blob while challenger history is retained",
  );
  assertMarkersInOrder(manifestBuilderBlock, [
    "baselineScore: artifact.baselineScore",
    "ranking: artifact.ranking",
    "qc: artifact.qcSnapshot",
    "alignment: artifact.alignment",
    "qcDelta: artifact.qcDelta",
  ]);
  assertMarkersInOrder(processFilesBlock, [
    "applyFinalConsonantResidualToOutputs(",
    "buildFinalReviewBundles(",
    "setOutputs(",
    "setReviewBundles(",
  ]);
});

test("final consonant delivery releases replaced blobs and avoids a second full WAV decode", () => {
  const polishBlock = sourceBetween(
    "const applyFinalConsonantPeakPolish = async",
    "const toFloatSamples =",
  );
  const residualSweepBlock = sourceBetween(
    "const applyFinalConsonantResidualToOutputs = async",
    "const runLoudnorm = async",
  );

  assert.doesNotMatch(polishBlock, /decodeWav\(polishedBytes\)/);
  assert.match(polishBlock, /return \{ buffer: polishedBytes\.buffer/);
  assert.doesNotMatch(residualSweepBlock, /const finalEntries/);
  assert.match(residualSweepBlock, /outputEntries\[index\] = \{ \.\.\.entry, blob: finalBlob/);
  assert.doesNotMatch(residualSweepBlock, /reviewBlobFromBytes\(result/);
});
