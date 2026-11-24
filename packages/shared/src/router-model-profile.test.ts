/**
 * Contract tests for the gateway model profile merge.
 *
 * A `minih-router` row follows the operator's per-model profile field by field
 * until the user changes a field, and these tests pin both halves of that rule:
 * what a profile writes, and what it must never overwrite.
 */
import { describe, expect, it } from "vitest";

import {
  bindingThinkingLevelsFromRouterModel,
  mergeRouterModelProfile,
  pinRouterProfilePatch,
  planRouterImageModelIds,
  profileFollowsGateway,
  restoreRouterProfileFollow,
} from "./router-model-profile.js";
import type { MinihRouterModel } from "./minih-router.js";
import type { ModelBinding } from "./types/models.js";

/** One `/api/models` entry that declares the whole profile. */
const profileModel = (overrides: Partial<MinihRouterModel> = {}): MinihRouterModel => ({
  id: "claude-sonnet-4.5",
  upstreamIds: [],
  vendor: "Anthropic",
  category: "chat",
  protocols: [],
  price: { input: null, output: null, cacheRead: null, cacheWrite: null },
  multiplePrices: false,
  tieredPricing: false,
  contextWindow: 200000,
  maxOutput: 64000,
  displayName: "Claude Sonnet 4.5",
  inputModalities: ["text", "image", "pdf"],
  reasoningLevels: ["none", "low", "medium", "high"],
  defaultReasoningLevel: "medium",
  thinkingProtocol: "adaptive",
  apiStyle: "anthropic_messages",
  kind: "chat",
  nativeWebSearch: true,
  systemPrompt: "Answer in the user's language.",
  ...overrides,
});

/** A binding as a model picked from the catalog is seeded. */
const binding = (overrides: Partial<ModelBinding> = {}): ModelBinding => ({
  id: "claude-sonnet-4.5",
  contextWindow: 128000,
  contextWindowSource: "catalog",
  maxTokens: 8192,
  maxTokensSource: "catalog",
  thinkingLevels: [],
  defaultThinkingLevel: null,
  supportsImages: null,
  supportsDocuments: null,
  ...overrides,
});

describe("mergeRouterModelProfile", () => {
  it("follows every field the gateway declares", () => {
    const merged = mergeRouterModelProfile(binding(), profileModel());
    expect(merged).not.toBeNull();
    expect(merged!.contextWindow).toBe(200000);
    expect(merged!.contextWindowSource).toBe("gateway");
    expect(merged!.maxTokens).toBe(64000);
    expect(merged!.maxTokensSource).toBe("gateway");
    expect(merged!.alias).toBe("Claude Sonnet 4.5");
    expect(merged!.thinkingLevels).toEqual(["off", "low", "medium", "high"]);
    expect(merged!.defaultThinkingLevel).toBe("medium");
    expect(merged!.thinkingProtocol).toBe("adaptive");
    expect(merged!.apiStyle).toBe("anthropic_messages");
    expect(merged!.supportsImages).toBe(true);
    expect(merged!.supportsDocuments).toBe(true);
    expect(merged!.nativeWebSearch).toBe(true);
    expect(merged!.systemPrompt).toBe("Answer in the user's language.");
    expect(merged!.profileSources).toMatchObject({
      alias: "gateway",
      thinkingLevels: "gateway",
      apiStyle: "gateway",
      supportsImages: "gateway",
      systemPrompt: "gateway",
      nativeWebSearch: "gateway",
    });
  });

  it("reports no change a second time, so a sync does not save every start", () => {
    const once = mergeRouterModelProfile(binding(), profileModel());
    expect(mergeRouterModelProfile(once!, profileModel())).toBeNull();
  });

  it("never overwrites a field the user pinned", () => {
    const pinned = binding({
      alias: "My Claude",
      profileSources: { alias: "user", apiStyle: "user" },
      apiStyle: "chat_completions",
    });
    const merged = mergeRouterModelProfile(pinned, profileModel());
    expect(merged!.alias).toBe("My Claude");
    expect(merged!.apiStyle).toBe("chat_completions");
    expect(merged!.profileSources?.alias).toBe("user");
    expect(merged!.profileSources?.apiStyle).toBe("user");
    // Everything the user did not touch still follows.
    expect(merged!.contextWindow).toBe(200000);
    expect(merged!.profileSources?.thinkingLevels).toBe("gateway");
  });

  it("reads a legacy record the way the historical rule does", () => {
    // No markers at all: a `user` limit, a typed alias and a typed prompt are
    // the user's own answers, everything else follows the gateway.
    const legacy = binding({
      contextWindow: 300000,
      contextWindowSource: "user",
      alias: "Work model",
      systemPrompt: "Be terse.",
    });
    const merged = mergeRouterModelProfile(legacy, profileModel());
    expect(merged!.contextWindow).toBe(300000);
    expect(merged!.contextWindowSource).toBe("user");
    expect(merged!.alias).toBe("Work model");
    expect(merged!.systemPrompt).toBe("Be terse.");
    // The output cap carries no marker, so it follows.
    expect(merged!.maxTokens).toBe(64000);
    expect(merged!.maxTokensSource).toBe("gateway");
  });

  it("leaves the local behaviour alone for a field the gateway omits", () => {
    const oldGateway = profileModel({
      contextWindow: null,
      maxOutput: null,
      displayName: undefined,
      inputModalities: undefined,
      reasoningLevels: undefined,
      defaultReasoningLevel: undefined,
      thinkingProtocol: undefined,
      apiStyle: undefined,
      kind: undefined,
      nativeWebSearch: undefined,
      systemPrompt: undefined,
    });
    const seeded = binding({
      alias: "Local name",
      thinkingLevels: ["off", "high"],
      defaultThinkingLevel: "high",
      apiStyle: "responses",
      supportsImages: null,
    });
    // Nothing declared means nothing written, including the ownership markers.
    expect(mergeRouterModelProfile(seeded, oldGateway)).toBeNull();
  });

  it("maps the gateway's own vocabulary onto the desktop ladder", () => {
    // `none` is the gateway's word for `off`; `ultra` and `persistent` have no
    // desktop equivalent and are dropped rather than re-mapped.
    const levels = bindingThinkingLevelsFromRouterModel(
      profileModel({
        reasoningLevels: ["none", "medium", "ultra", "persistent", "max"],
      }),
    );
    expect(levels).toEqual(["off", "medium", "max"]);
    // A model whose only declared level is one the desktop cannot send leaves
    // the local ladder alone instead of emptying it.
    const kept = mergeRouterModelProfile(
      binding({ thinkingLevels: ["off", "high"] }),
      profileModel({ reasoningLevels: ["ultra"], defaultReasoningLevel: undefined }),
    );
    expect(kept!.thinkingLevels).toEqual(["off", "high"]);
  });

  it("does not put an unreachable default ahead of the ladder", () => {
    const merged = mergeRouterModelProfile(
      binding(),
      profileModel({ reasoningLevels: ["none", "low"], defaultReasoningLevel: "high" }),
    );
    // The ladder follows; the default it cannot reach does not.
    expect(merged!.thinkingLevels).toEqual(["off", "low"]);
    expect(merged!.defaultThinkingLevel).toBeNull();
  });

  it("reads a declared input list as the operator's answer", () => {
    const merged = mergeRouterModelProfile(
      binding(),
      profileModel({ inputModalities: ["text"] }),
    );
    expect(merged!.supportsImages).toBe(false);
    expect(merged!.supportsDocuments).toBe(false);
  });

  it("clears an embedding mark when the gateway says the model is a chat model", () => {
    const merged = mergeRouterModelProfile(binding({ kind: "embedding" }), profileModel());
    expect(merged!.kind).toBeUndefined();
    expect(merged!.profileSources?.kind).toBe("gateway");
  });

  it("drops a native web search flag the gateway turned off", () => {
    const merged = mergeRouterModelProfile(
      binding({ nativeWebSearch: true }),
      profileModel({ nativeWebSearch: false }),
    );
    expect(merged!.nativeWebSearch).toBeUndefined();
    expect(merged!.profileSources?.nativeWebSearch).toBe("gateway");
  });

  it("caps an over-long alias instead of failing the save", () => {
    const merged = mergeRouterModelProfile(
      binding(),
      profileModel({ displayName: "x".repeat(120) }),
    );
    expect(merged!.alias).toHaveLength(60);
  });
});

describe("restoreRouterProfileFollow", () => {
  it("hands every field back to the gateway", () => {
    const merged = mergeRouterModelProfile(
      binding(),
      profileModel(),
    )!;
    const pinnedUser = {
      ...merged,
      alias: "Mine",
      contextWindow: 1000,
      contextWindowSource: "user" as const,
      profileSources: { ...merged.profileSources, alias: "user" as const },
    };
    const restored = restoreRouterProfileFollow(pinnedUser, profileModel());
    expect(restored.alias).toBe("Claude Sonnet 4.5");
    expect(restored.contextWindow).toBe(200000);
    expect(restored.contextWindowSource).toBe("gateway");
    expect(restored.profileSources?.alias).toBe("gateway");
  });

  it("keeps the local values when the gateway has no profile for the model", () => {
    const restored = restoreRouterProfileFollow(
      binding({ alias: "Mine", profileSources: { alias: "user" } }),
      null,
    );
    expect(restored.alias).toBe("Mine");
    expect(restored.profileSources).toBeUndefined();
  });
});

describe("pinRouterProfilePatch", () => {
  it("marks the edited field as the user's own answer", () => {
    const patched = pinRouterProfilePatch(binding({ profileSources: { alias: "gateway" } }), {
      alias: "Mine",
    });
    expect(patched.profileSources).toEqual({ alias: "user" });
  });

  it("pins a limit through its own marker", () => {
    const patched = pinRouterProfilePatch(binding(), { contextWindow: 96000 });
    expect(patched.contextWindowSource).toBe("user");
    expect(patched.profileSources?.contextWindow).toBeUndefined();
  });

  it("keeps the markers of fields the patch did not touch", () => {
    const patched = pinRouterProfilePatch(
      binding({ profileSources: { alias: "gateway", kind: "gateway" } }),
      { kind: "embedding" },
    );
    expect(patched.profileSources).toEqual({ alias: "gateway", kind: "user" });
  });
});

describe("planRouterImageModelIds", () => {
  const imageModel = profileModel({ id: "gpt-image-2", outputModalities: ["image"] });

  it("designates a model the gateway marks as image output", () => {
    const next = planRouterImageModelIds(
      [],
      [binding({ id: "gpt-image-2" })],
      [imageModel],
    );
    expect(next).toEqual(["gpt-image-2"]);
  });

  it("never re-adds a designation the user removed", () => {
    const pinned = binding({
      id: "gpt-image-2",
      profileSources: { imageGeneration: "user" },
    });
    expect(planRouterImageModelIds([], [pinned], [imageModel])).toBeNull();
  });

  it("reports no change for a model the gateway does not mark", () => {
    expect(
      planRouterImageModelIds(["gpt-image-2"], [binding({ id: "gpt-image-2" })], [
        profileModel({ id: "gpt-image-2", outputModalities: ["text"] }),
      ]),
    ).toBeNull();
  });
});

describe("profileFollowsGateway", () => {
  it("resolves a legacy record field by field", () => {
    const legacy = binding({ alias: "Typed" });
    expect(profileFollowsGateway(legacy, "alias")).toBe(false);
    expect(profileFollowsGateway(legacy, "systemPrompt")).toBe(true);
    expect(profileFollowsGateway({ ...legacy, maxTokensSource: "user" }, "maxTokens")).toBe(false);
    expect(profileFollowsGateway(legacy, "imageGeneration")).toBe(true);
  });

  it("lets an explicit marker win over the legacy inference", () => {
    const explicit = binding({
      alias: "Typed",
      profileSources: { alias: "gateway" },
    });
    expect(profileFollowsGateway(explicit, "alias")).toBe(true);
  });
});