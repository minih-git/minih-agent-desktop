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
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { Sidebar } from "../../apps/desktop/src/components/Sidebar";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) },
    "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } },
  interpolation: { escapeValue: false } });
const requests = [];
const pending = [];
const unexpected = [];
let primeObserved = false;
window.minihAgent = { platform: "linux", on() { return () => {}; },
  invoke(channel, input) {
    if (channel === IPC.invoke.providersMinihRouterAccount) {
      requests.push(input);
      return new Promise(resolve => pending.push({ id: input.providerId, resolve }));
    }
    if (channel === IPC.invoke.updatesGetState) return Promise.resolve({ ok: true, data: { status: "idle", currentVersion: "0.20.5" } });
    unexpected.push(channel);
    return Promise.resolve({ ok: false, error: { code: "TEST_UNEXPECTED", message: "Unexpected fixture request" } });
  } };
const makeProvider = (id, label) => ({
  id, name: label, oauthAccountLabel: label, vendorKey: "minih-router", type: "openai_compatible",
  protocol: "openai_compatible", authKind: "api_key_and_base_url",
  baseUrl: "https://router.example.test/v1", enabled: true, hasSecret: true, hasOauth: false, models: [],
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
});
const first = makeProvider("router-a", "My account");
const second = makeProvider("router-b", "Second account");
useAppStore.setState({ providers: [first], sessions: [], openProjects: [], openProjectPaths: [],
  workspace: null, activeProjectPath: null, activeSessionId: null, page: "chat", settingsTab: "general",
  settings: { theme: "light", defaultMode: "agent", enterToSend: true, onboardingDismissed: true },
  version: { version: "0.20.5" }, });
const node = createRoot(document.getElementById("root"));
flushSync(() => node.render(<Sidebar onToggleSidebar={() => {}} sidebarToggleShortcut="Ctrl+B" sidebarWidth={275}
  onWidthChange={() => {}} onWidthCommit={() => {}} />));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(value, message) { if (!value) throw new Error(message); }
const trigger = () => document.querySelector('[data-nav="user"]');
const panel = () => document.querySelector('[data-sidebar-user-popover]');
const account = (remaining = "87.5") => ({
  keyName: "Desktop", maskedKey: "sk-…xxxx", status: "active", expiresAtMs: null, expired: false,
  priceMultiplier: "1", rpmLimit: 60, allowed: true, nextAvailableAtMs: null,
  quotas: [
    { id: 1, kind: "period", periodSeconds: 18000, limitUsd: "100", usedUsd: "12.5", remainingUsd: remaining, windowEndsAtMs: 1760600000000, status: "ok" },
    { id: 2, kind: "period", periodSeconds: 604800, limitUsd: "500", usedUsd: "50", remainingUsd: "450", windowEndsAtMs: 1761000000000, status: "ok" },
  ],
  usage: { days: 30, requestCount: 321, totalTokens: 987654, costUsd: "12.5" }, observedAtMs: 1760000000000,
});
async function answer(id, data, error = false) {
  const index = pending.findIndex(value => value.id === id);
  check(index >= 0, "expected pending quota request for " + id);
  pending.splice(index, 1)[0].resolve(error
    ? { ok: false, error: { code: "FIXTURE_OFFLINE", message: "fixture-private-diagnostic" } }
    : { ok: true, data });
  await settle();
}
const key = value => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
async function open() { trigger().click(); await settle(); check(panel(), "popover opens"); }
window.userMenuProbe = async ({ theme, locale }) => {
  document.documentElement.dataset.theme = theme;
  await i18n.changeLanguage(locale);
  await settle();
  const startRequests = requests.length;
  check(requests.length === startRequests, "closed menu adds no request");
  for (const destination of ["scheduled", "plugins", "activity"]) {
    check(document.querySelector('.sidebar-destinations [data-nav="' + destination + '"]')?.textContent.trim(), "labeled sidebar destination " + destination);
    check(!document.querySelector('.sidebar-footer [data-nav="' + destination + '"]'), "utility removed from footer");
  }
  check(document.querySelector(".notification-trigger"), "notification remains reachable");
  check(document.querySelector('[data-nav="build"]')?.textContent.includes("0.20.5"), "version remains reachable");
  if (!primeObserved && pending.some((value) => value.id === "router-a")) {
    primeObserved = true;
    // The startup prime: one background read fills the trigger label
    // without opening the menu.
    check(requests.length === 1 && Object.keys(requests[0]).join() === "providerId", "startup primes the account name once");
    check(trigger().querySelector(".sidebar-user-trigger-name")?.textContent === "My account", "trigger falls back to the row label before the prime answers");
    await answer("router-a", account());
    check(trigger().querySelector(".sidebar-user-trigger-name")?.textContent === "Desktop", "trigger shows the gateway key name right after startup");
  }
  const beforeOpen = requests.length;
  await open();
  check(trigger().getAttribute("aria-expanded") === "true", "trigger expanded state");
  check(document.activeElement === panel(), "focus enters dialog");
  check(panel().querySelector('[role="status"]'), "loading state visible");
  check(panel().querySelector(".sidebar-user-identity-copy strong")?.textContent === "My account", "identity falls back to the row label while loading");
  check(requests.length === beforeOpen + 1 && Object.keys(requests.at(-1)).join() === "providerId", "quota request only names saved account");
  await answer("router-a", account());
  check(panel().querySelector(".sidebar-user-identity-copy strong")?.textContent === "Desktop", "identity shows the gateway key name once loaded");
  check(panel().textContent.includes("87.50"), "balance renders");
  check(panel().textContent.includes("321"), "usage renders");
  check(panel().querySelectorAll(".minih-router-quota").length === 1, "headline quota is not duplicated in secondary quota list");
  const spentRect = panel().querySelectorAll(".minih-router-stat")[1].getBoundingClientRect();
  const expiresRect = panel().querySelector(".minih-router-stat.is-expires").getBoundingClientRect();
  check(expiresRect.width > spentRect.width * 1.5, "expires card spans full row in popover");
  const box = panel().getBoundingClientRect();
  check(box.left >= 11 && box.right <= innerWidth - 11 && box.top >= 11 && box.bottom <= innerHeight - 11, "popover fits viewport");
  check(panel().scrollWidth <= panel().clientWidth + 1, "no horizontal quota overflow");
  check(getComputedStyle(panel()).zIndex === "60", "popover above shell");
  key("Home"); check(document.activeElement.tagName === "BUTTON", "keyboard reaches actions");
  key("End"); check(document.activeElement.dataset.nav === "configSync", "End reaches last action");
  key("Escape"); await settle();
  check(!panel() && document.activeElement === trigger(), "Escape closes and returns focus");
  // The resolved gateway key name now labels the collapsed trigger too.
  check(trigger().querySelector(".sidebar-user-trigger-name")?.textContent === "Desktop",
    "trigger shows the remembered gateway key name after a read");
  const closedRequests = requests.length; await settle();
  check(requests.length === closedRequests, "closed menu stays idle");

  await open();
  await answer("router-a", null, true);
  check(panel().querySelector('[role="alert"]'), "quota failure visible");
  check(!panel().textContent.includes("fixture-private-diagnostic"), "raw error not exposed");
  panel().querySelector(".sidebar-user-quota-heading button").click(); await settle();
  await answer("router-a", account());
  check(!panel().querySelector('[role="alert"]'), "refresh recovers error");
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); await settle();
  check(!panel(), "outside pointer dismisses");

  await open();
  flushSync(() => useAppStore.setState({ providers: [second] })); await settle();
  check(!panel().textContent.includes("87.50"), "switch hides previous balance immediately");
  await answer("router-a", account("99"));
  check(!panel().textContent.includes("99.00"), "late old account reply ignored");
  // Two reads are in flight for the new row: the popover's own and the
  // trigger-label prime. Answer both; the popover shows the second answer.
  await answer("router-b", account("42"));
  await answer("router-b", account("42"));
  check(panel().textContent.includes("42.00"), "new account quota visible");
  panel().querySelector('[data-nav="accounts"]').click(); await settle();
  check(!panel() && useAppStore.getState().page === "settings" && useAppStore.getState().settingsTab === "accounts", "account management navigation");
  await open(); panel().querySelector('[data-nav="configSync"]').click(); await settle();
  check(!panel() && useAppStore.getState().settingsTab === "sync", "cloud sync navigation");
  flushSync(() => useAppStore.getState().setPage("chat")); await settle();
  await open(); panel().querySelector('[data-nav="settings"]').click(); await settle();
  check(!panel() && useAppStore.getState().page === "settings", "settings navigation");
  flushSync(() => useAppStore.getState().setPage("chat")); await settle();
  document.querySelector('[data-nav="scheduled"]').click(); await settle();
  check(useAppStore.getState().page === "scheduled", "scheduled navigation");
  check(document.querySelector('[data-nav="scheduled"]').getAttribute("aria-current") === "page", "scheduled selected state");
  document.querySelector('[data-nav="plugins"]').click(); await settle();
  check(useAppStore.getState().page === "plugins", "plugins navigation");
  document.querySelector('[data-nav="plugins"]').click(); await settle();
  check(useAppStore.getState().page === "scheduled", "plugins second activation goes back");
  document.querySelector('[data-nav="activity"]').click(); await settle();
  check(document.querySelector('[data-sidebar-activity-panel]'), "activity navigation");

  flushSync(() => useAppStore.setState({ providers: [] })); await settle();
  const beforeEmpty = requests.length; await open();
  check(panel().textContent.includes(i18n.t("userMenu.connectHint")), "unconnected action shown");
  check(requests.length === beforeEmpty, "no quota read without account");
  const outside = document.getElementById("outside");
  outside.focus();
  check(document.activeElement === outside, "focus moves outside the menu");
  // A hidden Electron window updates activeElement without dispatching focusin.
  outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  await settle();
  check(!panel(), "focus leaving dismisses dialog");
  const footer = document.querySelector(".sidebar-footer").getBoundingClientRect();
  check(footer.bottom <= innerHeight && footer.right <= 276, "footer stays within sidebar");
  flushSync(() => node.unmount());
  while (pending.length) pending.shift().resolve({ ok: true, data: account() });
  await settle();
  check(!document.querySelector('[data-sidebar-user-popover]'), "unmount removes portaled dialog");
  check(unexpected.length === 0, "unexpected IPC: " + unexpected.join());
  return { passed: true, theme, locale };
};
`;

test("Sidebar account menu: quotas, keyboard, navigation, stale replies and empty profile", {
  timeout: 90_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.user-menu-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
      loader: { ".png": "file" },
      alias: {
        "@minih-agent/i18n": join(root, "packages/i18n/src"),
        "@minih-agent/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      }, nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "renderer.css"), (await loadStyles()).replace(/@theme(?: inline)?\s*\{/g, ":root {"));
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="renderer.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex}#outside{position:fixed;top:100px;left:500px}.sidebar{--ds-sidebar-width:275px;width:275px;height:100%}</style><div id="root"></div><button id="outside">Outside</button><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 560,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", event => console.error(event.message));
  try {
    const results = [];
    for (const [theme, locale, width, height] of [["light", "en", 800, 560], ["dark", "zh-CN", 1200, 900]]) {
      win.setContentSize(width, height);
      await win.loadFile(path.join(__dirname, "index.html"));
      results.push(await win.webContents.executeJavaScript("window.userMenuProbe(" + JSON.stringify({ theme, locale }) + ")"));
    }
    console.log("USER_MENU_PROBE " + JSON.stringify(results)); app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding("utf8"); stream.on("data", chunk => { output += chunk; }); }
    const timer = setTimeout(() => child.kill("SIGKILL"), 75_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find(entry => entry.startsWith("USER_MENU_PROBE "));
    assert.ok(line, output.slice(-6000));
    const results = JSON.parse(line.slice("USER_MENU_PROBE ".length));
    assert.equal(results.length, 2);
    assert.ok(results.every(value => value.passed));
  } finally { await rm(temp, { recursive: true, force: true }); }
});
