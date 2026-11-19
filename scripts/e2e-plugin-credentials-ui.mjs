#!/usr/bin/env node
/** Full isolated Desktop shell: credential settings, plugin fetch and visual states. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { waitFor } from "./e2e/wait.mjs";

const binary = resolveHostBinary();
const repo = repositoryRoot();
const dir = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "credential-full-ui-"));
const dataDir = join(dir, "data");
const pluginDir = join(dir, "plugin");
const output = join(repo, ".artifacts/plugin-credentials");
mkdirSync(pluginDir);
mkdirSync(output, { recursive: true });
const host = new Host(binary, dataDir, { quiet: true });
let child;
let ws;
const received = [];
const httpServer = createHttpServer((request, response) => {
  received.push(request.headers.authorization);
  response.writeHead(200, { authorization: "Bearer synthetic-visual-token" });
  response.end("ok");
});
try {
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const targetUrl = `http://127.0.0.1:${httpServer.address().port}/credential`;
  writeFileSync(join(pluginDir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: "test.credential-visual", name: "凭据测试插件", version: "1.0.0", main: "main.js",
    permissions: ["net.fetch", "credentials.use"], net: { domains: ["127.0.0.1"] },
    contributes: {
      commands: [{ id: "test.credential.probe", title: "凭据连接测试" }],
      credentials: [{ id: "service", title: "测试服务", kind: "bearer",
        fields: [{ key: "token", label: "令牌", secret: true }], scope: { domains: ["127.0.0.1"] } }],
    },
  }));
  writeFileSync(join(pluginDir, "main.js"), `module.exports = {async onLoad(){await globalThis.pi.commands.register({id:'test.credential.probe',title:'凭据连接测试',run:async()=>{const result=await globalThis.pi.net.fetch({url:${JSON.stringify(targetUrl)},credentialRef:'service'});if(result.status!==200||result.headers.authorization!==undefined)throw Error('credential response check failed');}})}};`);
  await host.start();
  await host.call("plugins.loadDev", { path: pluginDir });
  await host.call("settings.set", { language: "zh-CN", theme: "light" });
  await host.stop();
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
  const env = { ...process.env, MINIH_AGENT_DATA_DIR: dataDir, MINIH_AGENT_HOST_BIN: binary,
    MINIH_AGENT_START_MAXIMIZED: "0", ELECTRON_RENDERER_URL: "" };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(resolveElectronBinary(repo).electronBinary,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, "profile")}`, "."],
    { cwd: join(repo, "apps/desktop"), env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume();
  child.stderr.resume();
  let target;
  await waitFor(async () => {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
        .find((entry) => entry.type === "page" && entry.url.includes("index.html") && !entry.url.includes("plugin-launcher"));
      return !!target;
    } catch { return false; }
  }, 30_000, "isolated desktop target");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, "open");
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const until = (expression, label) => waitFor(() => evaluate(expression), 30_000, label);
  const click = async (selector) => {
    await until(`!!document.querySelector(${JSON.stringify(selector)})`, selector);
    const ok = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;e.click();return true})()`);
    if (!ok) throw new Error(`cannot click ${selector}`);
  };
  await send("Page.enable");
  await until(`!!document.querySelector('[data-nav="plugins"]')`, "sidebar");
  await click('[data-nav="plugins"]');
  await until(`!![...document.querySelectorAll('.plugins-row')].find(e=>e.textContent.includes('凭据测试插件'))`, "plugin row");
  const open = async () => {
    await evaluate(`(()=>{const row=[...document.querySelectorAll('.plugins-row')].find(e=>e.textContent.includes('凭据测试插件'));const b=row?.querySelector('[aria-label="插件设置"]');if(!b)throw Error('settings button missing');b.click()})()`);
    await until(`!!document.querySelector('.plugin-credential-slot')`, "credential form");
  };
  const close = async () => { await click('[aria-label="关闭插件设置"]'); await until(`!document.querySelector('.plugin-credential-slot')`, "close dialog"); };
  const capture = async (state, theme, width) => {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.getAnimations().forEach(a=>{try{a.finish()}catch{}})`);
    const rect = await evaluate(`(()=>{const r=document.querySelector('.plugin-credential-slot').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}})()`);
    if (rect.x < 0 || rect.y < 0 || rect.right > rect.width || rect.bottom > rect.height) throw new Error(`credential panel outside viewport: ${JSON.stringify(rect)}`);
    const image = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(output, `${state}-${theme}-${width}.png`), Buffer.from(image.data, "base64"));
  };
  const switchTheme = async (expected) => {
    await close(); await click('[data-nav="theme"]');
    await until(`document.documentElement.dataset.theme === ${JSON.stringify(expected)}`, `theme ${expected}`);
    await open();
  };
  await open();
  await until(`document.querySelector('.plugin-credential-slot').textContent.includes('未配置')`, "unconfigured");
  if (!(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='清除凭据');return !!b && b.disabled})()`))) throw new Error("unconfigured clear button is enabled");
  for (const width of [1440, 1024]) await capture("unconfigured", "light", width);
  await switchTheme("dark");
  for (const width of [1440, 1024]) await capture("unconfigured", "dark", width);
  await evaluate(`(()=>{const e=document.querySelector('input[aria-label="令牌"]');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'synthetic-visual-token');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='保存凭据');if(!b||b.disabled)throw Error('save unavailable');b.click()})()`);
  await until(`document.querySelector('.plugin-credential-slot').textContent.includes('已配置')`, "configured");
  if (await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='清除凭据');return !b || b.disabled})()`)) throw new Error("configured clear button is disabled");
  if (await evaluate(`document.querySelector('input[aria-label="令牌"]').value`)) throw new Error("saved value remained visible");
  await until(`(async()=>{const r=await window.minihAgent.invoke(window.minihAgent.channels.invoke.commandPaletteSearch,'凭据连接测试');return r.ok&&r.data.commands.some(c=>c.id==='test.credential.probe')})()`, "plugin command");
  const commandOk = await evaluate(`(async()=>{const r=await window.minihAgent.invoke(window.minihAgent.channels.invoke.commandPaletteExecute,'test.credential.probe');return r.ok})()`);
  if (!commandOk || received.length !== 1 || received[0] !== "Bearer synthetic-visual-token") throw new Error("plugin authenticated fetch failed");
  const auditLog = readFileSync(join(dataDir, "logs/app/plugin.log"), "utf8");
  const auditRows = auditLog.trim().split("\n").map((line) => JSON.parse(line));
  if (!auditRows.some((row) => row.api === "net.fetch" && row.scheme === "http")) throw new Error("credential audit scheme missing");
  if (auditLog.includes("synthetic-visual-token")) throw new Error("credential leaked into audit log");
  for (const width of [1440, 1024]) await capture("configured", "dark", width);
  await switchTheme("light");
  for (const width of [1440, 1024]) await capture("configured", "light", width);
} finally {
  if (ws) ws.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
  await host.stop();
  await new Promise((resolve) => httpServer.close(resolve));
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
console.log(`PASS full Desktop credential path and screenshots: ${output}`);
