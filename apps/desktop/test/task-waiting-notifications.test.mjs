/**
 * The waiting channel's notifications (employee mode 0.5 slice 4a).
 *
 * Two things have to be true and neither is visible in a screenshot:
 *
 * - a question or permission asked **in a task's own session** is announced as
 *   "<employee> · <task> 在等你", with the question (or the tool and its reason)
 *   as the body — not as a generic "a question needs your answer";
 * - a task whose stage became `blocked` or `failed` is announced once per
 *   `stage_seq` as "<employee> 卡住了：<where>", and a task the person stopped
 *   themselves is announced by nobody.
 *
 * The modules under test are the production ones; `lib/api` is stubbed at the one
 * seam this feature uses (the host reads and the native-notification IPC), which
 * is also where the click target comes from: the notification carries the task
 * session's id, and Main's `notificationActivated` selects exactly that session.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";

function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return module.exports;
}

/**
 * The zh-CN copy these cases read, spelled out.
 *
 * The catalogs themselves are guarded by `packages/i18n` (every locale carries
 * every key); this list only pins the words the assertions are about, so a
 * wording change here is a deliberate decision rather than a silent one.
 */
const COPY = {
  "notifications.taskWaitingTitle": "{{employee}} · {{task}} 在等你",
  "notifications.permissionBodyWithReason": "运行 {{toolName}} 需要你同意：{{reason}}",
  "notifications.permissionTitle": "{{sessionTitle}} 需要工具授权",
  "notifications.permissionBody": "运行 {{toolName}} 需要你的同意。",
  "notifications.askTitle": "需要回答一个问题",
  "notifications.askBodyFallback": "这个任务需要你的回答才能继续。",
  "notifications.taskStuckTitle": "{{employee}} 卡住了",
  "notifications.taskStuckInterrupted": "应用重启时这项任务正在运行",
  "notifications.failedBody": "回合失败了。",
  "notifications.failedBodyWithCode": "回合以错误 {{code}} 结束。",
  "bots.card.targetUnknown": "还没有员工",
  "chat.untitledTask": "未命名任务",
};

const translate = (key, options = {}) =>
  (COPY[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ""));
/** What `notification-runtime` sees as the translation module. */
const i18nStub = { t: translate };
/** A transpiled default import reads `module.default`. */
const i18nextModule = { default: i18nStub };

const EMPLOYEE = {
  sessionId: "employee-1",
  title: "Router 后端",
  profile: { name: "Router 后端", permissionMode: "accept-edits", mustAsk: [], observe: false },
};

function task(overrides = {}) {
  return {
    id: "task-1",
    employeeSessionId: "employee-1",
    sessionId: "task-session-1",
    title: "修一下登录超时",
    origin: "steward",
    stage: "blocked",
    shortId: "task-1",
    createdAt: "2026-11-13T00:00:00.000Z",
    workspaceStatus: "none",
    stageSeq: 3,
    ...overrides,
  };
}

/** The api seam: host reads and the native-notification IPC. */
function apiStub(tasks, employees = [EMPLOYEE]) {
  const listeners = { tasks: [], bots: [] };
  const native = [];
  return {
    native,
    listeners,
    module: {
      api: {
        listTasks: async () => ({ tasks }),
        listBots: async () => ({ bots: employees }),
        onTasksChanged: (listener) => {
          listeners.tasks.push(listener);
          return () => listeners.tasks.splice(listeners.tasks.indexOf(listener), 1);
        },
        onBotsChanged: (listener) => {
          listeners.bots.push(listener);
          return () => listeners.bots.splice(listeners.bots.indexOf(listener), 1);
        },
        showNativeNotification: async (input) => {
          native.push(input);
          return { shown: true };
        },
        recordPromptNotification: async () => ({ ok: true }),
      },
    },
  };
}

function runtimeFor(api) {
  return load("../src/stores/runtime/task-waiting-runtime.ts", { "../../lib/api": api });
}

const toasts = [];
const showToast = (message, options) => toasts.push({ message, options });

test("a task session's question is announced as the employee and the task", async () => {
  const api = apiStub([
    task({ stage: "person/answer", stageSeq: 3, waiting: [{ requestId: "req-1" }] }),
  ]);
  const runtime = runtimeFor(api.module);
  runtime.startTaskWaitingRuntime({
    translate,
    showToast,
    notifyNative: api.module.api.showNativeNotification,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const notification = load("../src/stores/runtime/notification-runtime.ts", {
    i18next: i18nextModule,
    "./task-waiting-runtime": runtime,
    "../../lib/api": api.module,
    "../../lib/notification-sound": { playNotificationChime: () => undefined },
  });
  toasts.length = 0;
  const notify = notification.createInteractivePromptNotifier(() => ({
    sessions: [{ id: "task-session-1", title: "修一下登录超时", role: "task" }],
    showToast: (message, options) => toasts.push({ message, options }),
  }));

  notify("task-session-1", "ask", { question: "要保留旧的登录接口吗？", requestId: "req-1" });
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /^Router 后端 · 修一下登录超时 在等你: 要保留旧的登录接口吗？$/);
  assert.equal(toasts[0].options.sessionId, "task-session-1");

  notify("task-session-1", "permission", {
    toolName: "Bash",
    reason: "needs to run the test suite",
    requestId: "perm-1",
  });
  assert.equal(toasts.length, 2);
  assert.match(toasts[1].message, /Router 后端 · 修一下登录超时 在等你: 运行 Bash 需要你同意/);

  // An ordinary conversation keeps its old wording: nothing invented.
  toasts.length = 0;
  notify("chat-1", "ask", { question: "Which branch?" });
  assert.equal(toasts[0].message, "需要回答一个问题: Which branch?");
});

test("a stuck task is announced once per stage, with where it stopped", async () => {
  toasts.length = 0;
  const api = apiStub([
    task({ blocker: { status: "blocked", where: "迁移脚本要先在测试库上跑一遍" } }),
  ]);
  const runtime = runtimeFor(api.module);
  runtime.resetTaskWaitingRuntimeForTest();
  runtime.startTaskWaitingRuntime({
    translate,
    showToast,
    notifyNative: api.module.api.showNativeNotification,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].message, "Router 后端 卡住了: 迁移脚本要先在测试库上跑一遍");
  assert.equal(toasts[0].options.duration, 0, "a pinned reminder, not a toast that expires");
  assert.equal(toasts[0].options.sessionId, "task-session-1", "the click target is the task");
  assert.equal(api.native.length, 1);
  assert.equal(api.native[0].id, "task-1:3", "one native notification per stage_seq");
  assert.equal(api.native[0].title, "Router 后端 卡住了");
  assert.equal(api.native[0].body, "迁移脚本要先在测试库上跑一遍");

  // The same stage arriving again (a re-read, a second event) says nothing.
  for (const listener of api.listeners.tasks) listener({ reason: "stage" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(toasts.length, 1);
  assert.equal(api.native.length, 1);
});

test("a task the person stopped is not announced, and a new stage is", async () => {
  toasts.length = 0;
  const stopped = task({ stage: "blocked", stageSeq: 4, blocker: { reason: "stopped" } });
  const api = apiStub([stopped]);
  const runtime = runtimeFor(api.module);
  runtime.resetTaskWaitingRuntimeForTest();
  runtime.startTaskWaitingRuntime({
    translate,
    showToast,
    notifyNative: api.module.api.showNativeNotification,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(toasts.length, 0, "stopping is the person's own act, not news");

  // The next real stage is its own announcement.
  api.module.api.listTasks = async () => ({
    tasks: [task({ stage: "failed", stageSeq: 5, blocker: { reason: "error", code: "PROVIDER_AUTH" } })],
  });
  for (const listener of api.listeners.tasks) listener({ reason: "stage" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /Router 后端 卡住了: .*PROVIDER_AUTH/);
});