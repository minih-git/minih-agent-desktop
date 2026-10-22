import { describe, expect, it } from "vitest";

import type { DirectChatAttempt, DirectChatTranscript } from "./history-store.js";
import { completionMarker, projectDirectTranscript, transcriptAsMarkdown } from "./view.js";

const T0 = "2026-10-21T09:00:00.000Z";

function attempt(overrides: Partial<DirectChatAttempt> & { id: string }): DirectChatAttempt {
  return {
    conversationId: "c1",
    userMessageId: "m1",
    assistantMessageId: null,
    state: "complete",
    modelId: "m-chat",
    modelLabel: "M Chat",
    protocol: "openai-completions",
    startedAt: T0,
    updatedAt: T0,
    error: null,
    errorKind: null,
    usage: null,
    ...overrides,
  };
}

function transcript(overrides: Partial<DirectChatTranscript> = {}): DirectChatTranscript {
  return {
    conversation: {
      id: "c1",
      scope: { gatewayRoot: "https://models.example.test", accessKeyId: "42" },
      title: "A thread",
      createdAt: T0,
      updatedAt: T0,
      pinned: false,
      archived: false,
      nextModelId: "m-chat",
      nextProtocol: "openai-completions",
      draft: "",
    },
    messages: [],
    attempts: [],
    ...overrides,
  };
}

/**
 * The projection is what the shared timeline renders, so these tests are about
 * the record-to-row contract: which rows appear, what labels they carry, and
 * what the copied Markdown says.
 */
describe("projecting a transcript", () => {
  it("renders a user row and its reply, labelled by the model", () => {
    const view = projectDirectTranscript(
      transcript({
        messages: [
          { id: "m1", conversationId: "c1", order: 1, role: "user", text: "hello", createdAt: T0 },
          {
            id: "a1-assistant",
            conversationId: "c1",
            order: 2,
            role: "assistant",
            text: "hi",
            createdAt: T0,
            attemptId: "a1",
          },
        ],
        attempts: [attempt({ id: "a1", assistantMessageId: "a1-assistant" })],
      }),
    );
    expect(view.items.map((item) => item.role)).toEqual(["user", "assistant"]);
    expect(view.items[1]?.agentName).toBe("M Chat");
    expect(view.items[1]?.modelId).toBe("m-chat");
    expect(view.items[1]?.status).toBe("completed");
    expect(view.liveAttempt).toBeNull();
  });

  it("marks the live reply as streaming so the panel shows it arriving", () => {
    const view = projectDirectTranscript(
      transcript({
        messages: [
          { id: "m1", conversationId: "c1", order: 1, role: "user", text: "hello", createdAt: T0 },
          {
            id: "a1-assistant",
            conversationId: "c1",
            order: 2,
            role: "assistant",
            text: "partial",
            createdAt: T0,
            attemptId: "a1",
          },
        ],
        attempts: [attempt({ id: "a1", state: "streaming", assistantMessageId: "a1-assistant" })],
      }),
    );
    expect(view.items[1]?.status).toBe("streaming");
    expect(view.liveAttempt?.id).toBe("a1");
  });

  it("inserts a separator when the model changes between replies", () => {
    const view = projectDirectTranscript(
      transcript({
        messages: [
          { id: "m1", conversationId: "c1", order: 1, role: "user", text: "one", createdAt: T0 },
          { id: "a1-a", conversationId: "c1", order: 2, role: "assistant", text: "a", createdAt: T0, attemptId: "a1" },
          { id: "m2", conversationId: "c1", order: 3, role: "user", text: "two", createdAt: T0 },
          { id: "a2-a", conversationId: "c1", order: 4, role: "assistant", text: "b", createdAt: T0, attemptId: "a2" },
        ],
        attempts: [
          attempt({ id: "a1", assistantMessageId: "a1-a" }),
          attempt({ id: "a2", modelId: "m-resp", modelLabel: "M Responses", assistantMessageId: "a2-a" }),
        ],
      }),
    );
    const separators = view.items.filter((item) => item.itemType === "compaction");
    expect(separators).toHaveLength(1);
    expect(separators[0]?.text).toBe("M Responses");
    // The separator sits before the reply it introduces, not after.
    expect(view.items.map((item) => item.role)).toEqual(["user", "assistant", "user", "system", "assistant"]);
  });

  it("shows a failed reply that produced no text as its own row", () => {
    const view = projectDirectTranscript(
      transcript({
        messages: [{ id: "m1", conversationId: "c1", order: 1, role: "user", text: "hello", createdAt: T0 }],
        attempts: [
          attempt({
            id: "a1",
            state: "failed",
            error: "the model gateway rejected this key (401)",
            errorKind: "unauthorized",
          }),
        ],
      }),
    );
    const stateRow = view.items.find((item) => item.id === "state-a1");
    expect(stateRow?.text).toContain("401");
    expect(view.retryable?.id).toBe("a1");
  });

  it("offers a retry for a stopped or interrupted reply, not for a complete one", () => {
    const base = transcript({
      messages: [{ id: "m1", conversationId: "c1", order: 1, role: "user", text: "hello", createdAt: T0 }],
    });
    expect(projectDirectTranscript({ ...base, attempts: [attempt({ id: "a1" })] }).retryable).toBeNull();
    expect(
      projectDirectTranscript({ ...base, attempts: [attempt({ id: "a1", state: "stopped" })] }).retryable?.id,
    ).toBe("a1");
    expect(
      projectDirectTranscript({ ...base, attempts: [attempt({ id: "a1", state: "interrupted" })] }).retryable?.id,
    ).toBe("a1");
  });
});

describe("copying as Markdown", () => {
  it("labels each reply and states how it ended", () => {
    const markdown = transcriptAsMarkdown(
      transcript({
        messages: [
          { id: "m1", conversationId: "c1", order: 1, role: "user", text: "hello", createdAt: T0 },
          { id: "a1-a", conversationId: "c1", order: 2, role: "assistant", text: "hi there", createdAt: T0, attemptId: "a1" },
        ],
        attempts: [attempt({ id: "a1", state: "stopped", assistantMessageId: "a1-a" })],
      }),
    );
    expect(markdown).toContain("# A thread");
    expect(markdown).toContain("## User");
    expect(markdown).toContain("## M Chat");
    expect(markdown).toContain("hi there");
    expect(markdown).toContain("Stopped");
  });

  it("carries no internal id, account or secret", () => {
    const markdown = transcriptAsMarkdown(
      transcript({
        messages: [
          { id: "m1", conversationId: "c1", order: 1, role: "user", text: "hello", createdAt: T0 },
          { id: "a1-a", conversationId: "c1", order: 2, role: "assistant", text: "hi", createdAt: T0, attemptId: "a1" },
        ],
        attempts: [attempt({ id: "a1", assistantMessageId: "a1-a" })],
      }),
    );
    expect(markdown).not.toContain("42");
    expect(markdown).not.toContain("models.example.test");
    expect(markdown).not.toContain("a1");
    expect(markdown).not.toContain("sk-");
  });

  it("describes every terminal state in words a reader understands", () => {
    expect(completionMarker(attempt({ id: "x" }))).toBe("Complete");
    expect(completionMarker(attempt({ id: "x", state: "stopped" }))).toContain("Stopped");
    expect(completionMarker(attempt({ id: "x", state: "interrupted" }))).toContain("Interrupted");
    expect(completionMarker(attempt({ id: "x", state: "failed", error: "boom" }))).toContain("boom");
    expect(completionMarker(attempt({ id: "x", state: "streaming" }))).toContain("Still being received");
  });
});

describe("a reply that has not started writing yet", () => {
  it("is a live row, so the screen can offer Stop before the first token", () => {
    const view = projectDirectTranscript(
      transcript({
        messages: [{ id: "m1", conversationId: "c1", order: 1, role: "user", text: "hello", createdAt: T0 }],
        attempts: [attempt({ id: "a1", state: "pending" })],
      }),
    );
    // The attempt produced no message, yet the reply must be visible and live.
    expect(view.liveAttempt?.id).toBe("a1");
    const liveRow = view.items.find((item) => item.id === "live-a1");
    expect(liveRow?.status).toBe("streaming");
    expect(liveRow?.role).toBe("assistant");
    expect(liveRow?.agentName).toBe("M Chat");
  });

  it("shows the text that has arrived before the first checkpoint", () => {
    const view = projectDirectTranscript(
      transcript({
        messages: [{ id: "m1", conversationId: "c1", order: 1, role: "user", text: "hello", createdAt: T0 }],
        attempts: [attempt({ id: "a1", state: "streaming" })],
      }),
      { liveText: "the first words" },
    );
    expect(view.items.find((item) => item.id === "live-a1")?.text).toBe("the first words");
  });
});
