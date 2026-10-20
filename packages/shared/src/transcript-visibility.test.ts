/**
 * What a transcript row shows (rollout D).
 *
 * These two predicates decide what the desktop transcript and the phone timeline
 * both render, so a change here changes two products. The cases pin the two rows
 * that are never shown and the reasons an assistant row still is.
 */
import { describe, expect, it } from "vitest";

import { isVisibleMessage, messageContentFacts, messageThinking } from "./transcript-visibility.js";
import type { UiMessage } from "./types/messages.js";

const message = (fields: Partial<UiMessage> & Pick<UiMessage, "role">): UiMessage =>
  ({ id: "m1", content: "", createdAt: "2026-10-20T00:00:00.000Z", ...fields }) as UiMessage;

describe("isVisibleMessage", () => {
  it("hides the internal model instructions", () => {
    expect(isVisibleMessage(message({ role: "system", modelSystem: { version: 1, messageJson: "{}" } }))).toBe(false);
    // A system row the user can read is still a row.
    expect(isVisibleMessage(message({ role: "system", content: "Compacted" }))).toBe(true);
  });

  it("hides an assistant row with nothing to show", () => {
    expect(isVisibleMessage(message({ role: "assistant" }))).toBe(false);
    expect(isVisibleMessage(message({ role: "assistant", content: "   " }))).toBe(false);
  });

  it("shows an assistant row that carries text, thinking, a search result, or an error", () => {
    expect(isVisibleMessage(message({ role: "assistant", content: "hello" }))).toBe(true);
    expect(isVisibleMessage(message({ role: "assistant", thinking: "working" }))).toBe(true);
    expect(
      isVisibleMessage(message({ role: "assistant", hostedSearch: { status: "completed", rounds: [] } })),
    ).toBe(true);
    expect(
      isVisibleMessage(message({ role: "assistant", error: { code: "MODEL_ERROR", message: "the model refused" } })),
    ).toBe(true);
  });
  it("shows a user or tool row whatever it holds", () => {
    expect(isVisibleMessage(message({ role: "user" }))).toBe(true);
    expect(isVisibleMessage(message({ role: "tool" }))).toBe(true);
  });
});

describe("messageContentFacts", () => {
  it("trims once per message and reports whether anything is left", () => {
    const row = message({ role: "assistant", content: "  hi  " });

    expect(messageContentFacts(row)).toEqual({ trimmedContent: "hi", hasContent: true });
    expect(messageContentFacts(message({ role: "assistant", content: " \n " }))).toEqual({ trimmedContent: "", hasContent: false });
  });
});

describe("messageThinking", () => {
  it("reports the thinking text, and nothing when there is none to show", () => {
    expect(messageThinking(message({ role: "assistant", thinking: "  plan  " }))).toBe("  plan  ");
    expect(messageThinking(message({ role: "assistant", thinking: "   " }))).toBe("");
    expect(messageThinking(message({ role: "assistant" }))).toBe("");
  });
});
