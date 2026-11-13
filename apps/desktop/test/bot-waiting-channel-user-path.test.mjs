import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * The waiting channel, as a person operates it (employee mode 0.5 slice 4a).
 *
 * One record, four surfaces, and this is the file that proves the three the
 * renderer owns: the steward's dock row a question shows up as, the blocked card
 * a stuck task shows as, and the sidebar's 「等你 N 件」 with the list it opens.
 *
 * Everything runs the production components in a real Electron renderer with the
 * real catalogs and real clicks. The host is stubbed at `window.minihAgent`, the
 * same seam the renderer uses in production, so the assertions are about what the
 * person sees and what the app asks the host to do.
 */

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
import { StewardTaskDock, TaskBlockedCardForSession } from "../../apps/desktop/src/features/bots/TaskWaitingDock";
import { BotSidebarGroup } from "../../apps/desktop/src/features/bots/BotSidebarGroup";
import { AskToolCard } from "../../apps/desktop/src/components/AskToolCard";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({ lng: "zh-CN", keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } },
  interpolation: { escapeValue: false } });

const calls = [];
const selected = [];
const sent = [];
const listeners = new Map();

function emit(channel, payload) {
  for (const listener of listeners.get(channel) ?? []) listener(payload);
}

const bots = [
  { sessionId: "steward", title: "Super Agent",
    profile: { name: "Super Agent", definition: "steward", permissionMode: "ask", mustAsk: [], observe: false },
    status: { kind: "idle" }, projectPath: "/repo/desktop", updatedAt: "2026-11-13T00:00:00.000Z", createdAt: "2026-11-13T00:00:00.000Z" },
  { sessionId: "router", title: "Router 后端",
    profile: { name: "Router 后端", permissionMode: "accept-edits", mustAsk: [], observe: false },
    status: { kind: "idle" }, projectPath: "/repo/router", updatedAt: "2026-11-13T00:00:00.000Z", createdAt: "2026-11-13T00:00:00.000Z" },
];

const initialTasks = [
  { id: "task-1", employeeSessionId: "router", sessionId: "task-1-session", title: "修一下登录超时",
    origin: "steward", stage: "person/answer", projectPath: "/repo/router", shortId: "task1",
    createdAt: "2026-11-13T00:00:00.000Z", workspaceStatus: "none",
    waiting: [{ requestId: "req-1", kind: "ask", question: "要保留旧的登录接口吗？", options: ["保留", "直接删掉"], openedAt: "2026-11-13T00:00:00.000Z" }] },
  { id: "task-2", employeeSessionId: "router", sessionId: "task-2-session", title: "补 remote_gateway 单测",
    origin: "steward", stage: "blocked", projectPath: "/repo/router", shortId: "task2",
    createdAt: "2026-11-13T00:00:00.000Z", workspaceStatus: "none",
    blocker: { status: "blocked", where: "迁移脚本要先在测试库上跑一遍", tried: "本地跑过一次，缺 staging 权限", suggestion: "给我一份 staging 只读账号" } },
  { id: "task-3", employeeSessionId: "router", sessionId: "task-3-session", title: "看一下缓存命中率",
    origin: "steward", stage: "person/answer", projectPath: "/repo/router", shortId: "task3",
    createdAt: "2026-11-13T00:00:00.000Z", workspaceStatus: "none",
    waiting: [{ requestId: "req-9", kind: "ask", question: "缓存预热要不要一起做？", openedAt: "2026-11-13T00:00:00.000Z" }] },
];
let tasks = initialTasks.map((task) => ({ ...task }));

window.minihAgent = {
  platform: "darwin",
  on(channel, listener) {
    const bucket = listeners.get(channel) ?? new Set();
    bucket.add(listener);
    listeners.set(channel, bucket);
    return () => bucket.delete(listener);
  },
  async invoke(channel, input) {
    calls.push({ channel, input });
    if (channel === IPC.invoke.botList) return { ok: true, data: { bots } };
    if (channel === IPC.invoke.taskList) return { ok: true, data: { tasks } };
    if (channel === IPC.invoke.taskCardList) return { ok: true, data: { drafts: [] } };
    if (channel === IPC.invoke.pendingInteractive) {
      // One session's request can be read, the other's cannot: the fallback row
      // is the case where this screen has lost it.
      if (input?.sessionId === "task-3-session") {
        return { ok: false, error: { code: "NOT_FOUND", message: "no sidecar generation holds this" } };
      }
      return { ok: true, data: { asks: [{ requestId: "req-1", sessionId: "task-1-session",
        toolCallId: "call-1", turnId: "turn-1",
        questions: [{ question: "要保留旧的登录接口吗？", options: ["保留", "直接删掉"] }] }], permissions: [] } };
    }
    if (channel === IPC.invoke.askToolResolve) {
      tasks = tasks.map((task) => task.id === "task-1" ? { ...task, stage: "working", waiting: [] } : task);
      return { ok: true, data: { ok: true } };
    }
    if (channel === IPC.invoke.taskReassign) return { ok: true, data: { draft: { id: "draft-1", sessionId: "steward" }, task: tasks[1] } };
    if (channel === IPC.invoke.taskArchive) return { ok: true, data: { task: { ...tasks[1], archivedAt: "2026-11-13T01:00:00.000Z" }, archivedAt: "2026-11-13T01:00:00.000Z" } };
    if (channel === IPC.invoke.taskGet) return { ok: true, data: { task: tasks[1] } };
    if (channel === IPC.invoke.taskRestart) return { ok: true, data: { task: tasks[1] } };
    return { ok: true, data: undefined };
  },
};

useAppStore.setState({
  askDrafts: {},
  setAskDraft: () => undefined,
  resolveAsk: async () => {
    // The answer goes through the same path the task session uses: Main closes
    // the waiting record, and the surfaces repaint from tasksChanged.
    tasks = tasks.map((task) =>
      task.id === "task-1" ? { ...task, stage: "working", waiting: [] } : task,
    );
    emit(IPC.event.tasksChanged, { employeeSessionId: "router", taskId: "task-1", reason: "stage" });
    return { ok: true };
  },
  selectSession: async (sessionId) => {
    selected.push(sessionId);
    useAppStore.setState({ activeSessionId: sessionId });
  },
  sendPrompt: async (content, _draft, target) => {
    sent.push({ content, target });
    return true;
  },
});

const callsTo = (channel) => calls.filter((call) => call.channel === channel);
const settle = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function until(predicate, label) {
  for (let n = 0; n < 240; n += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("timed out waiting for " + label + " body=" + document.body.textContent);
}

function textOf(node) {
  return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function button(label) {
  return [...document.querySelectorAll("button")].find((node) => textOf(node) === label);
}

/** A button that exists and is not mid-action: the click would be refused. */
function ready(label) {
  const node = button(label);
  return node && !node.disabled ? node : undefined;
}

let mounted = null;
function mount(element) {
  if (mounted) {
    flushSync(() => mounted.unmount());
    mounted = null;
  }
  const container = document.getElementById("root");
  container.innerHTML = "";
  const rootNode = createRoot(container);
  mounted = rootNode;
  flushSync(() => rootNode.render(element));
  return rootNode;
}

window.waitingProbe = async () => {
  const report = { passed: false };

  // --- the steward's dock: an orange row per open question, a card per stuck task
  mount(React.createElement(StewardTaskDock, { sessionId: "steward" }));
  await until(() => document.querySelector("[data-task-waiting='task-1']"), "the waiting row");
  await until(() => document.querySelector("[data-task-blocked='task-2']"), "the blocked card");
  const row = document.querySelector("[data-task-waiting='task-1']");
  // The row appears as soon as the task list lands; whether it can be *answered*
  // here depends on a second read (pendingInteractive), which is a separate
  // round trip. Waiting for it is the assertion's own precondition — the row is
  // briefly in its "answer it in the task" fallback while that read is in flight.
  await until(
    () =>
      document.querySelector("[data-task-waiting='task-1']")
        ?.getAttribute("data-waiting-can-answer") === "true",
    "the readable request",
  );
  report.rowQuestion = textOf(row.querySelector(".task-waiting-question"));
  report.rowMeta = textOf(row.querySelector(".task-waiting-meta"));
  report.canAnswer = row.getAttribute("data-waiting-can-answer");
  report.blockedFields = [...document.querySelectorAll("[data-task-blocked='task-2'] dd")].map(textOf);
  report.blockedTitle = textOf(document.querySelector("[data-task-blocked='task-2'] .task-blocked-title"));
  // A request this screen cannot read keeps its row and says where to answer.
  const fallbackRow = document.querySelector("[data-task-waiting='task-3']");
  report.fallbackCanAnswer = fallbackRow?.getAttribute("data-waiting-can-answer");
  report.fallbackLabel = textOf(button("去任务里回答"));

  // --- answering in the dock resolves the same request the task would
  await until(() => ready("保留"), "the option button");
  flushSync(() => ready("保留").click());
  await until(() => callsTo(IPC.invoke.askToolResolve).length === 1, "askToolResolve");
  report.askResolution = callsTo(IPC.invoke.askToolResolve)[0].input;
  await until(() => document.querySelector("[data-waiting-answered='true']"), "the answered row");
  report.answeredLabel = textOf(document.querySelector("[data-waiting-answered='true'] .task-waiting-answered"));

  // --- the task session's own card: retry, reassign, drop, say something
  mount(React.createElement(TaskBlockedCardForSession, { sessionId: "task-2-session" }));
  await until(() => document.querySelector("[data-task-blocked='task-2']"), "the task's own card");
  report.sessionCardFields = [...document.querySelectorAll("[data-task-blocked='task-2'] dd")].map(textOf);
  flushSync(() => button("重试").click());
  await until(() => sent.length === 1, "the retry message");
  report.retry = sent[0];
  await until(() => ready("改派给…"), "the reassign button to be ready");

  flushSync(() => ready("改派给…").click());
  await until(() => callsTo(IPC.invoke.taskReassign).length === 1, "task.reassign");
  report.reassign = callsTo(IPC.invoke.taskReassign)[0].input;
  await until(() => document.querySelector("[data-blocked-reassigned]"), "the reassigned note");

  await until(() => ready("放弃"), "the drop button to be ready");
  flushSync(() => ready("放弃").click());
  await until(() => document.querySelector("[data-blocked-drop-confirm]"), "the drop confirmation");
  flushSync(() => document.querySelector("[data-blocked-drop-confirm]").click());
  await until(() => callsTo(IPC.invoke.taskArchive).length === 1, "task.archive");
  report.archive = callsTo(IPC.invoke.taskArchive)[0].input;

  await until(() => document.querySelector("[data-blocked-say]:not([disabled])"), "the say button");
  flushSync(() => document.querySelector("[data-blocked-say]").click());
  await until(() => selected.length === 1, "the task to be selected");
  report.selected = selected[0];

  // --- the sidebar: one number for every source, and the list it opens
  // The fixture is reset first, so the number does not depend on which actions
  // the steps above happened to perform.
  tasks = initialTasks.map((task) => ({ ...task }));
  mount(React.createElement(BotSidebarGroup, {
    activeSessionId: null,
    onOpenBot: () => {},
    onOpenTask: (task) => selected.push("task:" + task.sessionId),
    bots,
    tasks,
  }));
  await until(() => document.querySelector("[data-sidebar-waiting]"), "the waiting count");
  const count = document.querySelector("[data-sidebar-waiting]");
  report.waitingCount = count.getAttribute("data-sidebar-waiting");
  report.waitingLabel = textOf(count);
  report.employeeTone = document
    .querySelector("[data-sidebar-bot-row='router']")?.getAttribute("data-bot-status");
  flushSync(() => count.click());
  await until(() => document.querySelector("[data-testid='sidebar-waiting-list']"), "the waiting list");
  report.waitingRows = [...document.querySelectorAll("[data-sidebar-waiting-row]")].map(
    (node) => node.getAttribute("data-sidebar-waiting-row"),
  );
  flushSync(() => document.querySelector("[data-sidebar-waiting-row='task-2']").click());
  await settle();
  report.listOpenedTask = selected[selected.length - 1];

  flushSync(() => mounted.unmount());
  mounted = null;
  report.passed = true;
  return report;
};

/**
 * The same record, but arriving while the surfaces are already on screen.
 *
 * The probe above hands the dock a task that is *already* waiting. In the app the
 * question arrives mid-turn, so the dock, the sidebar count and the task's own
 * card all have to appear and then collapse from events — which is exactly what
 * was broken before task.waiting.open announced its task.
 */
window.waitingLiveProbe = async () => {
  const report = { passed: false };
  tasks = [
    { id: "task-1", employeeSessionId: "router", sessionId: "task-1-session",
      title: "修一下登录超时", origin: "steward", stage: "working",
      projectPath: "/repo/router", shortId: "task1",
      createdAt: "2026-11-13T00:00:00.000Z", workspaceStatus: "none", stageSeq: 2 },
  ];
  mount(React.createElement("div", null,
    React.createElement(BotSidebarGroup, {
      activeSessionId: "task-1-session",
      onOpenBot: () => {},
      onOpenTask: () => {},
    }),
    React.createElement(StewardTaskDock, { sessionId: "steward" }),
    React.createElement(AskToolCard, { request: {
      requestId: "req-1", sessionId: "task-1-session", toolCallId: "call-1", turnId: "turn-1",
      questions: [{ question: "要保留旧的登录接口吗？", options: ["保留", "直接删掉"] }],
    } }),
  ));
  await until(() => document.querySelector("[data-sidebar-bot-row='router']"), "the employee row");
  report.countBefore = document.querySelector("[data-sidebar-waiting]")?.getAttribute("data-sidebar-waiting") ?? "0";
  report.dockBefore = Boolean(document.querySelector("[data-task-waiting='task-1']"));

  // The runtime asks mid-turn: the host opens the record and announces the task.
  tasks = [{
    ...tasks[0], stage: "person/answer", stageSeq: 3,
    waiting: [{ requestId: "req-1", kind: "ask", question: "要保留旧的登录接口吗？",
      options: ["保留", "直接删掉"], openedAt: "2026-11-13T01:00:00.000Z" }],
  }];
  emit(IPC.event.tasksChanged, { employeeSessionId: "router", taskId: "task-1", reason: "waiting" });
  await until(() => document.querySelector("[data-task-waiting='task-1']"), "the live waiting row");
  await until(() => document.querySelector("[data-sidebar-waiting]"), "the live sidebar count");
  report.dockAfter = true;
  report.countAfter = document.querySelector("[data-sidebar-waiting]").getAttribute("data-sidebar-waiting");
  report.rowQuestion = textOf(document.querySelector("[data-task-waiting='task-1'] .task-waiting-question"));

  // Answering in the task session's own card closes it everywhere.
  await until(() => button("保留"), "the option in the task's card");
  flushSync(() => button("保留").click());
  await until(() => button("提交答案"), "the submit button");
  flushSync(() => button("提交答案").click());
  await until(() => !document.querySelector("[data-task-waiting='task-1']"), "the row to collapse");
  report.countAfterAnswer = document.querySelector("[data-sidebar-waiting]")
    ? document.querySelector("[data-sidebar-waiting]").getAttribute("data-sidebar-waiting")
    : "0";

  flushSync(() => mounted.unmount());
  mounted = null;
  report.passed = true;
  return report;
};
`;

const probeCache = new Map();

/** One Electron run per probe expression: each is a real window and real clicks. */
async function runProbe(expression, label) {
  if (probeCache.has(label)) return probeCache.get(label);
  const temp = await mkdtemp(join(tmpdir(), `pi-bot-waiting-${label}-`));
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
      join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>',
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("WAITING_PROBE " + JSON.stringify(await win.webContents.executeJavaScript(${JSON.stringify(expression)})));
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith("WAITING_PROBE "));
    assert.ok(line, output.slice(-6000));
    const report = JSON.parse(line.slice("WAITING_PROBE ".length));
    probeCache.set(label, report);
    return report;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const probe = () => runProbe("window.waitingProbe()", "waiting");
const liveProbe = () => runProbe("window.waitingLiveProbe()", "live");

const displayMissing = process.platform === "linux" && !process.env.DISPLAY;
const options = { skip: displayMissing ? "Electron requires a display" : false };

test(
  "waiting: the steward's dock shows the employee, the repository, the task and the question itself",
  options,
  async () => {
    const report = await probe();
    assert.equal(report.passed, true, JSON.stringify(report));
    assert.equal(report.rowQuestion, "要保留旧的登录接口吗？");
    assert.match(report.rowMeta, /Router 后端 · router · 修一下登录超时/);
    assert.equal(report.canAnswer, "true");
  },
);

test("waiting: a stuck task's card shows its own three fields, never a summary", options, async () => {
  const report = await probe();
  assert.deepEqual(report.blockedFields, [
    "迁移脚本要先在测试库上跑一遍",
    "本地跑过一次，缺 staging 权限",
    "给我一份 staging 只读账号",
  ]);
  assert.deepEqual(report.sessionCardFields, report.blockedFields);
  assert.equal(report.blockedTitle, "Router 后端 卡住了");
});

test("waiting: answering in the dock resolves the same request, and the row collapses", options, async () => {
  const report = await probe();
  assert.deepEqual(report.askResolution, {
    requestId: "req-1",
    sessionId: "task-1-session",
    answers: [["保留"]],
  });
  assert.equal(report.answeredLabel, "已回复");
});

test("waiting: a request this screen cannot read keeps its row and says where to answer", options, async () => {
  const report = await probe();
  assert.equal(report.fallbackCanAnswer, "false");
  assert.equal(report.fallbackLabel, "去任务里回答");
});

test("blocked: retry sends one fixed message, reassign asks for a new card, drop asks twice", options, async () => {
  const report = await probe();
  assert.deepEqual(report.retry, { content: "再试一次。", target: "task-2-session" });
  assert.equal(report.reassign.taskId, "task-2");
  assert.equal(report.reassign.reason, "从任务 #task2 改派");
  assert.equal(report.reassign.stewardSessionId, "steward");
  assert.deepEqual(report.archive, { taskId: "task-2", discard: true });
  assert.equal(report.selected, "task-2-session");
});

test("sidebar: one number for every source, and every row in its list goes somewhere", options, async () => {
  const report = await probe();
  // Two tasks wait on the person (a question and a stuck card); the working one
  // does not count, and no card is pending in this fixture.
  assert.equal(report.waitingCount, "3");
  assert.equal(report.waitingLabel, "等你 3 件");
  assert.equal(report.employeeTone, "attention");
  assert.deepEqual(report.waitingRows.sort(), ["task-1", "task-2", "task-3"]);
  assert.equal(report.listOpenedTask, "task:task-2-session");
});
test("waiting: a question that arrives mid-turn appears and collapses without a reload", options, async () => {
  const report = await liveProbe();
  assert.equal(report.passed, true);
  assert.equal(report.dockBefore, false, "nothing waits before the question");
  assert.equal(report.countBefore, "0");
  assert.equal(report.dockAfter, true, "the dock row appears on tasksChanged");
  assert.equal(report.countAfter, "1");
  assert.equal(report.rowQuestion, "要保留旧的登录接口吗？");
  assert.equal(report.countAfterAnswer, "0", "answering in the task collapses every surface");
});
