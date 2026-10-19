import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { MODEL_SWITCH_COMPACTION_MIN_TOKENS } from "./context-budget.js";
import {
  modelSwitchCompactionFloor,
  modelSwitchCompactionNeeded,
  previousModelSince,
  sameModelIdentity,
  type ModelBinding,
  type ModelIdentity,
} from "./model-switch-compaction.js";

/** A 128K window: the floor is the fixed 48K bound, the trigger near 100K. */
const budget128 = { hardLimit: 111_616, keepRecentTokens: 22_323 };
/** A 1M window: 2 × keepRecent (64K) crosses the 48K bound at 128K. */
const budget1m = { hardLimit: 950_000, keepRecentTokens: 64_000 };

/** The model that produced the history. */
const modelA: ModelIdentity = { providerId: "account-a", modelId: "model-a" };
/** The binding the next request uses after the switch. */
const modelB: ModelBinding = {
  providerId: "account-b",
  modelId: "model-b",
  providerAliases: ["vendor-b"],
};

function assistant(
  id: string,
  provider: string | undefined,
  model: string | undefined,
  role: "assistant" | "user" = "assistant",
): { id: string; type: "message"; message: AgentMessage } {
  return {
    id,
    type: "message",
    message: {
      role,
      content: [],
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      timestamp: Number(id.replace(/\D/g, "")) || 1,
    } as unknown as AgentMessage,
  };
}

function decision(
  overrides: Partial<Parameters<typeof modelSwitchCompactionNeeded>[0]> = {},
) {
  return modelSwitchCompactionNeeded({
    previous: modelA,
    current: modelB,
    tokens: 80_000,
    budget: budget128,
    compactionEnabled: true,
    strategy: "summary",
    ...overrides,
  });
}

describe("previousModelSince", () => {
  it("reads the newest assistant model after the checkpoint boundary", () => {
    const entries = [
      assistant("1", "account-a", "model-a", "user"),
      assistant("2", "account-a", "model-a"),
      assistant("3", "account-b", "model-b"),
    ];

    expect(previousModelSince(entries, undefined)).toEqual({
      providerId: "account-b",
      modelId: "model-b",
    });
    expect(previousModelSince(entries, { throughMessageId: "2" })).toEqual({
      providerId: "account-b",
      modelId: "model-b",
    });
  });

  it("ignores the range the active checkpoint already covers", () => {
    const entries = [
      assistant("1", "account-a", "model-a"),
      assistant("2", "account-a", "model-a"),
    ];

    expect(previousModelSince(entries, { throughMessageId: "2" })).toBeUndefined();
  });

  it("has no answer before any assistant message exists", () => {
    expect(
      previousModelSince([assistant("1", undefined, undefined, "user")], undefined),
    ).toBeUndefined();
  });

  it("skips assistant rows that recorded no producer", () => {
    const entries = [
      assistant("1", "account-a", "model-a"),
      assistant("2", undefined, undefined),
    ];

    expect(previousModelSince(entries, undefined)).toEqual({
      providerId: "account-a",
      modelId: "model-a",
    });
  });

  it("scans the whole transcript when the boundary is gone", () => {
    const entries = [assistant("1", "account-a", "model-a")];

    expect(previousModelSince(entries, { throughMessageId: "missing" })).toEqual({
      providerId: "account-a",
      modelId: "model-a",
    });
  });
});

describe("sameModelIdentity", () => {
  it("treats the vendor key and the account row id as one binding", () => {
    expect(
      sameModelIdentity({ providerId: "vendor-b", modelId: "model-b" }, modelB),
    ).toBe(true);
  });

  it("separates two accounts serving the same model", () => {
    expect(
      sameModelIdentity({ providerId: "account-c", modelId: "model-b" }, modelB),
    ).toBe(false);
  });
});

describe("modelSwitchCompactionFloor", () => {
  it("uses the fixed floor for a small window", () => {
    expect(modelSwitchCompactionFloor(budget128)).toBe(
      MODEL_SWITCH_COMPACTION_MIN_TOKENS,
    );
  });

  it("keeps twice the retained window on a large one", () => {
    expect(modelSwitchCompactionFloor(budget1m)).toBe(128_000);
  });
});

describe("modelSwitchCompactionNeeded", () => {
  it("compacts a switched model's large context", () => {
    expect(decision()).toBe(true);
  });

  it("leaves a short history whole", () => {
    expect(decision({ tokens: 47_999 })).toBe(false);
    expect(decision({ tokens: 48_000 })).toBe(true);
  });

  it("steps aside once the automatic threshold owns the request", () => {
    expect(decision({ tokens: 101_000 })).toBe(false);
  });

  it("does not treat a thinking-level change as a model switch", () => {
    expect(decision({ previous: { ...modelB } })).toBe(false);
  });

  it("does not fire when the switched-away model is back in front", () => {
    const entries = [
      assistant("1", "account-a", "model-a"),
      assistant("2", "account-b", "model-b"),
    ];

    expect(decision({ previous: previousModelSince(entries, undefined) })).toBe(false);
  });

  it("does nothing when the range has no assistant message yet", () => {
    expect(decision({ previous: undefined })).toBe(false);
  });

  it("does nothing while compaction is disabled", () => {
    expect(decision({ compactionEnabled: false })).toBe(false);
  });

  it("does nothing for the fresh-window family", () => {
    expect(decision({ strategy: "fresh_window" })).toBe(false);
  });

  it("compacts when only the provider changed", () => {
    expect(
      decision({ previous: { providerId: "account-c", modelId: "model-b" } }),
    ).toBe(true);
  });
});
