import { describe, expect, it } from "vitest";

import type { MinihRouterModel } from "@minih-agent/shared";

import {
  filterDirectModels,
  initialDirectModel,
  resolveDirectModel,
  splitDirectModels,
  resolveEffectiveChatModel,
  resolveEffectiveImageModel,
  isImageModel,
  checkModelVisionCapability,
} from "./catalog.js";
function model(overrides: Partial<MinihRouterModel> & { id: string }): MinihRouterModel {
  return {
    upstreamIds: [],
    vendor: "Test",
    category: "chat",
    protocols: ["openai-completions"],
    price: { input: null, output: null, cacheRead: null, cacheWrite: null },
    multiplePrices: false,
    tieredPricing: false,
    contextWindow: null,
    maxOutput: null,
    ...overrides,
  };
}

/**
 * The protocol decision is the whole point of the catalog layer: the gateway
 * declares what a model speaks, and this client implements two protocols. A
 * wrong guess here sends a request that fails, or bills a model the user did not
 * pick.
 */
describe("choosing a protocol", () => {
  it("prefers chat completions when the gateway offers both", () => {
    const choice = resolveDirectModel(model({ id: "gpt-4.1", protocols: ["openai-completions", "openai-responses"] }));
    expect(choice.usable).toBe(true);
    if (choice.usable) expect(choice.protocol).toBe("openai-completions");
  });

  it("uses responses when it is the only protocol offered", () => {
    const choice = resolveDirectModel(model({ id: "o4", protocols: ["openai-responses"] }));
    expect(choice.usable).toBe(true);
    if (choice.usable) expect(choice.protocol).toBe("openai-responses");
  });

  it("does not care about the order the gateway lists them in", () => {
    const choice = resolveDirectModel(model({ id: "x", protocols: ["openai-responses", "openai-completions"] }));
    expect(choice.usable).toBe(true);
    if (choice.usable) expect(choice.protocol).toBe("openai-completions");
  });

  it("disables a model that speaks only another protocol, and says which", () => {
    const choice = resolveDirectModel(model({ id: "claude", protocols: ["anthropic-messages"] }));
    expect(choice.usable).toBe(false);
    if (!choice.usable) {
      expect(choice.reason).toBe("unsupported-protocol");
      expect(choice.protocols).toEqual(["anthropic-messages"]);
    }
  });

  it("disables a model with no declared protocol instead of guessing one", () => {
    const choice = resolveDirectModel(model({ id: "mystery", protocols: [] }));
    expect(choice.usable).toBe(false);
    if (!choice.usable) expect(choice.reason).toBe("unsupported-protocol");
  });

  it("never guesses from the model's name", () => {
    // A name that looks like a chat model is not evidence of a protocol.
    const choice = resolveDirectModel(model({ id: "gpt-4.1-mini", protocols: [] }));
    expect(choice.usable).toBe(false);
  });
});

describe("models that are not chat choices", () => {
  it("disables an image model even when the gateway also lists a chat protocol", () => {
    // Router lists every protocol a route group accepts, so a `gpt-image` row
    // arrives declaring chat completions too. Offering it as a conversation
    // model sent a request the upstream refused - the failure this pins.
    const real = [
      "openai-completions",
      "openai-responses",
      "openai-images",
      "anthropic",
      "gemini",
    ];
    const choice = resolveDirectModel(model({ id: "gpt-image-2.5", protocols: real }));
    expect(choice.usable).toBe(false);
    if (!choice.usable) expect(choice.reason).toBe("image-model");
  });

  it("keeps the image reason on rows that also declare another chat protocol", () => {
    // An image row is explained as an image row, not as a protocol mismatch.
    for (const protocols of [
      ["openai-images"],
      ["openai-images", "openai-completions"],
      ["anthropic", "openai-images"],
    ]) {
      const choice = resolveDirectModel(model({ id: "m", protocols }));
      expect(choice.usable, protocols.join(",")).toBe(false);
      if (!choice.usable) expect(choice.reason, protocols.join(",")).toBe("image-model");
    }
  });

  it("disables a model that declares only other non-conversation protocols", () => {
    for (const protocols of [["openai-embeddings"], ["rerank"], ["ocr"], ["openai-embeddings", "ocr"]]) {
      const choice = resolveDirectModel(model({ id: "m", protocols }));
      expect(choice.usable, protocols.join(",")).toBe(false);
      if (!choice.usable) expect(choice.reason).toBe("not-chat");
    }
  });

  it("never disables a model because of its name or a category derived from it", () => {
    // The shared parser files `qwen-vl` and `gpt-4o-omni` under vision by name;
    // the gateway still serves them over Chat Completions.
    for (const category of ["vision", "embedding", "video"] as const) {
      const choice = resolveDirectModel(model({ id: "qwen-vl-max", category }));
      expect(choice.usable, category).toBe(true);
    }
  });

  it("calls a model with an unimplemented chat protocol unsupported, not non-chat", () => {
    const choice = resolveDirectModel(model({ id: "claude", protocols: ["anthropic"] }));
    expect(choice.usable).toBe(false);
    if (!choice.usable) expect(choice.reason).toBe("unsupported-protocol");
  });
});

describe("splitting a catalog for the sheet", () => {
  it("lists usable models and explains the rest", () => {
    const list = splitDirectModels([
      model({ id: "gpt-4.1" }),
      model({ id: "dall-e-3", category: "vision", protocols: ["openai-images"] }),
      model({ id: "claude", protocols: ["anthropic-messages"] }),
      model({ id: "o4", protocols: ["openai-responses"] }),
    ]);
    expect(list.usable.map((entry) => entry.model.id)).toEqual(["gpt-4.1", "o4"]);
    expect(list.disabled.map((entry) => entry.model.id)).toEqual(["dall-e-3", "claude"]);
  });

  it("is empty when the catalog is", () => {
    expect(splitDirectModels([])).toEqual({ usable: [], disabled: [] });
  });
});

describe("the model a new conversation starts on", () => {
  const usable = [model({ id: "a" }), model({ id: "b" })];

  it("uses the account's last explicit choice while it is still offered", () => {
    expect(initialDirectModel(usable, "b")?.id).toBe("b");
  });

  it("asks the user to choose when that model is gone, rather than moving them", () => {
    expect(initialDirectModel(usable, "removed")).toBeNull();
  });

  it("has nothing chosen for a fresh account", () => {
    expect(initialDirectModel(usable, null)).toBeNull();
  });
});

describe("searching the sheet", () => {
  const models = [model({ id: "gpt-4.1", vendor: "OpenAI" }), model({ id: "qwen-max", vendor: "Alibaba Cloud" })];

  it("matches the id and the vendor, case-insensitively", () => {
    expect(filterDirectModels(models, "GPT").map((entry) => entry.id)).toEqual(["gpt-4.1"]);
    expect(filterDirectModels(models, "alibaba").map((entry) => entry.id)).toEqual(["qwen-max"]);
  });

  it("returns the list unchanged for an empty query", () => {
    expect(filterDirectModels(models, "   ").map((entry) => entry.id)).toEqual(["gpt-4.1", "qwen-max"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterDirectModels(models, "zzz")).toEqual([]);
  });
});

describe("effective chat model resolution (ADR D2)", () => {
  const models = [
    model({ id: "gpt-4.1" }),
    model({ id: "claude", protocols: ["anthropic-messages"] }),
    model({ id: "dall-e-3", protocols: ["openai-images"] }),
    model({ id: "o4", protocols: ["openai-responses"] }),
  ];

  it("uses configured default chat model if usable", () => {
    const result = resolveEffectiveChatModel(models, "gpt-4.1", "o4");
    expect(result.model?.id).toBe("gpt-4.1");
    if (result.model) expect(result.source).toBe("default");
  });

  it("does not silently fall back to lastModelId if configured default is unavailable or removed", () => {
    const result = resolveEffectiveChatModel(models, "removed-model", "o4");
    expect(result.model).toBeNull();
    if (!result.model) expect(result.reason).toBe("unavailable");
  });

  it("does not silently fall back to lastModelId if configured default is non-usable (e.g. image model)", () => {
    const result = resolveEffectiveChatModel(models, "dall-e-3", "o4");
    expect(result.model).toBeNull();
    if (!result.model) expect(result.reason).toBe("unavailable");
  });

  it("falls back to lastModelId when no explicit default exists and lastModel is usable", () => {
    const result = resolveEffectiveChatModel(models, null, "o4");
    expect(result.model?.id).toBe("o4");
    if (result.model) expect(result.source).toBe("last");
  });

  it("returns none if neither default nor lastModel is available", () => {
    const result = resolveEffectiveChatModel(models, null, null);
    expect(result.model).toBeNull();
    if (!result.model) expect(result.reason).toBe("none");
  });
});

describe("effective image model resolution (ADR D2)", () => {
  const models = [
    model({ id: "gpt-4.1" }),
    model({ id: "dall-e-3", protocols: ["openai-images"] }),
  ];

  it("recognizes image models", () => {
    expect(isImageModel(models[0]!)).toBe(false);
    expect(isImageModel(models[1]!)).toBe(true);
  });

  it("returns valid default image model", () => {
    expect(resolveEffectiveImageModel(models, "dall-e-3")?.id).toBe("dall-e-3");
    expect(resolveEffectiveImageModel(models, "gpt-4.1")).toBeNull();
    expect(resolveEffectiveImageModel(models, null)).toBeNull();
  });

/**
 * Image input is authorized by the gateway's declaration alone (ADR D5). A name
 * or a UI category is not evidence, and "no declaration" is a third answer
 * rather than a "no": the screen tells the user what it cannot verify.
 */
describe("whether a model accepts images", () => {
  it("is supported when the gateway declares the image modality", () => {
    const vision = model({ id: "qwen-vl-max", inputModalities: ["text", "image"] });
    expect(checkModelVisionCapability(vision)).toBe("supported");
  });

  it("is unsupported when the gateway declares modalities without images", () => {
    expect(checkModelVisionCapability(model({ id: "gpt-4.1", inputModalities: ["text"] }))).toBe(
      "unsupported",
    );
    expect(checkModelVisionCapability(model({ id: "x", inputModalities: [] }))).toBe("unsupported");
  });

  it("is unknown when the gateway did not say", () => {
    // No declaration at all, and no model to ask about.
    expect(checkModelVisionCapability(model({ id: "mystery" }))).toBe("unknown");
    expect(checkModelVisionCapability(null)).toBe("unknown");
    expect(checkModelVisionCapability(undefined)).toBe("unknown");
  });

  it("never infers an answer from the id or the category", () => {
    // A name that looks like a vision model is still only a name.
    expect(checkModelVisionCapability(model({ id: "qwen-vl-max", category: "vision" }))).toBe("unknown");
    expect(checkModelVisionCapability(model({ id: "omni", category: "chat" }))).toBe("unknown");
  });
});
});
