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
  if (channel === IPC.invoke.pluginCredentialsStatus) return { ok: true, data: { slots: [{ id: "mail", title: "邮件", kind: "bearer", fields: [{ key: "token", label: "令牌", secret: true }], configured, lastUsedAt: null }] } };
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

test("credential settings accept a masked value, clear it after save, and clear the slot", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "plugin-credentials-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
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
    console.log("PASS credential settings"); process.exit(0);
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
    assert.match(output, /PASS credential settings/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
