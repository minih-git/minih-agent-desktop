/**
 * Older rows, loaded a page at a time (rollout D).
 *
 * The snapshot carries only the newest page of the Host's history, and in a
 * session full of tool calls that page may hold no user message at all. These
 * cases pin how many pages are worth loading, when to stop, and how a page
 * merges without duplicating or trimming what the user asked for.
 */
import { describe, expect, it } from "vitest";

import type { RacpItemSummary } from "@minih-agent/shared";

import {
  countUserRows,
  historyItems,
  HISTORY_PAGE_LIMIT,
  loadOlderPages,
  MAX_HISTORY_PAGES,
  MIN_VISIBLE_USER_ROWS,
  oldestItemId,
  shouldLoadMoreHistory,
  singleFlight,
  TARGET_VISIBLE_ITEMS,
} from "./timeline-history.js";
import { boundItems, MAX_TIMELINE_ITEMS } from "./timeline-items.js";
import { createInitialTimelineState, timelineReducer } from "./timeline.js";
import type { TimelineItem } from "./timeline-types.js";

function row(id: string, role: "user" | "assistant" | "tool", content = "text"): RacpItemSummary {
  return {
    id,
    turnId: "t1",
    itemType: role === "tool" ? "tool" : "message",
    status: "completed",
    content: role === "tool" ? { toolName: "Read", toolStatus: "success", toolResult: content } : { id, role, content, createdAt: "" },
  } as RacpItemSummary;
}

function item(id: string, role?: "user" | "assistant"): TimelineItem {
  return { id, turnId: "t1", itemType: "message", status: "completed", text: id, ...(role ? { role } : {}) };
}

describe("shouldLoadMoreHistory", () => {
  it("loads while the transcript is short of the user's last two messages", () => {
    expect(
      shouldLoadMoreHistory({ visibleUserRows: 0, visibleItems: 10, hasMoreHistory: true, pagesLoaded: 0 }),
    ).toBe(true);
    expect(
      shouldLoadMoreHistory({
        visibleUserRows: MIN_VISIBLE_USER_ROWS - 1,
        visibleItems: 10,
        hasMoreHistory: true,
        pagesLoaded: 1,
      }),
    ).toBe(true);
  });

  it("stops once the user's messages are covered, or the view is long enough", () => {
    expect(
      shouldLoadMoreHistory({
        visibleUserRows: MIN_VISIBLE_USER_ROWS,
        visibleItems: 4,
        hasMoreHistory: true,
        pagesLoaded: 0,
      }),
    ).toBe(false);
    expect(
      shouldLoadMoreHistory({
        visibleUserRows: 0,
        visibleItems: TARGET_VISIBLE_ITEMS,
        hasMoreHistory: true,
        pagesLoaded: 0,
      }),
    ).toBe(false);
  });

  it("stops when the Host has nothing older, or the page budget is spent", () => {
    expect(
      shouldLoadMoreHistory({ visibleUserRows: 0, visibleItems: 1, hasMoreHistory: false, pagesLoaded: 0 }),
    ).toBe(false);
    expect(
      shouldLoadMoreHistory({
        visibleUserRows: 0,
        visibleItems: 1,
        hasMoreHistory: true,
        pagesLoaded: MAX_HISTORY_PAGES,
      }),
    ).toBe(false);
  });
});

describe("historyItems", () => {
  it("keeps the page's own oldest-first order and drops rows the client already has", () => {
    const known = [item("m3"), item("m4")];
    // The Host answers oldest-first (protocol §7.6, "ordered oldest to newest").
    const older = historyItems([row("m1", "user"), row("m2", "user"), row("m3", "user")], known);

    expect(older.map((entry) => entry.id)).toEqual(["m1", "m2"]);
  });

  it("drops rows the desktop would hide", () => {
    const internal = { id: "sys", turnId: "t1", itemType: "message", status: "completed", content: { id: "sys", role: "system", modelSystem: { version: 1, messageJson: "{}" }, createdAt: "" } } as RacpItemSummary;
    expect(historyItems([internal], [])).toEqual([]);
  });

  it("names the oldest row to page from", () => {
    expect(oldestItemId([item("m1"), item("m2")])).toBe("m1");
    expect(oldestItemId([])).toBeUndefined();
  });
});

describe("prepending older rows", () => {
  it("keeps the rows the user loaded, even past the live cap", () => {
    const full = Array.from({ length: MAX_TIMELINE_ITEMS }, (_, index) => item(`m${index}`));
    const state = { ...createInitialTimelineState(), items: full, attached: true };
    const older = Array.from({ length: 30 }, (_, index) => item(`old${index}`));

    const next = timelineReducer(state, { type: "prepend", items: older, hasMoreHistory: false });

    // Nothing was trimmed: the loaded rows are the ones being read.
    expect(next.items).toHaveLength(MAX_TIMELINE_ITEMS + 30);
    expect(next.items[0]!.id).toBe("old0");
    // An append still trims from the oldest end — the oldest rows go first,
    // which is what keeps a live stream bounded.
    const appended = boundItems([...next.items, item("newest")]);
    expect(appended).toHaveLength(MAX_TIMELINE_ITEMS);
    expect(appended.at(-1)!.id).toBe("newest");
    expect(appended[0]!.id).not.toBe("old0");
  });

  it("dedupes a page that repeats a row", () => {
    const state = { ...createInitialTimelineState(), items: [item("m2")], attached: true };
    const next = timelineReducer(state, {
      type: "prepend",
      items: [item("m1"), item("m2")],
      hasMoreHistory: true,
    });

    expect(next.items.map((entry) => entry.id)).toEqual(["m1", "m2"]);
    expect(next.hasMoreHistory).toBe(true);
  });

  it("counts the user's own rows, which is what the loader waits for", () => {
    expect(countUserRows([item("a", "user"), item("b", "assistant"), item("c", "user")])).toBe(2);
    expect(countUserRows([item("a", "assistant")])).toBe(0);
  });

  it("asks for pages the Host will accept", () => {
    expect(HISTORY_PAGE_LIMIT).toBeGreaterThanOrEqual(1);
    expect(HISTORY_PAGE_LIMIT).toBeLessThanOrEqual(200);
  });
});

describe("loadOlderPages", () => {
  /**
   * A page of rows the desktop hides: they cost a request but show nothing. The
   * page is ordered the way the Host orders it, oldest row first.
   */
  const hiddenPage = (count: number, oldest: number): RacpItemSummary[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `hidden-${oldest + index}`,
      turnId: "t1",
      itemType: "message",
      status: "completed",
      content: { id: `hidden-${oldest + index}`, role: "system", modelSystem: { version: 1, messageJson: "{}" }, createdAt: "" },
    }) as RacpItemSummary);

  const longView = (): TimelineItem[] =>
    Array.from({ length: TARGET_VISIBLE_ITEMS }, (_, index) => item(`m${index}`, index % 2 === 0 ? "user" : "assistant"));

  it("asks for nothing while the view is already readable", async () => {
    const requests: Array<{ beforeItemId?: string; limit: number }> = [];
    const load = await loadOlderPages({
      items: longView(),
      hasMoreHistory: true,
      manual: false,
      fetchPage: async (request) => {
        requests.push(request);
        return { ok: true, value: { items: [row("older", "user")], hasMore: true } };
      },
    });

    expect(requests).toEqual([]);
    expect(load).toEqual({ ok: true, value: { pages: [] } });
  });

  it("walks back while the page holds nothing the phone shows, and stops at the budget", async () => {
    const requests: Array<{ beforeItemId?: string; limit: number }> = [];
    const load = await loadOlderPages({
      items: [item("newest", "user")],
      hasMoreHistory: true,
      manual: false,
      fetchPage: async (request) => {
        requests.push(request);
        const oldest = 1000 - requests.length * 50;
        return { ok: true, value: { items: hiddenPage(50, oldest), hasMore: true } };
      },
    });

    expect(requests).toHaveLength(MAX_HISTORY_PAGES);
    expect(requests[0].limit).toBe(HISTORY_PAGE_LIMIT);
    // Each request is older than the previous page's oldest row, even though
    // none of those rows reached the screen.
    expect(requests.map((request) => request.beforeItemId)).toEqual(["newest", "hidden-950", "hidden-900"]);
    expect(load.ok).toBe(true);
    expect(load.ok && load.value.pages).toHaveLength(MAX_HISTORY_PAGES);
    expect(load.ok && load.value.pages.every((page) => page.items.length === 0 && page.hasMoreHistory)).toBe(true);
  });

  it("stops as soon as the page brings the user's own messages back", async () => {
    let calls = 0;
    const load = await loadOlderPages({
      items: [],
      hasMoreHistory: true,
      manual: false,
      fetchPage: async () => {
        calls += 1;
        return { ok: true, value: { items: [row("u1", "user"), row("u2", "user")], hasMore: true } };
      },
    });

    expect(calls).toBe(1);
    expect(load.ok && load.value.pages[0].items.map((entry) => entry.id)).toEqual(["u1", "u2"]);
  });

  it("loads exactly one page when the reader asks for one", async () => {
    const requests: Array<{ beforeItemId?: string; limit: number }> = [];
    const load = await loadOlderPages({
      items: longView(),
      hasMoreHistory: true,
      manual: true,
      fetchPage: async (request) => {
        requests.push(request);
        return { ok: true, value: { items: [row("older", "user")], hasMore: true } };
      },
    });

    expect(requests).toHaveLength(1);
    expect(load.ok && load.value.pages).toHaveLength(1);
  });

  it("reports a failing page as the failure and applies nothing", async () => {
    const failure = { kind: "transport", message: "offline" } as never;
    const load = await loadOlderPages({
      items: [],
      hasMoreHistory: true,
      manual: false,
      fetchPage: async () => ({ ok: false, failure }),
    });

    expect(load).toEqual({ ok: false, failure });
  });
});

/**
 * A stand-in for the Host's own pager, written from `packages/host-runtime/src/
 * host-ports.ts` (`createHostSessionPort().history`): the transcript is one
 * chronological array, `beforeItemId` names the row to stop at, and the page is
 * the `limit` rows in front of it — oldest first, exactly as protocol §7.6
 * promises ("ordered oldest to newest").
 */
function chronologicalPager(rows: RacpItemSummary[]) {
  const requests: Array<{ beforeItemId?: string; limit: number }> = [];
  return {
    requests,
    fetchPage: async (request: { beforeItemId?: string; limit: number }) => {
      requests.push(request);
      const end = request.beforeItemId ? rows.findIndex((entry) => entry.id === request.beforeItemId) : rows.length;
      const cut = end === -1 ? rows.length : end;
      const start = Math.max(0, cut - request.limit);
      return { ok: true as const, value: { items: rows.slice(start, cut), hasMore: start > 0 } };
    },
  };
}

describe("loadOlderPages against the Host's own paging", () => {
  it("walks back a page at a time through a 260-row conversation", async () => {
    const rows = Array.from({ length: 260 }, (_, index) => row(`m${String(index).padStart(3, "0")}`, "user"));
    const { requests, fetchPage } = chronologicalPager(rows);
    // The client opens holding the newest 60 rows, as a snapshot would leave it.
    let items: TimelineItem[] = rows.slice(200).map((entry) => item(entry.id, "user"));
    // What the reducer would hold: each page reports whether anything is left.
    let hasMoreHistory = true;
    const perPress: number[] = [];

    for (let press = 0; press < 3; press += 1) {
      const load = await loadOlderPages({ items, hasMoreHistory, manual: true, fetchPage });
      expect(load.ok).toBe(true);
      const older = load.ok ? load.value.pages.flatMap((page) => page.items) : [];
      perPress.push(older.length);
      items = [...older, ...items];
      hasMoreHistory = load.ok ? (load.value.pages.at(-1)?.hasMoreHistory ?? hasMoreHistory) : hasMoreHistory;
    }

    // Every press moved a whole page back, not one row: a page inserted in the
    // wrong direction, or a cursor pointing at the newest row of the page just
    // read, both show up here.
    expect(perPress).toEqual([100, 100, 0]);
    // Each request asked for what precedes the oldest row the client held.
    expect(requests.map((request) => request.beforeItemId)).toEqual(["m200", "m100"]);
    // The transcript reads oldest to newest, with every row exactly once.
    const ids = items.map((entry) => entry.id);
    expect(ids).toEqual(rows.map((entry) => entry.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stops asking once the Host says the transcript has no earlier rows", async () => {
    const rows = Array.from({ length: 120 }, (_, index) => row(`m${String(index).padStart(3, "0")}`, "user"));
    const { requests, fetchPage } = chronologicalPager(rows);
    const load = await loadOlderPages({
      items: rows.slice(100).map((entry) => item(entry.id, "user")),
      hasMoreHistory: true,
      manual: true,
      fetchPage,
    });

    expect(requests).toHaveLength(1);
    expect(load.ok && load.value.pages[0].hasMoreHistory).toBe(false);
    expect(load.ok && load.value.pages[0].items.map((entry) => entry.id)).toEqual(rows.slice(0, 100).map((entry) => entry.id));
  });
});

describe("singleFlight", () => {
  it("joins the load already in flight instead of starting a second one", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const run = singleFlight(async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return calls;
    });

    const first = run();
    const second = run();
    release();

    // Both callers get the one load's result, and only one walk happened: the
    // automatic top-up and a press of "Load earlier" must not walk from the
    // same cursor twice.
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(calls).toBe(1);
  });

  it("forwards the caller's arguments to the load it starts", async () => {
    const seen: Array<{ manual?: boolean }> = [];
    const run = singleFlight(async (options: { manual?: boolean }) => {
      seen.push(options);
      return options.manual === true;
    });

    // A press of "Load earlier" asks for exactly one page; losing the argument
    // here turned every press into another automatic top-up, which loads nothing
    // once the view is already long enough.
    expect(await run({ manual: true })).toBe(true);
    expect(seen).toEqual([{ manual: true }]);
  });

  it("starts a fresh load once the previous one settled", async () => {
    let calls = 0;
    const run = singleFlight(async () => {
      calls += 1;
      return calls;
    });

    expect(await run()).toBe(1);
    expect(await run()).toBe(2);
  });

  it("does not wedge when a load fails", async () => {
    let calls = 0;
    const run = singleFlight(async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return calls;
    });

    await expect(run()).rejects.toThrow("offline");
    expect(await run()).toBe(2);
  });
});
