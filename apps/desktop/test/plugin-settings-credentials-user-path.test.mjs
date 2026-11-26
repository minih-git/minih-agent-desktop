import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary, scaledTimeout } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

/** The first frame, the save, and the clear of one credential slot. */
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { PluginCredentials } from "../../apps/desktop/src/components/plugins/PluginCredentials";
await i18n.use(initReactI18next).init({ lng: "zh-CN", fallbackLng: "en", keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) }, en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });
let configured = false;
let stored = "";
window.minihAgent = { platform: "darwin", on() { return () => {}; }, async invoke(channel, input) {
  if (channel === IPC.invoke.pluginCredentialsStatus) return { ok: true, data: { slots: [{ id: "mail", title: "邮件", kind: "bearer", fields: [{ key: "token", label: "令牌", secret: true }], configured, lastUsedAt: null, userEndpoint: { protocols: ["imap"] }, userProxy: { types: ["http", "socks5"] }, userSend: { security: ["tls", "starttls"] } }] } };
  if (channel === IPC.invoke.pluginCredentialsSet) { stored = input.fields.token; configured = true; return { ok: true, data: undefined }; }
  if (channel === IPC.invoke.pluginCredentialsClear) { stored = ""; configured = false; return { ok: true, data: undefined }; }
  throw new Error("unexpected IPC");
} };
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<PluginCredentials pluginId="demo.mail" />));
const until = async (condition, message) => { const deadline = performance.now() + 5000; while (!condition()) { if (performance.now() > deadline) throw new Error(message); await new Promise(requestAnimationFrame); } };
window.probe = async () => {
  await until(() => document.body.textContent.includes("未配置"), "missing unconfigured state");
  const clear = [...document.querySelectorAll("button")].find((button) => button.textContent === "清除凭据");
  if (!clear || !clear.disabled) throw new Error("clear must be disabled for an unconfigured slot");
  // The declaration reaches the sheet: a slot that names its own server, proxy
  // and outgoing server shows all three sections (the component test covers the
  // other half — a slot that declares none shows none).
  for (const section of ["使用自己的邮件服务器", "代理", "用我自己的服务器发信"]) {
    if (!document.body.textContent.includes(section)) throw new Error("missing section: " + section);
  }
  const input = document.querySelector('input[aria-label="令牌"]');
  if (!input || input.type !== "password") throw new Error("secret must be masked");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  flushSync(() => { setter.call(input, "synthetic-token"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  const save = [...document.querySelectorAll("button")].find((button) => button.textContent === "保存凭据");
  if (!save || save.disabled) throw new Error("save is not enabled");
  flushSync(() => save.click());
  await until(() => document.body.textContent.includes("已配置"), "missing configured state");
  if (input.value || stored !== "synthetic-token") throw new Error("save did not clear input or store value");
  if (clear.disabled) throw new Error("clear must be enabled for a configured slot");
  flushSync(() => clear.click());
  await until(() => document.body.textContent.includes("未配置"), "clear did not update status");
  if (!clear.disabled) throw new Error("clear must be disabled after clearing the slot");
  if (stored || input.value) throw new Error("clear retained a value");
  document.getAnimations().forEach((animation) => animation.finish());
  return true;
};`;

/**
 * Editing a saved mailbox account: the password box is empty because the host
 * never hands a stored secret back, and only the proxy is filled in. Saving has
 * to be possible, and it has to submit that empty box with the account's own id
 * — the merge that keeps the saved password happens in the host.
 */
const editFixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { PluginCredentials } from "../../apps/desktop/src/components/plugins/PluginCredentials";
await i18n.use(initReactI18next).init({ lng: "zh-CN", fallbackLng: "en", keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) }, en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });
const instances = [{ instanceId: "acc_00000001", label: "alice@example.com", configured: true, publicFields: { username: "alice@example.com" } }];
let submitted = null;
window.minihAgent = { platform: "darwin", on() { return () => {}; }, async invoke(channel, input) {
  if (channel === IPC.invoke.pluginCredentialsStatus) return { ok: true, data: { slots: [{
    id: "mailbox", title: "邮箱", kind: "imap",
    fields: [{ key: "username", label: "邮箱地址", secret: false }, { key: "password", label: "授权码", secret: true }],
    configured: true, lastUsedAt: null, multiple: true, max: 3, instances,
    userProxy: { types: ["http", "socks5"] },
  }] } };
  if (channel === IPC.invoke.pluginCredentialsSet) { submitted = input; return { ok: true, data: {} }; }
  throw new Error("unexpected IPC");
} };
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<PluginCredentials pluginId="demo.mailbox" />));
const until = async (condition, message, budget = 5000) => { const deadline = performance.now() + budget; while (!condition()) { if (performance.now() > deadline) throw new Error(message); await new Promise(requestAnimationFrame); } };
const button = (label) => [...document.querySelectorAll("button")].find((entry) => entry.textContent === label);
const type = (element, value) => {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
  flushSync(() => { descriptor.set.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
};
window.probe = async () => {
  await until(() => document.body.textContent.includes("已配置"), "missing configured account", 15000);
  flushSync(() => button("编辑").click());
  // The saved address comes back; the password never does.
  await until(() => document.querySelector('input[aria-label="邮箱地址"]')?.value === "alice@example.com", "edit form was not prefilled", 15000);
  const password = document.querySelector('input[aria-label="授权码"]');
  if (password.value) throw new Error("a stored secret was rendered back");
  if (!password.placeholder.includes("留空则保留已保存的")) throw new Error("the secret box does not say what empty means: " + password.placeholder);
  const save = button("保存凭据");
  // Nothing else to type: an empty secret keeps the saved one.
  if (save.disabled) throw new Error("save must be enabled with only the saved password missing");
  const type_ = document.querySelector('select[aria-label="代理类型"]');
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  flushSync(() => { descriptor.set.call(type_, "http"); type_.dispatchEvent(new Event("change", { bubbles: true })); });
  await until(() => document.querySelector('input[aria-label="代理服务器"]'), "the proxy address did not appear", 15000);
  type(document.querySelector('input[aria-label="代理服务器"]'), "127.0.0.1");
  type(document.querySelector('input[aria-label="代理端口"]'), "7897");
  // The password box is still empty: this is the whole point of the change.
  if (password.value) throw new Error("the proxy fill typed into the password box");
  if (save.disabled) throw new Error("save must stay enabled with the password left empty");
  flushSync(() => button("保存凭据").click());
  await until(() => submitted, "the save never reached the host", 15000);
  if (submitted.instanceId !== "acc_00000001") throw new Error("the edit lost the account id: " + JSON.stringify(submitted));
  // Absent and empty mean the same thing to the host: keep the saved one.
  if ((submitted.fields.password ?? "") !== "") throw new Error("the renderer must submit the empty box as it is: " + JSON.stringify(submitted));
  if (submitted.fields.proxyType !== "http" || submitted.fields.proxyHost !== "127.0.0.1" || submitted.fields.proxyPort !== "7897") throw new Error("the proxy did not reach the host: " + JSON.stringify(submitted));
  if (submitted.fields.username !== "alice@example.com") throw new Error("the saved address did not travel with the edit");
  await until(() => document.body.textContent.includes("已配置"), "the sheet did not come back to the account list", 15000);
  document.getAnimations().forEach((animation) => animation.finish());
  return true;
};`;

/** Bundle one fixture, boot it in Electron, and return what the probe printed. */
async function runInElectron(contents, marker) {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "plugin-credentials-ui-"));
  try {
    await build({
      stdin: { contents, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "true" },
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
    await writeFile(join(temp, "index.html"), '<!doctype html><html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 768, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    await win.webContents.executeJavaScript("window.probe()");
    console.log("PASS ${marker}"); process.exit(0);
  } catch (error) { console.error(error.stack || error); process.exit(1); }
});`);
    const env = { ...process.env, MINIH_AGENT_DATA_DIR: join(temp, "data") };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding("utf8"); stream.on("data", (chunk) => { output += chunk; }); }
    const timer = setTimeout(() => child.kill("SIGKILL"), scaledTimeout(90_000));
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    assert.match(output, new RegExp(`PASS ${marker}`));
  } finally { await rm(temp, { recursive: true, force: true }); }
}

const skipWithoutDisplay = {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
};

test("credential settings accept a masked value, clear it after save, and clear the slot", skipWithoutDisplay, async () => {
  await runInElectron(fixture, "credential settings");
});

test("editing a saved account needs only the proxy, never the password again", skipWithoutDisplay, async () => {
  await runInElectron(editFixture, "credential edit");
});