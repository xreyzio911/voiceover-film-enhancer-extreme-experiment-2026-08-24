import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  tameCanonicalMonoFloat32WavBlobInChunks,
} from "./chunkedConsonantTamer.ts";
import {
  buildRenderedConsonantReference,
  tameRenderedConsonantPeaks,
} from "./gainPlanner.ts";
import { decodeWav, encodeWavFloat32 } from "./webAudioRender.ts";

const dbToLin = (db: number) => 10 ** (db / 20);

const synthesizeVoicedFricativeTake = ({
  sampleRate,
  durationSec,
  bodyRmsDb,
  consonantPeakDb,
  consonantCentersSec,
}: {
  sampleRate: number;
  durationSec: number;
  bodyRmsDb: number;
  consonantPeakDb: number;
  consonantCentersSec: readonly number[];
}) => {
  const samples = new Float32Array(Math.round(sampleRate * durationSec));
  const bodyMixRms = Math.sqrt((0.82 ** 2 + 0.18 ** 2) / 2);
  const bodyScale = dbToLin(bodyRmsDb) / bodyMixRms;
  for (let index = 0; index < samples.length; index += 1) {
    const timeSec = index / sampleRate;
    samples[index] = bodyScale * (
      0.82 * Math.sin(2 * Math.PI * 220 * timeSec)
      + 0.18 * Math.sin(2 * Math.PI * 510 * timeSec)
    );
  }

  const halfBurstSamples = Math.max(1, Math.round(sampleRate * 0.008));
  for (const centerSec of consonantCentersSec) {
    const targetPeak = dbToLin(consonantPeakDb);
    const centerSample = Math.round(centerSec * sampleRate);
    const start = Math.max(0, centerSample - halfBurstSamples);
    const end = Math.min(samples.length, centerSample + halfBurstSamples);
    const burst = new Float32Array(end - start);
    let burstPeak = 0;
    for (let offset = 0; offset < burst.length; offset += 1) {
      const timeSec = (start + offset) / sampleRate;
      const value = (
        0.22 * Math.sin(2 * Math.PI * 220 * timeSec)
        + 0.72 * Math.sin(2 * Math.PI * 5600 * timeSec)
        + 0.28 * Math.sin(2 * Math.PI * 6800 * timeSec)
      );
      burst[offset] = value;
      burstPeak = Math.max(burstPeak, Math.abs(value));
    }
    const scale = targetPeak / Math.max(1e-9, burstPeak);
    for (let offset = 0; offset < burst.length; offset += 1) {
      samples[start + offset] = burst[offset] * scale;
    }
  }
  return samples;
};

const synthesizeHighBandNativeEvent = ({
  sampleRate,
  durationSec,
  centerSec,
  eventFrequencyHz,
}: {
  sampleRate: number;
  durationSec: number;
  centerSec: number;
  eventFrequencyHz: number;
}) => {
  const samples = synthesizeVoicedFricativeTake({
    sampleRate,
    durationSec,
    bodyRmsDb: -24,
    consonantPeakDb: -4,
    consonantCentersSec: [],
  });
  const radius = Math.max(1, Math.round(sampleRate * 0.008));
  const center = Math.round(sampleRate * centerSec);
  const start = Math.max(0, center - radius);
  const end = Math.min(samples.length, center + radius);
  let burstPeak = 0;
  const burst = new Float32Array(end - start);
  for (let index = start; index < end; index += 1) {
    const distance = Math.abs(index - center) / Math.max(1, radius);
    const taper = Math.cos((distance * Math.PI) / 2) ** 2;
    const value = Math.sin((2 * Math.PI * eventFrequencyHz * index) / sampleRate) * taper;
    burst[index - start] = value;
    burstPeak = Math.max(burstPeak, Math.abs(value));
  }
  const scale = dbToLin(-4) / Math.max(1e-9, burstPeak);
  for (let index = start; index < end; index += 1) {
    samples[index] = burst[index - start] * scale;
  }
  return samples;
};

const peakDbNear = (
  samples: Float32Array,
  sampleRate: number,
  centerSec: number,
  halfWindowMs = 14,
) => {
  const center = Math.round(centerSec * sampleRate);
  const radius = Math.max(1, Math.round((sampleRate * halfWindowMs) / 1000));
  let peak = 0;
  for (let index = Math.max(0, center - radius); index < Math.min(samples.length, center + radius); index += 1) {
    peak = Math.max(peak, Math.abs(samples[index]));
  }
  return peak > 0 ? 20 * Math.log10(peak) : -120;
};

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

const makeCanonicalBlob = (samples: Float32Array, sampleRate: number) =>
  new Blob([bytesAsBlobPart(encodeWavFloat32(samples, sampleRate, 1))], { type: "audio/wav" });

const synthesizeAdjacentWeakStrongLaneTake = (eventPeakDb: readonly [number, number]) => {
  const sampleRate = 48_000;
  const durationSec = 0.4;
  const centersSec = [0.099, 0.101] as const;
  const eventRadiusSamples = Math.round(0.0004 * sampleRate);
  const samples = new Float32Array(Math.round(sampleRate * durationSec));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = dbToLin(-20.2)
      * Math.sin((2 * Math.PI * 220 * index) / sampleRate)
      * Math.SQRT2;
  }
  for (const [eventIndex, centerSec] of centersSec.entries()) {
    const centerSample = Math.round(centerSec * sampleRate);
    for (
      let index = centerSample - eventRadiusSamples;
      index <= centerSample + eventRadiusSamples;
      index += 1
    ) {
      const normalizedOffset = (index - centerSample) / eventRadiusSamples;
      const envelope = Math.cos((normalizedOffset * Math.PI) / 2) ** 2;
      samples[index] = dbToLin(eventPeakDb[eventIndex] ?? -120)
        * Math.sin((2 * Math.PI * 6000 * index) / sampleRate)
        * envelope;
    }
  }
  return { samples, sampleRate, centersSec, eventRadiusSamples };
};

const synthesizeFractionalBoundaryLaneTake = (
  eventPeakDb: readonly [number, number | null],
) => {
  const sampleRate = 44_100;
  const samples = new Float32Array(Math.round(sampleRate * 0.4));
  const centers = [4454, 4498] as const;
  const eventRadiusSamples = Math.round(0.0004 * sampleRate);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = dbToLin(-20.2)
      * Math.sin((2 * Math.PI * 220 * index) / sampleRate)
      * Math.SQRT2;
  }
  for (const [eventIndex, centerSample] of centers.entries()) {
    const peakDb = eventPeakDb[eventIndex];
    if (peakDb === null) continue;
    for (
      let index = centerSample - eventRadiusSamples;
      index <= centerSample + eventRadiusSamples;
      index += 1
    ) {
      const normalizedOffset = (index - centerSample) / eventRadiusSamples;
      const envelope = Math.cos((normalizedOffset * Math.PI) / 2) ** 2;
      samples[index] = dbToLin(peakDb)
        * Math.sin((2 * Math.PI * 6000 * index) / sampleRate)
        * envelope;
    }
  }
  return { samples, sampleRate };
};

const synthesizeBoundaryVerdictDivergenceTake = (
  eventPeakDb: number,
  acceptedSide: "before" | "after" = "before",
) => {
  const sampleRate = 16_000;
  const durationSec = acceptedSide === "before" ? 61 : 62;
  const boundarySec = 60;
  const samples = new Float32Array(sampleRate * durationSec);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = dbToLin(-20.2)
      * Math.sin((2 * Math.PI * 220 * index) / sampleRate)
      * Math.SQRT2;
  }

  const uniqueCentersSec = acceptedSide === "before"
    ? [
        1.013, 2.731, 4.927, 7.441, 10.357,
        13.889, 17.123, 20.741, 24.389, 27.911,
        31.667, 35.291, 39.113, 42.781, 46.627,
        50.219, 53.843, 56.497, 58.091, 59.101,
      ]
    : [
        60.713, 60.761, 60.827, 60.899, 60.947,
        61.019, 61.087, 61.151, 61.217, 61.289,
        61.337, 61.411, 61.477, 61.549, 61.613,
        61.681, 61.747, 61.819, 61.883, 61.947,
      ];
  const periodicStartMs = acceptedSide === "before" ? 59_520 : 59_460;
  const periodicCenterCount = acceptedSide === "before" ? 50 : 35;
  const periodicCentersSec = Array.from(
    { length: periodicCenterCount },
    (_unused, index) => (periodicStartMs + index * 30) / 1000,
  );
  const eventRadiusSamples = Math.max(1, Math.round(sampleRate * 0.0008));
  const targetPeak = dbToLin(eventPeakDb);
  for (const centerSec of [...uniqueCentersSec, ...periodicCentersSec]) {
    const centerSample = Math.round(centerSec * sampleRate);
    const start = Math.max(0, centerSample - eventRadiusSamples);
    const end = Math.min(samples.length, centerSample + eventRadiusSamples + 1);
    const burst = new Float32Array(end - start);
    let burstPeak = 0;
    for (let index = start; index < end; index += 1) {
      const normalizedOffset = (index - centerSample) / eventRadiusSamples;
      const envelope = Math.cos((normalizedOffset * Math.PI) / 2) ** 2;
      const value = Math.sin(
        (2 * Math.PI * 6000 * index) / sampleRate + 0.41,
      ) * envelope;
      burst[index - start] = value;
      burstPeak = Math.max(burstPeak, Math.abs(value));
    }
    const scale = targetPeak / Math.max(1e-9, burstPeak);
    for (let index = start; index < end; index += 1) {
      samples[index] = (burst[index - start] ?? 0) * scale;
    }
  }

  return {
    samples,
    sampleRate,
    boundarySample: boundarySec * sampleRate,
  };
};

const synthesizeAcceptedBoundaryLagDivergenceTake = (
  eventPeakDb: number,
  rendered: boolean,
) => {
  const sampleRate = 16_000;
  const durationSec = 62;
  const boundarySample = 60 * sampleRate;
  const samples = new Float32Array(sampleRate * durationSec);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = dbToLin(-20.2)
      * Math.sin((2 * Math.PI * 220 * index) / sampleRate)
      * Math.SQRT2;
  }

  const firstSourceCentersSec = [
    1.013, 2.731, 4.927, 7.441, 10.357,
    13.889, 17.123, 20.741, 24.389, 27.911,
    31.667, 35.291, 39.113, 42.781, 46.627,
    50.219, 53.843, 56.497, 58.091,
  ];
  const secondSourceCentersSec = [
    60.713, 60.761, 60.827, 60.899, 60.947,
    61.019, 61.087, 61.151, 61.217, 61.289,
    61.337, 61.411, 61.477, 61.549, 61.613,
    61.681, 61.747, 61.819, 61.883, 61.947,
  ];
  const centersSec = rendered
    ? [
        ...firstSourceCentersSec.map((center) => center + 0.01),
        60,
        ...secondSourceCentersSec.map((center) => center + 0.04),
      ]
    : [...firstSourceCentersSec, 59.99, ...secondSourceCentersSec];
  const eventRadiusSamples = Math.max(1, Math.round(sampleRate * 0.0008));
  const targetPeak = dbToLin(eventPeakDb);
  for (const centerSec of centersSec) {
    const centerSample = Math.round(centerSec * sampleRate);
    const start = Math.max(0, centerSample - eventRadiusSamples);
    const end = Math.min(samples.length, centerSample + eventRadiusSamples + 1);
    const burst = new Float32Array(end - start);
    let burstPeak = 0;
    for (let index = start; index < end; index += 1) {
      const normalizedOffset = (index - centerSample) / eventRadiusSamples;
      const envelope = Math.cos((normalizedOffset * Math.PI) / 2) ** 2;
      const value = Math.sin(
        (2 * Math.PI * 6000 * index) / sampleRate + 0.41,
      ) * envelope;
      burst[index - start] = value;
      burstPeak = Math.max(burstPeak, Math.abs(value));
    }
    const scale = targetPeak / Math.max(1e-9, burstPeak);
    for (let index = start; index < end; index += 1) {
      samples[index] = (burst[index - start] ?? 0) * scale;
    }
  }

  return { samples, sampleRate, boundarySample };
};

const maxSampleReductionDb = (
  before: Float32Array,
  after: Float32Array,
  startSample: number,
  endSampleInclusive: number,
) => {
  let maxReductionDb = 0;
  let nonzeroSampleCount = 0;
  let samplesOverWeakCap = 0;
  for (let index = startSample; index <= endSampleInclusive; index += 1) {
    if (Math.abs(before[index] ?? 0) <= 1e-8) continue;
    nonzeroSampleCount += 1;
    const reductionDb = 20 * Math.log10(
      Math.abs(before[index]) / Math.max(Math.abs(after[index]), 1e-12),
    );
    maxReductionDb = Math.max(maxReductionDb, reductionDb);
    if (reductionDb > 1.251) samplesOverWeakCap += 1;
  }
  return { maxReductionDb, nonzeroSampleCount, samplesOverWeakCap };
};

const FFMPEG_EXTENSIBLE_DATA_HEADER_OFFSET = 106;
const FFMPEG_EXTENSIBLE_DATA_OFFSET = 114;
const IEEE_FLOAT_SUBFORMAT_GUID = new Uint8Array([
  0x03, 0x00, 0x00, 0x00,
  0x00, 0x00,
  0x10, 0x00,
  0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
]);

const encodeFfmpegExtensibleFloat32Wav = (
  samples: Float32Array,
  sampleRate: number,
  suffixPayload = new Uint8Array(0),
) => {
  const suffixChunkLength = suffixPayload.length > 0
    ? 8 + suffixPayload.length + (suffixPayload.length % 2)
    : 0;
  const dataLength = samples.length * 4;
  const bytes = new Uint8Array(FFMPEG_EXTENSIBLE_DATA_OFFSET + dataLength + suffixChunkLength);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 40, true);
  view.setUint16(20, 0xfffe, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  view.setUint16(36, 22, true);
  view.setUint16(38, 32, true);
  view.setUint32(40, 0x04, true);
  bytes.set(IEEE_FLOAT_SUBFORMAT_GUID, 44);
  writeAscii(60, "fact");
  view.setUint32(64, 4, true);
  view.setUint32(68, samples.length, true);
  writeAscii(72, "LIST");
  view.setUint32(76, 26, true);
  writeAscii(80, "INFO");
  writeAscii(84, "ISFT");
  view.setUint32(88, 13, true);
  writeAscii(92, "Lavf61.7.100");
  writeAscii(FFMPEG_EXTENSIBLE_DATA_HEADER_OFFSET, "data");
  view.setUint32(FFMPEG_EXTENSIBLE_DATA_HEADER_OFFSET + 4, dataLength, true);
  for (let index = 0; index < samples.length; index += 1) {
    view.setFloat32(FFMPEG_EXTENSIBLE_DATA_OFFSET + index * 4, samples[index], true);
  }
  if (suffixPayload.length > 0) {
    const suffixOffset = FFMPEG_EXTENSIBLE_DATA_OFFSET + dataLength;
    writeAscii(suffixOffset, "JUNK");
    view.setUint32(suffixOffset + 4, suffixPayload.length, true);
    bytes.set(suffixPayload, suffixOffset + 8);
  }
  return bytes;
};

class TrackingBlob extends Blob {
  readonly readSizes: number[];
  directArrayBufferCalls = 0;

  constructor(parts: BlobPart[], options?: BlobPropertyBag, readSizes: number[] = []) {
    super(parts, options);
    this.readSizes = readSizes;
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    this.directArrayBufferCalls += 1;
    return super.arrayBuffer();
  }

  override slice(start?: number, end?: number, contentType?: string): Blob {
    const nativeSlice = super.slice(start, end, contentType);
    const readSizes = this.readSizes;
    const originalArrayBuffer = nativeSlice.arrayBuffer.bind(nativeSlice);
    Object.defineProperty(nativeSlice, "arrayBuffer", {
      configurable: true,
      value: async () => {
        readSizes.push(nativeSlice.size);
        return originalArrayBuffer();
      },
    });
    return nativeSlice;
  }
}

describe("chunked mono float WAV consonant tamer", () => {
  it("accepts 44.1 kHz WAVs that end exactly on a rounded-up evidence boundary", async () => {
    for (const [sampleCount, expectedFrameCount] of [
      [265, 3],
      [62_005, 703],
    ] as const) {
      const sampleRate = 44_100;
      const samples = new Float32Array(sampleCount);
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = dbToLin(-24)
          * Math.sin((2 * Math.PI * 220 * index) / sampleRate)
          * Math.SQRT2;
      }
      const reference = buildRenderedConsonantReference(samples, sampleRate);
      assert.ok(reference);
      assert.equal(reference.rmsDb.length, expectedFrameCount);
      const input = makeCanonicalBlob(samples, sampleRate);

      const result = await tameCanonicalMonoFloat32WavBlobInChunks(input, reference, {
        coreChunkDurationSec: 0.2,
        contextDurationMs: 500,
      });

      assert.equal(result.blob, input);
    }
  });

  it("keeps adjacent weak and strong owner budgets sample-bounded with whole-file parity", async () => {
    const source = synthesizeAdjacentWeakStrongLaneTake([-10.4, -4]);
    const rendered = synthesizeAdjacentWeakStrongLaneTake([-3.9, 2]);
    const reference = buildRenderedConsonantReference(source.samples, source.sampleRate);
    assert.ok(reference);
    const direct = tameRenderedConsonantPeaks(
      rendered.samples,
      rendered.sampleRate,
      reference.frameMs,
      { reference, maxReductionDb: 2.5 },
    );
    const chunked = await tameCanonicalMonoFloat32WavBlobInChunks(
      makeCanonicalBlob(rendered.samples, rendered.sampleRate),
      reference,
      { coreChunkDurationSec: 0.2, contextDurationMs: 500, maxReductionDb: 2.5 },
    );
    const decoded = decodeWav(await chunked.blob.arrayBuffer());

    assert.deepEqual(decoded.samples, direct.samples);
    const weakCenterSample = Math.round(rendered.centersSec[0] * rendered.sampleRate);
    const strongCenterSample = Math.round(rendered.centersSec[1] * rendered.sampleRate);
    const weak = maxSampleReductionDb(
      rendered.samples,
      decoded.samples,
      weakCenterSample - rendered.eventRadiusSamples,
      weakCenterSample + rendered.eventRadiusSamples,
    );
    const strong = maxSampleReductionDb(
      rendered.samples,
      decoded.samples,
      strongCenterSample - rendered.eventRadiusSamples,
      strongCenterSample + rendered.eventRadiusSamples,
    );
    const samplesPerEvidenceFrame = Math.round((rendered.sampleRate * reference.frameMs) / 1000);
    const nativeOwnerFrame = Math.floor(weakCenterSample / samplesPerEvidenceFrame) - 1;
    const native = maxSampleReductionDb(
      rendered.samples,
      decoded.samples,
      nativeOwnerFrame * samplesPerEvidenceFrame,
      (nativeOwnerFrame + 1) * samplesPerEvidenceFrame - 1,
    );

    assert.equal(weak.nonzeroSampleCount, 28);
    assert.equal(weak.samplesOverWeakCap, 0);
    assert.ok(weak.maxReductionDb <= 1.251);
    assert.ok(strong.maxReductionDb > 0.05 && strong.maxReductionDb <= 1.251);
    assert.ok(native.maxReductionDb <= 0.001);
  });

  it("keeps rounded 44.1 kHz weak and native owners bounded with whole-file parity", async () => {
    for (const lane of ["weak", "native"] as const) {
      const source = synthesizeFractionalBoundaryLaneTake(
        lane === "weak" ? [-4, -10.4] : [-4, null],
      );
      const rendered = synthesizeFractionalBoundaryLaneTake(
        lane === "weak" ? [2, -3.9] : [2, null],
      );
      const reference = buildRenderedConsonantReference(source.samples, source.sampleRate);
      assert.ok(reference);
      const direct = tameRenderedConsonantPeaks(
        rendered.samples,
        rendered.sampleRate,
        reference.frameMs,
        { reference, maxReductionDb: 2.5 },
      );
      const chunked = await tameCanonicalMonoFloat32WavBlobInChunks(
        makeCanonicalBlob(rendered.samples, rendered.sampleRate),
        reference,
        { coreChunkDurationSec: 0.2, contextDurationMs: 500, maxReductionDb: 2.5 },
      );
      const decoded = decodeWav(await chunked.blob.arrayBuffer());
      assert.deepEqual(decoded.samples, direct.samples);

      const samplesPerEvidenceFrame = (rendered.sampleRate * reference.frameMs) / 1000;
      const ownerFrameStart = Math.round(51 * samplesPerEvidenceFrame);
      const ownerFrameEnd = Math.round(52 * samplesPerEvidenceFrame) - 1;
      const measuredOwner = maxSampleReductionDb(
        rendered.samples,
        decoded.samples,
        ownerFrameStart,
        ownerFrameEnd,
      );
      if (lane === "weak") {
        assert.equal(measuredOwner.samplesOverWeakCap, 0);
        assert.ok(measuredOwner.maxReductionDb <= 1.251);
      } else {
        assert.ok(measuredOwner.maxReductionDb <= 0.001);
        assert.deepEqual(
          decoded.samples.slice(ownerFrameStart, ownerFrameEnd + 1),
          rendered.samples.slice(ownerFrameStart, ownerFrameEnd + 1),
        );
      }
    }
  });

  it("smoothly returns an accepted chunk to the original at a rejected-chunk boundary", async () => {
    const source = synthesizeBoundaryVerdictDivergenceTake(-10.4);
    const rendered = synthesizeBoundaryVerdictDivergenceTake(-3.9);
    const reference = buildRenderedConsonantReference(source.samples, source.sampleRate);
    assert.ok(reference);
    const input = makeCanonicalBlob(rendered.samples, rendered.sampleRate);

    const result = await tameCanonicalMonoFloat32WavBlobInChunks(input, reference);
    const decoded = decodeWav(await result.blob.arrayBuffer());
    const finalAcceptedSample = source.boundarySample - 1;
    const finalAcceptedReductionDb = 20 * Math.log10(
      Math.abs(rendered.samples[finalAcceptedSample] ?? 0)
        / Math.max(Math.abs(decoded.samples[finalAcceptedSample] ?? 0), 1e-12),
    );
    let retainedTaperReductionDb = 0;
    let maximumAdjacentReductionStepDb = 0;
    let previousReductionDb: number | null = null;
    const taperWindowSamples = Math.round(source.sampleRate * 0.002);
    for (
      let index = source.boundarySample - taperWindowSamples;
      index <= source.boundarySample;
      index += 1
    ) {
      const before = Math.abs(rendered.samples[index] ?? 0);
      const after = Math.abs(decoded.samples[index] ?? 0);
      if (before <= 1e-6 || after <= 1e-12) continue;
      const reductionDb = 20 * Math.log10(before / after);
      retainedTaperReductionDb = Math.max(retainedTaperReductionDb, reductionDb);
      if (previousReductionDb !== null) {
        maximumAdjacentReductionStepDb = Math.max(
          maximumAdjacentReductionStepDb,
          Math.abs(reductionDb - previousReductionDb),
        );
      }
      previousReductionDb = reductionDb;
    }

    assert.equal(result.stats.processedChunkCount, 2);
    assert.equal(result.stats.referenceUsedChunkCount, 1);
    assert.equal(result.stats.referenceRejectedChunkCount, 1);
    assert.ok(
      retainedTaperReductionDb > 0.005,
      `the accepted chunk should retain a nonzero attenuation taper, got ${retainedTaperReductionDb.toFixed(4)} dB`,
    );
    assert.ok(
      maximumAdjacentReductionStepDb <= 0.15,
      `boundary attenuation must change smoothly, got a ${maximumAdjacentReductionStepDb.toFixed(3)} dB sample step`,
    );
    assert.ok(
      finalAcceptedReductionDb <= 0.001,
      `accepted-side attenuation must reach zero at the seam, got ${finalAcceptedReductionDb.toFixed(3)} dB`,
    );
    assert.deepEqual(
      decoded.samples.slice(source.boundarySample),
      rendered.samples.slice(source.boundarySample),
      "the rejected chunk must remain sample-identical to the input",
    );
    assert.ok(result.stats.maxReductionDb <= 1.251);
    assert.equal(decoded.samples.length, rendered.samples.length);
    assert.equal(result.blob.size, input.size);
  });

  it("smoothly leaves the original for an accepted chunk after a rejected chunk", async () => {
    const source = synthesizeBoundaryVerdictDivergenceTake(-10.4, "after");
    const rendered = synthesizeBoundaryVerdictDivergenceTake(-3.9, "after");
    const reference = buildRenderedConsonantReference(source.samples, source.sampleRate);
    assert.ok(reference);
    const input = makeCanonicalBlob(rendered.samples, rendered.sampleRate);

    const result = await tameCanonicalMonoFloat32WavBlobInChunks(input, reference);
    const decoded = decodeWav(await result.blob.arrayBuffer());
    const firstAcceptedReductionDb = 20 * Math.log10(
      Math.abs(rendered.samples[source.boundarySample] ?? 0)
        / Math.max(Math.abs(decoded.samples[source.boundarySample] ?? 0), 1e-12),
    );
    let retainedTaperReductionDb = 0;
    let maximumAdjacentReductionStepDb = 0;
    let previousReductionDb: number | null = null;
    const taperWindowSamples = Math.round(source.sampleRate * 0.002);
    for (
      let index = source.boundarySample - 1;
      index <= source.boundarySample + taperWindowSamples;
      index += 1
    ) {
      const before = Math.abs(rendered.samples[index] ?? 0);
      const after = Math.abs(decoded.samples[index] ?? 0);
      if (before <= 1e-6 || after <= 1e-12) continue;
      const reductionDb = 20 * Math.log10(before / after);
      retainedTaperReductionDb = Math.max(retainedTaperReductionDb, reductionDb);
      if (previousReductionDb !== null) {
        maximumAdjacentReductionStepDb = Math.max(
          maximumAdjacentReductionStepDb,
          Math.abs(reductionDb - previousReductionDb),
        );
      }
      previousReductionDb = reductionDb;
    }

    assert.equal(result.stats.processedChunkCount, 2);
    assert.equal(result.stats.referenceUsedChunkCount, 1);
    assert.equal(result.stats.referenceRejectedChunkCount, 1);
    assert.deepEqual(
      decoded.samples.slice(0, source.boundarySample),
      rendered.samples.slice(0, source.boundarySample),
      "the preceding rejected chunk must remain sample-identical to the input",
    );
    assert.ok(
      firstAcceptedReductionDb <= 0.001,
      `accepted-side attenuation must start at zero, got ${firstAcceptedReductionDb.toFixed(3)} dB`,
    );
    assert.ok(
      retainedTaperReductionDb > 0.005,
      `the accepted chunk should ease into nonzero authorized attenuation, got ${retainedTaperReductionDb.toFixed(4)} dB`,
    );
    assert.ok(
      maximumAdjacentReductionStepDb <= 0.15,
      `boundary attenuation must change smoothly, got a ${maximumAdjacentReductionStepDb.toFixed(3)} dB sample step`,
    );
    assert.ok(result.stats.maxReductionDb <= 1.251);
    assert.equal(decoded.samples.length, rendered.samples.length);
    assert.equal(result.blob.size, input.size);
  });

  it("reconciles differing accepted-chunk lags without a one-sample attenuation seam", async () => {
    const source = synthesizeAcceptedBoundaryLagDivergenceTake(-10.4, false);
    const rendered = synthesizeAcceptedBoundaryLagDivergenceTake(-3.9, true);
    const reference = buildRenderedConsonantReference(source.samples, source.sampleRate);
    assert.ok(reference);
    const input = makeCanonicalBlob(rendered.samples, rendered.sampleRate);

    const result = await tameCanonicalMonoFloat32WavBlobInChunks(input, reference);
    const decoded = decodeWav(await result.blob.arrayBuffer());
    const taperWindowSamples = Math.round(source.sampleRate * 0.002);
    let previousReductionDb: number | null = null;
    let maximumAdjacentReductionStepDb = 0;
    for (
      let index = source.boundarySample - taperWindowSamples;
      index <= source.boundarySample + taperWindowSamples;
      index += 1
    ) {
      const before = Math.abs(rendered.samples[index] ?? 0);
      const after = Math.abs(decoded.samples[index] ?? 0);
      assert.ok(after <= before + 1e-7, "seam reconciliation must never amplify above the render");
      if (before <= 1e-6 || after <= 1e-12) continue;
      const reductionDb = 20 * Math.log10(before / after);
      if (previousReductionDb !== null) {
        maximumAdjacentReductionStepDb = Math.max(
          maximumAdjacentReductionStepDb,
          Math.abs(reductionDb - previousReductionDb),
        );
      }
      previousReductionDb = reductionDb;
    }

    assert.equal(result.stats.processedChunkCount, 2);
    assert.equal(result.stats.referenceUsedChunkCount, 2);
    assert.equal(result.stats.referenceRejectedChunkCount, 0);
    assert.ok(result.stats.referenceLagMs >= 20 && result.stats.referenceLagMs <= 30);
    assert.ok(
      maximumAdjacentReductionStepDb <= 0.15,
      `accepted-chunk attenuation must remain smooth, got a ${maximumAdjacentReductionStepDb.toFixed(3)} dB sample step`,
    );
    assert.ok(result.stats.maxReductionDb <= 1.251);
    assert.equal(decoded.samples.length, rendered.samples.length);
    assert.equal(result.blob.size, input.size);
  });

  it("accepts FFmpeg extensible float WAV and preserves its exact prefix and legal suffix", async () => {
    const sampleRate = 48_000;
    const durationSec = 2.4;
    const consonantCentersSec = [0.06, 1.2, durationSec - 0.06];
    const referenceSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -20.2,
      consonantPeakDb: -4,
      consonantCentersSec,
    });
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: -4,
      consonantCentersSec,
    });
    const reference = buildRenderedConsonantReference(referenceSamples, sampleRate);
    assert.ok(reference);
    const suffixPayload = new Uint8Array([0x46, 0x46, 0x6d, 0x70]);
    const inputBytes = encodeFfmpegExtensibleFloat32Wav(
      renderedSamples,
      sampleRate,
      suffixPayload,
    );
    const input = new Blob([bytesAsBlobPart(inputBytes)], { type: "audio/wav" });

    const result = await tameCanonicalMonoFloat32WavBlobInChunks(input, reference, {
      coreChunkDurationSec: 1,
    });

    assert.notEqual(result.blob, input);
    assert.equal(result.blob.size, input.size);
    const outputBytes = new Uint8Array(await result.blob.arrayBuffer());
    assert.deepEqual(
      outputBytes.subarray(0, FFMPEG_EXTENSIBLE_DATA_OFFSET),
      inputBytes.subarray(0, FFMPEG_EXTENSIBLE_DATA_OFFSET),
      "fmt/fact/LIST/data prefix must remain byte-identical",
    );
    const dataEnd = FFMPEG_EXTENSIBLE_DATA_OFFSET + renderedSamples.length * 4;
    assert.deepEqual(
      outputBytes.subarray(dataEnd),
      inputBytes.subarray(dataEnd),
      "legal chunks after data must remain byte-identical",
    );
    const decoded = decodeWav(outputBytes);
    for (const centerSec of consonantCentersSec) {
      const reductionDb = peakDbNear(renderedSamples, sampleRate, centerSec)
        - peakDbNear(decoded.samples, sampleRate, centerSec);
      assert.ok(
        reductionDb >= 0.35 && reductionDb <= 1.5 + 1e-3,
        `event at ${centerSec.toFixed(2)} s should be subtly reduced, got ${reductionDb.toFixed(3)} dB`,
      );
    }
  });

  it("returns an unchanged FFmpeg extensible WAV by identity with bounded reads", async () => {
    const sampleRate = 48_000;
    const durationSec = 3;
    const samples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: -4,
      consonantCentersSec: [0.06, 1.5, durationSec - 0.06],
    });
    const reference = buildRenderedConsonantReference(samples, sampleRate);
    assert.ok(reference);
    const encoded = encodeFfmpegExtensibleFloat32Wav(
      samples,
      sampleRate,
      new Uint8Array([1, 2, 3, 4]),
    );
    const input = new TrackingBlob([bytesAsBlobPart(encoded)], { type: "audio/wav" });

    const result = await tameCanonicalMonoFloat32WavBlobInChunks(input, reference, {
      coreChunkDurationSec: 0.6,
      contextDurationMs: 500,
    });

    assert.equal(result.blob, input);
    assert.equal(input.directArrayBufferCalls, 0);
    assert.ok(input.readSizes.every((size) => size < input.size));
    assert.ok(Math.max(...input.readSizes) <= Math.round(1.6 * sampleRate * 4));
  });

  it("uses the planner's compact 16 kHz reference against a 48 kHz final WAV", async () => {
    const outputSampleRate = 48_000;
    const plannerSampleRate = 16_000;
    const durationSec = 2.4;
    const consonantCentersSec = [0.06, 1.2, durationSec - 0.06];
    const referenceSamples = synthesizeVoicedFricativeTake({
      sampleRate: plannerSampleRate,
      durationSec,
      bodyRmsDb: -20.2,
      consonantPeakDb: -4,
      consonantCentersSec,
    });
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate: outputSampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: -4,
      consonantCentersSec,
    });
    const plannerReference = buildRenderedConsonantReference(
      referenceSamples,
      plannerSampleRate,
    );
    assert.ok(plannerReference);
    const input = makeCanonicalBlob(renderedSamples, outputSampleRate);

    const result = await tameCanonicalMonoFloat32WavBlobInChunks(
      input,
      plannerReference,
      { coreChunkDurationSec: 1 },
    );
    const decoded = decodeWav(await result.blob.arrayBuffer());

    assert.equal(decoded.sampleRate, outputSampleRate);
    assert.equal(decoded.samples.length, renderedSamples.length);
    assert.ok(result.stats.tamedFrameCount >= consonantCentersSec.length);
    for (const centerSec of consonantCentersSec) {
      const reductionDb = peakDbNear(renderedSamples, outputSampleRate, centerSec)
        - peakDbNear(decoded.samples, outputSampleRate, centerSec);
      assert.ok(
        reductionDb >= 0.35,
        `16 kHz source evidence should repair ${centerSec.toFixed(2)} s, got ${reductionDb.toFixed(3)} dB`,
      );
      assert.ok(reductionDb <= 1.5 + 1e-3, `repair at ${centerSec.toFixed(2)} s exceeded the cap`);
    }
  });

  it("preserves native consonants when the compact source reference is 16 kHz", async () => {
    const outputSampleRate = 48_000;
    const plannerSampleRate = 16_000;
    const durationSec = 2.4;
    const consonantCentersSec = [0.06, 1.2, durationSec - 0.06];
    const referenceSamples = synthesizeVoicedFricativeTake({
      sampleRate: plannerSampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: -4,
      consonantCentersSec,
    });
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate: outputSampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: -4,
      consonantCentersSec,
    });
    const plannerReference = buildRenderedConsonantReference(
      referenceSamples,
      plannerSampleRate,
    );
    assert.ok(plannerReference);
    const input = makeCanonicalBlob(renderedSamples, outputSampleRate);

    const result = await tameCanonicalMonoFloat32WavBlobInChunks(
      input,
      plannerReference,
      { coreChunkDurationSec: 1 },
    );

    assert.equal(result.blob, input, "matching native articulation must keep the original Blob by identity");
    assert.equal(result.stats.tamedFrameCount, 0);
    assert.equal(result.stats.maxReductionDb, 0);
  });

  it("subtly repairs start, middle, end, and cross-boundary events without changing length", async () => {
    const sampleRate = 48_000;
    const durationSec = 3;
    const consonantCentersSec = [0.04, 1, 1.5, 2, durationSec - 0.04];
    const referenceSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -20.2,
      consonantPeakDb: -4,
      consonantCentersSec,
    });
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: -4,
      consonantCentersSec,
    });
    const reference = buildRenderedConsonantReference(referenceSamples, sampleRate);
    assert.ok(reference);
    const input = makeCanonicalBlob(renderedSamples, sampleRate);

    const result = await tameCanonicalMonoFloat32WavBlobInChunks(input, reference, {
      coreChunkDurationSec: 1,
      contextDurationMs: 500,
    });

    assert.notEqual(result.blob, input);
    assert.equal(result.blob.size, input.size, "canonical float WAV byte length must stay exact");
    assert.ok(result.stats.processedChunkCount === 3);
    assert.ok(result.stats.changedSpanCount >= consonantCentersSec.length);
    assert.ok(result.stats.tamedFrameCount >= consonantCentersSec.length);
    assert.ok(result.stats.maxReductionDb >= 0.35 && result.stats.maxReductionDb <= 1.5 + 1e-4);

    const decoded = decodeWav(await result.blob.arrayBuffer());
    assert.equal(decoded.channels, 1);
    assert.equal(decoded.sampleRate, sampleRate);
    assert.equal(decoded.samples.length, renderedSamples.length, "sample count and duration must be preserved");
    const wholeFileResult = tameRenderedConsonantPeaks(renderedSamples, sampleRate, reference.frameMs, {
      reference,
    });
    assert.deepEqual(
      decoded.samples,
      wholeFileResult.samples,
      "500 ms context should make chunk seams sample-identical to the existing whole-file tamer",
    );
    for (const centerSec of consonantCentersSec) {
      const reductionDb = peakDbNear(renderedSamples, sampleRate, centerSec)
        - peakDbNear(decoded.samples, sampleRate, centerSec);
      assert.ok(
        reductionDb >= 0.35,
        `event at ${centerSec.toFixed(2)} s should be subtly reduced, got ${reductionDb.toFixed(3)} dB`,
      );
      assert.ok(reductionDb <= 1.5 + 1e-3, `event at ${centerSec.toFixed(2)} s exceeded the residual cap`);
    }
  });

  it("returns the original Blob by identity and never reads the complete Blob when no sample changes", async () => {
    const sampleRate = 48_000;
    const durationSec = 3;
    const samples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: -4,
      consonantCentersSec: [0.04, 1, 2, durationSec - 0.04],
    });
    const reference = buildRenderedConsonantReference(samples, sampleRate);
    assert.ok(reference);
    const encoded = encodeWavFloat32(samples, sampleRate, 1);
    const input = new TrackingBlob([bytesAsBlobPart(encoded)], { type: "audio/wav" });

    const result = await tameCanonicalMonoFloat32WavBlobInChunks(input, reference, {
      coreChunkDurationSec: 0.6,
      contextDurationMs: 500,
    });

    assert.equal(result.blob, input);
    assert.equal(result.stats.changedSampleCount, 0);
    assert.equal(result.stats.changedSpanCount, 0);
    assert.equal(input.directArrayBufferCalls, 0, "the helper must never call arrayBuffer on the full input Blob");
    assert.ok(input.readSizes.length > 1, "the header and bounded sample windows should be read separately");
    assert.ok(
      input.readSizes.every((size) => size < input.size),
      `every materialized read must be smaller than the ${input.size}-byte input`,
    );
    const maximumPaddedRead = Math.round((0.6 + 2 * 0.5) * sampleRate * 4);
    assert.ok(
      Math.max(...input.readSizes) <= maximumPaddedRead,
      `largest read should fit one padded core (${maximumPaddedRead} bytes)`,
    );
  });

  it("fails open when a lower-rate compact reference cannot represent a native above-Nyquist event", async () => {
    const renderedSampleRate = 48_000;
    const compactReferenceSampleRate = 16_000;
    const durationSec = 2;
    const renderedSamples = synthesizeHighBandNativeEvent({
      sampleRate: renderedSampleRate,
      durationSec,
      centerSec: 1,
      eventFrequencyHz: 10_000,
    });
    // This is deliberately a realistic low-rate analysis reference, not a
    // hand-edited envelope: its 8 kHz Nyquist limit cannot retain the native
    // 10 kHz event present in the original 48 kHz take.
    const compactReferenceSamples = synthesizeVoicedFricativeTake({
      sampleRate: compactReferenceSampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: -4,
      consonantCentersSec: [],
    });
    const reference = buildRenderedConsonantReference(
      compactReferenceSamples,
      compactReferenceSampleRate,
    );
    assert.ok(reference);
    const input = makeCanonicalBlob(renderedSamples, renderedSampleRate);

    const result = await tameCanonicalMonoFloat32WavBlobInChunks(input, reference, {
      coreChunkDurationSec: 1,
    });

    assert.equal(
      result.blob,
      input,
      "missing above-Nyquist evidence must preserve the native high-band event",
    );
    assert.equal(result.stats.changedSampleCount, 0);
    assert.equal(result.stats.maxReductionDb, 0);
    assert.ok(result.stats.referenceRejectedChunkCount >= 1);
    assert.equal(
      result.stats.referenceUsedChunkCount + result.stats.referenceRejectedChunkCount,
      result.stats.processedChunkCount,
    );
    assert.ok(result.stats.minimumReferenceConfidence <= result.stats.referenceConfidence);
  });

  it("fails open when a sparse event has two equally plausible local lags", async () => {
    const sampleRate = 48_000;
    const durationSec = 1.6;
    const referenceSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: -10,
      consonantCentersSec: [0.7, 0.9],
    });
    const renderedSamples = synthesizeVoicedFricativeTake({
      sampleRate,
      durationSec,
      bodyRmsDb: -24,
      consonantPeakDb: -2,
      consonantCentersSec: [0.8],
    });
    const reference = buildRenderedConsonantReference(referenceSamples, sampleRate);
    assert.ok(reference);
    const input = makeCanonicalBlob(renderedSamples, sampleRate);

    const result = await tameCanonicalMonoFloat32WavBlobInChunks(input, reference);

    assert.equal(
      result.blob,
      input,
      "a sparse ambiguous chunk must not attenuate from a self-selected lag",
    );
    assert.equal(result.stats.changedSampleCount, 0);
    assert.equal(result.stats.maxReductionDb, 0);
    assert.equal(result.stats.referenceUsedChunkCount, 0);
    assert.equal(result.stats.referenceRejectedChunkCount, result.stats.processedChunkCount);
    assert.ok(result.stats.referenceConfidence < 1);
  });

  it("throws for unsupported or corrupt WAV input so callers can fail open", async () => {
    const sampleRate = 48_000;
    const mono = new Float32Array(sampleRate);
    const reference = buildRenderedConsonantReference(mono, sampleRate);
    assert.ok(reference);
    const stereo = new Blob([
      bytesAsBlobPart(encodeWavFloat32(new Float32Array(sampleRate * 2), sampleRate, 2)),
    ]);
    await assert.rejects(
      tameCanonicalMonoFloat32WavBlobInChunks(stereo, reference),
      /mono pcm_f32le/,
    );

    const canonical = encodeWavFloat32(mono, sampleRate, 1);
    const truncated = new Blob([
      bytesAsBlobPart(canonical.subarray(0, canonical.length - 4)),
    ]);
    await assert.rejects(
      tameCanonicalMonoFloat32WavBlobInChunks(truncated, reference),
      /RIFF size does not match/,
    );
  });

  it("rejects unsafe extensible formats, subtype GUIDs, and chunk sizes", async () => {
    const sampleRate = 48_000;
    const samples = new Float32Array(sampleRate);
    const reference = buildRenderedConsonantReference(samples, sampleRate);
    assert.ok(reference);
    const valid = encodeFfmpegExtensibleFloat32Wav(
      samples,
      sampleRate,
      new Uint8Array([1, 2, 3, 4]),
    );
    const mutatedBlob = (mutate: (view: DataView, bytes: Uint8Array) => void) => {
      const bytes = new Uint8Array(valid);
      mutate(new DataView(bytes.buffer), bytes);
      return new Blob([bytesAsBlobPart(bytes)]);
    };

    await assert.rejects(
      tameCanonicalMonoFloat32WavBlobInChunks(
        mutatedBlob((view) => view.setUint16(20, 1, true)),
        reference,
      ),
      /float|format/i,
    );
    await assert.rejects(
      tameCanonicalMonoFloat32WavBlobInChunks(
        mutatedBlob((view) => view.setUint16(22, 2, true)),
        reference,
      ),
      /mono/i,
    );
    await assert.rejects(
      tameCanonicalMonoFloat32WavBlobInChunks(
        mutatedBlob((_view, bytes) => { bytes[44] ^= 0x01; }),
        reference,
      ),
      /subtype|GUID|float/i,
    );
    await assert.rejects(
      tameCanonicalMonoFloat32WavBlobInChunks(
        mutatedBlob((view) => view.setUint32(16, 39, true)),
        reference,
      ),
      /fmt|extensible|chunk/i,
    );
    await assert.rejects(
      tameCanonicalMonoFloat32WavBlobInChunks(
        mutatedBlob((view) => view.setUint32(
          FFMPEG_EXTENSIBLE_DATA_HEADER_OFFSET + 4,
          samples.length * 4 + 8,
          true,
        )),
        reference,
      ),
      /data|chunk|size/i,
    );
    const suffixOffset = FFMPEG_EXTENSIBLE_DATA_OFFSET + samples.length * 4;
    await assert.rejects(
      tameCanonicalMonoFloat32WavBlobInChunks(
        mutatedBlob((view) => view.setUint32(suffixOffset + 4, 0xffff_ffff, true)),
        reference,
      ),
      /suffix|chunk|size/i,
    );
  });
});
