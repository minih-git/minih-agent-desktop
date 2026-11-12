import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * A task's workspace, as a person operates it (employee mode 0.5 slice 2;
 * ADR 0329 amendment 2026-11).
 *
 * The representative path of the slice: a person types a task into an
 * employee's workbench, the app says it is preparing the workspace instead of
 * looking stuck, and the first message only leaves once the host answers that
 * the folder is ready. A preparation that failed says so, sends nothing, and can
 * be retried from the task's own header. Archiving asks a second time when the
 * folder still holds work.
 *
 * The host is stubbed at `window.minihAgent`, the same seam the renderer uses in
 * production, so the assertions are about what the person sees and what the app
 * asks the host to do.
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
import { EmployeeWorkbench } from "../../apps/desktop/src/features/bots/EmployeeWorkbench";
import { ConversationTopbar } from "../../apps/desktop/src/components/ConversationTopbar";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { useWorktreeUi } from "../../apps/desktop/src/features/worktree/worktree-ui-store";
import { BotSidebarGroup } from "../../apps/desktop/src/features/bots/BotSidebarGroup";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });

const calls = [];
const listeners = new Map();
const sentPrompts = [];
const confirmMessages = [];
let confirmAnswer = true;
// What the stubbed host answers when the archive asks whether the workspace is
// empty; the probe switches it to the "could not be checked" refusal.
let refusalCode = "WORKSPACE_HAS_UNSAVED_WORK";
let refusalMessage =
  "the task's workspace still holds 2 uncommitted file(s) and 1 unpushed commit(s)";
let selected = null;
let releaseCreate = null;
let created = null;

function employee(sessionId, name) {
  return {
    sessionId, title: name,
    profile: { name, permissionMode: "accept-edits", mustAsk: ["deploy", "delete", "spend"], observe: false },
    status: { kind: "idle" },
    projectPath: "/repo/router",
    modelKey: "minih-router/gemini-3.8-flash",
    updatedAt: "2026-11-12T00:00:00.000Z", createdAt: "2026-11-12T00:00:00.000Z",
  };
}

const bots = [employee("router", "Router 后端")];

function task(id, sessionId, extra = {}) {
  return {
    id, employeeSessionId: "router", sessionId, title: "Fix the login timeout",
    origin: "direct", stage: "queued",
    projectPath: "/repo/router", createdAt: "2026-11-12T09:00:00.000Z",
    shortId: id.slice(0, 6), workspaceStatus: "ready",
    workspaceBranch: "minih-agent/task0001", baseRef: "refs/heads/main", baseRemote: false,
    deliveryMode: "local",
    ...extra,
  };
}

let tasks = [];

function emit(channel, payload) {
  for (const listener of listeners.get(channel) ?? []) listener(payload);
}

window.confirm = (message) => {
  confirmMessages.push(String(message));
  return confirmAnswer;
};

window.minihAgent = {
  platform: "darwin",
  on(channel, listener) {
    const bucket = listeners.get(channel) ?? new Set();
    listeners.set(channel, bucket);
    bucket.add(listener);
    return () => bucket.delete(listener);
  },
  async invoke(channel, input) {
    calls.push({ channel, input });
    if (channel === IPC.invoke.botList) return { ok: true, data: { bots } };
    if (channel === IPC.invoke.projectList) return { ok: true, data: { projects: [] } };
    if (channel === IPC.invoke.taskList) return { ok: true, data: { tasks } };
    if (channel === IPC.invoke.taskCreate) {
      // The host creates the task and then prepares its workspace; the answer
      // arrives only when that is done, which is what the person waits for.
      return await new Promise((resolve) => {
        releaseCreate = () => {
          created = task("task-0001", "sess-task-0001", {
            title: input.title, sourceUtterance: input.sourceUtterance,
          });
          tasks = [created];
          emit(IPC.event.tasksChanged, { employeeSessionId: "router", taskId: created.id, reason: "created" });
          resolve({ ok: true, data: { task: created, session: { id: "sess-task-0001" } } });
        };
      });
    }
    if (channel === IPC.invoke.taskWorkspaceRetry) {
      tasks = tasks.map((row) => ({ ...row, workspaceStatus: "ready", workspaceError: undefined }));
      return { ok: true, data: { task: tasks[0] } };
    }
    if (channel === IPC.invoke.taskArchive) {
      // The host refuses until the folder is empty, and discard is the only
      // thing that changes its mind.
      if (!input?.discard) {
        return { ok: false, error: { message: refusalMessage, code: refusalCode } };
      }
      return { ok: true, data: { task: { ...tasks[0], archivedAt: "2026-11-12T10:00:00.000Z" }, archivedAt: "2026-11-12T10:00:00.000Z" } };
    }
    return { ok: true, data: undefined };
  },
};

useAppStore.setState({
  sessions: [{ id: "router", title: "Router 后端", role: "bot", projectPath: "/repo/router",
    createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z" }],
  activeSessionId: null,
  selectSession: async (sessionId) => { selected = sessionId; useAppStore.setState({ activeSessionId: sessionId }); },
  sendPrompt: async (content, draft, target) => { sentPrompts.push({ content, target }); return true; },
  projectMeta: {},
  workspace: { path: "/repo/router", name: "router" },
  setPage: () => undefined,
  openWorkPanelTab: () => undefined,
  activeWorkPanelTabId: null,
  settings: {},
  renameSession: async () => undefined,
  showToast: () => undefined,
  bootstrap: async () => undefined,
  refreshSessions: async () => undefined,
  prefetchSession: async () => undefined,
  planningStates: {},
});

let rootNode = null;
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }
async function until(predicate, label) {
  for (let n = 0; n < 240; n += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error("timed out waiting for " + label + " body=" + document.body.textContent);
}
const callsTo = (channel) => calls.filter((call) => call.channel === channel);
const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();

function mount(element) {
  const container = document.getElementById("root");
  if (rootNode) flushSync(() => rootNode.unmount());
  container.innerHTML = "";
  rootNode = createRoot(container);
  flushSync(() => rootNode.render(element));
}

const topbar = () => React.createElement(ConversationTopbar, {
  sidebarCollapsed: false, workPanelOpen: false,
  onToggleSidebar: () => undefined, onNewTask: () => undefined, onOpenSearch: () => undefined,
});

window.workspaceProbe = async () => {
  const report = {};

  // 1. Typing a task starts with "preparing the workspace", and nothing is sent
  //    while the host is still building the folder.
  mount(React.createElement(EmployeeWorkbench, { employee: bots[0], onOpenTask: () => undefined }));
  await until(() => document.querySelector("[data-workbench-new-task]"), "the new task field");
  const input = document.querySelector("[data-workbench-new-task]");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  flushSync(() => {
    setter.call(input, "修一下登录超时");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  flushSync(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await until(() => document.querySelector("[data-workbench-preparing]"), "the preparing line");
  report.preparing = text(document.querySelector("[data-workbench-preparing]"));
  check(/Preparing workspace/.test(report.preparing), "the field does not say what it waits for: " + report.preparing);
  check(sentPrompts.length === 0, "the first message left before the workspace was ready");
  check(document.querySelectorAll("[data-employee-task]").length === 0, "a task appeared before it was ready");

  // 2. The host answers "ready": the message goes, and the row the host returned
  //    carries the real branch it prepared (not something the renderer invented).
  flushSync(() => releaseCreate());
  await until(() => sentPrompts.length === 1, "the first message");
  check(selected === "sess-task-0001", "the created task session was not opened");
  check(sentPrompts[0].target === "sess-task-0001", "the message was sent to the wrong session");
  await until(() => document.querySelector("[data-employee-task='task-0001']"), "the task row");
  const row = document.querySelector("[data-employee-task='task-0001']");
  check(/修一下登录超时/.test(text(row)), "the row does not show the task: " + text(row));
  check(/minih-agent\/task0001/.test(text(row)), "the row does not show the branch the host created: " + text(row));
  check(/Workspace ready/.test(text(row)), "the row does not say the workspace is ready: " + text(row));
  check(/local main/.test(text(row)), "the row does not say where the branch started: " + text(row));
  report.row = text(row);

  // 2b. The task row carries the same "behind the project" count an isolated
  //     session does: ADR 0329's marker, read from the store that
  //     worktree.behindAll fills.
  useWorktreeUi.setState({ behind: { "sess-task-0001": 3 } });
  mount(React.createElement(BotSidebarGroup, {
    bots, tasks, onOpenBot: () => undefined, onOpenTask: () => undefined,
  }));
  await until(
    () => document.querySelector("[data-sidebar-bot-task='task-0001'] [data-worktree-behind]"),
    "the behind marker on the task row",
  );
  const marked = document.querySelector("[data-sidebar-bot-task='task-0001']");
  check(/↓3/.test(text(marked)), "the task row does not show how far behind it is: " + text(marked));
  report.behind = text(marked);

  // 3. A preparation that failed sends nothing, says why, and retries.
  tasks = [task("task-0002", "sess-task-0002", {
    stage: "failed", workspaceStatus: "failed",
    workspaceBranch: undefined, baseRef: undefined,
    workspaceError: "the workspace setup command failed\nexit 3",
  })];
  useAppStore.setState({
    sessions: [
      { id: "router", title: "Router 后端", role: "bot", projectPath: "/repo/router",
        createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z" },
      { id: "sess-task-0002", title: "Fix the login timeout", role: "task", projectPath: "/repo/router",
        createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z" },
    ],
    activeSessionId: "sess-task-0002",
  });
  mount(topbar());
  await until(() => document.querySelector("[data-task-workspace-retry]"), "the retry control");
  const header = document.querySelector("[data-task-header]");
  check(/Workspace failed/.test(text(header)), "the header does not say the workspace failed: " + text(header));
  check(/setup command failed/.test(text(header)), "the header does not say why: " + text(header));
  report.failedHeader = text(header);
  const retriesBefore = callsTo(IPC.invoke.taskWorkspaceRetry).length;
  flushSync(() => document.querySelector("[data-task-workspace-retry]").click());
  await until(() => callsTo(IPC.invoke.taskWorkspaceRetry).length === retriesBefore + 1, "the retry call");
  await until(() => /Workspace ready/.test(text(document.querySelector("[data-task-header]"))), "the ready chip");
  check(!document.querySelector("[data-task-workspace-retry]"), "the retry control stayed after it worked");
  report.retried = text(document.querySelector("[data-task-header]"));

  // 4. Archiving a workspace that still holds work asks once, and only the
  //    person's second click passes discard.
  tasks = [task("task-0003", "sess-task-0003", { stage: "person/accept" })];
  useAppStore.setState({ activeSessionId: "sess-task-0003",
    sessions: [
      { id: "router", title: "Router 后端", role: "bot", projectPath: "/repo/router",
        createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z" },
      { id: "sess-task-0003", title: "Fix the login timeout", role: "task", projectPath: "/repo/router",
        createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z" },
    ] });
  mount(topbar());
  await until(() => document.querySelector("[data-task-archive]"), "the archive control");
  flushSync(() => document.querySelector("[data-task-archive]").click());
  await until(() => callsTo(IPC.invoke.taskArchive).length >= 1, "the archive call");
  await until(() => confirmMessages.length === 1, "the discard confirmation");
  report.confirm = confirmMessages[0];
  check(/2 uncommitted file/.test(report.confirm), "the confirmation does not count the work: " + report.confirm);
  await until(() => callsTo(IPC.invoke.taskArchive).length === 2, "the discarded archive call");
  const archiveCalls = callsTo(IPC.invoke.taskArchive);
  check(archiveCalls[0].input.discard === undefined, "the first archive already discarded");
  check(archiveCalls[1].input.discard === true, "the second archive did not discard");
  report.archiveCalls = archiveCalls.length;

  // 5. Backing out of the confirmation archives nothing.
  confirmMessages.length = 0;
  confirmAnswer = false;
  const before = callsTo(IPC.invoke.taskArchive).length;
  mount(topbar());
  await until(() => document.querySelector("[data-task-archive]"), "the archive control again");
  flushSync(() => document.querySelector("[data-task-archive]").click());
  await until(() => confirmMessages.length === 1, "the second confirmation");
  await settle();
  check(
    callsTo(IPC.invoke.taskArchive).length === before + 1,
    "backing out still archived the task",
  );
  report.archiveCallsAfterCancel = callsTo(IPC.invoke.taskArchive).length;

  // 6. And the same question when the host cannot tell what the folder holds:
  //    a failed commit count is not a permission to delete commits.
  refusalCode = "WORKSPACE_UNSAVED_UNKNOWN";
  refusalMessage = "the workspace's unsaved work could not be checked: git rev-list failed";
  confirmMessages.length = 0;
  confirmAnswer = true;
  const beforeUnknown = callsTo(IPC.invoke.taskArchive).length;
  mount(topbar());
  await until(() => document.querySelector("[data-task-archive]"), "the archive control once more");
  flushSync(() => document.querySelector("[data-task-archive]").click());
  await until(() => confirmMessages.length === 1, "the unreadable-count confirmation");
  check(
    /could not be checked/.test(confirmMessages[0]),
    "the confirmation does not say the count is unknown: " + confirmMessages[0],
  );
  await until(
    () => callsTo(IPC.invoke.taskArchive).length === beforeUnknown + 2,
    "the discarded archive after an unreadable count",
  );
  report.unknownArchiveCalls = callsTo(IPC.invoke.taskArchive).length - beforeUnknown;

  flushSync(() => rootNode.unmount());
  report.passed = true;
  return report;
};
`;

async function runProbe(expression, label) {
  const temp = await mkdtemp(join(tmpdir(), `pi-${label}-`));
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
    console.log("WORKSPACE_PROBE " + JSON.stringify(await win.webContents.executeJavaScript(${JSON.stringify(expression)})));
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith("WORKSPACE_PROBE "));
    assert.ok(line, output.slice(-6000));
    return JSON.parse(line.slice("WORKSPACE_PROBE ".length));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const displayMissing = process.platform === "linux" && !process.env.DISPLAY;

test(
  "workspace: a typed task says it is preparing, sends only when ready, retries a failure, and asks before discarding",
  { skip: displayMissing ? "Electron requires a display" : false },
  async () => {
    const report = await runProbe("window.workspaceProbe()", "task-workspace");
    assert.equal(report.passed, true);
    // The row and the header read the host's facts, not a guess.
    assert.match(report.row, /minih-agent\/task0001/);
    assert.match(report.failedHeader, /Workspace failed/);
    assert.match(report.retried, /Workspace ready/);
    // One archive call per click, and the confirmation is the only path to a
    // discard.
    assert.equal(report.archiveCalls, 2);
    assert.equal(report.archiveCallsAfterCancel, 3);
    // An unreadable count asks the same question, and still needs the discard.
    assert.equal(report.unknownArchiveCalls, 2);
  },
);