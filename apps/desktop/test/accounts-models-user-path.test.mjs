/**
 * Isolated Electron user path for the accounts + models pages.
 *
 * 1. A fresh install shows only the Minih Router connect card: one token field
 *    (plus an optional endpoint behind "Advanced"), and connecting creates a
 *    `minih-router` row with no models at all.
 * 2. The models page for that row offers "Add models": the gateway plaza as
 *    selectable cards with search and paging, and confirming saves the chosen
 *    bindings.
 * 3. A model's configure drawer can pin its own protocol mode; "Follow global"
 *    stays the default and saves no `apiStyle` for that binding.
 * 4. Removing a model re-plans the app defaults instead of leaving a dangling
 *    default behind.
 *
 * IPC is answered by a fake main; the pages, dialog, drawer and formatting are
 * the real renderer code.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixtureSource = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { AccountsPage } from "../../apps/desktop/src/components/settings/AccountsPage";
import { ModelsPage } from "../../apps/desktop/src/components/settings/ModelConfigPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

window.addEventListener("error", (event) => console.error("FIXTURE_ERROR " + (event.error?.stack ?? event.message)));

const apiCalls = [];
let created = null;
let updated = null;
let deleted = null;
let settingsWrites = [];
let savesSecret = null;
let providers = [];
let settings = {
  defaultProviderId: "",
  defaultModelId: "",
  imageGenerationModels: [],
  imageGeneration: null,
  developerMode: false,
};

const allModels = Array.from({ length: 30 }, (_, index) => ({
  id: index === 0 ? "gpt-4.1" : "model-" + String(index).padStart(2, "0"),
  vendor: index === 0 ? "OpenAI" : "Vendor",
  category: "chat",
  protocols: ["openai-completions"],
  price: index === 0
    ? { input: "2", output: "8", cacheRead: "0.5", cacheWrite: null }
    : { input: String(index), output: String(index * 2), cacheRead: null, cacheWrite: null },
  multiplePrices: index === 0,
  tieredPricing: false,
  contextWindow: index === 0 ? 1047576 : null,
  maxOutput: null,
}));

function routerRow() {
  return {
    id: "router-1", name: "Minih Router", vendorKey: "minih-router",
    type: "openai_compatible", protocol: "openai_compatible",
    authKind: "api_key_and_base_url", apiStyle: "chat_completions",
    baseUrl: "https://router.hmini.org/v1", hasSecret: true, enabled: true,
    models: [],
  };
}

window.minihAgent = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, ...args) {
    const input = args[0];
    apiCalls.push({ channel, input });
    switch (channel) {
      case "minih-agent-desktop/plugin/providerCatalog":
        return { ok: true, data: [] };
      case "minih-agent-desktop/settings/get":
        return { ok: true, data: settings };
      case "minih-agent-desktop/settings/set":
        settings = { ...settings, ...input };
        settingsWrites.push(input);
        return { ok: true, data: settings };
      case "minih-agent-desktop/providers/list":
        return { ok: true, data: { providers } };
      // The provider refresh reads the surrounding catalogue in one round trip.
      case "minih-agent-desktop/session/list":
        return { ok: true, data: { sessions: [] } };
      case "minih-agent-desktop/app/getOnboarding":
        return { ok: true, data: { completed: true, steps: [] } };
      case "minih-agent-desktop/plugin/list":
        return { ok: true, data: { plugins: [] } };
      case "minih-agent-desktop/providers/create":
        created = input;
        providers = [{ ...routerRow(), ...input, models: [] }];
        return { ok: true, data: { provider: providers[0] } };
      case "minih-agent-desktop/providers/update":
        updated = input;
        providers = providers.map((row) => row.id === input.id ? { ...row, ...input } : row);
        return { ok: true, data: { provider: providers[0] } };
      case "minih-agent-desktop/providers/secret/set":
        savesSecret = input;
        return { ok: true, data: { ok: true } };
      case "minih-agent-desktop/providers/delete":
        deleted = input;
        providers = [];
        return { ok: true, data: { ok: true } };
      case "minih-agent-desktop/providers/minihRouter/account":
        return { ok: true, data: {
          keyName: "desktop", maskedKey: "sk-gl-…cret", status: "active",
          expiresAtMs: null, expired: false, priceMultiplier: "1", rpmLimit: 60,
          allowed: true, nextAvailableAtMs: null,
          quotas: [{ id: 1, kind: "total", limitUsd: "100", usedUsd: "12.5", remainingUsd: "87.5", status: "ok" }],
          usage: { days: 30, requestCount: 321, totalTokens: 987654, costUsd: "12.5" },
          observedAtMs: 1760000000000,
        } };
      case "minih-agent-desktop/providers/minihRouter/modelDetails": {
        const wanted = new Set(input.modelIds.map((id) => id.toLowerCase()));
        return { ok: true, data: allModels.filter((model) => wanted.has(model.id.toLowerCase())) };
      }
      case "minih-agent-desktop/providers/lookupModel": {
        // The models.dev record behind an id: limits, thinking ladder and the
        // published image capability the configure dialog must follow.
        if ((input?.modelId ?? "").toLowerCase() === "gpt-4.1") {
          return { ok: true, data: { info: {
            modelId: "gpt-4.1", displayName: "gpt-4.1", providerId: "router-1",
            capabilities: [], reasoning: true,
            thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
            modalities: { input: ["text", "image"] },
            limit: { context: 400_000, output: 16_384 },
          } } };
        }
        return { ok: true, data: { info: null } };
      }
      case "minih-agent-desktop/providers/minihRouter/models": {
        const query = (input.query ?? "").toLowerCase();
        const matched = allModels.filter((model) => model.id.includes(query));
        const start = (input.page - 1) * input.pageSize;
        return { ok: true, data: {
          items: matched.slice(start, start + input.pageSize),
          page: input.page, pageSize: input.pageSize, totalItems: matched.length,
          totalPages: Math.ceil(matched.length / input.pageSize),
        } };
      }
      case "minih-agent-desktop/easytier/status":
        return { ok: true, data: null };
      case "minih-agent-desktop/providers/modelCatalogStatus":
        return { ok: true, data: { status: null } };
      default:
        return { ok: true, data: null };
    }
  },
};

await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
});

const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await settle();
    const value = predicate();
    if (value) return value;
  }
  throw new Error(message + "\n" + document.body.innerText.slice(0, 2000));
}
function button(label) {
  return [...document.querySelectorAll("button")]
    .find((candidate) => candidate.textContent.trim() === label);
}
function setValue(input, value) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  valueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function cardIds() {
  return [...document.querySelectorAll("[data-model-section=\"chosen\"] .models-chosen-card")]
    .map((node) => node.getAttribute("data-model-id"));
}
function mount(element) {
  flushSync(() => rootNode.render(element));
}

const rootNode = createRoot(document.getElementById("root"));

window.accountsProbe = async () => {
  // 1) Fresh install: the connect card is the whole page body.
  providers = [];
  settings = { ...settings, defaultProviderId: "", defaultModelId: "" };
  useAppStore.setState({ providers: [], settings });
  mount(React.createElement(AccountsPage));

  const tokenField = await waitFor(
    () => document.querySelector('input[type="password"]'),
    "the token field did not render",
  );
  const endpointHiddenInitially = !document.querySelector('input[placeholder="https://router.hmini.org/v1"]');
  const advancedToggle = button("Advanced: custom endpoint") ??
    [...document.querySelectorAll("button")].find((node) => node.textContent.includes("Advanced"));
  flushSync(() => advancedToggle.click());
  const endpointShown = await waitFor(
    () => document.querySelector('input[placeholder="https://router.hmini.org/v1"]'),
    "the advanced endpoint input did not appear",
  );

  flushSync(() => setValue(tokenField, "sk-gl-user-token"));
  const connect = await waitFor(() => {
    const candidate = button("Connect");
    return candidate && !candidate.disabled ? candidate : null;
  }, "Connect never became available");
  flushSync(() => connect.click());
  await waitFor(() => created && providers.length === 1, "the router row was not created");

  const connectSaved = {
    vendorKey: created.vendorKey,
    baseUrl: created.baseUrl,
    apiStyle: created.apiStyle,
    secretValue: created.secretValue,
    // The one-field initialization: no model is required or saved.
    modelsOmitted: !("models" in created) || (created.models ?? []).length === 0,
    endpointHiddenInitially: endpointHiddenInitially && Boolean(endpointShown),
  };

  // The AI-service list is developer-only surface: a normal profile, even one
  // with other providers, sees the account card alone.
  const otherProvidersHidden = !document.querySelector(".other-providers-section");

  // The connected card replaces the token entry once the row exists.
  const connectedBadge = await waitFor(
    () => document.body.innerText.includes("Connected") || null,
    "the connected state did not render",
  );
  const tokenEntryGoneAfterConnect = !document.querySelector('input[type="password"]');

  // 2) Models page for the connected row.
  mount(null);
  mount(React.createElement(ModelsPage));
  await waitFor(() => button("Add models"), "the add-models action did not render");
  const emptyStateShown = document.body.innerText.includes("No models yet");
  const globalStyleRow = document.querySelector(".models-global-style-row");
  const globalStyleRowShown = Boolean(globalStyleRow);

  const globalTrigger = document.querySelector(
    '.models-global-style-row button[aria-label="API format"]') ??
    document.querySelector(".models-global-style-row .settings-menu-select-trigger");
  flushSync(() => globalTrigger.click());
  const globalOption = [...document.querySelectorAll('[role="option"]')]
    .find((node) => node.textContent.includes("Anthropic Messages"));
  flushSync(() => globalOption.click());
  await waitFor(
    () => updated && "apiStyle" in updated && updated.apiStyle === "anthropic_messages",
    "the global protocol write did not land",
  );
  const globalStyleSaved = updated.apiStyle === "anthropic_messages";

  flushSync(() => button("Add models").click());
  const dialog = await waitFor(
    () => document.querySelector(".add-models-dialog"),
    "the add-models dialog did not open",
  );
  const firstPage = [...dialog.querySelectorAll("[data-model-id]")].map((node) => node.getAttribute("data-model-id"));
  const dialogCards = firstPage.length;

  // Search settles, then a card can be picked and confirmed.
  const search = dialog.querySelector('input[aria-label="Search models, vendors or groups"]');
  flushSync(() => setValue(search, "gpt"));
  await waitFor(
    () => dialog.querySelectorAll("[data-model-id]").length === 1,
    "search did not filter the dialog",
  );
  // Select-all before anything is picked: a fresh search keeps every card
  // available, so the one visible card becomes selected through the bulk row.
  const selectAllBefore = document.querySelector(".add-models-select-all input");
  const selectAllWasUnchecked = selectAllBefore ? !selectAllBefore.checked : false;
  flushSync(() => setValue(search, ""));
  await waitFor(
    () => dialog.querySelectorAll("[data-model-id]").length === 12,
    "clearing the search did not restore the page",
  );
  // The bulk row selects every card on the page that is not already on the row.
  const selectAll = document.querySelector(".add-models-select-all input");
  flushSync(() => selectAll.click());
  await waitFor(
    () => document.querySelector(".add-models-count").textContent.includes("12"),
    "select-all did not select the whole page",
  );
  const selectAllCheckedAfter = selectAll.checked;
  const selectAllIndeterminate = selectAll.indeterminate;
  flushSync(() => selectAll.click());
  await waitFor(
    () => !document.querySelector(".add-models-count").textContent.includes("12"),
    "select-all did not clear the page",
  );
  // Then one card is picked on its own, which is what gets saved.
  const check = dialog.querySelector(".minih-router-model-check");
  flushSync(() => check.click());
  const selectedCount = document.querySelector(".add-models-count").textContent;
  flushSync(() => button("Add").click());
  await waitFor(() => updated && updated.models.length === 1, "the chosen model was not saved");

  const savedBinding = updated.models[0];
  const addSaved = {
    modelId: savedBinding.id,
    // A seeded binding keeps no protocol pin.
    protocolPinLeftToGlobal: !("apiStyle" in savedBinding) || !savedBinding.apiStyle,
    // The published record auto-configured the binding: the catalog's window
    // (400k) replaced the gateway's own number, and the thinking ladder and
    // image capability follow models.dev instead of defaulting off.
    autoConfigured: {
      contextWindow: savedBinding.contextWindow,
      contextWindowSource: savedBinding.contextWindowSource,
      thinkingLevels: savedBinding.thinkingLevels,
      defaultThinkingLevel: savedBinding.defaultThinkingLevel,
      followsPublishedCapabilities:
        savedBinding.supportsImages == null && savedBinding.supportsDocuments == null,
    },
    // Nothing else in the row was rewritten by the models page.
    nameUntouched: updated.name === undefined,
    defaultFollowsFirstBinding: updated.defaultModelId === savedBinding.id,
  };

  // The default the save claimed is reported on the card, not re-settable here.
  const defaultBadgeShown = document.body.innerText.includes("Default");

  // 3) Configure opens a modal dialog, not an inline drawer in the card.
  await waitFor(() => cardIds().length === 1, "the chosen model card did not render");
  flushSync(() => button("Configure").click());
  const drawer = await waitFor(
    () => document.querySelector(".model-configure-dialog"),
    "the configure dialog did not open",
  );
  const cardStayedCompact = !document.querySelector(".models-configure-drawer");
  const modalIsDialog = drawer.getAttribute("role") === "dialog";
  // The published record reaches the dialog: the image-input checkbox follows
  // models.dev (on) without the user pinning anything. The read is async, so
  // the checkbox settles once the catalog answer lands.
  const imageFollowsPublished = await waitFor(() => {
    const box = [...drawer.querySelectorAll("input[type=checkbox]")]
      .find((node) => node.closest("label")?.textContent?.trim().startsWith("Images"));
    return box && box.checked ? true : null;
  }, "the image capability did not follow the published record");

  const followGlobalNamesNewStyle = [...drawer.querySelectorAll("button")]
    .some((node) => node.textContent.includes("Follow global (anthropic_messages)"));
  const protocolTrigger = drawer.querySelector('button[aria-label="Protocol mode"]');
  flushSync(() => protocolTrigger.click());
  const protocolOptions = [...document.querySelectorAll('[role="option"]')]
    .map((node) => node.textContent.trim().replace(/\s+/g, " "));
  const followGlobalDefault = protocolOptions.some((label) => label.includes("Follow global"));
  const responsesOption = [...document.querySelectorAll('[role="option"]')]
    .find((node) => node.textContent.includes("OpenAI Responses"));
  flushSync(() => responsesOption.click());
  const dialogClosesAfterSave = true; // asserted through the wait below
  flushSync(() => button("Save").click());
  await waitFor(
    () => !document.querySelector(".model-configure-dialog"),
    "the configure dialog did not close after saving",
  );
  await waitFor(
    () => updated && updated.models[0]?.apiStyle === "responses",
    "the per-model protocol was not saved",
  );
  const pinnedProtocol = updated.models[0].apiStyle;

  // 4) Removing the only model leaves no dangling replacement behind: the row
  //    loses its binding list, and no default is invented for an empty row.
  const settingsWritesBeforeRemoval = settingsWrites.length;
  await waitFor(() => button("Remove model"), "the remove action did not render");
  flushSync(() => button("Remove model").click());
  await waitFor(() => updated && updated.models.length === 0, "the model was not removed");
  const removalWroteNoDefaults = settingsWrites.length === settingsWritesBeforeRemoval;

  // The models page also renders while settings are still absent (the shell's
  // recovery path) without changing its hook order: nothing renders, and the
  // normal page comes back as soon as settings arrive.
  await waitFor(() => button("Add models"), "the models page lost its header");
  const savedSettings = settings;
  useAppStore.setState({ settings: null });
  mount(null);
  mount(React.createElement(ModelsPage));
  const nullSettingsRendersEmpty = document.body.innerText.trim() === "";
  useAppStore.setState({ settings: savedSettings });
  mount(React.createElement(ModelsPage));
  await waitFor(() => button("Add models"), "the models page did not recover after settings arrived");

  const routerCalls = apiCalls.filter((call) => call.channel.startsWith("minih-agent-desktop/providers/minihRouter/"));
  return {
    connectSaved,
    connectedBadge: Boolean(connectedBadge),
    otherProvidersHidden,
    globalStyleRowShown,
    globalStyleSaved,
    followGlobalNamesNewStyle,
    nullSettingsRendersEmpty,
    tokenEntryGoneAfterConnect,
    emptyStateShown,
    dialogCards,
    selectedCount: selectedCount.trim(),
    selectAllWasUnchecked,
    selectAllCheckedAfter,
    selectAllIndeterminate,
    addSaved,
    cardStayedCompact,
    modalIsDialog,
    imageFollowsPublished,
    dialogClosesAfterSave,
    defaultBadgeShown,
    followGlobalDefault,
    protocolOptions,
    pinnedProtocol,
    removalWroteNoDefaults,
    storedDefaultsKept: {
      defaultProviderId: settings.defaultProviderId,
      defaultModelId: settings.defaultModelId,
      imageGeneration: settings.imageGeneration,
    },
    rendererNeverSendsToken: routerCalls.every((call) => !JSON.stringify(call.input).includes("sk-gl-user-token")),
    callsNameTheRow: routerCalls.every((call) => call.input.providerId === "router-1"),
  };
};
`;

test("Accounts and models pages: token-only connect, then models are added, configured and removed", {
  timeout: 90_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.accounts-ui-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "accounts-models.jsx"),
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
        "@minih-agent/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><body><div id="root"></div><script type="module" src="renderer.js"></script>',
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.accountsProbe()");
    console.log("ACCOUNTS_PROBE " + JSON.stringify(result));
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 75_000);
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith("ACCOUNTS_PROBE "));
    assert(line, output.slice(-6000));
    const result = JSON.parse(line.slice("ACCOUNTS_PROBE ".length));
    assert.deepEqual(result, {
      connectSaved: {
        vendorKey: "minih-router",
        baseUrl: "https://router.hmini.org/v1",
        apiStyle: "chat_completions",
        secretValue: "sk-gl-user-token",
        modelsOmitted: true,
        endpointHiddenInitially: true,
      },
      connectedBadge: true,
      otherProvidersHidden: true,
      globalStyleRowShown: true,
      globalStyleSaved: true,
      followGlobalNamesNewStyle: true,
      nullSettingsRendersEmpty: true,
      tokenEntryGoneAfterConnect: true,
      emptyStateShown: true,
      dialogCards: 12,
      selectedCount: "1 selected",
      selectAllWasUnchecked: true,
      selectAllCheckedAfter: true,
      selectAllIndeterminate: false,
      addSaved: {
        modelId: "gpt-4.1",
        protocolPinLeftToGlobal: true,
        autoConfigured: {
          contextWindow: 400000,
          contextWindowSource: "catalog",
          thinkingLevels: ["low", "medium", "high"],
          defaultThinkingLevel: "medium",
          followsPublishedCapabilities: true,
        },
        nameUntouched: true,
        defaultFollowsFirstBinding: true,
      },
      cardStayedCompact: true,
      modalIsDialog: true,
      imageFollowsPublished: true,
      dialogClosesAfterSave: true,
      defaultBadgeShown: true,
      followGlobalDefault: true,
      // The follow-global default names the style the row now stores.
      protocolOptions: [
        "Follow global (anthropic_messages)",
        "OpenAI Chat Completions",
        "OpenAI Responses",
        "Anthropic Messages",
      ],
      pinnedProtocol: "responses",
      removalWroteNoDefaults: true,
      storedDefaultsKept: {
        defaultProviderId: "router-1",
        defaultModelId: "gpt-4.1",
        imageGeneration: null,
      },
      rendererNeverSendsToken: true,
      callsNameTheRow: true,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
