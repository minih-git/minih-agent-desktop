/**
 * Account-mode UI on the desktop (D666; rollout R7 package E2).
 *
 * The real page and the real confirmation dialog are bundled and rendered in
 * Electron against a fake IPC bridge and the English catalog: the account-mode
 * section, the strict-mode switch, the "new device" notices, and the
 * `device.request` dialog (focus, keyboard, timeout) are exercised by clicking
 * and typing, not by reading the components.
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
import { RemoteGatewayPage } from "../../apps/desktop/src/components/settings/RemoteGatewayPage";
import { DeviceRequestHost } from "../../apps/desktop/src/components/settings/DeviceRequestHost";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const check = (value, message) => { if (!value) throw new Error(message); };
const text = (key, options) => i18n.t("settings.remoteGateway." + key, options);

// A fake main: one status, one device list, and the account-mode channels.
const listeners = new Map();
const calls = [];
let status = {
  state: "connected",
  since: "2026-10-18T00:00:00.000Z",
  enabled: true,
  enrolled: true,
  hostId: "host_desktop",
  strictDevices: false,
  accountMode: {
    available: true,
    url: "wss://gateway.example.com/hostlink",
    publicOrigin: "https://gateway.example.com",
  },
};
let pending = [];
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
    if (channel === IPC.invoke.remoteGatewaySetStrictDevices) {
      status = { ...status, strictDevices: input.strictDevices };
      return { ok: true, data: status };
    }
    if (channel === IPC.invoke.remoteGatewayPendingDeviceRequests) return { ok: true, data: { requests: pending } };
    if (channel === IPC.invoke.remoteGatewayDeviceDecision) return { ok: true, data: { answered: true } };
    if (channel === IPC.invoke.remoteGatewayDevicePresence) return { ok: true, data: { denied: 0 } };
    throw new Error("Unexpected IPC: " + channel);
  },
};
const emit = (channel, payload) => {
  for (const callback of listeners.get(channel) ?? []) callback(payload);
};

let page;
let dialog;
const mount = () => {
  page = createRoot(document.getElementById("page"));
  dialog = createRoot(document.getElementById("dialog"));
  flushSync(() => {
    page.render(React.createElement(RemoteGatewayPage));
    dialog.render(React.createElement(DeviceRequestHost));
  });
};
const frame = () => new Promise(requestAnimationFrame);
const until = async (condition, message) => {
  const end = performance.now() + 5000;
  while (!condition()) { if (performance.now() > end) throw new Error(message); await frame(); }
};
const buttons = () => [...document.querySelectorAll("button")];
const button = (label) => buttons().find((node) => node.textContent.trim() === label);
const check1 = (value, message) => { if (!value) throw new Error(message); };
const click = async (element, message) => {
  check1(element, "missing control: " + message);
  flushSync(() => element.click());
  await frame();
};
const request = (overrides = {}) => ({
  requestId: "req_1",
  deviceLabel: "Pixel",
  client: "android",
  requestedAt: "2026-10-18T00:00:00.000Z",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
});

window.accountModeProbe = async () => {
  mount();
  // 1. The account-mode section replaces the registration-code form.
  await until(() => document.querySelector('[data-testid="remote-gateway-account-mode"]'), "account-mode section missing");
  const section = document.querySelector('[data-testid="remote-gateway-account-mode"]').textContent;
  check1(section.includes(text("accountModeActive")), "account mode should read as active: " + section);
  check1(section.includes("wss://gateway.example.com/hostlink"), "the advertised endpoint should be shown");
  check1(!button(text("enroll")), "the registration-code form must be replaced by account mode");

  // 2. Strict mode is a switch, off by default, and turning it on reaches main.
  const strict = [...document.querySelectorAll('button[role="switch"]')].pop();
  check1(strict, "strict-mode switch missing");
  check1(strict.getAttribute("aria-checked") === "false", "strict mode must default to off");
  await click(strict, "strict toggle");
  const setStrict = calls.filter((call) => call.channel === IPC.invoke.remoteGatewaySetStrictDevices);
  check1(setStrict.length === 1, "strict mode did not reach main");
  check1(setStrict[0].input.strictDevices === true, "strict mode should have been turned on");

  // 3. A device request opens the dialog, focused on the safe answer.
  emit(IPC.event.remoteGatewayDeviceRequest, request());
  await until(() => document.querySelector('[role="alertdialog"]'), "device dialog missing");
  const dialogText = document.querySelector('[role="alertdialog"]').textContent;
  check1(dialogText.includes("Pixel"), "the dialog should name the device: " + dialogText);
  check1(dialogText.includes("android"), "the dialog should name the client");
  check1(dialogText.includes(text("deviceRequestApprove")), "approve missing");
  // A hidden Electron window never takes OS focus here, so the focus target is
  // asserted structurally: Deny is the marked safe action AND the first
  // focusable control of the dialog, which is where the component sends focus.
  const deny = button(text("deviceRequestDeny"));
  const approve = button(text("deviceRequestApprove"));
  check1(deny?.getAttribute("data-safe-action") === "true", "Deny must be the marked safe action");
  const focusables = [...document.querySelectorAll('[role="alertdialog"] button:not([disabled])')];
  check1(focusables[0] === deny, "Deny must be the first focusable control");
  check1(focusables[1] === approve, "Approve must come second");

  // 4. Escape denies, and the answer reaches main.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await until(() => !document.querySelector('[role="alertdialog"]'), "dialog did not close on Escape");
  const decisions = calls.filter((call) => call.channel === IPC.invoke.remoteGatewayDeviceDecision);
  check1(decisions.length === 1, "Escape did not answer the request");
  check1(decisions[0].input.approved === false, "Escape must deny");

  // 5. Approving from the button is the other path.
  emit(IPC.event.remoteGatewayDeviceRequest, request({ requestId: "req_2" }));
  await until(() => document.querySelector('[role="alertdialog"]'), "second dialog missing");
  await click(button(text("deviceRequestApprove")), "approve");
  const answers = calls.filter((call) => call.channel === IPC.invoke.remoteGatewayDeviceDecision);
  check1(answers.length === 2 && answers[1].input.approved === true, "approve did not answer the request");

  // 6. A request whose deadline already passed never stays on screen.
  emit(IPC.event.remoteGatewayDeviceRequest, request({ requestId: "req_3", expiresAt: new Date(Date.now() - 1000).toISOString() }));
  await frame();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await until(() => !document.querySelector('[role="alertdialog"]'), "an expired request kept its dialog open");

  // 7. A device notice is shown on the page (ADR decision 6).
  emit(IPC.event.remoteGatewayDeviceNotice, { kind: "device.adopted", deviceId: "dev_9", label: "iPad", at: "2026-10-18T10:00:00.000Z" });
  await until(() => document.body.textContent.includes("iPad"), "the notice should name the device");

  // 8. An unavailable account mode keeps the registration-code form.
  status = { ...status, accountMode: { available: false, reason: "the overlay forward is not installed" } };
  flushSync(() => page.render(React.createElement(RemoteGatewayPage)));
  emit(IPC.event.remoteGatewayStatusChanged, status);
  await until(() => button(text("enroll")), "the self-hosted form should return when account mode is unavailable");
  check1(document.body.textContent.includes("the overlay forward is not installed"), "the reason should be shown");

  flushSync(() => { page.unmount(); dialog.unmount(); });
  return { passed: true };
};
`;

test(
  "account mode shows the Router endpoint, the strict switch, the dialog and the notices",
  { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false },
  async () => {
    const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "remote-account-ui-"));
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
        '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="styles.css"><div id="page"></div><div id="dialog"></div><script type="module" src="renderer.js"></script>',
      );
      await writeFile(
        join(temp, "main.cjs"),
        `
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 1100, height: 1000,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    // A hidden window is never focused by the OS; give the renderer document
    // focus so the dialog's focus handling is observable.
    win.webContents.focus();
    console.log("REMOTE_ACCOUNT_UI_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.accountModeProbe()")));
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
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
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
      assert.match(output, /REMOTE_ACCOUNT_UI_PROBE \{"passed":true\}/);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
