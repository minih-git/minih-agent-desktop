#!/usr/bin/env node
/** Full-shell plugin process → inbox → view/command journey with isolated data. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const root = repositoryRoot();
const appDir = join(root, "apps/desktop");
const binary = resolveHostBinary();
const electron = resolveElectronBinary(root).electronBinary;
const scratch = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "plugin-notification-e2e-"));
const artifacts = resolve(process.env.MINIH_AGENT_NOTIFICATION_ARTIFACT_DIR ?? join(root, ".artifacts/plugin-notify-center"));
await mkdir(artifacts, { recursive: true });
const home = join(scratch, "home");
await mkdir(home, { recursive: true });
// The fixture never needs provider credentials, a user profile, or network keys.
const cleanEnv = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
const env = {
  ...cleanEnv,
  PATH: process.env.PATH,
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  HOME: home,
  USERPROFILE: home,
  LANG: "zh_CN.UTF-8",
  PI_CODING_AGENT_DIR: join(scratch, "agent"),
  MINIH_AGENT_HOST_BIN: binary,
  MINIH_AGENT_START_MAXIMIZED: "0",
  ELECTRON_RENDERER_URL: "",
};

const pluginDir = join(scratch, "plugin");
await mkdir(pluginDir, { recursive: true });
await writeFile(join(pluginDir, "manifest.json"), JSON.stringify({
  schemaVersion: 1,
  id: "fixture.notify",
  name: "常驻助手",
  version: "1.0.0",
  main: "main.mjs",
  icon: "icon.png",
  permissions: ["notify.center", "ui.view"],
  engines: { minihAgent: ">=1.0.0" },
  contributes: {
    views: [{ id: "inbox", title: "助手视图", entry: "view.html", placement: "sidebar" }],
    commands: [{ id: "fixture.notify.run", title: "运行提醒命令" }],
  },
}));
await writeFile(join(pluginDir, "view.html"), "<!doctype html><title>通知视图</title><main>合成通知视图</main>");
await writeFile(join(pluginDir, "main.mjs"), `
export async function onLoad() {
  await pi.commands.register({ id: "fixture.notify.run", title: "运行提醒命令", run: async () => {
    await pi.notify.center({ title: "命令已执行", dedupeKey: "command-result" });
  }});
  await pi.notify.center({ title: "构建已完成", body: "新版本已准备好，请查看构建结果。", dedupeKey: "build", link: { command: "fixture.notify.run" } });
  await pi.notify.center({ kind: "digest", title: "每日摘要", body: "今天有 3 项重要进展。", dedupeKey: "digest", link: { view: "inbox" } });
}
`);
await writeFile(join(pluginDir, "icon.png"), Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==", "base64",
));

async function freePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolveReady));
  const port = server.address().port;
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return port;
}

async function waitFor(fn, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`Timeout waiting for ${label}: ${lastError?.message ?? ""}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
    ws.onclose = () => {
      for (const entry of this.pending.values()) entry.reject(new Error("CDP connection closed"));
      this.pending.clear();
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolveOpen, reject) => { ws.onopen = resolveOpen; ws.onerror = reject; });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolveResult, reject) => {
      this.pending.set(id, { resolve: resolveResult, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluation failed");
    return result.result.value;
  }
  async click(selector) {
    const point = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error("missing target");
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  }
}

async function seed(theme) {
  const data = join(scratch, `data-${theme}`);
  await mkdir(data, { recursive: true });
  const host = new Host(binary, data, { env, quiet: true });
  try {
    await host.start();
    await host.call("settings.set", { language: "zh-CN", theme });
    const { session } = await host.call("session.create", { title: "构建与发布", mode: "agent" });
    const { turnId } = await host.call("session.beginTurn", { sessionId: session.id });
    await host.call("session.endTurn", { turnId, status: "completed", createNotification: true });
    await host.call("plugins.installFromPath", { path: pluginDir, enable: true, grantedPermissions: ["notify.center", "ui.view"] });
    assert.equal((await host.call("notification.list", { limit: 200 })).notifications.length, 1);
  } finally {
    await host.stop();
  }
  return data;
}

async function run(theme) {
  const data = await seed(theme);
  const profile = join(scratch, `profile-${theme}`);
  await mkdir(profile, { recursive: true });
  const port = await freePort();
  const child = spawn(electron, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "."], {
    cwd: appDir,
    env: { ...env, MINIH_AGENT_DATA_DIR: data },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output = (output + chunk).slice(-5_000); });
  }
  let cdp;
  try {
    const target = await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}`);
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
      return (await response.json()).find((entry) => entry.type === "page" && entry.url.includes("out/renderer/index.html") && !entry.url.includes("surface=") && entry.webSocketDebuggerUrl);
    }, "main window");
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await waitFor(() => cdp.evaluate(`(() => {
      const button = document.querySelector('.notification-trigger');
      if (!button) return false;
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 &&
        Boolean(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('.notification-trigger'));
    })()`), "visible notification trigger");
    await waitFor(() => cdp.evaluate(`(async () => {
      const result = await window.minihAgent.invoke("minih-agent-desktop/notification/list", { limit: 200 });
      return result.ok && result.data.notifications.length >= 3;
    })()`), "plugin notifications persisted");
    await cdp.click(".notification-trigger");
    await waitFor(() => cdp.evaluate('document.querySelector(".notification-trigger")?.getAttribute("aria-expanded") === "true"'), "notification center opens");
    await waitFor(async () => (await cdp.evaluate('document.querySelectorAll(".notification-item").length')) >= 3, "mixed notifications");
    await waitFor(() => cdp.evaluate(`(() => {
      const icons = [...document.querySelectorAll('.notification-plugin-avatar')];
      return icons.length >= 2 && icons.every((icon) => icon.complete && icon.naturalWidth > 0 && icon.src.startsWith('plugin-asset://fixture.notify/'));
    })()`), "plugin icons loaded");
    for (const width of [1440, 1024]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await waitFor(async () => (await cdp.evaluate("window.innerWidth")) === width, `viewport ${width}`);
      await cdp.evaluate(`(async () => {
        function finishAnimations() { for (const animation of document.getAnimations()) { try { animation.finish(); } catch {} } }
        finishAnimations(); await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      })()`);
      const state = await cdp.evaluate(`(() => {
        const rect = document.querySelector('.notification-popover').getBoundingClientRect();
        return { language: document.documentElement.lang, theme: document.documentElement.dataset.theme,
          kinds: [...document.querySelectorAll('.notification-item')].map((item) => item.dataset.notificationKind),
          visible: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight };
      })()`);
      assert.equal(state.language, "zh-CN");
      assert.equal(state.theme, theme);
      assert.ok(state.visible, "notification center must be inside the viewport");
      for (const kind of ["task.completed", "plugin.alert", "plugin.digest"]) assert.ok(state.kinds.includes(kind));
      const image = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      const path = join(artifacts, `${theme}-${width}.png`);
      await writeFile(path, Buffer.from(image.data, "base64"));
      console.log(`SCREENSHOT ${path}`);
    }
    await cdp.click('[data-notification-kind="plugin.digest"]');
    await waitFor(() => cdp.evaluate('Boolean(document.querySelector(\'[data-plugin-view-page="fixture.notify/inbox"]\'))'), "plugin view activation");
    await cdp.click('[data-action="leave-plugin-view"]');
    await waitFor(() => cdp.evaluate('Boolean(document.querySelector(".notification-trigger"))'), "return to shell");
    await cdp.click(".notification-trigger");
    await waitFor(() => cdp.evaluate('Boolean(document.querySelector(\'[data-notification-kind="plugin.alert"]\'))'), "alert row");
    await cdp.click('[data-notification-kind="plugin.alert"]');
    await cdp.click(".notification-trigger");
    await waitFor(() => cdp.evaluate('document.querySelector(".notification-popover")?.innerText.includes("命令已执行")'), "plugin command result");
    const uninstalled = await cdp.evaluate(`(async () => {
      const result = await window.minihAgent.invoke("minih-agent-desktop/plugin/uninstall", "fixture.notify");
      return result.ok && result.data.ok;
    })()`);
    assert.equal(uninstalled, true);
    await waitFor(() => cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.notification-item')];
      return rows.length === 1 && rows[0].dataset.notificationKind === 'task.completed' &&
        document.querySelector('.notification-badge')?.textContent === '1';
    })()`), "uninstall removes plugin notifications and refreshes the badge");
    console.log(`PASS ${theme}: plugin process → inbox → view, command and uninstall`);
  } catch (error) {
    throw new Error(`${theme} notification journey failed: ${error.message}\n${output}`);
  } finally {
    cdp?.ws.close();
    if (child.pid) {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch { /* already stopped */ }
    }
  }
}

try {
  await run("light");
  await run("dark");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
