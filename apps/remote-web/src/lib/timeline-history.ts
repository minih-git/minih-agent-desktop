/**
 * Loading older transcript rows (rollout D).
 *
 * A snapshot carries only the newest page of the Host's history (50 rows), and
 * in a session full of tool calls that page can be almost entirely tool rows:
 * the user opens the conversation and cannot see what they even asked. The rest
 * comes from `session/history`, one page at a time, walking backwards from the
 * oldest row the client holds.
 *
 * This module is the pure half — how many pages to ask for, when to stop, and
 * how a page merges into the timeline — so the screen and the hook stay thin and
 * the rules are unit-testable without a DOM.
 */
import type { RacpItemSummary } from "@minih-agent/shared";

import { itemFromSummary } from "./timeline-items.js";
import type { TimelineItem } from "./timeline-types.js";
import type { HistoryPage, MutationResult } from "./mutations.js";

/**
 * The most pages loaded automatically when a conversation opens. Bounded so a
 * very long session cannot turn "open the conversation" into an unbounded
 * download; the user can always ask for more with the button.
 */
export const MAX_HISTORY_PAGES = 3;

/** Rows per page. The Host clamps to 1–200; this stays well inside it. */
export const HISTORY_PAGE_LIMIT = 100;

/**
 * Stop once the transcript shows the user's last two messages. Two is the
 * smallest number that gives a reader context: the question and the one before
 * it, rather than a single orphaned prompt.
 */
export const MIN_VISIBLE_USER_ROWS = 2;

/** Stop once the transcript is long enough to be worth reading on a phone. */
export const TARGET_VISIBLE_ITEMS = 30;

/**
 * Whether another page is worth loading.
 *
 * Stops when the Host says there is nothing older, when the visible rows already
 * cover the user's last two messages, when enough rows are visible, or when the
 * page budget is spent.
 */
export function shouldLoadMoreHistory(input: {
  visibleUserRows: number;
  visibleItems: number;
  hasMoreHistory: boolean;
  pagesLoaded: number;
}): boolean {
  if (!input.hasMoreHistory) return false;
  if (input.pagesLoaded >= MAX_HISTORY_PAGES) return false;
  if (input.visibleUserRows >= MIN_VISIBLE_USER_ROWS) return false;
  if (input.visibleItems >= TARGET_VISIBLE_ITEMS) return false;
  return true;
}

/** The id to ask "older than this" for: the oldest row the client holds. */
export function oldestItemId(items: readonly TimelineItem[]): string | undefined {
  return items[0]?.id;
}

/**
 * One page as timeline rows, with the rows the desktop hides dropped and
 * duplicates removed.
 *
 * The Host answers a page oldest to newest (protocol §7.6), which is also the
 * order the caller prepends in, so the page is returned as it arrived. The
 * dedupe is still needed: the transcript can change between two reads, and the
 * Host then repeats a row the client already holds.
 */
export function historyItems(
  page: readonly RacpItemSummary[],
  known: readonly TimelineItem[],
): TimelineItem[] {
  const seen = new Set(known.map((item) => item.id));
  const older: TimelineItem[] = [];
  for (const summary of page) {
    if (seen.has(summary.id)) continue;
    const item = itemFromSummary(summary);
    if (!item) continue;
    seen.add(item.id);
    older.push(item);
  }
  return older;
}

/** How many rows of the transcript are the user's own messages. */
export function countUserRows(items: readonly TimelineItem[]): number {
  return items.reduce((total, item) => (item.role === "user" ? total + 1 : total), 0);
}

/** One page as the caller will apply it: the rows, and what the Host then said. */
export type LoadedHistoryPage = { items: TimelineItem[]; hasMoreHistory: boolean };

/** The pages a walk loaded, newest page first, each ready to prepend as it is. */
export type HistoryLoad = { pages: LoadedHistoryPage[] };

/**
 * Walk backwards through the Host's history, one page at a time.
 *
 * `manual` is the button: exactly one page, because that is what the person
 * pressing it asked for. Otherwise the rules in `shouldLoadMoreHistory` decide,
 * so a view that is already readable costs no request at all and the page budget
 * those rules carry bounds the walk. A page that yields no visible rows still
 * counts and still reports the Host's own `hasMore`, because a page can be
 * almost entirely rows the desktop hides.
 *
 * The pages come back rather than being merged here, so the caller dispatches
 * exactly what the reducer has to prepend.
 */
export async function loadOlderPages(options: {
  items: readonly TimelineItem[];
  hasMoreHistory: boolean;
  manual: boolean;
  fetchPage: (request: { beforeItemId?: string; limit: number }) => Promise<MutationResult<HistoryPage>>;
}): Promise<MutationResult<HistoryLoad>> {
  const pages: LoadedHistoryPage[] = [];
  let items = [...options.items];
  let hasMore = options.hasMoreHistory;
  // The Host pages by `beforeItemId`, which names the row to stop at, so the
  // walk advances with the *oldest* row of the page just read — the page's first
  // row, because a page is ordered oldest to newest. Advancing with any other
  // row (the newest one, or the oldest row the phone happens to show) either
  // re-reads the same page or skips over the rows in between.
  let before = oldestItemId(items);
  for (;;) {
    if (!hasMore) break;
    const wanted = options.manual
      ? pages.length < 1
      : shouldLoadMoreHistory({
          visibleUserRows: countUserRows(items),
          visibleItems: items.length,
          hasMoreHistory: hasMore,
          pagesLoaded: pages.length,
        });
    if (!wanted) break;
    const result = await options.fetchPage({ ...(before ? { beforeItemId: before } : {}), limit: HISTORY_PAGE_LIMIT });
    if (!result.ok) return { ok: false, failure: result.failure };
    const oldest = result.value.items[0]?.id;
    if (oldest) before = oldest;
    const older = historyItems(result.value.items, items);
    items = older.length > 0 ? [...older, ...items] : items;
    hasMore = result.value.hasMore;
    pages.push({ items: older, hasMoreHistory: hasMore });
  }
  return { ok: true, value: { pages } };
}

/**
 * Run one load at a time, forwarding the caller's arguments.
 *
 * A conversation opens with an automatic top-up and the reader can press **Load
 * earlier** while it is still running. Both walk from the same cursor, so a
 * second walk would re-read the page the first one is already applying; the
 * second caller joins the load in flight instead. Once it settles the next call
 * starts a fresh one, whether it succeeded or failed. The arguments must reach
 * the wrapped call — dropping them turned every manual press into another
 * automatic top-up, which loads nothing once the view is long enough.
 */
export function singleFlight<A extends unknown[], T>(run: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (...args: A) => {
    if (inFlight) return inFlight;
    const started = run(...args).finally(() => {
      inFlight = null;
    });
    inFlight = started;
    return started;
  };
}
