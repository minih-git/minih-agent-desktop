#!/usr/bin/env node
/**
 * Full isolated Desktop shell: a plugin creates an employee task, a local fake
 * model asks for a shell command, the person's permission card stops the turn,
 * `tasks:changed` reaches the creating plugin, and the plugin stops the task.
 *
 * What is real here: the Electron shell, preload, Electron Main, the plugin
 * host process and its `pi.tasks.*` bridge, the Rust host (task ledger, employee
 * roster, permission manager), the agent runtime, and the task's own session.
 * What is replaced: the model service only — an in-process HTTP server speaking
 * OpenAI `chat_completions` over SSE on 127.0.0.1. No real provider is touched,
 * and `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `MINIH_AGENT_DATA_DIR` all point
 * inside this run's scratch directory.
 *
 * Screenshots (zh-CN, light and dark, 1440 and 1024 wide) cover the three states
 * of the journey: 1 permission review for `tasks.manage` (the accept-edits
 * ceiling note), 2 the created-task notification, 3 the task's permission card.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { assertLocalModelOnly, pluginTasksModelFixture } from "./e2e/plugin-tasks-model.mjs";

const root = repositoryRoot();
const appDir = join(root, "apps/desktop");
const hostBinary = resolveHostBinary();
const electronBinary = resolveElectronBinary(root).electronBinary;
const scratch = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "plugin-tasks-e2e-"));
const artifacts = resolve(
  process.env.MINIH_AGENT_PLUGIN_TASKS_ARTIFACT_DIR ?? join(scratch, "artifacts"),
);
await mkdir(artifacts, { recursive: true });

const PLUGIN_ID = "fixture.tasks.workbench";
const PLUGIN_NAME = "任务工作台";
const EMPLOYEE_NAME = "打包助手";
const TASK_TITLE = "整理构建日志";
const STOP_COMMAND = "fixture.tasks.stop";
const MODEL_ID = "plugin-tasks-fixture";

const TEXTS = {
  reviewLabel: "权限确认",
  // A folder that was never reviewed in this run reloads as "wants more"; the
  // dialog may also open as a first load, so both titles are accepted.
  reviewTitles: ["任务工作台 请求更多权限", "加载 任务工作台？"],
  manageLabel: "创建并推进任务",
  manageHelp: "创建并推进本插件创建的任务。",
  ceiling: "插件创建的任务目前最高以 accept-edits 模式运行",
  accept: "加载插件",
  reload: "重载插件",
  permissionTitle: "需要权限",
  bash: "Bash",
};

/** A clean process environment: nothing of the developer's profile leaks in. */
function isolatedEnv(home, extra = {}) {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "TEMP", "OS", "PROCESSOR_ARCHITECTURE"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"),
    TMPDIR: join(home, "tmp"),
    LANG: "zh_CN.UTF-8",
    LC_ALL: "zh_CN.UTF-8",
    PI_CODING_AGENT_DIR: join(home, "agent"),
    MINIH_AGENT_HOST_BIN: hostBinary,
    MINIH_AGENT_START_MAXIMIZED: "0",
    ELECTRON_RENDERER_URL: "",
    ...extra,
  });
  return env;
}

async function writePluginFixture(pluginDir) {
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: PLUGIN_ID,
      name: PLUGIN_NAME,
      version: "1.0.0",
      description: "员工任务工作台（端到端测试夹具）",
      // `.js` + `module.exports`: a CommonJS entry, the shape a plugin folder
      // written by hand uses.
      main: "main.js",
      permissions: ["tasks.read", "tasks.manage"],
      // Declared `auto` is the ceiling the review has to speak about: the host
      // still runs every plugin-created task at accept-edits.
      tasks: { manage: { maxPermission: "auto" } },
      engines: { minihAgent: ">=1.0.0" },
      contributes: {
        commands: [{ id: STOP_COMMAND, title: "停止插件任务" }],
      },
    }),
  );
  await writeFile(join(pluginDir, "main.js"), PLUGIN_MAIN);
}

const PLUGIN_MAIN = `
const fs = require("node:fs");
const path = require("node:path");

let logPath = null;
let taskId = null;

function record(entry) {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify({ ts: Date.now(), ...entry }) + "\\n");
}

module.exports = {
  async onLoad() {
    const dataPath = await pi.plugin.getDataPath();
    fs.mkdirSync(dataPath, { recursive: true });
    logPath = path.join(dataPath, "task-journey.ndjson");
    record({ kind: "load", pluginId: pi.plugin.getId() });
    pi.events.on("tasks:changed", (event) => {
      record({ kind: "changed", taskId: event.taskId, stage: event.stage });
    });
    await pi.commands.register({
      id: ${JSON.stringify(STOP_COMMAND)},
      title: "停止插件任务",
      run: async () => {
        record({ kind: "stopRequested", taskId });
        try {
          const listed = await pi.tasks.list({ limit: 20 });
          const target = taskId ?? listed.tasks[0]?.taskId;
          record({ kind: "listed", tasks: listed.tasks.map((row) => ({ taskId: row.taskId, stage: row.stage })) });
          await pi.tasks.stop({ taskId: target });
          record({ kind: "stopped", taskId: target });
          const after = await pi.tasks.get({ taskId: target });
          record({ kind: "afterStop", task: after.task });
        } catch (error) {
          record({ kind: "stopFailed", code: error.code ?? null, message: String(error.message) });
          throw error;
        }
      },
    });
    const roster = await pi.tasks.roster();
    record({
      kind: "roster",
      employees: roster.employees.map((row) => ({
        employeeId: row.employeeId,
        name: row.name,
        permissionMode: row.permissionMode,
      })),
    });
    const employee = roster.employees.find((row) => row.name === ${JSON.stringify(EMPLOYEE_NAME)}) ?? roster.employees[0];
    if (!employee) throw new Error("no employee to create a task for");
    const created = await pi.tasks.create({
      employeeId: employee.employeeId,
      title: ${JSON.stringify(TASK_TITLE)},
      prompt: "用 Bash 运行 git status --short，然后汇报结果。",
    });
    taskId = created.taskId;
    record({ kind: "created", taskId: created.taskId, sessionId: created.sessionId });
  },
};
`;

async function freePort() {
  const server = createNetServer();
  await new Promise((resolveReady, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolveReady),
  );
  const { port } = server.address();
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return port;
}

function until(predicate, label, timeoutMs = 120_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  return (async () => {
    while (Date.now() < deadline) {
      try {
        const value = await predicate();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await delay(intervalMs);
    }
    throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
  })();
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
    socket.onclose = () => {
      for (const entry of this.pending.values()) entry.reject(new Error("CDP connection closed"));
      this.pending.clear();
    };
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, reject) => {
      socket.onopen = resolveOpen;
      socket.onerror = reject;
    });
    return new Cdp(socket);
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolveResult, reject) => {
      this.pending.set(id, { resolve: resolveResult, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "evaluation failed",
      );
    }
    return result.result.value;
  }

  async clickByText(selector, text) {
    const clicked = await this.evaluate(`(() => {
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.textContent.includes(${JSON.stringify(text)}));
      if (!target) return false;
      target.click();
      return true;
    })()`);
    assert.equal(clicked, true, `could not click ${selector} containing ${text}`);
  }

  async click(selector) {
    const clicked = await this.evaluate(`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return false;
      target.click();
      return true;
    })()`);
    assert.equal(clicked, true, `could not click ${selector}`);
  }

  /** Finish animations, then settle two frames: the screenshot is post-animation. */
  async settle() {
    await this.evaluate(`(async () => {
      const finishAnimations = () => {
        for (const animation of document.getAnimations()) {
          try { animation.finish(); } catch {}
        }
      };
      finishAnimations();
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      finishAnimations();
      await new Promise((done) => requestAnimationFrame(done));
    })()`);
  }

  async capture(path, selector) {
    await this.settle();
    const box = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      // A card deep in a transcript still has to be on screen for the shot.
      element.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: innerWidth, height: innerHeight,
      };
    })()`);
    assert.ok(box, `${selector} is missing before the screenshot`);
    assert.ok(
      box.left >= -1 && box.top >= -1 && box.right <= box.width + 1 && box.bottom <= box.height + 1,
      `${selector} must be inside the viewport: ${JSON.stringify(box)}`,
    );
    const image = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(path, Buffer.from(image.data, "base64"));
    console.log(`SCREENSHOT ${path}`);
  }
}

async function findJourneyLog(dataDir) {
  const queue = [dataDir];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.name === "task-journey.ndjson") return full;
    }
  }
  return null;
}

async function readJourney(logPath) {
  if (!logPath) return [];
  try {
    const text = await readFile(logPath, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const WAITING_STAGES = ["person/answer", "blocked", "failed", "waiting"];

async function seed(theme, modelBaseUrl) {
  const home = join(scratch, `home-${theme}`);
  await mkdir(join(home, "tmp"), { recursive: true });
  const dataDir = join(scratch, `data-${theme}`);
  await mkdir(dataDir, { recursive: true });
  const project = join(scratch, `project-${theme}`);
  await mkdir(project, { recursive: true });
  const env = isolatedEnv(home);
  const host = new Host(hostBinary, dataDir, { env, quiet: true });
  try {
    const handshake = await host.start();
    await host.call("settings.set", { language: "zh-CN", theme });
    await host.call("workspace.set", { path: project });
    const { provider } = await host.call("providers.create", {
      name: "Plugin task fixture model",
      vendorKey: "custom",
      type: "openai_compatible",
      protocol: "openai_compatible",
      baseUrl: modelBaseUrl,
      authKind: "none",
      defaultModelId: MODEL_ID,
      apiStyle: "chat_completions",
    });
    assertLocalModelOnly(modelBaseUrl);
    await host.call("settings.set", {
      defaultProviderId: provider.id,
      defaultModelId: MODEL_ID,
      defaultMode: "agent",
      defaultPermissionMode: "accept-edits",
    });
    const hire = await host.call("bot.create", {
      profile: {
        name: EMPLOYEE_NAME,
        duty: "整理构建日志与产物",
        permissionMode: "accept-edits",
        mustAsk: [],
        observe: false,
      },
      title: EMPLOYEE_NAME,
    });
    assert.ok(hire?.session?.id, "the employee must exist before a task can be created");
    // Registered as a local plugin folder, then switched off: the journey's own
    // reload is what loads it, so the task is created while the test watches.
    await host.call("plugins.loadDev", { path: join(scratch, "plugin") });
    await host.call("plugins.disable", { id: PLUGIN_ID });
    return { dataDir, project, home, env, employeeId: hire.session.id, handshake };
  } finally {
    await host.stop();
  }
}

async function run(theme, model, modelBaseUrl) {
  const seeded = await seed(theme, modelBaseUrl);
  const profile = join(scratch, `profile-${theme}`);
  await mkdir(profile, { recursive: true });
  const port = await freePort();
  const evidence = { theme, screenshots: [], milestones: [] };
  let output = "";
  const child = spawn(
    electronBinary,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "."],
    {
      cwd: appDir,
      env: { ...seeded.env, MINIH_AGENT_DATA_DIR: seeded.dataDir },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-20_000);
    });
  }
  let cdp;
  const milestone = (name, detail) => {
    evidence.milestones.push({ name, ts: Date.now(), ...(detail ?? {}) });
    console.log(`MILESTONE ${theme} ${name}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
  };
  try {
    const target = await until(async () => {
      if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}`);
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      });
      return (await response.json()).find(
        (entry) =>
          entry.type === "page" &&
          entry.url.includes("out/renderer/index.html") &&
          !entry.url.includes("surface=") &&
          entry.webSocketDebuggerUrl,
      );
    }, "main window");
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

    await until(
      () => cdp.evaluate(`document.documentElement.lang === "zh-CN" && document.documentElement.dataset.theme === ${JSON.stringify(theme)}`),
      `shell in zh-CN / ${theme}`,
    );
    await until(
      () => cdp.evaluate(`!!document.querySelector('[data-nav="plugins"]')`),
      "sidebar",
    );
    await cdp.click('[data-nav="plugins"]');
    await until(
      () => cdp.evaluate(`!![...document.querySelectorAll('.plugins-row')].find((row) => row.textContent.includes(${JSON.stringify(PLUGIN_NAME)}))`),
      "installed plugin row",
    );
    milestone("plugin-row-visible");

    // 1. The permission review a locally loaded plugin folder has to answer.
    const menuOpened = await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('.plugins-row')].find((item) => item.textContent.includes(${JSON.stringify(PLUGIN_NAME)}));
      // Each row also carries a scope menu; the actions menu is the one whose
      // accessible name is "<plugin> 的操作".
      const trigger = [...(row?.querySelectorAll('[aria-haspopup="menu"]') ?? [])]
        .find((button) => (button.getAttribute("aria-label") ?? "").endsWith("的操作"));
      if (!trigger) return false;
      trigger.click();
      return true;
    })()`);
    assert.equal(menuOpened, true, "the plugin row menu must open");
    await until(
      () => cdp.evaluate(`!![...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes(${JSON.stringify(TEXTS.reload)}))`),
      "reload menu item",
    );
    await cdp.clickByText('[role="menuitem"]', TEXTS.reload);
    await until(
      () => cdp.evaluate(`!!document.querySelector('.plugins-modal[role="dialog"]')`),
      "permission review dialog",
    );
    const review = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('.plugins-modal[role="dialog"]');
      const text = dialog?.textContent ?? "";
      return {
        label: dialog?.getAttribute("aria-label") ?? "",
        text,
        accepts: [...(dialog?.querySelectorAll("button") ?? [])].map((button) => button.textContent.trim()),
      };
    })()`);
    assert.equal(review.label, TEXTS.reviewLabel);
    assert.ok(
      TEXTS.reviewTitles.some((title) => review.text.includes(title)),
      `review title: ${review.text.slice(0, 400)}`,
    );
    assert.ok(review.text.includes(TEXTS.manageLabel), "the review must list tasks.manage");
    assert.ok(review.text.includes(TEXTS.manageHelp), "the review must explain tasks.manage");
    assert.ok(review.text.includes(TEXTS.ceiling), "the review must state the accept-edits ceiling");
    assert.ok(review.accepts.includes(TEXTS.accept), "the review must offer the accept button");
    milestone("permission-review-shown");
    for (const width of [1440, 1024]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await until(() => cdp.evaluate(`innerWidth === ${width}`), `viewport ${width}`);
      const path = join(artifacts, `${theme}-${width}-1-permission-review.png`);
      await cdp.capture(path, '.plugins-modal[role="dialog"]');
      evidence.screenshots.push(path);
    }

    // Accepting the review is what loads the plugin, which is what creates the task.
    await cdp.clickByText(".plugins-modal[role='dialog'] button", TEXTS.accept);
    try {
      await until(
        () => cdp.evaluate(`!document.querySelector('.plugins-modal[role="dialog"]')`),
        "review dialog closed",
        90_000,
      );
    } catch (error) {
      // A failed confirm keeps the dialog open and reports through a toast; the
      // toast is the only place that reason is visible.
      const toast = await cdp
        .evaluate(`[...document.querySelectorAll('.toast-message')].map((node) => node.textContent).join(" | ")`)
        .catch(() => "");
      throw new Error(`${error.message}; toast: ${toast}`);
    }
    milestone("review-accepted");

    const logPath = await until(() => findJourneyLog(seeded.dataDir), "plugin journey log", 90_000);
    const created = await until(async () => {
      const rows = await readJourney(logPath);
      return rows.find((row) => row.kind === "created");
    }, "pi.tasks.create answer", 90_000);
    milestone("task-created", { taskId: created.taskId, sessionId: created.sessionId });
    const roster = (await readJourney(logPath)).find((row) => row.kind === "roster");
    assert.ok(roster?.employees?.some((row) => row.employeeId === seeded.employeeId), "the roster must hold the hired employee");
    assert.equal(
      roster.employees.find((row) => row.employeeId === seeded.employeeId)?.permissionMode,
      "accept-edits",
    );

    await until(() => model.askedForBash, "the local model to be asked for a shell step", 120_000);
    milestone("model-asked-for-bash", { calls: model.calls });

    // 2. The person's inbox row for the task the plugin created.
    await until(
      () => cdp.evaluate(`!!document.querySelector('.notification-trigger')`),
      "notification trigger",
    );
    await cdp.click(".notification-trigger");
    await until(
      () => cdp.evaluate(`document.querySelector('.notification-trigger')?.getAttribute('aria-expanded') === "true"`),
      "notification center open",
    );
    const row = await until(
      () => cdp.evaluate(`(() => {
        // The permission prompt for the same session also carries the task
        // title; the announcement is the plugin-owned row.
        const item = [...document.querySelectorAll('.notification-item')]
          .find((entry) => entry.dataset.notificationKind === "plugin.alert" && entry.textContent.includes(${JSON.stringify(TASK_TITLE)}));
        if (!item) return null;
        return { id: item.dataset.notificationId, kind: item.dataset.notificationKind, text: item.textContent };
      })()`),
      "created-task notification row",
    );
    assert.equal(row.kind, "plugin.alert");
    assert.ok(row.text.includes(EMPLOYEE_NAME), `notification names the employee: ${row.text}`);
    assert.ok(row.text.includes(PLUGIN_NAME), `notification names the plugin: ${row.text}`);
    assert.ok(row.text.includes(`插件「${PLUGIN_NAME}」`), `notification uses the plugin display name: ${row.text}`);
    assert.ok(row.text.includes("以 允许编辑 模式运行"), `notification names the effective mode: ${row.text}`);
    milestone("task-notification-shown", { notificationId: row.id });
    for (const width of [1440, 1024]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await until(() => cdp.evaluate(`innerWidth === ${width}`), `viewport ${width}`);
      const path = join(artifacts, `${theme}-${width}-2-task-notification.png`);
      await cdp.capture(path, ".notification-popover");
      evidence.screenshots.push(path);
    }

    // 3. Opening that row is the task's own session, where the shell step waits.
    const opened = await cdp.evaluate(`(() => {
      const item = [...document.querySelectorAll('.notification-item')]
        .find((entry) => entry.dataset.notificationKind === "plugin.alert" && entry.textContent.includes(${JSON.stringify(TASK_TITLE)}));
      if (!item) return false;
      item.click();
      return true;
    })()`);
    assert.equal(opened, true, "the task notification must be clickable");
    const card = await until(
      () => cdp.evaluate(`(() => {
        const element = document.querySelector('.permission-card');
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { title: element.textContent, visible: rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0 };
      })()`),
      "permission card for the Bash step",
      120_000,
    );
    assert.ok(card.title.includes(TEXTS.permissionTitle), `permission card title: ${card.title.slice(0, 300)}`);
    assert.ok(card.title.includes(TEXTS.bash), `the card must be about Bash: ${card.title.slice(0, 300)}`);
    assert.ok(!card.title.includes("允许本次对话"), "a plugin task must not offer session-wide approval");
    assert.equal(card.visible, true, "the permission card must be on screen");
    milestone("permission-card-shown");
    for (const width of [1440, 1024]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await until(() => cdp.evaluate(`innerWidth === ${width}`), `viewport ${width}`);
      const path = join(artifacts, `${theme}-${width}-3-permission-card.png`);
      await cdp.capture(path, ".permission-card");
      evidence.screenshots.push(path);
    }

    // The task is waiting on the person: the host stage event must reach the
    // plugin that created it, resolved from the ledger.
    const waiting = await until(async () => {
      const rows = await readJourney(logPath);
      return rows.find(
        (row) => row.kind === "changed" && row.taskId === created.taskId && WAITING_STAGES.includes(row.stage),
      );
    }, "tasks:changed waiting stage", 120_000);
    milestone("tasks-changed-waiting", { stage: waiting.stage });

    // The plugin stops its own task through the command palette channel.
    const stopCall = await cdp.evaluate(`(async () => {
      const result = await window.minihAgent.invoke(
        window.minihAgent.channels.invoke.commandPaletteExecute,
        { commandId: ${JSON.stringify(STOP_COMMAND)}, pluginId: ${JSON.stringify(PLUGIN_ID)} },
      );
      return { ok: !!result?.ok, commandId: result?.data?.commandId ?? result?.commandId ?? null };
    })()`);
    assert.equal(stopCall.ok, true, "the plugin command must run");
    const stopped = await until(async () => {
      const rows = await readJourney(logPath);
      return rows.find((row) => row.kind === "stopped" && row.taskId === created.taskId);
    }, "pi.tasks.stop answer", 90_000);
    const afterStop = await until(async () => {
      const rows = await readJourney(logPath);
      return rows.find((row) => row.kind === "afterStop");
    }, "pi.tasks.get after stop", 90_000);
    assert.equal(stopped.taskId, created.taskId);
    assert.equal(afterStop.task.employeeId, seeded.employeeId, "the task ledger must name its employee");
    // The card the person was looking at must go away once the plugin stops the
    // task: `person/answer` is the stage that means "waiting for that answer".
    assert.notEqual(
      afterStop.task.stage,
      "person/answer",
      "a stopped task must not still wait for the permission answer",
    );
    await until(
      () => cdp.evaluate(`!document.querySelector('.permission-card')`),
      "permission card withdrawn after stop",
      60_000,
    );
    milestone("task-stopped", { stage: afterStop.task.stage });

    evidence.journey = await readJourney(logPath);
    evidence.modelRequests = model.requests;
    evidence.task = { taskId: created.taskId, sessionId: created.sessionId, finalStage: afterStop.task.stage };
    console.log(`PASS ${theme}: plugin → task → Bash approval → tasks:changed → pi.tasks.stop`);
  } catch (error) {
    const failure = `${theme} plugin-task journey failed: ${error.message}\n${output}`;
    await writeFile(join(artifacts, `failure-${theme}.log`), failure);
    throw new Error(failure);
  } finally {
    cdp?.socket.close();
    const logPath = await findJourneyLog(seeded.dataDir);
    evidence.journey = evidence.journey ?? (await readJourney(logPath));
    await writeFile(
      join(artifacts, `journey-${theme}.json`),
      JSON.stringify(
        { ...evidence, pluginLog: logPath, appOutput: output.slice(-8_000) },
        null,
        2,
      ),
    );
    if (child.pid) {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already stopped */
      }
    }
  }
  return evidence;
}

const model = pluginTasksModelFixture();
const server = createServer(model.handler);
await new Promise((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
const modelBaseUrl = `http://127.0.0.1:${server.address().port}/v1`;
console.log(`LOCAL MODEL ${modelBaseUrl}`);
await writePluginFixture(join(scratch, "plugin"));
const summary = { scratch, artifacts, modelBaseUrl, runs: [] };
try {
  for (const theme of ["light", "dark"]) {
    summary.runs.push(await run(theme, model, modelBaseUrl));
  }
  await writeFile(join(artifacts, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`PASS plugin tasks journey. Screenshots: ${artifacts}`);
} finally {
  await new Promise((resolveClosed) => server.close(resolveClosed));
  if (!process.env.MINIH_AGENT_PLUGIN_TASKS_KEEP) {
    await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } else {
    console.log(`KEPT ${scratch}`);
  }
}