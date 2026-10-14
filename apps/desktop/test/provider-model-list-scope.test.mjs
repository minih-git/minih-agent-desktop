/**
 * What `modelsForProvider` lists from the bundled models.dev snapshot.
 *
 * The settings picker no longer answers from this snapshot when a service
 * publishes no model list of its own — the service is the authority on what it
 * serves, and a directory stand-in would make a rejected key look ready to
 * save. The catalog read itself remains the enrichment source for discovery
 * answers and session/agent model lookups, so its scope contract still holds:
 * the default list stays what a session can run, and the wider list is the
 * same set plus the endpoints a text-only filter hides.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { ModelsDevCatalog } = await import("../electron/main/models-dev-catalog.ts");

const catalogPath = new URL("../resources/models.dev/api.json", import.meta.url).pathname;

async function loadedCatalog() {
  const catalog = new ModelsDevCatalog({ catalogPath });
  assert.equal(await catalog.ensureLoaded(), true);
  return catalog;
}

/** A model whose published modalities are text in and text out. */
const isTextModel = (model) =>
  model.modalities.input.includes("text") && model.modalities.output.includes("text");

test("the catalog read can ask for every model a provider publishes", async () => {
  const catalog = await loadedCatalog();
  const input = { vendorKey: "openai", providerId: "row" };
  const textOnly = catalog.modelsForProvider(input);

  assert.ok(textOnly.length > 0, "the bundled snapshot publishes openai text models");
  assert.ok(textOnly.every(isTextModel), "the default list stays what a session can run");

  const all = catalog.modelsForProvider({ ...input, includeNonChat: true });
  // Nothing is dropped when the list widens: it is the same set plus the
  // endpoints a text-only filter hides.
  for (const model of textOnly) {
    assert.ok(
      all.some((entry) => entry.modelId === model.modelId),
      `${model.modelId} disappeared from the wider list`,
    );
  }
  assert.ok(all.length > textOnly.length, "some published model is not a text model");
  assert.ok(
    all.some((model) => !isTextModel(model)),
    "the extra rows are the non-text endpoints the picker has to show",
  );
});

test("the wider list keeps one record per id and stays attributed to the provider", async () => {
  const catalog = await loadedCatalog();
  const models = catalog.modelsForProvider({
    vendorKey: "openai",
    providerId: "row-wide",
    includeNonChat: true,
  });
  const ids = models.map((model) => model.modelId.toLowerCase());
  assert.equal(new Set(ids).size, ids.length, "an id is listed once");
  assert.ok(models.every((model) => model.providerId === "row-wide"));
});
