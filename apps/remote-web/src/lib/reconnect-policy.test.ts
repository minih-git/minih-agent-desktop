import { describe, expect, it } from "vitest";

import { STREAM_RECONNECT_POLICY, backoffDelay, type ReconnectPolicy } from "./reconnect-policy.js";

const policy: ReconnectPolicy = { baseDelayMs: 100, maxDelayMs: 800, maxAttempts: 5, jitterRatio: 0.5 };

describe("backoffDelay", () => {
  it("grows exponentially up to the cap", () => {
    expect(backoffDelay(1, policy, 1)).toBe(100);
    expect(backoffDelay(2, policy, 1)).toBe(200);
    expect(backoffDelay(3, policy, 1)).toBe(400);
    expect(backoffDelay(4, policy, 1)).toBe(800);
    expect(backoffDelay(9, policy, 1)).toBe(800);
  });

  it("removes at most jitterRatio of the delay", () => {
    expect(backoffDelay(1, policy, 0)).toBe(50);
    expect(backoffDelay(1, policy, 0.5)).toBe(75);
    expect(backoffDelay(1, policy, 0.999)).toBe(100);
  });

  it("still grows at the unlucky end of the jitter range", () => {
    const lows = [1, 2, 3, 4].map((attempt) => backoffDelay(attempt, policy, 0));
    expect(lows).toEqual([50, 100, 200, 400]);
  });

  it("treats an attempt below one as the first attempt", () => {
    expect(backoffDelay(0, policy, 1)).toBe(100);
    expect(backoffDelay(Number.NaN, policy, 1)).toBe(100);
  });

  it("clamps a hostile random value", () => {
    expect(backoffDelay(1, policy, 5)).toBe(100);
    expect(backoffDelay(1, policy, -3)).toBe(50);
  });

  it("ships a bounded default schedule", () => {
    expect(STREAM_RECONNECT_POLICY.baseDelayMs).toBeLessThan(STREAM_RECONNECT_POLICY.maxDelayMs);
    expect(STREAM_RECONNECT_POLICY.jitterRatio).toBeGreaterThan(0);
    expect(STREAM_RECONNECT_POLICY.maxAttempts).toBeGreaterThan(0);
  });
});
