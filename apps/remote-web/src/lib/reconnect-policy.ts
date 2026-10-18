/**
 * SSE reconnect schedule (PR-4).
 *
 * Exponential backoff with jitter: a Gateway restart would otherwise make every
 * open H5 client retry in lockstep. The attempt number is 1-based; the jitter
 * keeps at least `1 - jitterRatio` of the computed delay, so the schedule still
 * grows even at the unlucky end of the range.
 */

export type ReconnectPolicy = {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  /** Share of the delay that may be removed at random; 0.5 = 50 %–100 %. */
  jitterRatio: number;
};

export const STREAM_RECONNECT_POLICY: ReconnectPolicy = {
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  maxAttempts: 8,
  jitterRatio: 0.5,
};

/**
 * `random` is a value in `[0, 1)` from the caller, so the schedule is testable
 * without stubbing the clock.
 */
export function backoffDelay(attempt: number, policy: ReconnectPolicy, random: number): number {
  const safeAttempt = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  const exponential = policy.baseDelayMs * 2 ** (safeAttempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const ratio = Math.min(Math.max(policy.jitterRatio, 0), 1);
  const boundedRandom = Math.min(Math.max(random, 0), 0.999_999);
  return Math.max(0, Math.round(capped * (1 - ratio + ratio * boundedRandom)));
}
