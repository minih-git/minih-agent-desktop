/**
 * The user path of the gateway model profile.
 *
 * A `minih-router` row follows the operator's per-model profile until the user
 * changes a field in the model dialog; from then on that field is theirs. These
 * tests walk the whole path at the level the page plans it — page open, edit,
 * later sync, restore — because that sequence is the feature, not any one
 * function in it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  declaredProfileFields,
  pinRouterProfilePatch,
  restoreRouterProfileFollow,
} from "@minih-agent/shared";
import {
  bindingFromRouterModel,
  planCatalogImageModels,
  planCatalogSync,
} from "../src/components/settings/models-page-state.ts";

/** One `/api/models` entry that declares the whole profile. */
const gatewayModel = (overrides = {}) => ({
  id: "claude-sonnet-4.5",
  upstreamIds: [],
  vendor: "Anthropic",
  category: "chat",
  protocols: ["anthropic-messages"],
  price: { input: "3", output: "15", cacheRead: null, cacheWrite: null },
  multiplePrices: false,
  tieredPricing: false,
  contextWindow: 200_000,
  maxOutput: 64_000,
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

/** A binding as it was stored before the gateway profile existed. */
const legacyBinding = () => ({
  id: "claude-sonnet-4.5",
  contextWindow: 128_000,
  contextWindowSource: "catalog",
  maxTokens: 8_192,
  maxTokensSource: "catalog",
  thinkingLevels: [],
  defaultThinkingLevel: null,
  supportsImages: null,
  supportsDocuments: null,
});

test("opening the models page applies the profile to a row saved months ago", () => {
  const next = planCatalogSync([legacyBinding()], [gatewayModel()], []);
  assert.ok(next, "the row needed a write");
  assert.equal(next[0].alias, "Claude Sonnet 4.5");
  assert.equal(next[0].contextWindow, 200_000);
  assert.equal(next[0].contextWindowSource, "gateway");
  assert.deepEqual(next[0].thinkingLevels, ["off", "low", "medium", "high"]);
  assert.equal(next[0].defaultThinkingLevel, "medium");
  assert.equal(next[0].apiStyle, "anthropic_messages");
  assert.equal(next[0].supportsImages, true);
  assert.equal(next[0].nativeWebSearch, true);
  assert.equal(next[0].systemPrompt, "Answer in the user's language.");
});

test("a second read of the same profile writes nothing", () => {
  const once = planCatalogSync([legacyBinding()], [gatewayModel()], []);
  assert.equal(planCatalogSync(once, [gatewayModel()], []), null);
});

test("a field the user edits keeps their value, and the rest still follows", () => {
  const seeded = bindingFromRouterModel(gatewayModel());
  const edited = {
    ...seeded,
    ...pinRouterProfilePatch(seeded, { alias: "My Claude" }),
  };
  const next = planCatalogSync(
    [edited],
    [gatewayModel({ displayName: "Claude Sonnet 5", contextWindow: 250_000 })],
    [],
  );
  // The alias the user typed survives a profile that renamed the model...
  assert.equal(next[0].alias, "My Claude");
  assert.equal(next[0].profileSources.alias, "user");
  // ...and the field they never touched follows the new profile.
  assert.equal(next[0].contextWindow, 250_000);
});

test("a limit the user typed is pinned through its own marker", () => {
  const seeded = bindingFromRouterModel(gatewayModel());
  const edited = {
    ...seeded,
    ...pinRouterProfilePatch(seeded, { contextWindow: 96_000 }),
  };
  assert.equal(edited.contextWindow, 96_000);
  assert.equal(edited.contextWindowSource, "user");
  // Nothing left to write: the gateway's window may not replace the user's, and
  // every other declared field already matches.
  assert.equal(planCatalogSync([edited], [gatewayModel({ contextWindow: 250_000 })], []), null);
});

test("restoring the follow takes the gateway's value back", () => {
  const seeded = bindingFromRouterModel(gatewayModel());
  const edited = {
    ...seeded,
    ...pinRouterProfilePatch(seeded, { alias: "My Claude" }),
  };
  const restored = restoreRouterProfileFollow(
    edited,
    gatewayModel({ displayName: "Claude Sonnet 5" }),
  );
  assert.equal(restored.alias, "Claude Sonnet 5");
  assert.equal(restored.profileSources.alias, "gateway");
  // And the restored binding then keeps following.
  assert.equal(
    planCatalogSync([restored], [gatewayModel({ displayName: "Claude Sonnet 5" })], []),
    null,
  );
});

test("a field the user edits keeps their value", () => {
  const seeded = bindingFromRouterModel(gatewayModel());
  const edited = {
    ...seeded,
    ...pinRouterProfilePatch(seeded, { alias: "My Claude" }),
  };
  const next = planCatalogSync(
    [edited],
    [gatewayModel({ displayName: "Claude Sonnet 5", contextWindow: 250_000 })],
    [],
  );
  // The alias the user typed survives a profile that renamed the model...
  assert.equal(next[0].alias, "My Claude");
  assert.equal(next[0].profileSources.alias, "user");
  // ...and the field they never touched follows the new profile.
  assert.equal(next[0].contextWindow, 250_000);
});

test("the dialog offers a restore only when the gateway declares something", () => {
  assert.ok(declaredProfileFields(gatewayModel()).includes("alias"));
  assert.deepEqual(
    declaredProfileFields(
      gatewayModel({
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
      }),
    ),
    [],
  );
});

test("a gateway that says nothing about a model leaves the row alone", () => {
  const silent = gatewayModel({
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
  assert.equal(planCatalogSync([legacyBinding()], [silent], []), null);
  // The legacy limits are untouched, including their provenance.
  const stale = planCatalogSync([legacyBinding()], [], []);
  assert.equal(stale, null);
});

test("an image model the gateway publishes becomes usable, and stays un-designated once removed", () => {
  const image = gatewayModel({ id: "gpt-image-2", outputModalities: ["image"] });
  const bindings = [bindingFromRouterModel(image)];
  assert.deepEqual(planCatalogImageModels([], bindings, [image]), ["gpt-image-2"]);

  // The dialog's checkbox writes the designation and the pin together; here is
  // the binding side of that edit.
  const unchecked = {
    ...bindings[0],
    profileSources: { ...bindings[0].profileSources, imageGeneration: "user" },
  };
  assert.equal(planCatalogImageModels([], [unchecked], [image]), null);
});