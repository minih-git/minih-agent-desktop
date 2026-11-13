import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * The secretary's slice-3 surfaces, as a person operates them (employee mode 0.5
 * §3), in a real Electron renderer with real clicks:
 *
 * - the card's **reason** ("why this employee") is rendered as the steward wrote
 *   it, the **assignee is a dropdown**, and a card that only reads says so with
 *   its own badge — the one card the host may start without the person;
 * - a card the host started by itself folds into one quiet line that says it is
 *   running read-only;
 * - a task the startup fence interrupted says **「已中断」** in the sidebar, and
 *   「重新开工」 in the task header's action group calls `task.restart` with that
 *   task's id.
 *
 * The screenshots are the point of this file as much as the assertions: they are
 * captured from a window that loads **the real compiled stylesheet** (Tailwind v4
 * plus the same `globals.css` cascade the app ships) and renders the **full app
 * shell** — sidebar, title band, conversation — at 1440×900, in zh-CN, in both
 * themes. An earlier version of this file rendered the components alone against
 * a hand-made stylesheet and produced pictures of unstyled buttons; that is the
 * mistake this file exists to prevent (`bot-workbench-visual.test.mjs` takes the
 * same approach for the employee workbench).
 *
 * The host is stubbed at `window.minihAgent`, the same seam the renderer uses in
 * production, so the assertions are about what the person sees and what the app
 * asks the host to do.
 */

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const artifacts = join(root, ".artifacts", "bot-steward");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { TaskCardDock } from "../../apps/desktop/src/features/bots/TaskCardDock";
import { BotSidebarGroup } from "../../apps/desktop/src/features/bots/BotSidebarGroup";
import { ConversationTopbar } from "../../apps/desktop/src/components/ConversationTopbar";
import { EmployeeTitlebar } from "../../apps/desktop/src/features/bots/EmployeeTitlebar";
import { ActiveTaskWorkspaceBanner } from "../../apps/desktop/src/features/bots/TaskWorkspaceBanner";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({
  lng: "zh-CN",
  keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } },
  interpolation: { escapeValue: false },
});

const calls = [];
const listeners = new Map();
/** What the dock's host reads return; the probe flips it between steps. */
let mode = "proposal";

const employee = {
  sessionId: "bot-1",
  title: "Desktop 前端",
  profile: {
    name: "Desktop 前端",
    duty: "桌面端渲染与外壳",
    permissionMode: "accept-edits",
    mustAsk: ["push", "deploy", "delete", "spend"],
    observe: false,
  },
  status: { kind: "idle" },
  projectPath: "/repo/minih-agent-desktop",
  modelKey: "minih-router/gemini-3.8-pro",
  updatedAt: "2026-11-12T09:00:00.000Z",
  createdAt: "2026-11-11T09:00:00.000Z",
};
const router = {
  ...employee,
  sessionId: "bot-2",
  title: "Router 后端",
  profile: { ...employee.profile, name: "Router 后端", duty: "网关、数据面与远端接入" },
};

const interruptedTask = {
  id: "task-interrupted",
  shortId: "37",
  employeeSessionId: "bot-1",
  sessionId: "task-session-1",
  title: "修登录超时",
  origin: "steward",
  stage: "working",
  deliveryId: "delivery-1",
  deliveryStatus: "interrupted",
  deliveryUpdatedAt: "2026-11-12T09:30:00.000Z",
  projectPath: "/repo/minih-agent-desktop",
  branch: "fix/login-timeout",
  workspaceStatus: "ready",
  baseRef: "refs/remotes/origin/main",
  baseRemote: true,
  deliveryMode: "pr",
  latestProgress: "在改 session.ts 的超时判定",
  createdAt: "2026-11-12T09:00:00.000Z",
};
const workingTask = {
  ...interruptedTask,
  id: "task-working",
  shortId: "41",
  sessionId: "task-session-2",
  title: "员工看板页面",
  stage: "working",
  deliveryStatus: "running",
  branch: "feat/employee-board",
  createdAt: "2026-11-12T08:00:00.000Z",
};

/** The draft the dock reads back; reassigning mutates it the way the host would. */
const current = { hash: "hash-1", target: "bot-1", title: "Desktop 前端" };

function proposal(cardHash) {
  return {
    id: "draft-1",
    sessionId: "steward-1",
    status: mode === "auto" ? "confirmed" : "proposed",
    ...(mode === "auto"
      ? { confirmedBy: "policy", confirmedAt: "2026-11-12T10:00:00.000Z" }
      : {}),
    card: {
      goal: "把员工看板的筛选做成下拉，并补一条空列表说明",
      criteria: [
        { id: "c1", text: "筛选是一个下拉，不是输入框" },
        { id: "c2", text: "没有任何任务时页面不空着" },
      ],
      boundaries: ["不要动发送链路"],
      permissionMode: "ask",
      readOnly: true,
      mustAsk: ["deploy", "delete", "spend"],
      risk: "low",
      reason: "这件活是页面与交互；你提到了 Desktop；它现在空闲。",
    },
    cardHash,
    sourceUtterance: "Desktop 加一个员工看板页面",
    targetSessionId: current.target,
    targetTitle: current.title,
    createdAt: "2026-11-12T09:00:00.000Z",
    updatedAt: "2026-11-12T09:00:00.000Z",
  };
}

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
    if (channel === IPC.invoke.taskCardList) {
      return {
        ok: true,
        data: { drafts: [proposal(mode === "auto" ? "hash-auto" : current.hash)] },
      };
    }
    if (channel === IPC.invoke.botList) return { ok: true, data: { bots: [employee, router] } };
    if (channel === IPC.invoke.taskCardReassign) {
      // The host narrowed the card to the new employee and recomputed its hash;
      // it is still proposed, so the person still starts it.
      current.hash = "hash-reassigned";
      current.target = input.targetSessionId;
      current.title = input.targetSessionId === "bot-2" ? "Router 后端" : "Desktop 前端";
      return { ok: true, data: { draft: proposal(current.hash), repoAvailable: true } };
    }
    if (channel === IPC.invoke.taskRestart) {
      return {
        ok: true,
        data: { task: { ...interruptedTask, stage: "queued", deliveryStatus: "queued" } },
      };
    }
    if (channel === IPC.invoke.taskList) {
      return { ok: true, data: { tasks: [interruptedTask, workingTask] } };
    }
    if (channel === IPC.invoke.projectList) {
      return { ok: true, data: { projects: [{ path: "/repo/minih-agent-desktop", name: "MiniH Agent Desktop" }] } };
    }
    return { ok: true, data: undefined };
  },
};

const sessions = [
  {
    id: "bot-1",
    title: "Desktop 前端",
    role: "bot",
    projectPath: "/repo/minih-agent-desktop",
    createdAt: "2026-11-11T09:00:00.000Z",
    updatedAt: "2026-11-12T09:00:00.000Z",
  },
  {
    id: "steward-1",
    title: "秘书",
    projectPath: "/repo/minih-agent-desktop",
    createdAt: "2026-11-10T09:00:00.000Z",
    updatedAt: "2026-11-12T09:05:00.000Z",
  },
  {
    id: "task-session-1",
    title: "修登录超时",
    role: "task",
    projectPath: "/repo/minih-agent-desktop",
    createdAt: "2026-11-12T09:00:00.000Z",
    updatedAt: "2026-11-12T09:30:00.000Z",
  },
];

const noop = () => undefined;
useAppStore.setState({
  sessions,
  activeSessionId: "steward-1",
  selectSession: async () => undefined,
  sendPrompt: async () => true,
  projectMeta: {},
  workspace: { path: "/repo/minih-agent-desktop", name: "MiniH Agent Desktop" },
  setPage: noop,
  openWorkPanelTab: noop,
  activeWorkPanelTabId: null,
  settings: {},
  renameSession: async () => undefined,
  showToast: noop,
  bootstrap: async () => undefined,
  refreshSessions: async () => undefined,
  prefetchSession: async () => undefined,
  planningStates: {},
  navStack: [],
  navIndex: 0,
  navBack: noop,
});

const frame = () => new Promise(requestAnimationFrame);
async function settle(times = 3) {
  for (let n = 0; n < times; n += 1) await frame();
}
async function until(predicate, label) {
  for (let n = 0; n < 300; n += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error("timed out waiting for " + label + ": " + document.body.textContent);
}
/**
 * Finish every animation that has an end, so a capture never catches a surface
 * mid-fade. Decorative loops are left alone: they never finish.
 */
function finishAnimations() {
  for (const animation of document.getAnimations()) {
    const timing = animation.effect && animation.effect.getTiming ? animation.effect.getTiming() : null;
    if (timing && timing.iterations === Infinity) continue;
    try {
      animation.finish();
    } catch {
      /* idle or infinite: nothing to finish */
    }
  }
}

let rootNode = null;
function mount(element) {
  // The header reads the active session from the store, so the fixture keeps
  // that in step with the surface being shown.
  useAppStore.setState({ activeSessionId: mode === "task" ? "task-session-1" : "steward-1" });
  const container = document.getElementById("root");
  if (rootNode) flushSync(() => rootNode.unmount());
  container.innerHTML = "";
  rootNode = createRoot(container);
  flushSync(() => rootNode.render(element));
}

const sidebar = () =>
  React.createElement(BotSidebarGroup, {
    bots: [employee, router],
    tasks: [interruptedTask, workingTask],
    activeSessionId: mode === "task" ? "task-session-1" : "steward-1",
    onOpenBot: noop,
    onOpenTask: noop,
  });

/** The band above the conversation: an employee's titlebar, or a task's header. */
function band() {
  if (mode !== "task") {
    return React.createElement(EmployeeTitlebar, {
      employee,
      sidebarCollapsed: false,
      workPanelOpen: false,
      sidebarToggleShortcut: "⌘B",
      onToggleSidebar: noop,
      onNewTask: noop,
    });
  }
  return React.createElement(ConversationTopbar, {
    sidebarCollapsed: false,
    workPanelOpen: false,
    onToggleSidebar: noop,
    onNewTask: noop,
    onOpenSearch: noop,
  });
}

/** What the conversation would show above the composer, as one quiet turn. */
function conversation() {
  return React.createElement(
    "div",
    { className: "shot-turn" },
    React.createElement(
      "p",
      { className: "shot-user" },
      "Desktop 加一个员工看板页面，先只调研，别改代码。",
    ),
    React.createElement(
      "p",
      { className: "shot-steward" },
      "好，卡片在下面。只有调研这类只读的活会自己开工，其他等你点。",
    ),
  );
}

function main() {
  if (mode === "task") {
    return React.createElement(
      "div",
      { className: "route-surface route-page shot-stack" },
      React.createElement(ActiveTaskWorkspaceBanner),
      React.createElement("div", { className: "shot-spacer" }),
    );
  }
  return React.createElement(
    "div",
    { className: "route-surface route-page shot-stack" },
    conversation(),
    React.createElement("div", { className: "shot-spacer" }),
    React.createElement(TaskCardDock, { sessionId: "steward-1" }),
  );
}

function shell() {
  return React.createElement(
    "div",
    { className: "app-shell" },
    React.createElement(
      "aside",
      { className: "sidebar sidebar-surface" },
      React.createElement("div", { className: "shot-sidebar-body" }, sidebar()),
    ),
    React.createElement("section", { className: "main-pane" }, band(), main()),
  );
}

const callsTo = (channel) => calls.filter((call) => call.channel === channel);
const button = (label) =>
  [...document.querySelectorAll("button")].find(
    (node) => node.textContent.replace(/\s+/g, " ").trim() === label,
  );

document.documentElement.dataset.platform = "darwin";

window.stewardProbe = async () => {
  const report = {};
  // 1. The card as the steward proposed it: goal, the reason, the picker, and
  //    the read-only badge that says the host may start this one alone.
  mode = "proposal";
  mount(shell());
  await until(() => button("开工"), "the proposed card");
  const reason = document.querySelector("[data-card-reason]");
  report.reason = reason ? reason.textContent.trim() : null;
  const select = document.querySelector("[data-card-assign]");
  report.options = select ? [...select.options].map((option) => option.textContent.trim()) : [];
  const readOnly = document.querySelector("[data-card-readonly]");
  report.readOnlyBadge = readOnly ? readOnly.textContent.trim() : null;
  const meta = [...document.querySelectorAll(".task-card-meta > *")].map((node) =>
    node.textContent.replace(/\s+/g, " ").trim(),
  );
  report.meta = meta;

  // 2. Picking another employee is a click: the host answers with the narrowed
  //    card and its new hash, and the card still waits to be started.
  calls.length = 0;
  flushSync(() => {
    select.value = "bot-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await until(() => callsTo(IPC.invoke.taskCardReassign).length === 1, "the reassign call");
  await until(
    () => document.querySelector("[data-card-hash]")?.getAttribute("data-card-hash") === "hash-reassigned",
    "the reassigned card",
  );
  report.reassign = callsTo(IPC.invoke.taskCardReassign)[0].input;

  // 3. A card the host started by itself folds into one quiet line, and the line
  //    says what kind of run it is.
  mode = "auto";
  mount(shell());
  await until(() => document.querySelector("[data-auto-started]"), "the auto-started row");
  report.autoStarted = document.querySelector("[data-auto-started]").textContent.trim();
  report.autoCardGone = !document.querySelector("[data-card-reason]");

  // 4. The interrupted task says so in the sidebar, and 「重新开工」 is one click
  //    from the task header's action group.
  mode = "task";
  mount(shell());
  await until(() => document.querySelector("[data-task-restart]"), "the restart button");
  report.sidebarStage = [...document.querySelectorAll(".sidebar-bot-task-stage")]
    .map((node) => node.textContent.trim())
    .slice(0, 1)[0];
  report.headerStage = document.querySelector('[data-task-stage="interrupted"]')?.textContent.trim();
  report.restartInActions = Boolean(
    document.querySelector(".ct-actions [data-task-restart]"),
  );
  calls.length = 0;
  flushSync(() => button("重新开工").click());
  await until(() => callsTo(IPC.invoke.taskRestart).length === 1, "the restart call");
  report.restart = callsTo(IPC.invoke.taskRestart)[0].input;
  return report;
};

/** One screen, one theme, exactly as the window will capture it. */
window.stewardScreens = {
  async render(kind, theme) {
    document.documentElement.dataset.theme = theme;
    mode = kind === "auto" ? "auto" : kind === "task" ? "task" : "proposal";
    mount(shell());
    // Each surface waits for its own content: a task header has no card dock,
    // and an auto-started card has no card to read.
    await until(() => document.querySelector("[data-sidebar-bot-task]"), "the sidebar rows");
    if (kind === "task") {
      await until(() => document.querySelector("[data-task-header]"), "the task header");
      await until(() => document.querySelector("[data-task-restart]"), "the restart button");
    } else if (kind === "auto") {
      await until(() => document.querySelector("[data-auto-started]"), "the auto-started row");
    } else {
      await until(() => document.querySelector("[data-card-reason]"), "the card");
    }
    finishAnimations();
    await settle(2);
    return true;
  },

  /**
   * What the capture has to prove: the stylesheet is the app's, not a browser
   * default. A missing cascade shows up as a button with no radius, a card with
   * no border, and the fields of the card's meta row running into each other.
   */
  measure() {
    const style = (node) => (node ? getComputedStyle(node) : null);
    const card = document.querySelector(".task-card");
    const start = button("开工");
    const meta = document.querySelector(".task-card-meta");
    const restart = document.querySelector(".ct-actions [data-task-restart]");
    const gaps = meta
      ? [...meta.children].map((child) => child.getBoundingClientRect().x + child.getBoundingClientRect().width)
      : [];
    const separations = meta
      ? [...meta.children].slice(1).map((child, index) => Math.round(child.getBoundingClientRect().x - gaps[index]))
      : [];
    return {
      theme: document.documentElement.dataset.theme,
      body: {
        background: style(document.body)?.backgroundColor ?? null,
        font: style(document.body)?.fontFamily ?? null,
      },
      page: {
        width: window.innerWidth,
        height: window.innerHeight,
        scale: window.devicePixelRatio,
      },
      card: card
        ? {
            radius: style(card).borderTopLeftRadius,
            borderWidth: style(card).borderTopWidth,
            borderStyle: style(card).borderTopStyle,
            background: style(card).backgroundColor,
          }
        : null,
      start: start
        ? {
            radius: style(start).borderTopLeftRadius,
            background: style(start).backgroundColor,
            color: style(start).color,
            height: Math.round(start.getBoundingClientRect().height),
          }
        : null,
      reason: (() => {
        const node = document.querySelector("[data-card-reason]");
        return node ? { border: style(node).borderLeftWidth, color: style(node).color } : null;
      })(),
      readonly: (() => {
        const node = document.querySelector("[data-card-readonly]");
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          text: node.textContent.trim(),
          border: style(node).borderTopWidth,
          radius: style(node).borderTopLeftRadius,
          size: { w: Math.round(rect.width), h: Math.round(rect.height) },
        };
      })(),
      metaSeparations: separations,
      auto: (() => {
        const node = document.querySelector("[data-auto-started]");
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          text: node.textContent.replace(/\s+/g, " ").trim(),
          borderStyle: style(node).borderTopStyle,
          color: style(node).color,
          height: Math.round(rect.height),
        };
      })(),
      sidebar: (() => {
        const stage = document.querySelector(".sidebar-bot-task-stage");
        return stage ? { text: stage.textContent.trim(), color: style(stage).color } : null;
      })(),
      header: (() => {
        const chip = document.querySelector('[data-task-stage="interrupted"]');
        return chip ? { text: chip.textContent.trim(), color: style(chip).color } : null;
      })(),
      restart: restart
        ? {
            text: restart.textContent.trim(),
            radius: style(restart.querySelector("button") ?? restart).borderTopLeftRadius,
          }
        : null,
    };
  },
};
`;

/** Compile the renderer stylesheet exactly as `electron-vite build` does. */
async function compileStylesheet(workDir) {
  const { build: viteBuild } = await import("vite");
  const { default: tailwindcss } = await import("@tailwindcss/vite");
  const appDir = join(root, "apps/desktop");
  const entry = join(workDir, "style-entry.js");
  await writeFile(entry, `import ${JSON.stringify(join(appDir, "src/styles/globals.css"))};\n`);
  const outDir = join(workDir, "css");
  await viteBuild({
    configFile: false,
    root: appDir,
    logLevel: "error",
    plugins: [tailwindcss()],
    build: {
      outDir,
      emptyOutDir: true,
      cssCodeSplit: false,
      rollupOptions: {
        input: entry,
        output: { entryFileNames: "style-entry.js", assetFileNames: "styles[extname]" },
      },
    },
  });
  const files = await readdir(outDir, { recursive: true });
  const stylesheet = files.find((name) => name.endsWith(".css"));
  assert.ok(stylesheet, "the renderer stylesheet compiled to nothing");
  return join(outDir, stylesheet);
}

/** A capture's colour spread: a blank or unstyled page collapses to one value. */
const HISTOGRAM = `(image) => {
  const { width, height, scaleFactor } = image.getSize();
  const bitmap = image.toBitmap();
  const seen = new Set();
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const offset = (y * width + x) * 4;
      seen.add(String(bitmap[offset]) + "," + String(bitmap[offset + 1]) + "," + String(bitmap[offset + 2]));
    }
  }
  return { colors: seen.size, width, height };
}`;

async function runInElectron(stylesheet) {
  const workDir = await mkdtemp(join(tmpdir(), "pi-steward-slice3-"));
  await mkdir(artifacts, { recursive: true });
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(workDir, "renderer.js"),
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
      join(workDir, "index.html"),
      `<!doctype html><meta charset="utf-8"><style>
        /* Harness-only layout: the app shell's own columns plus the padding a
           sidebar scroller and the composer area would have. No colours, no
           component styling: everything the capture proves comes from the app's
           compiled stylesheet loaded below. */
        html, body, #root { height: 100%; margin: 0; }
        body { background: var(--ds-bg-primary); color: var(--ds-text-primary); }
        .shot-sidebar-body { display: flex; min-height: 0; flex: 1; flex-direction: column;
          overflow: auto; padding: 42px 8px 12px; }
        .shot-stack { display: flex; min-height: 0; flex: 1; flex-direction: column;
          padding: 24px 32px 20px; }
        .shot-spacer { flex: 1; }
        .shot-turn { display: flex; flex-direction: column; gap: 10px; max-width: 680px; }
        .shot-user { margin: 0; align-self: flex-end; padding: 8px 12px; border-radius: 12px;
          background: var(--ds-bg-chip); font-size: var(--text-sm-plus); }
        .shot-steward { margin: 0; color: var(--ds-text-muted); font-size: var(--text-sm-plus); }
      </style>
      <link rel="stylesheet" href="${stylesheet}">
      <div id="root"></div><script type="module" src="renderer.js"></script>`,
    );

    const shots = [
      { kind: "cards", name: "steward-cards" },
      { kind: "auto", name: "steward-auto-started" },
      { kind: "task", name: "task-interrupted" },
    ];
    const plan = ["dark", "light"].flatMap((theme) => shots.map((shot) => ({ theme, ...shot })));
    await writeFile(
      join(workDir, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const plan = ${JSON.stringify(plan)};
const outDir = ${JSON.stringify(artifacts)};
app.disableHardwareAcceleration();
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) console.error("RENDERER " + message); });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    win.setContentSize(1440, 900);
    await win.webContents.executeJavaScript("new Promise((resolve, reject) => { const deadline = Date.now() + 20000; (function check() { if (window.stewardProbe) return resolve(true); if (Date.now() > deadline) return reject(new Error('fixture did not mount')); requestAnimationFrame(check); })(); })");
    console.log("STEWARD_SLICE3_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.stewardProbe()")));
    const histogram = ${HISTOGRAM};
    const captures = [];
    for (const entry of plan) {
      await win.webContents.executeJavaScript("window.stewardScreens.render(" + JSON.stringify(entry.kind) + ", " + JSON.stringify(entry.theme) + ")");
      await new Promise((resolve) => setTimeout(resolve, 150));
      const image = await win.webContents.capturePage();
      const file = path.join(outDir, entry.name + "-" + entry.theme + ".png");
      writeFileSync(file, image.toPNG());
      const report = await win.webContents.executeJavaScript("window.stewardScreens.measure()");
      captures.push({ ...entry, file, pixels: histogram(image), report });
    }
    console.log("STEWARD_SLICE3_SCREENS " + JSON.stringify(captures));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`,
    );

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(workDir, "main.cjs")], {
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
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
    const probeLine = output
      .split(/\r?\n/)
      .find((line) => line.startsWith("STEWARD_SLICE3_PROBE "));
    assert.ok(probeLine, output.slice(-6000));
    const capturesLine = output
      .split(/\r?\n/)
      .find((line) => line.startsWith("STEWARD_SLICE3_SCREENS "));
    assert.ok(capturesLine, output.slice(-6000));
    const probe = JSON.parse(probeLine.slice("STEWARD_SLICE3_PROBE ".length));
    const screens = JSON.parse(capturesLine.slice("STEWARD_SLICE3_SCREENS ".length));
    // The measurements beside the pictures: a reviewer can check what each
    // capture proved (borders, sizes, colours) without reading the test file.
    await writeFile(
      join(artifacts, "capture-report.json"),
      `${JSON.stringify({ probe, screens }, null, 2)}\n`,
    );
    return { probe, screens };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const displayMissing = process.platform === "linux" && !process.env.DISPLAY;

test(
  "employee mode 0.5 slice 3: card reason, read-only badge, auto-start row, interrupted task",
  { skip: displayMissing ? "Electron requires a display" : false },
  async () => {
    const stylesheet = await compileStylesheet(await mkdtemp(join(tmpdir(), "pi-bot-css-")));
    const { probe, screens } = await runInElectron(stylesheet);

    // 1. The card as a person reads it.
    assert.equal(probe.reason, "这件活是页面与交互；你提到了 Desktop；它现在空闲。");
    assert.deepEqual(probe.options, ["没有指定员工", "Desktop 前端", "Router 后端"]);
    assert.equal(probe.readOnlyBadge, "只读");
    // 2. The fields of the meta row are separate labels, never one run-on line.
    assert.ok(probe.meta.length >= 3, `the card's meta row lost its fields: ${probe.meta}`);
    assert.ok(
      probe.meta.some((text) => text.startsWith("权限档")),
      `the card does not state its permission: ${probe.meta}`,
    );
    assert.ok(
      probe.meta.some((text) => text.startsWith("项目")),
      `the card does not state its project: ${probe.meta}`,
    );
    // 3. Changing the assignee is a click that goes through the host.
    assert.deepEqual(probe.reassign, { draftId: "draft-1", targetSessionId: "bot-2" });
    // 4. The auto-started row says the run is read-only.
    assert.match(probe.autoStarted, /只读开工 · 改动前会问你/);
    assert.equal(probe.autoCardGone, true, "an auto-started card still asked to be read");
    // 5. The interruption is visible where the task is, and one click away from
    //    being started again — from the header's action group.
    assert.equal(probe.sidebarStage, "已中断");
    assert.equal(probe.headerStage, "已中断");
    assert.equal(probe.restartInActions, true, "「重新开工」 is not in the action group");
    assert.deepEqual(probe.restart, { taskId: "task-interrupted" });

    // 6. Each capture proves it was taken against the app's own stylesheet.
    assert.equal(screens.length, 6);
    for (const capture of screens) {
      const { report, pixels, file } = capture;
      // The capture is the window's backing bitmap: 1440×900 CSS pixels at the
      // display's scale. Checked against the page's own devicePixelRatio so the
      // assertion is about the window, not about the bitmap's byte size.
      assert.equal(pixels.width, 1440 * report.page.scale, `${file}: the window is not 1440 wide`);
      assert.equal(pixels.height, 900 * report.page.scale, `${file}: the window is not 900 tall`);
      assert.ok(pixels.colors > 40, `${file}: only ${pixels.colors} colours — the stylesheet is missing`);
      // The start button only exists on the card surface; where it does, it must
      // be the app's button and not a browser default.
      if (report.start) {
        assert.ok(report.start.radius !== "0px", `${file}: the start button is unstyled`);
        assert.ok(report.start.height >= 24, `${file}: the start button is a browser default`);
      }
      if (capture.kind === "cards") {
        assert.ok(report.card, `${file}: the card did not render`);
        assert.notEqual(report.card.borderWidth, "0px", `${file}: the card has no border`);
        assert.equal(report.reason.border, "2px", `${file}: the reason lost its rule`);
        assert.equal(report.readonly.text, "只读");
        assert.notEqual(report.readonly.border, "0px", `${file}: the read-only badge has no border`);
        // A separating gutter between the meta fields, not one concatenated line.
        for (const gap of report.metaSeparations) {
          assert.ok(gap >= 4, `${file}: the card's meta fields run together (${report.metaSeparations})`);
        }
      }
      if (capture.kind === "auto") {
        assert.match(report.auto.text, /只读开工 · 改动前会问你/);
        assert.equal(report.auto.borderStyle, "dashed", `${file}: the auto row lost its quiet style`);
      }
      if (capture.kind === "task") {
        assert.equal(report.header.text, "已中断");
        assert.equal(report.sidebar.text, "已中断");
        assert.equal(report.restart.text, "重新开工");
        assert.ok(report.restart.radius !== "0px", `${file}: the restart button is unstyled`);
      }
    }
    const written = screens.map((capture) => capture.file);
    assert.equal(new Set(written).size, 6, written.join(", "));
  },
);