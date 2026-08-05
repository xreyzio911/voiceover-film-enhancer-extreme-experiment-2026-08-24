const RIFF_HEADER_BYTES = 12;
const CANONICAL_FLOAT_WAV_HEADER_BYTES = 44;
const BLOB_WAV_HEADER_PROBE_BYTES = 64 * 1024;
const BLOB_WAV_HEADER_MAX_PROBE_BYTES = 4 * 1024 * 1024;
const FLOAT32_BYTES = Float32Array.BYTES_PER_ELEMENT;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export type MonoFloat32WavInfo = Readonly<{
  sampleRate: number;
  dataOffset: number;
  dataBytes: number;
  totalSamples: number;
  durationSec: number;
}>;

export type BoundedWavWindow = Readonly<{
  bytes: Uint8Array;
  startSample: number;
  sampleCount: number;
  durationSec: number;
}>;

export type BoundedWavQcRoutingInput = Readonly<{
  durationSec: number;
  renderedBytes: number;
  companionBytes?: number;
  minDurationSec: number;
  minRenderedBytes: number;
  minCombinedBytes: number;
}>;

const finiteNonNegative = (value: number) => (
  Number.isFinite(value) ? Math.max(0, value) : 0
);

/**
 * Conservatively projects the exact byte footprint of the app's canonical
 * mono 48 kHz float delivery WAV before that render exists. This lets source
 * review decoding use the same memory route as rendered-candidate QC instead
 * of relying on a separate duration threshold that can drift.
 */
export const estimateCanonicalMonoFloat32WavBytes = (
  durationSec: number,
  sampleRate = 48_000,
) => {
  const safeDurationSec = finiteNonNegative(durationSec);
  const safeSampleRate = Math.max(1, Math.floor(finiteNonNegative(sampleRate)));
  const sampleCount = Math.ceil(safeDurationSec * safeSampleRate);
  return CANONICAL_FLOAT_WAV_HEADER_BYTES + sampleCount * FLOAT32_BYTES;
};

/**
 * Selects the bounded analysis implementation from actual browser-memory
 * pressure. The source and render coexist in FFmpeg's virtual filesystem, so
 * their combined footprint can be unsafe before either file is large alone.
 * This is only an execution route; it does not accept or reject audio.
 */
export const shouldUseBoundedWavQc = (input: BoundedWavQcRoutingInput) => {
  const durationSec = finiteNonNegative(input.durationSec);
  const renderedBytes = finiteNonNegative(input.renderedBytes);
  const companionBytes = finiteNonNegative(input.companionBytes ?? 0);
  const minDurationSec = finiteNonNegative(input.minDurationSec);
  const minRenderedBytes = finiteNonNegative(input.minRenderedBytes);
  const minCombinedBytes = finiteNonNegative(input.minCombinedBytes);
  return (
    durationSec >= minDurationSec ||
    renderedBytes >= minRenderedBytes ||
    renderedBytes + companionBytes >= minCombinedBytes
  );
};

const readAscii = (view: DataView, offset: number, length: number) => {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
};

const writeAscii = (view: DataView, offset: number, value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
};

class IncompleteWavPrefixError extends Error {
  readonly requiredBytes: number;

  constructor(requiredBytes: number) {
    super("WAV header inspection needs a larger bounded prefix.");
    this.name = "IncompleteWavPrefixError";
    this.requiredBytes = requiredBytes;
  }
}

const inspectMonoFloat32WavPrefix = (
  bytes: Uint8Array,
  fileByteLength: number,
): MonoFloat32WavInfo => {
  if (
    bytes.byteLength < CANONICAL_FLOAT_WAV_HEADER_BYTES ||
    fileByteLength < CANONICAL_FLOAT_WAV_HEADER_BYTES ||
    bytes.byteLength > fileByteLength
  ) {
    throw new Error("WAV is too small for bounded QC.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
    throw new Error("Bounded QC expects a RIFF/WAVE container.");
  }

  let offset = RIFF_HEADER_BYTES;
  let formatValid = false;
  let sampleRate = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkId !== "data" && chunkEnd > fileByteLength) {
      throw new Error(`Corrupt WAV: ${chunkId.trim() || "unknown"} chunk exceeds the file.`);
    }
    if (chunkId !== "data" && chunkEnd > view.byteLength) {
      const nextChunkHeaderEnd = chunkEnd + (chunkSize % 2) + 8;
      throw new IncompleteWavPrefixError(Math.min(fileByteLength, nextChunkHeaderEnd));
    }

    if (chunkId === "fmt ") {
      if (chunkSize < 16) throw new Error("Corrupt WAV: incomplete fmt chunk.");
      const rawFormat = view.getUint16(chunkStart, true);
      const channels = view.getUint16(chunkStart + 2, true);
      sampleRate = view.getUint32(chunkStart + 4, true);
      const byteRate = view.getUint32(chunkStart + 8, true);
      const blockAlign = view.getUint16(chunkStart + 12, true);
      const bitsPerSample = view.getUint16(chunkStart + 14, true);
      const extensibleFloat =
        rawFormat === WAVE_FORMAT_EXTENSIBLE &&
        chunkSize >= 40 &&
        view.getUint16(chunkStart + 18, true) === 32 &&
        view.getUint16(chunkStart + 24, true) === WAVE_FORMAT_IEEE_FLOAT;
      formatValid =
        (rawFormat === WAVE_FORMAT_IEEE_FLOAT || extensibleFloat) &&
        channels === 1 &&
        bitsPerSample === 32 &&
        blockAlign === FLOAT32_BYTES &&
        sampleRate > 0 &&
        byteRate === sampleRate * FLOAT32_BYTES;
    } else if (chunkId === "data") {
      dataOffset = chunkStart;
      dataBytes = chunkSize;
      if (dataOffset + dataBytes > fileByteLength) {
        throw new Error("Corrupt WAV: data chunk exceeds the file.");
      }
      break;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (dataOffset < 0 && view.byteLength < fileByteLength) {
    throw new IncompleteWavPrefixError(
      Math.min(fileByteLength, Math.max(offset + 8, view.byteLength + 8)),
    );
  }

  if (!formatValid) {
    throw new Error("Bounded QC expects mono pcm_f32le audio.");
  }
  if (dataOffset < 0 || dataBytes <= 0 || dataBytes % FLOAT32_BYTES !== 0) {
    throw new Error("Corrupt WAV: missing or misaligned float32 audio data.");
  }

  const totalSamples = dataBytes / FLOAT32_BYTES;
  return {
    sampleRate,
    dataOffset,
    dataBytes,
    totalSamples,
    durationSec: totalSamples / sampleRate,
  };
};

export const inspectMonoFloat32Wav = (bytes: Uint8Array): MonoFloat32WavInfo =>
  inspectMonoFloat32WavPrefix(bytes, bytes.byteLength);

export const inspectMonoFloat32WavBlob = async (blob: Blob): Promise<MonoFloat32WavInfo> => {
  let prefixEnd = Math.min(blob.size, BLOB_WAV_HEADER_PROBE_BYTES);
  while (true) {
    const prefixBytes = new Uint8Array(await blob.slice(0, prefixEnd).arrayBuffer());
    try {
      return inspectMonoFloat32WavPrefix(prefixBytes, blob.size);
    } catch (error) {
      if (!(error instanceof IncompleteWavPrefixError)) throw error;
      const requiredBytes = Math.max(prefixEnd + 1, error.requiredBytes);
      if (requiredBytes > BLOB_WAV_HEADER_MAX_PROBE_BYTES) {
        throw new Error(
          `WAV metadata prefix exceeds the ${BLOB_WAV_HEADER_MAX_PROBE_BYTES}-byte bounded inspection limit.`,
        );
      }
      prefixEnd = Math.min(blob.size, requiredBytes);
    }
  }
};

const encodeCanonicalHeader = (sampleRate: number, sampleCount: number) => {
  const dataBytes = sampleCount * FLOAT32_BYTES;
  const output = new Uint8Array(CANONICAL_FLOAT_WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(output.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, output.byteLength - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, WAVE_FORMAT_IEEE_FLOAT, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * FLOAT32_BYTES, true);
  view.setUint16(32, FLOAT32_BYTES, true);
  view.setUint16(34, 32, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  return output;
};

const resolveWindowSamples = (
  info: MonoFloat32WavInfo,
  startSec: number,
  durationSec: number,
) => {
  if (!Number.isFinite(startSec) || startSec < 0) {
    throw new Error("Bounded QC window start must be a finite non-negative value.");
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("Bounded QC window duration must be a finite positive value.");
  }
  const startSample = Math.min(info.totalSamples, Math.max(0, Math.round(startSec * info.sampleRate)));
  const requestedSamples = Math.max(1, Math.round(durationSec * info.sampleRate));
  const sampleCount = Math.min(requestedSamples, info.totalSamples - startSample);
  if (sampleCount <= 0) throw new Error("Bounded QC window starts after the WAV audio data.");
  return { startSample, sampleCount };
};

export const sliceMonoFloat32Wav = (
  bytes: Uint8Array,
  startSec: number,
  durationSec: number,
): BoundedWavWindow => {
  const info = inspectMonoFloat32Wav(bytes);
  const { startSample, sampleCount } = resolveWindowSamples(info, startSec, durationSec);

  const output = encodeCanonicalHeader(info.sampleRate, sampleCount);
  const sourceStart = info.dataOffset + startSample * FLOAT32_BYTES;
  const sourceEnd = sourceStart + sampleCount * FLOAT32_BYTES;
  output.set(bytes.subarray(sourceStart, sourceEnd), CANONICAL_FLOAT_WAV_HEADER_BYTES);
  return {
    bytes: output,
    startSample,
    sampleCount,
    durationSec: sampleCount / info.sampleRate,
  };
};

export const sliceMonoFloat32WavBlob = async (
  blob: Blob,
  info: MonoFloat32WavInfo,
  startSec: number,
  durationSec: number,
): Promise<BoundedWavWindow> => {
  if (info.dataOffset + info.dataBytes > blob.size) {
    throw new Error("Corrupt WAV: data chunk exceeds the Blob.");
  }
  const { startSample, sampleCount } = resolveWindowSamples(info, startSec, durationSec);

  const sourceStart = info.dataOffset + startSample * FLOAT32_BYTES;
  const sourceEnd = sourceStart + sampleCount * FLOAT32_BYTES;
  const sourceBytes = new Uint8Array(await blob.slice(sourceStart, sourceEnd).arrayBuffer());
  if (sourceBytes.byteLength !== sampleCount * FLOAT32_BYTES) {
    throw new Error("Bounded QC Blob slice returned incomplete audio data.");
  }
  const output = encodeCanonicalHeader(info.sampleRate, sampleCount);
  output.set(sourceBytes, CANONICAL_FLOAT_WAV_HEADER_BYTES);
  return {
    bytes: output,
    startSample,
    sampleCount,
    durationSec: sampleCount / info.sampleRate,
  };
};
