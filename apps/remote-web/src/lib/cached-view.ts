/**
 * Which rows and lists a screen shows while a Host answer is still in flight.
 *
 * The cache (`host-cache.ts`) holds the last answer; this module decides what
 * that means for the screen, and it is the only place that decision is made:
 *
 * - A **live** answer always wins, so a refresh replaces the cached view the
 *   moment it lands and the cache can never outlive its own correction.
 * - A cached value is only ever shown while there is no live one, and the screen
 *   says so (`cacheHint`), so nobody mistakes yesterday's list for an answer that
 *   just arrived.
 * - `session/attach` is the one answer that is *not* just newer data: it comes
 *   with the cursor the event stream must resume from. So the cached timeline is
 *   shown only until the snapshot arrives, and the moment it does the live rows
 *   replace it whole — the cached rows, their order, and any cursor-like state
 *   they might suggest are dropped, never merged (protocol §5.4).
 */
import type { TimelineItem } from "./timeline-types.js";

/** A value on screen, and whether it came from this visit or from the cache. */
export type CachedValue<T> = {
  value: T | null;
  /** True while what is shown is the cached answer rather than this visit's. */
  fromCache: boolean;
  /** When the Host sent the shown value; `null` when nothing is shown. */
  fetchedAt: string | null;
};

/**
 * The live list when there is one, the cached one before that.
 *
 * `live` is `null` until the first successful read of this visit, which is what
 * makes "the cached list is showing" and "no answer yet" the same state.
 */
export function resolveCachedValue<T>(
  live: T | null,
  cached: { value: T; fetchedAt: string } | null,
): CachedValue<T> {
  if (live !== null) return { value: live, fromCache: false, fetchedAt: null };
  if (cached !== null) return { value: cached.value, fromCache: true, fetchedAt: cached.fetchedAt };
  return { value: null, fromCache: false, fetchedAt: null };
}

/** How a screen labels the cached data it is showing. */
export type CacheHintKind = "refreshing" | "offline";

/**
 * The notice a screen shows under its header, or nothing.
 *
 * "Offline" needs a failure to say so: a cache with no failure is simply a
 * request that has not answered yet, and claiming an outage there would be a
 * guess. Neither kind is an error tone — the failure banner already carries the
 * reason, and the cache is the reason the screen still works.
 */
export function cacheHint(input: { fromCache: boolean; failed: boolean }): CacheHintKind | null {
  if (!input.fromCache) return null;
  return input.failed ? "offline" : "refreshing";
}

export type TimelineView = {
  items: TimelineItem[];
  /** True while these rows are the cached snapshot, not the attached one. */
  fromCache: boolean;
  fetchedAt: string | null;
};

/**
 * The rows the session screen renders.
 *
 * Before the snapshot, the cached tail — never a merged or filtered version of
 * it. After it, exactly the live rows: the cached copy is not consulted again
 * for the rest of the visit, because the attached timeline is the transcript the
 * cursor belongs to.
 */
export function resolveTimelineView(input: {
  attached: boolean;
  items: readonly TimelineItem[];
  cached: { items: readonly TimelineItem[]; fetchedAt: string } | null;
}): TimelineView {
  if (input.attached) {
    return { items: [...input.items], fromCache: false, fetchedAt: null };
  }
  if (input.cached && input.cached.items.length > 0) {
    return {
      items: [...input.cached.items],
      fromCache: true,
      fetchedAt: input.cached.fetchedAt,
    };
  }
  return { items: [...input.items], fromCache: false, fetchedAt: null };
}