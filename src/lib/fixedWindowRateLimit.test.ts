import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeFixedWindowRateLimit,
  type FixedWindowRateLimitState,
} from "./fixedWindowRateLimit.ts";

const LIMIT = Object.freeze({ windowMs: 1_000, maxRequests: 2, maxEntries: 2 });

test("consumeFixedWindowRateLimit counts an authenticated identity without mutating prior state", () => {
  const initial = new Map();
  const first = consumeFixedWindowRateLimit({
    state: initial,
    key: "allowed@example.com",
    nowMs: 100,
    ...LIMIT,
  });
  const second = consumeFixedWindowRateLimit({
    state: first.state,
    key: "allowed@example.com",
    nowMs: 200,
    ...LIMIT,
  });
  const denied = consumeFixedWindowRateLimit({
    state: second.state,
    key: "allowed@example.com",
    nowMs: 300,
    ...LIMIT,
  });

  assert.equal(initial.size, 0);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(denied.allowed, false);
  assert.deepEqual(first.state.get("allowed@example.com"), { count: 1, resetAtMs: 1_100 });
  assert.deepEqual(second.state.get("allowed@example.com"), { count: 2, resetAtMs: 1_100 });
});

test("consumeFixedWindowRateLimit prunes expired identities and starts a fresh window", () => {
  const staleState: FixedWindowRateLimitState = new Map<
    string,
    Readonly<{ count: number; resetAtMs: number }>
  >([
    ["stale@example.com", Object.freeze({ count: 2, resetAtMs: 1_000 })],
    ["active@example.com", Object.freeze({ count: 1, resetAtMs: 5_000 })],
  ]);
  const result = consumeFixedWindowRateLimit({
    state: staleState,
    key: "stale@example.com",
    nowMs: 1_001,
    ...LIMIT,
  });

  assert.equal(result.allowed, true);
  assert.equal(result.state.size, 2);
  assert.deepEqual(result.state.get("stale@example.com"), { count: 1, resetAtMs: 2_001 });
  assert.deepEqual(staleState.get("stale@example.com"), { count: 2, resetAtMs: 1_000 });
});

test("consumeFixedWindowRateLimit keeps the process map bounded without evicting active identities", () => {
  const fullState: FixedWindowRateLimitState = new Map<
    string,
    Readonly<{ count: number; resetAtMs: number }>
  >([
    ["one@example.com", Object.freeze({ count: 1, resetAtMs: 5_000 })],
    ["two@example.com", Object.freeze({ count: 1, resetAtMs: 5_000 })],
  ]);
  const result = consumeFixedWindowRateLimit({
    state: fullState,
    key: "three@example.com",
    nowMs: 100,
    ...LIMIT,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.state.size, 2);
  assert.equal(result.state.has("three@example.com"), false);
});
