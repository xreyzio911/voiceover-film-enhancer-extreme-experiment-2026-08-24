import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveGainPlannerOutcome } from "./plannerFallbackPolicy.ts";

const voLevelerSource = readFileSync(new URL("../components/VoLeveler.tsx", import.meta.url), "utf8");
const qcReportLabSource = readFileSync(
  new URL("../components/QcReportLab.tsx", import.meta.url),
  "utf8",
);
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

test("speech-bearing input without a usable gain plan remains a source-preserving output", () => {
  const outcome = resolveGainPlannerOutcome({
    hasUsablePlan: false,
    speechBearing: true,
  });

  assert.equal(outcome.action, "render-source-preserving");
  assert.equal(outcome.shouldEmitOutput, true);
  assert.equal(outcome.claimsAdaptiveEnhancement, false);
  assert.equal(outcome.candidateVariant, "source-safe");
  assert.equal(outcome.sourcePassthroughChain, true);
  assert.equal(outcome.disableLimiter, true);
});

test("planner no-plan fallback is wired to a truthful source-preserving render instead of throwing", () => {
  const plannerContextBlock = sourceBetween(
    "const preparePlannerRenderContext = async",
    "const formatCandidateVariant =",
  );
  const processFilesBlock = sourceBetween(
    "const processFiles = async () =>",
    "const downloadOutputsSequentially = async",
  );

  assert.match(plannerContextBlock, /resolveGainPlannerOutcome\(\{/);
  assert.match(plannerContextBlock, /context\.sourcePreservingFallback = true/);
  assert.match(plannerContextBlock, /no adaptive enhancement claimed/);
  assert.doesNotMatch(
    plannerContextBlock,
    /throw new Error\("speech-aware planner produced no plan on speech-bearing input"\)/,
  );
  assertMarkersInOrder(processFilesBlock, [
    'const candidateVariants: CandidateVariant[] = plannerContext.sourcePreservingFallback',
    '["source-safe"]',
    "sourcePassthroughChain: plannerContext.sourcePreservingFallback",
    "disableLimiter: plannerContext.sourcePreservingFallback",
    "disableGainPlanner: plannerContext.sourcePreservingFallback",
    "selectedSourcePreservingFallback",
    "final polish skipped; planner produced no usable gain plan",
    "corrective processing skipped; planner produced no usable gain plan",
  ]);
});

test("planner no-plan output stays source-preserving through every later delivery transform", () => {
  const outputEntryBlock = sourceBetween(
    "type OutputEntry = {",
    "type ReviewBundleAsset =",
  );
  const batchAlignmentBlock = sourceBetween(
    "const alignBatchMixReadyOutputs = async",
    "const applyFinalConsonantResidualToOutputs = async",
  );
  const renderFallbackBlock = sourceBetween(
    "const renderMixReadyWithFallbacks = async",
    "let lastMixError: unknown = null",
  );
  const finalResidualBlock = sourceBetween(
    "const applyFinalConsonantResidualToOutputs = async",
    "const buildFinalReviewBundles = async",
  );
  const processFilesBlock = sourceBetween(
    "const processFiles = async () =>",
    "const downloadOutputsSequentially = async",
  );

  assert.match(outputEntryBlock, /sourcePreservingFallback\?: boolean/);
  assertMarkersInOrder(renderFallbackBlock, [
    "options?.sourcePassthroughChain",
    "source-preserving passthrough",
    "disableLimiter: true",
    "if (!options?.sourcePassthroughChain)",
    "room cleanup bypass",
    "stability-safe chain",
    "audibility passthrough",
  ]);
  assert.match(
    batchAlignmentBlock,
    /\.filter\(\(\{ entry \}\) => entry\.kind === "mixready" && !entry\.sourcePreservingFallback\)/,
  );
  assert.match(batchAlignmentBlock, /excluded \(source-preserving planner fallback\)/);
  assertMarkersInOrder(finalResidualBlock, [
    "if (entry.sourcePreservingFallback)",
    "source-preserving planner fallback; original bytes kept",
    "continue",
  ]);
  assertMarkersInOrder(processFilesBlock, [
    "shouldEmitMixReadyOutput(loudnessConfig !== null) || selectedSourcePreservingFallback",
    "sourcePreservingFallback: selectedSourcePreservingFallback",
    "sceneBlend && !selectedSourcePreservingFallback",
    "loudnessConfig && !selectedSourcePreservingFallback",
    "decoded 48 kHz float source-preserving output",
  ]);
  assert.match(
    voLevelerSource,
    /Source-preserving fallback: the gain planner returned no usable plan, so no adaptive enhancement or later mastering transform was applied\./,
  );
});

test("adaptive diagnostics identify percentage scores as lower-is-better risks", () => {
  assert.match(voLevelerSource, /QC risks \(lower is better\): instability/);
  assert.match(voLevelerSource, /click artifacts risk/);
});

test("QC Lab explains risk direction instead of showing ambiguous percentage scores", () => {
  assert.match(qcReportLabSource, /Percentages are risk scores — lower is better\./);
  assert.match(qcReportLabSource, />Instability risk</);
  assert.match(qcReportLabSource, />Click artifacts risk</);
  assert.match(qcReportLabSource, />Echo risk</);
});

test("QC Lab large-WAV path uses the shared adaptive click detector", () => {
  const streamingQcBlock = textBetween(
    qcReportLabSource,
    "const analyzePcmWavStreaming = async",
    "const createEmptyReviewDraft =",
  );

  assertMarkersInOrder(streamingQcBlock, [
    "const analyzedFrames =",
    "countAdaptiveSampleClickDiscontinuitiesBounded({",
    "loadSamples: async (startSample, endSample)",
    "clickDetection.count,",
  ]);
  assert.doesNotMatch(
    streamingQcBlock,
    /diff\s*>=\s*0\.09[\s\S]{0,80}abs\s*>=\s*0\.015/,
    "large WAVs must not fall back to the obsolete fixed-difference click rule",
  );
});

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

test("planner-active secondary dynamics use continuous speech evidence instead of a fixed large lift", () => {
  const mixFilterBlock = sourceBetween(
    "const buildMixFilter = (profile: AdaptiveProfile | null, options?: MixRenderOptions)",
    "const runMixReady = async",
  );

  assert.match(
    mixFilterBlock,
    /const baseSecondaryMaxGainFactor = toOddInt\(5 \* levelerAdaptationScale, 3, 11\)/,
  );
  assert.match(mixFilterBlock, /resolvePlannerSecondaryMaxGainFactor\(\{/);
  assert.match(mixFilterBlock, /baseMaxGainFactor: baseSecondaryMaxGainFactor/);
  assert.match(mixFilterBlock, /speechDutyCyclePct: profile\?\.speechDutyCyclePct \?\? null/);
  assert.match(mixFilterBlock, /speechSegmentCount: profile\?\.speechSegmentCount \?\? null/);
  assert.match(mixFilterBlock, /m=\$\{secondaryMaxGainFactor\.toFixed\(3\)\}/);
  assert.doesNotMatch(mixFilterBlock, /baseMaxGainFactor:\s*5[,}]/);
});

test("speech-only spectrum and continuous event evidence drive de-essing without changing the QC speech mask", () => {
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
  assert.match(
    envelopeBlock,
    /computeEventSibilanceAuthority\(samples, ANALYSIS_SAMPLE_RATE, \{/,
  );
  assert.match(envelopeBlock, /activityMask/);
  assert.match(envelopeBlock, /activityFrameMs: ENVELOPE_FRAME_MS/);
  assert.doesNotMatch(envelopeBlock, /maxAuthority/);
  assert.match(
    envelopeBlock,
    /Math\.max\(computeSibilanceScore\(spectralDecisionDb\), eventSibilanceAuthority\)/,
  );
  assert.match(adaptiveProfileBlock, /deriveSpectrumTiltsDb\(analysis\.speechBandSpectrumDb \?\? \[\]\)/);
  assert.match(adaptiveProfileBlock, /const deEsserSpectrumDb = analysis\.speechBandSpectrumDb \?\? analysis\.bandSpectrumDb/);
  assert.match(adaptiveProfileBlock, /bandSpectrumDb: deEsserSpectrumDb/);
});

test("distributed speech spectra retain recurring event authority without a binary engagement gate", () => {
  const aggregationBlock = sourceBetween(
    "const aggregateWindowAnalyses = (",
    "type AnalysisOptions =",
  );

  assertMarkersInOrder(aggregationBlock, [
    "const eventSibilanceAuthority = weightedMetric(",
    "const speechBandMedians =",
    "aggregated.speechBandSpectrumDb = speechBandMedians",
    "aggregated.sibilanceScore = Math.max(",
    "computeSibilanceScore(speechBandMedians)",
    "eventSibilanceAuthority ?? 0",
  ]);
  assert.doesNotMatch(aggregationBlock, /sibilanceScore\s*>=/);
});

test("window QC carries the measured sentence-jump and breath-spike evidence into aggregation", () => {
  const windowAnalysisBlock = sourceBetween(
    "const analyzeFileWindow = async",
    "const aggregateWindowAnalyses = (",
  );

  assert.match(windowAnalysisBlock, /analysis\.sentenceJumpScore = envelope\.sentenceJumpScore/);
  assert.match(windowAnalysisBlock, /analysis\.breathSpikeRisk = envelope\.breathSpikeRisk/);
});

test("de-esser depth follows a continuous evidence curve without the legacy engagement gate", () => {
  const mixFilterBlock = sourceBetween(
    "const buildMixFilter = (profile: AdaptiveProfile | null, options?: MixRenderOptions)",
    "const runMixReady = async",
  );

  assert.match(mixFilterBlock, /resolveDeEsserCutsDb\(sibilanceScore\)/);
  assert.match(mixFilterBlock, /mainCutDb\.toFixed\(2\)/);
  assert.match(mixFilterBlock, /secondaryCutDb\.toFixed\(2\)/);
  assert.doesNotMatch(mixFilterBlock, /sibilanceScore\s*>=\s*0\.4/);
  assert.doesNotMatch(mixFilterBlock, /1\.2 \+ depthNorm/);
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

test("normal output variants upgrade planner evidence to a native-rate source reference", () => {
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
    "the compact planner reference remains a fail-open fallback until native planner-apply evidence exists",
  );
  assert.match(
    processFilesBlock,
    /plannerContext\.nativeSourceConsonantReference[\s\S]*?consonantReferencesByOutputKey\.set\(job\.base, plannerContext\.nativeSourceConsonantReference\)/,
    "native 48 kHz evidence collected during planner apply must replace the 16 kHz fallback",
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

test("final consonant residual fails open when fallback evidence lacks delivery bandwidth", () => {
  const finalResidualBlock = sourceBetween(
    "const applyFinalConsonantResidualToOutputs = async",
    "const buildFinalReviewBundles = async",
  );

  assertMarkersInOrder(finalResidualBlock, [
    "if (!sourceReference)",
    "isConsonantReferenceBandwidthCompatible(",
    "sourceReference.sampleRate",
    "PLANNER_APPLY_SAMPLE_RATE",
    "tameCanonicalMonoFloat32WavBlobInChunks(",
  ]);
  assert.match(finalResidualBlock, /reference bandwidth[\s\S]*original bytes kept/);
});

test("planner apply accumulates native reference frames while excluding duplicated crossfade tails", () => {
  const levelInputRangeBlock = sourceBetween(
    "const levelInputRange = async",
    "const applyPlannerToFullInput = async",
  );
  const plannerApplyBlock = sourceBetween(
    "const applyPlannerToFullInput = async",
    "const emptyEnvelopeMetrics =",
  );

  assert.match(levelInputRangeBlock, /sourceStartSample/);
  assert.match(levelInputRangeBlock, /uniqueEndSample/);
  assert.match(levelInputRangeBlock, /referenceAccumulator\.append/);
  assertMarkersInOrder(plannerApplyBlock, [
    "createNativeConsonantReferenceAccumulator({",
    "sampleRate: PLANNER_APPLY_SAMPLE_RATE",
    "nativeSpans[index]",
    "uniqueDurationSec",
    "finalizeReference(referenceAccumulator",
  ]);
  assert.doesNotMatch(
    plannerApplyBlock,
    /sampleRate:\s*GAIN_PLANNER_ANALYSIS_SAMPLE_RATE/,
    "planner-apply references must not inherit the 16 kHz analysis domain",
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

test("long-form references use bounded native-rate subranges instead of one 16 kHz part decode", () => {
  const referenceBuilderBlock = sourceBetween(
    "const buildConsonantReferenceForInputRange = async",
    "const renderLongFormSafeMode = async",
  );

  assert.match(referenceBuilderBlock, /createNativeConsonantReferenceAccumulator\(/);
  assert.match(referenceBuilderBlock, /PLANNER_APPLY_SAMPLE_RATE/);
  assert.match(referenceBuilderBlock, /LONG_FORM_REFERENCE_DECODE_SECONDS/);
  assert.match(referenceBuilderBlock, /while \(cursorSample < totalSampleCount/);
  assert.doesNotMatch(referenceBuilderBlock, /GAIN_PLANNER_ANALYSIS_SAMPLE_RATE/);
});

test("large rendered-candidate QC analyzes bounded WAV windows without restoring whole files after retry", () => {
  const boundedQcBlock = sourceBetween(
    "const analyzeRenderedPcmWindows = async",
    "const buildBatchReference =",
  );
  const processFilesBlock = sourceBetween(
    "const processFiles = async () =>",
    "const downloadOutputsSequentially = async",
  );

  assertMarkersInOrder(boundedQcBlock, [
    "inspectMonoFloat32Wav(inputBytes)",
    "selectDistributedAnalysisWindowsWithConfig(",
    "await safeDeleteFile(ffmpeg, inputName)",
    "sliceMonoFloat32Wav(inputBytes",
    "await analyzeFileWindow(ffmpeg, windowName, 0",
    "aggregateWindowAnalyses(",
  ]);
  assert.doesNotMatch(
    boundedQcBlock,
    /restoreRecoveryInputs|ensureRecoveryInputBytes/,
    "a small-window retry must not rehydrate 100-200 MB source and render WAVs",
  );
  assert.match(
    boundedQcBlock,
    /ffmpeg\.writeFile\(windowName, cloneBytes\(boundedWindow\.bytes\)\)/,
    "each worker attempt needs its own transferable copy so a failed write cannot detach the retry bytes",
  );
  assert.match(boundedQcBlock, /analysisWindowsAttempted: windows\.length/);
  assert.match(boundedQcBlock, /analysisWindowsSucceeded: windowAnalyses\.length/);
  assert.match(boundedQcBlock, /analysisWindowsDropped: windowDropCount/);
  assert.match(processFilesBlock, /applyCandidateMeasurementWindowSummary\(candidateMeta, analysisResult\.windowSummary\)/);
  assert.match(processFilesBlock, /shouldUseBoundedCandidateQc[\s\S]*?analyzeRenderedPcmWindows\(/);
});

test("bounded QC and JavaScript review decodes share the same memory route", () => {
  const processFilesBlock = sourceBetween(
    "const processFiles = async () =>",
    "const downloadOutputsSequentially = async",
  );
  const artifactBuilderBlock = sourceBetween(
    "const buildArtifactForRenderedMix = async",
    "const buildSingleWinnerManifest =",
  );

  assert.doesNotMatch(processFilesBlock, /LONG_CANDIDATE_QC_SAFE_SECONDS/);
  assert.match(
    processFilesBlock,
    /const useBoundedSourceReviewMemory = shouldUseBoundedCandidateQc\([\s\S]*?estimateCanonicalMonoFloat32WavBytes\(candidateQcSafeDurationSeconds\)[\s\S]*?job\.file\.size[\s\S]*?\)/,
    "the source must not be fully decoded when its projected render already belongs on the bounded route",
  );
  assert.match(
    processFilesBlock,
    /const useBoundedCandidateReviewMemory = shouldUseBoundedCandidateQc\([\s\S]*?candidateBytes\.byteLength[\s\S]*?job\.file\.size[\s\S]*?\)/,
  );
  assert.match(
    processFilesBlock,
    /if \(!useBoundedCandidateReviewMemory\)[\s\S]*?candidateDecodedForReview = decodeWavToMono\(candidateBytes\)/,
  );
  assert.match(
    processFilesBlock,
    /if \(useBoundedCandidateReviewMemory && \(shouldRefreshForQcError \|\| isRecoverableFailure\(error\)\)\)[\s\S]*?candidateQcMemoryFailed = true/,
  );
  assert.match(
    processFilesBlock,
    /const alignment = useBoundedCandidateReviewMemory[\s\S]*?buildDurationOnlyAlignmentMetrics\(/,
  );
  assert.match(
    artifactBuilderBlock,
    /const useBoundedRenderedReviewMemory = shouldUseBoundedCandidateQc\([\s\S]*?bytes\.byteLength[\s\S]*?job\.file\.size[\s\S]*?\)/,
  );
  assert.match(
    artifactBuilderBlock,
    /if \(!useBoundedRenderedReviewMemory\)[\s\S]*?renderedDecodedForReview = decodeWavToMono\(bytes\)/,
  );
  assert.match(
    artifactBuilderBlock,
    /const alignment = useBoundedRenderedReviewMemory[\s\S]*?buildDurationOnlyAlignmentMetrics\(/,
  );
});

test("bounded post-render QC restores exact selected bytes even when window analysis fails", () => {
  const artifactBuilderBlock = sourceBetween(
    "const buildArtifactForRenderedMix = async",
    "const buildSingleWinnerManifest =",
  );

  assertMarkersInOrder(artifactBuilderBlock, [
    "let restoreRenderedBytesAfterQc = false",
    "restoreRenderedBytesAfterQc = useBoundedRenderedReviewMemory",
    "} finally {",
    "if (restoreRenderedBytesAfterQc)",
    "await ffmpeg.writeFile(renderedName, cloneBytes(bytes))",
  ]);
});

test("sampled candidate QC stays advisory instead of authorizing a file-wide corrective retry", () => {
  const scoreBuilderBlock = sourceBetween(
    "const buildCandidateScore = (analysis: FileAnalysis | null)",
    "const countUsableSpeechPauseBoundaries =",
  );
  const processFilesBlock = sourceBetween(
    "const processFiles = async () =>",
    "const downloadOutputsSequentially = async",
  );

  assert.match(scoreBuilderBlock, /buildCandidateScoreFromAnalysis\(analysis\)/);
  assert.match(
    processFilesBlock,
    /const hasFileScopedCorrectiveEvidence[\s\S]*?measurementStatus === "measured"/,
  );
  assert.match(
    processFilesBlock,
    /const shouldTryCorrective =[\s\S]*?correctiveTriggered[\s\S]*?hasFileScopedCorrectiveEvidence/,
  );
  assert.match(processFilesBlock, /sampled QC remains advisory; original render kept/);
  assert.doesNotMatch(
    processFilesBlock,
    /analysisWindowsSucceeded[\s\S]{0,100}>= 3/,
    "a successful sample count must not be promoted to file-wide evidence",
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
