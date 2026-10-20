/**
 * Where the timeline is scrolled, decided without a browser (rollout D).
 *
 * The screen used to have no scroll handling: opening a long conversation landed
 * on its oldest row and new rows arrived off-screen. These cases pin the
 * arithmetic the hook relies on, so the behaviour is testable in the node
 * environment the package uses.
 */
import { describe, expect, it } from "vitest";

import {
  appendedRows,
  bottomOffset,
  distanceFromBottom,
  FOLLOW_THRESHOLD_PX,
  isNearBottom,
  prefersReducedMotion,
  unreadAfter,
  type ScrollMetrics,
} from "./scroll.js";

const at = (scrollTop: number, scrollHeight = 1_000, clientHeight = 400): ScrollMetrics => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe("distanceFromBottom", () => {
  it("measures from the bottom edge, and never goes negative", () => {
    expect(distanceFromBottom(at(600))).toBe(0);
    expect(distanceFromBottom(at(500))).toBe(100);
    // A rubber-banded or over-scrolled container reports past the end.
    expect(distanceFromBottom(at(900))).toBe(0);
  });

  it("treats a container that fits its content as at the bottom", () => {
    expect(distanceFromBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(0);
  });
});

describe("isNearBottom", () => {
  it("follows within the threshold and stops beyond it", () => {
    expect(isNearBottom(at(600))).toBe(true);
    expect(isNearBottom(at(600 - FOLLOW_THRESHOLD_PX))).toBe(true);
    expect(isNearBottom(at(600 - FOLLOW_THRESHOLD_PX - 1))).toBe(false);
  });

  it("takes a caller's own threshold", () => {
    expect(isNearBottom(at(600 - 20), 10)).toBe(false);
    expect(isNearBottom(at(600 - 20), 40)).toBe(true);
  });
});

describe("bottomOffset", () => {
  it("is the offset that shows the newest row", () => {
    expect(bottomOffset(at(0))).toBe(600);
    expect(bottomOffset({ scrollTop: 0, scrollHeight: 100, clientHeight: 400 })).toBe(0);
  });
});

describe("appendedRows", () => {
  const edges = (itemCount: number, firstItemId: string, lastItemId: string) => ({ itemCount, firstItemId, lastItemId });

  it("counts nothing for older rows loaded above the reader", () => {
    // A page of 100 older rows: the last row is where it was, so nothing is
    // "new" — otherwise the control would claim 100 unread messages the reader
    // asked for (review B5).
    expect(appendedRows(edges(50, "m100", "m149"), edges(150, "m000", "m149"))).toBe(0);
  });

  it("counts the rows that arrived at the end", () => {
    expect(appendedRows(edges(50, "m100", "m149"), edges(53, "m100", "m152"))).toBe(3);
  });

  it("counts at least one row when only the last row changed", () => {
    // The cap dropped rows while new ones arrived, so the count cannot be read
    // off the length.
    expect(appendedRows(edges(400, "m100", "m499"), edges(400, "m101", "m500"))).toBe(1);
  });

  it("counts one row when a prepend and an append land in the same commit", () => {
    expect(appendedRows(edges(50, "m100", "m149"), edges(151, "m000", "m150"))).toBe(1);
  });

  it("counts nothing when nothing changed", () => {
    expect(appendedRows(edges(50, "m100", "m149"), edges(50, "m100", "m149"))).toBe(0);
  });
});
