/**
 * Isolated Electron user path for Minih Router as the primary gateway.
 *
 * 1. The add-service chooser leads with Minih Router; picking it shows a token
 *    field and a Base URL field prefilled with router.hmini.org.
 * 2. Pasting a token and saving creates a `minih-router` row; a console
 *    address typed into Base URL is saved as its `/v1` API address.
 * 3. The settings panel for that row shows the balance and quotas, then the
 *    model plaza with prices, one page at a time, with search.
 * 4. A failing read is reported in place and Retry recovers it.
 *
 * IPC is answered by a fake main; the dialog, panel, hooks and formatting are
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
import { ProviderSetupDialog } from "../../apps/desktop/src/components/settings/ProviderSetupDialog";
import { MinihRouterPanel } from "../../apps/desktop/src/components/settings/MinihRouterPanel";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

window.addEventListener("error", (event) => console.error("FIXTURE_ERROR " + (event.error?.stack ?? event.message)));
const apiCalls = [];
let created = null;
let updated = null;
let failModels = false;
let easytierState = {
  enabled: true,
  configuredMode: "no_tun",
  effectiveMode: "no_tun",
  state: "connected",
  virtualIpv4: "11.11.11.20",
  localForwardPort: 25890,
  activeRouterBaseUrl: "http://127.0.0.1:25890/v1",
  fallbackRouterBaseUrl: "https://router.hmini.org/v1",
  usingLan: true,
  routerLanReachable: true,
  peerCount: 2,
  peers: ["udp://tier.hmini.org:11010", "tcp://tier.hmini.org:11010"],
  bootstrapPeers: ["udp://tier.hmini.org:11010", "tcp://tier.hmini.org:11010"],
  networkName: "minih-net",
  routerLanUrl: "http://11.11.11.10:3001/v1",
  lastError: null,
  updatedAtMs: 1760000000000,
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

window.minihAgent = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, ...args) {
    const input = args[0];
    apiCalls.push({ channel, input });
    switch (channel) {
      case "minih-agent-desktop/plugin/providerCatalog":
        return { ok: true, data: [] };
      case "minih-agent-desktop/providers/listModels":
        return { ok: true, data: {
          models: input?.source === "cache" ? [] : [{ modelId: "gpt-4.1", displayName: "gpt-4.1", providerId: "minih-router", capabilities: ["chat", "tools"], contextWindow: 1047576, maxOutputTokens: 32768 }],
          source: input?.source === "cache" ? "cache" : "remote",
        } };
      case "minih-agent-desktop/providers/update":
        updated = input;
        return { ok: true, data: { provider: { ...input, hasSecret: true, enabled: true } } };
      case "minih-agent-desktop/providers/create":
        created = input;
        return { ok: true, data: { provider: { id: "router-1", ...input, hasSecret: true, enabled: true } } };
      case "minih-agent-desktop/providers/minihRouter/account":
        return { ok: true, data: {
          keyName: "desktop", maskedKey: "sk-gl-…cret", status: "active",
          expiresAtMs: null, expired: false, priceMultiplier: "1.2", rpmLimit: 60,
          allowed: true, nextAvailableAtMs: null,
          quotas: [
            { id: 1, kind: "total", limitUsd: "100", usedUsd: "12.5", remainingUsd: "87.5", status: "ok" },
            { id: 2, kind: "periodic", limitUsd: "5", usedUsd: "4", remainingUsd: "1", status: "ok", periodSeconds: 86400 },
          ],
          usage: { days: 30, requestCount: 321, totalTokens: 987654, costUsd: "12.5" },
          observedAtMs: 1760000000000,
        } };
      case "minih-agent-desktop/providers/minihRouter/modelDetails": {
        const wanted = new Set(input.modelIds.map((id) => id.toLowerCase()));
        return { ok: true, data: allModels.filter((model) => wanted.has(model.id.toLowerCase())) };
      }
      case "minih-agent-desktop/providers/minihRouter/models": {
        if (failModels) {
          return { ok: false, error: { code: "PROVIDER_ERROR", message: "gateway unavailable" } };
        }
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
        return { ok: true, data: easytierState };
      case "minih-agent-desktop/easytier/configure":
        easytierState = {
          ...easytierState,
          enabled: input.enabled ?? easytierState.enabled,
          configuredMode: input.mode ?? easytierState.configuredMode,
          effectiveMode: input.mode === "tun" ? "tun" : "no_tun",
          networkName: input.networkName ?? easytierState.networkName,
          bootstrapPeers: input.peers ?? easytierState.bootstrapPeers,
          peers: input.peers ?? easytierState.peers,
          routerLanUrl: input.routerLanUrl ?? easytierState.routerLanUrl,
        };
        return { ok: true, data: easytierState };
      case "minih-agent-desktop/easytier/reconnect":
        return { ok: true, data: easytierState };
      case "minih-agent-desktop/easytier/requestElevation":
        easytierState = {
          ...easytierState,
          configuredMode: "tun",
          effectiveMode: "tun",
        };
        return { ok: true, data: easytierState };
      default:
        // Model lookups and catalog reads the dialog may issue are answered empty.
        return { ok: true, data: null };
    }
  },
};

await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
useAppStore.setState({ providers: [] });

const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await settle();
    const value = predicate();
    if (value) return value;
  }
  throw new Error(message + "\n" + document.body.innerText.slice(0, 2000));
}
function button(label) {
  return [...document.querySelectorAll("button")]
    .find((candidate) => candidate.textContent.trim() === label || candidate.getAttribute("aria-label") === label);
}
function setValue(input, value) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  valueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function fieldInput(label) {
  const field = [...document.querySelectorAll("label")].find((node) =>
    node.textContent.trim().startsWith(label));
  return field?.querySelector("input");
}
function modelIds(section = "plaza") {
  return [...document.querySelectorAll('[data-model-section="' + section + '"] [data-model-id]')]
    .map((node) => node.getAttribute("data-model-id"));
}

const rootNode = createRoot(document.getElementById("root"));
function mount(element) {
  flushSync(() => rootNode.render(element));
}

window.minihRouterProbe = async () => {
  // 1) Minih Router leads the chooser.
  let saved = null;
  mount(React.createElement(ProviderSetupDialog, {
    provider: null,
    onClose: () => {},
    onSaved: (provider) => { saved = provider; },
  }));
  const groupTitles = await waitFor(
    () => [...document.querySelectorAll(".service-chooser-group-title")].map((node) => node.textContent.trim()),
    "the chooser did not render",
  );
  const tiles = [...document.querySelectorAll("[data-service-id]")].map((node) => node.getAttribute("data-service-id"));
  const featuredFirst = groupTitles[0] === "Recommended" && tiles[0] === "minih-router";
  const listedOnce = tiles.filter((id) => id === "minih-router").length === 1;
  flushSync(() => document.querySelector('[data-service-id="minih-router"]').click());

  // 2) Token and an editable Base URL defaulting to router.hmini.org.
  const baseUrlInput = await waitFor(() => fieldInput("Base URL"), "no Base URL field for Minih Router");
  const tokenInput = fieldInput("Token");
  const baseUrlPrefilled = baseUrlInput.value === "https://router.hmini.org/v1";
  const tokenFieldShown = Boolean(tokenInput) && tokenInput.type === "password";
  flushSync(() => setValue(tokenInput, "sk-gl-user-token"));
  flushSync(() => setValue(baseUrlInput, "https://router.example.com"));
  baseUrlInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  baseUrlInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  await waitFor(() => fieldInput("Base URL").value === "https://router.example.com/v1", "the console address was not normalized");
  const save = await waitFor(() => {
    const candidate = button("Save provider");
    return candidate && !candidate.disabled ? candidate : null;
  }, "Save never became available");
  flushSync(() => save.click());
  await waitFor(() => created && saved, "the provider was not created");
  const createdRow = {
    vendorKey: created.vendorKey,
    baseUrl: created.baseUrl,
    apiStyle: created.apiStyle,
    secretValue: created.secretValue,
  };

  // 2b) An existing custom row that already reaches a Router is switched to
  //     the Minih Router service and keeps its own address and format.
  mount(null);
  let resaved = null;
  mount(React.createElement(ProviderSetupDialog, {
    provider: {
      id: "legacy-router", name: "Minih-Router", vendorKey: "custom", type: "openai_compatible",
      protocol: "openai_compatible", authKind: "api_key_and_base_url", apiStyle: "responses",
      baseUrl: "http://11.11.11.10:3001/v1", hasSecret: true, enabled: true,
      models: [{ id: "gpt-4.1", contextWindow: 128000, maxTokens: 8192, thinkingLevels: [], defaultThinkingLevel: null }],
    },
    onClose: () => {},
    onSaved: (provider) => { resaved = provider; },
  }));
  const change = await waitFor(() => button("Change"), "the service chip has no Change action");
  flushSync(() => change.click());
  const routerTile = await waitFor(
    () => document.querySelector('[data-service-id="minih-router"]'),
    "editing does not offer Minih Router",
  );
  flushSync(() => routerTile.click());
  const keptAddress = await waitFor(() => fieldInput("Base URL")?.value, "no Base URL after switching");
  // The saved format is shown in the Router form's own API format picker.
  const formatShown = document.querySelector(".provider-setup-relocatable-row")
    ?.innerText.includes("OpenAI Responses") ?? false;
  const resave = await waitFor(() => {
    const candidate = button("Save provider");
    return candidate && !candidate.disabled ? candidate : null;
  }, "Save never became available when converting");
  flushSync(() => resave.click());
  await waitFor(() => updated && resaved, "the converted row was not saved");
  const convertedRow = {
    keptAddress,
    formatShown,
    vendorKey: updated.vendorKey,
    baseUrl: updated.baseUrl,
    apiStyle: updated.apiStyle,
    tokenUntouched: !("secretValue" in updated),
  };

  // 3) The panel: balance first, then the priced plaza.
  mount(null);
  const provider = {
    id: "router-1", name: "Minih Router", vendorKey: "minih-router",
    baseUrl: "https://router.example.com/v1", hasSecret: true, enabled: true,
    models: [{ id: "gpt-4.1" }, { id: "local-only", contextWindow: 32000, maxTokens: 4096 }],
  };
  mount(React.createElement(MinihRouterPanel, { provider }));
  await waitFor(() => document.body.innerText.includes("My models"), "the chosen-models section is missing");
  await waitFor(() => document.body.innerText.includes("$1.00"), "the balance did not render");
  const text = document.body.innerText;
  const balance = {
    headlineIsLowestShare: text.includes("Daily quota"),
    remaining: text.includes("$1.00"),
    total: text.includes("$87.50 left of $100.00"),
    spent: text.includes("$12.50"),
    requests: text.includes("321"),
    multiplier: text.includes("Prices ×1.2 for this token"),
    neverExpires: text.includes("Never"),
  };
  await waitFor(
    () => modelIds("chosen").length === 2 && modelIds().length === 12,
    "the chosen models and the first page did not render",
  );
  const unpricedChosen = document
    .querySelector('[data-model-section="chosen"] [data-model-id="local-only"]')
    ?.innerText ?? "";
  const unpricedHandled =
    unpricedChosen.includes("The gateway lists no price for this model.") &&
    unpricedChosen.includes("32K context");
  const chosenSection = document.querySelectorAll(".minih-router-models-head");
  const sections = {
    myModelsFirst: chosenSection[0]?.textContent?.trim() === "My models",
    allModelsSecond: chosenSection[1]?.textContent?.includes("All models") ?? false,
    chosenListedWithPrice: document
      .querySelector('[data-model-section="chosen"] [data-model-id="gpt-4.1"] .minih-router-model-prices')
      ?.textContent?.includes("$2") ?? false,
    chosenCountedOnce: document.querySelectorAll('[data-model-section="chosen"] [data-model-id]').length === 2,
    unpricedHandled,
  };
  const firstPage = modelIds();
  const gptCard = document.querySelector('[data-model-id="gpt-4.1"]').innerText;
  const prices = {
    input: gptCard.includes("$2"),
    output: gptCard.includes("$8"),
    startingPrice: gptCard.includes("from"),
    cache: gptCard.includes("Cache read $0.5"),
    context: gptCard.includes("1.05M context"),
    inUse: gptCard.includes("Added"),
  };
  const pageStatus1 = document.querySelector(".minih-router-page-status")?.textContent;

  flushSync(() => button("Next page").click());
  const pageTwo = () => modelIds();
  await waitFor(() => pageTwo()[0] === "model-12", "page two did not load");
  const pageStatus2 = document.querySelector(".minih-router-page-status")?.textContent;
  const prevEnabled = !button("Previous page").disabled;

  // Search settles, then starts on page one.
  const search = document.querySelector('input[aria-label="Search models, vendors or groups"]');
  flushSync(() => setValue(search, "gpt"));
  await waitFor(
    () => pageTwo().length === 1 && pageTwo()[0] === "gpt-4.1",
    "search did not filter the plaza",
  );
  const searchSentPageOne = apiCalls.some((call) =>
    call.channel === "minih-agent-desktop/providers/minihRouter/models" && call.input.query === "gpt" && call.input.page === 1);
  const paginationHiddenForOnePage = !document.querySelector(".minih-router-pagination");

  // 4) A failed read is reported in place, and Retry recovers.
  failModels = true;
  flushSync(() => button("Refresh").click());
  await waitFor(() => document.body.innerText.includes("Couldn't load models"), "the failure was not shown");
  const failureDetail = document.body.innerText.includes("gateway unavailable");
  const keptPreviousPage = pageTwo().length === 1;
  failModels = false;
  flushSync(() => button("Retry").click());
  await waitFor(() => !document.body.innerText.includes("Couldn't load models"), "Retry did not recover");

  // 5) EasyTier virtual LAN status, TUN elevation, and custom network settings.
  const lanSection = await waitFor(
    () => document.querySelector('[data-testid="minih-router-lan"]'),
    "EasyTier LAN section did not render",
  );
  const initialLanText = lanSection.innerText;
  const lanInitial = {
    connected: initialLanText.includes("Connected"),
    noTunMode: initialLanText.includes("No-TUN (User-space)"),
    virtualIp: initialLanText.includes("11.11.11.20"),
    routeActive: initialLanText.includes("LAN Tunnel (11.11.11.10:3001/v1)"),
  };
  flushSync(() => button("Enable TUN Mode (Admin)").click());
  await waitFor(
    () => lanSection.innerText.includes("TUN (Virtual NIC)"),
    "TUN elevation did not switch the displayed mode",
  );
  flushSync(() => button("LAN Settings").click());
  const netNameInput = await waitFor(
    () => document.querySelector('input[aria-label="Network Name"]'),
    "Network Name input did not appear",
  );
  flushSync(() => setValue(netNameInput, "custom-lan"));
  flushSync(() => button("Save LAN Settings").click());
  await waitFor(
    () => !document.querySelector('[data-testid="minih-router-lan-form"]'),
    "LAN Settings form did not close after saving",
  );
  const lanConfigured = apiCalls.some(
    (call) =>
      call.channel === "minih-agent-desktop/easytier/configure" &&
      call.input?.networkName === "custom-lan",
  );

  const routerCalls = apiCalls.filter((call) => call.channel.startsWith("minih-agent-desktop/providers/minihRouter/"));
  return {
    featuredFirst,
    listedOnce,
    baseUrlPrefilled,
    tokenFieldShown,
    createdRow,
    convertedRow,
    balance,
    firstPageCount: firstPage.length,
    sections,
    prices,
    pageStatus1,
    pageStatus2,
    prevEnabled,
    searchSentPageOne,
    paginationHiddenForOnePage,
    failureDetail,
    keptPreviousPage,
    lanInitial,
    lanConfigured,
    rendererNeverSendsToken: routerCalls.every((call) => !JSON.stringify(call.input).includes("sk-gl-user-token")),
    callsNameTheRow: routerCalls.every((call) => call.input.providerId === "router-1"),
  };
};
`;

test("Minih Router: add with a token, then see balance and a paged, priced model list", {
  timeout: 90_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.minih-router-ui-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "minih-router-settings.jsx"),
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
  const win = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.minihRouterProbe()");
    console.log("MINIH_ROUTER_PROBE " + JSON.stringify(result));
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith("MINIH_ROUTER_PROBE "));
    assert(line, output.slice(-6000));
    const result = JSON.parse(line.slice("MINIH_ROUTER_PROBE ".length));
    assert.deepEqual(result, {
      featuredFirst: true,
      listedOnce: true,
      baseUrlPrefilled: true,
      tokenFieldShown: true,
      createdRow: {
        vendorKey: "minih-router",
        baseUrl: "https://router.example.com/v1",
        apiStyle: "chat_completions",
        secretValue: "sk-gl-user-token",
      },
      convertedRow: {
        keptAddress: "http://11.11.11.10:3001/v1",
        formatShown: true,
        vendorKey: "minih-router",
        baseUrl: "http://11.11.11.10:3001/v1",
        apiStyle: "responses",
        tokenUntouched: true,
      },
      balance: {
        headlineIsLowestShare: true,
        remaining: true,
        total: true,
        spent: true,
        requests: true,
        multiplier: true,
        neverExpires: true,
      },
      firstPageCount: 12,
      sections: {
        myModelsFirst: true,
        allModelsSecond: true,
        chosenListedWithPrice: true,
        chosenCountedOnce: true,
        unpricedHandled: true,
      },
      prices: {
        input: true,
        output: true,
        startingPrice: true,
        cache: true,
        context: true,
        inUse: true,
      },
      pageStatus1: "Page 1 of 3 · 30 models",
      pageStatus2: "Page 2 of 3 · 30 models",
      prevEnabled: true,
      searchSentPageOne: true,
      paginationHiddenForOnePage: true,
      failureDetail: true,
      keptPreviousPage: true,
      lanInitial: {
        connected: true,
        noTunMode: true,
        virtualIp: true,
        routeActive: true,
      },
      lanConfigured: true,
      rendererNeverSendsToken: true,
      callsNameTheRow: true,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
