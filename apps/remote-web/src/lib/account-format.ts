/**
 * Presentation helpers for the account flow (rollout R7 package F).
 *
 * Kept out of the screen so the two things a user reads — the countdown and the
 * reason a sign-in failed — are unit-testable without a DOM.
 */
import type { OperationFailure } from "./errors.js";

/** `m:ss` until the request deadline; `0:00` once it has passed. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Whole seconds of the Gateway's own retry hint, or null when there is none. */
export function retrySeconds(failure: OperationFailure): number | null {
  if (failure.retryAfterMs === undefined) return null;
  return Math.max(1, Math.ceil(failure.retryAfterMs / 1000));
}
