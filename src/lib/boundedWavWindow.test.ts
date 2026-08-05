import assert from "node:assert/strict";
import test from "node:test";
import { decodeWav, encodeWavFloat32 } from "./webAudioRender.ts";
import {
  estimateCanonicalMonoFloat32WavBytes,
  inspectMonoFloat32WavBlob,
  inspectMonoFloat32Wav,
  shouldUseBoundedWavQc,
  sliceMonoFloat32WavBlob,
  sliceMonoFloat32Wav,
} from "./boundedWavWindow.ts";

const buildRamp = (sampleRate: number, seconds: number) => {
  const samples = new Float32Array(Math.round(sampleRate * seconds));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = index / Math.max(1, samples.length - 1);
  }
  return samples;
};

test("inspects app-rendered mono float32 WAV without decoding the full payload", () => {
  const sampleRate = 48_000;
  const samples = buildRamp(sampleRate, 3);
  const bytes = encodeWavFloat32(samples, sampleRate, 1);

  const info = inspectMonoFloat32Wav(bytes);

  assert.equal(info.sampleRate, sampleRate);
  assert.equal(info.totalSamples, samples.length);
  assert.equal(info.durationSec, 3);
  assert.equal(info.dataOffset, 44);
});

test("slices an exact bounded window into a standalone canonical WAV", () => {
  const sampleRate = 48_000;
  const samples = buildRamp(sampleRate, 4);
  const bytes = encodeWavFloat32(samples, sampleRate, 1);

  const window = sliceMonoFloat32Wav(bytes, 1.25, 0.5);
  const decoded = decodeWav(window.bytes);

  assert.equal(window.startSample, 60_000);
  assert.equal(window.sampleCount, 24_000);
  assert.equal(decoded.sampleRate, sampleRate);
  assert.equal(decoded.channels, 1);
  assert.equal(decoded.samples.length, 24_000);
  assert.ok(Math.abs(decoded.samples[0] - samples[60_000]) < 1e-7);
  assert.ok(Math.abs(decoded.samples.at(-1)! - samples[83_999]) < 1e-7);
  assert.equal(window.bytes.byteLength, 44 + 24_000 * Float32Array.BYTES_PER_ELEMENT);
});

test("clamps the final bounded window without padding or timing drift", () => {
  const sampleRate = 48_000;
  const bytes = encodeWavFloat32(buildRamp(sampleRate, 2), sampleRate, 1);

  const window = sliceMonoFloat32Wav(bytes, 1.8, 1);

  assert.equal(window.startSample, 86_400);
  assert.equal(window.sampleCount, 9_600);
  assert.equal(window.durationSec, 0.2);
});

test("slices a final-WAV Blob without materializing the complete file", async () => {
  class WholeReadTrackingBlob extends Blob {
    wholeRead = false;
    largestSliceBytes = 0;

    override async arrayBuffer() {
      this.wholeRead = true;
      return super.arrayBuffer();
    }

    override slice(start?: number, end?: number, contentType?: string) {
      const safeStart = start ?? 0;
      const safeEnd = end ?? this.size;
      this.largestSliceBytes = Math.max(this.largestSliceBytes, safeEnd - safeStart);
      return super.slice(start, end, contentType);
    }
  }

  const sampleRate = 48_000;
  const samples = buildRamp(sampleRate, 4);
  const encoded = encodeWavFloat32(samples, sampleRate, 1);
  const encodedBuffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(encodedBuffer).set(encoded);
  const blob = new WholeReadTrackingBlob([encodedBuffer]);
  const info = await inspectMonoFloat32WavBlob(blob);
  const window = await sliceMonoFloat32WavBlob(blob, info, 1.25, 0.5);
  const decoded = decodeWav(window.bytes);

  assert.equal(blob.wholeRead, false, "bounded Blob inspection must never call whole-file arrayBuffer()");
  assert.ok(blob.largestSliceBytes < blob.size);
  assert.equal(info.durationSec, 4);
  assert.equal(window.startSample, 60_000);
  assert.equal(window.sampleCount, 24_000);
  assert.ok(Math.abs(decoded.samples[0] - samples[60_000]) < 1e-7);
  assert.ok(Math.abs(decoded.samples.at(-1)! - samples[83_999]) < 1e-7);
});

test("rejects stereo or non-float input instead of silently misreading QC evidence", () => {
  const stereo = encodeWavFloat32(new Float32Array(48_000 * 2), 48_000, 2);
  assert.throws(() => inspectMonoFloat32Wav(stereo), /mono pcm_f32le/i);

  const int16 = encodeWavFloat32(new Float32Array(48_000), 48_000, 1);
  new DataView(int16.buffer, int16.byteOffset, int16.byteLength).setUint16(20, 1, true);
  assert.throws(() => inspectMonoFloat32Wav(int16), /mono pcm_f32le/i);
});

test("routes QC by combined WASM footprint before either WAV is individually huge", () => {
  const mib = 1024 * 1024;
  const routing = {
    minDurationSec: 600,
    minRenderedBytes: 96 * mib,
    minCombinedBytes: 40 * mib,
  };

  assert.equal(shouldUseBoundedWavQc({
    durationSec: 457,
    renderedBytes: Math.round(83.7 * mib),
    companionBytes: Math.round(41.8 * mib),
    ...routing,
  }), true, "the observed Antonio source+render footprint must avoid whole-file WASM QC");
  assert.equal(shouldUseBoundedWavQc({
    durationSec: 90,
    renderedBytes: 16.5 * mib,
    companionBytes: 24.8 * mib,
    ...routing,
  }), true, "the observed fourth-file audition footprint must take the bounded route");
  assert.equal(shouldUseBoundedWavQc({
    durationSec: 90,
    renderedBytes: 16 * mib,
    companionBytes: 20 * mib,
    ...routing,
  }), false);
  assert.equal(shouldUseBoundedWavQc({
    durationSec: 600,
    renderedBytes: 8 * mib,
    companionBytes: 4 * mib,
    ...routing,
  }), true);
  assert.equal(shouldUseBoundedWavQc({
    durationSec: 60,
    renderedBytes: 97 * mib,
    companionBytes: 0,
    ...routing,
  }), true);
});

test("estimates the exact canonical render footprint for pre-render memory routing", () => {
  const mib = 1024 * 1024;
  const routing = {
    minDurationSec: 600,
    minRenderedBytes: 96 * mib,
    minCombinedBytes: 112 * mib,
  };

  assert.equal(estimateCanonicalMonoFloat32WavBytes(0), 44);
  assert.equal(estimateCanonicalMonoFloat32WavBytes(-10), 44);
  assert.equal(estimateCanonicalMonoFloat32WavBytes(Number.NaN), 44);
  assert.equal(
    estimateCanonicalMonoFloat32WavBytes(600),
    44 + 600 * 48_000 * Float32Array.BYTES_PER_ELEMENT,
  );
  assert.equal(
    shouldUseBoundedWavQc({
      durationSec: 457,
      renderedBytes: estimateCanonicalMonoFloat32WavBytes(457),
      companionBytes: Math.round(41.8 * mib),
      ...routing,
    }),
    true,
    "the source review decode must be skipped when the projected render plus source crosses the bounded-QC footprint",
  );
  assert.equal(
    shouldUseBoundedWavQc({
      durationSec: 300,
      renderedBytes: estimateCanonicalMonoFloat32WavBytes(300),
      companionBytes: 20 * mib,
      ...routing,
    }),
    false,
  );
});
