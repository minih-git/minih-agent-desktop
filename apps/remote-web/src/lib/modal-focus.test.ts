import { describe, expect, it } from "vitest";

import { isFocusable, takeModalFocus } from "./modal-focus.js";

/**
 * Focus ownership of a full-screen modal (ADR mobile-redesign D4): the dialog
 * takes focus when it opens and gives it back to the card that opened it.
 */
describe("takeModalFocus", () => {
  function counter() {
    let focused = 0;
    return {
      element: {
        focus: () => {
          focused += 1;
        },
      },
      count: () => focused,
    };
  }

  /** A stand-in for a detached element; only `focus()` is ever called on it. */
  function asNode(value: unknown): Node {
    return value as Node;
  }

  it("moves focus into the modal when it opens", () => {
    const card = counter();
    const close = counter();
    takeModalFocus({ activeElement: asNode(card.element) }, close.element);
    expect(close.count()).toBe(1);
    expect(card.count()).toBe(0);
  });

  it("returns focus to the gallery card when it closes", () => {
    const card = counter();
    const close = counter();
    const restore = takeModalFocus({ activeElement: asNode(card.element) }, close.element);
    restore();
    expect(card.count()).toBe(1);
  });

  it("restores nothing when the dialog opened with no focus to return to", () => {
    const close = counter();
    const restore = takeModalFocus({ activeElement: null }, close.element);
    expect(close.count()).toBe(1);
    expect(() => restore()).not.toThrow();
  });

  it("does not refocus itself when the close button already had focus", () => {
    const close = counter();
    const restore = takeModalFocus({ activeElement: asNode(close.element) }, close.element);
    restore();
    expect(close.count()).toBe(1);
  });

  it("returns focus to the card only while the dialog still holds it", () => {
    const card = counter();
    const close = counter();
    const composer = counter();
    const dialog = { contains: (node: Node | null) => node === asNode(close.element) };
    const doc = { activeElement: asNode(card.element) };

    const restore = takeModalFocus(doc, close.element, dialog);
    // An action inside the dialog (reusing the prompt) moves focus to the
    // composer before the dialog closes: that focus must win.
    doc.activeElement = asNode(composer.element);
    restore();
    expect(card.count()).toBe(0);
    expect(composer.count()).toBe(0);

    const stillInside = { activeElement: asNode(card.element) };
    const restoreInside = takeModalFocus(stillInside, close.element, dialog);
    // The close button still holds focus, so the card gets it back.
    stillInside.activeElement = asNode(close.element);
    restoreInside();
    expect(card.count()).toBe(1);
  });

  it("tolerates a missing document and a non-focusable active element", () => {
    const close = counter();
    expect(() => takeModalFocus(null, close.element)()).not.toThrow();
    expect(close.count()).toBe(1);
    expect(isFocusable({})).toBe(false);
    expect(isFocusable(null)).toBe(false);
    expect(isFocusable({ focus: "not a function" })).toBe(false);
  });
});