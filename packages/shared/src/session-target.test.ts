import { describe, expect, it } from "vitest";
import { parseSessionLinks } from "./session-link.js";
import {
  SESSION_TARGET_TITLE_MAX_CHARS,
  formatSessionTargetText,
  sessionTargetLabel,
  sessionTargetTitle,
} from "./session-target.js";

/**
 * The Composer's `#` session target: the text one target contributes to the
 * prompt. It names a conversation for the session tools; it is never a session
 * *link*, because main would resolve a link into an excerpt of that
 * conversation, which is exactly what a target must not carry.
 */

const id = "0f1e2d3c-4b5a-6978-8c9d-0e1f2a3b4c5d";

describe("sessionTargetTitle", () => {
  it("folds whitespace and trims", () => {
    expect(sessionTargetTitle("  Review\t the \n diff  ")).toBe("Review the diff");
    expect(sessionTargetTitle("line one\n\nline two")).toBe("line one line two");
    expect(sessionTargetTitle("\t \n")).toBe("");
  });

  it("cuts a long title without leaving a trailing space", () => {
    const cut = sessionTargetTitle(`${"a".repeat(SESSION_TARGET_TITLE_MAX_CHARS)} tail`);
    expect(cut).toBe("a".repeat(SESSION_TARGET_TITLE_MAX_CHARS));
    expect(Array.from(cut)).toHaveLength(SESSION_TARGET_TITLE_MAX_CHARS);
    // A cut that lands on a separator must not keep it.
    expect(sessionTargetTitle(`${"a".repeat(SESSION_TARGET_TITLE_MAX_CHARS - 1)} b`)).toBe(
      "a".repeat(SESSION_TARGET_TITLE_MAX_CHARS - 1),
    );
  });

  it("drops our own deep-link scheme, so a title cannot carry a link", () => {
    expect(sessionTargetTitle("minih-agent-desktop://session/abc")).toBe("session/abc");
  });
});

describe("formatSessionTargetText", () => {
  it("names the title and the Session ID", () => {
    expect(formatSessionTargetText("Review the diff", id)).toBe(
      `#Review the diff (Session ID: ${id})`,
    );
  });

  it("falls back to the id's first eight characters without a title", () => {
    expect(formatSessionTargetText("", id)).toBe(`#0f1e2d3c (Session ID: ${id})`);
    expect(formatSessionTargetText("   \n ", id)).toBe(`#0f1e2d3c (Session ID: ${id})`);
    expect(sessionTargetLabel("", id)).toBe("#0f1e2d3c");
    expect(sessionTargetLabel("Review the diff", id)).toBe("#Review the diff");
  });

  it("keeps the id even when the title is lost, and trims a padded id", () => {
    expect(formatSessionTargetText("Fix", ` ${id} `)).toBe(`#Fix (Session ID: ${id})`);
  });

  it("never reads as a session link, so main attaches no excerpt", () => {
    // The whole point of a target: main's resolver must find nothing here.
    for (const title of [
      "Review the diff",
      "minih-agent-desktop://session/other",
      "session/1234",
      "notes.txt",
      "",
    ]) {
      expect(parseSessionLinks(formatSessionTargetText(title, id))).toEqual([]);
    }
  });
});
