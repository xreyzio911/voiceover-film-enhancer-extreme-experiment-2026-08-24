import { frameDbFromFloatSamples } from "./audibilityDropout.ts";
import { computeSpeechBodyFrameDb } from "./gainPlanner.ts";
import {
  compareVoiceStability,
  type VoiceEnvelopeEvidence,
  type VoiceStabilityReport,
} from "./voiceStabilityMetrics.ts";

export type MonoVoiceEvidenceAudio = Readonly<{
  samples: Float32Array;
  sampleRate: number;
}>;

export type VoiceStabilityObservabilitySnapshot = Readonly<{
  schemaVersion: 1;
  /** This payload is evidence only and must never select, cancel, or reject audio. */
  advisoryOnly: true;
  measurementStatus: "measured" | "unavailable";
  report: VoiceStabilityReport | null;
  notes: readonly string[];
}>;

export const VOICE_STABILITY_RUNTIME_FRAME_MS = 20;
export const VOICE_STABILITY_RUNTIME_REFERENCE_SAMPLE_RATE = 48_000;
export const VOICE_STABILITY_RUNTIME_MAX_SAMPLE_RATE =
  VOICE_STABILITY_RUNTIME_REFERENCE_SAMPLE_RATE;
const VOICE_STABILITY_RUNTIME_MAX_MONO_SAMPLE_BYTES = 96 * 1024 * 1024;
export const VOICE_STABILITY_RUNTIME_MAX_SAMPLE_COUNT =
  VOICE_STABILITY_RUNTIME_MAX_MONO_SAMPLE_BYTES /
  Float32Array.BYTES_PER_ELEMENT;
export const VOICE_STABILITY_RUNTIME_MAX_DURATION_SECONDS =
  VOICE_STABILITY_RUNTIME_MAX_SAMPLE_COUNT /
  VOICE_STABILITY_RUNTIME_MAX_SAMPLE_RATE;

export type VoiceStabilityRuntimeBoundsIssue =
  | "invalid-audio"
  | "duration-limit"
  | "sample-limit"
  | null;

const unavailableSnapshot = (notes: readonly string[]): VoiceStabilityObservabilitySnapshot =>
  Object.freeze({
    schemaVersion: 1,
    advisoryOnly: true,
    measurementStatus: "unavailable",
    report: null,
    notes: Object.freeze([...notes]),
  });

export const sanitizeVoiceStabilitySamples = (samples: Float32Array) => {
  for (let index = 0; index < samples.length; index += 1) {
    if (!Number.isFinite(samples[index])) {
      const sanitizedSamples = new Float32Array(samples.length);
      for (let writeIndex = 0; writeIndex < samples.length; writeIndex += 1) {
        const sample = samples[writeIndex];
        sanitizedSamples[writeIndex] = Number.isFinite(sample) ? sample : 0;
      }
      return {
        samples: sanitizedSamples,
        sanitized: true,
      };
    }
  }
  return { samples, sanitized: false };
};

export const resolveVoiceStabilityRuntimeBoundsIssue = (
  sampleCount: number,
  sampleRate: number,
): VoiceStabilityRuntimeBoundsIssue => {
  if (
    !Number.isFinite(sampleCount) ||
    sampleCount < 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0
  ) {
    return "invalid-audio";
  }
  if (sampleCount > VOICE_STABILITY_RUNTIME_MAX_SAMPLE_COUNT) {
    return "sample-limit";
  }
  if (sampleCount / sampleRate > VOICE_STABILITY_RUNTIME_MAX_DURATION_SECONDS) {
    return "duration-limit";
  }
  return null;
};

const buildFramePeakDb = (
  samples: Float32Array,
  sampleRate: number,
  frameMs: number,
) => {
  const samplesPerFrame = Math.max(1, Math.round((sampleRate * frameMs) / 1_000));
  const frameCount = Math.floor(samples.length / samplesPerFrame);
  const framePeakDb = new Array<number>(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let peak = 0;
    const start = frame * samplesPerFrame;
    const end = start + samplesPerFrame;
    for (let index = start; index < end; index += 1) {
      peak = Math.max(peak, Math.abs(samples[index] ?? 0));
    }
    framePeakDb[frame] = peak > 1e-12 ? 20 * Math.log10(peak) : -240;
  }
  return framePeakDb;
};

const buildEnvelopeEvidence = (
  audio: MonoVoiceEvidenceAudio,
  frameMs: number,
): Readonly<{
  evidence: VoiceEnvelopeEvidence | null;
  sanitized: boolean;
}> => {
  if (
    !(audio.samples instanceof Float32Array) ||
    audio.samples.length === 0 ||
    !Number.isFinite(audio.sampleRate) ||
    audio.sampleRate <= 0
  ) {
    return { evidence: null, sanitized: false };
  }
  const safe = sanitizeVoiceStabilitySamples(audio.samples);
  const frameDb = frameDbFromFloatSamples(safe.samples, audio.sampleRate, frameMs);
  const framePeakDb = buildFramePeakDb(safe.samples, audio.sampleRate, frameMs);
  const speechBodyDb = computeSpeechBodyFrameDb(
    safe.samples,
    audio.sampleRate,
    frameMs,
  );
  const frameCount = Math.min(
    frameDb.length,
    framePeakDb.length,
    speechBodyDb.length,
  );
  if (frameCount < 2) return { evidence: null, sanitized: safe.sanitized };
  return {
    evidence: Object.freeze({
      frameMs,
      frameDb: frameDb.slice(0, frameCount),
      framePeakDb: framePeakDb.slice(0, frameCount),
      speechBodyDb: speechBodyDb.slice(0, frameCount),
    }),
    sanitized: safe.sanitized,
  };
};

export type VoiceStabilityObservabilitySourceSession = Readonly<{
  compare: (
    candidate: MonoVoiceEvidenceAudio | null | undefined,
  ) => VoiceStabilityObservabilitySnapshot;
}>;

/**
 * Prepare the source envelope once for a per-file candidate session. Candidate
 * arrays still receive independent bounded analysis, while the shared source
 * avoids repeating the same envelope and body-filter work for every variant.
 */
export const createVoiceStabilityObservabilitySourceSession = ({
  source,
  frameMs = VOICE_STABILITY_RUNTIME_FRAME_MS,
}: Readonly<{
  source: MonoVoiceEvidenceAudio | null | undefined;
  frameMs?: number;
}>): VoiceStabilityObservabilitySourceSession => {
  const sourceUnavailable = !source
    ? ["Exact paired source and candidate audio were not both available."]
    : !Number.isFinite(frameMs) || frameMs <= 0
      ? ["A finite positive frame duration is required."]
      : (() => {
          const issue = resolveVoiceStabilityRuntimeBoundsIssue(
            source.samples.length,
            source.sampleRate,
          );
          if (!issue) return null;
          const reason =
            issue === "duration-limit"
              ? "duration ceiling"
              : issue === "sample-limit"
                ? "sample-count ceiling"
                : "valid finite sample-rate and sample-count inputs";
          return [
            `Runtime stability observability skipped because paired audio exceeded the ${reason}.`,
          ];
        })();
  const preparedSource =
    sourceUnavailable || !source
      ? null
      : (() => {
          try {
            return buildEnvelopeEvidence(source, frameMs);
          } catch {
            return null;
          }
        })();

  return Object.freeze({
    compare: (
      candidate: MonoVoiceEvidenceAudio | null | undefined,
    ): VoiceStabilityObservabilitySnapshot => {
      if (sourceUnavailable) return unavailableSnapshot(sourceUnavailable);
      if (!source || !candidate) {
        return unavailableSnapshot([
          "Exact paired source and candidate audio were not both available.",
        ]);
      }
      if (!preparedSource?.evidence) {
        return unavailableSnapshot([
          "Paired audio did not contain enough finite analysis frames.",
        ]);
      }
      const candidateBoundsIssue = resolveVoiceStabilityRuntimeBoundsIssue(
        candidate.samples.length,
        candidate.sampleRate,
      );
      if (candidateBoundsIssue) {
        const reason =
          candidateBoundsIssue === "duration-limit"
            ? "duration ceiling"
            : candidateBoundsIssue === "sample-limit"
              ? "sample-count ceiling"
              : "valid finite sample-rate and sample-count inputs";
        return unavailableSnapshot([
          `Runtime stability observability skipped because paired audio exceeded the ${reason}.`,
        ]);
      }

      try {
        const candidateEvidence = buildEnvelopeEvidence(candidate, frameMs);
        if (!candidateEvidence.evidence) {
          return unavailableSnapshot([
            "Paired audio did not contain enough finite analysis frames.",
          ]);
        }
        const notes: string[] = [];
        if (preparedSource.sanitized || candidateEvidence.sanitized) {
          notes.push(
            "Non-finite decoded samples were replaced with silence for advisory measurement only.",
          );
        }
        if (source.sampleRate !== candidate.sampleRate) {
          notes.push(
            `Native sample rates differ (${source.sampleRate} Hz source, ${candidate.sampleRate} Hz candidate); body-balance deltas may include a small filter-rate bias.`,
          );
        }
        if (Math.abs(frameMs - VOICE_STABILITY_RUNTIME_FRAME_MS) > 1e-6) {
          notes.push(
            `${frameMs} ms runtime stability evidence differs from the ${VOICE_STABILITY_RUNTIME_FRAME_MS} ms corpus ledger resolution and is not directly comparable.`,
          );
        }
        return Object.freeze({
          schemaVersion: 1,
          advisoryOnly: true,
          measurementStatus: "measured",
          report: compareVoiceStability(
            preparedSource.evidence,
            candidateEvidence.evidence,
          ),
          notes: Object.freeze(notes),
        });
      } catch {
        return unavailableSnapshot([
          "Source-relative stability measurement could not be completed.",
        ]);
      }
    },
  });
};

/**
 * Build compact source-relative stability evidence from already-decoded exact
 * source/candidate audio. Envelope arrays stay local; only the bounded report
 * is returned. Any unavailable or malformed evidence fails open to an
 * advisory-only status and never changes audio selection or delivery.
 */
export const buildVoiceStabilityObservabilitySnapshot = ({
  source,
  candidate,
  frameMs = VOICE_STABILITY_RUNTIME_FRAME_MS,
}: Readonly<{
  source: MonoVoiceEvidenceAudio | null | undefined;
  candidate: MonoVoiceEvidenceAudio | null | undefined;
  frameMs?: number;
}>): VoiceStabilityObservabilitySnapshot =>
  createVoiceStabilityObservabilitySourceSession({ source, frameMs }).compare(
    candidate,
  );
