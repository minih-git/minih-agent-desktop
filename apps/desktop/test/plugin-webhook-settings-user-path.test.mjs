import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { PluginWebhookSettings } from "../../apps/desktop/src/components/plugins/PluginWebhookSettings";
import { WebhookLanWarning } from "../../apps/desktop/src/features/plugins/WebhookLanWarning";

let loopbackOnly = false;
const calls = [];
window.minihAgent = {
  platform: "darwin", on() { return () => {}; },
  async invoke(channel, ...args) {
    calls.push({ channel, args });
    if (channel.endsWith("/webhooks/list")) return { ok: true, data: { loopbackOnly, receivers: [{ id: "hook", url: "http://127.0.0.1:37124/hooks/example.plugin/hook", enabled: true }] } };
    if (channel.endsWith("/webhooks/setLoopback")) { loopbackOnly = args[0]; return { ok: true }; }
    if (channel.endsWith("/webhooks/tokenDialog")) return { ok: true };
    throw new Error("Unexpected IPC");
  },
};
await i18n.use(initReactI18next).init({ lng: "zh-CN", fallbackLng: "en", keySeparator: false, resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } }, interpolation: { escapeValue: false } });
const frame = () => new Promise(requestAnimationFrame);
async function waitFor(predicate) {
  for (let i = 0; i < 120; i += 1) { await frame(); const value = predicate(); if (value) return value; }
  throw new Error("Expected UI state did not appear");
}
const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(React.createElement(PluginWebhookSettings, { pluginId: "example.plugin" })));
window.webhookProbe = async () => {
  await waitFor(() => document.querySelector("input"));
  const warning = document.body.textContent.includes("明文 HTTP");
  const masked = document.body.textContent.includes("已隐藏");
  const manage = [...document.querySelectorAll("button")].find((button) => button.textContent.includes("管理令牌"));
  flushSync(() => manage.click());
  await waitFor(() => calls.some((call) => call.channel.endsWith("/webhooks/tokenDialog")));
  const local = [...document.querySelectorAll("button")].find((button) => button.textContent.includes("仅在本机监听"));
  await waitFor(() => !local.disabled);
  flushSync(() => local.click());
  await waitFor(() => document.body.textContent.includes("监听局域网"));
  const localModeHidesWarning = !document.body.textContent.includes("明文 HTTP");
  const url = document.querySelector("input").value;
  loopbackOnly = false;
  flushSync(() => rootNode.render(React.createElement(WebhookLanWarning, { plugins: [{ id: "example.plugin", enabled: true, permissions: ["inbound.webhook"] }] })));
  const globalButton = await waitFor(() => [...document.querySelectorAll("button")].find((button) => button.textContent.includes("仅在本机监听")));
  flushSync(() => globalButton.click());
  await waitFor(() => !document.body.textContent.includes("明文 HTTP"));
  return {
    warning, masked,
    localModeHidesWarning,
    tokenDialogCalls: calls.filter((call) => call.channel.endsWith("/webhooks/tokenDialog")).length,
    bindArgs: calls.find((call) => call.channel.endsWith("/webhooks/setLoopback"))?.args,
    url,
    globalWarningCanDisable: loopbackOnly,
  };
};
`;

test("webhook settings switch modes and open token management without a renderer token", {
  timeout: 60_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Isolated Electron UI test requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "webhook-ui-"));
  try {
    await build({
      stdin: { contents: fixtureSource, resolveDir: join(root, "scripts/e2e"), sourcefile: join(root, "scripts/e2e/webhook-fixture.jsx"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@minih-agent/i18n": join(root, "packages/i18n/src"),
        "@minih-agent/shared": join(root, "packages/shared"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><body><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try { await win.loadFile(path.join(__dirname, "index.html")); const result = await win.webContents.executeJavaScript("window.webhookProbe()"); console.log("WEBHOOK_UI " + JSON.stringify(result)); app.exit(0); }
  catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env, MINIH_AGENT_DATA_DIR: join(temp, "data") };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding("utf8"); stream.on("data", (chunk) => { output += chunk; }); }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("WEBHOOK_UI "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("WEBHOOK_UI ".length)), {
      warning: true, masked: true, localModeHidesWarning: true, tokenDialogCalls: 1, bindArgs: [true],
      url: "http://127.0.0.1:37124/hooks/example.plugin/hook",
      globalWarningCanDisable: true,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
