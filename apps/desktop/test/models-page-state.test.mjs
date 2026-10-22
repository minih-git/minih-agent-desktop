/**
 * The models page's pure planning: how a gateway plaza row becomes a binding,
 * how the chosen list changes, and which app defaults move with it.
 *
 * The page itself only performs I/O; every decision that can leave a dangling
 * default or a duplicated binding is asserted here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  bindingAfterRemoval,
  bindingFromRouterModel,
  hiddenIdsWithout,
  hiddenIdsWith,
  hiddenModelIdsFor,
  mergeAddedBindings,
  missingCatalogModels,
  planCatalogSync,
  planModelsSave,
  sameHiddenIds,
} from "../src/components/settings/models-page-state.ts";

/** A gateway plaza row as the models endpoint reports it. */
const plazaModel = (id, contextWindow = null) => ({
  id,
  upstreamIds: [],
  vendor: "Vendor",
  category: "chat",
  protocols: ["openai-completions"],
  price: { input: "1", output: "2", cacheRead: null, cacheWrite: null },
  multiplePrices: false,
  tieredPricing: false,
  contextWindow,
  maxOutput: null,
});

const provider = (overrides = {}) => ({
  id: "router-1",
  name: "Minih Router",
  vendorKey: "minih-router",
  type: "openai_compatible",
  protocol: "openai_compatible",
  authKind: "api_key_and_base_url",
  apiStyle: "chat_completions",
  baseUrl: "https://router.hmini.org/v1",
  hasSecret: true,
  enabled: true,
  models: [],
  ...overrides,
});

test("a plaza row seeds a binding that still follows the catalog", () => {
  const seeded = bindingFromRouterModel(plazaModel("gpt-4.1", 1_047_576));
  assert.equal(seeded.id, "gpt-4.1");
  assert.equal(seeded.contextWindow, 1_047_576);
  // The gateway's number is the best known published value, not a pin: a later
  // models.dev correction still reaches the binding.
  assert.equal(seeded.contextWindowSource, "catalog");
  assert.equal(seeded.apiStyle, undefined);

  // Without a published window the generic seed stands, so models.dev can still
  // take the limits over later.
  const unknown = bindingFromRouterModel(plazaModel("mystery"));
  assert.equal(unknown.contextWindowSource, "catalog");
  assert.equal(unknown.apiStyle, undefined);
});

test("a published models.dev record auto-configures the added binding", () => {
  const info = {
    modelId: "gpt-4.1",
    displayName: "gpt-4.1",
    providerId: "minih-router",
    reasoning: true,
    thinkingLevelMap: { minimal: "minimal", low: "low", high: "high" },
    modalities: { input: ["text", "image"] },
    limit: { context: 400_000, output: 16_384 },
  };
  const seeded = bindingFromRouterModel(plazaModel("gpt-4.1", 1_047_576), info);
  // The catalog's numbers and thinking ladder arrive configured, and the
  // capabilities follow the published record instead of defaulting to off.
  assert.equal(seeded.contextWindow, 400_000);
  assert.equal(seeded.contextWindowSource, "catalog");
  assert.deepEqual(seeded.thinkingLevels, ["minimal", "low", "high"]);
  // No published "medium": the default is the ladder's first enabled level.
  assert.equal(seeded.defaultThinkingLevel, "minimal");
  assert.equal(seeded.supportsImages, null);
  assert.equal(seeded.supportsDocuments, null);

  // A record without limits keeps the gateway's own window as the fallback.
  const sparse = { ...info, limit: undefined, contextWindow: undefined };
  const fallback = bindingFromRouterModel(plazaModel("gpt-4.1", 1_047_576), sparse);
  assert.equal(fallback.contextWindow, 1_047_576);
});

test("adding models appends the new ones once, keeping the saved order", () => {
  const current = [bindingFromRouterModel(plazaModel("a")), bindingFromRouterModel(plazaModel("b"))];
  const next = mergeAddedBindings(current, [
    plazaModel("c"),
    plazaModel("B"),
    plazaModel("d"),
  ]);
  assert.deepEqual(next.map((binding) => binding.id), ["a", "b", "c", "d"]);
  // The caller's list is untouched.
  assert.deepEqual(current.map((binding) => binding.id), ["a", "b"]);
});

test("removing a model matches the wire id case-insensitively", () => {
  const current = [bindingFromRouterModel(plazaModel("GPT-4.1")), bindingFromRouterModel(plazaModel("other"))];
  assert.deepEqual(
    bindingAfterRemoval(current, "gpt-4.1").map((binding) => binding.id),
    ["other"],
  );
});

test("a save hands the row the new list and lets the first binding lead", () => {
  const row = provider({ models: [bindingFromRouterModel(plazaModel("old"))] });
  const nextBindings = [bindingFromRouterModel(plazaModel("new"))];
  const plan = planModelsSave(
    row,
    nextBindings,
    { defaultProviderId: "", defaultModelId: "" },
    [row],
  );
  assert.equal(plan.provider.id, "router-1");
  assert.deepEqual(plan.provider.models.map((binding) => binding.id), ["new"]);
  assert.equal(plan.provider.defaultModelId, "new");
  // Nothing runnable was selected before, so the app default is claimed.
  assert.equal(plan.settings?.defaultProviderId, "router-1");
  assert.equal(plan.settings?.defaultModelId, "new");
});

test("a working app default survives a save that adds another model", () => {
  const row = provider({ models: [bindingFromRouterModel(plazaModel("keep"))] });
  const plan = planModelsSave(
    row,
    [bindingFromRouterModel(plazaModel("keep")), bindingFromRouterModel(plazaModel("extra"))],
    { defaultProviderId: "router-1", defaultModelId: "keep" },
    [row],
  );
  // The row's own default follows its first binding; the app default stays put
  // and no settings write is planned at all.
  assert.equal(plan.provider.defaultModelId, "keep");
  assert.equal(plan.settings, null);
});

test("removing the model the app default names does not invent a replacement", () => {
  const row = provider({ models: [bindingFromRouterModel(plazaModel("only"))] });
  const plan = planModelsSave(
    row,
    [],
    { defaultProviderId: "router-1", defaultModelId: "only" },
    [row],
  );
  assert.deepEqual(plan.provider.models, []);
  // No `defaultModelId` is written for an empty row, and the stored default is
  // left for the next model the user adds.
  assert.equal("defaultModelId" in plan.provider, false);
  assert.equal(plan.settings, null);
});

test("an explicit image selection designates the row's image models", () => {
  const row = provider({ models: [bindingFromRouterModel(plazaModel("gpt-image"))] });
  const plan = planModelsSave(
    row,
    [bindingFromRouterModel(plazaModel("gpt-image"))],
    { defaultProviderId: "router-1", defaultModelId: "gpt-image" },
    [row],
    ["gpt-image"],
  );
  // The designated model becomes a candidate and claims the image default,
  // exactly like the service dialog's image checkbox did.
  assert.deepEqual(plan.settings?.imageGenerationModels, [
    { providerId: "router-1", modelId: "gpt-image" },
  ]);
  assert.deepEqual(plan.settings?.imageGeneration, {
    providerId: "router-1",
    modelId: "gpt-image",
  });
});

test("an image binding naming a removed model is dropped with its default", () => {
  const row = provider({
    models: [bindingFromRouterModel(plazaModel("gpt-image")), bindingFromRouterModel(plazaModel("chat"))],
  });
  const plan = planModelsSave(
    row,
    [bindingFromRouterModel(plazaModel("chat"))],
    {
      defaultProviderId: "router-1",
      defaultModelId: "chat",
      imageGenerationModels: [{ providerId: "router-1", modelId: "gpt-image" }],
      imageGeneration: { providerId: "router-1", modelId: "gpt-image" },
    },
    [row],
  );
  assert.deepEqual(plan.settings?.imageGenerationModels, []);
  assert.equal(plan.settings?.imageGeneration, null);
  // The chat default still resolves, so it is not rewritten.
  assert.equal(plan.settings?.defaultModelId, undefined);
});

test("the catalog mirror carries every model the account serves", () => {
  const current = [bindingFromRouterModel(plazaModel("a"))];
  const catalog = [plazaModel("a"), plazaModel("b"), plazaModel("c")];
  const next = planCatalogSync(current, catalog, []);
  assert.deepEqual(next?.map((binding) => binding.id), ["a", "b", "c"]);
  // The row's own entry is the caller's object, not a re-seeded copy: a
  // configured alias, limits or thinking ladder never move on a sync.
  assert.equal(next?.[0], current[0]);
  // A settled page plans nothing, which is what stops the mirror from looping.
  assert.equal(planCatalogSync(next, catalog, []), null);
});

test("a binding the gateway stopped listing stays on the row", () => {
  const current = [bindingFromRouterModel(plazaModel("kept")), bindingFromRouterModel(plazaModel("legacy"))];
  const next = planCatalogSync(current, [plazaModel("kept")], []);
  // Only an explicit removal leaves the list; a shorter plaza is not one.
  assert.equal(next, null);
});

test("a hidden model stays out of the mirror, and restoring it brings it back", () => {
  const catalog = [plazaModel("a"), plazaModel("b"), plazaModel("c")];
  const hidden = hiddenIdsWith([], "B");
  assert.deepEqual(hidden, ["b"]);
  assert.deepEqual(missingCatalogModels([], catalog, hidden).map((model) => model.id), ["a", "c"]);
  assert.deepEqual(
    planCatalogSync([], catalog, hidden)?.map((binding) => binding.id),
    ["a", "c"],
  );
  // Restoring the id drops it from the hidden list, so the next sync carries it.
  const restored = hiddenIdsWithout(hidden, ["b"]);
  assert.deepEqual(restored, []);
  assert.deepEqual(
    planCatalogSync([bindingFromRouterModel(plazaModel("a"))], catalog, restored)?.map(
      (binding) => binding.id,
    ),
    ["a", "b", "c"],
  );
});

test("a hidden model already on the row is dropped by the next sync", () => {
  const current = [bindingFromRouterModel(plazaModel("a")), bindingFromRouterModel(plazaModel("b"))];
  const next = planCatalogSync(current, [plazaModel("a"), plazaModel("b")], ["b"]);
  assert.deepEqual(next?.map((binding) => binding.id), ["a"]);
});

test("hidden ids are stored per provider row and compared as a set", () => {
  const stored = { "router-1": ["B", "a"], "router-2": ["c"] };
  assert.deepEqual(hiddenModelIdsFor(stored, "router-1"), ["b", "a"]);
  assert.deepEqual(hiddenModelIdsFor(stored, "router-3"), []);
  assert.deepEqual(hiddenModelIdsFor(null, "router-1"), []);
  assert.equal(sameHiddenIds(["b", "a"], ["a", "b", "A"]), true);
  assert.equal(sameHiddenIds(["a"], ["a", "b"]), false);
});

test("the mirror seeds only the models it appends from the catalog", () => {
  const asked = [];
  const next = planCatalogSync([bindingFromRouterModel(plazaModel("known"))], [plazaModel("known"), plazaModel("fresh", 400_000)], [], (model) => {
    asked.push(model.id);
    return model.id === "fresh" ? { modelId: "fresh", contextWindow: 1_000_000 } : null;
  });
  assert.deepEqual(asked, ["fresh"]);
  assert.deepEqual(next?.map((binding) => binding.id), ["known", "fresh"]);
  assert.equal(next?.[1]?.contextWindow, 1_000_000);
});

test("removing the model the app default names moves that default on", () => {
  const row = provider({
    models: [bindingFromRouterModel(plazaModel("primary")), bindingFromRouterModel(plazaModel("second"))],
  });
  const plan = planModelsSave(
    row,
    [bindingFromRouterModel(plazaModel("second"))],
    { defaultProviderId: "router-1", defaultModelId: "primary" },
    [row],
  );
  // The row still serves another model, but not the one the default names: a
  // stale id would launch sessions on a model the row no longer sends.
  assert.deepEqual(plan.settings?.defaultProviderId, "router-1");
  assert.deepEqual(plan.settings?.defaultModelId, "second");
});

test("a default resolving on another provider survives this row's save", () => {
  const row = provider({
    models: [bindingFromRouterModel(plazaModel("primary")), bindingFromRouterModel(plazaModel("second"))],
  });
  const other = provider({ id: "router-2", models: [bindingFromRouterModel(plazaModel("other"))] });
  const plan = planModelsSave(
    row,
    [bindingFromRouterModel(plazaModel("second"))],
    { defaultProviderId: "router-2", defaultModelId: "other" },
    [row, other],
  );
  assert.equal(plan.settings, null);
});
