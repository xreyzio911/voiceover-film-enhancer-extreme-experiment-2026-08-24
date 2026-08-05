/**
 * Read-only, sequential VO corpus measurement harness.
 *
 * The source/result WAVs are opened with read-only range handles. Only one
 * bounded PCM range is decoded at a time, and only compact frame envelopes
 * survive while the companion file is analyzed. The JSON ledger is advisory:
 * it has no delivery accept/reject/cancel semantics.
 *
 * Usage:
 *   npm run measure:vo-corpus -- --out tasks/render-evidence/current-goal/voice-stability-baseline.json
 *   npm run measure:vo-corpus -- --out tasks/render-evidence/current-goal/audition.json \
 *     --pair "clips/source.wav|clips/result.wav|audition-id"
 */
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { computeSpeechBodyFrameDb } from "../src/lib/gainPlanner.ts";
import {
  decodePcmWavMonoRange,
  parseWavHeader,
  type ParsedWavInfo,
} from "../src/lib/qcWavStreaming.ts";
import {
  compareVoiceStability,
  type VoiceEnvelopeEvidence,
  type VoiceStabilityReport,
} from "../src/lib/voiceStabilityMetrics.ts";

const CORPUS_ROOTS = [
  { id: "audio-testing", relativePath: "audio testing" },
  { id: "bug", relativePath: "bug" },
  { id: "another-testing", relativePath: "another testing" },
] as const;
const DEFAULT_FRAME_MS = 20;
const DEFAULT_CHUNK_SECONDS = 20;
const BODY_FILTER_WARMUP_MS = 200;
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_EXPLICIT_PAIRS = 64;
const OPTIONAL_HISTORICAL_RESULTS = [
  {
    corpus: "audio-testing",
    source: "audio testing/Arthur_Batch1-10.wav",
    result: "tasks/render-evidence/current-goal/browser/arthur-exact-24a2daa/Arthur_Batch1-10_patched-final-residual.wav",
  },
] as const;

export type CorpusFile = Readonly<{
  corpus: string;
  path: string;
  relativePath: string;
  normalizedKey: string;
  reason?: string;
}>;

export type CorpusPair = Readonly<{
  id: string;
  corpus: string;
  normalizedKey: string;
  source: CorpusFile;
  result: CorpusFile;
}>;

export type CorpusDiscovery = Readonly<{
  pairs: readonly CorpusPair[];
  unmatchedSources: readonly CorpusFile[];
  unmatchedResults: readonly CorpusFile[];
  missingRoots: readonly string[];
}>;

type RangeFile = Pick<Blob, "size" | "slice">;

export type ExtractedEvidence = Readonly<{
  evidence: VoiceEnvelopeEvidence;
  wav: ParsedWavInfo;
  analyzedFrames: number;
  ignoredTailSamples: number;
  nonFiniteSampleCount: number;
  maximumDecodedRangeBytes: number;
}>;

type PairLedgerEntry = Readonly<{
  id: string;
  corpus: string;
  source: string;
  result: string;
  sourceSha256?: string;
  resultSha256?: string;
  status: "measured" | "error";
  sourceWav?: ReturnType<typeof wavLedgerMetadata>;
  resultWav?: ReturnType<typeof wavLedgerMetadata>;
  durationDeltaMs?: number;
  metrics?: VoiceStabilityReport;
  error?: string;
}>;

const compareText = (left: string, right: string) =>
  left.localeCompare(right, "en", { sensitivity: "base", numeric: true });

const normalizeSlashes = (value: string) => value.replaceAll("\\", "/");

const normalizeCorpusKey = (fileName: string) =>
  path.basename(fileName, path.extname(fileName))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^(?:result|ori(?:ginal)?|source)[\s_-]+/, "")
    .replace(/[\s_-]+mixready(?:[\s_-].*)?$/, "")
    .replace(/[^a-z0-9]+/g, "");

const walkWavs = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkWavs(absolutePath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".wav")) {
      files.push(absolutePath);
    }
  }
  return files;
};

const isResultPath = (relativeWithinCorpus: string) => {
  const segments = normalizeSlashes(relativeWithinCorpus).split("/");
  const directorySegments = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  const baseName = path.basename(relativeWithinCorpus);
  return (
    directorySegments.includes("result") ||
    directorySegments.includes("the result") ||
    /^result[\s_-]+/i.test(baseName)
  );
};

const appendByKey = (map: Map<string, CorpusFile[]>, file: CorpusFile) => {
  const existing = map.get(file.normalizedKey) ?? [];
  map.set(file.normalizedKey, [...existing, file]);
};

const pathExists = async (filePath: string) => {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/** Discover exact 1:1 source/result pairs without dropping ambiguous files. */
export const discoverCorpusPairs = async (repoRoot: string): Promise<CorpusDiscovery> => {
  const pairs: CorpusPair[] = [];
  const unmatchedSources: CorpusFile[] = [];
  const unmatchedResults: CorpusFile[] = [];
  const missingRoots: string[] = [];

  for (const corpusRoot of CORPUS_ROOTS) {
    const absoluteRoot = path.join(repoRoot, corpusRoot.relativePath);
    let paths: string[];
    try {
      paths = await walkWavs(absoluteRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missingRoots.push(corpusRoot.relativePath);
        continue;
      }
      throw error;
    }

    const sources = new Map<string, CorpusFile[]>();
    const results = new Map<string, CorpusFile[]>();
    for (const absolutePath of paths) {
      const relativeWithinCorpus = path.relative(absoluteRoot, absolutePath);
      const file: CorpusFile = {
        corpus: corpusRoot.id,
        path: absolutePath,
        relativePath: normalizeSlashes(path.relative(repoRoot, absolutePath)),
        normalizedKey: normalizeCorpusKey(path.basename(absolutePath)),
      };
      appendByKey(isResultPath(relativeWithinCorpus) ? results : sources, file);
    }

    const keys = [...new Set([...sources.keys(), ...results.keys()])].sort(compareText);
    for (const key of keys) {
      const keyedSources = sources.get(key) ?? [];
      const keyedResults = results.get(key) ?? [];
      if (key && keyedSources.length === 1 && keyedResults.length === 1) {
        pairs.push({
          id: `${corpusRoot.id}:${key}`,
          corpus: corpusRoot.id,
          normalizedKey: key,
          source: keyedSources[0],
          result: keyedResults[0],
        });
        continue;
      }
      const sourceReason =
        keyedResults.length === 0
          ? "no-result-with-normalized-key"
          : "ambiguous-normalized-key";
      const resultReason =
        keyedSources.length === 0
          ? "no-source-with-normalized-key"
          : "ambiguous-normalized-key";
      unmatchedSources.push(...keyedSources.map((file) => ({ ...file, reason: sourceReason })));
      unmatchedResults.push(...keyedResults.map((file) => ({ ...file, reason: resultReason })));
    }
  }

  // Arthur's exact delivered browser render predates this ledger and lives in
  // the ignored evidence tree. Treat it as a narrow optional fallback only:
  // a normal in-corpus 1:1 result always wins, and absence leaves the source
  // explicitly unmatched.
  for (const mapping of OPTIONAL_HISTORICAL_RESULTS) {
    const normalizedKey = normalizeCorpusKey(mapping.source);
    if (pairs.some((pair) => pair.corpus === mapping.corpus && pair.normalizedKey === normalizedKey)) {
      continue;
    }
    const sourcePath = path.resolve(repoRoot, mapping.source);
    const resultPath = path.resolve(repoRoot, mapping.result);
    if (!await pathExists(sourcePath) || !await pathExists(resultPath)) continue;
    const unmatchedIndex = unmatchedSources.findIndex(
      (file) => file.corpus === mapping.corpus && file.normalizedKey === normalizedKey,
    );
    if (unmatchedIndex < 0) continue;
    unmatchedSources.splice(unmatchedIndex, 1);
    const source: CorpusFile = {
      corpus: mapping.corpus,
      path: sourcePath,
      relativePath: normalizeSlashes(mapping.source),
      normalizedKey,
    };
    const result: CorpusFile = {
      corpus: mapping.corpus,
      path: resultPath,
      relativePath: normalizeSlashes(mapping.result),
      normalizedKey,
    };
    pairs.push({
      id: `${mapping.corpus}:${normalizedKey}`,
      corpus: mapping.corpus,
      normalizedKey,
      source,
      result,
    });
  }

  return {
    pairs: pairs.sort((left, right) => compareText(left.id, right.id)),
    unmatchedSources: unmatchedSources.sort((left, right) => compareText(left.relativePath, right.relativePath)),
    unmatchedResults: unmatchedResults.sort((left, right) => compareText(left.relativePath, right.relativePath)),
    missingRoots: missingRoots.sort(compareText),
  };
};

/** Restrict the one writable artifact to the repo's already-ignored evidence tree. */
export const resolveLedgerOutputPath = (repoRoot: string, requestedPath: string) => {
  if (!requestedPath.trim()) throw new Error("--out requires a JSON path.");
  const outputPath = path.resolve(repoRoot, requestedPath);
  const evidenceRoot = path.resolve(repoRoot, "tasks", "render-evidence");
  const relativeToEvidence = path.relative(evidenceRoot, outputPath);
  if (
    relativeToEvidence === "" ||
    relativeToEvidence.startsWith(`..${path.sep}`) ||
    relativeToEvidence === ".." ||
    path.isAbsolute(relativeToEvidence)
  ) {
    throw new Error("--out must stay under tasks/render-evidence/.");
  }
  if (path.extname(outputPath).toLowerCase() !== ".json") {
    throw new Error("--out must end in .json.");
  }
  return outputPath;
};

const isPathInside = (basePath: string, targetPath: string) => {
  const relative = path.relative(basePath, targetPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

const parseExplicitPairSpec = (spec: string) => {
  if (spec.length > 4_096) throw new Error("--pair is too long.");
  const fields = spec.split("|").map((field) => field.trim());
  if (fields.length !== 3 || fields.some((field) => field.length === 0)) {
    throw new Error("--pair requires source|result|id with three non-empty fields.");
  }
  const [sourcePath, resultPath, id] = fields;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new Error("--pair id must use 1-128 letters, numbers, dots, underscores, colons, or hyphens.");
  }
  return { sourcePath, resultPath, id };
};

const resolveExplicitWav = async (
  repoRoot: string,
  realRepoRoot: string,
  requestedPath: string,
  role: "source" | "result",
) => {
  if (path.extname(requestedPath).toLowerCase() !== ".wav") {
    throw new Error(`Explicit ${role} path must end in .wav.`);
  }
  const absolutePath = path.resolve(repoRoot, requestedPath);
  if (!isPathInside(repoRoot, absolutePath)) {
    throw new Error(`Explicit ${role} path must stay inside the repository.`);
  }
  let info;
  try {
    info = await stat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Explicit ${role} WAV does not exist: ${requestedPath}`);
    }
    throw error;
  }
  if (!info.isFile()) throw new Error(`Explicit ${role} WAV is not a file: ${requestedPath}`);
  const realFilePath = await realpath(absolutePath);
  if (!isPathInside(realRepoRoot, realFilePath)) {
    throw new Error(`Explicit ${role} path must resolve inside the repository.`);
  }
  return {
    absolutePath,
    relativePath: normalizeSlashes(path.relative(repoRoot, absolutePath)),
  };
};

/** Resolve a small caller-selected audition set without changing default discovery. */
export const resolveExplicitCorpusPairs = async (
  repoRoot: string,
  pairSpecs: readonly string[],
): Promise<readonly CorpusPair[]> => {
  if (pairSpecs.length > MAX_EXPLICIT_PAIRS) {
    throw new Error(`At most ${MAX_EXPLICIT_PAIRS} explicit pairs may be measured at once.`);
  }
  const realRepoRoot = await realpath(repoRoot);
  const seenIds = new Set<string>();
  const pairs: CorpusPair[] = [];
  for (const pairSpec of pairSpecs) {
    const parsed = parseExplicitPairSpec(pairSpec);
    if (seenIds.has(parsed.id)) throw new Error(`Duplicate explicit pair id: ${parsed.id}`);
    seenIds.add(parsed.id);
    const source = await resolveExplicitWav(repoRoot, realRepoRoot, parsed.sourcePath, "source");
    const result = await resolveExplicitWav(repoRoot, realRepoRoot, parsed.resultPath, "result");
    pairs.push({
      id: parsed.id,
      corpus: "explicit",
      normalizedKey: parsed.id.toLowerCase(),
      source: {
        corpus: "explicit",
        path: source.absolutePath,
        relativePath: source.relativePath,
        normalizedKey: parsed.id.toLowerCase(),
      },
      result: {
        corpus: "explicit",
        path: result.absolutePath,
        relativePath: result.relativePath,
        normalizedKey: parsed.id.toLowerCase(),
      },
    });
  }
  return pairs;
};

const ensureDirectoryChainHasNoRedirect = async (
  repoRoot: string,
  outputParent: string,
) => {
  const relativeParent = path.relative(repoRoot, outputParent);
  let current = repoRoot;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      info = await lstat(current);
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Ledger output parent contains a junction or symbolic link: ${current}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`Ledger output parent component is not a directory: ${current}`);
    }
  }
};

/** Create and real-path-verify the one allowed writable output directory. */
export const prepareLedgerOutputPath = async (
  repoRoot: string,
  requestedPath: string,
) => {
  const outputPath = resolveLedgerOutputPath(repoRoot, requestedPath);
  const evidenceRoot = path.resolve(repoRoot, "tasks", "render-evidence");
  const outputParent = path.dirname(outputPath);
  await ensureDirectoryChainHasNoRedirect(path.resolve(repoRoot), outputParent);
  const realEvidenceRoot = await realpath(evidenceRoot);
  const realOutputParent = await realpath(outputParent);
  if (!isPathInside(realEvidenceRoot, realOutputParent)) {
    throw new Error("Ledger output parent real path escapes tasks/render-evidence/.");
  }
  return outputPath;
};

const normalizeSliceBoundary = (value: number | undefined, size: number, fallback: number) => {
  if (value === undefined) return fallback;
  const integer = Math.trunc(value);
  return integer < 0 ? Math.max(0, size + integer) : Math.min(size, integer);
};

const readExactRange = async (handle: FileHandle, start: number, length: number) => {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(bytes, offset, length - offset, start + offset);
    if (bytesRead <= 0) throw new Error(`Short file read at byte ${start + offset}.`);
    offset += bytesRead;
  }
  return bytes.buffer;
};

const makeRangeFile = (handle: FileHandle, size: number): RangeFile => ({
  size,
  slice(start?: number, end?: number) {
    const normalizedStart = normalizeSliceBoundary(start, size, 0);
    const normalizedEnd = Math.max(normalizedStart, normalizeSliceBoundary(end, size, size));
    const length = normalizedEnd - normalizedStart;
    return {
      size: length,
      arrayBuffer: () => readExactRange(handle, normalizedStart, length),
    } as Blob;
  },
});

const toDb = (amplitude: number) =>
  amplitude > 0 && Number.isFinite(amplitude)
    ? 20 * Math.log10(amplitude)
    : -120;

const analyzeBroadbandFrames = (
  samples: Float32Array,
  samplesPerFrame: number,
  discardFrames: number,
) => {
  const frameCount = Math.floor(samples.length / samplesPerFrame);
  const frameDb: number[] = [];
  const framePeakDb: number[] = [];
  for (let frame = discardFrames; frame < frameCount; frame += 1) {
    const start = frame * samplesPerFrame;
    const end = start + samplesPerFrame;
    let sumSquares = 0;
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      const sample = samples[index];
      sumSquares += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    frameDb.push(toDb(Math.sqrt(sumSquares / samplesPerFrame) + 1e-12));
    framePeakDb.push(toDb(peak + 1e-12));
  }
  return { frameDb, framePeakDb };
};

export const extractEnvelopeEvidence = async (
  filePath: string,
  frameMs: number,
  chunkSeconds: number,
): Promise<ExtractedEvidence> => {
  const handle = await open(filePath, "r");
  try {
    const fileStat = await handle.stat();
    const file = makeRangeFile(handle, fileStat.size);
    const wav = await parseWavHeader(file);
    const samplesPerFrame = Math.max(1, Math.round((wav.sampleRate * frameMs) / 1_000));
    const totalAnalysisFrames = Math.floor(wav.totalFrames / samplesPerFrame);
    const chunkFrameCount = Math.max(1, Math.floor((chunkSeconds * wav.sampleRate) / samplesPerFrame));
    const warmupFrames = Math.max(0, Math.round(BODY_FILTER_WARMUP_MS / frameMs));
    const frameDb: number[] = [];
    const framePeakDb: number[] = [];
    const speechBodyDb: number[] = [];
    let nonFiniteSampleCount = 0;
    let maximumDecodedRangeBytes = 0;

    for (let frameCursor = 0; frameCursor < totalAnalysisFrames; frameCursor += chunkFrameCount) {
      const outputEndFrame = Math.min(totalAnalysisFrames, frameCursor + chunkFrameCount);
      const readStartFrame = Math.max(0, frameCursor - warmupFrames);
      const startSample = readStartFrame * samplesPerFrame;
      const endSample = outputEndFrame * samplesPerFrame;
      const decoded = await decodePcmWavMonoRange(file, wav, startSample, endSample);
      maximumDecodedRangeBytes = Math.max(maximumDecodedRangeBytes, decoded.byteLength);
      let safeSamples = decoded;
      let chunkNonFiniteSampleCount = 0;
      for (const sample of decoded) {
        if (!Number.isFinite(sample)) chunkNonFiniteSampleCount += 1;
      }
      nonFiniteSampleCount += chunkNonFiniteSampleCount;
      if (chunkNonFiniteSampleCount > 0) {
        safeSamples = Float32Array.from(decoded, (sample) => Number.isFinite(sample) ? sample : 0);
      }
      const discardFrames = frameCursor - readStartFrame;
      const broadband = analyzeBroadbandFrames(safeSamples, samplesPerFrame, discardFrames);
      const bodyFrames = computeSpeechBodyFrameDb(safeSamples, wav.sampleRate, frameMs)
        .slice(discardFrames);
      frameDb.push(...broadband.frameDb);
      framePeakDb.push(...broadband.framePeakDb);
      speechBodyDb.push(...bodyFrames);
    }

    const analyzedFrames = Math.min(frameDb.length, framePeakDb.length, speechBodyDb.length);
    return {
      evidence: {
        frameMs,
        frameDb: frameDb.slice(0, analyzedFrames),
        framePeakDb: framePeakDb.slice(0, analyzedFrames),
        speechBodyDb: speechBodyDb.slice(0, analyzedFrames),
      },
      wav,
      analyzedFrames,
      ignoredTailSamples: wav.totalFrames - analyzedFrames * samplesPerFrame,
      nonFiniteSampleCount,
      maximumDecodedRangeBytes,
    };
  } finally {
    await handle.close();
  }
};

const wavLedgerMetadata = (extracted: ExtractedEvidence) => ({
  channels: extracted.wav.channels,
  sampleRateHz: extracted.wav.sampleRate,
  bitsPerSample: extracted.wav.bitsPerSample,
  audioFormat: extracted.wav.audioFormat,
  durationSec: extracted.wav.durationSec,
  analyzedFrames: extracted.analyzedFrames,
  ignoredTailSamples: extracted.ignoredTailSamples,
  nonFiniteSampleCount: extracted.nonFiniteSampleCount,
  maximumDecodedRangeBytes: extracted.maximumDecodedRangeBytes,
});

const safeErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const hashFileSha256 = async (filePath: string) => {
  const handle = await open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = new Uint8Array(HASH_CHUNK_BYTES);
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
};

const measurePair = async (
  pair: CorpusPair,
  frameMs: number,
  chunkSeconds: number,
): Promise<PairLedgerEntry> => {
  try {
    const sourceSha256 = await hashFileSha256(pair.source.path);
    const source = await extractEnvelopeEvidence(pair.source.path, frameMs, chunkSeconds);
    const resultSha256 = await hashFileSha256(pair.result.path);
    const result = await extractEnvelopeEvidence(pair.result.path, frameMs, chunkSeconds);
    return {
      id: pair.id,
      corpus: pair.corpus,
      source: pair.source.relativePath,
      result: pair.result.relativePath,
      sourceSha256,
      resultSha256,
      status: "measured",
      sourceWav: wavLedgerMetadata(source),
      resultWav: wavLedgerMetadata(result),
      durationDeltaMs: (result.wav.durationSec - source.wav.durationSec) * 1_000,
      metrics: compareVoiceStability(source.evidence, result.evidence),
    };
  } catch (error) {
    return {
      id: pair.id,
      corpus: pair.corpus,
      source: pair.source.relativePath,
      result: pair.result.relativePath,
      status: "error",
      error: safeErrorMessage(error),
    };
  }
};

const median = (values: readonly number[]) => {
  const finiteValues = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finiteValues.length === 0) return null;
  const middle = Math.floor(finiteValues.length / 2);
  return finiteValues.length % 2 === 0
    ? (finiteValues[middle - 1] + finiteValues[middle]) / 2
    : finiteValues[middle];
};

const summarize = (
  discovery: CorpusDiscovery,
  entries: readonly PairLedgerEntry[],
) => {
  const measured = entries.filter((entry) => entry.status === "measured" && entry.metrics);
  const values = (selector: (metrics: VoiceStabilityReport) => number | null) =>
    measured.flatMap((entry) => {
      const value = selector(entry.metrics!);
      return value === null ? [] : [value];
    });
  return {
    discoveredPairCount: discovery.pairs.length,
    measuredPairCount: measured.length,
    errorPairCount: entries.length - measured.length,
    unmatchedSourceCount: discovery.unmatchedSources.length,
    unmatchedResultCount: discovery.unmatchedResults.length,
    missingRootCount: discovery.missingRoots.length,
    corpusMedian: {
      sourceSignedDriftDbPerMinute: median(
        values((metrics) => metrics.drift.sourceSignedSlopeDbPerMinute),
      ),
      candidateSignedDriftDbPerMinute: median(
        values((metrics) => metrics.drift.candidateSignedSlopeDbPerMinute),
      ),
      signedDriftDbPerMinute: median(values((metrics) => metrics.drift.signedSlopeDbPerMinute)),
      upwardAddedSpikeP95Db: median(values((metrics) => metrics.spikes.up.p95AddedContrastDb)),
      downwardAddedSpikeP95Db: median(values((metrics) => metrics.spikes.down.p95AddedContrastDb)),
      bodyUpwardAddedSpikeP95Db: median(
        values((metrics) => metrics.bodySpikes.up.p95AddedContrastDb),
      ),
      bodyDownwardAddedSpikeP95Db: median(
        values((metrics) => metrics.bodySpikes.down.p95AddedContrastDb),
      ),
      bodyFloorFillDeltaDb: median(values((metrics) => metrics.body.floorFillDeltaDb)),
      bodySpreadDeltaDb: median(values((metrics) => metrics.body.spreadDeltaDb)),
      intraRunBodySpreadDeltaMedianDb: median(
        values((metrics) => metrics.intraRunBody.spreadDeltaMedianDb),
      ),
      intraRunBodySpreadDeltaP90Db: median(
        values((metrics) => metrics.intraRunBody.spreadDeltaP90Db),
      ),
      intraRunArcSpreadDeltaMedianDb: median(
        values((metrics) => metrics.intraRunArc.spreadDeltaMedianDb),
      ),
      intraRunArcSpreadDeltaP90Db: median(
        values((metrics) => metrics.intraRunArc.spreadDeltaP90Db),
      ),
      intraRunArcRiseDeltaMedianDb: median(
        values((metrics) => metrics.intraRunArc.riseDeltaMedianDb),
      ),
      intraRunArcFallDeltaMedianDb: median(
        values((metrics) => metrics.intraRunArc.fallDeltaMedianDb),
      ),
      expressiveContrastRetentionP10Ratio: median(
        values((metrics) => metrics.expressiveRetention.contrastRetentionP10Ratio),
      ),
    },
  };
};

export const parseMeasureVoCorpusArguments = (argumentsList: readonly string[]) => {
  let output: string | null = null;
  const pairSpecs: string[] = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--out") {
      if (output !== null) throw new Error("--out may only be supplied once.");
      output = argumentsList[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argument === "--pair") {
      const pairSpec = argumentsList[index + 1];
      if (pairSpec === undefined) throw new Error("--pair requires source|result|id.");
      pairSpecs.push(pairSpec);
      if (pairSpecs.length > MAX_EXPLICIT_PAIRS) {
        throw new Error(`At most ${MAX_EXPLICIT_PAIRS} explicit pairs may be measured at once.`);
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (output === null || output.trim() === "") {
    throw new Error("Usage requires --out <tasks/render-evidence/...json>.");
  }
  return { output, pairSpecs: [...pairSpecs] };
};

const toLedgerCorpusFile = (file: CorpusFile) => ({
  corpus: file.corpus,
  relativePath: file.relativePath,
  normalizedKey: file.normalizedKey,
  reason: file.reason,
});

const main = async () => {
  const repoRoot = process.cwd();
  const { output, pairSpecs } = parseMeasureVoCorpusArguments(process.argv.slice(2));
  const outputPath = await prepareLedgerOutputPath(repoRoot, output);
  const discovery: CorpusDiscovery = pairSpecs.length === 0
    ? await discoverCorpusPairs(repoRoot)
    : {
        pairs: await resolveExplicitCorpusPairs(repoRoot, pairSpecs),
        unmatchedSources: [],
        unmatchedResults: [],
        missingRoots: [],
      };
  const entries: PairLedgerEntry[] = [];

  for (let index = 0; index < discovery.pairs.length; index += 1) {
    const pair = discovery.pairs[index];
    process.stderr.write(`[${index + 1}/${discovery.pairs.length}] ${pair.id}\n`);
    entries.push(await measurePair(pair, DEFAULT_FRAME_MS, DEFAULT_CHUNK_SECONDS));
  }

  const ledger = {
    schemaVersion: 3,
    advisoryOnly: true,
    generatedAt: new Date().toISOString(),
    definitions: {
      frameMs: DEFAULT_FRAME_MS,
      decodedChunkSeconds: DEFAULT_CHUNK_SECONDS,
      processingModel: "one pair at a time; source and result read sequentially in bounded ranges",
      fileIdentity: "full-file SHA-256 for both source and result; paths alone are not treated as delivered-byte identity",
      drift: "median source, candidate, and candidate-minus-source dB by 10 s source-speech section; bounded-lag robust absolute and processing-delta slopes in dB/min",
      alignment: "gain-centered global envelope lag searched within +/-250 ms before comparison",
      spikes: "broadband candidate local up/down contrast beyond the source +/-20 ms neighborhood; retains cleanup-artifact visibility separately from voice-body stability",
      bodySpikes: "180-3000 Hz candidate local up/down contrast beyond the source +/-20 ms neighborhood; event-peak P95, advisory 1.5 dB event count, and strongest five source-timeline event windows",
      body: "source-body-supported non-expressive speech, using 180-3000 Hz P10 floor/fill and P90-P10 spread after per-file static-gain centering",
      intraRunBody: "source-run 300 ms medians at 100 ms hops with >=80% body support, source body >= file median-18 dB, expressive windows excluded, and >=5 windows per eligible run; reports candidate-minus-source run-spread median and P90",
      intraRunArc: "source-run 300 ms medians at 100 ms hops with >=80% body support and >=5 windows per eligible run; keeps expressive body-supported windows, uses only the existing median-24 dB body-support boundary, and reports ungated spread plus signed head/mid/tail rise and fall",
      expressiveRetention: "source-only local emphasis/crest events; best candidate support within +/-20 ms reported separately",
      adjudication: "advisory comparative evidence only; no accept, reject, cancellation, or delivery gate",
    },
    summary: summarize(discovery, entries),
    discovery: {
      missingRoots: discovery.missingRoots,
      unmatchedSources: discovery.unmatchedSources.map(toLedgerCorpusFile),
      unmatchedResults: discovery.unmatchedResults.map(toLedgerCorpusFile),
    },
    pairs: entries,
  };

  await prepareLedgerOutputPath(repoRoot, outputPath);
  await writeFile(outputPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(ledger.summary)}\n${outputPath}\n`);
};

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
