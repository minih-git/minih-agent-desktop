import {
  readComposerSource,
  readMainModule,
  readMainSource,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

// The advanced body is the shared binding editor; the picker keeps the row
// shell and expand state. Both are read together so this contract still holds
// for every surface that edits a binding.
const pickerSource = await readFile(
  new URL("../src/components/settings/ModelSelectionPanes.tsx", import.meta.url),
  "utf8",
);
const bindingEditorSource = await readFile(
  new URL("../src/components/settings/ModelBindingFields.tsx", import.meta.url),
  "utf8",
);
const reasoningEffortSource = await readFile(
  new URL("../src/components/settings/ReasoningEffortSelect.tsx", import.meta.url),
  "utf8",
);
const advancedSource = [pickerSource, bindingEditorSource, reasoningEffortSource].join("\n");
const imageModelRowSource = await readFile(
  new URL("../src/components/settings/ImageGenerationModelRow.tsx", import.meta.url),
  "utf8",
);
const composerSource = await readComposerSource();
const capabilitiesSource = await readFile(
  new URL(
    "../../../packages/agent-runtime/src/model-capabilities.ts",
    import.meta.url,
  ),
  "utf8",
);
const catalogSource = await readFile(
  new URL("../../../packages/shared/src/model-catalog.ts", import.meta.url),
  "utf8",
);
const mainSource = await readMainSource();
const providerCatalogSource = await readMainModule("runtime/provider-catalog.ts");
const sidecarSource = await readFile(
  new URL("../../../packages/agent-runtime/src/sidecar.ts", import.meta.url),
  "utf8",
);
const styles = await loadStyles();

test("advanced settings choose the default thinking level among omit and the enabled ones", () => {
  // Offering the published ladder instead of the enabled subset would store a
  // default the runtime clamps away on the next request. omit is a client
  // selector, so it sits on the default picker rather than the capability chips.
  assert.match(advancedSource, /settings\.defaultThinkingLevel/);
  assert.match(advancedSource, /const enabledLevels = sortThinkingLevels\(/);
  assert.match(advancedSource, /bindingDefaultThinkingMenuLevels\(enabledLevels\)\.map/);
  assert.match(advancedSource, /defaultThinkingLevel: id as SessionThinkingLevel/);
  assert.match(advancedSource, /bindingDefaultThinkingMenuLevels\(enabledLevels\)\.length > 1 \?/);
});

test("advanced settings expose the model thinking protocol", () => {
  assert.match(advancedSource, /settings\.thinkingProtocol/);
  assert.match(advancedSource, /settings\.thinkingProtocolLegacy/);
  assert.match(advancedSource, /settings\.thinkingProtocolAdaptive/);
  assert.match(
    advancedSource,
    /binding\.thinkingProtocol\s*\?\?\s*info\?\.thinkingProtocol\s*\?\?\s*"legacy"/,
  );
  assert.match(advancedSource, /thinkingProtocol: id as ThinkingProtocol/);
});

test("the capability checkboxes show and follow the published value", () => {
  assert.match(advancedSource, /settings\.imageInput/);
  assert.match(advancedSource, /settings\.documentInput/);
  assert.match(advancedSource, /supportsImages: next/);
  assert.match(advancedSource, /supportsDocuments: next/);
  // A deliberate checkbox change pins the selected value even when it equals
  // today's catalog value; later catalog corrections must not undo that choice.
  assert.match(advancedSource, /onChange\(event\.target\.checked\)/);
  assert.match(
    advancedSource,
    /const effective = typeof value === "boolean" \? value : published/,
  );
  // The published baseline is models.dev, never the stored override.
  assert.match(advancedSource, /modelMatchesFilter\(info, "vision"\) : false/);
  assert.match(advancedSource, /modelMatchesFilter\(info, "pdf"\) : false/);
});

test("the capability row carries no explanatory copy or extra controls", () => {
  // The panel is a dense list of per-model rows; a hint paragraph and a reset
  // link per capability crowded it without telling the user anything the
  // checkbox state does not already say.
  assert.doesNotMatch(pickerSource, /documentInputHint/);
  assert.doesNotMatch(pickerSource, /followPublished/);
  assert.doesNotMatch(pickerSource, /capabilityPublished|capabilityUnknown/);
  assert.doesNotMatch(styles, /provider-chosen-capability-(reset|state|hint)/);
});


test("image generation selection hides the summary when nothing can be chosen", () => {
  assert.match(
    advancedSource,
    /className="provider-chosen-capability-rows">[\s\S]*?settings\.setImageModel/,
  );
  assert.doesNotMatch(
    pickerSource,
    /className="provider-chosen-advanced-toggle"[^\n]*settings\.setImageModel/,
  );
  assert.match(pickerSource, /imageModelIds\?\.some\([\s\S]*?modelId\.toLowerCase\(\) === binding\.id\.toLowerCase\(\)/);
  // The editor fires the shared callback; the picker only forwards it.
  assert.match(advancedSource, /onImageModelChange\(binding\.id, event\.target\.checked\)/);
  assert.match(pickerSource, /onImageModelChange=\{onImageModelChange\}/);
  // The row's own rule — the stored candidate list, the legacy single binding
  // only while no list was ever saved, plus a signed-in vendor account's image
  // model — now lives in the shared helper, pinned by image-generation-default.test.mjs.
  assert.ok(imageModelRowSource.includes("imageGenerationPickerCandidates("));
  assert.match(imageModelRowSource, /if \(!options\.some\(\(option\) => !option\.disabled\)\) return null;/);
  assert.match(imageModelRowSource, /if \(candidates\.length === 0\) return null;/);
  assert.match(imageModelRowSource, /imageModelUnavailable/);
});

test("the Composer model rows use the provider binding for vision badges", () => {
  assert.match(composerSource, /composerModelBadges\(model, group\.provider\)/);
});

test("capability overrides reach the transport modality arrays", () => {
  assert.match(capabilitiesSource, /function modalityOverride\(/);
  assert.match(capabilitiesSource, /nextInput\.add\("image"\)/);
  assert.match(capabilitiesSource, /nextInput\.add\("pdf"\)/);
  // Text input can never be dropped by an attachment override.
  assert.match(capabilitiesSource, /nextInput\.add\("text"\)/);
  // The adapter subset carries only blocks pi-ai can encode.
  assert.match(capabilitiesSource, /modality === "text" \|\| modality === "image"/);
  assert.match(catalogSource, /export function bindingSupportsImages\(/);
  assert.match(catalogSource, /export function bindingSupportsDocuments\(/);
});

test("the capability controls and default selector are styled", () => {
  assert.match(styles, /\.provider-chosen-capability-rows \{/);
  assert.match(styles, /\.provider-chosen-capability \{/);
  assert.match(styles, /\.provider-chosen-thinking-select \.settings-menu-select-trigger \{/);
  assert.match(styles, /\.provider-chosen-thinking-select \.settings-menu-select-trigger:focus-visible \{/);
});

test("selected thinking chips keep high contrast in both themes", () => {
  const selectedRule = styles.match(
    /\.provider-thinking-chip\.selected \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(selectedRule);
  assert.match(selectedRule, /background: var\(--ds-accent\)/);
  assert.match(selectedRule, /color: var\(--ds-bg-primary\)/);
});

test("thinking levels use a compact accessible grouped control", () => {
  assert.match(
    advancedSource,
    /className="provider-chosen-thinking-head">[\s\S]*?thinkingManualOverrideHint[\s\S]*?<\/div>\s*<div[\s\S]*?className="provider-chosen-thinking-chips"/,
  );
  assert.match(advancedSource, /role="group"/);
  assert.match(styles, /\.provider-chosen-thinking-head \{/);
  assert.match(styles, /\.provider-chosen-thinking-hint \{/);
  assert.match(
    styles,
    /\.provider-chosen-thinking-chips \{[\s\S]*?width: 100%;[\s\S]*?max-width: 100%;/,
  );
  assert.match(
    styles,
    /\.provider-chosen-thinking-chips \{[\s\S]*?grid-template-columns: repeat\(7, minmax\(0, 1fr\)\);/,
  );
  assert.match(
    styles,
    /\.provider-thinking-chip \{[\s\S]*?border: 0;[\s\S]*?transition:/,
  );
  assert.match(
    styles,
    /\.provider-thinking-chip:focus-visible \{[\s\S]*?outline:/,
  );
});

test("a configured model keeps its published record when discovery omits it", () => {
  // The checkboxes read models.dev through this record. The live branch used to
  // return only what the endpoint listed, so a configured model the service no
  // longer advertises lost its capabilities and both boxes read as unpublished.
  assert.match(mainSource, /const withConfiguredBindings =/);
  const unions = mainSource.match(/withConfiguredBindings\(/g) ?? [];
  assert.ok(unions.length >= 3, `expected 3+ union sites, saw ${unions.length}`);
  // Discovery stays the authority on what the service offers: only the rows it
  // returned are cached as discovered.
  const liveReturn = mainSource.slice(
    mainSource.indexOf("await cacheForCurrentProvider(models);"),
  );
  assert.match(liveReturn.slice(0, 260), /models: withConfiguredBindings\(models\)/);
});

test("the published record is not shaped by the stored override", () => {
  // ModelInfo.modalities is the baseline the panel compares against. Applying
  // the binding to it would make an override its own justification.
  assert.match(
    mainSource,
    /modalities: operationMetadata\?\.modalities \?\? catalogModelConfig\.modalities \?\? \{ input: \["text"\], output: \["text"\] \}/,
  );
  const decorate = mainSource.slice(
    mainSource.indexOf("const decorate ="),
    mainSource.indexOf("const withConfiguredBindings"),
  );
  assert.doesNotMatch(decorate, /reasoning: capabilities\.supportsReasoning/);
  assert.doesNotMatch(
    decorate,
    /supportedThinkingLevels: \[\.\.\.capabilities\.supportedThinkingLevels\]/,
  );
});

test("every image gate reads the override-shaped model config", () => {
  // Five independent reads used to answer "can this model see an image": the two
  // enrichment helpers, the sidecar launch params, the prompt transport gate and
  // history replay. A raw input.includes("image") on any of them would disagree
  // with the settings switch for exactly the models the override exists for.
  assert.doesNotMatch(mainSource, /modelConfig\?\.input\.includes\("image"\)/);
  assert.doesNotMatch(sidecarSource, /modelConfig\?\.input\.includes\("image"\)/);
  const gates = mainSource.match(/visionFromModelConfig\(/g) ?? [];
  assert.ok(gates.length >= 4, `expected 4+ vision gates, saw ${gates.length}`);
  assert.match(sidecarSource, /visionFromModelConfig\(params\.provider\.modelConfig\)/);
});

test("a model the catalog does not describe still reports its binding overrides", () => {
  // Both enrichment helpers use the same catalog-or-generic resolver and then
  // apply the binding, matching the launch path; returning undefined instead
  // would report no image support for a hand-typed id whose transport does
  // inline images.
  const providerBlock = providerCatalogSource.slice(
    providerCatalogSource.indexOf("const enrichProvider ="),
    providerCatalogSource.indexOf("const normalizeThinkingLevel ="),
  );
  const sessionBlock = providerCatalogSource.slice(
    providerCatalogSource.indexOf("const enrichSession ="),
    providerCatalogSource.indexOf(
      "\n  return {\n    bindingForModel",
      providerCatalogSource.indexOf("const enrichSession ="),
    ),
  );
  for (const block of [providerBlock, sessionBlock]) {
    assert.match(block, /modelConfigWithBinding\(/);
    assert.match(block, /catalogModelConfigFor\(modelsDevCatalog/);
    assert.match(block, /providerId: provider.id/);
  }
  assert.match(providerCatalogSource, /resolveBindingLimits\(catalogConfig, binding\)/);
});

test("the advanced body is a compact sheet without helper paragraphs", () => {
  // The generic Field + hint paragraph made the disclosure a stacked form dump
  // inside a half-pane. Labels stay 2xs, the alias hint is the help mark beside
  // the label, and the default selector sits on the thinking label row.
  assert.match(advancedSource, /className="provider-chosen-field"/);
  assert.match(
    advancedSource,
    /<HelpIcon label=\{t\("settings\.modelAliasHint"\)\} \/>/,
  );
  assert.doesNotMatch(advancedSource, /hint=\{t\("settings\.modelAliasHint"\)\}/);
  assert.match(pickerSource, /aria-controls=\{advancedId\}/);
  // Every row starts folded so chosen models stay scannable (D625).
  assert.match(pickerSource, /useState<string \| null>\(null\)/);
  assert.doesNotMatch(pickerSource, /models\[0\]\?\.id \?\? null/);
  assert.match(
    advancedSource,
    /className="provider-chosen-thinking-head">[\s\S]*?provider-chosen-thinking-default[\s\S]*?provider-chosen-thinking-chips/,
  );
  assert.match(
    advancedSource,
    /className="provider-chosen-capability-rows">[\s\S]*?provider-chosen-delegation/,
  );
  assert.match(styles, /\.provider-chosen-field \{/);
  assert.match(styles, /\.provider-chosen-row-body\[hidden\] \{/);
  assert.match(
    styles,
    /\.provider-chosen-advanced-toggle\[aria-expanded="true"\]/,
  );
  assert.match(
    styles,
    /input\[type="number"\]::-webkit-inner-spin-button/,
  );
});

test("the offered default and the saved default use one order", () => {
  // The panel lists enabled levels in canonical order; the save path must fall
  // back to the same first entry, or the user is shown one default and another
  // is persisted for a binding whose levels were toggled out of order.
  assert.match(
    pickerSource,
    /const thinkingLevels = sortThinkingLevels\(binding\.thinkingLevels\)/,
  );
  assert.match(pickerSource, /const enabled = thinkingLevels/);
  assert.match(
    pickerSource,
    /resolveBindingDefaultThinkingLevel\(\s*binding\.defaultThinkingLevel,\s*enabled,/,
  );
  assert.match(
    advancedSource,
    /resolveBindingDefaultThinkingLevel\(\s*binding\.defaultThinkingLevel,\s*sortThinkingLevels\(next\),/,
  );
});

test("advanced settings expose the Chat Completions reasoning effort override by effective model protocol", () => {
  assert.match(bindingEditorSource, /const effectiveApiStyle = binding\.apiStyle \|\| globalApiStyle;/);
  assert.match(pickerSource, /globalApiStyle=\{globalApiStyle \?\? apiStyle\}/);
  assert.match(
    bindingEditorSource,
    /!effectiveApiStyle \|\|\s*effectiveApiStyle === "chat_completions" \|\|\s*effectiveApiStyle === "opencode_go"/,
  );
  assert.match(bindingEditorSource, /<ReasoningEffortSelect[\s\S]*?value=\{binding\.supportsReasoningEffort\}/);
  assert.match(reasoningEffortSource, /settings\.reasoningEffortParameter/);
  assert.match(reasoningEffortSource, /settings\.reasoningEffortParameterHint/);
  assert.match(reasoningEffortSource, /settings\.reasoningEffortAuto/);
  assert.match(reasoningEffortSource, /settings\.reasoningEffortSend/);
  assert.match(reasoningEffortSource, /settings\.reasoningEffortOmit/);
  assert.match(styles, /\.provider-chosen-reasoning-effort\s*\{/);
});

test("rendered ModelBindingFields, ModelSelectionPanes and ProviderConnectionFields follow effective protocol and optional-key contracts", async (t) => {
  const { fileURLToPath } = await import("node:url");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createInstance } = await import("i18next");
  const { I18nextProvider } = await import("react-i18next");
  const { createServer } = await import("vite");

  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());

  const { ModelBindingFields } = await server.ssrLoadModule(
    "/src/components/settings/ModelBindingFields.tsx",
  );
  const { ModelSelectionPanes, useModelSelection } = await server.ssrLoadModule(
    "/src/components/settings/ModelSelectionPanes.tsx",
  );
  const { ProviderConnectionFields } = await server.ssrLoadModule(
    "/src/components/settings/ProviderConnectionFields.tsx",
  );
  const { PluginProviderKeySetupForm } = await server.ssrLoadModule(
    "/src/components/settings/PluginProviderKeySetupForm.tsx",
  );

  const { catalogs, flattenCatalog } = await import("@minih-agent/i18n");
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    keySeparator: false,
    resources: {
      en: { translation: flattenCatalog(catalogs.en) },
    },
  });

  const render = (element) =>
    renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element));

  const baseBinding = {
    id: "deepseek-v4.1-flash",
    alias: "DeepSeek Fast",
    contextWindow: 64000,
    contextWindowSource: "catalog",
    maxTokens: 8192,
    maxTokensSource: "user",
    thinkingLevels: ["off", "high"],
    defaultThinkingLevel: "high",
    supportsImages: true,
    supportsDocuments: false,
    availableForSubagents: true,
    nativeWebSearch: true,
  };

  // 1) Chat Completions and opencode_go show ReasoningEffortSelect with tri-state labels.
  for (const [supportsReasoningEffort, expectedLabel] of [
    [undefined, "Auto"],
    [null, "Auto"],
    [true, "Send"],
    [false, "Do not send"],
  ]) {
    const html = render(
      createElement(ModelBindingFields, {
        binding: { ...baseBinding, supportsReasoningEffort },
        publishedLevels: ["off", "high"],
        nativeWebSearchCapable: true,
        globalApiStyle: "chat_completions",
        onChange: () => {},
      }),
    );
    assert.match(html, /class="provider-chosen-reasoning-effort"/);
    assert.match(html, new RegExp(`>${expectedLabel}<`));
    assert.match(html, /value="DeepSeek Fast"/);
  }

  // 2) Non-Completions global styles hide ReasoningEffortSelect unless binding.apiStyle overrides to chat_completions.
  for (const nonCompletionsStyle of ["responses", "anthropic_messages", "google_generative_ai"]) {
    const hiddenByGlobal = render(
      createElement(ModelBindingFields, {
        binding: baseBinding,
        publishedLevels: ["off", "high"],
        nativeWebSearchCapable: true,
        globalApiStyle: nonCompletionsStyle,
        onChange: () => {},
      }),
    );
    assert.doesNotMatch(hiddenByGlobal, /provider-chosen-reasoning-effort/);

    const shownByModelOverride = render(
      createElement(ModelBindingFields, {
        binding: { ...baseBinding, apiStyle: "chat_completions", supportsReasoningEffort: true },
        publishedLevels: ["off", "high"],
        nativeWebSearchCapable: true,
        globalApiStyle: nonCompletionsStyle,
        onChange: () => {},
      }),
    );
    assert.match(shownByModelOverride, /class="provider-chosen-reasoning-effort"/);
    assert.match(shownByModelOverride, />Send</);

    const hiddenByModelOverride = render(
      createElement(ModelBindingFields, {
        binding: { ...baseBinding, apiStyle: nonCompletionsStyle, supportsReasoningEffort: true },
        publishedLevels: ["off", "high"],
        nativeWebSearchCapable: true,
        globalApiStyle: "chat_completions",
        onChange: () => {},
      }),
    );
    assert.doesNotMatch(hiddenByModelOverride, /provider-chosen-reasoning-effort/);
  }

  // 3) ModelSelectionPanes forwards apiStyle to ModelBindingFields and preserves supportsReasoningEffort in bindingsToPersist.
  let persistedSnapshot = [];
  function PaneHarness({ apiStyle, models }) {
    const selection = useModelSelection(
      { status: "ready", models: [], source: "remote" },
      models,
      () => {},
    );
    persistedSnapshot = selection.bindingsToPersist;
    return createElement(ModelSelectionPanes, {
      discovery: { status: "ready", models: [], source: "remote" },
      selection,
      listTitle: "Models",
      apiStyle,
    });
  }
  const paneCompletionsHtml = render(
    createElement(PaneHarness, {
      apiStyle: "chat_completions",
      models: [{ ...baseBinding, supportsReasoningEffort: false }],
    }),
  );
  assert.match(paneCompletionsHtml, /class="provider-chosen-reasoning-effort"/);
  assert.equal(persistedSnapshot[0]?.supportsReasoningEffort, false);

  const paneResponsesHtml = render(
    createElement(PaneHarness, {
      apiStyle: "responses",
      models: [{ ...baseBinding, supportsReasoningEffort: true }],
    }),
  );
  assert.doesNotMatch(paneResponsesHtml, /class="provider-chosen-reasoning-effort"/);
  assert.equal(persistedSnapshot[0]?.supportsReasoningEffort, true);

  // 4) ProviderConnectionFields custom optional key vs saved-key Clear vs named Minih Router.
  const baseConnectionProps = {
    named: false,
    custom: true,
    editing: false,
    saving: false,
    serviceLabel: "Custom",
    serviceBaseUrl: "",
    onChangeService: () => {},
    apiKeyRef: { current: null },
    nameRef: { current: null },
    apiKey: "",
    onApiKeyChange: () => {},
    name: "Gateway",
    onNameChange: () => {},
    baseUrl: "http://127.0.0.1:11434/v1",
    onBaseUrlChange: () => {},
    commitBaseUrl: () => {},
    apiStyle: "chat_completions",
    onApiStyleChange: () => {},
    accountOnlyApiStyle: false,
    requiresApiStyleChoice: false,
  };
  const customNewHtml = render(createElement(ProviderConnectionFields, baseConnectionProps));
  assert.doesNotMatch(customNewHtml, /role="switch"/);
  assert.doesNotMatch(customNewHtml, /Clear saved API key/);
  assert.match(customNewHtml, /Optional\. Leave blank to send requests without an API key\./);

  const customSavedKeyHtml = render(
    createElement(ProviderConnectionFields, {
      ...baseConnectionProps,
      editing: true,
      hasSavedApiKey: true,
      onClearApiKey: () => {},
    }),
  );
  assert.match(customSavedKeyHtml, /Leave blank to keep the saved key\./);
  assert.match(customSavedKeyHtml, />Clear saved API key</);

  const routerHtml = render(
    createElement(ProviderConnectionFields, {
      ...baseConnectionProps,
      named: true,
      custom: false,
      relocatable: true,
      defaultBaseUrl: "https://router.hmini.org/v1",
      editing: true,
      hasSavedApiKey: true,
      onClearApiKey: () => {},
    }),
  );
  assert.match(routerHtml, />Token<button/);
  assert.match(routerHtml, /provider-setup-relocatable-row/);
  assert.doesNotMatch(routerHtml, />Clear saved API key</);

  // 5) PluginProviderKeySetupForm renders cleanly with the updated ProviderConnectionFields contract.
  const pluginSetupHtml = render(
    createElement(PluginProviderKeySetupForm, {
      provider: {
        id: "plugin:demo:1",
        name: "Demo Plugin Provider",
        vendorKey: "custom",
        type: "openai_compatible",
        protocol: "openai_compatible",
        enabled: true,
        authKind: "api_key_and_base_url",
        apiStyle: "chat_completions",
        baseUrl: "https://plugin.example/v1",
        hasSecret: false,
        models: [],
      },
      pluginName: "Demo Plugin",
      onClose: () => {},
      onSaved: () => {},
    }),
  );
  assert.match(pluginSetupHtml, /Demo Plugin Provider/);
  assert.doesNotMatch(pluginSetupHtml, /role="switch"/);
});
