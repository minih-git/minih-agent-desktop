import { expect, it } from "vitest";

import { type MinihRouterModel, parseMinihRouterModelPage } from "@minih-agent/shared";

import {
  gatewayDefaultLevel,
  reasoningLevelFor,
  reasoningLevelsOf,
  reasoningLevelSurvives,
} from "./reasoning.js";

const model = (overrides: Partial<MinihRouterModel> = {}): MinihRouterModel => ({
  id: "gpt-6-astra",
  upstreamIds: [],
  vendor: "openai",
  category: "chat",
  protocols: ["openai-completions"],
  price: { input: "0", output: "0", cacheRead: "0", cacheWrite: "0" },
  multiplePrices: false,
  tieredPricing: false,
  contextWindow: null,
  maxOutput: null,
  ...overrides,
});

it("lists the levels the gateway declared, in its own order, and nothing else", () => {
  // The gateway's order is its own business; a picker's positions must not move.
  expect(reasoningLevelsOf(model({ reasoningLevels: ["high", "none", "medium"] }))).toEqual([
    "none",
    "medium",
    "high",
  ]);
  // The two levels only the gateway knows stay usable.
  expect(reasoningLevelsOf(model({ reasoningLevels: ["ultra", "persistent"] }))).toEqual([
    "ultra",
    "persistent",
  ]);
  // A level nobody can send, and the desktop ladder's `off`, never become options.
  expect(reasoningLevelsOf(model({ reasoningLevels: ["turbo"] as never }))).toEqual([]);
  expect(reasoningLevelsOf(model({ reasoningLevels: ["off"] as never }))).toEqual([]);
  expect(reasoningLevelsOf(model())).toEqual([]);
  expect(reasoningLevelsOf(null)).toEqual([]);
});

it("sends a saved level only while the model still declares it", () => {
  const declared = model({
    reasoningLevels: ["none", "low", "high"],
    defaultReasoningLevel: "low",
  });
  expect(reasoningLevelFor(declared, "high")).toBe("high");
  // "Default" is the absence of a level, which is not the same as `none`.
  expect(reasoningLevelFor(declared, null)).toBeNull();
  expect(reasoningLevelFor(declared, "")).toBeNull();
  // A level that outlived its model is dropped instead of sent.
  expect(reasoningLevelFor(model({ reasoningLevels: ["none"] }), "max")).toBeNull();
  expect(reasoningLevelFor(model({ reasoningLevels: ["none"] }), "turbo")).toBeNull();
  // A record written before the gateway's vocabulary existed can hold `off`;
  // it is not a level the gateway knows, so it reads as "default".
  expect(reasoningLevelFor(model({ reasoningLevels: ["none", "high"] }), "off")).toBeNull();
});

it("names the gateway's own default only when it is one of the declared levels", () => {
  expect(
    gatewayDefaultLevel(model({ reasoningLevels: ["none", "medium"], defaultReasoningLevel: "medium" })),
  ).toBe("medium");
  // A default outside the list is not something the picker could show.
  expect(
    gatewayDefaultLevel(model({ reasoningLevels: ["none"], defaultReasoningLevel: "max" })),
  ).toBeNull();
  expect(gatewayDefaultLevel(model({ reasoningLevels: [] }))).toBeNull();
  expect(gatewayDefaultLevel(null)).toBeNull();
});

it("reads the levels the shared parser lifted out of /api/models", () => {
  // The whole point of this test is the boundary: the parser and `reasoning.ts`
  // must be the same `@minih-agent/shared` build, or the phone would ship a
  // parser that emits nothing this screen can read.
  const parsed = parseMinihRouterModelPage({
    items: [
      {
        client_model: "gpt-6-astra",
        reasoning_levels: ["medium", "high"],
        default_reasoning_level: "high",
      },
    ],
    pagination: { page: 1, page_size: 1, total_items: 1, total_pages: 1 },
  });
  expect(reasoningLevelsOf(parsed.items[0])).toEqual(["medium", "high"]);
  expect(parsed.items[0]?.defaultReasoningLevel).toBe("high");
});

it("tells the caller when a saved level did not survive a model change", () => {
  const declared = model({ reasoningLevels: ["none", "high"] });
  expect(reasoningLevelSurvives(declared, "high")).toBe(true);
  expect(reasoningLevelSurvives(declared, "max")).toBe(false);
  // "Default" needs no explanation: nothing was lost.
  expect(reasoningLevelSurvives(declared, null)).toBe(false);
});