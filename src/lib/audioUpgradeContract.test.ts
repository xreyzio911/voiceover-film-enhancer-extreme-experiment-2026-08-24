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
const finalPolishFilterSource = readFileSync(
  new URL("./finalPolishFilter.ts", import.meta.url),
  "utf8",
);
const gitignoreSource = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");

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

test("private local voice corpora are protected by exact root ignores", () => {
  assert.match(gitignoreSource, /^\/bug\/\r?$/m);
  assert.match(gitignoreSource, /^\/another testing\/\r?$/m);
});

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
    'let candidateVariants: CandidateVariant[] = plannerContext.sourcePreservingFallback',
    '["source-safe"]',
    "sourcePassthroughChain: plannerContext.sourcePreservingFallback",
    "disableLimiter: plannerContext.sourcePreservingFallback",
    "disableGainPlanner: plannerContext.sourcePreservingFallback",
    "selectedSourcePreservingFallback",
    "final polish skipped; planner produced no usable gain plan",
    "corrective processing skipped; planner produced no usable gain plan",
  ]);
});

test("the selected leveler preset continuously controls speech-planner consistency", () => {
  const plannerBlock = sourceBetween(
    "const planGainForInput = async",
    "const applyPlannerToFullInput = async",
  );

  assert.match(
    plannerBlock,
    /const activeControls = getActiveAudioReviewControls\(\)[\s\S]*?const activeLeveler = getLevelerForControls\(activeControls\)/,
    "the planner must read the same active leveler choice as the downstream chain",
  );
  assert.match(
    plannerBlock,
    /levelingConsistency:\s*LEVELER_CONSISTENCY\[activeLeveler\]/,
    "the adaptive consistency authority must be passed into the speech-aware gain planner",
  );
  assert.match(
    voLevelerSource,
    /const LEVELER_CONSISTENCY = \{[\s\S]*?"Minimal \(no auto-leveler\)": 0\.1,[\s\S]*?Gentle: 0\.25,[\s\S]*?Balanced: 0\.35,[\s\S]*?Firm: 0\.65,[\s\S]*?\} as const/,
    "preset authority should stay ordered while Balanced preserves roughly half of source line contrast",
  );
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
  const protectedOutputPredicate = sourceBetween(
    "const isProtectedOutputEntry =",
    "type ReviewBundleAsset =",
  );

  assert.match(outputEntryBlock, /sourcePreservingFallback\?: boolean/);
  assert.match(outputEntryBlock, /protectedRecovery\?: boolean/);
  assertMarkersInOrder(protectedOutputPredicate, [
    "entry.sourcePreservingFallback",
    "entry.sourceSafeRecovery",
    "entry.protectedRecovery",
  ]);
  assertMarkersInOrder(renderFallbackBlock, [
    "options?.sourcePassthroughChain",
    "source-preserving passthrough",
    "disableLimiter: options.disableLimiter === true",
    "if (!options?.sourcePassthroughChain)",
    "room cleanup bypass",
    "stability-safe chain",
    "audibility passthrough",
  ]);
  assert.match(
    batchAlignmentBlock,
    /\.filter\(\(\{ entry \}\) => entry\.kind === "mixready" && !isProtectedOutputEntry\(entry\)\)/,
  );
  assert.match(batchAlignmentBlock, /excluded \(protected recovery\/fallback\)/);
  assertMarkersInOrder(finalResidualBlock, [
    "if (isProtectedOutputEntry(entry))",
    "protected recovery/fallback; selected bytes kept",
    "continue",
  ]);
  assertMarkersInOrder(processFilesBlock, [
    "shouldEmitMixReadyOutput(loudnessConfig !== null) || finalSelectedDeliveryProtected",
    "sourcePreservingFallback: finalSelectedSourcePreservingFallback",
    "protectedRecovery: finalSelectedProtectedRecovery",
    "sceneBlend && !finalSelectedDeliveryProtected",
    "loudnessConfig && !finalSelectedDeliveryProtected",
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

  assert.match(finalPolishBlock, /resolveSourceRelativeFinalTone\(/);
  assert.match(finalPolishBlock, /resolveEvidenceAwarePlannerDeliveryMakeupDb\(/);
  assert.doesNotMatch(
    finalPolishBlock,
    /resolvePlannerDeliveryMakeupDb\(/,
    "the shipped final-polish path must not retain the legacy speech-only +10.5 dB authority",
  );
  assert.match(finalPolishBlock, /buildFinalPolishFilter\(/);
  assert.match(finalPolishBlock, /"-af",\s*finalPolishFilter/);
  assert.match(finalPolishBlock, /"Linear final app polish"/);
  assert.doesNotMatch(finalPolishBlock, /buildFinalPolishProfile/);
  assert.doesNotMatch(finalPolishBlock, /getActiveAudioReviewAdaptiveDirectives/);
  assert.doesNotMatch(finalPolishBlock, /runMixReady\(/);
});

test("every delivered limiter path compensates lookahead latency", () => {
  assert.match(
    voLevelerSource,
    /const LIMITER_FILTER = "alimiter=limit=-2dB:level=disabled:latency=1"/,
    "the primary mix limiter must preserve source timing",
  );
  assert.match(
    finalPolishFilterSource,
    /FINAL_POLISH_LIMITER_FILTER\s*=\s*"alimiter=limit=-2dB:level=disabled:latency=1"/,
    "the final-polish limiter must preserve source timing",
  );
  const staticFallbackBlock = sourceBetween(
    "const runStaticLoudnessFallback = async",
    "const alignBatchMixReadyOutputs = async",
  );
  assert.match(
    staticFallbackBlock,
    /alimiter=limit=\$\{cfg\.TP\}dB:level=disabled:latency=1/,
    "the static loudness fallback limiter must preserve source timing",
  );
});

test("planner delivery uses the existing speech mask and the selected pre-polish measurement", () => {
  const envelopeBlock = sourceBetween(
    "const computeEnvelopeMetrics = (samples: Float32Array)",
    "const parseSilencedetectSpans =",
  );
  const exactSampleEvidenceBlock = sourceBetween(
    "const measureFinalPolishEvidenceFromAnalysisSamples = (",
    "const mergeNativeFinalToneEvidence = (",
  );
  const exactEvidenceRecoveryBlock = sourceBetween(
    "const recoverFinalPolishEvidenceFromExactWav = async (",
    "const runCrossfadeConcat = async (",
  );
  const virtualEvidenceBlock = sourceBetween(
    "const measureFinalPolishEvidenceFromVirtualWav = async (",
    "const recoverFinalPolishEvidenceFromExactWav = async (",
  );
  const finalPolishBlock = sourceBetween(
    "const runFinalAppPolishPass = async",
    "const analyzeIntegratedLoudness = async",
  );
  const batchAlignmentBlock = sourceBetween(
    "const alignBatchMixReadyOutputs = async",
    "const applyFinalConsonantResidualToOutputs = async",
  );
  const longFormBlock = sourceBetween(
    "const renderLongFormSafeMode = async",
    "const safeDeleteFile = async",
  );
  const aggregationBlock = sourceBetween(
    "const aggregateWindowAnalyses = (",
    "type AnalysisOptions =",
  );
  const processFilesBlock = sourceBetween(
    "const processFiles = async () =>",
    "const downloadOutputsSequentially = async",
  );

  assertMarkersInOrder(envelopeBlock, [
    "const activityMask = buildSpeechMask(",
    "speechKWeightedEnergyDb = computeSpeechKWeightedEnergyDb(",
    "activityMask,",
    "speechBandSpectrumDb = computeLogBandSpectrumDb(",
    "plannerDeliverySafetyEvidence = measurePlannerDeliverySafetyEvidence(",
  ]);
  assert.match(
    aggregationBlock,
    /aggregated\.speechKWeightedEnergyDb = weightedMetric\([\s\S]*?speechKWeightedEnergyDb[\s\S]*?50/,
  );
  assert.match(
    processFilesBlock,
    /runFinalAppPolishPass\([\s\S]*?sourceFinalPolishEvidence,[\s\S]*?selectedFinalPolishEvidence,[\s\S]*?plannerContext\.plan\?\.targetDb/,
    "the selected candidate's measured post-chain speech level must drive only one static delivery gain",
  );
  assert.match(
    processFilesBlock,
    /candidateFinalPolishEvidence\s*=\s*await recoverFinalPolishEvidenceFromExactWav\([\s\S]*?candidateName,[\s\S]*?candidateBytes/,
    "a full-QC worker failure must recover delivery evidence from the exact rendered WAV",
  );
  assert.match(
    processFilesBlock,
    /correctiveFinalPolishEvidence\s*=\s*await recoverFinalPolishEvidenceFromExactWav\([\s\S]*?correctiveName,[\s\S]*?correctiveBytesBeforePolish/,
  );
  assert.match(exactEvidenceRecoveryBlock, /await ffmpeg\.writeFile\(targetName, cloneBytes\(exactBytes\)\)/);
  assert.match(
    virtualEvidenceBlock,
    /"-ar",\s*`\$\{ANALYSIS_SAMPLE_RATE\}`/,
    "fallback evidence must be decoded into the same 16 kHz domain as planner/source analysis",
  );
  assert.match(
    virtualEvidenceBlock,
    /measureFinalPolishEvidenceFromAnalysisSamples\(\s*toFloatSamples\(rawBytes\),\s*ANALYSIS_SAMPLE_RATE/,
  );
  assert.match(
    voLevelerSource,
    /const mergeNativeFinalToneEvidence = \([\s\S]*?measureNativeFinalToneSpectrumDb\(decoded\.monoSamples, decoded\.sampleRate\)/,
    "native-rate decodes may supply only the missing optional top-octave evidence",
  );
  assert.match(
    processFilesBlock,
    /candidateFinalPolishEvidence = mergeNativeFinalToneEvidence\([\s\S]*?candidateDecodedForReview/,
  );
  assert.match(
    finalPolishBlock,
    /resolveEvidenceAwarePlannerDeliveryMakeupDb\(\{[\s\S]*?speechKWeightedEnergyDb: renderedAnalysis\?\.speechKWeightedEnergyDb,[\s\S]*?sourceSafetyEvidence: sourceAnalysis\?\.plannerDeliverySafetyEvidence,[\s\S]*?renderedSafetyEvidence: renderedAnalysis\?\.plannerDeliverySafetyEvidence/,
    "native-rate evidence must not replace the established 16 kHz planner delivery measurement",
  );
  assert.match(
    exactSampleEvidenceBlock,
    /measurePlannerDeliverySafetyEvidence\([\s\S]*?samples,[\s\S]*?sampleRate,[\s\S]*?activityMask,[\s\S]*?ENVELOPE_FRAME_MS/,
    "the exact-WAV recovery path must measure nonzero-bed and peak authority from its shared decoded samples and speech mask",
  );
  assert.match(
    exactEvidenceRecoveryBlock,
    /measureFinalPolishEvidenceFromVirtualWav\(ffmpeg, targetName\)/,
  );
  assert.match(
    voLevelerSource,
    /type FinalPolishEvidence = Pick<[\s\S]*?"plannerDeliverySafetyEvidence"/,
    "delivery evidence must retain the source-relative noise and peak measurement",
  );
  assert.match(
    aggregationBlock,
    /aggregated\.plannerDeliverySafetyEvidence = null/,
    "sampled windows must not claim whole-file peak authority for positive file-wide gain",
  );
  assert.match(
    processFilesBlock,
    /selectedFinalPolishEvidence\s*=\s*selectedPostPolishArtifact\.finalPolishEvidence/,
    "batch alignment must use evidence measured from the selected post-polish bytes",
  );
  assert.match(
    processFilesBlock,
    /selectedFinalPolishEvidence\s*=\s*correctiveArtifact\.finalPolishEvidence/,
    "a winning corrective render must replace stale delivery evidence",
  );
  assert.match(
    processFilesBlock,
    /deliverySafetyEvidence:[\s\S]*?selectedFinalPolishEvidence\?\.plannerDeliverySafetyEvidence/,
  );
  assert.match(
    processFilesBlock,
    /const blendDeliverySafetyEvidence\s*=\s*resolveBlendDeliverySafetyEvidence\(\{[\s\S]*?inputSafetyEvidence:[\s\S]*?selectedFinalPolishEvidence\?\.plannerDeliverySafetyEvidence[\s\S]*?indoorGain,[\s\S]*?outdoorGain,[\s\S]*?deliverySafetyEvidence:\s*blendDeliverySafetyEvidence/,
    "scene-blend alignment must propagate a conservative envelope from the selected clean bytes",
  );
  assert.doesNotMatch(
    processFilesBlock,
    /measureFinalPolishEvidenceFromVirtualWav\([\s\S]{0,240}?job\.blendMixName/,
    "scene blend must not reintroduce an unbounded full-WAV evidence decode",
  );
  assert.match(
    longFormBlock,
    /long-form parts retain negative alignment, but optional positive batch gain is omitted because bounded windows cannot prove whole-file peak headroom/,
    "the memory-bounded long-form limitation must remain explicit and observable",
  );
  assertMarkersInOrder(batchAlignmentBlock, [
    "const finalPolishEvidence = await measureFinalPolishEvidenceFromVirtualWav(activeFfmpeg, inputName)",
    "const speechEnergyDb = finalPolishEvidence?.speechKWeightedEnergyDb",
    "values.push(speechEnergyDb)",
    "planBatchLoudnessAlignment(groupMeasurements)",
  ]);
  assert.doesNotMatch(
    batchAlignmentBlock,
    /const loudness = await analyzeIntegratedLoudness\(activeFfmpeg, inputName\)[\s\S]{0,240}?values\.push\(loudness\.inputI\)/,
    "batch alignment planning must not be anchored to whole-file LUFS, which is pause/room-tone sensitive",
  );
  assertMarkersInOrder(batchAlignmentBlock, [
    "const requestedOffsetDb = plan.offsetDb",
    "resolveSafePositiveDeliveryGainDb({",
    "sourceSafetyEvidence:",
    "renderedSafetyEvidence:",
    "`volume=${authorizedOffsetDb.toFixed(2)}dB",
    "const alignedFinalPolishEvidence = await measureFinalPolishEvidenceFromVirtualWav(activeFfmpeg, outputName)",
    "const afterSpeechEnergyDb = alignedFinalPolishEvidence?.speechKWeightedEnergyDb",
    "const alignedLoudness = await analyzeIntegratedLoudness(activeFfmpeg, outputName)",
  ]);
  assert.match(
    batchAlignmentBlock,
    /omittedPositiveAlignmentCount[\s\S]*?requestedOffsetDb > 0 && authorizedOffsetDb <= 0[\s\S]*?omittedPositiveAlignmentCount \+= 1[\s\S]*?alignedCount === 0[\s\S]*?omittedPositiveAlignmentCount > 0/,
    "an omitted positive offset must not be reported as already aligned",
  );
});

test("speech-aware gain planner owns leveling without a post-planner dynaudnorm stage", () => {
  const mixFilterBlock = sourceBetween(
    "const buildMixFilter = (profile: AdaptiveProfile | null, options?: MixRenderOptions)",
    "const runMixReady = async",
  );
  const dynamicsStageBlock = textBetween(
    mixFilterBlock,
    "    if (dyn",
    "    const continuityBreathProtect =",
  );

  assert.match(
    dynamicsStageBlock,
    /if \(dyn && !gainPlannerActive\) \{/,
    "legacy dynaudnorm must be explicitly gated to renders the gain planner does not own",
  );
  assert.equal(
    dynamicsStageBlock.match(/filters\.push\(\s*`dynaudnorm=/g)?.length ?? 0,
    1,
    "buildMixFilter may retain one legacy/fallback dynaudnorm, but must not add a second planner-active stage",
  );
});

test("planner-active renders do not stack fast event tamers or a second compressor", () => {
  const mixFilterBlock = sourceBetween(
    "const buildMixFilter = (profile: AdaptiveProfile | null, options?: MixRenderOptions)",
    "const runMixReady = async",
  );

  for (const [name, declaration] of [
    ["click", "const useClickTamer ="],
    ["onset", "const useOnsetTamer ="],
    ["breath", "const useBreathSpikeTamer ="],
  ] as const) {
    const stageBlock = textBetween(
      mixFilterBlock,
      declaration,
      name === "click"
        ? "    const useOnsetTamer ="
        : name === "onset"
          ? "    const useBreathSpikeTamer ="
          : "    if (controls.eqCleanup)",
    );
    assert.match(
      stageBlock,
      /!gainPlannerActive/,
      `${name} tamer must yield fast-event authority when the planner already owns dynamics`,
    );
  }

  assert.doesNotMatch(
    mixFilterBlock,
    /else if \(gainPlannerActive && !disableSpikeTamers\)[\s\S]*?acompressor=/,
    "planner-active audio must not receive a second broadband compressor",
  );
  assert.match(
    mixFilterBlock,
    /const roomCleanupEnabled =[\s\S]*?!gainPlannerActive/,
    "planner-active audio must not enter a second gate or dereverb authority path",
  );
  assert.match(
    mixFilterBlock,
    /const adaptiveNoiseReductionFilter = gainPlannerActive[\s\S]*?\?\s*null\s*:\s*resolveAdaptiveNoiseReductionFilter/,
    "planner-active audio must not be spectrally erased by post-planner adaptive reduction",
  );
  assert.match(
    mixFilterBlock,
    /const breath =\s*gainPlannerActive \|\| sourceSafeMode[\s\S]*?\?\s*null/,
    "planner-active audio must not stack a broadband breath compander",
  );
  assert.match(
    mixFilterBlock,
    /const preferFloorGuard =\s*!gainPlannerActive/,
    "planner-active audio must not stack a floor compander",
  );
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

test("fricative onset evidence learns the recurring recording bed instead of digital silence", () => {
  const plannerAnalysisBlock = sourceBetween(
    "const planGainForInput = async",
    "const applyPlannerToFullInput = async",
  );

  assertMarkersInOrder(plannerAnalysisBlock, [
    "const fricativeFrameDb = computeFricativeFrameDb(",
    "const fricativeCalibration =",
    "resolvePlannerCalibration(fricativeFrameDb, null, null)",
    "const fricativeNoiseFloorDb = fricativeCalibration?.noiseFloorDb",
    "fricativeNoiseFloorDb,",
  ]);
  assert.doesNotMatch(
    plannerAnalysisBlock,
    /fricativeNoiseFloorDb\s*=\s*[\s\S]*?estimatePlannerEnvelopeNoiseFloorDb\(fricativeFrameDb\)/,
    "edited digital silence must not make ordinary high-frequency room tone look like consonant evidence",
  );
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

test("audibility recovery judges the final speech band against the raw source", () => {
  const decodeBlock = sourceBetween(
    "const renderAudibilityFrameDb = async",
    "const decodeWavToMono =",
  );
  const guardBlock = sourceBetween(
    "const assertRenderedAudibility = async",
    "// Candidate renders normally receive a file-level planner context",
  );
  const renderBlock = sourceBetween(
    "const renderMixReadyWithFallbacks = async",
    "const processFiles = async () =>",
  );

  assertMarkersInOrder(decodeBlock, [
    '"-af"',
    "AUDIBILITY_GUARD_SPEECH_BAND_FILTER",
    '"-ar"',
    "`${AUDIBILITY_GUARD_SAMPLE_RATE}`",
  ]);
  assert.match(
    voLevelerSource,
    /const AUDIBILITY_GUARD_SPEECH_BAND_FILTER = "highpass=f=120,lowpass=f=7500"/,
  );
  assertMarkersInOrder(guardBlock, [
    "if (!sourceAudibilityFrameDb)",
    "sourceAudibilityFrameDb = await renderAudibilityFrameDb(",
    "job.inputName",
    "`${job.base}_source`",
    "const renderedFrameDb = await renderAudibilityFrameDb(",
    "detectAlignedAudibilityDropouts({",
    "maxAlignmentMs: AUDIBILITY_GUARD_MAX_ALIGNMENT_MS",
    "const report = alignedResult.finalReport",
  ]);
  assert.match(voLevelerSource, /const AUDIBILITY_GUARD_MAX_ALIGNMENT_MS = 250/);
  assert.equal((renderBlock.match(/await assertRenderedAudibility\(/g) ?? []).length, 4);
  assert.doesNotMatch(guardBlock, /planner-leveled|referenceInputName/);
  assert.doesNotMatch(renderBlock, /assertRenderedAudibility\([^;]*leveled[^;]*\)/);
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

test("long-form parts use chunk-local planner leveling without the legacy auto-leveler", () => {
  const rangeMixBlock = sourceBetween(
    "const runMixReadyRange = async",
    "const runMixReadySegmented = async",
  );
  const rangePlannerBlock = sourceBetween(
    "const applyPlannerToInputRange = async",
    "const emptyEnvelopeMetrics =",
  );
  const longFormBlock = sourceBetween(
    "const renderLongFormSafeMode = async",
    "const safeDeleteFile = async",
  );

  assert.doesNotMatch(
    rangeMixBlock,
    /gainPlannerActive:\s*false/,
    "the long-form range renderer must not hard-enable the legacy dynaudnorm path",
  );
  assertMarkersInOrder(rangePlannerBlock, [
    "sourceStartSec + localStartSec",
    "planStartSec: localStartSec",
    "runCrossfadeConcat(",
  ]);
  assertMarkersInOrder(longFormBlock, [
    "const chunkPlan = await planGainForInput(",
    "startSec: chunk.startSec",
    "const leveledChunkName =",
    "await applyPlannerToInputRange(",
    "await runMixReadyRange(",
    "leveledChunkName",
  ]);
  assert.match(
    longFormBlock,
    /plannerOwnsDynamics:\s*true/,
    "a no-plan long-form part must fail open without silently restoring legacy broadband dynamics",
  );
  assert.doesNotMatch(
    longFormBlock,
    /measureFinalPolishEvidenceFromVirtualWav\(/,
    "memory-bounded long-form delivery must not add a fallible full-part evidence decode",
  );
  assert.match(
    longFormBlock,
    /runFinalAppPolishPass\(\s*ffmpeg,\s*mixChunkName,\s*null,\s*null,\s*null,/,
    "long-form parts must remain deliverable through limiter-only final polish when optional evidence is unavailable",
  );
});

test("stateful segmented renders warm every noninitial filter from real source history", () => {
  const fixedSegmentBlock = sourceBetween(
    "const runMixReadySegmented = async",
    "const buildSpeechAlignedRenderSegments =",
  );
  const speechAlignedSegmentBlock = sourceBetween(
    "const runMixReadySpeechAlignedSegmented = async",
    "const runBlendMixReady = async",
  );

  assert.match(
    voLevelerSource,
    /import\s*\{\s*resolveSegmentRenderWindow\s*\}\s*from\s*["']\.\.\/lib\/segmentRenderContinuity["']/,
  );
  for (const [label, block] of [
    ["fixed", fixedSegmentBlock],
    ["speech-aligned", speechAlignedSegmentBlock],
  ] as const) {
    assert.match(
      block,
      /resolveSegmentRenderWindow\(\{/,
      `${label} segmentation must derive one sample-exact history and trim window`,
    );
    assert.match(
      block,
      /stateHistorySec:\s*HEAD_PRIME_SECONDS/,
      `${label} segmentation must warm stateful filters with the same one-second context as the file head`,
    );
    assert.match(
      block,
      /"-ss",\s*renderWindow\.readStartSec\.toFixed\(6\)/,
      `${label} segmentation must read the real historical source span`,
    );
    assert.match(
      block,
      /atrim=start=\$\{renderWindow\.trimStartSec\.toFixed\(6\)\}:end=\$\{renderWindow\.trimEndSec\.toFixed\(6\)\}/,
      `${label} segmentation must remove filter history after processing`,
    );
  }
  assert.match(fixedSegmentBlock, /isInitialSegment:\s*index === 0/);
  assert.match(speechAlignedSegmentBlock, /isInitialSegment:\s*index === 0/);
  assertMarkersInOrder(fixedSegmentBlock, [
    "resolveSegmentRenderWindow({",
    "const runUnprimed = async",
    "renderWindow.readStartSec",
    "filterChainWithTrim",
    "runCrossfadeConcat(",
  ]);
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
    "ffmpeg = await refreshFfmpeg(`bounded candidate QC clean worker on ${sanitizeBase(inputName)}`)",
    "sliceMonoFloat32Wav(inputBytes",
    "await analyzeFileWindow(ffmpeg, windowName, 0",
    "aggregateWindowAnalyses(",
  ]);
  assert.doesNotMatch(
    boundedQcBlock,
    /restoreRecoveryInputs|ensureRecoveryInputBytes/,
    "a small-window retry must not rehydrate 100-200 MB source and render WAVs",
  );
  assert.doesNotMatch(
    boundedQcBlock,
    /writeJobInput/,
    "the clean QC worker must receive only bounded windows, never the full source file",
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
  assert.match(
    voLevelerSource,
    /const BOUNDED_CANDIDATE_QC_MIN_COMBINED_BYTES = 40 \* 1024 \* 1024/,
    "the measured 41 MiB fourth-file audition footprint must avoid whole-file WASM QC",
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

test("objective invalidity or the full quality trio schedules one limiter-on enhanced linear recovery", () => {
  const processFilesBlock = sourceBetween(
    "const processFiles = async () =>",
    "const downloadOutputsSequentially = async",
  );
  const renderFallbackBlock = sourceBetween(
    "const renderMixReadyWithFallbacks = async",
    "const processFiles = async",
  );

  assert.match(processFilesBlock, /shouldRunSourceSafeRecoveryForCandidate/);
  assert.match(processFilesBlock, /shouldRequestEnhancedLinearRecoveryForCandidate/);
  assert.match(processFilesBlock, /enhancedLinearRecoveryRequested = true/);
  assert.match(processFilesBlock, /sourcePassthroughChain: plannerContext\.sourcePreservingFallback \|\| enhancedLinearRecovery/);
  assert.match(processFilesBlock, /disableLimiter: plannerContext\.sourcePreservingFallback,/);
  assert.doesNotMatch(
    processFilesBlock,
    /disableLimiter: plannerContext\.sourcePreservingFallback \|\| enhancedLinearRecovery/,
    "neither objective nor advisory linear recovery may turn into raw passthrough",
  );
  assert.match(processFilesBlock, /disableGainPlanner: plannerContext\.sourcePreservingFallback \|\| enhancedLinearRecovery/);
  assert.match(
    processFilesBlock,
    /disableHeadPriming: plannerContext\.sourcePreservingFallback \|\| enhancedLinearRecovery/,
    "enhanced linear recovery must not receive a hidden pre-roll transform",
  );
  assert.match(processFilesBlock, /candidateVariants = \[\.\.\.candidateVariants, "source-safe"\]/);
  assert.match(processFilesBlock, /adaptive tail\/source quality evidence requested one enhanced linear recovery/);
  assert.match(processFilesBlock, /resolveRequestedEnhancedLinearRecoverySelection/);
  assert.match(processFilesBlock, /linearRecoverySelection\.select/);
  assert.match(
    processFilesBlock,
    /enhanced linear recovery after advisory tail\/source damage/,
  );
  assert.match(processFilesBlock, /"source-safe-recovery"/);
  assert.match(
    renderFallbackBlock,
    /label: options\.disableLimiter === true\s*\? "source-preserving passthrough"\s*:\s*ENHANCED_LINEAR_RECOVERY_STRATEGY_LABEL/,
    "the effective source-linear strategy must distinguish raw fallback from peak-safe recovery",
  );
  assert.match(
    renderFallbackBlock,
    /disableLimiter: options\.disableLimiter === true/,
    "the fallback strategy must preserve the caller's limiter policy instead of forcing raw passthrough",
  );
  assert.doesNotMatch(
    renderFallbackBlock,
    /sourcePassthroughChain: true,[\s\S]{0,120}?disableLimiter: true/,
    "the strategy merge must not overwrite objective recovery with limiter-off passthrough",
  );
  assert.match(
    renderFallbackBlock,
    /const effectiveOptions = \{ \.\.\.options, \.\.\.strategy\.options \}/,
    "the contract covers the exact strategy merge that determines the rendered filter",
  );
  assert.match(
    processFilesBlock,
    /if \(MAX_CORRECTIVE_PASSES > 0 && selectedVariant && selectedSourcePreservingFallback\)[\s\S]*?corrective processing skipped; requested enhanced linear recovery must remain untouched[\s\S]*?if \([\s\S]*?!selectedSourcePreservingFallback/,
    "a selected enhanced linear recovery must be excluded before the small-file corrective branch",
  );
});

test("technically valid corrective enhancement stays deliverable after advisory comparison", () => {
  const processFilesBlock = sourceBetween(
    "const processFiles = async () =>",
    "const downloadOutputsSequentially = async",
  );
  const correctiveSelectionBlock = textBetween(
    processFilesBlock,
    "const originalRank = selectedPostPolishArtifact.scoredScore.rankingScore",
    "} catch (error) {",
  );

  assert.match(correctiveSelectionBlock, /resolveEnhancedDeliveryDecision/);
  assert.match(correctiveSelectionBlock, /deliveryDecision\.deliverEnhanced/);
  assert.match(correctiveSelectionBlock, /qualityAdvisoryReasons/);
  assert.doesNotMatch(correctiveSelectionBlock, /correctiveRank <= originalRank - CORRECTIVE_WIN_MARGIN/);
  assert.doesNotMatch(correctiveSelectionBlock, /discarded corrective render/);
});

test("an accepted corrective protected recovery stays immutable through final delivery routing", () => {
  const processFilesBlock = sourceBetween(
    "const processFiles = async () =>",
    "const downloadOutputsSequentially = async",
  );
  const correctiveRenderBlock = textBetween(
    processFilesBlock,
    "const correctiveResult = await renderMixReadyWithFallbacks(",
    "const correctiveBytes = await readVirtualFileBytes(ffmpeg, correctiveName)",
  );
  const finalProtectedRoutingBlock = textBetween(
    processFilesBlock,
    "const finalSelectedSourceSafeRecovery =",
    'markQueueDone(job.base, "Outputs ready")',
  );
  const batchAlignmentBlock = sourceBetween(
    "const alignBatchMixReadyOutputs = async",
    "const applyFinalConsonantResidualToOutputs = async",
  );
  const finalResidualBlock = sourceBetween(
    "const applyFinalConsonantResidualToOutputs = async",
    "const buildFinalReviewBundles = async",
  );

  assertMarkersInOrder(correctiveRenderBlock, [
    "if (isAudibilityProtectedRender(correctiveResult.meta))",
    "skipped corrective final app polish",
    "} else {",
    "runFinalAppPolishPass(",
  ]);
  assertMarkersInOrder(processFilesBlock, [
    "selectedMeta = correctiveArtifact.meta",
    "const finalSelectedSourceSafeRecovery =",
    'selectedMeta?.degradeReasons.includes("source-safe-recovery") === true',
    "const finalSelectedAudibilityProtected = isAudibilityProtectedRender(selectedMeta)",
    "const finalSelectedSourcePreservingFallback =",
    "plannerContext.sourcePreservingFallback",
    "const finalSelectedProtectedRecovery =",
    "!finalSelectedSourcePreservingFallback &&",
    "!finalSelectedSourceSafeRecovery &&",
    "finalSelectedAudibilityProtected",
    "const finalSelectedDeliveryProtected =",
    "finalSelectedSourcePreservingFallback ||",
    "finalSelectedSourceSafeRecovery ||",
    "finalSelectedProtectedRecovery",
    "shouldEmitMixReadyOutput(loudnessConfig !== null) || finalSelectedDeliveryProtected",
    "sourcePreservingFallback: finalSelectedSourcePreservingFallback",
    "protectedRecovery: finalSelectedProtectedRecovery",
    "sceneBlend && !finalSelectedDeliveryProtected",
    "loudnessConfig && !finalSelectedDeliveryProtected",
  ]);
  assert.doesNotMatch(
    finalProtectedRoutingBlock,
    /shouldTryCorrective|runFinalAppPolishPass/,
    "once final protection is derived from the accepted artifact, no corrective recursion or final polish may follow",
  );
  assert.match(
    batchAlignmentBlock,
    /\.filter\(\(\{ entry \}\) => entry\.kind === "mixready" && !isProtectedOutputEntry\(entry\)\)/,
    "the final protection flag must exclude the accepted corrective from batch alignment",
  );
  assertMarkersInOrder(finalResidualBlock, [
    "if (isProtectedOutputEntry(entry))",
    "protected recovery/fallback; selected bytes kept",
    "continue",
  ]);
});

test("delivery metadata and UI distinguish raw fallback from protected recovery", () => {
  const manifestBlock = sourceBetween(
    "const buildDeliveryManifest = (",
    "const downloadOutputsSequentially = async",
  );
  const outputUiBlock = sourceBetween(
    "const outputHelpText = output.sourceSafeRecovery",
    "return (",
  );
  const outputBadgeBlock = sourceBetween(
    "{isProtectedOutputEntry(output) && (",
    "</span>",
  );

  assertMarkersInOrder(manifestBlock, [
    "sourcePreservingFallback: output.sourcePreservingFallback === true",
    "sourceSafeRecovery: output.sourceSafeRecovery === true",
    "protectedRecovery: output.protectedRecovery === true",
  ]);
  assertMarkersInOrder(outputUiBlock, [
    "output.sourceSafeRecovery",
    "Enhanced linear recovery:",
    "output.protectedRecovery",
    "Protected recovery:",
    "output.sourcePreservingFallback",
    "Source-preserving fallback:",
  ]);
  assertMarkersInOrder(outputBadgeBlock, [
    "output.sourceSafeRecovery",
    '"Enhanced linear recovery"',
    "output.protectedRecovery",
    '"Protected recovery"',
    '"Source preserved"',
  ]);
});

test("corrective ownership is one pass per file and cannot be exhausted by earlier batch entries", () => {
  const processFilesBlock = sourceBetween(
    "const processFiles = async () =>",
    "const downloadOutputsSequentially = async",
  );

  assert.match(voLevelerSource, /const MAX_CORRECTIVE_PASSES = 1/);
  assert.match(
    processFilesBlock,
    /let correctiveAttemptedFiles: ReadonlySet<string> = new Set\(\)/,
  );
  assertMarkersInOrder(processFilesBlock, [
    "let correctiveAttemptedFiles: ReadonlySet<string> = new Set()",
    "while (i < jobs.length)",
    "correctiveAttemptedFiles.has(job.base)",
    "const correctiveClaim = claimCorrectivePassForFile(correctiveAttemptedFiles, job.base)",
    "correctiveAttemptedFiles = correctiveClaim.attemptedFiles",
  ]);
  assert.match(processFilesBlock, /correctiveAttemptedFiles\.has\(job\.base\)/);
  assert.match(
    processFilesBlock,
    /const correctiveClaim = claimCorrectivePassForFile\(correctiveAttemptedFiles, job\.base\)[\s\S]*?correctiveAttemptedFiles = correctiveClaim\.attemptedFiles/,
  );
  assert.doesNotMatch(processFilesBlock, /correctiveRenderAttempts|correctiveRenderBudget/);
  assert.doesNotMatch(processFilesBlock, /batch render budget|40% cap/);
  assert.doesNotMatch(voLevelerSource, /resolveCorrectiveMaxFilesPerBatch/);
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
    "the bounded source-relative cap must be cumulative, not reset by stacked passes",
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
