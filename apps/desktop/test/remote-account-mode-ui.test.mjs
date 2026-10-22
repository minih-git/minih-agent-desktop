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
import { RemoteControlSection } from "../../apps/desktop/src/components/settings/RemoteControlSection";
import { DeviceRequestHost } from "../../apps/desktop/src/components/settings/DeviceRequestHost";
import { useRemoteControl } from "../../apps/desktop/src/components/settings/useRemoteControl";

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
    if (channel === IPC.invoke.remoteGatewaySetEnabled) {
      status = { ...status, enabled: input.enabled };
      return { ok: true, data: status };
    }
    if (channel === IPC.invoke.remoteGatewayStatus) return { ok: true, data: status };
    if (channel === IPC.invoke.remoteGatewayListDevices) return { ok: true, data: { devices: [] } };
    if (channel === IPC.invoke.remoteGatewaySetStrictDevices) {
      status = { ...status, strictDevices: input.strictDevices };
      return { ok: true, data: status };
    }
    if (channel === IPC.invoke.remoteGatewaySetDesktopAuto) {
      status = { ...status, desktopAutoAdmission: input.enabled };
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
// The section is fed by the one useRemoteControl the accounts page owns, so the
// probe mounts the same pairing: a host component that owns the hook and passes
// its control down.
const SectionHost = () => React.createElement(RemoteControlSection, { control: useRemoteControl() });
const mount = () => {
  page = createRoot(document.getElementById("page"));
  dialog = createRoot(document.getElementById("dialog"));
  flushSync(() => {
    page.render(React.createElement(SectionHost));
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

  // 2. Both device switches are real switches. Strict mode is off by default;
  // automatic admission of a same-account computer is ON by default (ADR
  // amendment 3), so an untouched install reads as "on".
  const switchFor = (label) => document.querySelector('button[role="switch"][aria-label="' + label + '"]');
  const strict = switchFor(text("strictLabel"));
  check1(strict, "strict-mode switch missing");
  check1(strict.getAttribute("aria-checked") === "false", "strict mode must default to off");
  const desktopAuto = switchFor(text("desktopAutoLabel"));
  check1(desktopAuto, "automatic-admission switch missing");
  check1(desktopAuto.getAttribute("aria-checked") === "true", "automatic admission must default to on");

  // Turning strict mode on reaches main…
  await click(strict, "strict toggle");
  const setStrict = calls.filter((call) => call.channel === IPC.invoke.remoteGatewaySetStrictDevices);
  check1(setStrict.length === 1, "strict mode did not reach main");
  check1(setStrict[0].input.strictDevices === true, "strict mode should have been turned on");

  // …and so does turning automatic admission off, which is the one switch whose
  // default is "on" and whose payload is the new state.
  await click(desktopAuto, "automatic-admission toggle");
  const setAuto = calls.filter((call) => call.channel === IPC.invoke.remoteGatewaySetDesktopAuto);
  check1(setAuto.length === 1, "automatic admission did not reach main");
  check1(setAuto[0].input.enabled === false, "automatic admission should have been turned off");

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
  // The dialog subscribes to the key in an effect, so the key is retried until
  // it lands: dispatching once on the frame the element appears is a race that
  // fails under a loaded suite, not a property of the dialog.
  await until(() => {
    if (!document.querySelector('[role="alertdialog"]')) return true;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return !document.querySelector('[role="alertdialog"]');
  }, "dialog did not close on Escape");
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

  // 8. An unavailable account mode says so, with the reason. The self-hosted
  // registration form is not here any more: rollout R8 package F moved it into
  // the advanced section of the accounts page, which has its own tests.
  status = { ...status, accountMode: { available: false, reason: "the overlay forward is not installed" } };
  flushSync(() => page.render(React.createElement(SectionHost)));
  emit(IPC.event.remoteGatewayStatusChanged, status);
  await until(
    () => document.body.textContent.includes(text("accountModeUnavailable")),
    "an unavailable account mode should be reported as unavailable",
  );
  check1(document.body.textContent.includes("the overlay forward is not installed"), "the reason should be shown");
  check1(!button(text("enroll")), "the registration form belongs to the advanced section now");

  flushSync(() => { page.unmount(); dialog.unmount(); });
  return { passed: true };
};
/**
 * The reported defect, rendered: a desktop that has never enrolled, whose
 * remote-control switch used to be greyed out while the account-mode section
 * that would explain why stayed hidden — so nothing could ever turn it on.
 */
window.freshInstallProbe = async () => {
  status = {
    state: "disabled",
    since: "2026-10-18T00:00:00.000Z",
    enabled: false,
    enrolled: false,
    strictDevices: false,
    accountMode: {
      available: true,
      url: "wss://gateway.example.com/hostlink",
      publicOrigin: "https://gateway.example.com",
    },
  };
  mount();
  await until(() => document.querySelector('[data-testid="remote-gateway-account-mode"]'), "a fresh install must show account mode");
  const section = document.querySelector('[data-testid="remote-gateway-account-mode"]').textContent;
  // Available is not registered: the page says ready, and explains that turning
  // the switch on is what registers this desktop.
  check1(section.includes(text("accountModeReady")), "a fresh install should read as ready: " + section);
  check1(!section.includes(text("accountModeActive")), "nothing is registered yet, so it must not read as active");
  check1(section.includes(text("accountModeReadyHint")), "the ready hint should say what turning it on does");
  check1(section.includes("wss://gateway.example.com/hostlink"), "the advertised endpoint should be shown");
  // The registration form is not part of this section any more (rollout R8
  // package F): its pending and enrolled states are asserted where it now
  // lives, in the advanced area of the accounts page.
  check1(!button(text("enroll")), "the registration form belongs to the advanced section now");

  // The switch that used to be disabled is usable, which is the whole fix.
  const remoteSwitch = buttons().find((node) => node.getAttribute("role") === "switch" && node.getAttribute("aria-label") === text("enabled"));
  check1(remoteSwitch, "remote-control switch missing");
  check1(remoteSwitch.disabled === false, "a fresh install with account mode must be able to turn the switch on");
  await click(remoteSwitch, "remote-control switch");
  const toggled = calls.filter((call) => call.channel === IPC.invoke.remoteGatewaySetEnabled);
  check1(toggled.length === 1, "turning the switch on did not reach main");
  check1(toggled[0].input.enabled === true, "the switch should have been turned on");

  // What main then reports is an enrolled desktop, and the page follows.
  status = {
    ...status,
    state: "connecting",
    enabled: true,
    enrolled: true,
    hostId: "host_desktop",
  };
  emit(IPC.event.remoteGatewayStatusChanged, status);
  await until(() => document.querySelector('[data-testid="remote-gateway-account-mode"]').textContent.includes(text("accountModeActive")), "the page should follow the enrollment");
  check1(!button(text("enroll")), "the registration form stays in the advanced section once enrolled");

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
    // A second document for the fresh-install path: the first probe went
    // through an enrolled desktop and left its own state behind.
    await win.loadFile(path.join(__dirname, "index.html"));
    win.webContents.focus();
    console.log("REMOTE_ACCOUNT_UI_FRESH " + JSON.stringify(await win.webContents.executeJavaScript("window.freshInstallProbe()")));
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
      // The reported defect: a fresh install used to hide account mode and grey
      // out the switch, so there was no way in.
      assert.match(output, /REMOTE_ACCOUNT_UI_FRESH \{"passed":true\}/);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
