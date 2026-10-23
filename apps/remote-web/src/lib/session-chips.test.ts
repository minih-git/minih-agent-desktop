import { describe, expect, it } from "vitest";

import { sessionChips } from "./session-chips.js";

describe("sessionChips", () => {
  it("returns no chips when the session record is null or undefined", () => {
    expect(sessionChips(null)).toEqual([]);
    expect(sessionChips(undefined)).toEqual([]);
  });

  it("builds model (+ thinking level), mode, and permission chips from the session record", () => {
    const chips = sessionChips(
      {
        modelId: "claude-sonnet-4-6",
        modelLabel: "Claude Sonnet 4.6",
        thinkingLevel: "high",
        mode: "agent",
        permissionMode: "ask",
      },
      {
        modeLabel: (mode) => `mode:${mode}`,
        permissionLabel: (perm) => `perm:${perm}`,
      },
    );

    expect(chips).toEqual([
      {
        kind: "model",
        tone: "gradient",
        label: "Claude Sonnet 4.6 · high",
      },
      {
        kind: "mode",
        tone: "neutral",
        label: "mode:agent",
      },
      {
        kind: "permission",
        tone: "neutral",
        label: "perm:ask",
      },
    ]);
  });

  it("falls back to modelId when modelLabel is absent, and omits thinkingLevel when absent", () => {
    const chips = sessionChips({
      modelId: "gpt-5.4",
      mode: "plan",
      permissionMode: "accept-edits",
    });

    expect(chips).toEqual([
      {
        kind: "model",
        tone: "gradient",
        label: "gpt-5.4",
      },
      {
        kind: "mode",
        tone: "neutral",
        label: "plan",
      },
      {
        kind: "permission",
        tone: "neutral",
        label: "accept-edits",
      },
    ]);
  });

  it("omits the model chip when neither modelLabel nor modelId is present on the session record", () => {
    const chips = sessionChips({
      thinkingLevel: "high",
      mode: "goal",
      permissionMode: "auto",
    });

    expect(chips).toEqual([
      {
        kind: "mode",
        tone: "neutral",
        label: "goal",
      },
      {
        kind: "permission",
        tone: "neutral",
        label: "auto",
      },
    ]);
  });

  it("omits any field that is genuinely absent rather than inventing a fallback", () => {
    expect(sessionChips({})).toEqual([]);
    expect(sessionChips({ modelLabel: "   " })).toEqual([]);
    expect(sessionChips({ mode: "agent" })).toEqual([
      { kind: "mode", tone: "neutral", label: "agent" },
    ]);
  });
});
