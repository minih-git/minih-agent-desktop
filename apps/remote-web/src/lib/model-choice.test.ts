import { describe, expect, it } from "vitest";

import {
  describeModel,
  effectiveThinkingLevel,
  isThinkingLevel,
  modelKey,
  modelSwitchBlockedReason,
  orderedThinkingLevels,
  resolveNewSessionModel,
  thinkingLevelOnModelSwitch,
  thinkingLevelsFor,
} from "./model-choice.js";
import type { RacpModelSummary } from "@minih-agent/shared";

const model = (overrides: Partial<RacpModelSummary> = {}): RacpModelSummary => ({
  providerId: "anthropic",
  providerLabel: "Anthropic",
  modelId: "claude-sonnet-5",
  label: "Claude Sonnet 5",
  thinkingLevels: ["off", "low", "high"],
  supportsImages: true,
  isDefault: false,
  ...overrides,
});

const models = [
  model({ modelId: "claude-opus-5", label: "Claude Opus 5" }),
  model({ modelId: "claude-sonnet-5", label: "Claude Sonnet 5", isDefault: true }),
];

/**
 * Choosing a session's model, and the one rule that can refuse it. The failure
 * this prevents is a session started on whatever the computer happened to
 * default to, so the resolution order matters more than the picker's layout.
 */
describe("resolveNewSessionModel", () => {
  it("keeps the user's choice while the Host still offers it", () => {
    const choice = resolveNewSessionModel(models, "anthropic/claude-opus-5");
    expect(choice.kind).toBe("model");
    expect(choice.kind === "model" && choice.model.label).toBe("Claude Opus 5");
  });

  it("falls back to the Host's default when nothing is chosen", () => {
    const choice = resolveNewSessionModel(models, null);
    expect(choice.kind === "model" && choice.model.isDefault).toBe(true);
  });

  it("falls back rather than failing when the chosen model was removed", () => {
    // The computer removed the model between the list and the sheet: starting on
    // the default is better than a creation the user cannot explain.
    const choice = resolveNewSessionModel(models, "anthropic/gone");
    expect(choice.kind === "model" && choice.model.isDefault).toBe(true);
  });

  it("uses the first model when the Host marks no default", () => {
    const noDefault = [model({ modelId: "a" }), model({ modelId: "b" })];
    const choice = resolveNewSessionModel(noDefault, null);
    expect(choice.kind === "model" && choice.model.modelId).toBe("a");
  });

  it("says so when the Host lists nothing at all", () => {
    expect(resolveNewSessionModel([], null)).toEqual({ kind: "host-default" });
  });
});

describe("modelSwitchBlockedReason", () => {
  it("refuses a running turn and a pending decision, and allows an idle session", () => {
    expect(modelSwitchBlockedReason({ running: true, hasPendingDecision: false })).toBe("model.locked.running");
    expect(modelSwitchBlockedReason({ running: false, hasPendingDecision: true })).toBe("model.locked.decision");
    expect(modelSwitchBlockedReason({ running: false, hasPendingDecision: false })).toBeNull();
  });
});

describe("thinkingLevelsFor", () => {
  it("puts the model's default level first without dropping the others", () => {
    expect(thinkingLevelsFor(model({ defaultThinkingLevel: "high" }))).toEqual(["high", "off", "low"]);
  });

  it("keeps the advertised order when the default is not advertised", () => {
    expect(thinkingLevelsFor(model({ defaultThinkingLevel: "max" }))).toEqual(["off", "low", "high"]);
    expect(thinkingLevelsFor(model())).toEqual(["off", "low", "high"]);
  });
});

describe("thinking level selection", () => {
  it("lists a model's levels off → max, whatever order the Host sent", () => {
    // The picker's positions must not move when the Host reorders its list.
    expect(orderedThinkingLevels(model({ thinkingLevels: ["high", "off", "medium"] }))).toEqual([
      "off",
      "medium",
      "high",
    ]);
    expect(orderedThinkingLevels(model({ thinkingLevels: [] }))).toEqual([]);
  });

  it("shows the level the session recorded, else the model's default", () => {
    expect(effectiveThinkingLevel(model(), "high")).toBe("high");
    expect(effectiveThinkingLevel(model({ defaultThinkingLevel: "low" }), null)).toBe("low");
    expect(effectiveThinkingLevel(model(), undefined)).toBe("off");
    expect(effectiveThinkingLevel(null, undefined)).toBeNull();
  });

  it("leaves the level alone when the new model still offers it", () => {
    // `null` means "send no thinkingLevel": the session keeps what it has.
    expect(thinkingLevelOnModelSwitch(model(), "high")).toBeNull();
    expect(thinkingLevelOnModelSwitch(model(), null)).toBeNull();
    expect(thinkingLevelOnModelSwitch(model({ thinkingLevels: [] }), "high")).toBeNull();
  });

  it("moves to the new model's default when the level is gone", () => {
    const next = model({ thinkingLevels: ["off", "medium"], defaultThinkingLevel: "medium" });
    expect(thinkingLevelOnModelSwitch(next, "xhigh")).toBe("medium");
  });

  it("walks to the nearest level only when the new model has no default", () => {
    // The same rule the desktop composer uses, so both clients answer alike.
    expect(thinkingLevelOnModelSwitch(model({ thinkingLevels: ["off", "high"] }), "medium")).toBe(
      "high",
    );
    expect(thinkingLevelOnModelSwitch(model({ thinkingLevels: ["off", "low"] }), "max")).toBe("low");
  });

  it("falls back to the new model's first level for a level it never heard of", () => {
    expect(thinkingLevelOnModelSwitch(model(), "turbo")).toBe("off");
    expect(isThinkingLevel("turbo")).toBe(false);
    expect(isThinkingLevel("xhigh")).toBe(true);
  });
});

describe("describeModel", () => {
  it("names the model and its provider, which is what the sheet row shows", () => {
    expect(describeModel(model())).toBe("Claude Sonnet 5 · Anthropic");
    expect(modelKey(model())).toBe("anthropic/claude-sonnet-5");
  });
});
