import { describe, expect, it } from "vitest";

import type { MinihRouterModel } from "@minih-agent/shared";

import {
  capabilityChips,
  checkModelVisionCapability,
  filterDirectModels,
  initialDirectModel,
  isImageModel,
  modelCapability,
  resolveDirectImageModel,
  resolveDirectModel,
  resolveEffectiveChatModel,
  resolveEffectiveImageModel,
  resolveStudioModel,
  splitDirectImageModels,
  splitDirectModels,
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
    const choice = resolveDirectModel(
      model({ id: "gpt-image-2.5", protocols: real, outputModalities: ["image"] }),
    );
    expect(choice.usable).toBe(false);
    if (!choice.usable) expect(choice.reason).toBe("image-model");
  });

  it("explains an undeclared row without a chat protocol as not a chat model", () => {
    // No output declaration and no chat protocol. `openai-images` is the channel
    // type's union, not a claim about what the model produces, so the row is
    // neither a conversation model nor an image model.
    for (const protocols of [["openai-images"], ["openai-images", "openai-embeddings"]]) {
      const row = model({ id: "m", protocols });
      const choice = resolveDirectModel(row);
      expect(choice.usable, protocols.join(",")).toBe(false);
      if (!choice.usable) expect(choice.reason, protocols.join(",")).toBe("not-chat");
      expect(isImageModel(row), protocols.join(",")).toBe(false);
    }
    // The same row with a declared image output stays an image row, however the
    // channel union also lists chat protocols (D1).
    const declared = resolveDirectModel(
      model({ id: "gpt-image-2", protocols: ["openai-images", "openai-completions"], outputModalities: ["image"] }),
    );
    expect(declared).toMatchObject({ usable: false, reason: "image-model" });
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

/**
 * ADR mobile-redesign D1: capability comes from per-model output modalities.
 *
 * Router fills `protocols` from the channel type, so the OpenAI-compatible
 * channel makes every model it carries look like an image model. These cases
 * are the classification table of D1 and the report that produced it.
 */
describe("capability from declared output modalities", () => {
  /** What `/api/models` returns for a model on an OpenAI-compatible channel. */
  const channelUnion = ["openai-completions", "openai-responses", "openai-images"];

  it("offers a text model that the channel union also lists under openai-images", () => {
    const text = model({ id: "gpt-5", protocols: channelUnion, outputModalities: ["text"] });
    expect(resolveDirectModel(text).usable).toBe(true);
    expect(isImageModel(text)).toBe(false);
  });

  it("keeps a declared image model out of chat, whatever chat protocol the union adds", () => {
    const image = model({ id: "gpt-image-2", protocols: channelUnion, outputModalities: ["image"] });
    expect(resolveDirectModel(image)).toMatchObject({ usable: false, reason: "image-model" });
    expect(isImageModel(image)).toBe(true);
  });

  it("offers a model that declares both, and lets the entry point choose the operation", () => {
    const both = model({
      id: "gemini-3.1-flash-image",
      protocols: channelUnion,
      outputModalities: ["text", "image"],
    });
    expect(resolveDirectModel(both).usable).toBe(true);
    expect(isImageModel(both)).toBe(true);
    expect(capabilityChips(both)).toEqual(["chat", "image"]);
  });

  it("reads an undeclared row as chat, and never as an image model", () => {
    // Two shapes of one rule. Image output is declared per model by the gateway,
    // so neither row is offered for image work — the protocols are the channel's
    // union, not a claim about what the model produces.
    const undeclared = model({ id: "unlisted", protocols: ["openai-completions", "openai-responses"] });
    expect(resolveDirectModel(undeclared).usable).toBe(true);
    expect(isImageModel(undeclared)).toBe(false);

    const unlisted = model({ id: "gpt-image-2.5", protocols: channelUnion });
    expect(resolveDirectModel(unlisted).usable).toBe(true);
    expect(isImageModel(unlisted)).toBe(false);
    expect(capabilityChips(unlisted)).toEqual(["chat"]);
    expect(splitDirectImageModels([unlisted])).toMatchObject({
      usable: [],
      disabled: [{ model: unlisted, reason: "not-image" }],
    });
  });

  it("does not turn openai-images alone into an image model either", () => {
    const legacy = model({ id: "legacy-image", protocols: ["openai-images"] });
    expect(resolveDirectImageModel(legacy)).toMatchObject({ usable: false, reason: "not-image" });
    expect(resolveDirectModel(legacy).usable).toBe(false);
  });

  it("offers a declared image model for generation, whatever the protocols say", () => {
    const declared = model({ id: "declared-image", protocols: channelUnion, outputModalities: ["image"] });
    expect(isImageModel(declared)).toBe(true);
    expect(capabilityChips(declared)).toEqual(["image"]);
    // Declared image and no text: not a conversation model.
    expect(resolveDirectModel(declared).usable).toBe(false);
  });

  it("reads a declared embedding output as neither chat nor image", () => {
    const embedding = model({
      id: "text-embedding-3",
      protocols: ["openai-embeddings"],
      outputModalities: ["embedding"],
    });
    expect(resolveDirectModel(embedding)).toMatchObject({ usable: false, reason: "not-chat" });
    expect(isImageModel(embedding)).toBe(false);
  });

  it("lists only the rows the gateway declared as image output", () => {
    const declared = model({ id: "gpt-image-2", outputModalities: ["image"] });
    const legacy = model({ id: "legacy-image", protocols: ["openai-images"] });
    const text = model({ id: "gpt-5", outputModalities: ["text"] });
    const list = splitDirectImageModels([declared, legacy, text]);
    expect(list.usable).toEqual([declared]);
    expect(list.disabled.map((entry) => entry.model.id)).toEqual(["legacy-image", "gpt-5"]);
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
    model({ id: "dall-e-3", protocols: ["openai-images"], outputModalities: ["image"] }),
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

  it("selects nothing when the remembered image model has left the catalog", () => {
    // The catalog is refreshed now (A). A model the gateway withdrew must not be
    // selected from a stale choice: every generation on it would fail, and the
    // screen would look like the phone rather than the gateway was wrong.
    const afterWithdrawal = [model({ id: "gpt-4.1" })];
    expect(resolveStudioModel(afterWithdrawal, "gpt-image-2", "gpt-image-2")).toBeNull();
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

/**
 * The operator's "mobile chat" switch (spec §19.13).
 *
 * `false` is a deliberate decision and removes the model from conversations;
 * missing is an older gateway that never had the concept, and must keep working
 * exactly as before — reading silence as "nothing is enabled" would empty every
 * phone's chat list.
 */
describe("mobile_chat", () => {
  const chatReady = { id: "gpt-6-astra", outputModalities: ["text"] };

  it("keeps a model the operator did not open out of conversations", () => {
    const closed = model({ ...chatReady, mobileChat: false });
    // The model is still a chat model — the switch is a permission, not a
    // capability — but this device may not use it for a conversation.
    expect(modelCapability(closed).chat).toBe(true);
    expect(resolveDirectModel(closed)).toMatchObject({
      usable: false,
      reason: "not-enabled-for-mobile",
    });
    expect(splitDirectModels([closed]).usable).toEqual([]);
  });

  it("leaves an opened model, and a gateway that sends nothing, exactly as before", () => {
    // `true` is the operator saying yes; `undefined` is an older gateway.
    for (const mobileChat of [true, undefined]) {
      const row = model({ ...chatReady, ...(mobileChat === undefined ? {} : { mobileChat }) });
      expect(resolveDirectModel(row).usable).toBe(true);
      expect(splitDirectModels([row]).usable).toHaveLength(1);
    }
  });

  it("gates conversations only, never image work", () => {
    // The flag is about phones' chat lists; the studio reads the declared
    // output and nothing else.
    const imageModel = model({ id: "gpt-image-2.5", outputModalities: ["image"], mobileChat: false });
    expect(isImageModel(imageModel)).toBe(true);
    expect(splitDirectImageModels([imageModel]).usable).toHaveLength(1);
    expect(resolveDirectModel(imageModel)).toMatchObject({
      usable: false,
      reason: "not-enabled-for-mobile",
    });
  });
});
