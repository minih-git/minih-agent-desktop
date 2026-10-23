/**
 * Remote control on the accounts page (D666 follow-up).
 *
 * The block moved out of its own rail destination into Settings ▸ Accounts,
 * below the Minih Router account and its overlay channel. What matters to a
 * user is unchanged, so the probe checks the same things from the new place:
 * a fresh install sees account mode and can turn the switch on, and the
 * self-hosted gateway is collapsed unless this desktop was registered that way.
 *
 * The whole page is rendered with a fake IPC bridge and the English catalog; the
 * account card itself is the not-yet-connected variant, so nothing here reads a
 * Router account.
 */
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
import { AccountsPage } from "../../apps/desktop/src/components/settings/AccountsPage";
import { DevicesPage } from "../../apps/desktop/src/components/settings/DevicesPage";
import { AccountsAdvancedPage } from "../../apps/desktop/src/components/settings/AccountsAdvancedPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const label = (key, options) => i18n.t("settings.remoteGateway." + key, options);
const navLabel = (key) => i18n.t(key);
const check = (value, message) => { if (!value) throw new Error(message); };

// No Router row: the page shows its connect card, and nothing here reads an
// account.
useAppStore.setState({ settings: { developerMode: false }, providers: [] });

const listeners = new Map();
const calls = [];
let status = {
  state: "disabled",
  since: "2026-10-18T00:00:00.000Z",
  enabled: false,
  enrolled: false,
  strictDevices: false,
  accountMode: { available: true, url: "wss://gateway.example.com/hostlink" },
};
window.minihAgent = { platform: "darwin", channels: IPC,
  on(channel, callback) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(callback);
    return () => listeners.get(channel).delete(callback);
  },
  async invoke(channel, input) {
    calls.push({ channel, input });
    if (channel === IPC.invoke.remoteGatewayStatus) return { ok: true, data: status };
    if (channel === IPC.invoke.remoteGatewayListDevices) return { ok: true, data: { devices: [] } };
    // "My devices" lists the account's computers; one sibling, offline.
    if (channel === IPC.invoke.remoteHostList) {
      return { ok: true, data: { hosts: [{ hostKey: "account-sib", label: "Studio Mac", url: "", connected: false, transport: "account" }] } };
    }
    if (channel === IPC.invoke.remoteGatewaySetEnabled) {
      status = { ...status, enabled: input.enabled, state: input.enabled ? "connecting" : "disabled" };
      return { ok: true, data: status };
    }
    throw new Error("Unexpected IPC: " + channel);
  },
};

let view;
const host = () => document.getElementById("root");
// Each page of the accounts category mounts on its own, the way the settings
// panel renders exactly one of them at a time.
const mountPage = (Page) => {
  if (view) flushSync(() => view.unmount());
  view = createRoot(host());
  flushSync(() => view.render(React.createElement(Page)));
};
const frame = () => new Promise(requestAnimationFrame);
const until = async (condition, message) => {
  const end = performance.now() + 5000;
  while (!condition()) { if (performance.now() > end) throw new Error(message); await frame(); }
};
const buttons = () => [...document.querySelectorAll("button")];
const button = (text) => buttons().find((node) => node.textContent.trim() === text);
const headings = () => [...document.querySelectorAll(".settings-card-heading")].map((node) => node.textContent.trim());
const advanced = () => document.querySelector('[data-testid="remote-gateway-advanced"]');
const remoteSwitch = () =>
  buttons().find((node) => node.getAttribute("role") === "switch" && node.getAttribute("aria-label") === label("enabled"));

window.freshInstallProbe = async () => {
  // 1. The account page: the Minih Router account, then this computer.
  mountPage(AccountsPage);
  // The switch renders before main answers, so wait for the account-mode block:
  // that only exists once the status has been read.
  await until(
    () => document.querySelector('[data-testid="remote-gateway-account-mode"]') && remoteSwitch(),
    "the accounts page did not render remote control",
  );
  const router = headings().indexOf(navLabel("Minih Router").trim());
  const thisComputer = document.querySelector('[data-testid="accounts-this-computer"]');
  check(router >= 0, "the Minih Router panel must stay on the page: " + headings().join(" | "));
  check(thisComputer, "the page must name this computer: " + headings().join(" | "));
  check(headings().includes(navLabel("settings.accountsThisComputerTitle").trim()),
    "this computer must have its own section heading: " + headings().join(" | "));
  check(headings().indexOf(navLabel("settings.accountsThisComputerTitle").trim()) > router,
    "this computer must sit below the account: " + headings().join(" | "));
  // Account mode is offered and the switch that enrolls this desktop is usable.
  const accountMode = document.querySelector('[data-testid="remote-gateway-account-mode"]');
  check(accountMode, "account mode must be visible on a fresh install");
  check(accountMode.textContent.includes(label("accountModeReady")), "it should read as ready: " + accountMode.textContent);
  check(remoteSwitch().disabled === false, "a fresh install must be able to turn remote access on");
  flushSync(() => remoteSwitch().click());
  await until(() => calls.some((call) => call.channel === IPC.invoke.remoteGatewaySetEnabled), "the switch did not reach main");
  check(calls.filter((call) => call.channel === IPC.invoke.remoteGatewaySetEnabled).length === 1, "one toggle, one call");
  await until(
    () => remoteSwitch().getAttribute("aria-checked") === "true",
    "the switch did not apply main's answer",
  );

  // 2. Devices: the account's computers with their online state, labeled as
  // computers, and the grants list (empty here) below them.
  mountPage(DevicesPage);
  const computers = () => document.querySelector('[data-testid="accounts-devices-computers"]');
  await until(() => computers()?.textContent.includes("Studio Mac"), "the account computer did not render");
  check(computers().textContent.includes(navLabel("settings.accountsDevices.offline")),
    "an offline computer must say so: " + computers().textContent);
  check(computers().textContent.includes(navLabel("settings.accountsDevices.kindComputer")),
    "a computer row must be labeled as a computer: " + computers().textContent);

  // 3. Advanced: the SSH host inventory renders in place, next to the folded
  // self-hosted gateway form.
  mountPage(AccountsAdvancedPage);
  await until(() => advanced(), "the advanced page did not render the self-hosted area");
  // The SSH inventory is on this page now: its add forms and its (empty) list
  // render next to the self-hosted gateway form.
  await until(
    () => button(navLabel("settings.remoteHosts.addSsh")) && button(navLabel("settings.remoteHosts.addPair")),
    "the advanced page must render the SSH host inventory: " + headings().join(" | "),
  );
  // The inventory lists what the host read returned (one paired computer here).
  await until(
    () => document.body.textContent.includes("Studio Mac"),
    "the inventory must list the paired hosts",
  );
  check(advanced().open === false, "the self-hosted area must start collapsed");
  // Opening it on a fresh install shows the state account mode replaced: the
  // registration is pending because this desktop has not enrolled yet.
  flushSync(() => advanced().querySelector("summary").click());
  check(document.body.textContent.includes(label("accountEnrollPendingTitle")),
    "a fresh install must read as pending inside the self-hosted area");
  flushSync(() => advanced().querySelector("summary").click());

  // A self-hosted registration keeps the advanced area open, so a user who
  // configured one still finds it without hunting.
  status = {
    state: "disabled",
    since: "2026-10-18T00:00:00.000Z",
    enabled: false,
    enrolled: true,
    strictDevices: false,
    accountMode: { available: false, reason: "no Minih Router AccessKey is configured" },
  };
  for (const callback of listeners.get(IPC.event.remoteGatewayStatusChanged) ?? []) callback(status);
  await until(() => advanced().open === true, "a self-hosted registration must open the advanced area");
  // The account-mode explanation belongs to This computer, which is on the
  // account page now; the advanced page owns the self-hosted form itself.
  check(button(label("enroll")), "the self-hosted form must be there for the self-hosted flow");

  // A registration through the account instead: the advanced area stops
  // offering the self-hosted form and reads as registered.
  status = {
    state: "connecting",
    since: "2026-10-18T00:00:00.000Z",
    enabled: true,
    enrolled: true,
    hostId: "host_desktop",
    strictDevices: false,
    accountMode: { available: true, url: "wss://gateway.example.com/hostlink" },
  };
  for (const callback of listeners.get(IPC.event.remoteGatewayStatusChanged) ?? []) callback(status);
  await until(() => advanced().open === false, "an account registration must fold the self-hosted area again");
  flushSync(() => advanced().querySelector("summary").click());
  check(advanced().open === true, "the self-hosted area did not open");
  check(
    document.body.textContent.includes(label("accountEnrollTitle")),
    "a desktop the account registered must read as registered inside the self-hosted area",
  );
  check(
    !document.body.textContent.includes(label("accountEnrollPendingTitle")),
    "a desktop the account registered must not read as pending",
  );

  flushSync(() => view.unmount());
  return { passed: true };
};
`;

test(
  "remote control lives on the accounts page and offers account mode first",
  { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false },
  async () => {
    const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "remote-accounts-page-"));
    try {
      await build({
        stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
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
        join(temp, "styles.css"),
        (await loadStyles()).replace(/@theme(?: inline)?\s*\{/g, ":root {"),
      );
      await writeFile(
        join(temp, "index.html"),
        '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="renderer.js"></script>',
      );
      await writeFile(
        join(temp, "main.cjs"),
        `
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 1000, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("REMOTE_ACCOUNTS_PAGE_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.freshInstallProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`,
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
        stream.on("data", (chunk) => {
          output += chunk;
        });
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
      assert.match(output, /REMOTE_ACCOUNTS_PAGE_PROBE \{"passed":true\}/);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
