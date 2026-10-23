import { describe, expect, it } from "vitest";

import type { DirectChatConversation, DirectChatTranscript } from "./history-store.js";

import { renameValueFor } from "./rename.js";

function conversation(overrides: Partial<DirectChatConversation> = {}): DirectChatConversation {
  return {
    id: "c1",
    scope: { gatewayRoot: "https://models.example.test", accessKeyId: "42" },
    title: "Sorting a list",
    createdAt: "2026-10-21T09:00:00.000Z",
    updatedAt: "2026-10-21T09:00:00.000Z",
    pinned: false,
    archived: false,
    nextModelId: "gpt-5",
    nextProtocol: "openai-completions",
    draft: "",
    ...overrides,
  };
}

function transcript(title: string): DirectChatTranscript {
  return { conversation: conversation({ title }), messages: [], attempts: [] };
}

/**
 * Bug B5: the rename field was seeded from a transcript that is `null` on the
 * first render, so it stayed empty and Save could never be enabled. The value is
 * derived now, and an edit wins over it.
 */
describe("what the rename field shows", () => {
  it("is empty while the record is still loading", () => {
    expect(renameValueFor(null, null)).toBe("");
  });

  it("shows the conversation's title once the record arrives", () => {
    expect(renameValueFor(transcript("Sorting a list"), null)).toBe("Sorting a list");
  });

  it("keeps what the user typed over a later re-read", () => {
    expect(renameValueFor(transcript("Sorting a list"), "Sorting arrays")).toBe("Sorting arrays");
  });

  it("lets an emptied field stay empty rather than reverting under the user", () => {
    expect(renameValueFor(transcript("Sorting a list"), "")).toBe("");
  });

  it("tracks a rename that happened elsewhere when nothing was typed", () => {
    expect(renameValueFor(transcript("Renamed on another device"), null)).toBe(
      "Renamed on another device",
    );
  });
});