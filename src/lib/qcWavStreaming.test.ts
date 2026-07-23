import assert from "node:assert/strict";
import test from "node:test";

import {
  decodePcmWavMonoRange,
  parseWavHeader,
} from "./qcWavStreaming.ts";

const writeAscii = (view: DataView, offset: number, value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
};

const pcmToInteger = (value: number, bitsPerSample: 8 | 16 | 24 | 32) => {
  const clamped = Math.max(-1, Math.min(1, value));
  if (bitsPerSample === 8) return Math.round((clamped * 0.5 + 0.5) * 255);
  const scale = 2 ** (bitsPerSample - 1);
  return Math.max(-scale, Math.min(scale - 1, Math.round(clamped * scale)));
};

const writePcmSample = (
  view: DataView,
  offset: number,
  bitsPerSample: 8 | 16 | 24 | 32,
  value: number,
) => {
  const integer = pcmToInteger(value, bitsPerSample);
  if (bitsPerSample === 8) {
    view.setUint8(offset, integer);
  } else if (bitsPerSample === 16) {
    view.setInt16(offset, integer, true);
  } else if (bitsPerSample === 24) {
    view.setUint8(offset, integer & 0xff);
    view.setUint8(offset + 1, (integer >> 8) & 0xff);
    view.setUint8(offset + 2, (integer >> 16) & 0xff);
  } else {
    view.setInt32(offset, integer, true);
  }
};

const buildPcmWav = (
  samples: readonly (readonly number[])[],
  options: { sampleRate?: number; bitsPerSample: 8 | 16 | 24 | 32 },
) => {
  const channels = samples[0]?.length ?? 1;
  const sampleRate = options.sampleRate ?? 48000;
  const bytesPerChannelSample = options.bitsPerSample / 8;
  const blockAlign = channels * bytesPerChannelSample;
  const dataBytes = samples.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, options.bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let frame = 0; frame < samples.length; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      writePcmSample(
        view,
        44 + frame * blockAlign + channel * bytesPerChannelSample,
        options.bitsPerSample,
        samples[frame]?.[channel] ?? 0,
      );
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
};

const buildExtensibleFloat32Wav = (
  samples: readonly (readonly number[])[],
  options: { sampleRate?: number } = {},
) => {
  const channels = samples[0]?.length ?? 1;
  const sampleRate = options.sampleRate ?? 48000;
  const bytesPerChannelSample = 4;
  const blockAlign = channels * bytesPerChannelSample;
  const dataBytes = samples.length * blockAlign;
  const fmtBytes = 40;
  const dataOffset = 12 + 8 + fmtBytes + 8;
  const buffer = new ArrayBuffer(dataOffset + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, fmtBytes, true);
  view.setUint16(20, 0xfffe, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 32, true);
  view.setUint16(36, 22, true);
  view.setUint16(38, 32, true);
  view.setUint32(40, 0, true);
  // WAVE_FORMAT_EXTENSIBLE subformat: IEEE_FLOAT
  view.setUint16(44, 3, true);
  view.setUint16(46, 0, true);
  view.setUint32(48, 0x00100000, true);
  view.setUint16(52, 0x0080, false);
  view.setUint8(54, 0x00);
  view.setUint8(55, 0xaa);
  view.setUint8(56, 0x00);
  view.setUint8(57, 0x38);
  view.setUint8(58, 0x9b);
  view.setUint8(59, 0x71);
  writeAscii(view, 60, "data");
  view.setUint32(64, dataBytes, true);

  for (let frame = 0; frame < samples.length; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      view.setFloat32(
        dataOffset + frame * blockAlign + channel * bytesPerChannelSample,
        samples[frame]?.[channel] ?? 0,
        true,
      );
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
};

const assertAlmostEqual = (actual: number, expected: number, tolerance = 1e-4) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
};

test("parses and decodes a bounded stereo 16-bit PCM range as mono frames", async () => {
  const blob = buildPcmWav(
    [
      [0.25, 0.75],
      [-0.5, 0.25],
      [0.1, -0.3],
    ],
    { bitsPerSample: 16, sampleRate: 44100 },
  );
  const wav = await parseWavHeader(blob);

  assert.equal(wav.channels, 2);
  assert.equal(wav.sampleRate, 44100);
  assert.equal(wav.blockAlign, 4);
  assert.equal(wav.totalFrames, 3);

  const decoded = await decodePcmWavMonoRange(blob, wav, 1, 3);
  assert.equal(decoded.length, 2);
  assertAlmostEqual(decoded[0], (-0.5 + 0.25) / 2);
  assertAlmostEqual(decoded[1], (0.1 - 0.3) / 2);
});

test("decodes signed 24-bit PCM ranges without losing byte alignment", async () => {
  const blob = buildPcmWav(
    [
      [-0.75],
      [0.5],
      [-0.125],
      [0.875],
    ],
    { bitsPerSample: 24 },
  );
  const wav = await parseWavHeader(blob);

  assert.equal(wav.bitsPerSample, 24);
  assert.equal(wav.blockAlign, 3);

  const decoded = await decodePcmWavMonoRange(blob, wav, 2, 4);
  assert.equal(decoded.length, 2);
  assertAlmostEqual(decoded[0], -0.125);
  assertAlmostEqual(decoded[1], 0.875);
});

test("normalizes WAVE_FORMAT_EXTENSIBLE float32 and averages multichannel samples", async () => {
  const blob = buildExtensibleFloat32Wav(
    [
      [0.5, -0.25, 0.25],
      [-0.25, -0.25, 0.5],
    ],
    { sampleRate: 48000 },
  );
  const wav = await parseWavHeader(blob);

  assert.equal(wav.audioFormat, 3);
  assert.equal(wav.bitsPerSample, 32);
  assert.equal(wav.channels, 3);
  assert.equal(wav.dataOffset, 68);

  const decoded = await decodePcmWavMonoRange(blob, wav, 0, 2);
  assertAlmostEqual(decoded[0], (0.5 - 0.25 + 0.25) / 3, 1e-7);
  assertAlmostEqual(decoded[1], (-0.25 - 0.25 + 0.5) / 3, 1e-7);
});

test("rejects invalid bounded sample ranges instead of silently clipping", async () => {
  const blob = buildPcmWav([[0], [0]], { bitsPerSample: 16 });
  const wav = await parseWavHeader(blob);

  await assert.rejects(() => decodePcmWavMonoRange(blob, wav, -1, 1), RangeError);
  await assert.rejects(() => decodePcmWavMonoRange(blob, wav, 1, 3), RangeError);
  await assert.rejects(() => decodePcmWavMonoRange(blob, wav, 2, 1), RangeError);
});
