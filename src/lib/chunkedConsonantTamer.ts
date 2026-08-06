import {
  tameRenderedConsonantPeaks,
  type RenderedConsonantReference,
} from "./gainPlanner.ts";

const DEFAULT_CORE_CHUNK_DURATION_SEC = 60;
const MIN_CONTEXT_DURATION_MS = 500;
const CHUNK_BOUNDARY_RECONCILIATION_DURATION_MS = 2;
const DEFAULT_MAX_HEADER_BYTES = 64 * 1024;
const FLOAT32_BYTES = 4;
const MIN_WAV_HEADER_BYTES = 44;
const MAX_RIFF_BLOB_BYTES = 0xffff_ffff + 8;
const MAX_SUFFIX_CHUNK_COUNT = 4096;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const IEEE_FLOAT_SUBFORMAT_GUID = new Uint8Array([
  0x03, 0x00, 0x00, 0x00,
  0x00, 0x00,
  0x10, 0x00,
  0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
]);

export type ChunkedConsonantTamerOptions = Readonly<{
  /** Duration processed at a time, excluding context on either side. */
  coreChunkDurationSec?: number;
  /** Context retained on either side of each core. Values below 500 ms are raised to 500 ms. */
  contextDurationMs?: number;
  /** Passed through to the existing source-relative tamer. */
  referenceMatchWindowMs?: number;
  /** Passed through to the existing tamer, which retains its own upper bound. */
  maxReductionDb?: number;
  /** Maximum prefix read while locating the fmt and data chunks. */
  maxHeaderBytes?: number;
}>;

export type ChunkedConsonantTamerStats = Readonly<{
  /** Unique final-output analysis frames that contain attenuation. */
  tamedFrameCount: number;
  /** Maximum attenuation actually written to a core sample. */
  maxReductionDb: number;
  /** Median reference lag reported by the independently padded chunks. */
  referenceLagMs: number;
  /** Median 0..1 alignment confidence across all independently padded chunks. */
  referenceConfidence: number;
  /** Lowest reported confidence, exposing sparse/ambiguous portions of the file. */
  minimumReferenceConfidence: number;
  /** Chunks whose source comparison was explicitly authorized by the core tamer. */
  referenceUsedChunkCount: number;
  /** Chunks that failed open because their local reference evidence was insufficient. */
  referenceRejectedChunkCount: number;
  processedChunkCount: number;
  changedSampleCount: number;
  changedSpanCount: number;
  maxReadBytes: number;
}>;

export type ChunkedConsonantTamerResult = Readonly<{
  /** The original Blob by identity when no sample changed. */
  blob: Blob;
  stats: ChunkedConsonantTamerStats;
}>;

type ParsedMonoFloat32Wav = Readonly<{
  sampleRate: number;
  dataOffset: number;
  dataLength: number;
  sampleCount: number;
}>;

type ReplacementSpan = Readonly<{
  startSample: number;
  endSample: number;
  bytes: Uint8Array;
}>;

type PendingAcceptedBoundary = Readonly<{
  originalSamples: Float32Array;
  tamedSamples: Float32Array;
  startSample: number;
}>;

const bytesAsBlobPart = (bytes: Uint8Array): ArrayBuffer => {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
};

const readOwnedBlobPart = async (blob: Blob, start: number, end: number): Promise<ArrayBuffer> => {
  const slice = blob.slice(start, end);
  const buffer = await slice.arrayBuffer();
  if (buffer.byteLength !== Math.max(0, end - start)) {
    throw new Error("Corrupt WAV: output assembly read returned an unexpected byte length.");
  }
  return buffer;
};

const readAscii = (view: DataView, offset: number, length: number) => {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
};

const hasIeeeFloatSubformatGuid = (view: DataView, offset: number) => {
  for (let index = 0; index < IEEE_FLOAT_SUBFORMAT_GUID.length; index += 1) {
    if (view.getUint8(offset + index) !== IEEE_FLOAT_SUBFORMAT_GUID[index]) return false;
  }
  return true;
};

const hasAtMostOneChannelMaskBit = (channelMask: number) => {
  if (channelMask === 0) return true;
  return ((channelMask & (channelMask - 1)) >>> 0) === 0;
};

const validateSuffixChunks = async (blob: Blob, suffixOffset: number) => {
  let offset = suffixOffset;
  let chunkCount = 0;
  while (offset < blob.size) {
    if (offset + 8 > blob.size) {
      throw new Error("Corrupt WAV: incomplete suffix chunk header.");
    }
    if (chunkCount >= MAX_SUFFIX_CHUNK_COUNT) {
      throw new Error("Unsupported WAV: too many suffix chunks.");
    }
    const headerBuffer = await blob.slice(offset, offset + 8).arrayBuffer();
    if (headerBuffer.byteLength !== 8) {
      throw new Error("Corrupt WAV: bounded suffix read returned an unexpected byte length.");
    }
    const header = new DataView(headerBuffer);
    const chunkId = readAscii(header, 0, 4);
    const chunkSize = header.getUint32(4, true);
    const chunkEnd = offset + 8 + chunkSize;
    const paddedChunkEnd = chunkEnd + (chunkSize % 2);
    if (chunkEnd > blob.size || paddedChunkEnd > blob.size) {
      throw new Error(`Corrupt WAV: ${chunkId} suffix chunk exceeds the Blob size.`);
    }
    offset = paddedChunkEnd;
    chunkCount += 1;
  }
};

const parseMonoFloat32Wav = async (
  blob: Blob,
  maxHeaderBytes: number,
): Promise<ParsedMonoFloat32Wav> => {
  if (blob.size < MIN_WAV_HEADER_BYTES) {
    throw new Error("Corrupt WAV: file is smaller than a valid float WAV header.");
  }
  if (blob.size > MAX_RIFF_BLOB_BYTES) {
    throw new Error("Unsupported WAV: RIFF size exceeds the 32-bit container limit.");
  }

  const prefixLength = Math.min(blob.size, maxHeaderBytes);
  const prefix = await blob.slice(0, prefixLength).arrayBuffer();
  const view = new DataView(prefix);
  if (view.byteLength < 12 || readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
    throw new Error("Unsupported WAV: expected a RIFF/WAVE container.");
  }
  if (view.getUint32(4, true) + 8 !== blob.size) {
    throw new Error("Corrupt WAV: RIFF size does not match the Blob size.");
  }

  let offset = 12;
  let fmt:
    | Readonly<{
        headerOffset: number;
        size: number;
        audioFormat: number;
        channels: number;
        sampleRate: number;
        byteRate: number;
        blockAlign: number;
        bitsPerSample: number;
        extensionSize: number;
        validBitsPerSample: number;
        channelMask: number;
        ieeeFloatSubformat: boolean;
      }>
    | null = null;
  let dataHeaderOffset = -1;
  let dataOffset = -1;
  let dataLength = -1;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > blob.size) {
      throw new Error(`Corrupt WAV: ${chunkId} chunk exceeds the Blob size.`);
    }
    if (chunkId === "fmt ") {
      if (fmt) throw new Error("Corrupt WAV: duplicate fmt chunks are not supported.");
      if (chunkSize < 16 || chunkStart + 16 > view.byteLength) {
        throw new Error("Corrupt WAV: incomplete fmt chunk in bounded header.");
      }
      const audioFormat = view.getUint16(chunkStart, true);
      const isExtensible = audioFormat === WAVE_FORMAT_EXTENSIBLE;
      if (isExtensible && (chunkSize < 40 || chunkStart + 40 > view.byteLength)) {
        throw new Error("Corrupt WAV: incomplete WAVE_FORMAT_EXTENSIBLE fmt chunk.");
      }
      if (!isExtensible && chunkSize > 16 && (chunkSize < 18 || chunkStart + 18 > view.byteLength)) {
        throw new Error("Corrupt WAV: incomplete extended IEEE-float fmt chunk.");
      }
      fmt = {
        headerOffset: offset,
        size: chunkSize,
        audioFormat,
        channels: view.getUint16(chunkStart + 2, true),
        sampleRate: view.getUint32(chunkStart + 4, true),
        byteRate: view.getUint32(chunkStart + 8, true),
        blockAlign: view.getUint16(chunkStart + 12, true),
        bitsPerSample: view.getUint16(chunkStart + 14, true),
        extensionSize: chunkSize >= 18 ? view.getUint16(chunkStart + 16, true) : 0,
        validBitsPerSample: isExtensible ? view.getUint16(chunkStart + 18, true) : 0,
        channelMask: isExtensible ? view.getUint32(chunkStart + 20, true) : 0,
        ieeeFloatSubformat: isExtensible
          ? hasIeeeFloatSubformatGuid(view, chunkStart + 24)
          : audioFormat === WAVE_FORMAT_IEEE_FLOAT,
      };
    } else if (chunkId === "fact" && chunkSize < 4) {
      throw new Error("Corrupt WAV: fact chunk is too small.");
    } else if (chunkId === "LIST" && chunkSize < 4) {
      throw new Error("Corrupt WAV: LIST chunk is too small.");
    } else if (chunkId === "data") {
      dataHeaderOffset = offset;
      dataOffset = chunkStart;
      dataLength = chunkSize;
      break;
    }
    const paddedChunkEnd = chunkEnd + (chunkSize % 2);
    if (paddedChunkEnd > blob.size) {
      throw new Error(`Corrupt WAV: ${chunkId} chunk is missing its pad byte.`);
    }
    offset = paddedChunkEnd;
  }

  if (!fmt || dataOffset < 0 || dataLength < 0) {
    throw new Error("Unsupported WAV: fmt or data chunk was not found in the bounded header.");
  }
  if (fmt.headerOffset < 12 || dataHeaderOffset <= fmt.headerOffset || dataOffset <= dataHeaderOffset) {
    throw new Error("Corrupt WAV: invalid fmt/data chunk ordering.");
  }
  if (fmt.audioFormat !== WAVE_FORMAT_IEEE_FLOAT && fmt.audioFormat !== WAVE_FORMAT_EXTENSIBLE) {
    throw new Error("Unsupported WAV format: expected IEEE float or WAVE_FORMAT_EXTENSIBLE.");
  }
  if (fmt.audioFormat === WAVE_FORMAT_IEEE_FLOAT) {
    if (fmt.size > 16 && fmt.extensionSize > fmt.size - 18) {
      throw new Error("Corrupt WAV: IEEE-float fmt extension exceeds its chunk size.");
    }
  } else {
    if (fmt.size < 40 || fmt.extensionSize < 22 || 18 + fmt.extensionSize > fmt.size) {
      throw new Error("Corrupt WAV: invalid WAVE_FORMAT_EXTENSIBLE fmt size.");
    }
    if (fmt.validBitsPerSample !== 32) {
      throw new Error("Unsupported WAV: extensible float must use 32 valid bits.");
    }
    if (!fmt.ieeeFloatSubformat) {
      throw new Error("Unsupported WAV: extensible subtype GUID is not IEEE float.");
    }
    if (!hasAtMostOneChannelMaskBit(fmt.channelMask)) {
      throw new Error("Unsupported WAV: mono extensible audio has an invalid channel mask.");
    }
  }
  if (fmt.bitsPerSample !== 32 || !fmt.ieeeFloatSubformat) {
    throw new Error("Unsupported WAV: expected 32-bit IEEE float samples.");
  }
  if (fmt.channels !== 1 || fmt.blockAlign !== FLOAT32_BYTES) {
    throw new Error("Unsupported WAV: expected mono pcm_f32le audio.");
  }
  if (!Number.isInteger(fmt.sampleRate) || fmt.sampleRate <= 0 || fmt.sampleRate > 768_000) {
    throw new Error("Corrupt WAV: invalid sample rate.");
  }
  if (fmt.byteRate !== fmt.sampleRate * FLOAT32_BYTES) {
    throw new Error("Corrupt WAV: byte rate does not match mono pcm_f32le audio.");
  }
  if (dataLength % FLOAT32_BYTES !== 0 || dataOffset + dataLength > blob.size) {
    throw new Error("Corrupt WAV: data length exceeds the RIFF container.");
  }
  await validateSuffixChunks(blob, dataOffset + dataLength);

  return {
    sampleRate: fmt.sampleRate,
    dataOffset,
    dataLength,
    sampleCount: dataLength / FLOAT32_BYTES,
  };
};

const decodeFloat32LittleEndian = (buffer: ArrayBuffer) => {
  if (buffer.byteLength % FLOAT32_BYTES !== 0) {
    throw new Error("Corrupt WAV: chunk read is not aligned to float32 samples.");
  }
  const view = new DataView(buffer);
  const samples = new Float32Array(buffer.byteLength / FLOAT32_BYTES);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = view.getFloat32(index * FLOAT32_BYTES, true);
    if (!Number.isFinite(sample)) {
      throw new Error("Corrupt WAV: pcm_f32le data contains a non-finite sample.");
    }
    samples[index] = sample;
  }
  return samples;
};

const encodeFloat32LittleEndian = (samples: Float32Array, start: number, end: number) => {
  const bytes = new Uint8Array((end - start) * FLOAT32_BYTES);
  const view = new DataView(bytes.buffer);
  for (let index = start; index < end; index += 1) {
    view.setFloat32((index - start) * FLOAT32_BYTES, samples[index], true);
  }
  return bytes;
};

const relaxTamedTowardSeamGain = (
  original: number,
  tamed: number,
  seamGain: number,
  seamWeight: number,
) => {
  if (seamWeight <= 0 || Math.abs(original) <= 1e-8) return tamed;
  const existingGain = Math.max(0, Math.min(1, Math.abs(tamed / original)));
  const targetGain = Math.max(existingGain, Math.min(1, seamGain));
  if (targetGain <= existingGain) return tamed;
  const phase = Math.min(1, seamWeight);
  const weight = 0.5 - 0.5 * Math.cos(Math.PI * phase);
  return original * (existingGain + (targetGain - existingGain) * weight);
};

const resolveBoundaryProcessingGain = (
  originalSamples: Float32Array,
  tamedSamples: Float32Array,
  fromEnd: boolean,
) => {
  for (let offset = 0; offset < originalSamples.length; offset += 1) {
    const index = fromEnd ? originalSamples.length - 1 - offset : offset;
    const original = originalSamples[index] ?? 0;
    if (Math.abs(original) <= 1e-6) continue;
    const tamed = tamedSamples[index] ?? original;
    return Math.max(0, Math.min(1, Math.abs(tamed / original)));
  }
  return 1;
};

const median = (values: readonly number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

const minimum = (values: readonly number[]) => {
  let result = Number.POSITIVE_INFINITY;
  for (const value of values) result = Math.min(result, value);
  return Number.isFinite(result) ? result : 0;
};

const validateOptions = (options: ChunkedConsonantTamerOptions) => {
  const coreChunkDurationSec = options.coreChunkDurationSec ?? DEFAULT_CORE_CHUNK_DURATION_SEC;
  const requestedContextMs = options.contextDurationMs ?? MIN_CONTEXT_DURATION_MS;
  const maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
  if (!Number.isFinite(coreChunkDurationSec) || coreChunkDurationSec <= 0) {
    throw new Error("Chunked consonant tamer requires a positive core chunk duration.");
  }
  if (!Number.isFinite(requestedContextMs) || requestedContextMs < 0) {
    throw new Error("Chunked consonant tamer requires a non-negative context duration.");
  }
  if (!Number.isInteger(maxHeaderBytes) || maxHeaderBytes < MIN_WAV_HEADER_BYTES) {
    throw new Error("Chunked consonant tamer requires at least 44 bounded header bytes.");
  }
  return {
    coreChunkDurationSec,
    contextDurationMs: Math.max(MIN_CONTEXT_DURATION_MS, requestedContextMs),
    maxHeaderBytes,
  };
};

const validateReference = (
  reference: RenderedConsonantReference,
  wav: ParsedMonoFloat32Wav,
) => {
  if (
    !Number.isFinite(reference.frameMs) ||
    reference.frameMs <= 0 ||
    !Number.isFinite(reference.durationSec) ||
    reference.durationSec <= 0 ||
    reference.rmsDb.length === 0 ||
    reference.rmsDb.length !== reference.peakDb.length
  ) {
    throw new Error("Invalid rendered-consonant reference.");
  }
  if (
    !Number.isFinite(reference.sampleRate) ||
    reference.sampleRate <= 0
  ) {
    throw new Error("Invalid rendered-consonant reference sample rate.");
  }
  const exactSamplesPerFrame = (wav.sampleRate * reference.frameMs) / 1000;
  if (!Number.isFinite(exactSamplesPerFrame) || exactSamplesPerFrame < 1) {
    throw new Error("Unsupported rendered-consonant reference frame rate for this WAV.");
  }
  // A frame exists while its rounded absolute start is before the final
  // sample. This is the closed form for the minimum F where round(F*S) >= N;
  // ceil(N/S) would invent one frame when an upward-rounded boundary equals N.
  const expectedFrameCount = Math.max(
    1,
    Math.ceil((wav.sampleCount - 0.5) / exactSamplesPerFrame),
  );
  if (reference.rmsDb.length < expectedFrameCount || reference.peakDb.length < expectedFrameCount) {
    throw new Error("Rendered-consonant reference does not cover the complete WAV.");
  }
  const wavDurationSec = wav.sampleCount / wav.sampleRate;
  const durationToleranceSec = Math.max(0.05, (reference.frameMs * 2) / 1000);
  if (Math.abs(reference.durationSec - wavDurationSec) > durationToleranceSec) {
    throw new Error("Rendered-consonant reference duration does not match the WAV.");
  }
  return { samplesPerFrame: exactSamplesPerFrame, expectedFrameCount };
};

/**
 * Apply the existing source-relative consonant tamer to a mono pcm_f32le WAV
 * without ever materializing the complete Blob. Each core is
 * evaluated with at least 500 ms of surrounding samples, then only the core's
 * changed sample spans are retained. Unchanged bytes remain Blob slices of the
 * input, and a sample-identical result returns the original Blob by identity.
 */
export const tameCanonicalMonoFloat32WavBlobInChunks = async (
  wavBlob: Blob,
  reference: RenderedConsonantReference,
  options: ChunkedConsonantTamerOptions = {},
): Promise<ChunkedConsonantTamerResult> => {
  const validatedOptions = validateOptions(options);
  const wav = await parseMonoFloat32Wav(wavBlob, validatedOptions.maxHeaderBytes);
  const { samplesPerFrame, expectedFrameCount } = validateReference(reference, wav);
  const frameMs = reference.frameMs;
  const coreFrameCount = Math.max(
    1,
    Math.round((validatedOptions.coreChunkDurationSec * 1000) / frameMs),
  );
  const contextFrameCount = Math.max(
    1,
    Math.ceil(validatedOptions.contextDurationMs / frameMs),
  );

  const replacements: ReplacementSpan[] = [];
  const referenceLagValues: number[] = [];
  const referenceConfidenceValues: number[] = [];
  let processedChunkCount = 0;
  let referenceUsedChunkCount = 0;
  let referenceRejectedChunkCount = 0;
  let changedSampleCount = 0;
  let changedFrameCount = 0;
  let changedSpanCount = 0;
  let maxReductionDb = 0;
  let maxReadBytes = Math.min(wavBlob.size, validatedOptions.maxHeaderBytes);
  let lastChangedGlobalFrame = -1;
  let lastChangedSpanEndSample = -1;
  let previousReferenceUsed: boolean | null = null;
  let pendingAcceptedBoundary: PendingAcceptedBoundary | null = null;
  const frameStartSample = (frame: number) => Math.min(
    wav.sampleCount,
    Math.round(frame * samplesPerFrame),
  );
  const appendChangedSampleRange = (
    originalSamples: Float32Array,
    outputSamples: Float32Array,
    startIndex: number,
    endIndex: number,
    globalSampleOffset: number,
  ) => {
    let localIndex = startIndex;
    while (localIndex < endIndex) {
      if (Object.is(originalSamples[localIndex], outputSamples[localIndex])) {
        localIndex += 1;
        continue;
      }
      const spanStart = localIndex;
      while (
        localIndex < endIndex &&
        !Object.is(originalSamples[localIndex], outputSamples[localIndex])
      ) {
        const before = Math.abs(originalSamples[localIndex]);
        const after = Math.abs(outputSamples[localIndex]);
        if (before > 0 && after > 0 && after < before) {
          maxReductionDb = Math.max(maxReductionDb, 20 * Math.log10(before / after));
        }
        const globalSample = globalSampleOffset + localIndex;
        const globalFrame = Math.max(
          0,
          Math.min(
            expectedFrameCount - 1,
            Math.ceil((globalSample + 0.5) / samplesPerFrame) - 1,
          ),
        );
        if (globalFrame !== lastChangedGlobalFrame) {
          changedFrameCount += 1;
          lastChangedGlobalFrame = globalFrame;
        }
        localIndex += 1;
      }
      const globalStartSample = globalSampleOffset + spanStart;
      const globalEndSample = globalSampleOffset + localIndex;
      replacements.push({
        startSample: globalStartSample,
        endSample: globalEndSample,
        bytes: encodeFloat32LittleEndian(outputSamples, spanStart, localIndex),
      });
      changedSampleCount += globalEndSample - globalStartSample;
      if (globalStartSample !== lastChangedSpanEndSample) changedSpanCount += 1;
      lastChangedSpanEndSample = globalEndSample;
    }
  };
  const appendPendingAcceptedBoundary = (
    boundary: PendingAcceptedBoundary,
    seamGain: number | null,
  ) => {
    let outputSamples = boundary.tamedSamples;
    if (seamGain !== null) {
      outputSamples = new Float32Array(boundary.tamedSamples.length);
      for (let index = 0; index < outputSamples.length; index += 1) {
        const seamWeight = outputSamples.length === 1
          ? 1
          : index / (outputSamples.length - 1);
        outputSamples[index] = relaxTamedTowardSeamGain(
          boundary.originalSamples[index],
          boundary.tamedSamples[index],
          seamGain,
          seamWeight,
        );
      }
    }
    appendChangedSampleRange(
      boundary.originalSamples,
      outputSamples,
      0,
      outputSamples.length,
      boundary.startSample,
    );
  };

  for (let coreStartFrame = 0; coreStartFrame < expectedFrameCount; coreStartFrame += coreFrameCount) {
    const coreEndFrame = Math.min(expectedFrameCount, coreStartFrame + coreFrameCount);
    const readStartFrame = Math.max(0, coreStartFrame - contextFrameCount);
    const readEndFrame = Math.min(expectedFrameCount, coreEndFrame + contextFrameCount);
    const coreStartSample = frameStartSample(coreStartFrame);
    const coreEndSample = frameStartSample(coreEndFrame);
    const readStartSample = frameStartSample(readStartFrame);
    const readEndSample = frameStartSample(readEndFrame);
    const readStartByte = wav.dataOffset + readStartSample * FLOAT32_BYTES;
    const readEndByte = wav.dataOffset + readEndSample * FLOAT32_BYTES;
    const chunkByteLength = readEndByte - readStartByte;
    const chunkBuffer = await wavBlob.slice(readStartByte, readEndByte).arrayBuffer();
    if (chunkBuffer.byteLength !== chunkByteLength) {
      throw new Error("Corrupt WAV: bounded sample read returned an unexpected byte length.");
    }
    maxReadBytes = Math.max(maxReadBytes, chunkBuffer.byteLength);
    const samples = decodeFloat32LittleEndian(chunkBuffer);
    const referenceSlice: RenderedConsonantReference = {
      sampleRate: reference.sampleRate,
      frameMs,
      durationSec: samples.length / wav.sampleRate,
      rmsDb: reference.rmsDb.slice(readStartFrame, readEndFrame),
      peakDb: reference.peakDb.slice(readStartFrame, readEndFrame),
    };
    const tamed = tameRenderedConsonantPeaks(samples, wav.sampleRate, frameMs, {
      reference: referenceSlice,
      referenceMatchWindowMs: options.referenceMatchWindowMs,
      maxReductionDb: options.maxReductionDb,
      analysisFrameOffset: readStartFrame,
    });
    processedChunkCount += 1;
    const referenceUsed = tamed.stats.referenceUsed;
    const referenceConfidence = Number.isFinite(tamed.stats.referenceConfidence)
      ? Math.max(0, Math.min(1, tamed.stats.referenceConfidence))
      : 0;
    referenceConfidenceValues.push(referenceConfidence);
    if (!referenceUsed) {
      if (pendingAcceptedBoundary) {
        appendPendingAcceptedBoundary(pendingAcceptedBoundary, 1);
        pendingAcceptedBoundary = null;
      }
      referenceRejectedChunkCount += 1;
      previousReferenceUsed = false;
      continue;
    }
    referenceUsedChunkCount += 1;
    referenceLagValues.push(tamed.stats.referenceLagMs);

    const localCoreStart = coreStartSample - readStartSample;
    const localCoreEnd = coreEndSample - readStartSample;
    const coreSampleCount = localCoreEnd - localCoreStart;
    const taperSampleCount = Math.min(
      coreSampleCount,
      Math.max(
        1,
        Math.round((wav.sampleRate * CHUNK_BOUNDARY_RECONCILIATION_DURATION_MS) / 1000),
      ),
    );
    const pendingStart = localCoreEnd - taperSampleCount;
    const startTaperEnd = Math.min(localCoreStart + taperSampleCount, localCoreEnd);
    const originalStartBoundarySamples = samples.slice(localCoreStart, startTaperEnd);
    const tamedStartBoundarySamples = tamed.samples.slice(localCoreStart, startTaperEnd);
    let startSeamGain = previousReferenceUsed === false ? 1 : null;
    if (pendingAcceptedBoundary) {
      const previousEdgeGain = resolveBoundaryProcessingGain(
        pendingAcceptedBoundary.originalSamples,
        pendingAcceptedBoundary.tamedSamples,
        true,
      );
      const currentEdgeGain = resolveBoundaryProcessingGain(
        originalStartBoundarySamples,
        tamedStartBoundarySamples,
        false,
      );
      const gainsDiverge = Math.abs(previousEdgeGain - currentEdgeGain) > 1e-6;
      // Meet at the less-attenuated decision. Reconciliation can only relax
      // an authorized dip; it never manufactures extra processing at a seam.
      const commonSeamGain = gainsDiverge
        ? Math.max(previousEdgeGain, currentEdgeGain)
        : null;
      appendPendingAcceptedBoundary(pendingAcceptedBoundary, commonSeamGain);
      pendingAcceptedBoundary = null;
      startSeamGain = commonSeamGain;
    }
    let immediateStart = localCoreStart;
    if (startSeamGain !== null && immediateStart < pendingStart) {
      const immediateTaperEnd = Math.min(startTaperEnd, pendingStart);
      const originalStartWindow = samples.slice(localCoreStart, immediateTaperEnd);
      const tamedStartWindow = tamed.samples.slice(localCoreStart, immediateTaperEnd);
      for (let index = 0; index < tamedStartWindow.length; index += 1) {
        const seamWeight = taperSampleCount === 1
          ? 1
          : 1 - index / (taperSampleCount - 1);
        tamedStartWindow[index] = relaxTamedTowardSeamGain(
          originalStartWindow[index],
          tamedStartWindow[index],
          startSeamGain,
          seamWeight,
        );
      }
      appendChangedSampleRange(
        originalStartWindow,
        tamedStartWindow,
        0,
        tamedStartWindow.length,
        coreStartSample,
      );
      immediateStart = immediateTaperEnd;
    }
    appendChangedSampleRange(
      samples,
      tamed.samples,
      immediateStart,
      pendingStart,
      readStartSample,
    );

    // The next core's actual edge gain is needed to reconcile independent
    // alignment decisions. Retain only 2 ms instead of the padded core.
    const originalBoundarySamples = samples.slice(pendingStart, localCoreEnd);
    const tamedBoundarySamples = tamed.samples.slice(pendingStart, localCoreEnd);
    if (startSeamGain !== null) {
      for (let index = 0; index < tamedBoundarySamples.length; index += 1) {
        const coreOffset = pendingStart + index - localCoreStart;
        if (coreOffset >= taperSampleCount) break;
        const seamWeight = taperSampleCount === 1
          ? 1
          : 1 - coreOffset / (taperSampleCount - 1);
        tamedBoundarySamples[index] = relaxTamedTowardSeamGain(
          originalBoundarySamples[index],
          tamedBoundarySamples[index],
          startSeamGain,
          seamWeight,
        );
      }
    }
    pendingAcceptedBoundary = {
      originalSamples: originalBoundarySamples,
      tamedSamples: tamedBoundarySamples,
      startSample: readStartSample + pendingStart,
    };
    previousReferenceUsed = true;
  }
  if (pendingAcceptedBoundary) {
    appendPendingAcceptedBoundary(pendingAcceptedBoundary, null);
  }

  const stats: ChunkedConsonantTamerStats = {
    tamedFrameCount: changedFrameCount,
    maxReductionDb,
    referenceLagMs: median(referenceLagValues),
    referenceConfidence: median(referenceConfidenceValues),
    minimumReferenceConfidence: minimum(referenceConfidenceValues),
    referenceUsedChunkCount,
    referenceRejectedChunkCount,
    processedChunkCount,
    changedSampleCount,
    changedSpanCount,
    maxReadBytes,
  };
  if (replacements.length === 0) {
    return { blob: wavBlob, stats };
  }

  const parts: BlobPart[] = [await readOwnedBlobPart(wavBlob, 0, wav.dataOffset)];
  let nextOriginalSample = 0;
  for (const replacement of replacements) {
    if (replacement.startSample > nextOriginalSample) {
      parts.push(
        await readOwnedBlobPart(
          wavBlob,
          wav.dataOffset + nextOriginalSample * FLOAT32_BYTES,
          wav.dataOffset + replacement.startSample * FLOAT32_BYTES,
        ),
      );
    }
    parts.push(bytesAsBlobPart(replacement.bytes));
    nextOriginalSample = replacement.endSample;
  }
  if (nextOriginalSample < wav.sampleCount) {
    parts.push(
      await readOwnedBlobPart(
        wavBlob,
        wav.dataOffset + nextOriginalSample * FLOAT32_BYTES,
        wav.dataOffset + wav.dataLength,
      ),
    );
  }
  const dataEnd = wav.dataOffset + wav.dataLength;
  if (dataEnd < wavBlob.size) parts.push(await readOwnedBlobPart(wavBlob, dataEnd, wavBlob.size));

  return {
    blob: new Blob(parts, { type: wavBlob.type || "audio/wav" }),
    stats,
  };
};
