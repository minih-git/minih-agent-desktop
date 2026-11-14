import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * Employee mode 0.5 slice 5, through real clicks (the follow-up that the slice
 * shipped without).
 *
 * Two things the person does, and the two things the host must therefore see:
 *
 * - **Deleting a lesson** from settings → employees. The row has to leave the
 *   list, the host has to be asked exactly once with that lesson's id, and a
 *   fresh read must not bring it back — a deleted lesson that returns is worse
 *   than one that could not be deleted.
 * - **Accepting finished work** on the completion card. An employee whose only
 *   task was `person/accept` is the loudest row in the sidebar; after the one
 *   click that ends the wait it must go quiet — no orange row, no red dot, one
 *   fewer thing in 「等你 N 件」 — while its task row says 「已接受，待合并」.
 *
 * The renderer is the real one: the shipped components, the same hooks, the
 * same IPC bridge shape the preload exposes. The host is scripted because this
 * is about what the renderer does with an answer, not about SQLite; the host's
 * own rules are proven in host-core.
 */

const root = repositoryRoot();
const { build: bundle } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { BotsSettingsPage } from "../../apps/desktop/src/features/bots/BotsSettingsPage";
import { BotSidebarGroup } from "../../apps/desktop/src/features/bots/BotSidebarGroup";
import { TaskCompletionCardForSession } from "../../apps/desktop/src/features/bots/TaskWaitingDock";

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
  status: { kind: "idle" }, projectPath: "/repo/Minih-Router",
  updatedAt: "2026-11-13T02:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z",
};
const bots = [steward, router];

/** One lesson, with the citation the section promises: the task it came from. */
function lesson(id, content, shortId) {
  return {
    id, scopeKind: "bot", scopeKey: "router", kind: "fact", content,
    status: "active", origin: "extracted", evidence: "verified",
    sourceSessionId: "sess-task-" + shortId, sourceMessageIds: [], fingerprint: "fp-" + id,
    revision: 1, createdAt: 1763000000000, updatedAt: 1763000000000, useCount: 0,
    sourceTaskId: "task-" + shortId, sourceTaskShortId: shortId,
    sourceTaskTitle: "把设置页的滚动问题修掉", sourceTaskArchivedAt: "2026-11-13T03:00:00.000Z",
  };
}
const kept = lesson("lesson-kept", "合并前先跑一遍迁移脚本。", "3f8a11");
const doomed = lesson("lesson-doomed", "截图要在真实外壳里拍，不要只截组件。", "77b0c2");

const result = {
  status: "ready",
  summary: "登录超时改成 30s。",
  acceptance: [{ criterion: "有能复现的失败用例", met: true }],
  leftovers: [],
  reportedAt: "2026-11-13T03:00:00.000Z",
};
const task = {
  id: "task-done", employeeSessionId: "router", sessionId: "sess-done",
  title: "修一下登录超时", origin: "direct", stage: "person/accept",
  projectPath: "/repo/Minih-Agent-Desktop", shortId: "a1b2c3",
  createdAt: "2026-11-13T01:00:00.000Z", workspaceStatus: "ready",
  deliveryMode: "pr", workspaceBranch: "fix/login-timeout", result,
};
const checks = {
  "task-done": { canMerge: true, prUrl: "https://github.com/minih-git/minih-agent-desktop/pull/255",
    checks: { total: 6, passed: 6, pending: 0, failed: [] },
    changes: { commits: [{ sha: "8450f4b0", subject: "fix(bot): 启动时不读任务列表" }], files: 2, truncated: false },
    elapsedMs: 40 * 60_000 },
};

const state = {
  // The host's rows: deleting one takes it out of what the next read returns,
  // which is what a tombstone does.
  lessons: { router: [kept, doomed], steward: [] },
  deleted: [],
  tasks: [task],
  acceptCalls: [],
  settingsReads: 0,
  experienceReads: 0,
};
const listeners = new Map();

window.minihAgent = {
  platform: "darwin",
  channels: IPC,
  on(channel, listener) {
    const list = listeners.get(channel) ?? [];
    list.push(listener);
    listeners.set(channel, list);
    return () => {
      listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== listener));
    };
  },
  async invoke(channel, input) {
    if (channel === IPC.invoke.settingsGet) {
      state.settingsReads += 1;
      return { ok: true, data: { learnedMemory: { learn: true } } };
    }
    if (channel === IPC.invoke.botList) return { ok: true, data: { bots } };
    if (channel === IPC.invoke.taskExperienceList) {
      state.experienceReads += 1;
      return { ok: true, data: { entries: state.lessons[input.employeeSessionId] ?? [] } };
    }
    if (channel === IPC.invoke.memoryDelete) {
      state.deleted.push(input.id);
      for (const sessionId of Object.keys(state.lessons)) {
        state.lessons[sessionId] = state.lessons[sessionId].filter((entry) => entry.id !== input.id);
      }
      return { ok: true, data: { ok: true } };
    }
    // Settings → employees reads a few things the experience section does not
    // depend on; each answer is the cheapest true one, so the page renders its
    // own rows instead of its error lines.
    if (channel === IPC.invoke.subagentCatalog) return { ok: true, data: { subagents: [], builtins: [] } };
    if (channel === IPC.invoke.projectList) return { ok: true, data: { projects: [] } };
    if (channel === IPC.invoke.providersList) return { ok: true, data: { providers: [] } };
    if (channel === IPC.invoke.taskList) return { ok: true, data: { tasks: state.tasks } };
    if (channel === IPC.invoke.taskCardList) return { ok: true, data: { drafts: [] } };
    if (channel === IPC.invoke.taskDeliveryCheck) {
      return { ok: true, data: checks[input.taskId] ?? { canMerge: false, reason: "pr-missing" } };
    }
    if (channel === IPC.invoke.taskAccept) {
      state.acceptCalls.push(input.taskId);
      state.tasks = state.tasks.map((entry) =>
        entry.id === input.taskId ? { ...entry, acceptedAt: "2026-11-13T04:00:00.000Z" } : entry);
      return { ok: true, data: { task: state.tasks.find((entry) => entry.id === input.taskId) } };
    }
    return { ok: false, error: { code: "UNEXPECTED", message: "unexpected channel " + channel } };
  },
};

const noop = () => undefined;
const frame = () => new Promise(requestAnimationFrame);
async function settle(count) { for (let n = 0; n < (count || 3); n += 1) await frame(); }
async function until(predicate, label) {
  for (let n = 0; n < 400; n += 1) {
    const value = predicate();
    if (value) return value;
    await frame();
  }
  throw new Error("timed out waiting for " + label + ": " + document.body.textContent);
}
function click(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error("no element for " + selector + " in " + document.body.innerHTML.slice(0, 600));
  flushSync(() => node.click());
}

let rootNode = null;
function mount(element) {
  const container = document.getElementById("root");
  if (rootNode) { flushSync(() => rootNode.unmount()); rootNode = null; }
  container.innerHTML = "";
  rootNode = createRoot(container);
  flushSync(() => rootNode.render(element));
}

/** The lesson rows of the settings page, by their visible text. */
function lessonTexts() {
  return Array.from(document.querySelectorAll(".bot-experience-content")).map((node) => node.textContent);
}

async function openEmployees() {
  mount(React.createElement("div", { className: "settings-page" },
    React.createElement("div", { className: "settings-content" },
      React.createElement(BotsSettingsPage, null))));
  await until(() => document.body.textContent.indexOf("经验") >= 0, "the experience card");
  await until(() => lessonTexts().length === 2, "both lessons");
}

function sidebarShell() {
  return React.createElement("div", { className: "app-shell" },
    React.createElement("aside", { className: "sidebar sidebar-surface" },
      React.createElement(BotSidebarGroup, { activeSessionId: "sess-done", onOpenBot: noop, onOpenTask: noop })),
    React.createElement("section", { className: "main-pane" },
      React.createElement("div", { className: "composer-dock composer-dock-docked" },
        React.createElement("div", { className: "composer-stack" },
          React.createElement(TaskCompletionCardForSession, { sessionId: "sess-done" })))));
}

function rowOf(sessionId) {
  return document.querySelector("[data-sidebar-bot-row='" + sessionId + "']");
}
function waitingCount() {
  const node = document.querySelector("[data-sidebar-waiting]");
  return node ? Number(node.getAttribute("data-sidebar-waiting")) : 0;
}
function taskStageText(taskId) {
  const row = document.querySelector("[data-sidebar-bot-task='" + taskId + "']");
  const stage = row?.querySelector(".sidebar-bot-task-stage");
  return stage ? stage.textContent : null;
}
/** The host tells the app its rows changed; every surface re-reads then. */
async function hostChanged() {
  for (const listener of listeners.get(IPC.event.tasksChanged) ?? []) listener({ employeeSessionId: "router", reason: "stage" });
  await settle(4);
}

window.shot = {
  /**
   * Delete one lesson from settings → employees, then read the page again the
   * way the person would: close it and open it.
   */
  async deleteLesson() {
    try {
      state.deleted = [];
      state.lessons = { router: [kept, doomed], steward: [] };
      await openEmployees();
      if (document.body.textContent.indexOf("任务 #3f8a11") < 0) {
        throw new Error("the lesson does not name the task it came from");
      }
      const rows = Array.from(document.querySelectorAll(".bot-experience-row"));
      const row = rows.find((node) => node.textContent.indexOf(doomed.content) >= 0);
      if (!row) throw new Error("the lesson to delete is not in the list");
      const button = row.querySelector("button[aria-label='" + i18n.t("bots.experience.deleteLabel") + "']");
      if (!button) throw new Error("the row has no delete button");
      flushSync(() => button.click());
      await until(() => lessonTexts().indexOf(doomed.content) < 0, "the deleted lesson to leave the list");
      await settle(3);
      const expected = [doomed.id];
      if (JSON.stringify(state.deleted) !== JSON.stringify(expected)) {
        throw new Error("the host was asked to delete " + JSON.stringify(state.deleted));
      }
      if (lessonTexts().indexOf(kept.content) < 0) {
        throw new Error("the other lesson was removed as well");
      }
      // A fresh read: the host's list no longer holds it, so reopening the page
      // must not bring it back.
      const readsBefore = state.experienceReads;
      mount(React.createElement("div", { className: "settings-page" },
        React.createElement("div", { className: "settings-content" },
          React.createElement(BotsSettingsPage, null))));
      await until(() => state.experienceReads > readsBefore, "the page to read the lessons again");
      await until(() => lessonTexts().length === 1, "the surviving lesson after the re-read");
      await settle(3);
      if (lessonTexts().indexOf(doomed.content) >= 0) {
        throw new Error("the deleted lesson came back after a re-read");
      }
      return { ok: true, deleted: state.deleted };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  },

  /**
   * Accept finished work and watch the employee go quiet: the whole point of
   * slice 4b, clicked once.
   */
  async acceptClearsAttention() {
    try {
      state.tasks = [task];
      state.acceptCalls = [];
      mount(sidebarShell());
      await until(() => rowOf("router"), "the employee row");
      // Before: the employee is the loudest thing on the sidebar and counts in
      // 「等你 N 件」.
      await until(() => rowOf("router").dataset.botStatus === "attention", "the attention dot before the click");
      await until(() => rowOf("router").classList.contains("needs-person"), "the attention row before the click");
      await until(() => document.querySelector(".sidebar-bot-status-dot.attention"), "the red dot before the click");
      await until(() => waitingCount() === 1, "one thing waiting before the click");
      await until(() => taskStageText("task-done") === i18n.t("bots.taskStage.personAccept"),
        "the task row still asking to accept");
      const card = await until(() => document.querySelector("[data-completion-accept]"), "the 只接受 button");
      if (card.disabled) throw new Error("the 只接受 button is disabled");
      flushSync(() => card.click());
      await until(() => state.acceptCalls.length === 1, "the host to be asked to accept");
      await settle(3);
      await hostChanged();
      // After: quiet row, no dot, one fewer thing waiting, and the task row now
      // says 已接受，待合并 instead of asking again.
      await until(() => rowOf("router").dataset.botStatus !== "attention", "the dot to go quiet");
      await settle(2);
      if (rowOf("router").classList.contains("needs-person")) {
        throw new Error("the employee row is still painted as needing the person");
      }
      if (document.querySelector(".sidebar-bot-status-dot.attention")) {
        throw new Error("the red dot is still there");
      }
      if (waitingCount() !== 0) throw new Error("the waiting count is still " + waitingCount());
      if (document.querySelector("[data-sidebar-waiting]")) {
        throw new Error("the 等你 N 件 button is still on the sidebar");
      }
      await until(() => taskStageText("task-done") === i18n.t("bots.taskStage.acceptedPendingMerge"),
        "the task row to say 已接受，待合并");
      const row = document.querySelector("[data-sidebar-bot-task='task-done']");
      if (row.dataset.taskTone === "attention") throw new Error("the task row is still orange");
      const openCount = document.querySelector("[data-bot-open-count]");
      if (!openCount) throw new Error("the accepted task vanished from the employee's list");
      return { ok: true, accepted: state.acceptCalls };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  },
};
`;

/** Run one Electron child and resolve with its exit code, forwarding its output. */
function spawnProcess(binary, args) {
  const { spawn } = createRequire(import.meta.url)("node:child_process");
  const child = spawn(binary, args, { stdio: ["ignore", "inherit", "inherit"], env: process.env });
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
}

/** Boot one window on the fixture, run `action`, and fail with its own words. */
async function runAction(action) {
  const workDir = await mkdtemp(join(tmpdir(), "pi-bot-experience-path-"));
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
  await writeFile(
    join(workDir, "index.html"),
    `<!doctype html><meta charset="utf-8">
     <style>
       html, body, #root { height: 100%; margin: 0; }
       body { background: var(--ds-bg-primary); color: var(--ds-text-primary); }
     </style>
     <div id="root"></div><script type="module" src="renderer.js"></script>`,
  );

  await writeFile(
    join(workDir, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
const action = ${JSON.stringify(action)};
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  let failure = null;
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    await win.webContents.executeJavaScript(
      "new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const tick = () => { if (window.shot) return resolve(true); if (Date.now() > deadline) return reject(new Error('renderer never loaded')); setTimeout(tick, 50); }; tick(); })",
    );
    const result = await win.webContents.executeJavaScript("window.shot." + action + "()");
    if (!result || result.ok !== true) throw new Error("action " + action + " failed: " + JSON.stringify(result));
  } catch (error) {
    failure = error;
  }
  if (failure) { console.error("FAIL", failure && failure.stack ? failure.stack : failure); app.exit(1); return; }
  app.exit(0);
});
`,
  );

  const code = await spawnProcess(resolveElectronBinary(root).electronBinary, [join(workDir, "main.cjs")]);
  assert.equal(code, 0, `${action} failed in the renderer; see the output above`);
}

test(
  "employees: deleting a lesson removes it once, and a re-read does not bring it back",
  { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false, timeout: 300_000 },
  async () => {
    await runAction("deleteLesson");
  },
);

test(
  "employees: accepting finished work clears the attention dot, the red row and the waiting count",
  { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false, timeout: 300_000 },
  async () => {
    await runAction("acceptClearsAttention");
  },
);