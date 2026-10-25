/** Configure a custom OpenAI-compatible endpoint that does not require a key. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
import { loadStyles } from "./helpers/styles.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixtureSource = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { ProviderSetupDialog } from "../../apps/desktop/src/components/settings/ProviderSetupDialog";
import { ModelBindingFields } from "../../apps/desktop/src/components/settings/ModelBindingFields";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const calls = [];
let createdProvider = null;
let updatedProvider = null;
let updateInput = null;
let savedCallback = false;
let failNextUpdate = false;
window.addEventListener("error", (event) => {
  console.error("CUSTOM_PROVIDER_NO_KEY_WINDOW_ERROR", event.error?.stack ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("CUSTOM_PROVIDER_NO_KEY_REJECTION", event.reason?.stack ?? event.reason);
});

window.minihAgent = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, ...args) {
    const input = args[0];
    calls.push({ channel, input });
    if (channel === "minih-agent-desktop/plugin/providerCatalog") {
      return { ok: true, data: [] };
    }
    if (channel === "minih-agent-desktop/providers/listModels") {
      return { ok: true, data: { models: [], source: "remote" } };
    }
    if (channel === "minih-agent-desktop/providers/lookupModel") {
      return { ok: true, data: { info: null } };
    }
    if (channel === "minih-agent-desktop/providers/create") {
      createdProvider = {
        id: "custom:no-auth",
        ...input,
        enabled: true,
        hasSecret: Boolean(input.secretValue),
        createdAt: "2026-10-13T00:00:00.000Z",
        updatedAt: "2026-10-13T00:00:00.000Z",
      };
      return { ok: true, data: { provider: createdProvider } };
    }
    if (channel === "minih-agent-desktop/providers/update") {
      if (failNextUpdate) {
        failNextUpdate = false;
        throw new Error("Host rejected provider update");
      }
      updateInput = input;
      updatedProvider = {
        ...createdProvider,
        ...input,
        hasSecret: input.authKind === "none" ? false : Boolean(input.secretValue) || createdProvider.hasSecret,
      };
      return { ok: true, data: { provider: updatedProvider } };
    }
    throw new Error("Unexpected fixture IPC: " + channel);
  },
};

await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: {
    en: { translation: flattenCatalog(catalogs.en) },
    "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) },
  },
  interpolation: { escapeValue: false },
});
useAppStore.setState({ providers: [] });

const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await settle();
    const value = predicate();
    if (value) return value;
  }
  throw new Error(message);
}
function setValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const rootNode = createRoot(document.getElementById("root"));
function mount(element) { flushSync(() => rootNode.render(element)); }

window.customProviderNoApiKeyProbe = async () => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const button = (label) => [...document.querySelectorAll("button")]
    .find((item) => item.getAttribute("aria-label") === label || item.textContent.trim() === label);
  const keyField = () => document.querySelector('input[type="password"]');
  const edit = (provider, key) => {
    updateInput = null;
    updatedProvider = null;
    mount(React.createElement(ProviderSetupDialog, {
      key,
      provider,
      onClose: () => mount(null),
      onSaved: () => {},
    }));
  };
  const saveEdit = async () => {
    flushSync(() => button("Save provider").click());
    await waitFor(() => updateInput && updatedProvider, "the provider edit was not saved");
    return structuredClone(updateInput);
  };
  mount(React.createElement(ProviderSetupDialog, {
    key: "new-provider",
    provider: null,
    onClose: () => mount(null),
    onSaved: () => { savedCallback = true; },
  }));
  const customTile = await waitFor(
    () => document.querySelector('[data-service-id="custom"]'),
    "the custom endpoint service was not offered",
  );
  flushSync(() => customTile.click());
  check(!document.querySelector('[role="switch"][aria-label="No API key required"]'),
    "the obsolete no-key switch is still present");
  check(keyField() && !keyField().disabled, "the optional API-key input is not enabled");
  const nameField = [...document.querySelectorAll("label")]
    .find((label) => label.textContent.includes("Name"))?.querySelector("input");
  const urlField = document.querySelector('input[type="url"]');
  check(nameField && urlField, "the custom endpoint identity fields were missing");
  setValue(nameField, "No Auth Gateway");
  setValue(urlField, "https://no-auth.example.org/v1");
  const discoveryCall = await waitFor(
    () => calls.find((call) => call.channel === "minih-agent-desktop/providers/listModels"
      && call.input.baseUrl === "https://no-auth.example.org/v1"),
    "the custom endpoint was not probed without an API key",
  );
  const modelField = document.querySelector('input[placeholder^="Enter a model ID"]');
  check(modelField, "the custom model input was missing");
  setValue(modelField, "no-auth-chat");
  flushSync(() => button("Add custom model").click());
  await waitFor(
    () => document.querySelector(".provider-chosen")?.innerText.includes("no-auth-chat"),
    "the model was not added to the custom provider",
  );
  // A whitespace-only key has the same meaning as an empty key.
  flushSync(() => setValue(keyField(), "   "));
  flushSync(() => button("Save provider").click());
  await waitFor(() => savedCallback && createdProvider, "the custom provider was not saved");
  const noAuthProvider = structuredClone(createdProvider);
  check(noAuthProvider.authKind === "none" && !Object.hasOwn(noAuthProvider, "secretValue"),
    "an empty API key did not automatically save as no-auth");

  edit(noAuthProvider, "edit-no-auth-unchanged");
  const unchangedNoAuth = await saveEdit();
  check(!Object.hasOwn(unchangedNoAuth, "authKind") && !Object.hasOwn(unchangedNoAuth, "secretValue"),
    "reopening and saving a no-auth provider changed its authentication");

  edit(noAuthProvider, "edit-no-auth-add-key");
  check(!keyField().disabled, "a no-auth provider cannot accept an API key");
  flushSync(() => setValue(keyField(), "  saved-api-key  "));
  const keyedUpdate = await saveEdit();
  check(keyedUpdate.authKind === "api_key_and_base_url" && keyedUpdate.secretValue === "saved-api-key",
    "typing a key did not switch the no-auth provider to API-key authentication");
  createdProvider = structuredClone(updatedProvider);
  const keyedProvider = structuredClone(createdProvider);

  edit(keyedProvider, "edit-keyed-keep-key");
  const keepKeyUpdate = await saveEdit();
  check(!Object.hasOwn(keepKeyUpdate, "authKind") && !Object.hasOwn(keepKeyUpdate, "secretValue"),
    "an untouched empty input overwrote the saved key");

  edit(keyedProvider, "edit-keyed-clear-and-cancel");
  const clearButton = button("Clear saved API key");
  check(clearButton, "the saved-key removal action was missing");
  check(clearButton.textContent.trim() === "" && clearButton.querySelector('svg[aria-hidden="true"]'),
    "the saved-key removal action is not an accessible icon-only button");
  const inputRect = keyField().getBoundingClientRect();
  const clearRect = clearButton.getBoundingClientRect();
  check(clearRect.left >= inputRect.right && clearRect.top < inputRect.bottom
    && clearRect.bottom > inputRect.top, "the clear icon is not beside the API-key input");
  check(clearRect.width >= 24 && clearRect.height >= 24, "the clear icon target is too small");
  flushSync(() => clearButton.click());
  check(document.activeElement === keyField(), "clearing the key did not focus its input");
  check(!updateInput, "clearing a key persisted before Save");
  check(keyField().value === "" && !keyField().disabled, "clearing a saved key disabled the input");
  const afterClear = calls.length;
  const clearProbe = await waitFor(
    () => calls.slice(afterClear).find((call) => call.channel === "minih-agent-desktop/providers/listModels"
      && call.input.baseUrl === keyedProvider.baseUrl && call.input.source !== "cache"),
    "clearing the saved key did not refresh model discovery",
  );
  check(!Object.hasOwn(clearProbe.input, "providerId") && !Object.hasOwn(clearProbe.input, "apiKey"),
    "model discovery reused a saved key after it was cleared");
  mount(null);
  check(!updateInput, "closing the form after Clear changed the saved key");

  await i18n.changeLanguage("zh-CN");
  edit(keyedProvider, "edit-keyed-clear-zh-cn");
  const zhClearLabel = i18n.t("settings.clearApiKey");
  const zhClearButton = button(zhClearLabel);
  check(zhClearButton && zhClearLabel !== "settings.clearApiKey", "the localized saved-key removal action was missing");
  check(zhClearButton.textContent.trim() === "" && zhClearButton.querySelector('svg[aria-hidden="true"]'),
    "the localized saved-key removal action is not an accessible icon-only button");
  const zhInputRect = keyField().getBoundingClientRect();
  const zhClearRect = zhClearButton.getBoundingClientRect();
  check(zhClearRect.left >= zhInputRect.right && zhClearRect.top < zhInputRect.bottom
    && zhClearRect.bottom > zhInputRect.top, "the localized clear icon is not beside the API-key input");
  check(zhClearRect.width >= 24 && zhClearRect.height >= 24, "the localized clear icon target is too small");
  flushSync(() => zhClearButton.click());
  check(document.activeElement === keyField(), "clearing the localized key did not focus its input");
  mount(null);
  await i18n.changeLanguage("en");
  edit(keyedProvider, "edit-keyed-clear-and-replace");
  flushSync(() => button("Clear saved API key").click());
  flushSync(() => setValue(keyField(), "replacement-api-key"));
  const replacementUpdate = await saveEdit();
  check(replacementUpdate.authKind !== "none" && replacementUpdate.secretValue === "replacement-api-key",
    "a replacement key was discarded after Clear");

  // A failed save after Clear must surface an error toast and not announce removal.
  let failedSaveCommitted = false;
  useAppStore.setState({ toasts: [] });
  failNextUpdate = true;
  mount(React.createElement(ProviderSetupDialog, {
    key: "edit-keyed-clear-save-error",
    provider: keyedProvider,
    onClose: () => mount(null),
    onSaved: () => { failedSaveCommitted = true; },
  }));
  flushSync(() => button("Clear saved API key").click());
  flushSync(() => button("Save provider").click());
  await waitFor(
    () => useAppStore.getState().toasts.some((toast) => toast.variant === "error" && toast.message.includes("Host rejected provider update")),
    "failed save did not surface an actionable error toast",
  );
  check(!failedSaveCommitted, "failed save announced completion before Host confirmation");

  edit(keyedProvider, "edit-keyed-clear-and-save");
  flushSync(() => button("Clear saved API key").click());
  const clearedUpdate = await saveEdit();
  check(clearedUpdate.authKind === "none" && !Object.hasOwn(clearedUpdate, "secretValue"),
    "clearing and saving did not switch to no-auth");
  check(updatedProvider.hasSecret === false, "the cleared provider is still marked as credentialed");

  const missingKeyProvider = { ...keyedProvider, hasSecret: false };
  edit(missingKeyProvider, "edit-keyed-missing-key");
  const missingKeyUpdate = await saveEdit();
  check(missingKeyUpdate.authKind === "none" && !Object.hasOwn(missingKeyUpdate, "secretValue"),
    "an existing custom provider without a stored key did not become no-auth");

  mount(React.createElement(ProviderSetupDialog, {
    key: "new-keyed-provider",
    provider: null,
    initialDraft: {
      name: "Key Gateway",
      baseUrl: keyedProvider.baseUrl,
      apiStyle: "chat_completions",
      models: keyedProvider.models,
    },
    onClose: () => mount(null),
    onSaved: () => {},
  }));
  flushSync(() => setValue(keyField(), "new-api-key"));
  createdProvider = null;
  flushSync(() => button("Save provider").click());
  await waitFor(() => createdProvider, "the new keyed provider was not saved");
  check(createdProvider.authKind === "api_key_and_base_url" && createdProvider.secretValue === "new-api-key",
    "a new custom provider with an API key did not retain API-key authentication");

  // Named presets (Minih Router) keep AccessKey authentication, editable base URL,
  // explicit format choices and do not expose custom key clearing or no-auth.
  const routerProvider = {
    ...keyedProvider,
    id: "router:1",
    name: "Minih Router",
    vendorKey: "minih-router",
    baseUrl: "https://router.hmini.org/v1",
    apiStyle: "chat_completions",
    authKind: "api_key_and_base_url",
    hasSecret: true,
  };
  createdProvider = structuredClone(routerProvider);
  edit(routerProvider, "edit-minih-router-blank-key");
  check(!button("Clear saved API key"), "named Minih Router preset offered custom key removal");
  check(Boolean(document.querySelector(".provider-setup-relocatable-row input[type='url']")),
    "Minih Router lost its editable Base URL field");
  const routerUpdate = await saveEdit();
  check(!Object.hasOwn(routerUpdate, "authKind") && !Object.hasOwn(routerUpdate, "secretValue"),
    "blank edit on Minih Router altered its saved AccessKey authentication");

  // Per-model ReasoningEffortSelect follows binding.apiStyle before globalApiStyle.
  const reasoningTrigger = () => [...document.querySelectorAll(".settings-menu-select-trigger")]
    .find((item) => item.getAttribute("aria-label") === "Reasoning effort parameter");
  const baseBinding = {
    id: "deepseek-v4.1-flash",
    contextWindow: 64000,
    maxTokens: 8192,
    thinkingLevels: ["off", "high"],
    defaultThinkingLevel: "high",
  };
  let latestPatch = null;
  mount(React.createElement(ModelBindingFields, {
    binding: { ...baseBinding, apiStyle: "chat_completions" },
    publishedLevels: ["off", "high"],
    nativeWebSearchCapable: false,
    globalApiStyle: "responses",
    onChange: (patch) => { latestPatch = patch; },
  }));
  check(Boolean(reasoningTrigger()) && reasoningTrigger().textContent.trim() === "Auto",
    "binding.apiStyle=chat_completions did not override globalApiStyle=responses to show reasoning effort");
  flushSync(() => reasoningTrigger().click());
  const sendOption = await waitFor(
    () => [...document.querySelectorAll(".settings-menu-select-option")]
      .find((item) => item.textContent.trim() === "Send"),
    "reasoning effort Send option did not open",
  );
  flushSync(() => sendOption.click());
  check(latestPatch?.supportsReasoningEffort === true, "selecting Send did not emit supportsReasoningEffort=true");

  mount(React.createElement(ModelBindingFields, {
    binding: { ...baseBinding, apiStyle: "responses", supportsReasoningEffort: false },
    publishedLevels: ["off", "high"],
    nativeWebSearchCapable: true,
    globalApiStyle: "chat_completions",
    onChange: () => {},
  }));
  check(!reasoningTrigger(),
    "binding.apiStyle=responses did not override globalApiStyle=chat_completions to hide reasoning effort");

  return {
    discoveryOmittedApiKey: !Object.hasOwn(discoveryCall.input, "apiKey"),
    savedAuthKind: noAuthProvider.authKind,
    selectedModel: noAuthProvider.models?.[0]?.id,
    noAuthReopenPreserved: true,
    typedKeyEnablesAuth: true,
    blankEditPreservesKey: true,
    clearDiscoveryOmitsStoredKey: true,
    cancelledClearPreservesKey: true,
    clearThenReplaceSavesKey: true,
    failedSaveObservableAndUncommitted: true,
    clearThenSaveRemovesKey: true,
    missingKeyBecomesNoAuth: true,
    newKeyedProviderPreserved: true,
    minihRouterAuthAndRelocatablePreserved: true,
    perModelEffectiveApiStyleReasoningEffort: true,
  };
};

window.renderScreenshotScene = async (scene) => {
  const button = (label) => [...document.querySelectorAll("button")]
    .find((item) => item.getAttribute("aria-label") === label || item.textContent.trim() === label);
  const keyedProvider = {
    id: "custom:keyed-scene",
    name: "Custom Gateway",
    vendorKey: "custom",
    type: "openai_compatible",
    protocol: "openai_compatible",
    baseUrl: "https://gateway.example.org/v1",
    apiStyle: "chat_completions",
    authKind: "api_key_and_base_url",
    hasSecret: true,
    enabled: true,
    models: [{
      id: "deepseek-v4.1-flash",
      alias: "DeepSeek Fast",
      contextWindow: 64000,
      maxTokens: 8192,
      thinkingLevels: ["off", "low", "medium", "high"],
      defaultThinkingLevel: "high",
      supportsReasoningEffort: null,
    }],
  };
  if (scene === "custom-new-optional-key") {
    mount(React.createElement(ProviderSetupDialog, {
      key: scene,
      provider: null,
      initialService: "custom",
      onClose: () => {},
      onSaved: () => {},
    }));
  } else if (scene === "custom-edit-saved-key") {
    mount(React.createElement(ProviderSetupDialog, {
      key: scene,
      provider: keyedProvider,
      onClose: () => {},
      onSaved: () => {},
    }));
  } else if (scene === "custom-edit-cleared-key") {
    mount(React.createElement(ProviderSetupDialog, {
      key: scene,
      provider: keyedProvider,
      onClose: () => {},
      onSaved: () => {},
    }));
    flushSync(() => button("Clear saved API key")?.click());
  } else if (scene === "minih-router-relocatable") {
    mount(React.createElement(ProviderSetupDialog, {
      key: scene,
      provider: {
        ...keyedProvider,
        id: "router:scene",
        name: "Minih Router",
        vendorKey: "minih-router",
        baseUrl: "https://router.hmini.org/v1",
      },
      onClose: () => {},
      onSaved: () => {},
    }));
  } else if (scene === "reasoning-effort-menu-wide" || scene === "reasoning-effort-menu-narrow") {
    mount(React.createElement(ProviderSetupDialog, {
      key: scene,
      provider: keyedProvider,
      onClose: () => {},
      onSaved: () => {},
    }));
    const advanced = document.querySelector(".provider-chosen-advanced-toggle");
    if (advanced?.getAttribute("aria-expanded") === "false") {
      flushSync(() => advanced.click());
    }
    await settle();
    const trigger = [...document.querySelectorAll(".settings-menu-select-trigger")]
      .find((item) => item.getAttribute("aria-label") === "Reasoning effort parameter");
    trigger?.scrollIntoView({ block: "center" });
    await settle();
    if (trigger) flushSync(() => trigger.click());
  }
  await settle();
  await settle();
};
`;

test("a custom endpoint can be saved and selected without an API key", {
  timeout: 60_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.custom-provider-no-api-key-ui-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "custom-provider-no-api-key.jsx"),
        loader: "tsx",
      },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@minih-agent/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(
      join(temp, "renderer.css"),
      (await loadStyles()).replace(/@theme(?: inline)?\s*\{/g, ":root {"),
    );
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="renderer.css"><title>Custom provider optional key regression</title><body><div id="root"></div><script type="module" src="renderer.js"></script>',
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.customProviderNoApiKeyProbe()");
    const screenshotDir = process.env.PI_SCRATCH_DIR;
    if (screenshotDir) {
      for (const [scene, width, height] of [
        ["custom-new-optional-key", 1000, 760],
        ["custom-edit-saved-key", 1000, 760],
        ["custom-edit-cleared-key", 1000, 760],
        ["minih-router-relocatable", 1000, 760],
        ["reasoning-effort-menu-wide", 1200, 800],
        ["reasoning-effort-menu-narrow", 850, 600],
      ]) {
        win.setContentSize(width, height);
        await win.webContents.executeJavaScript("window.renderScreenshotScene(" + JSON.stringify(scene) + ")");
        const image = await win.webContents.capturePage();
        await fs.writeFile(path.join(screenshotDir, scene + ".png"), image.toPNG());
      }
    }
    console.log("CUSTOM_PROVIDER_NO_API_KEY_PROBE " + JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});
`,
    );

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/)
      .find((item) => item.startsWith("CUSTOM_PROVIDER_NO_API_KEY_PROBE "));
    assert(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("CUSTOM_PROVIDER_NO_API_KEY_PROBE ".length)), {
      discoveryOmittedApiKey: true,
      savedAuthKind: "none",
      selectedModel: "no-auth-chat",
      noAuthReopenPreserved: true,
      typedKeyEnablesAuth: true,
      blankEditPreservesKey: true,
      clearDiscoveryOmitsStoredKey: true,
      cancelledClearPreservesKey: true,
      clearThenReplaceSavesKey: true,
      failedSaveObservableAndUncommitted: true,
      clearThenSaveRemovesKey: true,
      missingKeyBecomesNoAuth: true,
      newKeyedProviderPreserved: true,
      minihRouterAuthAndRelocatablePreserved: true,
      perModelEffectiveApiStyleReasoningEffort: true,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
