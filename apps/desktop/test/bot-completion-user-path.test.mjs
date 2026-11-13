import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * The completion card, end to end through real clicks (employee mode 0.5 slice
 * 4b), plus the seven pictures the design asks for.
 *
 * The renderer is the real one — the same components, the same stylesheet
 * compiled from `globals.css` — driven through the same IPC bridge shape the
 * preload exposes. The host is scripted, because this test is about what the
 * person sees and what the renderer does with the answer, not about git; the
 * merge itself is proven against real repositories in host-core.
 */

const root = repositoryRoot();
const { build: bundle } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const artifactRoot = join(root, ".artifacts", "bot-completion");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { ConversationTopbar } from "../../apps/desktop/src/components/ConversationTopbar";
import { Composer } from "../../apps/desktop/src/components/Composer";
import {
  StewardTaskDock,
  TaskCompletionCardForSession,
  TaskBlockedCardForSession,
} from "../../apps/desktop/src/features/bots/TaskWaitingDock";
import { BotSidebarGroup } from "../../apps/desktop/src/features/bots/BotSidebarGroup";
import { sortBots } from "../../apps/desktop/src/features/bots/bot-status";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({ lng: "zh-CN", keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } },
  interpolation: { escapeValue: false } });

const steward = {
  sessionId: "steward", title: "Super Agent",
  profile: { name: "Super Agent", definition: "steward", permissionMode: "ask", mustAsk: [], observe: false },
  status: { kind: "idle" }, projectPath: "/repo/Minih-Agent-Desktop",
  updatedAt: "2026-11-13T02:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z",
};
const router = {
  sessionId: "router", title: "Router 后端",
  profile: { name: "Router 后端", permissionMode: "accept-edits", mustAsk: [], observe: false },
  status: { kind: "busy", stage: "working" }, projectPath: "/repo/Minih-Router",
  updatedAt: "2026-11-13T02:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z",
};
const desk = {
  sessionId: "desk", title: "Desktop 前端",
  profile: { name: "Desktop 前端", permissionMode: "accept-edits", mustAsk: [], observe: false },
  status: { kind: "stage", stage: "blocked" }, projectPath: "/repo/Minih-Agent-Desktop",
  updatedAt: "2026-11-13T02:00:00.000Z", createdAt: "2026-11-02T00:00:00.000Z",
};

const result = {
  status: "ready",
  summary: "登录超时改成 30s，重试复用同一个 token。",
  acceptance: [
    { criterion: "有能复现的失败用例", met: true },
    { criterion: "超时可配置", met: false, note: "留到下一片" },
  ],
  leftovers: ["文档页还写着 10s"],
  reportedAt: "2026-11-13T03:00:00.000Z",
};

function task(overrides) {
  return Object.assign({
    id: "task-done", employeeSessionId: "router", sessionId: "sess-done",
    title: "修一下登录超时", origin: "direct", stage: "person/accept",
    projectPath: "/repo/Minih-Agent-Desktop", shortId: "a1b2c3",
    createdAt: "2026-11-13T01:00:00.000Z", workspaceStatus: "ready",
    deliveryMode: "pr", workspaceBranch: "fix/login-timeout",
    result,
  }, overrides || {});
}

const done = task({});
const accepted = task({
  id: "task-accepted", sessionId: "sess-accepted", shortId: "d4e5f6",
  acceptedAt: "2026-11-13T03:10:00.000Z",
});
const refused = task({
  id: "task-refused", sessionId: "sess-refused", shortId: "112233",
});
const deliveryBlocked = task({
  id: "task-delivery", sessionId: "sess-delivery", shortId: "778899",
  stage: "blocked", deliveryMode: "pr",
  result: undefined,
  blocker: { reason: "delivery", step: "push-remotes", detail: "gitea: 拒绝推送" },
  delivery: { mode: "pr", steps: [
    { name: "read-pr", status: "done", at: "2026-11-13T03:00:00.000Z" },
    { name: "push-main", status: "done", at: "2026-11-13T03:00:10.000Z" },
    { name: "push-remotes", status: "failed", at: "2026-11-13T03:00:20.000Z" },
  ] },
});
function batchTask(index) {
  return task({
    id: "task-batch-" + index, sessionId: "sess-batch-" + index,
    shortId: "b0" + index + "000", origin: "steward", title: "依赖对齐 " + index,
    batchId: "turn-42", createdAt: "2026-11-13T0" + index + ":00:00.000Z",
    employeeSessionId: index === 2 ? "desk" : "router",
  });
}
const batch = [batchTask(1), batchTask(2), batchTask(3)];
function manyTask(index) {
  return task({
    id: "task-many-" + index, sessionId: "sess-many-" + index, shortId: "c0" + index + "000",
    origin: "steward", stage: "person/answer", title: "等你回答第 " + index + " 件",
    result: undefined,
    waiting: [{ requestId: "req-" + index, kind: "ask",
      question: "要保留旧的登录接口吗？", options: ["保留", "删掉"],
      openedAt: "2026-11-13T0" + index + ":30:00.000Z" }],
  });
}
const many = [1, 2, 3, 4, 5, 6, 7, 8].map(manyTask);

const checks = {
  "task-done": { canMerge: true, prUrl: "https://github.com/minih-git/minih-agent-desktop/pull/255",
    checks: { total: 6, passed: 6, pending: 0, failed: [] },
    changes: { commits: [
      { sha: "8450f4b0", subject: "fix(bot): 启动时不读任务列表" },
      { sha: "36f8c472", subject: "feat(bot): 员工交付 ready 报告" },
    ], files: 12, truncated: false },
    elapsedMs: 3 * 3600_000 + 24 * 60_000,
    usage: { inputTokens: 128000, outputTokens: 32000, turns: 6, costUsd: 0.42 } },
  "task-accepted": { canMerge: true, prUrl: "https://github.com/minih-git/minih-agent-desktop/pull/256",
    checks: { total: 4, passed: 4, pending: 0, failed: [] },
    changes: { commits: [], files: 3, truncated: false }, elapsedMs: 40 * 60_000,
    usage: { inputTokens: 1000, outputTokens: 500, turns: 2 } },
  "task-refused": { canMerge: false, reason: "ci-running", reasonDetail: "2",
    checks: { total: 6, passed: 4, pending: 2, failed: [] },
    changes: { commits: [{ sha: "abcdef12", subject: "wip" }], files: 1, truncated: false },
    elapsedMs: 10 * 60_000 },
  "task-batch-1": { canMerge: true, changes: { commits: [], files: 2, truncated: false }, elapsedMs: 300_000 },
  "task-batch-2": { canMerge: true, changes: { commits: [], files: 1, truncated: false }, elapsedMs: 300_000 },
  "task-batch-3": { canMerge: true, changes: { commits: [], files: 1, truncated: false }, elapsedMs: 300_000 },
};

const state = {
  tasks: [],
  checkCalls: [],
  accepted: [],
  merges: [],
  sent: [],
};

window.minihAgent = {
  platform: "darwin",
  on: () => () => undefined,
  async invoke(channel, input) {
    if (channel === IPC.invoke.botList) return { ok: true, data: { bots: [router, desk, steward] } };
    if (channel === IPC.invoke.taskList) return { ok: true, data: { tasks: state.tasks } };
    if (channel === IPC.invoke.taskCardList) return { ok: true, data: { drafts: [] } };
    if (channel === IPC.invoke.pendingInteractive) return { ok: true, data: { asks: [], permissions: [] } };
    if (channel === IPC.invoke.taskDeliveryCheck) {
      state.checkCalls.push(input.taskId);
      return { ok: true, data: checks[input.taskId] || { canMerge: false, reason: "pr-missing" } };
    }
    if (channel === IPC.invoke.taskAccept) {
      state.accepted.push(input.taskId);
      state.tasks = state.tasks.map((entry) =>
        entry.id === input.taskId ? { ...entry, acceptedAt: "2026-11-13T04:00:00.000Z" } : entry);
      return { ok: true, data: { task: state.tasks.find((entry) => entry.id === input.taskId) } };
    }
    if (channel === IPC.invoke.taskDeliveryMerge) {
      state.merges.push(input.taskId);
      if (input.taskId === "task-batch-2") {
        state.tasks = state.tasks.map((entry) => entry.id === input.taskId
          ? { ...entry, stage: "blocked",
              blocker: { reason: "delivery", step: "push-remotes", detail: "gitea: 拒绝推送" } }
          : entry);
        return { ok: true, data: { merged: false, failedStep: "push-remotes",
          detail: "gitea: 拒绝推送", published: true } };
      }
      state.tasks = state.tasks.map((entry) => entry.id === input.taskId ? { ...entry, archivedAt: "2026-11-13T04:05:00.000Z" } : entry);
      return { ok: true, data: { merged: true, published: true } };
    }
    return { ok: true, data: undefined };
  },
};

const sessions = [
  { id: "steward", title: "Super Agent", role: "bot", projectPath: "/repo/Minih-Agent-Desktop",
    botProfile: steward.profile, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-13T02:00:00.000Z" },
];

function store() {
  useAppStore.setState({
    sessions,
    activeSessionId: "sess-done",
    selectSession: async () => undefined,
    sendPrompt: async (text, _attachments, sessionId) => {
      state.sent.push({ text, sessionId });
      return true;
    },
    resolveAsk: async () => ({ ok: true }),
    setAskDraft: () => undefined,
    askDrafts: {},
    showToast: () => undefined,
    steerPrompt: async () => true,
    removeQueuedPrompt: () => undefined,
    moveQueuedPrompt: () => undefined,
    editQueuedPrompt: () => undefined,
    sendQueuedNow: async () => true,
    abort: async () => undefined,
    isRunning: false,
    queuedPrompts: [],
    pendingAsks: [],
    pendingPermissions: [],
    plugins: [],
    projectMeta: {},
    workspace: { path: "/repo/Minih-Agent-Desktop", name: "Minih-Agent-Desktop" },
    setPage: () => undefined,
    openWorkPanelTab: () => undefined,
    activeWorkPanelTabId: null,
    settings: {},
    renameSession: async () => undefined,
    bootstrap: async () => undefined,
    refreshSessions: async () => undefined,
    prefetchSession: async () => undefined,
    planningStates: {},
    navStack: [],
    navIndex: 0,
    navBack: () => undefined,
  });
}
store();

const noop = () => undefined;
let lastError = null;
window.addEventListener("error", (event) => {
  lastError = String((event.error && (event.error.stack || event.error.message)) || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  lastError = String(event.reason && event.reason.message ? event.reason.message : event.reason);
});

const frame = () => new Promise(requestAnimationFrame);
async function settle(count) { for (let n = 0; n < (count || 3); n += 1) await frame(); }
async function until(predicate, label) {
  for (let n = 0; n < 400; n += 1) {
    const value = predicate();
    if (value) return value;
    await frame();
  }
  throw new Error("timed out waiting for " + label + ": " + document.body.textContent + " | lastError=" + lastError);
}
function finishAnimations() {
  for (const animation of document.getAnimations()) {
    const timing = animation.effect && animation.effect.getTiming ? animation.effect.getTiming() : null;
    if (timing && timing.iterations === Infinity) continue;
    try { animation.finish(); } catch { /* idle or infinite */ }
  }
}
function click(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error("no element for " + selector + " in " + document.body.innerHTML.slice(0, 400));
  flushSync(() => node.click());
}

function shell(options) {
  useAppStore.setState({ activeSessionId: options.sessionId });
  return React.createElement("div", { className: "app-shell" },
    React.createElement("aside", { className: "sidebar sidebar-surface" },
      React.createElement("div", { className: "shot-sidebar-body" },
        React.createElement(BotSidebarGroup, {
          activeSessionId: options.sessionId, onOpenBot: noop, onOpenTask: noop,
        }))),
    React.createElement("section", { className: "main-pane" },
      React.createElement(ConversationTopbar, {
        sidebarCollapsed: false, workPanelOpen: false,
        onToggleSidebar: noop, onNewTask: noop, onOpenSearch: noop,
      }),
      React.createElement("div", { className: "route-surface route-page shot-stack" },
        React.createElement("div", { className: "shot-turn" },
          React.createElement("p", { className: "shot-user" }, options.user),
          React.createElement("p", { className: "shot-steward" }, options.answer)),
        React.createElement("div", { className: "shot-spacer" })),
      options.dock
        ? React.createElement("div", { className: "composer-dock composer-dock-docked" },
            React.createElement("div", { className: "composer-stack" }, options.dock))
        : React.createElement(Composer, { variant: "docked" })));
}

let rootNode = null;
function mount(element) {
  const container = document.getElementById("root");
  if (rootNode) { flushSync(() => rootNode.unmount()); rootNode = null; }
  container.innerHTML = "";
  rootNode = createRoot(container);
  flushSync(() => rootNode.render(element));
}

async function scene(kind) {
  if (kind === "card") {
    state.tasks = [done];
    mount(shell({ sessionId: "sess-done", user: "登录超时今天修掉。",
      answer: "改完了，超时和重试都动了。",
      dock: React.createElement(TaskCompletionCardForSession, { sessionId: "sess-done" }) }));
    await until(() => document.querySelector("[data-task-completion]"), "the completion card");
    await until(() => document.querySelector("[data-completion-can-merge='true']"), "a mergeable card");
    return;
  }
  if (kind === "card-refused") {
    state.tasks = [refused];
    mount(shell({ sessionId: "sess-refused", user: "登录超时今天修掉。",
      answer: "改完了，CI 还在跑。",
      dock: React.createElement(TaskCompletionCardForSession, { sessionId: "sess-refused" }) }));
    await until(() => document.querySelector("[data-completion-reason='ci-running']"), "the greyed card");
    await until(() => document.body.textContent.indexOf("CI 还在跑") >= 0, "the reason's words");
    return;
  }
  if (kind === "card-accepted") {
    state.tasks = [accepted];
    mount(shell({ sessionId: "sess-accepted", user: "登录超时今天修掉。",
      answer: "改完了，先收下。",
      dock: React.createElement(TaskCompletionCardForSession, { sessionId: "sess-accepted" }) }));
    await until(() => document.querySelector("[data-completion-accepted='true']"), "the accepted card");
    await until(() => document.body.textContent.indexOf("已接受，待合并") >= 0, "the accepted note");
    return;
  }
  if (kind === "blocked-delivery") {
    state.tasks = [deliveryBlocked];
    mount(shell({ sessionId: "sess-delivery", user: "登录超时今天修掉。",
      answer: "合到一半，Gitea 那边被拒了。",
      dock: React.createElement(TaskBlockedCardForSession, { sessionId: "sess-delivery" }) }));
    await until(() => document.querySelector("[data-blocked-delivery='push-remotes']"), "the delivery card");
    await until(() => document.body.textContent.indexOf("拒绝推送") >= 0, "the remote's own words");
    return;
  }
  if (kind === "batch") {
    state.tasks = batch.slice();
    mount(shell({ sessionId: "steward", user: "三个仓库的依赖对齐一下。",
      answer: "拆成三张卡派出去了，都回来了。" }));
    await until(() => document.querySelector("[data-task-batch]"), "the batch summary");
    await until(() => document.querySelectorAll("[data-batch-row]").length === 3, "three rows");
    return;
  }
  if (kind === "dock-many") {
    state.tasks = many.slice();
    mount(shell({ sessionId: "steward", user: "这几件事都看一下。", answer: "都派下去了。" }));
    const dock = await until(() => document.querySelector("[data-testid='task-waiting-dock']"), "the dock");
    await settle(3);
    const style = window.getComputedStyle(dock);
    const limit = Math.round(window.innerHeight * 0.5);
    const height = Math.round(dock.getBoundingClientRect().height);
    if (dock.scrollHeight <= dock.clientHeight) throw new Error("the dock did not overflow");
    if (height > limit + 2) throw new Error("the dock is " + height + "px, over the " + limit + "px ceiling");
    if (style.overflowY !== "auto") throw new Error("the dock does not scroll internally: " + style.overflowY);
    return;
  }
  if (kind === "sidebar") {
    state.tasks = many.slice(0, 2);
    // The regression this scene protects: the steward is idle while one employee
    // is busy and another is blocked, so ordering everyone by tone alone put her
    // last — below the employees she dispatches to.
    const ordered = sortBots([router, desk, steward]).map((bot) => bot.sessionId);
    if (ordered[0] !== "steward") throw new Error("sortBots put her last: " + ordered.join(","));
    if (ordered.length !== 3) throw new Error("sortBots dropped a row: " + ordered.join(","));
    mount(React.createElement("div", { className: "shot-sidebar" },
      React.createElement(BotSidebarGroup, {
        activeSessionId: "steward", onOpenBot: noop, onOpenTask: noop,
        // useBots hands the group the sorted roster, so the scene does too.
        bots: sortBots([router, desk, steward]), tasks: state.tasks,
      })));
    const first = await until(() => document.querySelector("[data-sidebar-bot-entry]"), "the bot rows");
    const rows = Array.from(document.querySelectorAll("[data-sidebar-bot-entry]")).map((node) => node.getAttribute("data-sidebar-bot-entry"));
    if (rows[0] !== "steward") throw new Error("the steward is not first: " + rows.join(","));
    void first;
    return;
  }
  throw new Error("unknown scene " + kind);
}

window.shot = {
  async render(kind, theme) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.platform = "darwin";
    try {
      await scene(kind);
      await settle(4);
      finishAnimations();
      await settle(2);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  },

  /**
   * The clicks. Each one is a real DOM click on the shipped button, and the
   * assertion is on what the renderer then asked the host to do.
   */
  async act(name) {
    try {
      if (name === "refresh") {
        state.tasks = [refused];
        await scene("card-refused");
        const before = state.checkCalls.length;
        click("[data-completion-refresh]");
        for (let n = 0; n < 200 && state.checkCalls.length === before; n += 1) await frame();
        if (state.checkCalls.length !== before + 1) throw new Error("refresh did not ask the host again");
        return { ok: true, detail: state.checkCalls.length };
      }
      if (name === "accept") {
        state.tasks = [task({})];
        state.accepted = [];
        await scene("card");
        const before = document.querySelector("[data-sidebar-waiting]");
        const beforeCount = before ? Number(before.getAttribute("data-sidebar-waiting")) : 0;
        click("[data-completion-accept]");
        await until(() => document.querySelector("[data-completion-accepted='true']"), "the accepted state");
        await settle(3);
        // The sidebar re-reads on the host's task event; the stub emits none, so
        // the scene is mounted again — the same read, at the same point.
        mount(shell({ sessionId: "sess-done", user: "登录超时今天修掉。",
          answer: "改完了，先收下。",
          dock: React.createElement(TaskCompletionCardForSession, { sessionId: "sess-done" }) }));
        await until(() => document.querySelector("[data-task-completion]"), "the re-read card");
        await settle(2);
        const after = document.querySelector("[data-sidebar-waiting]");
        const afterCount = after ? Number(after.getAttribute("data-sidebar-waiting")) : 0;
        if (state.accepted[0] !== "task-done") throw new Error("the host was not asked to accept");
        if (afterCount !== beforeCount - 1) {
          throw new Error("the count went " + beforeCount + " -> " + afterCount);
        }
        return { ok: true, detail: beforeCount + "->" + afterCount };
      }
      if (name === "reject" || name === "append") {
        state.tasks = [done];
        state.sent = [];
        await scene("card");
        click(name === "reject" ? "[data-completion-reject]" : "[data-completion-append]");
        const input = await until(() => document.querySelector("[data-completion-input='" + name + "']"), "the writer");
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
        flushSync(() => setter.call(input, name === "reject" ? "超时改成 30s 就行" : "顺手把文档也改了"));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await frame();
        click("[data-completion-send='" + name + "']");
        await until(() => state.sent.length > 0, "the message");
        const sent = state.sent[0];
        if (name === "reject") {
          if (sent.sessionId !== "sess-done") throw new Error("reject went to " + sent.sessionId);
          if (sent.text.indexOf("30s") < 0) throw new Error("the words were lost: " + sent.text);
        } else {
          if (sent.sessionId !== "steward") throw new Error("append went to " + sent.sessionId);
          if (sent.text.indexOf("task-done") < 0) throw new Error("no taskId in " + sent.text);
          if (sent.text.indexOf("文档") < 0) throw new Error("the words were lost: " + sent.text);
        }
        return { ok: true, detail: sent.sessionId };
      }
      if (name === "batch-accept-all") {
        state.tasks = batch.slice(0, 3);
        state.merges = [];
        state.accepted = [];
        await scene("batch");
        click("[data-batch-accept-all]");
        await until(() => state.merges.length > 0, "the first merge");
        await settle(6);
        if (state.merges.join(",") !== "task-batch-1,task-batch-2") {
          throw new Error("the batch did not stop at the failure: " + state.merges.join(","));
        }
        // The summary dissolves as soon as one task stops being finished — that
        // task is a blocked task now — so the proof is the blocked card it left
        // behind, plus the third task never being touched.
        const blocked = await until(
          () => document.querySelector("[data-blocked-delivery='push-remotes']"),
          "the blocked card the failure left",
        );
        void blocked;
        if (state.merges.indexOf("task-batch-3") >= 0) {
          throw new Error("the batch continued past the failure: " + state.merges.join(","));
        }
        return { ok: true, detail: state.merges.join(",") };
      }
      if (name === "reject-writer") {
        state.tasks = [done];
        await scene("card");
        click("[data-completion-reject]");
        await until(() => document.querySelector("[data-completion-input='reject']"), "the writer");
        await settle(2);
        finishAnimations();
        return { ok: true };
      }
      throw new Error("unknown action " + name);
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  },
};
`;

async function compileStylesheet(workDir) {
  const { build: viteBuild } = await import("vite");
  const { default: tailwindcss } = await import("@tailwindcss/vite");
  const appDir = join(root, "apps/desktop");
  const entry = join(workDir, "style-entry.js");
  const outDir = join(workDir, "styles");
  await writeFile(entry, `import ${JSON.stringify(join(appDir, "src/styles/globals.css"))};\n`);
  await viteBuild({
    configFile: false,
    root: appDir,
    logLevel: "error",
    plugins: [tailwindcss()],
    build: {
      outDir,
      emptyOutDir: true,
      cssCodeSplit: false,
      rollupOptions: { input: entry, output: { entryFileNames: "style-entry.js", assetFileNames: "styles[extname]" } },
    },
  });
  const files = await readdir(outDir);
  const stylesheet = files.find((name) => name.endsWith(".css"));
  assert.ok(stylesheet, "the stylesheet did not compile");
  return join(outDir, stylesheet);
}

const harnessCss = `
  html, body, #root { height: 100%; margin: 0; }
  body { background: var(--ds-bg-primary); color: var(--ds-text-primary); }
  #root { padding: 24px; box-sizing: border-box; }
  .shot-surface { display: flex; flex-direction: column; gap: 16px; }
  .shot-topbar > * { position: static; }
  .shot-sidebar { width: 300px; }
`;

test(
  "completion: the seven screens, dark and light, at 1440 and 1024",
  { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false, timeout: 300_000 },
  async () => {
    await mkdir(artifactRoot, { recursive: true });
    const workDir = await mkdtemp(join(tmpdir(), "pi-bot-completion-shot-"));
    const workletStub = join(workDir, "pcm-worklet-stub.js");
    await writeFile(workletStub, 'export default "";\n');
    await bundle({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(workDir, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env": '{"NODE_ENV":"production","DEV":false}',
        "import.meta.env": '{"DEV":false,"PROD":true,"MODE":"production"}',
      },
      plugins: [{
        name: "vite-url-import-stub",
        setup(build) { build.onResolve({ filter: /\?url$/ }, () => ({ path: workletStub })); },
      }],
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
    const stylesheet = await compileStylesheet(workDir);
    await writeFile(
      join(workDir, "index.html"),
      `<!doctype html><meta charset="utf-8"><style>${harnessCss}</style>
       <link rel="stylesheet" href="${stylesheet}">
       <div id="root"></div><script type="module" src="renderer.js"></script>`,
    );

    const scenes = ["card", "card-refused", "card-accepted", "blocked-delivery", "batch", "dock-many", "sidebar"];
    const plan = [];
    for (const theme of ["dark", "light"]) {
      for (const width of [1440, 1024]) {
        for (const scene of scenes) plan.push({ kind: "shot", theme, width, scene });
      }
    }
    const actions = ["refresh", "accept", "reject", "append", "batch-accept-all", "reject-writer"];
    for (const name of actions) plan.push({ kind: "act", name });

    await writeFile(
      join(workDir, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
const plan = ${JSON.stringify(plan)};
const outDir = ${JSON.stringify(artifactRoot)};
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  let failure = null;
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    win.setContentSize(1440, 900);
    await win.webContents.executeJavaScript(
      "new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const tick = () => { if (window.shot) return resolve(true); if (Date.now() > deadline) return reject(new Error('renderer never loaded')); setTimeout(tick, 50); }; tick(); })",
    );
    for (const entry of plan) {
      if (entry.kind === "shot") {
        win.setContentSize(entry.width, 900);
        const rendered = await win.webContents.executeJavaScript("window.shot.render(" + JSON.stringify(entry.scene) + "," + JSON.stringify(entry.theme) + ")");
        if (!rendered || rendered.ok !== true) throw new Error("scene " + entry.scene + " did not render: " + JSON.stringify(rendered));
        await new Promise((resolve) => setTimeout(resolve, 150));
        const image = await win.webContents.capturePage();
        require("node:fs").writeFileSync(path.join(outDir, entry.scene + "-" + entry.theme + "-" + entry.width + ".png"), image.toPNG());
      } else {
        win.setContentSize(1440, 900);
        const result = await win.webContents.executeJavaScript("window.shot.act(" + JSON.stringify(entry.name) + ")");
        if (!result || result.ok !== true) throw new Error("action " + entry.name + " failed: " + JSON.stringify(result));
      }
    }
  } catch (error) {
    failure = error;
  }
  if (failure) { console.error("FAIL", failure && failure.stack ? failure.stack : failure); app.exit(1); return; }
  app.exit(0);
});
`,
    );

    const child = spawnProcess(resolveElectronBinary(root).electronBinary, [join(workDir, "main.cjs")]);
    const code = await child;
    assert.equal(code, 0, "the completion-card run failed; see stderr above");
    for (const scene of scenes) {
      for (const theme of ["dark", "light"]) {
        for (const width of [1440, 1024]) {
          assert.ok(
            readFileSync(join(artifactRoot, `${scene}-${theme}-${width}.png`)).length > 1000,
            `${scene} ${theme} ${width} was not captured`,
          );
        }
      }
    }
  },
);

/** Run one Electron child and resolve with its exit code, forwarding its output. */
function spawnProcess(binary, args) {
  const { spawn } = createRequire(import.meta.url)("node:child_process");
  const child = spawn(binary, args, { stdio: ["ignore", "inherit", "inherit"], env: process.env });
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
}

test("completion: the task session's rules name the tool and the ship-first order", () => {
  const source = readFileSync(join(root, "apps/desktop/electron/main/services/task-status.ts"), "utf8");
  assert.match(source, /status: \\"ready\\"/, "the briefing does not name the ready report");
  assert.match(source, /one acceptance entry per criterion/, "the briefing does not ask for the criteria");
  assert.match(source, /pushes its branch and opens the PR first/, "the briefing does not ship before reporting");
});
