import { describe, expect, it } from "vitest";

import { submitsOnEnter } from "./composer-send.js";

/**
 * Enter was submitting while an IME was still composing, so a Chinese, Japanese,
 * or Korean candidate list committed its half-typed text as a message. The
 * decision is shared by the chat composer and the Studio prompt, so it lives
 * here rather than in either textarea.
 */
describe("submitsOnEnter", () => {
  it("submits on a plain Enter", () => {
    expect(submitsOnEnter({ key: "Enter", shiftKey: false })).toBe(true);
  });

  it("leaves Shift+Enter to the textarea as a newline", () => {
    expect(submitsOnEnter({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("ignores any other key", () => {
    expect(submitsOnEnter({ key: "a", shiftKey: false })).toBe(false);
    expect(submitsOnEnter({ key: "Escape", shiftKey: false })).toBe(false);
  });

  it("never submits while an IME composition is active", () => {
    expect(submitsOnEnter({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    // `isComposing: false` is the ordinary state and still submits.
    expect(submitsOnEnter({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
  });

  it("never submits on the legacy keyCode an IME sends", () => {
    expect(submitsOnEnter({ key: "Enter", shiftKey: false, keyCode: 229 })).toBe(false);
    expect(submitsOnEnter({ key: "Enter", shiftKey: false, keyCode: 13 })).toBe(true);
  });

  it("does not submit when both signals mark a composition", () => {
    expect(
      submitsOnEnter({ key: "Enter", shiftKey: false, isComposing: true, keyCode: 229 }),
    ).toBe(false);
  });
});