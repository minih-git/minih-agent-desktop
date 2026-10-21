import { describe, expect, it } from "vitest";

import {
  COMPLETE_FRACTION,
  EDGE_WIDTH,
  MIN_FLICK_DISTANCE_FRACTION,
  classifyDrag,
  completesOnRelease,
  dragFrame,
  mayStartEdgeGesture,
} from "./edge-gesture.js";

/** A touch on a phone screen. */
const touch = (startX: number, overrides: Partial<Parameters<typeof mayStartEdgeGesture>[0]> = {}) => ({
  startX,
  sheetOpen: false,
  canGoBack: true,
  pointerType: "touch",
  ...overrides,
});

describe("mayStartEdgeGesture", () => {
  it("starts anywhere on the screen for a valid touch", () => {
    expect(mayStartEdgeGesture(touch(0))).toBe(true);
    expect(mayStartEdgeGesture(touch(EDGE_WIDTH))).toBe(true);
    expect(mayStartEdgeGesture(touch(EDGE_WIDTH + 1))).toBe(true);
    expect(mayStartEdgeGesture(touch(180))).toBe(true);
    expect(mayStartEdgeGesture(touch(-1))).toBe(false);
  });

  it("never takes a touch from a sheet, from a mouse, or with nowhere to go", () => {
    expect(mayStartEdgeGesture(touch(2, { sheetOpen: true }))).toBe(false);
    expect(mayStartEdgeGesture(touch(2, { pointerType: "mouse" }))).toBe(false);
    expect(mayStartEdgeGesture(touch(2, { canGoBack: false }))).toBe(false);
  });
});

describe("classifyDrag", () => {
  it("does not decide on a small movement", () => {
    expect(classifyDrag({ dx: 4, dy: 2 })).toEqual({ kind: "undecided" });
  });

  it("releases a mostly-vertical drag, which is the timeline scrolling", () => {
    expect(classifyDrag({ dx: 6, dy: 40 })).toEqual({ kind: "reject" });
    expect(classifyDrag({ dx: -30, dy: 40 })).toEqual({ kind: "reject" });
  });

  it("releases a leftward drag", () => {
    expect(classifyDrag({ dx: -20, dy: 2 })).toEqual({ kind: "reject" });
  });

  it("tracks a rightward drag, clamped at zero", () => {
    expect(classifyDrag({ dx: 40, dy: 3 })).toEqual({ kind: "drag", offset: 40 });
  });
});

describe("completesOnRelease", () => {
  const width = 390;

  it("completes past the completion fraction of the screen", () => {
    expect(completesOnRelease({ offset: width * COMPLETE_FRACTION, velocity: 0, viewportWidth: width })).toBe(true);
    expect(completesOnRelease({ offset: width * COMPLETE_FRACTION - 1, velocity: 0, viewportWidth: width })).toBe(false);
  });

  it("completes a short, fast flick once it has travelled far enough", () => {
    const flick = width * MIN_FLICK_DISTANCE_FRACTION + 1;
    expect(completesOnRelease({ offset: flick, velocity: 1.2, viewportWidth: width })).toBe(true);
  });

  it("springs back a short drag whatever speed it reports", () => {
    const tooShort = width * MIN_FLICK_DISTANCE_FRACTION - 1;
    expect(completesOnRelease({ offset: tooShort, velocity: 6.7, viewportWidth: width })).toBe(false);
    expect(completesOnRelease({ offset: 20, velocity: 40, viewportWidth: width })).toBe(false);
  });

  it("cancels a long drag the user flicked back", () => {
    expect(completesOnRelease({ offset: 300, velocity: -1.5, viewportWidth: width })).toBe(false);
  });

  it("never completes without a viewport to measure against", () => {
    expect(completesOnRelease({ offset: 400, velocity: 0, viewportWidth: 0 })).toBe(false);
  });
});

describe("dragFrame", () => {
  it("moves the screen with the finger and the one beneath at a third", () => {
    expect(dragFrame({ offset: 195, viewportWidth: 390 })).toEqual({ progress: 0.5, parallax: 0.5 / 3 });
    expect(dragFrame({ offset: 900, viewportWidth: 390 })).toEqual({ progress: 1, parallax: 1 / 3 });
    expect(dragFrame({ offset: 0, viewportWidth: 390 })).toEqual({ progress: 0, parallax: 0 });
  });
});
