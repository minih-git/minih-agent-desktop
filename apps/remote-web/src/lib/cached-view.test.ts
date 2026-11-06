import { describe, expect, it } from "vitest";

import { cacheHint, resolveCachedValue, resolveTimelineView } from "./cached-view.js";
import type { TimelineItem } from "./timeline-types.js";

/**
 * Which source a screen shows (`lib/cached-view.ts`).
 *
 * These are the four states the screens must not confuse: nothing yet, the
 * cached answer while the request is in flight, the live answer that replaces
 * it, and a cached answer kept because the request failed. The session screen's
 * case is the fourth section: the cache is a first paint, and `session/attach`
 * ends it.
 */
const cachedSessions = { value: ["cached"], fetchedAt: "2026-10-21T09:00:00.000Z" };

function item(id: string): TimelineItem {
  return { id, turnId: "turn_1", itemType: "message", status: "completed", text: id };
}

describe("a cached list", () => {
  it("paints the cached answer while the live read is still in flight", () => {
    const shown = resolveCachedValue<string[]>(null, cachedSessions);
    expect(shown.value).toEqual(["cached"]);
    expect(shown.fromCache).toBe(true);
    expect(shown.fetchedAt).toBe("2026-10-21T09:00:00.000Z");
  });

  it("is replaced the moment the live answer lands", () => {
    const shown = resolveCachedValue(["live"], cachedSessions);
    expect(shown.value).toEqual(["live"]);
    expect(shown.fromCache).toBe(false);
    // Nothing claims a time for data that just arrived.
    expect(shown.fetchedAt).toBeNull();
  });

  it("keeps the cached answer when there is no live one yet", () => {
    // A failed refresh leaves `live` null, which is exactly the cached case.
    expect(resolveCachedValue<string[]>(null, cachedSessions).value).toEqual(["cached"]);
  });

  it("shows nothing when there is neither", () => {
    expect(resolveCachedValue<string[]>(null, null)).toEqual({
      value: null,
      fromCache: false,
      fetchedAt: null,
    });
  });
});

describe("the hint a screen shows", () => {
  it("says it is refreshing when the cached answer is on screen", () => {
    expect(cacheHint({ fromCache: true, failed: false })).toBe("refreshing");
  });

  it("says offline only once a read has actually failed", () => {
    expect(cacheHint({ fromCache: true, failed: true })).toBe("offline");
  });

  it("says nothing at all about live data", () => {
    expect(cacheHint({ fromCache: false, failed: false })).toBeNull();
    expect(cacheHint({ fromCache: false, failed: true })).toBeNull();
  });
});

describe("a session timeline", () => {
  it("shows the cached tail before the snapshot arrives", () => {
    const shown = resolveTimelineView({
      attached: false,
      items: [],
      cached: { items: [item("cached-1"), item("cached-2")], fetchedAt: "2026-10-21T09:00:00.000Z" },
    });
    expect(shown.items.map((row) => row.id)).toEqual(["cached-1", "cached-2"]);
    expect(shown.fromCache).toBe(true);
  });

  it("shows the snapshot alone once it arrives, cached rows and all dropped", () => {
    const shown = resolveTimelineView({
      attached: true,
      items: [item("live-1")],
      cached: { items: [item("cached-1")], fetchedAt: "2026-10-21T09:00:00.000Z" },
    });
    // Not merged, not appended to, not kept for the missing page: the attached
    // timeline is the whole transcript this visit continues from.
    expect(shown.items.map((row) => row.id)).toEqual(["live-1"]);
    expect(shown.fromCache).toBe(false);
    expect(shown.fetchedAt).toBeNull();
  });

  it("still prefers the snapshot when it is empty", () => {
    const shown = resolveTimelineView({
      attached: true,
      items: [],
      cached: { items: [item("cached-1")], fetchedAt: "2026-10-21T09:00:00.000Z" },
    });
    expect(shown.items).toEqual([]);
    expect(shown.fromCache).toBe(false);
  });

  it("opens empty when there is no cache and no snapshot yet", () => {
    expect(resolveTimelineView({ attached: false, items: [], cached: null })).toEqual({
      items: [],
      fromCache: false,
      fetchedAt: null,
    });
  });
});