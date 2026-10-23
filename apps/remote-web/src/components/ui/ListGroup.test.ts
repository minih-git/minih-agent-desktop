import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ListGroup, ListRow, SwipeRow, swipeRowActionState } from "./ListGroup.js";

/**
 * Swipe-row actions were Tab-focusable while the row was collapsed: the buttons
 * stay mounted behind the front, so the browser put them in the tab order and a
 * screen reader announced controls the user could not see (ADR mobile-redesign
 * D4). They are now `inert` while collapsed and reachable from the keyboard
 * through `ArrowRight` / `Escape` on the row.
 */
describe("SwipeRow collapsed actions", () => {
  function renderCollapsedRow(): string {
    return renderToStaticMarkup(
      createElement(ListGroup, {
        children: createElement(SwipeRow, {
          actions: [
            { key: "pin", label: "Pin", tone: "pin", onClick: () => undefined },
            { key: "archive", label: "Archive", tone: "archive", onClick: () => undefined },
          ],
          children: createElement(ListRow, {
            title: "Conversation",
            subtitle: "Replying",
            onClick: () => undefined,
          }),
        }),
      }),
    );
  }

  it("renders the trailing actions inert, hidden, and out of the tab order", () => {
    const html = renderCollapsedRow();
    expect(html).toContain('class="rm-swipe-actions"');
    expect(html).toContain("inert=\"\"");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("Pin");
    expect(html).toContain("Archive");
  });

  it("announces the reveal state on the row front", () => {
    const html = renderCollapsedRow();
    expect(html).toContain('class="rm-swipe-front"');
    expect(html).toContain('aria-expanded="false"');
  });
});

describe("swipeRowActionState", () => {
  it("keeps a collapsed row's actions out of reach", () => {
    expect(swipeRowActionState(false)).toEqual({
      inert: true,
      ariaHidden: "true",
      tabIndex: -1,
      expanded: "false",
    });
  });

  it("hands a revealed row's actions back to the tab order and to AT", () => {
    expect(swipeRowActionState(true)).toEqual({
      inert: false,
      ariaHidden: undefined,
      tabIndex: 0,
      expanded: "true",
    });
  });
});