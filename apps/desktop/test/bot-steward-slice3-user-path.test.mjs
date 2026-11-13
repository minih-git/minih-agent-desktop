import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * The steward's surfaces with a renameable name (employee mode 0.5), operated the
 * way a person operates them in a real Electron renderer:
 *
 * - the steward's conversation uses the **conversation topbar**, like every other
 *   chat — not the employee titlebar, which belongs to a workbench;
 * - every label that refers to that employee reads its **current name**: the task
 *   card's heading, the workbench row's origin, the seed hint. The default is
 *   `Super Agent`, and renaming it in Settings → Employees (a real click in the
 *   product's own form) renames all of them through the existing `botsChanged`
 *   event, with no reload and no second source of truth;
 * - a task the startup fence interrupted says 「已中断」 and its dot carries the
 *   same warning colour as the words, not the busy colour of the stage it was
 *   left in;
 * - the card states one effective permission level and keeps the 「只读」 badge.
 *
 * The screenshots are the point as much as the assertions: they are captured from
 * a window that loads the **real compiled stylesheet** (Tailwind v4 plus the same
 * `globals.css` cascade the app ships) with the **full app shell**, at 1440×900,
 * in zh-CN and en, in both themes.
 *
 * The host is stubbed at `window.minihAgent`, the same seam the renderer uses in
 * production, so the assertions are about what the person sees and what the app
 * asks the host to do.
 */

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const artifacts = join(root, ".artifacts", "bot-super-agent");

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
import { BotsSettingsPage } from "../../apps/desktop/src/features/bots/BotsSettingsPage";
import { EmployeeWorkbench } from "../../apps/desktop/src/features/bots/EmployeeWorkbench";
import { ConversationTopbar } from "../../apps/desktop/src/components/ConversationTopbar";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const resources = {};
for (const locale of ["zh-CN", "en"]) {
  resources[locale] = { translation: flattenCatalog(catalogs[locale]) };
}
await i18n.use(initReactI18next).init({
  lng: "zh-CN",
  fallbackLng: "en",
  keySeparator: false,
  resources,
  interpolation: { escapeValue: false },
});

const calls = [];
const listeners = new Map();
function emit(channel, payload) {
  for (const listener of listeners.get(channel) ?? []) listener(payload);
}

/** The roster the host answers with; a rename mutates it the way the host would. */
const bots = [
  {
    sessionId: "steward-1",
    title: "Super Agent",
    profile: {
      name: "Super Agent",
      duty: "派活、盯进度、回来汇报",
      permissionMode: "ask",
      mustAsk: [],
      observe: false,
      definition: "steward",
    },
    status: { kind: "idle" },
    projectPath: "/repo/minih-agent-desktop",
  },
  {
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
  },
];

const tasks = [
  {
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
  },
  {
    id: "task-done",
    shortId: "41",
    employeeSessionId: "bot-1",
    sessionId: "task-session-2",
    title: "员工看板页面",
    origin: "steward",
    stage: "person/accept",
    deliveryId: "delivery-2",
    deliveryStatus: "ready",
    projectPath: "/repo/minih-agent-desktop",
    branch: "feat/employee-board",
    workspaceStatus: "ready",
    deliveryMode: "pr",
    latestProgress: "验收 2/3",
    createdAt: "2026-11-11T09:00:00.000Z",
  },
];

function steward() {
  return bots.find((bot) => bot.profile.definition === "steward");
}

function cardDraft(cardHash) {
  return {
    id: "draft-1",
    sessionId: "steward-1",
    status: "proposed",
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
    cardHash: cardHash || "hash-1",
    sourceUtterance: "Desktop 加一个员工看板页面",
    targetSessionId: "bot-1",
    targetTitle: "Desktop 前端",
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
    if (channel === IPC.invoke.botList) return { ok: true, data: { bots } };
    if (channel === IPC.invoke.botUpdate) {
      // A rename writes the name and the session title, and tells everyone:
      // the roster on botsChanged, the session list on sessionsChanged.
      const target = bots.find((bot) => bot.sessionId === input.sessionId);
      const name = String(input.profile.name ?? "").trim();
      if (target && name) {
        target.profile.name = name;
        target.title = name;
      }
      emit(IPC.event.botsChanged, { reason: "status" });
      emit(IPC.event.sessionsChanged, { reason: "bot.updated" });
      return { ok: true, data: { session: { id: input.sessionId, title: name } } };
    }
    if (channel === IPC.invoke.sessionList) {
      // The host keeps a renamed employee's session title in step with its name.
      const name = steward().profile.name;
      return {
        ok: true,
        data: {
          sessions: sessions.map((session) =>
            session.id === "steward-1" ? { ...session, title: name } : session,
          ),
        },
      };
    }
    if (channel === IPC.invoke.taskCardList) {
      return { ok: true, data: { drafts: [cardDraft()] } };
    }
    if (channel === IPC.invoke.taskList) {
      const rows = input && input.employeeSessionId
        ? tasks.filter((task) => task.employeeSessionId === input.employeeSessionId)
        : tasks;
      return { ok: true, data: { tasks: rows } };
    }
    if (channel === IPC.invoke.projectList) {
      return { ok: true, data: { projects: [{ path: "/repo/minih-agent-desktop", name: "MiniH Agent Desktop" }] } };
    }
    return { ok: true, data: undefined };
  },
};

const sessions = [
  {
    id: "steward-1",
    title: "Super Agent",
    projectPath: "/repo/minih-agent-desktop",
    createdAt: "2026-11-10T09:00:00.000Z",
    updatedAt: "2026-11-12T09:05:00.000Z",
  },
  {
    id: "bot-1",
    title: "Desktop 前端",
    role: "bot",
    projectPath: "/repo/minih-agent-desktop",
    createdAt: "2026-11-11T09:00:00.000Z",
    updatedAt: "2026-11-12T09:00:00.000Z",
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
/** One shell, one React root: switching panes must not remount the sidebar. */
const view = { pane: "steward" };
const viewListeners = new Set();
function go(pane) {
  view.pane = pane;
  for (const listener of viewListeners) listener();
}

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
  // The real store re-reads the list through api.listSessions on the event;
  // nothing here updates a title by hand.
  refreshSessions: async () => {
    const result = await window.minihAgent.invoke(IPC.invoke.sessionList);
    useAppStore.setState({ sessions: result.data.sessions });
  },
  prefetchSession: async () => undefined,
  planningStates: {},
  navStack: [],
  navIndex: 0,
  navBack: noop,
});

const frame = () => new Promise(requestAnimationFrame);
async function settle(times) {
  for (let n = 0; n < (times || 3); n += 1) await frame();
}
async function until(predicate, label) {
  for (let n = 0; n < 300; n += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error("timed out waiting for " + label + ": " + document.body.textContent);
}
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

function conversation() {
  return React.createElement(
    "div",
    { className: "shot-turn" },
    React.createElement("p", { className: "shot-user" }, "Desktop 加一个员工看板页面，先只调研，别改代码。"),
    React.createElement(
      "p",
      { className: "shot-steward" },
      "好，卡片在下面。只有调研这类只读的活会自己开工，其他等你点。",
    ),
  );
}

function mainPane() {
  if (view.pane === "settings") {
    return React.createElement(
      "div",
      { className: "route-surface route-page shot-stack shot-scroll" },
      React.createElement(BotsSettingsPage, null),
    );
  }
  if (view.pane === "workbench") {
    return React.createElement(
      "div",
      { className: "route-surface route-page shot-stack" },
      React.createElement(EmployeeWorkbench, { employee: bots[1], onOpenTask: noop }),
    );
  }
  if (view.pane === "task") {
    return React.createElement(
      "div",
      { className: "route-surface route-page shot-stack" },
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

function Shell() {
  const [, forceUpdate] = React.useState(0);
  React.useEffect(() => {
    const listener = () => forceUpdate((value) => value + 1);
    viewListeners.add(listener);
    return () => viewListeners.delete(listener);
  }, []);
  // The real shell refreshes the session list on sessionsChanged
  // (useAppShellRuntime), which is the only way a renamed title reaches the
  // conversation topbar. Subscribing here keeps that link under test.
  React.useEffect(() => {
    const off = window.minihAgent.on(IPC.event.sessionsChanged, () => {
      void useAppStore.getState().refreshSessions();
    });
    return off;
  }, []);
  // The steward's chat and a task's session both show the conversation topbar;
  // only the employees page is a route of its own.
  const active = view.pane === "task" ? "task-session-1" : "steward-1";
  useAppStore.setState({ activeSessionId: active });
  return React.createElement(
    "div",
    { className: "app-shell" },
    React.createElement(
      "aside",
      { className: "sidebar sidebar-surface" },
      React.createElement(
        "div",
        { className: "shot-sidebar-body" },
        React.createElement(BotSidebarGroup, {
          activeSessionId: active,
          onOpenBot: noop,
          onOpenTask: noop,
        }),
      ),
    ),
    React.createElement(
      "section",
      { className: "main-pane" },
      React.createElement(ConversationTopbar, {
        sidebarCollapsed: false,
        workPanelOpen: false,
        onToggleSidebar: noop,
        onNewTask: noop,
        onOpenSearch: noop,
      }),
      mainPane(),
    ),
  );
}

let rootNode = null;
function mount() {
  const container = document.getElementById("root");
  container.innerHTML = "";
  rootNode = createRoot(container);
  flushSync(() => rootNode.render(React.createElement(Shell)));
}

const text = (node) => (node ? node.textContent.replace(/\s+/g, " ").trim() : null);
const button = (label) =>
  [...document.querySelectorAll("button")].find((node) => text(node) === label);
const callsTo = (channel) => calls.filter((call) => call.channel === channel);

document.documentElement.dataset.platform = "darwin";

/** Rename the steward the way a person does: Settings → Employees → edit → save. */
async function rename(next) {
  go("settings");
  const editButton = () =>
    [...document.querySelectorAll("button")].find(
      (node) =>
        node.getAttribute("aria-label") ===
        i18n.t("bots.settings.edit", { name: steward().profile.name }),
    );
  await until(() => editButton(), "the settings rows");
  flushSync(() => editButton().click());
  await until(() => document.querySelector(".bot-form input"), "the employee form");
  const input = document.querySelector(".bot-form input");
  flushSync(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = button(i18n.t("bots.settings.save"));
  flushSync(() => save.click());
  await until(() => callsTo(IPC.invoke.botUpdate).length > 0, "the rename call");
  await settle(4);
  return callsTo(IPC.invoke.botUpdate).at(-1).input;
}

window.stewardProbe = async () => {
  const report = { updates: [] };
  calls.length = 0;
  mount();
  await until(() => document.querySelector("[data-card-hash]"), "the card dock");
  await until(() => document.querySelector("[data-sidebar-bot-task]"), "the sidebar rows");

  // 1. Default name everywhere it appears.
  report.defaultCardTitle = text(document.querySelector(".task-card-header span"));
  report.defaultSidebarName = text(
    document.querySelector('[data-sidebar-bot-entry="steward-1"] .bot-entry-name, [data-sidebar-bot-entry="steward-1"] .sidebar-bot-name'),
  );
  // The card states one effective permission and keeps the read-only badge.
  report.cardMeta = [...document.querySelectorAll(".task-card-meta > *")].map(text);
  report.defaultConversationTitle = text(document.querySelector(".ct-title"));

  // 2. The workbench row names the steward for the work it sent.
  go("workbench");
  await until(() => document.querySelector("[data-employee-task]"), "the workbench rows");
  report.workbenchOrigin = [...document.querySelectorAll("[data-employee-task]")].map((row) => text(row)).join(" | ");

  // 3. The interrupted row's dot carries the warning colour of its words.
  const interruptedRow = document.querySelector('[data-sidebar-bot-task="task-interrupted"]');
  const dot = interruptedRow.querySelector(".sidebar-bot-task-dot");
  const stage = interruptedRow.querySelector(".sidebar-bot-task-stage");
  const probe = document.createElement("span");
  probe.style.color = "var(--ds-warning)";
  document.body.appendChild(probe);
  report.warningColor = getComputedStyle(probe).color;
  probe.remove();
  report.interruptedDot = getComputedStyle(dot).backgroundColor;
  report.interruptedWords = text(stage);

  // 4. A rename is one click path and reaches every label through botsChanged.
  report.updates.push(await rename("阿福"));
  go("steward");
  await until(
    () => text(document.querySelector(".task-card-header span"))?.startsWith("阿福"),
    "the renamed card heading",
  );
  report.renamedCardTitle = text(document.querySelector(".task-card-header span"));
  // The topbar reads the session list, so a rename only lands there if
  // bot.update announces sessionsChanged and the shell re-reads it.
  await until(
    () => text(document.querySelector(".ct-title")) === "阿福",
    "the renamed conversation title",
  );
  report.renamedConversationTitle = text(document.querySelector(".ct-title"));
  report.renamedSidebarName = text(
    document.querySelector('[data-sidebar-bot-entry="steward-1"] .bot-entry-name, [data-sidebar-bot-entry="steward-1"] .sidebar-bot-name'),
  );
  go("workbench");
  await until(() => document.querySelector("[data-employee-task]"), "the workbench rows again");
  report.renamedWorkbenchOrigin = [...document.querySelectorAll("[data-employee-task]")].map((row) => text(row)).join(" | ");

  // 5. And back: the name is a setting, not a migration.
  report.updates.push(await rename("Super Agent"));
  go("steward");
  await until(
    () => text(document.querySelector(".task-card-header span"))?.startsWith("Super Agent"),
    "the restored card heading",
  );
  report.restoredCardTitle = text(document.querySelector(".task-card-header span"));
  await until(
    () => text(document.querySelector(".ct-title")) === "Super Agent",
    "the restored conversation title",
  );
  report.restoredConversationTitle = text(document.querySelector(".ct-title"));
  return report;
};

window.stewardScreens = {
  /**
   * kind: cards | cards-renamed | workbench | task; locale: zh-CN | en.
   */
  async render(kind, theme, locale, stewardName) {
    document.documentElement.dataset.theme = theme;
    await i18n.changeLanguage(locale);
    const wanted = stewardName || "Super Agent";
    if (steward().profile.name !== wanted) {
      await rename(wanted);
    }
    const pane =
      kind === "workbench" ? "workbench" : kind === "task" ? "task" : "steward";
    if (!rootNode) mount();
    go(pane);
    await until(() => document.querySelector("[data-sidebar-bot-task]"), "the sidebar rows");
    if (pane === "steward") {
      await until(() => document.querySelector("[data-card-hash]"), "the card dock");
    }
    if (pane === "workbench") {
      await until(() => document.querySelector("[data-employee-task]"), "the workbench rows");
    }
    finishAnimations();
    await settle(2);
    return true;
  },

  measure() {
    const style = (node) => (node ? getComputedStyle(node) : null);
    const card = document.querySelector(".task-card");
    const stage = document.querySelector(".sidebar-bot-task-stage");
    const interrupted = document.querySelector('[data-sidebar-bot-task="task-interrupted"] .sidebar-bot-task-dot');
    const probe = document.createElement("span");
    probe.style.color = "var(--ds-warning)";
    document.body.appendChild(probe);
    const warning = getComputedStyle(probe).color;
    probe.remove();
    return {
      theme: document.documentElement.dataset.theme,
      locale: i18n.language,
      page: { width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio },
      stewardName: text(document.querySelector('[data-sidebar-bot-entry="steward-1"] .bot-entry-name, [data-sidebar-bot-entry="steward-1"] .sidebar-bot-name')),
      cardTitle: text(document.querySelector(".task-card-header span")),
      conversationTitle: text(document.querySelector(".ct-title")),
      card: card
        ? {
            radius: style(card).borderTopLeftRadius,
            borderWidth: style(card).borderTopWidth,
          }
        : null,
      meta: [...document.querySelectorAll(".task-card-meta > *")].map(text),
      workbenchOrigin: [...document.querySelectorAll(".employee-task-meta > span")].map(text).join(" | "),
      interrupted: interrupted
        ? {
            dot: style(interrupted).backgroundColor,
            words: text(stage),
            wordsColor: style(stage)?.color,
            matches: style(interrupted).backgroundColor === warning,
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

const HISTOGRAM = `(image) => {
  const { width, height } = image.getSize();
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
  const workDir = await mkdtemp(join(tmpdir(), "pi-super-agent-"));
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
        /* Harness-only layout: the app shell's columns, the sidebar scroller's
           padding and a composer area. No colours, no component styling — every
           pixel the captures prove comes from the app's compiled stylesheet. */
        html, body, #root { height: 100%; margin: 0; }
        body { background: var(--ds-bg-primary); color: var(--ds-text-primary); }
        .shot-sidebar-body { display: flex; min-height: 0; flex: 1; flex-direction: column;
          overflow: auto; padding: 42px 8px 12px; }
        .shot-stack { display: flex; min-height: 0; flex: 1; flex-direction: column;
          padding: 24px 32px 20px; }
        .shot-scroll { overflow: auto; }
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
      { kind: "cards", locale: "zh-CN", steward: "Super Agent", name: "steward-cards-zh" },
      { kind: "workbench", locale: "zh-CN", steward: "Super Agent", name: "steward-workbench-zh" },
      { kind: "task", locale: "zh-CN", steward: "Super Agent", name: "steward-task-zh" },
      { kind: "cards", locale: "en", steward: "Super Agent", name: "steward-cards-en" },
      { kind: "workbench", locale: "en", steward: "Super Agent", name: "steward-workbench-en" },
      { kind: "task", locale: "en", steward: "Super Agent", name: "steward-task-en" },
    ];
    const plan = ["dark", "light"].flatMap((theme) => shots.map((shot) => ({ theme, ...shot })));
    // The renamed surfaces: the same card, sidebar and conversation title, with
    // the name the person chose, in both themes. `-v2` replaces the captures
    // taken while the topbar still showed the previous name.
    for (const theme of ["dark", "light"]) {
      plan.push({ kind: "cards-renamed", locale: "zh-CN", theme, steward: "阿福", name: "steward-cards-renamed-v2" });
    }
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
    console.log("SUPER_AGENT_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.stewardProbe()")));
    const histogram = ${HISTOGRAM};
    const captures = [];
    for (const entry of plan) {
      await win.webContents.executeJavaScript("window.stewardScreens.render(" + JSON.stringify(entry.kind) + ", " + JSON.stringify(entry.theme) + ", " + JSON.stringify(entry.locale) + ", " + JSON.stringify(entry.steward) + ")");
      await new Promise((resolve) => setTimeout(resolve, 150));
      const image = await win.webContents.capturePage();
      const file = path.join(outDir, entry.name + "-" + entry.theme + ".png");
      writeFileSync(file, image.toPNG());
      const report = await win.webContents.executeJavaScript("window.stewardScreens.measure()");
      captures.push({ ...entry, file, pixels: histogram(image), report });
    }
    console.log("SUPER_AGENT_SCREENS " + JSON.stringify(captures));
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
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
    const probeLine = output.split(/\r?\n/).find((line) => line.startsWith("SUPER_AGENT_PROBE "));
    assert.ok(probeLine, output.slice(-6000));
    const screensLine = output.split(/\r?\n/).find((line) => line.startsWith("SUPER_AGENT_SCREENS "));
    assert.ok(screensLine, output.slice(-6000));
    const probe = JSON.parse(probeLine.slice("SUPER_AGENT_PROBE ".length));
    const screens = JSON.parse(screensLine.slice("SUPER_AGENT_SCREENS ".length));
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
  "employee mode 0.5: the steward's name is the employee's, and its labels follow a rename",
  { skip: displayMissing ? "Electron requires a display" : false },
  async () => {
    const stylesheet = await compileStylesheet(await mkdtemp(join(tmpdir(), "pi-bot-css-")));
    const { probe, screens } = await runInElectron(stylesheet);

    // 1. The default is what the crew seeds, and nothing writes it into copy.
    assert.equal(probe.defaultCardTitle, "Super Agent 给你的任务");
    assert.equal(probe.defaultSidebarName, "Super Agent");
    // The conversation topbar shows the session title, which `bot.update` keeps
    // in step with the name — the default, and both sides of the rename.
    assert.equal(probe.defaultConversationTitle, "Super Agent");
    // 2. One effective permission level, plus the read-only badge.
    assert.ok(
      probe.cardMeta.some((entry) => entry.startsWith("权限档")),
      `the card does not state its permission: ${probe.cardMeta}`,
    );
    assert.ok(probe.cardMeta.includes("只读"), `the card lost its read-only badge: ${probe.cardMeta}`);
    const askedTwice = probe.cardMeta.filter((entry) => /问你|会先问你/.test(entry));
    assert.equal(askedTwice.length, 1, `the same permission is stated twice: ${probe.cardMeta}`);
    // 3. The workbench row names the steward for the work it sent.
    assert.match(probe.workbenchOrigin, /Super Agent 派/);
    // 4. The interrupted row's dot and words share the warning colour.
    assert.equal(probe.interruptedWords, "已中断");
    assert.equal(
      probe.interruptedDot,
      probe.warningColor,
      `the interrupted dot is not the warning colour (${probe.interruptedDot} vs ${probe.warningColor})`,
    );
    // 5. Renaming the employee renames every label, through the existing event.
    assert.equal(probe.updates[0].profile.name, "阿福");
    assert.equal(probe.renamedCardTitle, "阿福 给你的任务");
    assert.equal(probe.renamedSidebarName, "阿福");
    assert.equal(probe.renamedConversationTitle, "阿福");
    assert.match(probe.renamedWorkbenchOrigin, /阿福 派/);
    // 6. And back: it is a setting, not a one-way migration.
    assert.equal(probe.updates[1].profile.name, "Super Agent");
    assert.equal(probe.restoredCardTitle, "Super Agent 给你的任务");
    assert.equal(probe.restoredConversationTitle, "Super Agent");

    // 7. Each capture is the app's own stylesheet at the reference window size.
    assert.equal(screens.length, 14);
    for (const capture of screens) {
      const { report, pixels, file } = capture;
      assert.equal(pixels.width, 1440 * report.page.scale, `${file}: the window is not 1440 wide`);
      assert.equal(pixels.height, 900 * report.page.scale, `${file}: the window is not 900 tall`);
      assert.ok(pixels.colors > 40, `${file}: only ${pixels.colors} colours — the stylesheet is missing`);
      assert.equal(report.interrupted.words, capture.locale === "en" ? "Interrupted" : "已中断");
      assert.equal(report.interrupted.matches, true, `${file}: the interrupted dot is not the warning colour`);
      if (capture.kind === "cards" || capture.kind === "cards-renamed") {
        assert.equal(report.stewardName, capture.steward);
        assert.equal(
          report.cardTitle,
          capture.locale === "en" ? `Task from ${capture.steward}` : `${capture.steward} 给你的任务`,
        );
        // The capture itself shows the name in the topbar, not only in the card.
        assert.equal(
          report.conversationTitle,
          capture.steward,
          `${file}: the topbar does not show the name`,
        );
        assert.equal(report.card.borderWidth !== "0px", true, `${file}: the card has no border`);
        const readOnlyWord = capture.locale === "en" ? "Read-only" : "只读";
        assert.equal(report.meta.includes(readOnlyWord), true, `${file}: the card lost its read-only badge`);
      }
      if (capture.kind === "workbench") {
        assert.match(
          report.workbenchOrigin,
          capture.locale === "en" ? /From Super Agent/ : /Super Agent 派/,
          `${file}: the workbench row does not name the steward: ${report.workbenchOrigin}`,
        );
      }
    }
    }
);