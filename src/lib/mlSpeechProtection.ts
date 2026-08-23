export type MlVadFrame = Readonly<{
  startMs: number;
  endMs: number;
  speechProbability: number;
}>;

export type MlSpeechProtectionInput = Readonly<{
  frameCount: number;
  frameMs: number;
  energySpeechMask: readonly boolean[];
  vadFrames?: readonly MlVadFrame[];
  speechProbabilityThreshold?: number;
  maxAttachedIslandMs?: number;
}>;

export type MlSpeechProtectionResult = Readonly<{
  advisoryOnly: true;
  protectedSpeechMask: readonly boolean[];
  addedFrameCount: number;
  isolatedMlFrameCount: number;
  speechProbabilityThreshold: number;
  reason: "ml-protection" | "legacy-fallback";
}>;

const DEFAULT_SPEECH_PROBABILITY_THRESHOLD = 0.65;
const DEFAULT_MAX_ATTACHED_ISLAND_MS = 120;

const isValidInputShape = (input: MlSpeechProtectionInput) =>
  Number.isInteger(input.frameCount) &&
  input.frameCount >= 0 &&
  Number.isFinite(input.frameMs) &&
  input.frameMs > 0 &&
  input.energySpeechMask.length === input.frameCount &&
  input.energySpeechMask.every((value) => typeof value === "boolean");

const legacyResult = (
  input: MlSpeechProtectionInput,
  probabilityThreshold = DEFAULT_SPEECH_PROBABILITY_THRESHOLD,
): MlSpeechProtectionResult =>
  Object.freeze({
    advisoryOnly: true,
    protectedSpeechMask: Object.freeze([...input.energySpeechMask]),
    addedFrameCount: 0,
    isolatedMlFrameCount: 0,
    speechProbabilityThreshold: probabilityThreshold,
    reason: "legacy-fallback",
  });

export const buildMlSpeechProtectionMask = (
  input: MlSpeechProtectionInput,
): MlSpeechProtectionResult => {
  const probabilityThreshold = Number.isFinite(input.speechProbabilityThreshold)
    ? Math.min(0.99, Math.max(0.01, input.speechProbabilityThreshold as number))
    : DEFAULT_SPEECH_PROBABILITY_THRESHOLD;
  if (!isValidInputShape(input)) return legacyResult(input, probabilityThreshold);
  if (!input.vadFrames || input.vadFrames.length !== input.frameCount) {
    return legacyResult(input, probabilityThreshold);
  }

  const vadSpeech = input.vadFrames.map((frame, index) => {
    const expectedStartMs = index * input.frameMs;
    const expectedEndMs = expectedStartMs + input.frameMs;
    return (
      Number.isFinite(frame.startMs) &&
      Number.isFinite(frame.endMs) &&
      Math.abs(frame.startMs - expectedStartMs) <= input.frameMs * 0.25 &&
      Math.abs(frame.endMs - expectedEndMs) <= input.frameMs * 0.25 &&
      Number.isFinite(frame.speechProbability) &&
      frame.speechProbability >= probabilityThreshold
    );
  });
  if (vadSpeech.length !== input.frameCount) return legacyResult(input, probabilityThreshold);

  const protectedSpeechMask = [...input.energySpeechMask];
  const maxAttachedFrames = Math.max(
    1,
    Math.round((input.maxAttachedIslandMs ?? DEFAULT_MAX_ATTACHED_ISLAND_MS) / input.frameMs),
  );
  let addedFrameCount = 0;
  let isolatedMlFrameCount = 0;

  for (let startFrame = 0; startFrame < input.frameCount;) {
    if (!vadSpeech[startFrame] || input.energySpeechMask[startFrame]) {
      startFrame += 1;
      continue;
    }

    let endFrame = startFrame + 1;
    while (
      endFrame < input.frameCount &&
      vadSpeech[endFrame] &&
      !input.energySpeechMask[endFrame]
    ) {
      endFrame += 1;
    }

    const touchesPreviousEnergy = startFrame > 0 && input.energySpeechMask[startFrame - 1];
    const touchesNextEnergy = endFrame < input.frameCount && input.energySpeechMask[endFrame];
    const attachedToEnergySpeech =
      (touchesPreviousEnergy || touchesNextEnergy) && endFrame - startFrame <= maxAttachedFrames;

    if (attachedToEnergySpeech) {
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        if (!protectedSpeechMask[frame]) {
          protectedSpeechMask[frame] = true;
          addedFrameCount += 1;
        }
      }
    } else {
      isolatedMlFrameCount += endFrame - startFrame;
    }

    startFrame = endFrame;
  }

  return Object.freeze({
    advisoryOnly: true,
    protectedSpeechMask: Object.freeze(protectedSpeechMask),
    addedFrameCount,
    isolatedMlFrameCount,
    speechProbabilityThreshold: probabilityThreshold,
    reason: "ml-protection",
  });
};
