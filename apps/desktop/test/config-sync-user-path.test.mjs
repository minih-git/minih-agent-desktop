import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { ConfigSyncPage } from "../../apps/desktop/src/components/settings/ConfigSyncPage";
import { Checkbox } from "../../apps/desktop/src/components/ui";
import { selectionFromDraft } from "../../apps/desktop/src/features/settings/config-sync-form";
import { CONFIG_SYNC_DRAFT_STORAGE_KEY } from "../../apps/desktop/src/features/settings/config-sync-preferences";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const label = (key) => i18n.t("settings.configSync." + key);
const listeners = new Map();
const calls = [];
const confirmations = [];
const initial = { configured: false, enabled: false, paused: false, locked: false,
  status: "notConfigured", mode: "sync", accountConnected: false, automaticSync: true,
  categories: selectionFromDraft(), includeSecrets: false,
  includeMemory: false, pendingApprovals: [], mappings: [] };
const connected = { accountConnected: true, accountEndpoint: "https://router.example.com" };
let state = initial;
let releaseSync;
let holdSync = true;
let holdHistory = false;
let releaseHistory;
const emitState = () => {
  for (const callback of listeners.get(IPC.event.configSyncChanged) ?? []) callback(state);
};
const history = () => [
  { revisionId: "current-" + state.accountEndpoint, createdAt: "2026-01-02T00:00:00Z", entityCount: 1, current: true },
  { revisionId: "older-" + state.accountEndpoint, createdAt: "2026-01-01T00:00:00Z", entityCount: 1, current: false },
];
window.confirm = (message) => { confirmations.push(message); return true; };
window.minihAgent = { platform: "darwin", channels: IPC,
  on(channel, callback) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(callback);
    return () => listeners.get(channel).delete(callback);
  },
  async invoke(channel, input) {
    calls.push({ channel, input: input === undefined ? undefined : JSON.parse(JSON.stringify(input)) });
    let data;
    if (channel === IPC.invoke.configSyncGetState) data = state;
    else if (channel === IPC.invoke.configSyncTest) data = { ok: true, conditionalWrites: true };
    else if (channel === IPC.invoke.configSyncConfigure) {
      const { backupPassword, ...publicFields } = input;
      state = { ...state, ...publicFields, configured: true, enabled: true, status: "upToDate" };
      data = state;
    } else if (channel === IPC.invoke.configSyncSyncNow) {
      state = { ...state, status: "syncing" };
      emitState();
      if (holdSync) await new Promise((resolve) => { releaseSync = resolve; });
      state = { ...state, status: "upToDate" };
      emitState();
      data = state;
    } else if (channel === IPC.invoke.configSyncListHistory) {
      const captured = history();
      if (holdHistory) {
        holdHistory = false;
        await new Promise((resolve) => { releaseHistory = resolve; });
      }
      data = captured;
    } else if (channel === IPC.invoke.configSyncRestore) data = state;
    else if (channel === IPC.invoke.configSyncApprove || channel === IPC.invoke.configSyncReject) {
      state = {
        ...state,
        status: "upToDate",
        pendingApprovals: state.pendingApprovals.filter((item) => item.id !== input.approvalId),
      };
      data = state;
    }
    else if (channel === IPC.invoke.configSyncPause) data = state = { ...state, paused: input.paused };
    else if (channel === IPC.invoke.configSyncUnlock) data = state = { ...state, locked: false, status: "upToDate" };
    else if (channel === IPC.invoke.configSyncChangePassword) data = state;
    else if (channel === IPC.invoke.configSyncDisconnect) data = state = { ...initial, ...connected };
    else throw new Error("Unexpected IPC: " + channel);
    return { ok: true, data };
  },
};
localStorage.setItem("pi.desktop.configSyncDraft", JSON.stringify({ endpoint: "https://legacy.example.com" }));
localStorage.setItem("pi.desktop.configSyncS3Draft.v1", JSON.stringify({ endpoint: "https://s3.example.com", bucket: "private-config" }));
let view;
const mount = () => { view = createRoot(document.getElementById("root")); flushSync(() => view.render(React.createElement(ConfigSyncPage))); };
const check = (value, message) => { if (!value) throw new Error(message); };
const frame = () => new Promise(requestAnimationFrame);
const until = async (condition, message) => {
  const end = performance.now() + 5000;
  while (!condition()) { if (performance.now() > end) throw new Error(message); await frame(); }
};
const input = (key) => document.querySelector('input[aria-label="' + label(key) + '"]');
const button = (key) => [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === label(key));
const last = (name) => calls.filter((call) => call.channel === IPC.invoke[name]).at(-1)?.input;
const fill = async (key, value) => {
  const element = input(key); check(element, "missing input " + key);
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await frame();
};
const toggle = async (key) => {
  const control = [...document.querySelectorAll('input[type="checkbox"], button[role="switch"]')].find((node) =>
    node.getAttribute("aria-label") === label(key) || node.closest("label")?.textContent.trim() === label(key));
  check(control, "missing boolean control " + key);
  flushSync(() => control.click()); await frame();
};
const disclosure = (key) => [...document.querySelectorAll("details")].find((node) =>
  node.querySelector(":scope > summary")?.textContent.trim() === label(key));
const expand = async (key) => {
  const element = disclosure(key); check(element, "missing disclosure " + key);
  if (!element.open) { element.querySelector("summary").click(); await frame(); }
};
const choose = async (key, value) => {
  const trigger = [...document.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label(key));
  flushSync(() => trigger.click()); await frame();
  const option = [...document.querySelectorAll('[role="option"]')].find((node) => node.textContent.trim() === label(value));
  check(option, "missing option " + value); flushSync(() => option.click()); await frame();
};
const click = async (key) => { check(button(key) && !button(key).disabled, "action unavailable " + key); flushSync(() => button(key).click()); await frame(); };
const ready = () => until(() => button("save") && !button("save").disabled, "save did not settle");
const connectAccount = () => {
  state = { ...state, ...connected };
  flushSync(() => { for (const callback of listeners.get(IPC.event.configSyncChanged) ?? []) callback(state); });
};
const verifyNoSecrets = () => {
  const cache = localStorage.getItem(CONFIG_SYNC_DRAFT_STORAGE_KEY) ?? "";
  check(!/test-password|test-password-new|backupPassword|[Pp]assword/.test(cache), "secret leaked into draft");
};
mount();
window.configSyncProbe = async () => {
  await until(() => button("enable"), "initial page missing");
  // Without a router account the setup form is replaced by a prompt card and
  // every setup action stays disabled.
  check(document.body.textContent.includes(label("accountRequiredTitle")), "account prompt missing");
  check(document.body.textContent.includes(label("accountRequiredBody")), "account prompt body missing");
  check(button("goToAccounts") && !button("goToAccounts").disabled, "accounts shortcut missing");
  check(button("enable").disabled, "setup enabled without an account");
  check(!input("deviceLabel"), "setup inputs must not render without an account");
  connectAccount();
  await until(() => input("deviceLabel"), "connected account did not reveal the setup form");
  check(document.body.textContent.includes(label("accountTitle")), "account card missing");
  check(document.body.textContent.includes(state.accountEndpoint), "account endpoint missing");
  check(!document.body.textContent.includes(label("accountRequiredTitle")), "prompt outlived the account");
  const page = document.querySelector(".settings-config-sync");
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme;
    for (const width of [380, 900]) {
      page.style.width = width + "px"; await frame();
      check(page.scrollWidth <= page.clientWidth, "settings overflow at " + width + " in " + theme);
      const columns = getComputedStyle(document.querySelector(".settings-config-sync-form")).gridTemplateColumns.split(" ");
      check(columns.length === (width < 560 ? 1 : 2), "form columns do not follow available width");
    }
  }
  page.style.removeProperty("width");
  await expand("categoriesTitle");
  check(document.querySelectorAll(".settings-config-sync-category").length === 10, "scope must contain supported categories only");
  check(!document.body.textContent.includes("Projects and folder mappings"), "removed project category still visible");
  await toggle("categoryProviders");
  check(localStorage.getItem("pi.desktop.configSyncS3Draft.v1") === null, "legacy S3 draft retained after a write");
  check(![...document.querySelectorAll('input[type="checkbox"]')].find((node) => node.closest("label")?.textContent.trim() === label("categoryCredentials")).checked, "credentials opted in by default");
  await toggle("categoryCredentials");
  check(document.querySelector(".settings-config-sync-warning")?.checkVisibility(), "credential opt-in warning hidden");
  await toggle("categoryCredentials");
  await fill("deviceLabel", "MacBook");
  await fill("backupPassword", "short1");
  check(button("enable").disabled, "short vault password must keep setup disabled");
  const passwordHelp = [...document.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label("backupPasswordHint"));
  check(passwordHelp?.getAttribute("aria-label").includes("8"), "password help must expose the eight-character minimum");
  await fill("backupPassword", "test-password");
  check(!button("enable").disabled, "valid vault password must enable setup");
  await choose("mode", "modeBackup");
  await toggle("automaticSync");
  verifyNoSecrets();
  await until(() => button("testConnection") && !button("testConnection").disabled, "probe did not become ready");
  await click("testConnection");
  await until(() => !button("testConnection").disabled, "probe did not settle");
  check(last("configSyncTest") === undefined, "probe must not carry a renderer payload");
  await click("enable");
  await until(() => releaseSync, "first run did not start");
  check(input("backupPassword").value.length === 0, "transient vault password remained after configure");
  check(last("configSyncConfigure").backupPassword === "test-password", "vault password missing");
  check(last("configSyncConfigure").deviceLabel === "MacBook", "device label lost");
  flushSync(() => view.unmount());
  mount();
  await until(() => button("backupNow")?.disabled, "re-entered settings did not restore active sync state");
  holdSync = false;
  releaseSync();
  await until(() => button("backupNow") && !button("backupNow").disabled, "background sync did not complete after navigation");
  await ready();
  await until(() => document.body.textContent.includes("older-https://router.example.com"), "history missing");
  flushSync(() => view.unmount()); mount(); await ready();
  check(input("deviceLabel").value === "MacBook", "saved choices not hydrated");
  check(!disclosure("connectionTitle").open, "saved connection must start collapsed");
  check(button("backupNow")?.checkVisibility(), "manual run must stay visible above settings");
  await toggle("pauseTitle"); await ready();
  check(button("backupNow").disabled, "paused device still permits manual run");
  await toggle("pauseTitle"); await ready();
  check(!button("backupNow").disabled, "resume did not restore manual run");
  await expand("connectionTitle");
  await expand("historyTitle");
  check(input("backupPassword").value === "", "vault password returned on reopen");
  await click("save"); await ready();
  const resaved = last("configSyncConfigure");
  check(resaved.deviceLabel === "MacBook" && resaved.automaticSync === false && resaved.mode === "backup", "resave lost saved choices");
  check(resaved.backupPassword === "", "blank vault password must mean keep");
  verifyNoSecrets();
  await choose("mode", "modeSync");
  await click("restore"); await ready();
  check(confirmations.at(-1) === label("restoreBackupConfirm"), "unsaved mode changed restore semantics");
  check(last("configSyncRestore").acknowledgePropagation === false, "backup restore propagated");
  await click("save"); await ready();
  await until(() => [...document.querySelectorAll("button")].some((node) => node.textContent.trim() === label("restore") && !node.disabled), "sync history missing");
  const restore = [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === label("restore") && !node.disabled);
  flushSync(() => restore.click()); await ready();
  check(confirmations.at(-1) === label("restoreConfirm") && last("configSyncRestore").acknowledgePropagation === true, "sync restore acknowledgment missing");
  holdHistory = true; await click("refreshHistory");
  await until(() => releaseHistory, "history request not held");
  state = { ...state, accountEndpoint: "https://other.example.com" };
  flushSync(() => { for (const callback of listeners.get(IPC.event.configSyncChanged) ?? []) callback(state); });
  await until(() => document.body.textContent.includes("older-https://other.example.com"), "new account history not loaded");
  releaseHistory(); await ready();
  check(!document.body.textContent.includes("older-https://router.example.com"), "stale history overwrote new account");
  // A merge conflict is one decision: a single row with one button per side,
  // and accepting a side sends that side's approval and digest.
  const pair = (side) => ({
    id: side + "-approval",
    domain: "application",
    entityId: "application:" + side,
    label: "Application preferences",
    reason: "conflict",
    digest: side + "-digest",
    createdAt: "2026-01-03T00:00:00Z",
    conflict: { baseId: "application", side },
  });
  state = { ...state, status: "conflict", pendingApprovals: [pair("local"), pair("remote")] };
  flushSync(() => { for (const callback of listeners.get(IPC.event.configSyncChanged) ?? []) callback(state); });
  const conflictRows = () => document.querySelectorAll("[data-config-sync-conflict]");
  await until(() => conflictRows().length === 1, "conflict rendered as " + conflictRows().length + " rows");
  check(document.querySelectorAll(".settings-config-sync-approval").length === 1, "conflict pair not folded into one choice");
  check(document.body.textContent.includes(label("conflictChoiceHint")), "conflict hint missing");
  check(button("conflictAcceptLocal") && button("conflictAcceptRemote"), "conflict choices missing");
  check(!button("approve") && !button("reject"), "conflict still offers approve and reject");
  const conflictPage = document.querySelector(".settings-config-sync");
  conflictPage.style.width = "380px"; await frame();
  check(conflictPage.scrollWidth <= conflictPage.clientWidth, "conflict card overflows at 380px");
  conflictPage.style.removeProperty("width");
  await click("conflictAcceptRemote");
  check(last("configSyncApprove")?.approvalId === "remote-approval" && last("configSyncApprove")?.digest === "remote-digest", "accepting the vault used the wrong side");
  await until(() => !document.querySelector('[data-config-sync-side="remote"]'), "accepted side stayed visible");
  check(button("conflictAcceptLocal") && button("reject"), "the remaining side lost its choice");
  state = { ...state, status: "upToDate", pendingApprovals: [] };
  flushSync(() => { for (const callback of listeners.get(IPC.event.configSyncChanged) ?? []) callback(state); });
  await until(() => !document.querySelector("[data-config-sync-conflict]"), "resolved conflict stayed on the page");
  await expand("maintenanceTitle");
  await fill("currentBackupPassword", "test-password");
  await fill("newBackupPassword", "test-password-new");
  await click("changePassword"); await ready();
  check(last("configSyncChangePassword").newPassword === "test-password-new", "password action lost its input");
  check(input("currentBackupPassword").value === "" && input("newBackupPassword").value === "", "password fields not cleared");
  disclosure("connectionTitle").open = false;
  state = { ...state, locked: true, status: "locked" };
  flushSync(() => { for (const callback of listeners.get(IPC.event.configSyncChanged) ?? []) callback(state); });
  await until(() => button("unlock"), "inline unlock missing");
  check(input("backupPassword").checkVisibility() && document.querySelectorAll('input[aria-label="' + label("backupPassword") + '"]').length === 1, "unlock password is hidden or duplicated");
  await fill("backupPassword", "test-password-new"); await click("unlock"); await ready();
  check(last("configSyncUnlock").backupPassword === "test-password-new", "unlock contract changed");
  verifyNoSecrets();
  await click("disconnect");
  await until(() => button("enable") && input("deviceLabel").value === "", "disconnect did not clear form");
  check(localStorage.getItem(CONFIG_SYNC_DRAFT_STORAGE_KEY) === null, "disconnect retained draft");
  check(localStorage.getItem("pi.desktop.configSyncDraft") !== null, "legacy draft deleted");
  check(input("deviceLabel") && document.body.textContent.includes(label("accountTitle")), "disconnect dropped the router account");
  flushSync(() => view.unmount());
  check(listeners.get(IPC.event.configSyncChanged)?.size === 0 && listeners.get(IPC.event.configSyncProgress)?.size === 0, "subscriptions leaked");
  return { passed: true };
};
window.checkboxProbe = async () => {
  let checked = false;
  const node = document.createElement("div"); document.body.append(node);
  const checkboxView = createRoot(node);
  const render = () => flushSync(() => checkboxView.render(<>
    <Checkbox label="Probe selection" checked={checked} onChange={(event) => { checked = event.target.checked; render(); }} />
    <Checkbox label="Probe mixed" indeterminate onChange={() => {}} />
    <Checkbox label="Probe disabled" disabled defaultChecked />
  </>));
  render();
  const controls = node.querySelectorAll("input");
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme;
    const style = getComputedStyle(controls[0]);
    check(style.appearance === "none" && style.width === "18px", "checkbox is still platform drawn in " + theme);
    check(getComputedStyle(controls[0].parentElement).gap === "8px", "checkbox label lacks spacing");
    controls[0].parentElement.click(); await frame();
    check(checked, "label click did not check input");
    await until(() => getComputedStyle(controls[0]).backgroundColor !== "rgba(0, 0, 0, 0)", "checked fill missing");
    controls[0].parentElement.click(); await frame();
    check(!checked, "label click did not uncheck input");
    check(controls[1].indeterminate && getComputedStyle(controls[1], "::after").content !== "none", "mixed indicator missing");
    controls[2].parentElement.click(); check(controls[2].checked, "disabled selection changed");
  }
  controls[0].focus();
  window.checkboxKeyboardResult = async () => {
    await until(() => checked, "Space did not toggle checkbox");
    check(parseFloat(getComputedStyle(controls[0]).outlineWidth) >= 2, "keyboard focus ring missing");
    checkboxView.unmount(); node.remove(); return { passed: true };
  };
};
`;

test("router account settings user path preserves preferences, modes, history and legacy data", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "router-settings-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
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
    await writeFile(join(temp, "styles.css"), (await loadStyles()).replace(/@theme(?: inline)?\s*\{/g, ":root {"));
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 1000, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("ROUTER_SETTINGS_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.configSyncProbe()")));
    await win.webContents.executeJavaScript("window.checkboxProbe()");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    console.log("CHECKBOX_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.checkboxKeyboardResult()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8"); stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    assert.match(output, /ROUTER_SETTINGS_PROBE \{"passed":true\}/);
    assert.match(output, /CHECKBOX_PROBE \{"passed":true\}/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
