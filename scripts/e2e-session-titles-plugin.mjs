#!/usr/bin/env node
/** Official title plugin + isolated Electron + local synthetic provider. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { waitFor } from "./e2e/wait.mjs";
import { connectRenderer } from "../apps/desktop/test/e2e/plugin-ui-slots/clients.mjs";

const pluginDir = process.argv[2] && resolve(process.argv[2]);
if (!pluginDir) throw new Error("Usage: node scripts/e2e-session-titles-plugin.mjs <official-plugin-directory>");
const manifest = JSON.parse(await readFile(join(pluginDir, "manifest.json"), "utf8"));
assert.equal(manifest.id, "minih.session-titles");
const root = repositoryRoot(), binary = resolveHostBinary();
const scratch = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "title-plugin-e2e-"));
const dataDir = join(scratch, "data"), home = join(scratch, "home");
await mkdir(home, { recursive: true });
const env = {
  ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])),
  PATH: process.env.PATH, HOME: home, USERPROFILE: home, LANG: "zh_CN.UTF-8",
  MINIH_AGENT_DATA_DIR: dataDir, MINIH_AGENT_HOST_BIN: binary,
  PI_CODING_AGENT_DIR: join(scratch, "agent"), MINIH_AGENT_START_MAXIMIZED: "0", ELECTRON_RENDERER_URL: "",
};
const host = new Host(binary, dataDir, { env, quiet: true });
const requests = [];
const server = httpServer(async (req, res) => {
  if (req.method !== "POST") { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"data":[]}'); return; }
  let body = ""; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body); requests.push(input);
  const text = input.model === "title-fixture" ? "登录问题排查" : "排查已完成";
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model: input.model };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\n`);
  res.end("data: [DONE]\n\n");
});
let child, renderer, output = "";
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  await host.start();
  const { provider } = await host.call("providers.create", {
    name: "Title E2E", type: "openai_compatible", apiStyle: "chat_completions",
    authKind: "none", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    defaultModelId: "chat-fixture", models: ["chat-fixture", "title-fixture"].map(id => ({ id, contextWindow: 128000, maxTokens: 4096, thinkingLevels: ["off"] })),
  });
  await host.call("settings.set", { language: "zh-CN", theme: "light", defaultProviderId: provider.id, defaultModelId: "chat-fixture", networkProxy: { mode: "direct" }, followUpSuggestion: { enabled: false } });
  await host.call("plugins.loadDev", { path: pluginDir });
  await host.stop();
  const port = await new Promise((done, reject) => {
    const s = createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => done(port)); });
  });
  child = spawn(resolveElectronBinary(root).electronBinary, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(scratch, "profile")}`, "."], {
    cwd: join(root, "apps/desktop"), env, stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk).slice(-12000); });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}`);
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).some(p => p.type === "page" && p.url.includes("out/renderer/index.html") && !p.url.includes("surface=")); } catch { return false; }
  }, 60000, "isolated desktop");
  renderer = await connectRenderer(port, p => p.url.includes("out/renderer/index.html") && !p.url.includes("surface="));
  console.log("Renderer target", await renderer.run(() => location.href));
  await renderer.until(() => !!document.querySelector('[data-nav="plugins"]'), null, "plugin destination", 60000);
  await renderer.click('[data-nav="plugins"]');
  await renderer.until(() => [...document.querySelectorAll(".plugins-row")].some(row => row.textContent.includes("会话标题")), null, "official title plugin");
  await renderer.until(async () => {
    const result = await window.minihAgent.invoke(window.minihAgent.channels.invoke.pluginSettingsGet, "minih.session-titles");
    return result.ok && result.data.settings?.some(setting => setting.key === "model");
  }, null, "plugin settings ready", 30000);
  await renderer.run(() => {
    const row = [...document.querySelectorAll(".plugins-row")].find(row => row.textContent.includes("会话标题"));
    row.querySelector('[aria-label="插件设置"]').setAttribute("data-title-settings", "true");
  });
  await renderer.click('[data-title-settings="true"]');
  await renderer.until(() => !!document.querySelector('[aria-label="Title model / 标题模型"]'), null, "native model picker");
  await renderer.click('[aria-label="Title model / 标题模型"]');
  await renderer.until(() => [...document.querySelectorAll('[role="option"]')].some(node => node.textContent.includes("title-fixture")), null, "title model option");
  await renderer.run(() => [...document.querySelectorAll('[role="option"]')].find(node => node.textContent.includes("title-fixture")).setAttribute("data-title-model", "true"));
  await renderer.click('[data-title-model="true"]');
  await renderer.until(() => document.querySelector('[aria-label="Title model / 标题模型"]')?.textContent.includes("title-fixture"), null, "selected title model");
  await renderer.run(() => [...document.querySelectorAll('.plugins-modal-actions button')].find(node => node.textContent.trim() === "保存设置").setAttribute("data-title-save", "true"));
  await renderer.click('[data-title-save="true"]');
  await renderer.until(() => !document.querySelector('.plugins-settings-modal'), null, "settings saved");
  await renderer.run(() => [...document.querySelectorAll('.plugins-row')].find(row => row.textContent.includes("会话标题")).querySelector('[aria-label="插件设置"]').setAttribute("data-title-settings", "true"));
  await renderer.click('[data-title-settings="true"]');
  await renderer.until(() => document.querySelector('[aria-label="Title model / 标题模型"]')?.textContent.includes("title-fixture"), null, "persisted title model");
  await writeFile(join(scratch, "settings-model-selected.png"), Buffer.from(await renderer.screenshot(), "base64"));
  await renderer.click('[aria-label="关闭插件设置"]');
  const invoke = (channel, args) => renderer.run(async ({ channel, args }) => {
    const result = await window.minihAgent.invoke(window.minihAgent.channels.invoke[channel], ...args);
    if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.data;
  }, { channel, args });
  const create = () => invoke("sessionCreate", [{ title: "New task", mode: "agent", providerId: provider.id, modelId: "chat-fixture" }]);
  const first = await create(); const sessionId = first.session.id;
  await invoke("agentPrompt", [{ sessionId, content: "帮我排查登录问题，不需要调用工具" }]);
  await waitFor(async () => (await invoke("sessionGet", [sessionId])).session?.title === "登录问题排查", 60000, "generated title persisted");
  assert.ok(requests.some(request => request.model === "title-fixture"));
  await waitFor(() => requests.some(request => request.model === "chat-fixture"), 60000, "conversation model request");
  assert.equal(requests.filter(request => request.model === "title-fixture").length, 1);
  const titleRequest = requests.find(request => request.model === "title-fixture");
  assert.equal(titleRequest.max_tokens ?? titleRequest.max_completion_tokens, 128);
  await invoke("pluginSettingsSet", [{ id: manifest.id, settings: { enabled: false } }]);
  const second = await create();
  await invoke("agentPrompt", [{ sessionId: second.session.id, content: "另一个任务，不需要调用工具" }]);
  await waitFor(async () => {
    const detail = await invoke("sessionGet", [second.session.id]);
    return detail.session?.messages?.some(message => message.role === "assistant");
  }, 60000, "second turn complete");
  assert.equal(requests.filter(request => request.model === "title-fixture").length, 1, "disabled title plugin must not spend another title call");
  console.log(JSON.stringify({ result: "PASS", configuredModel: "title-fixture", title: "登录问题排查", titleCalls: 1, disabledGeneration: "PASS", artifacts: scratch }));
} catch (error) {
  await writeFile(join(scratch, "electron.log"), output);
  if (renderer) await writeFile(join(scratch, "controls.json"), JSON.stringify(await renderer.run(() => ({
    text: document.body.innerText,
    controls: [...document.querySelectorAll('button,[role="dialog"]')].map(node => ({ text: node.textContent.slice(0, 100), label: node.getAttribute("aria-label"), role: node.getAttribute("role") })),
  })), null, 2)).catch(() => {});
  if (renderer) await writeFile(join(scratch, "failure.png"), Buffer.from(await renderer.screenshot(), "base64")).catch(() => {});
  console.error(`Artifacts: ${scratch}`); throw error;
} finally {
  renderer?.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 3000);
    await once(child, "close"); clearTimeout(deadline);
  }
  await host.stop();
  await new Promise(done => server.close(done));
}
