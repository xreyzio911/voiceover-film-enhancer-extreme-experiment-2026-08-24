export type GainPlannerOutcomeInput = Readonly<{
  hasUsablePlan: boolean;
  speechBearing: boolean;
}>;

export type GainPlannerOutcome =
  | Readonly<{
      action: "use-plan";
      shouldEmitOutput: true;
      claimsAdaptiveEnhancement: true;
      candidateVariant: null;
      sourcePassthroughChain: false;
      disableLimiter: false;
    }>
  | Readonly<{
      action: "bypass-nonspeech";
      shouldEmitOutput: true;
      claimsAdaptiveEnhancement: false;
      candidateVariant: null;
      sourcePassthroughChain: false;
      disableLimiter: false;
    }>
  | Readonly<{
      action: "render-source-preserving";
      shouldEmitOutput: true;
      claimsAdaptiveEnhancement: false;
      candidateVariant: "source-safe";
      sourcePassthroughChain: true;
      disableLimiter: true;
    }>;

/**
 * A missing speech plan is an analysis limitation, not proof that accepted
 * audio should disappear. Keep the non-speech no-op behavior, but route
 * speech-bearing input through an explicit no-op render so the source remains
 * deliverable without pretending adaptive enhancement succeeded.
 */
export const resolveGainPlannerOutcome = ({
  hasUsablePlan,
  speechBearing,
}: GainPlannerOutcomeInput): GainPlannerOutcome => {
  if (hasUsablePlan) {
    return {
      action: "use-plan",
      shouldEmitOutput: true,
      claimsAdaptiveEnhancement: true,
      candidateVariant: null,
      sourcePassthroughChain: false,
      disableLimiter: false,
    };
  }

  if (speechBearing) {
    return {
      action: "render-source-preserving",
      shouldEmitOutput: true,
      claimsAdaptiveEnhancement: false,
      candidateVariant: "source-safe",
      sourcePassthroughChain: true,
      disableLimiter: true,
    };
  }

  return {
    action: "bypass-nonspeech",
    shouldEmitOutput: true,
    claimsAdaptiveEnhancement: false,
    candidateVariant: null,
    sourcePassthroughChain: false,
    disableLimiter: false,
  };
};
