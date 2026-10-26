import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { catalogs } from "@minih-agent/i18n";

/*
 * A plugin may declare a `model` setting, and the host fills its options from
 * the live ready-model list instead of the manifest (plugin-sdk refuses an
 * author `enum` there). This pins the mapping the settings sheet receives, and
 * the sheet's own side of the contract: one select, one "app default" row, and
 * a label for that row in every locale.
 */

const {
  defaultModelLabel,
  modelSettingOptions,
  pluginSettingsView,
} = await import("../electron/main/plugin-settings-view.ts");

const models = [
  {
    key: "minimax/m2",
    providerId: "minimax",
    providerName: "MiniMax",
    modelId: "m2",
    label: "m2 (MiniMax)",
    isDefault: true,
    supportsReasoning: true,
    thinkingLevels: ["off"],
  },
  {
    key: "anthropic/haiku",
    providerId: "anthropic",
    providerName: "Anthropic",
    modelId: "haiku",
    label: "haiku (Anthropic)",
    alias: "快",
    isDefault: false,
    supportsReasoning: false,
    thinkingLevels: ["off"],
  },
];

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the options are the ready models, keyed the way agent.complete takes them", () => {
  assert.deepEqual(modelSettingOptions(models), [
    { label: "m2 (MiniMax)", value: "minimax/m2" },
    // A user alias is what Settings shows, so the sheet shows it too.
    { label: "快 · haiku (Anthropic)", value: "anthropic/haiku" },
  ]);
  assert.deepEqual(modelSettingOptions(), []);
});

test("the default label names the model the app would use", () => {
  assert.equal(defaultModelLabel(models), "m2 (MiniMax)");
  // No default flagged: the first ready model is what launch falls back to.
  assert.equal(defaultModelLabel([models[1]]), "haiku (Anthropic)");
  assert.equal(defaultModelLabel([]), "");
});

test("a model field carries the live options and keeps the stored key", () => {
  const view = pluginSettingsView(
    [
      { key: "model", title: "Model", type: "model", default: "" },
      { key: "model2", title: "Model 2", type: "model", default: "" },
    ],
    { model: "anthropic/haiku" },
    models,
  );
  assert.deepEqual(view[0].enum, modelSettingOptions(models));
  assert.equal(view[0].defaultModelLabel, "m2 (MiniMax)");
  assert.equal(view[0].value, "anthropic/haiku");
  // Nothing stored yet falls back to the declared default; the empty string
  // means "the app default", which the sheet renders as its first row.
  assert.equal(view[1].value, "");
  assert.equal(view[0].scope, "plugin");
});

test("every other type passes through as it always has", () => {
  const view = pluginSettingsView(
    [
      { key: "target", title: "Language", type: "select", default: "zh-CN", enum: [{ label: "中文", value: "zh-CN" }] },
      { key: "note", title: "Note", type: "string", description: "help", default: "" },
    ],
    {},
    models,
  );
  assert.deepEqual(view[0], {
    key: "target",
    title: "Language",
    type: "select",
    default: "zh-CN",
    enum: [{ label: "中文", value: "zh-CN" }],
    scope: "plugin",
    value: "zh-CN",
  });
  assert.equal(view[1].description, "help");
  assert.equal(view[1].enum, undefined);
  assert.equal(view[1].defaultModelLabel, undefined);
});

test("a plugin without settings, and a host without models, still answer", () => {
  assert.deepEqual(pluginSettingsView(undefined, {}), []);
  const view = pluginSettingsView([{ key: "model", title: "Model", type: "model" }], {}, []);
  assert.deepEqual(view[0].enum, []);
  assert.equal(view[0].defaultModelLabel, "");
});

test("the sheet draws a model field as one select with an app-default row", () => {
  const sheet = read("src/components/plugins/PluginSettingsSheet.tsx");
  assert.match(sheet, /setting\.type === "model" \?/);
  assert.match(sheet, /t\("plugins\.settingsModelDefault"\)/);
  // The row value is the model key itself, not an index into the enum.
  assert.match(sheet, /onChange=\{\(id\) => setValue\(setting\.key, id\)\}/);
});

test("every locale names the app-default row", () => {
  for (const [locale, catalog] of Object.entries(catalogs)) {
    assert.equal(
      typeof catalog.plugins?.settingsModelDefault,
      "string",
      `plugins.settingsModelDefault is missing from ${locale}`,
    );
  }
});