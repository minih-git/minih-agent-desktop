/**
 * Settings ▸ Remote gateway user path (rollout R5, ADR 0331).
 *
 * The real page is bundled and rendered in Electron against a fake IPC bridge,
 * the English catalog and a controllable clock: the switch gate, enrollment
 * success and failure (including the build without the transport), the pairing
 * code with its clipboard copy and ten-minute expiry, revoke with its
 * confirmation, and the listener/timer cleanup on unmount are all exercised by
 * clicking and typing, not by reading the component source.
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
import { MyDevicesSection } from "../../apps/desktop/src/components/settings/MyDevicesSection";
import { AccountsAdvancedSection } from "../../apps/desktop/src/components/settings/AccountsAdvancedSection";
import { useRemoteControl } from "../../apps/desktop/src/components/settings/useRemoteControl";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const label = (key, options) => i18n.t("settings.remoteGateway." + key, options);
const check = (value, message) => { if (!value) throw new Error(message); };

// A controllable clock: the page reads Date.now(), so an offset moves time
// without waiting for it.
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const advance = (milliseconds) => { clockOffset += milliseconds; };

// Count the component's timers so unmount cleanup is observable.
const realSetInterval = window.setInterval.bind(window);
const realClearInterval = window.clearInterval.bind(window);
const liveIntervals = new Set();
window.setInterval = (handler, delay, ...rest) => {
  const id = realSetInterval(handler, delay, ...rest);
  liveIntervals.add(id);
  return id;
};
window.clearInterval = (id) => { liveIntervals.delete(id); return realClearInterval(id); };

// A fake clipboard: writing a code must reach exactly this recorder.
const clipboardWrites = [];
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: async (text) => { clipboardWrites.push(text); } },
});

// Fake main: status, devices and the operations the page steers.
const listeners = new Map();
const calls = [];
const revokeCalls = [];
const PAIRING_CODE = "pdt1.test-pairing-code";
const HOST_ID = "host_test_desktop";
let status = { state: "disabled", since: "2026-10-18T00:00:00.000Z", enabled: false, enrolled: false };
let devices = [{
  deviceId: "dev_phone",
  label: "Phone",
  roles: ["viewer", "controller", "approver"],
  createdAt: "2026-10-18T00:00:00.000Z",
}];
let enrollFailure = null;
let revokeFailure = null;
const emitStatus = () => {
  for (const callback of listeners.get(IPC.event.remoteGatewayStatusChanged) ?? []) callback(status);
};
window.minihAgent = { platform: "darwin", channels: IPC,
  on(channel, callback) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(callback);
    return () => listeners.get(channel).delete(callback);
  },
  async invoke(channel, input) {
    calls.push({ channel, input: input === undefined ? undefined : JSON.parse(JSON.stringify(input)) });
    if (channel === IPC.invoke.remoteGatewayStatus) return { ok: true, data: status };
    if (channel === IPC.invoke.remoteGatewayListDevices) return { ok: true, data: { devices } };
    // "My devices" reads the account's computers; none exist in this fixture.
    if (channel === IPC.invoke.remoteHostList) return { ok: true, data: { hosts: [] } };
    if (channel === IPC.invoke.remoteGatewaySetEnabled) {
      status = { ...status, enabled: input.enabled, state: input.enabled ? "connecting" : "disabled" };
      emitStatus();
      return { ok: true, data: status };
    }
    if (channel === IPC.invoke.remoteGatewayEnroll) {
      if (enrollFailure) return { ok: false, error: enrollFailure };
      status = { ...status, enrolled: true, enabled: false, url: input.url };
      emitStatus();
      return { ok: true, data: status };
    }
    if (channel === IPC.invoke.remoteGatewayCreatePairingCode) {
      return { ok: true, data: { code: PAIRING_CODE, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), hostId: HOST_ID } };
    }
    if (channel === IPC.invoke.remoteGatewayRevokeDevice) {
      if (revokeFailure) return { ok: false, error: revokeFailure };
      revokeCalls.push(input.deviceId);
      devices = devices.map((device) => device.deviceId === input.deviceId
        ? { ...device, revokedAt: new Date().toISOString() } : device);
      return { ok: true, data: { revoked: true } };
    }
    throw new Error("Unexpected IPC: " + channel);
  },
};

let view;
const host = () => document.getElementById("root");
// The sections take their control from the page; a tiny wrapper provides them
// the way AccountsPage does, so the probe covers the revoke flow that now
// lives in My devices and the self-hosted form that lives in Advanced.
const SectionHost = () => {
  const control = useRemoteControl();
  return React.createElement(React.Fragment, null,
    React.createElement(RemoteControlSection, { control }),
    React.createElement(MyDevicesSection, { control }),
    React.createElement(AccountsAdvancedSection, { control }));
};
const mount = () => { view = createRoot(host()); flushSync(() => view.render(React.createElement(SectionHost))); };
const frame = () => new Promise(requestAnimationFrame);
const until = async (condition, message) => {
  const end = performance.now() + 5000;
  while (!condition()) { if (performance.now() > end) throw new Error(message); await frame(); }
};
const buttons = () => [...document.querySelectorAll("button")];
const button = (text) => buttons().find((node) => node.textContent.trim() === text);
const alerts = () => [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent.trim());
const switchControl = () => document.querySelector('button[role="switch"]');
const field = (text) => [...document.querySelectorAll("label")].find((node) => node.textContent.trim() === text);
const control = (text) => field(text)?.querySelector("input, textarea");
const fill = async (text, value) => {
  const element = control(text);
  check(element, "missing field " + text);
  const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await frame();
};
const ariaLabels = () => buttons().map((node) => (node.getAttribute("aria-label") ?? node.textContent.trim()).slice(0, 40)).join(" | ");
const click = async (element, message) => {
  check(element, "missing control: " + message + " :: rendered: " + ariaLabels());
  check(!element.disabled, "control is disabled: " + message + " :: rendered: " + ariaLabels());
  flushSync(() => element.click());
  await frame();
};
const pairingCode = () => document.querySelector("#remote-gateway-pairing-code")?.textContent.trim();
const pairingTicket = () => document.querySelector("#remote-gateway-pairing-ticket")?.textContent.trim();
const prefix = (text) => text.split("{{")[0].trim();

mount();
window.remoteGatewayProbe = async () => {
  // (a) An unregistered desktop cannot enable the switch.
  await until(() => switchControl() && button(label("enroll")), "page did not render");
  check(switchControl().disabled, "switch must stay disabled before registration");
  check(document.body.textContent.includes(label("stateDisabled")), "disabled state copy missing");

  // (a2) The self-hosted path is folded away by default: a user who never
  // registered sees the advanced area closed, and opening it is what reveals
  // the address, CA, and code fields.
  const advanced = document.querySelector('[data-testid="remote-gateway-advanced"]');
  check(advanced, "advanced self-hosted area missing");
  check(advanced.open === false, "the self-hosted area must start collapsed");
  check(advanced.textContent.includes(label("advancedTitle")), "advanced title missing");

  // (b) A failed registration shows the failure; a build without the transport
  // shows its own reason instead of a generic one.
  await click(advanced.querySelector("summary"), "advanced summary");
  check(advanced.open === true, "the self-hosted area did not open");
  await fill(label("url"), "wss://gateway.test");
  await fill(label("caPem"), "-----BEGIN CERTIFICATE-----");
  await fill(label("registrationCode"), "registration-code");
  enrollFailure = { code: "GATEWAY_LINK_ENROLL_FAILED", message: "the gateway refused this code" };
  await click(button(label("enroll")), "register action");
  await until(() => alerts().length > 0, "registration failure was not shown");
  check(alerts().some((text) => text.startsWith(prefix(label("enrollFailed")))), "failure copy missing: " + alerts());
  check(!alerts().some((text) => text.includes(label("errorUnavailable"))), "generic failure claimed a missing transport");

  enrollFailure = { code: "GATEWAY_LINK_UNAVAILABLE", message: "this build does not include the gateway link transport" };
  await click(button(label("enroll")), "register action");
  await until(() => alerts().some((text) => text.includes(label("errorUnavailable"))), "missing-transport copy missing: " + alerts());
  check(switchControl().disabled, "a failed registration must not unlock the switch");

  // A successful registration unlocks the switch and reports the new state.
  // A pinned CA that does not match the Gateway is its own failure: the user
  // has to fix a certificate, not a URL or a code.
  enrollFailure = { code: "GATEWAY_IDENTITY_MISMATCH", message: "the Gateway certificate chain does not end at the pinned CA" };
  await click(button(label("enroll")), "register action");
  await until(() => alerts().some((text) => text.includes(label("errorGatewayIdentity"))),
    "identity-mismatch copy missing: " + alerts());
  check(!alerts().some((text) => text.includes(label("errorEnrollmentCode"))),
    "an identity mismatch claimed a bad registration code");
  check(switchControl().disabled, "an identity mismatch must not unlock the switch");

  enrollFailure = null;
  await click(button(label("enroll")), "register action");
  await until(() => !switchControl().disabled, "registration did not unlock the switch");
  check(control(label("registrationCode")).value === "", "single-use code stayed in the form");
  const enrolledCall = calls.filter((call) => call.channel === IPC.invoke.remoteGatewayEnroll).at(-1);
  check(enrolledCall.input.url === "wss://gateway.test" && enrolledCall.input.code === "registration-code",
    "registration payload changed");

  await click(switchControl(), "enable switch");
  await until(() => switchControl().getAttribute("aria-checked") === "true", "switch did not turn on");
  check(calls.filter((call) => call.channel === IPC.invoke.remoteGatewaySetEnabled).at(-1).input.enabled === true,
    "switch did not ask main to enable the link");

  // (c) Pairing code and ticket: shown, copied, and cleared once the ten
  // minutes pass. The ticket is the code plus the Host id, and the Host id is
  // the only way a browser can address the Host-scoped pair endpoint.
  await click(button(label("pairingCreate")), "create pairing code");
  await until(() => pairingCode() === PAIRING_CODE, "pairing code not shown");
  check(document.body.textContent.includes(label("pairingExpiresIn", { time: "10:00" })), "countdown missing");
  await until(() => pairingTicket() === "mpt1:" + HOST_ID + ":" + PAIRING_CODE, "pairing ticket not shown: " + pairingTicket());
  check(document.body.textContent.includes(label("pairingTicketHint")), "ticket hint missing");
  await click(button(label("pairingCopy")), "copy pairing code");
  await until(() => clipboardWrites.length > 0, "clipboard never received the code");
  check(clipboardWrites.at(-1) === PAIRING_CODE, "clipboard received the wrong value");
  await until(() => button(label("pairingCopied")), "copy confirmation missing");
  await click(button(label("pairingTicketCopy")), "copy pairing ticket");
  await until(() => clipboardWrites.length > 1, "clipboard never received the ticket");
  check(clipboardWrites.at(-1) === "mpt1:" + HOST_ID + ":" + PAIRING_CODE, "clipboard received the wrong ticket");
  await until(() => button(label("pairingTicketCopied")), "ticket copy confirmation missing");
  advance(10 * 60 * 1000 + 1000);
  await until(() => pairingCode() === undefined, "expired pairing code is still on screen");
  check(pairingTicket() === undefined, "expired pairing ticket is still on screen");
  check(document.body.textContent.includes(label("pairingExpired")), "expired copy missing");

  // (d) Revoke: confirm first, cancel leaves main untouched, confirm calls it
  // exactly once, and a failure is reported.
  const revokeButton = () => buttons().find((node) =>
    node.getAttribute("aria-label") === label("revokeTitle", { label: "Phone" }));
  await click(revokeButton(), "revoke action");
  await until(() => button(label("revokeConfirm")), "revoke confirmation missing");
  check(document.body.textContent.includes(label("revokeBody")), "confirmation copy missing");
  await click(button(label("cancel")), "cancel revoke");
  await until(() => !button(label("revokeConfirm")), "cancel left the confirmation open");
  check(revokeCalls.length === 0, "cancel must not revoke");

  revokeFailure = { code: "AGENT_UNAVAILABLE", message: "host-core is not running" };
  await click(revokeButton(), "revoke action");
  await until(() => button(label("revokeConfirm")), "revoke confirmation missing");
  await click(button(label("revokeConfirm")), "confirm revoke");
  await until(() => alerts().some((text) => text.startsWith(prefix(label("revokeFailed")))), "revoke failure missing: " + alerts());
  check(revokeCalls.length === 0, "a failed revoke must not be recorded as success");

  revokeFailure = null;
  await click(revokeButton(), "revoke action");
  await until(() => button(label("revokeConfirm")), "revoke confirmation missing");
  await click(button(label("revokeConfirm")), "confirm revoke");
  await until(() => revokeCalls.length === 1, "revoke did not reach main exactly once");
  check(revokeCalls[0] === "dev_phone", "revoke named the wrong device");

  // (e) A live code owns a timer; unmounting releases it and the subscription.
  await click(button(label("pairingCreate")), "create pairing code");
  await until(() => pairingCode() === PAIRING_CODE, "pairing code not shown again");
  check(liveIntervals.size > 0, "countdown timer was not registered");
  check((listeners.get(IPC.event.remoteGatewayStatusChanged) ?? new Set()).size === 1, "status subscription missing");
  flushSync(() => view.unmount());
  await frame();
  check((listeners.get(IPC.event.remoteGatewayStatusChanged) ?? new Set()).size === 0, "status subscription leaked");
  check(liveIntervals.size === 0, "countdown timer leaked");

  // A remounted page re-subscribes and reads the stored state again.
  mount();
  await until(() => switchControl(), "remount did not render");
  check((listeners.get(IPC.event.remoteGatewayStatusChanged) ?? new Set()).size === 1, "remount did not re-subscribe");
  flushSync(() => view.unmount());
  return { passed: true };
};
`;

test(
  "remote gateway settings user path gates the switch, enrolls, pairs, revokes and cleans up",
  { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false },
  async () => {
    const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "remote-gateway-settings-"));
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
    console.log("REMOTE_GATEWAY_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.remoteGatewayProbe()")));
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
      assert.match(output, /REMOTE_GATEWAY_PROBE \{"passed":true\}/);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
