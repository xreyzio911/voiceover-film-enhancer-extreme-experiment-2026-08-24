export const QC_WAV_HEADER_SCAN_BYTES = 8 * 1024 * 1024;

export type ParsedWavInfo = {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  audioFormat: number;
  blockAlign: number;
  dataOffset: number;
  dataBytes: number;
  totalFrames: number;
  durationSec: number;
};

type SliceableAudioBlob = Pick<Blob, "size" | "slice">;

const readFourCC = (view: DataView, offset: number) =>
  String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );

export const parseWavHeader = async (
  file: SliceableAudioBlob,
): Promise<ParsedWavInfo> => {
  const headerScanBytes = Math.min(file.size, QC_WAV_HEADER_SCAN_BYTES);
  const headerBuffer = await file.slice(0, headerScanBytes).arrayBuffer();
  const view = new DataView(headerBuffer);

  if (view.byteLength < 12) {
    throw new Error("WAV header is too small.");
  }
  const riff = readFourCC(view, 0);
  const wave = readFourCC(view, 8);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Unsupported WAV container (expected RIFF/WAVE).");
  }

  let offset = 12;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let audioFormat: number | null = null;
  let blockAlign: number | null = null;
  let dataOffset: number | null = null;
  let dataBytes: number | null = null;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readFourCC(view, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    const nextOffset = chunkDataOffset + chunkSize + (chunkSize % 2);

    if (chunkId === "fmt " && chunkDataOffset + Math.min(chunkSize, 40) <= view.byteLength) {
      const rawFormat = view.getUint16(chunkDataOffset, true);
      const parsedChannels = view.getUint16(chunkDataOffset + 2, true);
      const parsedSampleRate = view.getUint32(chunkDataOffset + 4, true);
      const parsedBlockAlign = view.getUint16(chunkDataOffset + 12, true);
      const parsedBitsPerSample = view.getUint16(chunkDataOffset + 14, true);

      let normalizedFormat = rawFormat;
      if (rawFormat === 0xfffe && chunkSize >= 40 && chunkDataOffset + 40 <= view.byteLength) {
        normalizedFormat = view.getUint16(chunkDataOffset + 24, true);
      }

      channels = parsedChannels;
      sampleRate = parsedSampleRate;
      blockAlign = parsedBlockAlign;
      bitsPerSample = parsedBitsPerSample;
      audioFormat = normalizedFormat;
    } else if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataBytes = Math.min(chunkSize, Math.max(0, file.size - chunkDataOffset));
      break;
    }

    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  if (channels === null || sampleRate === null || bitsPerSample === null || audioFormat === null || blockAlign === null) {
    throw new Error("WAV fmt chunk not found or incomplete.");
  }
  if (dataOffset === null || dataBytes === null) {
    throw new Error("WAV data chunk not found in header scan.");
  }
  if (channels <= 0 || sampleRate <= 0 || blockAlign <= 0) {
    throw new Error("Invalid WAV format values.");
  }

  const bytesPerSample = blockAlign / channels;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0) {
    throw new Error("Unsupported WAV block alignment.");
  }

  const supported =
    (audioFormat === 1 && [8, 16, 24, 32].includes(bitsPerSample)) ||
    (audioFormat === 3 && [32, 64].includes(bitsPerSample));
  if (!supported) {
    throw new Error(`Unsupported WAV sample format (format ${audioFormat}, ${bitsPerSample}-bit).`);
  }

  const totalFrames = Math.floor(dataBytes / blockAlign);
  const durationSec = totalFrames / sampleRate;
  return {
    channels,
    sampleRate,
    bitsPerSample,
    audioFormat,
    blockAlign,
    dataOffset,
    dataBytes,
    totalFrames,
    durationSec,
  };
};

export const createWavSampleReader = (
  view: DataView,
  audioFormat: number,
  bitsPerSample: number,
) => {
  if (audioFormat === 3 && bitsPerSample === 32) {
    return (byteOffset: number) => view.getFloat32(byteOffset, true);
  }
  if (audioFormat === 3 && bitsPerSample === 64) {
    return (byteOffset: number) => view.getFloat64(byteOffset, true);
  }
  if (audioFormat === 1 && bitsPerSample === 8) {
    return (byteOffset: number) => (view.getUint8(byteOffset) - 128) / 128;
  }
  if (audioFormat === 1 && bitsPerSample === 16) {
    return (byteOffset: number) => view.getInt16(byteOffset, true) / 32768;
  }
  if (audioFormat === 1 && bitsPerSample === 24) {
    return (byteOffset: number) => {
      let value =
        view.getUint8(byteOffset) |
        (view.getUint8(byteOffset + 1) << 8) |
        (view.getUint8(byteOffset + 2) << 16);
      if (value & 0x800000) value |= ~0xffffff;
      return value / 8388608;
    };
  }
  if (audioFormat === 1 && bitsPerSample === 32) {
    return (byteOffset: number) => view.getInt32(byteOffset, true) / 2147483648;
  }
  throw new Error(`Unsupported WAV reader (format ${audioFormat}, ${bitsPerSample}-bit).`);
};

export const decodePcmWavMonoRange = async (
  file: SliceableAudioBlob,
  wav: ParsedWavInfo,
  startSample: number,
  endSample: number,
) => {
  const start = Math.trunc(startSample);
  const end = Math.trunc(endSample);
  if (
    !Number.isFinite(startSample) ||
    !Number.isFinite(endSample) ||
    start < 0 ||
    end < start ||
    end > wav.totalFrames
  ) {
    throw new RangeError(`Invalid WAV sample range [${startSample}, ${endSample}).`);
  }

  const frameCount = end - start;
  const byteStart = wav.dataOffset + start * wav.blockAlign;
  const byteEnd = wav.dataOffset + end * wav.blockAlign;
  const buffer = await file.slice(byteStart, byteEnd).arrayBuffer();
  const expectedBytes = frameCount * wav.blockAlign;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `WAV range [${start}, ${end}) returned ${buffer.byteLength} bytes; expected ${expectedBytes}.`,
    );
  }

  const view = new DataView(buffer);
  const readSample = createWavSampleReader(view, wav.audioFormat, wav.bitsPerSample);
  const bytesPerChannelSample = wav.blockAlign / wav.channels;
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const baseByteOffset = frame * wav.blockAlign;
    let mono = 0;
    for (let channel = 0; channel < wav.channels; channel += 1) {
      mono += readSample(baseByteOffset + channel * bytesPerChannelSample) / wav.channels;
    }
    samples[frame] = mono;
  }
  return samples;
};
