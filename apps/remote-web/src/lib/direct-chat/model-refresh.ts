/**
 * Keeping the phone's cached model catalog current.
 *
 * The catalog is read when the account connects and then kept on the device, so
 * the picker opens without a network. Nothing refreshed it afterwards: a model
 * the gateway had since withdrawn stayed selectable for as long as the record
 * lived, and every request on it failed with no way to tell why. This module
 * refreshes it at the moments the catalog can have changed — the app returns to
 * the foreground, a picker opens, a root screen is entered — and one shared
 * throttle keeps those moments from turning into a request each.
 *
 * A failed refresh never clears the cache: `refreshModels` only writes on a
 * successful read, and this module reports the failure instead of hiding it.
 */
import type { DirectChatFailure } from "./control.js";

/** How long the client waits before asking the gateway again. */
export const MODEL_REFRESH_THROTTLE_MS = 60_000;

/** Why a refresh did not happen, when it did not have to. */
export type ModelRefreshSkip = "throttled" | "in-flight";

export type ModelRefreshResult =
  | { ok: true; refreshed: true }
  | { ok: true; refreshed: false; skipped: ModelRefreshSkip }
  | { ok: false; failure: DirectChatFailure };

/**
 * Whether this moment is worth a request.
 *
 * `lastStartedAt` is when the previous attempt *started*, not when it finished:
 * a slow gateway must not be asked twice while its first answer is outstanding,
 * and `inFlight` covers the case where it still is.
 */
export function shouldRefreshModels(input: {
  lastStartedAt: number | null;
  now: number;
  inFlight?: boolean;
  throttleMs?: number;
}): boolean {
  if (input.inFlight === true) return false;
  if (input.lastStartedAt === null) return true;
  const throttle = input.throttleMs ?? MODEL_REFRESH_THROTTLE_MS;
  return input.now - input.lastStartedAt >= throttle;
}

export type ModelRefresherOptions = {
  /** Read the catalog; the caller writes it, this module only asks. */
  refresh: () => Promise<{ ok: true } | { ok: false; failure: DirectChatFailure }>;
  /** Injected for tests. */
  now?: () => number;
  throttleMs?: number;
  /** A successful read, so the screens can re-read the connection. */
  onRefreshed?: () => void;
  /** A failed read, so it is reported rather than only logged. */
  onFailure?: (failure: DirectChatFailure) => void;
};

export type ModelRefresher = { request: () => Promise<ModelRefreshResult> };

export function createModelRefresher(options: ModelRefresherOptions): ModelRefresher {
  const now = options.now ?? (() => Date.now());
  const throttleMs = options.throttleMs ?? MODEL_REFRESH_THROTTLE_MS;
  let lastStartedAt: number | null = null;
  let inFlight = false;

  const request = async (): Promise<ModelRefreshResult> => {
    if (inFlight) return { ok: true, refreshed: false, skipped: "in-flight" };
    if (!shouldRefreshModels({ lastStartedAt, now: now(), throttleMs })) {
      return { ok: true, refreshed: false, skipped: "throttled" };
    }
    inFlight = true;
    lastStartedAt = now();
    try {
      const outcome = await options.refresh();
      if (outcome.ok) {
        options.onRefreshed?.();
        return { ok: true, refreshed: true };
      }
      options.onFailure?.(outcome.failure);
      return { ok: false, failure: outcome.failure };
    } catch (cause) {
      // A throw is a failure like any other: the cached catalog stays, and the
      // user is told rather than left wondering why the list will not change.
      const failure: DirectChatFailure = {
        kind: "gateway",
        message: cause instanceof Error ? cause.message : String(cause),
      };
      options.onFailure?.(failure);
      return { ok: false, failure };
    } finally {
      inFlight = false;
    }
  };

  return { request };
}