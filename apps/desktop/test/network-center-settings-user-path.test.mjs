/**
 * Isolated Electron user path for the network center section.
 *
 * 1. A normal profile never sees the section: the channel is driven by the
 *    gateway and has nothing for the user to configure.
 * 2. Developer mode reveals it, titled "Network Center" with no vendor name.
 * 3. Its default state shows status only — no identity inputs, because the
 *    gateway issues the identity.
 * 4. "Configure the network identity manually" reveals the fields, and saving
 *    sends `identity: "manual"` with the typed parameters.
 * 5. A channel that is holding shows the gateway's reason and the note that the
 *    Router endpoint must be publicly reachable.
 *
 * IPC is answered by a fake main; the page, the section and the formatting are
 * the real renderer code.
 */
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
import { AccountsPage } from "../../apps/desktop/src/components/settings/AccountsPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

window.addEventListener("error", (event) => console.error("FIXTURE_ERROR " + (event.error?.stack ?? event.message)));

const apiCalls = [];
let configured = null;
let settings = { developerMode: false };
let providers = [];

function routerRow() {
  return {
    id: "router-1", name: "Minih Router", vendorKey: "minih-router",
    type: "openai_compatible", protocol: "openai_compatible",
    authKind: "api_key_and_base_url", apiStyle: "chat_completions",
    baseUrl: "https://router.hmini.org/v1", hasSecret: true, enabled: true,
    models: [],
  };
}

// What host-core reports for a channel the gateway answered.
function issuedStatus() {
  return {
    enabled: true,
    configuredMode: "no_tun",
    effectiveMode: "no_tun",
    identity: "gateway",
    state: "connected",
    virtualIpv4: "11.12.0.10",
    localForwardPort: 25890,
    localForwardUrl: "http://127.0.0.1:25890/v1",
    activeRouterBaseUrl: "http://127.0.0.1:25890/v1",
    fallbackRouterBaseUrl: "https://router.hmini.org/v1",
    routerLanUrl: "http://11.12.0.1:3001/v1",
    usingLan: true,
    routerLanReachable: true,
    peerCount: 2,
    peers: ["udp://router.hmini.org:11012"],
    bootstrapPeers: ["udp://router.hmini.org:11012"],
    dhcp: true,
    staticIpv4: "",
    bootstrapSource: "gateway",
    bootstrapNetworkName: "minih-router",
    bootstrapError: "",
    networkName: "minih-router",
    lastError: null,
    updatedAtMs: 1760000000000,
    remoteGateway: {
      available: false, hostlinkUrl: "", publicOrigin: "", caPem: "",
      dialUrl: "", tlsServerName: "", localForwardPort: null,
      unavailableReason: "the Router does not offer account mode",
    },
  };
}

// What it reports when the gateway refuses or cannot be reached: nothing starts,
// requests stay on the public endpoint, and the reason is carried for the panel.
function heldStatus() {
  return {
    ...issuedStatus(),
    effectiveMode: "disabled",
    state: "error",
    virtualIpv4: null,
    localForwardPort: null,
    localForwardUrl: null,
    activeRouterBaseUrl: "https://router.hmini.org/v1",
    usingLan: false,
    routerLanReachable: false,
    peerCount: 0,
    bootstrapSource: "gateway",
    bootstrapNetworkName: "",
    bootstrapError:
      "gateway does not serve the bootstrap endpoint",
  };
}

let currentStatus = issuedStatus();

window.minihAgent = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, ...args) {
    const input = args[0];
    apiCalls.push({ channel, input });
    switch (channel) {
      case "minih-agent-desktop/settings/get":
        return { ok: true, data: settings };
      case "minih-agent-desktop/settings/set":
        settings = { ...settings, ...input };
        return { ok: true, data: settings };
      case "minih-agent-desktop/providers/list":
        return { ok: true, data: { providers } };
      case "minih-agent-desktop/session/list":
        return { ok: true, data: { sessions: [] } };
      case "minih-agent-desktop/app/getOnboarding":
        return { ok: true, data: { completed: true, steps: [] } };
      case "minih-agent-desktop/plugin/list":
        return { ok: true, data: { plugins: [] } };
      case "minih-agent-desktop/providerCatalog":
      case "minih-agent-desktop/plugin/providerCatalog":
        return { ok: true, data: [] };
      case "minih-agent-desktop/providers/minihRouter/account":
        return { ok: true, data: {
          keyName: "desktop", maskedKey: "sk-gl-…cret", status: "active",
          expiresAtMs: null, expired: false, priceMultiplier: "1", rpmLimit: 60,
          allowed: true, nextAvailableAtMs: null, quotas: [],
          usage: { days: 30, requestCount: 0, totalTokens: 0, costUsd: "0" },
          observedAtMs: 1760000000000,
        } };
      case "minih-agent-desktop/providers/minihRouter/modelDetails":
        return { ok: true, data: [] };
      case "minih-agent-desktop/easytier/status":
        return { ok: true, data: currentStatus };
      case "minih-agent-desktop/easytier/configure":
        configured = input;
        return { ok: true, data: currentStatus };
      case "minih-agent-desktop/easytier/reconnect":
        return { ok: true, data: currentStatus };
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
function toggle(label) {
  return document.querySelector('button[role="switch"][aria-label="' + label + '"]');
}
function setValue(input, value) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  valueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function mount(element) {
  flushSync(() => rootNode.render(element));
}
const panel = () => document.querySelector('[data-testid="minih-router-lan"]');
const form = () => document.querySelector('[data-testid="minih-router-lan-form"]');

const rootNode = createRoot(document.getElementById("root"));

window.networkCenterProbe = async () => {
  // A normal profile: the connected account card, and no network center at all.
  providers = [routerRow()];
  settings = { developerMode: false };
  currentStatus = issuedStatus();
  useAppStore.setState({ providers, settings });
  mount(React.createElement(AccountsPage));
  await waitFor(() => document.body.innerText.includes("Connected"), "the account card did not render");
  const hiddenOutsideDeveloperMode = !panel();

  // Developer mode: the section appears, titled without a vendor name.
  settings = { developerMode: true };
  useAppStore.setState({ settings });
  mount(React.createElement(AccountsPage));
  const shownInDeveloperMode = await waitFor(() => panel(), "the section did not render");
  const title = shownInDeveloperMode.querySelector(".minih-router-models-title")?.textContent ?? "";
  // The identity fields belong to nobody by default: the gateway issues it.
  const noIdentityFieldsByDefault = !form() &&
    !document.querySelector('input[aria-label="Network Name"]');
  // The gateway's own network name is shown, read-only.
  const issuedNetworkName =
    document.querySelector('[data-testid="minih-router-lan-network-name"]')?.textContent ?? "";
  const mentionsEasyTier = shownInDeveloperMode.innerText.includes("EasyTier");

  // The manual switch reveals the escape hatch.
  const manualSwitch = await waitFor(
    () => toggle("Configure the network identity manually"),
    "the manual identity switch did not render",
  );
  flushSync(() => manualSwitch.click());
  const identityForm = await waitFor(() => form(), "the manual identity form did not appear");
  const fieldLabels = [...identityForm.querySelectorAll("input")].map(
    (node) => node.getAttribute("aria-label"),
  );
  // The secret is never prefilled: nothing may be invented in its place.
  const secretField = identityForm.querySelector('input[type="password"]');
  const secretPrefilled = (secretField?.value ?? "") !== "";

  const nameInput = identityForm.querySelector('input[aria-label="Network Name"]');
  flushSync(() => setValue(nameInput, "self-hosted-net"));
  flushSync(() => setValue(secretField, "typed-network-secret"));
  const save = await waitFor(() => button("Save LAN Settings"), "the save action did not render");
  flushSync(() => save.click());
  await waitFor(() => configured, "the manual save never reached the host");
  const manualSave = {
    identity: configured?.identity ?? null,
    name: configured?.networkName ?? null,
    secret: configured?.networkSecret ?? null,
  };

  // A channel without an identity says why, and what makes it fixable. The page
  // is remounted so the hook re-reads the status instead of keeping the previous
  // answer.
  configured = null;
  currentStatus = heldStatus();
  mount(null);
  mount(React.createElement(AccountsPage));
  const hold = await waitFor(
    () => document.querySelector('[data-testid="minih-router-lan-hold"]'),
    "the hold reason did not render",
  );
  const holdReason = hold.innerText.replace(/\s+/g, " ").trim();
  const identityInputsWhileHeld = Boolean(form());

  return {
    hiddenOutsideDeveloperMode,
    shownInDeveloperMode: Boolean(shownInDeveloperMode),
    title,
    noIdentityFieldsByDefault,
    issuedNetworkName,
    mentionsEasyTier,
    fieldLabels,
    secretPrefilled,
    configuredIdentity: manualSave.identity,
    configuredName: manualSave.name,
    configuredSecret: manualSave.secret,
    // The reason names the gateway's answer, and the fix is stated.
    holdNamesReason: holdReason.includes("does not serve"),
    endpointHintShown: holdReason.includes("public internet"),
    // A holding channel shows status only: the fields are for a manual identity.
    identityInputsWhileHeld,
  };
};
`;

test("Network center: developer-only section, gateway-issued identity, manual escape hatch", {
  timeout: 90_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.network-center-ui-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "network-center.jsx"),
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
      join(temp, "renderer.css"),
      (await loadStyles()).replace(/@theme(?: inline)?\s*\{/g, ":root {"),
    );
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="renderer.css"><body><div id="root"></div><script type="module" src="renderer.js"></script>',
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
    const results = [];
    win.setContentSize(1200, 900);
    await win.loadFile(path.join(__dirname, "index.html"));
    results.push(await win.webContents.executeJavaScript("window.networkCenterProbe()"));
    console.log("NETWORK_CENTER_PROBE " + JSON.stringify(results));
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith("NETWORK_CENTER_PROBE "));
    assert(line, output.slice(-6000));
    const [result] = JSON.parse(line.slice("NETWORK_CENTER_PROBE ".length));
    assert.deepEqual(result, {
      hiddenOutsideDeveloperMode: true,
      shownInDeveloperMode: true,
      title: "Network Center",
      noIdentityFieldsByDefault: true,
      issuedNetworkName: "minih-router",
      mentionsEasyTier: false,
      fieldLabels: [
        "Network Name",
        "Network Secret",
        "Router LAN Address",
        "Bootstrap Peers (comma or newline separated)",
      ],
      secretPrefilled: false,
      configuredIdentity: "manual",
      configuredName: "self-hosted-net",
      configuredSecret: "typed-network-secret",
      holdNamesReason: true,
      endpointHintShown: true,
      identityInputsWhileHeld: false,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
