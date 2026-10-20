import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { createServer } from "vite";

/**
 * The AI-settings row that names the model a session the Agent creates for
 * itself runs on (ADR session-create-tool).
 *
 * The row is the user's opt-in: while nothing is selected the built-in
 * `SessionCreate` tool refuses, so the row must show "not configured" rather
 * than a model the runtime would never use, must keep showing a pairing the
 * provider list no longer offers (so it can be repaired), and must hide itself
 * only when there is no runnable candidate at all.
 */

async function loadModules() {
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const row = await vite.ssrLoadModule("/src/components/settings/SessionCreateModelRow.tsx");
  return { vite, ...row };
}

async function i18nInstance(locale = "en") {
  const { catalogs } = await import("@minih-agent/i18n");
  const i18n = createInstance();
  await i18n.init({ lng: locale, resources: { [locale]: { translation: catalogs[locale] } } });
  return i18n;
}

/** A runnable provider row; `over` overrides any field. */
function provider(id, modelIds, over = {}) {
  return {
    id,
    name: `Provider ${id}`,
    enabled: true,
    hasSecret: true,
    authKind: "api_key_and_base_url",
    baseUrl: "https://example.test/v1",
    models: modelIds.map((modelId) => ({ id: modelId })),
    ...over,
  };
}

async function renderRow(modules, settings, providers, locale = "en") {
  const i18n = await i18nInstance(locale);
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(modules.SessionCreateModelRow, { settings, providers, onChange: () => {} }),
    ),
  );
}

test("the row shows the configured model, the unset state and a stale pairing", async (t) => {
  const modules = await loadModules();
  t.after(() => modules.vite.close());
  const providers = [provider("p1", ["m1", "m2"])];

  const resolved = await renderRow(modules, { sessionCreateModel: { providerId: "p1", modelId: "m1" } }, providers);
  assert.match(resolved, /Session creation model/);
  assert.match(resolved, /Provider p1/);
  assert.match(resolved, /m1/);
  assert.doesNotMatch(resolved, /Not configured/);

  // Model identity is compared case-insensitively, the way the runtime resolves
  // it: a differently-cased id is the same model, not a stale pairing.
  const cased = await renderRow(modules, { sessionCreateModel: { providerId: "p1", modelId: "M1" } }, providers);
  assert.match(cased, /m1/);
  assert.doesNotMatch(cased, /Currently unavailable/);

  const unset = await renderRow(modules, {}, providers);
  assert.match(unset, /Not configured/);
  assert.match(unset, /Do not create sessions/);

  // A pairing the provider list no longer serves stays visible as unavailable,
  // so the user can see what is wrong and pick another one.
  const stale = await renderRow(modules, { sessionCreateModel: { providerId: "p1", modelId: "gone" } }, providers);
  assert.match(stale, /Currently unavailable/);
  assert.doesNotMatch(stale, /Not configured/);

  // No runnable provider means no choice to offer, so the row disappears
  // instead of claiming a model the runtime cannot launch.
  const hidden = await renderRow(modules, {}, [provider("p1", ["m1"], { hasSecret: false })]);
  assert.equal(hidden, "");
});

test("the picker offers every runnable model and a way back to unset", async (t) => {
  const modules = await loadModules();
  t.after(() => modules.vite.close());
  const providers = [provider("p1", ["m1", "m2"]), provider("p2", ["m3"])];

  assert.deepEqual(
    modules.sessionCreateModelCandidates({}, providers)
      .map((candidate) => `${candidate.provider.id}/${candidate.modelId}`),
    ["p1/m1", "p1/m2", "p2/m3"],
  );

  // The trigger names the current choice, and an unset setting reads as the
  // explicit off option: the row never invents a model the user did not pick.
  const html = await renderRow(modules, { sessionCreateModel: { providerId: "p1", modelId: "m1" } }, providers);
  assert.match(html, /Provider p1 · m1/);
  const unset = await renderRow(modules, {}, providers);
  assert.match(unset, /Do not create sessions/);
});

test("the candidates exclude the image models the settings page excludes", async (t) => {
  const modules = await loadModules();
  t.after(() => modules.vite.close());
  const providers = [provider("p1", ["m1", "m2", "image-1"])];
  const modelIds = (settings) =>
    modules.sessionCreateModelCandidates(settings, providers).map((candidate) => candidate.modelId);

  // The stored candidate list merged with the active default is the set the
  // create path resolves too, so the row and the tool agree on what is usable.
  assert.deepEqual(modelIds({}), ["m1", "m2", "image-1"]);
  assert.deepEqual(modelIds({ imageGenerationModels: [{ providerId: "p1", modelId: "image-1" }] }), ["m1", "m2"]);
  assert.deepEqual(modelIds({ imageGeneration: { providerId: "p1", modelId: "m2" } }), ["m1", "image-1"]);
  assert.deepEqual(
    modelIds({
      imageGenerationModels: [{ providerId: "p1", modelId: "IMAGE-1" }],
    }),
    ["m1", "m2"],
  );

  // A pairing the row excludes is what the row shows as unavailable, so the
  // user sees why the configured model stopped being usable.
  const stale = await renderRow(
    modules,
    {
      sessionCreateModel: { providerId: "p1", modelId: "image-1" },
      imageGenerationModels: [{ providerId: "p1", modelId: "image-1" }],
    },
    providers,
  );
  assert.match(stale, /Currently unavailable/);
});

test("a menu selection resolves to a binding, and only to one the row offered", async (t) => {
  const modules = await loadModules();
  t.after(() => modules.vite.close());
  const candidates = modules.sessionCreateModelCandidates({}, [provider("p1", ["m1"])]);

  const id = modules.sessionCreateModelOptionId({ providerId: "p1", modelId: "m1" });
  assert.deepEqual(modules.sessionCreateModelOptionBinding(candidates, id), {
    providerId: "p1",
    modelId: "m1",
  });
  // The explicit off choice clears the setting; an id the row never offered
  // resolves to nothing rather than to some other pairing.
  assert.equal(modules.sessionCreateModelOptionBinding(candidates, modules.SESSION_CREATE_MODEL_NONE), null);
  assert.equal(modules.sessionCreateModelOptionBinding(candidates, "p9\u0000gone"), null);
});

test("every locale carries the session creation model copy", async () => {
  const { catalogs } = await import("@minih-agent/i18n");
  const keys = [
    "sessionCreateModel",
    "sessionCreateModelUnset",
    "sessionCreateModelUnavailable",
    "sessionCreateModelNone",
    "sessionCreateModelHint",
    "sessionCreateModelSaveFailed",
    "sessionCreateModelSelected",
  ];
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const key of keys) {
      assert.equal(typeof catalog.settings[key], "string", `${locale} is missing settings.${key}`);
      assert.ok(catalog.settings[key].trim().length > 0, `${locale} settings.${key} is empty`);
    }
    if (locale !== "en") {
      assert.notEqual(catalog.settings.sessionCreateModel, catalogs.en.settings.sessionCreateModel, locale);
      assert.notEqual(catalog.settings.sessionCreateModelHint, catalogs.en.settings.sessionCreateModelHint, locale);
    }
  }
});
