import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { API_STYLES } = await import("@minih-agent/shared");
const { CUSTOM_PROVIDER_API_STYLES, MINIH_ROUTER_API_STYLES, needsCustomApiStyleChoice, providerSetupPreset } =
  await import("../src/components/settings/provider-api-style.ts");
const { copyProviderConfiguration } = await import("../src/components/settings/provider-copy.ts");

const source = (apiStyle) => ({
  id: "legacy", name: "Legacy custom", vendorKey: "custom", authKind: "api_key_and_base_url",
  apiStyle, baseUrl: "https://api.openai.com/v1", hasSecret: true,
  models: [{ id: "fixture", contextWindow: 32000, maxTokens: 4000,
    thinkingLevels: ["off"], defaultThinkingLevel: "off" }],
});

test("custom creation offers general APIs without removing account or named transports", () => {
  assert.deepEqual(CUSTOM_PROVIDER_API_STYLES,
    ["chat_completions", "responses", "anthropic_messages", "google_generative_ai"]);
  for (const style of ["openai_codex_responses", "pi_messages", "opencode_go"]) {
    assert.ok(API_STYLES.includes(style));
  }
});

for (const style of ["openai_codex_responses", "pi_messages"]) {
  test(`${style} cannot be newly chosen, but a saved value can remain unchanged`, () => {
    assert.equal(needsCustomApiStyleChoice(style), true);
    assert.equal(needsCustomApiStyleChoice(style, style), false);
    assert.equal(needsCustomApiStyleChoice(style, "responses"), true);
    assert.equal(needsCustomApiStyleChoice("responses", style), false);
  });

  test(`legacy ${style} edit/copy keeps its protocol even on a named endpoint URL`, () => {
    const original = source(style);
    const before = structuredClone(original);
    assert.equal(providerSetupPreset(original), undefined);
    const copy = copyProviderConfiguration(original, "Copy");
    assert.equal(copy.apiStyle, style);
    assert.equal(copy.baseUrl, original.baseUrl);
    assert.equal(copy.id, undefined);
    assert.equal(copy.hasSecret, undefined);
    assert.equal(needsCustomApiStyleChoice(copy.apiStyle), true);
    assert.deepEqual(original, before);
  });
}

test("ordinary named services retain existing preset selection", () => {
  const preset = providerSetupPreset({ ...source("anthropic_messages"),
    vendorKey: "anthropic", baseUrl: "https://api.anthropic.com" });
  assert.equal(preset.apiStyle, "anthropic_messages");
  assert.equal(providerSetupPreset(null), undefined);
});

test("a named hostname cannot overwrite a manually saved protocol", () => {
  assert.equal(providerSetupPreset(source("chat_completions")), undefined);

});

test("a Minih Router row stays the Router service whatever format and address it saved", () => {
  for (const apiStyle of ["chat_completions", "responses", "anthropic_messages"]) {
    const preset = providerSetupPreset({ ...source(apiStyle),
      vendorKey: "minih-router", baseUrl: "http://11.11.11.10:3001/v1" });
    assert.equal(preset?.id, "minih-router", apiStyle);
  }
  // A custom row pointing at a Router address is not silently reclassified.
  assert.equal(providerSetupPreset({ ...source("responses"),
    baseUrl: "http://11.11.11.10:3001/v1" }), undefined);
});

test("the Router form offers only the formats a Router serves under /v1", () => {
  assert.deepEqual(MINIH_ROUTER_API_STYLES, ["chat_completions", "responses", "anthropic_messages"]);
});
