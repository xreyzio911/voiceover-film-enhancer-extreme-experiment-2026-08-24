export type FixedWindowRateLimitBucket = Readonly<{
  count: number;
  resetAtMs: number;
}>;

export type FixedWindowRateLimitState = ReadonlyMap<string, FixedWindowRateLimitBucket>;

type FixedWindowRateLimitInput = Readonly<{
  state: FixedWindowRateLimitState;
  key: string;
  nowMs: number;
  windowMs: number;
  maxRequests: number;
  maxEntries: number;
}>;

type FixedWindowRateLimitResult = Readonly<{
  allowed: boolean;
  state: FixedWindowRateLimitState;
}>;

const assertPositiveSafeInteger = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
};

export const consumeFixedWindowRateLimit = (
  input: FixedWindowRateLimitInput,
): FixedWindowRateLimitResult => {
  const { state, key, nowMs, windowMs, maxRequests, maxEntries } = input;
  assertPositiveSafeInteger(windowMs, "windowMs");
  assertPositiveSafeInteger(maxRequests, "maxRequests");
  assertPositiveSafeInteger(maxEntries, "maxEntries");
  if (!Number.isFinite(nowMs) || !key) throw new RangeError("nowMs and key must be valid");

  const activeState = new Map(
    [...state.entries()].filter(([, bucket]) => bucket.resetAtMs > nowMs),
  );
  const current = activeState.get(key);
  if (current?.count !== undefined && current.count >= maxRequests) {
    return Object.freeze({ allowed: false, state: activeState });
  }
  if (!current && activeState.size >= maxEntries) {
    return Object.freeze({ allowed: false, state: activeState });
  }

  const nextState = new Map(activeState);
  nextState.set(key, Object.freeze({
    count: (current?.count ?? 0) + 1,
    resetAtMs: current?.resetAtMs ?? nowMs + windowMs,
  }));
  return Object.freeze({ allowed: true, state: nextState });
};
