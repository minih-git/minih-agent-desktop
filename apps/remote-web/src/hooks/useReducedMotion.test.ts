import { describe, expect, it } from "vitest";

import { REDUCED_MOTION_QUERY, reduceMotionFrom } from "./useReducedMotion.js";

/**
 * The motion decision behind `useReducedMotion` (ADR mobile-redesign D4).
 *
 * The hook itself needs a browser; the part that decides whether to animate is
 * pure, so it is pinned here with a fake query list.
 */
describe("reduceMotionFrom", () => {
  it("asks the reduced-motion query, not the color-scheme one", () => {
    expect(REDUCED_MOTION_QUERY).toBe("(prefers-reduced-motion: reduce)");
  });

  it("follows the query list's current match", () => {
    expect(reduceMotionFrom({ matches: true })).toBe(true);
    expect(reduceMotionFrom({ matches: false })).toBe(false);
  });

  it("stays false when the platform has no query list", () => {
    expect(reduceMotionFrom(null)).toBe(false);
    expect(reduceMotionFrom(undefined)).toBe(false);
  });
});