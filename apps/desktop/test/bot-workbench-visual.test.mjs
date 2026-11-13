import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * The employee workbench, the sidebar's task rows and the task session header,
 * as a picture and as measured layout.
 *
 * These three surfaces once shipped with no stylesheet rules at all, so the
 * workbench rendered as bare stacked elements. `bot-ui-class-styles.test.mjs`
 * stops that specific regression (a class with no rule); this file checks the
 * result a person actually sees: one dated row of field + repository + start,
 * tabs on one line with an underline under the selection, task cards with the
 * stage on the right, an indented sidebar task list, and the task header's
 * chips — in both themes, at 1440×900.
 *
 * It renders the production components against the real compiled stylesheet
 * (Tailwind v4 + the same `globals.css` cascade the app ships) inside a real
 * Electron window, then captures the window with `capturePage`. The PNGs land
 * in `.artifacts/bot-workbench/` for review; the assertions read computed
 * styles and geometry, so a colour or a column that quietly disappears fails
 * here even when the class still exists.
 */

const root = repositoryRoot();
const { build: bundle } = createRequire(join(root, "packages/agent-runtime/package.json"))(
  "esbuild",
);

/** Where the captures land: outside the source tree, never committed. */
const artifactRoot = join(root, ".artifacts", "bot-workbench");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { BotSidebarGroup } from "../../apps/desktop/src/features/bots/BotSidebarGroup";
import { EmployeeTitlebar } from "../../apps/desktop/src/features/bots/EmployeeTitlebar";
import { EmployeeWorkbench } from "../../apps/desktop/src/features/bots/EmployeeWorkbench";
import { ConversationTopbar } from "../../apps/desktop/src/components/ConversationTopbar";
import { ActiveTaskWorkspaceBanner } from "../../apps/desktop/src/features/bots/TaskWorkspaceBanner";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({
  lng: "zh-CN",
  keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } },
  interpolation: { escapeValue: false },
});

const employee = {
  sessionId: "router",
  title: "Router 后端",
  profile: {
    name: "Router 后端",
    duty: "网关、数据面与远端接入",
    permissionMode: "accept-edits",
    mustAsk: ["push", "deploy", "delete", "spend"],
    observe: false,
  },
  status: { kind: "idle" },
  projectPath: "/repo/Minih-Agent-Desktop",
  modelKey: "minih-router/gemini-3.8-pro",
  updatedAt: "2026-11-12T03:00:00.000Z",
  createdAt: "2026-11-01T00:00:00.000Z",
};

const waiting = {
  id: "task-0037", shortId: "37", employeeSessionId: "router", sessionId: "sess-0037",
  title: "修 E2E 超时", origin: "steward", stage: "person/accept",
  projectPath: "/repo/Minih-Agent-Desktop", branch: "fix/e2e-timeout",
  workspaceStatus: "ready", baseRef: "refs/remotes/origin/main", baseRemote: true,
  deliveryMode: "pr", latestProgress: "审批：推送分支到 GitHub（3 个提交）",
  createdAt: "2026-11-12T02:41:00.000Z",
};
const working = {
  id: "task-0041", shortId: "41", employeeSessionId: "router", sessionId: "sess-0041",
  title: "员工看板页面", origin: "direct", stage: "working",
  projectPath: "/repo/Minih-Agent-Desktop", branch: "feat/employee-board",
  workspaceStatus: "ready", baseRef: "refs/remotes/origin/main", baseRemote: true,
  deliveryMode: "pr", latestProgress: "验收 2/5 · 在写 BoardPage.tsx 的任务列表",
  createdAt: "2026-11-12T02:03:00.000Z",
};
const done = {
  id: "task-0012", shortId: "12", employeeSessionId: "router", sessionId: "sess-0012",
  title: "任务卡 Dock 不刷新", origin: "steward", stage: "person/accept",
  projectPath: "/repo/Minih-Agent-Desktop", workspaceStatus: "ready",
  deliveryMode: "pr", latestProgress: "PR #242（合并）· 验收 3/3 · 已归档",
  createdAt: "2026-11-11T01:00:00.000Z", archivedAt: "2026-11-11T09:20:00.000Z",
};
const failed = {
  ...waiting, workspaceStatus: "failed",
  workspaceError: "git worktree add 失败：磁盘空间不足",
};


window.minihAgent = {
  platform: "darwin",
  on: () => () => undefined,
  async invoke(channel, input) {
    if (channel === IPC.invoke.botList) return { ok: true, data: { bots: [employee] } };
    if (channel === IPC.invoke.taskList) {
      const rows = input && input.includeArchived ? tasks : tasks.filter((row) => !row.archivedAt);
      const filtered = input && input.employeeSessionId
        ? rows.filter((row) => row.employeeSessionId === input.employeeSessionId)
        : rows;
      return { ok: true, data: { tasks: filtered } };
    }
    if (channel === IPC.invoke.projectList) {
      return {
        ok: true,
        data: {
          projects: [
            { path: "/repo/Minih-Agent-Desktop", name: "Minih-Agent-Desktop" },
            { path: "/repo/Minih-Router", name: "Minih-Router" },
          ],
        },
      };
    }
    return { ok: true, data: undefined };
  },
};

const sessions = [
  { id: "router", title: "Router 后端", role: "bot", projectPath: "/repo/Minih-Agent-Desktop",
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-12T03:00:00.000Z" },
  { id: "sess-0037", title: "修 E2E 超时", role: "task", projectPath: "/repo/Minih-Agent-Desktop",
    createdAt: "2026-11-12T02:41:00.000Z", updatedAt: "2026-11-12T02:50:00.000Z" },
];
let tasks = [waiting, working, done];

useAppStore.setState({
  sessions,
  activeSessionId: "sess-0037",
  selectSession: async () => undefined,
  sendPrompt: async () => true,
  projectMeta: {},
  workspace: { path: "/repo/Minih-Agent-Desktop", name: "Minih-Agent-Desktop" },
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
  navStack: [],
  navIndex: 0,
  navBack: () => undefined,
});

const noop = () => undefined;
const frame = () => new Promise(requestAnimationFrame);
async function settle(count = 3) { for (let n = 0; n < count; n += 1) await frame(); }
/** Wait for a surface's data to land; a React render alone is not enough. */
async function until(predicate, label) {
  for (let n = 0; n < 300; n += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error("timed out waiting for " + label + ": " + document.body.textContent);
}

let rootNode = null;
function mount(element) {
  const container = document.getElementById("root");
  if (rootNode) flushSync(() => rootNode.unmount());
  container.innerHTML = "";
  rootNode = createRoot(container);
  flushSync(() => rootNode.render(element));
}

function shell({ sidebar, band, main }) {
  return React.createElement(
    "div",
    { className: "app-shell" },
    React.createElement(
      "aside",
      { className: "sidebar sidebar-surface" },
      React.createElement("div", { className: "shot-sidebar-body" }, sidebar),
    ),
    React.createElement("section", { className: "main-pane" }, band, main),
  );
}

const sidebar = () => React.createElement(BotSidebarGroup, {
  bots: [employee],
  tasks,
  activeSessionId: "sess-0037",
  onOpenBot: noop,
  onOpenTask: noop,
});
const titlebar = () => React.createElement(EmployeeTitlebar, {
  employee,
  sidebarCollapsed: false,
  workPanelOpen: false,
  sidebarToggleShortcut: "⌘B",
  onToggleSidebar: noop,
  onNewTask: noop,
});
const taskTopbar = () => React.createElement(ConversationTopbar, {
  sidebarCollapsed: false,
  workPanelOpen: false,
  onToggleSidebar: noop,
  onNewTask: noop,
  onOpenSearch: noop,
});
const workbench = () => React.createElement(
  "div",
  { className: "route-surface route-page" },
  React.createElement(EmployeeWorkbench, { employee, onOpenTask: noop }),
);

const surfaces = {
  "workbench-tasks": () => shell({ sidebar: sidebar(), band: titlebar(), main: workbench() }),
  "workbench-done": () => shell({ sidebar: sidebar(), band: titlebar(), main: workbench() }),
  "sidebar-history": () => shell({ sidebar: sidebar(), band: titlebar(), main: workbench() }),
  "task-session": () =>
    shell({ sidebar: sidebar(), band: taskTopbar(), main: React.createElement(ActiveTaskWorkspaceBanner) }),
  "task-session-failed": () =>
    shell({ sidebar: sidebar(), band: taskTopbar(), main: React.createElement(ActiveTaskWorkspaceBanner) }),
};

function cssVar(name) {
  const probe = document.createElement("span");
  probe.style.color = "var(" + name + ")";
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}
const box = (element) => {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
};
const words = (element) => (element ? element.textContent.replace(/\s+/g, " ").trim() : null);
const ink = (element) => (element ? getComputedStyle(element).color : null);

window.shot = {
  async render(kind, theme) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.platform = "darwin";
    tasks = kind === "task-session-failed" ? [failed, working, done] : [waiting, working, done];
    mount(surfaces[kind]());
    await until(() => document.querySelector("[data-sidebar-bot-task]"), "the sidebar task rows");
    if (kind.startsWith("task-session")) {
      await until(() => document.querySelector("[data-task-header]"), "the task header");
    } else {
      await until(
        () => document.querySelector("[data-employee-task]") || document.querySelector(".employee-workbench-empty"),
        "the workbench rows",
      );
    }
    await settle();
    if (kind === "workbench-done") {
      document.querySelector('[data-workbench-tab="done"]').click();
      await settle();
    }
    if (kind === "sidebar-history") {
      document.querySelector('[data-action="toggle-bot-task-history"]').click();
      await settle();
    }
    return true;
  },

  measure(kind) {
    const report = {
      theme: document.documentElement.dataset.theme,
      tokens: {
        warning: cssVar("--ds-warning"),
        success: cssVar("--ds-success"),
        error: cssVar("--ds-error"),
        busy: cssVar("--ds-prose-accent"),
        textPrimary: cssVar("--ds-text-primary"),
        textMuted: cssVar("--ds-text-muted"),
        textFaint: cssVar("--ds-text-faint"),
        bgPrimary: cssVar("--ds-bg-primary"),
      },
      page: {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        /* On darwin the shell itself is deliberately transparent (the window
           vibrancy material is behind it), so the pane is what carries the
           theme surface. */
        mainPaneBackground: getComputedStyle(document.querySelector(".main-pane")).backgroundColor,
      },
    };

    const bench = document.querySelector(".employee-workbench");
    if (bench) {
      const style = getComputedStyle(bench);
      report.workbench = {
        overflowY: style.overflowY,
        paddingTop: Math.round(parseFloat(style.paddingTop)),
        paddingLeft: Math.round(parseFloat(style.paddingLeft)),
        scrolls: bench.scrollHeight > bench.clientHeight,
        avatar: box(document.querySelector(".employee-workbench-avatar")),
        name: {
          text: words(document.querySelector(".employee-workbench-title h1")),
          size: parseFloat(getComputedStyle(document.querySelector(".employee-workbench-title h1")).fontSize),
          weight: getComputedStyle(document.querySelector(".employee-workbench-title h1")).fontWeight,
        },
        sub: words(document.querySelector(".employee-workbench-sub")),
        waiting: {
          text: words(document.querySelector(".employee-workbench-waiting")),
          color: ink(document.querySelector(".employee-workbench-waiting")),
          attention: document.querySelector(".employee-workbench-waiting").classList.contains("attention"),
        },
        newTask: {
          border: getComputedStyle(document.querySelector(".employee-workbench-new")).borderTopStyle,
          box: box(document.querySelector(".employee-workbench-new")),
          field: box(document.querySelector("[data-workbench-new-task]")),
          repository: box(document.querySelector("[data-workbench-repository]")),
          start: box(document.querySelector("[data-workbench-start]")),
          hint: {
            text: words(document.querySelector(".employee-workbench-new-hint")),
            size: parseFloat(getComputedStyle(document.querySelector(".employee-workbench-new-hint")).fontSize),
            color: ink(document.querySelector(".employee-workbench-new-hint")),
          },
        },
        tabs: [...document.querySelectorAll("[data-workbench-tab]")].map((tab) => ({
          id: tab.dataset.workbenchTab,
          box: box(tab),
          selected: tab.getAttribute("aria-selected") === "true",
          underline: getComputedStyle(tab).borderBottomColor,
          count: words(tab.querySelector(".employee-workbench-tab-count")),
        })),
        groups: [...document.querySelectorAll(".employee-task-group h2")].map((heading) => ({
          text: words(heading),
          size: parseFloat(getComputedStyle(heading).fontSize),
          transform: getComputedStyle(heading).textTransform,
          color: ink(heading),
        })),
        rows: [...document.querySelectorAll("[data-employee-task]")].map((row) => ({
          id: row.dataset.employeeTask,
          stage: row.dataset.taskStage,
          archived: row.dataset.taskArchived !== undefined,
          box: box(row),
          radius: getComputedStyle(row).borderTopLeftRadius,
          background: getComputedStyle(row).backgroundColor,
          title: box(row.querySelector(".employee-task-title")),
          meta: box(row.querySelector(".employee-task-meta")),
          stageText: words(row.querySelector(".employee-task-stage")),
          stageColor: ink(row.querySelector(".employee-task-stage")),
          progress: words(row.querySelector(".employee-task-progress")),
        })),
        empty: [...document.querySelectorAll(".employee-workbench-empty")].map(words),
      };
    }

    const entry = document.querySelector("[data-sidebar-bot-entry]");
    if (entry) {
      report.sidebar = {
        entry: box(entry),
        employeeRow: box(document.querySelector("[data-sidebar-bot-row]")),
        count: {
          text: words(document.querySelector("[data-bot-open-count]")),
          color: ink(document.querySelector("[data-bot-open-count]")),
        },
        list: {
          paddingLeft: Math.round(parseFloat(getComputedStyle(document.querySelector(".bot-task-list")).paddingLeft)),
          box: box(document.querySelector(".bot-task-list")),
        },
        tasks: [...document.querySelectorAll("[data-sidebar-bot-task]")].map((row) => ({
          id: row.dataset.sidebarBotTask,
          tone: row.dataset.taskTone,
          archived: row.classList.contains("archived"),
          title: words(row.querySelector(".sidebar-bot-task-title")),
          stage: words(row.querySelector(".sidebar-bot-task-stage")),
          stageColor: ink(row.querySelector(".sidebar-bot-task-stage")),
          dot: getComputedStyle(row.querySelector(".sidebar-bot-task-dot")).backgroundColor,
          box: box(row),
        })),
        history: {
          exists: !!document.querySelector('[data-action="toggle-bot-task-history"]'),
          text: words(document.querySelector('[data-action="toggle-bot-task-history"]')),
          color: ink(document.querySelector('[data-action="toggle-bot-task-history"]')),
        },
      };
    }

    const band = document.querySelector(".conversation-topbar, .main-titlebar");
    if (band) {
      const bandRect = band.getBoundingClientRect();
      // Anything the band draws has to stay inside it: the row is one fixed
      // height, so a chip or a button that hangs past it is clipped by the
      // window instead of by the band. The collapsed-sidebar slot is hidden on
      // purpose (zero width, no pointer events), so it is not a leak.
      const leaking = [...band.querySelectorAll("*")]
        .filter((node) => {
          if (node.closest('[aria-hidden="true"]')) return false;
          const style = getComputedStyle(node);
          if (style.visibility === "hidden" || style.opacity === "0") return false;
          const rect = node.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          return (
            rect.left < bandRect.left - 1 ||
            rect.right > bandRect.right + 1 ||
            rect.top < bandRect.top - 1 ||
            rect.bottom > bandRect.bottom + 1
          );
        })
        .map((node) => node.tagName.toLowerCase() + "." + String(node.className || ""));
      // A chip the header dropped for width has no box; it is not part of the row.
      const visibleChips = [...band.querySelectorAll(".ct-chip")].filter(
        (chip) => chip.getBoundingClientRect().width > 0,
      );
      report.band = {
        className: band.className,
        box: box(band),
        heading: words(band.querySelector(".main-titlebar-heading")),
        headingTitle: words(band.querySelector(".main-titlebar-title")),
        headingSub: words(band.querySelector(".main-titlebar-sub")),
        title: words(band.querySelector(".ct-title")),
        titleBox: box(band.querySelector(".ct-title")),
        breadcrumb: words(band.querySelector(".ct-project-name")),
        meta: box(band.querySelector(".ct-task-meta")),
        chips: visibleChips.map((chip) => ({
          text: words(chip),
          color: ink(chip),
          border: getComputedStyle(chip).borderTopColor,
          radius: getComputedStyle(chip).borderTopLeftRadius,
          box: box(chip),
        })),
        leaking,
        carriesError: Boolean(band.querySelector("[data-task-workspace-error]")),
        carriesRetry: Boolean(band.querySelector("[data-task-workspace-retry]")),
        archive: Boolean(band.querySelector("[data-task-archive]")),
        archiveText: words(band.querySelector("[data-task-archive]")),
        archiveBox: box(band.querySelector("[data-task-archive]")),
      };
    }

    const banner = document.querySelector("[data-task-workspace-banner]");
    if (banner) {
      report.banner = {
        box: box(banner),
        borderStyle: getComputedStyle(banner).borderTopStyle,
        borderColor: getComputedStyle(banner).borderTopColor,
        error: words(banner.querySelector(".task-workspace-error")),
        errorColor: ink(banner.querySelector(".task-workspace-error")),
        retry: {
          text: words(banner.querySelector("[data-task-workspace-retry]")),
          box: box(banner.querySelector("[data-task-workspace-retry]")),
        },
      };
    }
    return report;
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

/**
 * A capture's colour spread: a blank or wrongly loaded page collapses to one or
 * two values, which is how a missing stylesheet or a mis-sized window shows up.
 */
const HISTOGRAM = `(image) => {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  const seen = new Set();
  let luma = 0;
  let samples = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const offset = (y * width + x) * 4;
      seen.add(String(bitmap[offset]) + "," + String(bitmap[offset + 1]) + "," + String(bitmap[offset + 2]));
      luma += 0.2126 * bitmap[offset] + 0.7152 * bitmap[offset + 1] + 0.0722 * bitmap[offset + 2];
      samples += 1;
    }
  }
  return { colors: seen.size, luma: Math.round(luma / Math.max(1, samples)), width, height };
}`;

async function runCaptures(stylesheet) {
  const workDir = await mkdtemp(join(tmpdir(), "pi-bot-workbench-"));
  await mkdir(artifactRoot, { recursive: true });
  try {
    await bundle({
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
        /* Harness-only frame around the real surfaces: the app shell's own
           two-column layout, plus the padding a sidebar scroller would have. */
        html, body, #root { height: 100%; margin: 0; }
        body { background: var(--ds-bg-primary); color: var(--ds-text-primary); }
        .shot-sidebar-body { display: flex; min-height: 0; flex: 1; flex-direction: column;
          overflow: auto; padding: 42px 8px 12px; }
      </style>
      <link rel="stylesheet" href="${stylesheet}">
      <div id="root"></div><script type="module" src="renderer.js"></script>`,
    );

    const shots = ["workbench-tasks", "workbench-done", "sidebar-history", "task-session", "task-session-failed"];
    const themes = ["dark", "light"];
    /*
     * Two widths: the desktop reference, and a narrow one where the task header
     * has to shed chips instead of growing a second row.
     */
    const plan = themes.flatMap((theme) => [
      ...shots.map((shot) => ({ theme, shot, width: 1440 })),
      { theme, shot: "task-session-failed", width: 1024 },
    ]);
    await writeFile(
      join(workDir, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const schedule = ${JSON.stringify(plan)};
const outDir = ${JSON.stringify(artifactRoot)};
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) console.error("RENDERER " + message); });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    win.setContentSize(1440, 900);
    await win.webContents.executeJavaScript("new Promise((resolve, reject) => { const deadline = Date.now() + 20000; (function check() { if (window.shot) return resolve(true); if (Date.now() > deadline) return reject(new Error('fixture did not mount')); requestAnimationFrame(check); })(); })");
    const histogram = ${HISTOGRAM};
    for (const entry of schedule) {
      win.setContentSize(entry.width, 900);
      await win.webContents.executeJavaScript("window.shot.render(" + JSON.stringify(entry.shot) + ", " + JSON.stringify(entry.theme) + ")");
      await new Promise((resolve) => setTimeout(resolve, 150));
      const image = await win.webContents.capturePage();
      const file = path.join(outDir, entry.theme + "-" + entry.shot + (entry.width === 1440 ? "" : "-" + entry.width) + "-v2.png");
      writeFileSync(file, image.toPNG());
      const pixels = histogram(image);
      const report = await win.webContents.executeJavaScript("window.shot.measure(" + JSON.stringify(entry.shot) + ")");
      console.log("SHOT " + JSON.stringify({ ...entry, file, pixels, report }));
    }
    app.exit(0);
  } catch (error) {
    console.error(error?.stack ?? error);
    app.exit(1);
  }
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
    const captures = output
      .split(/\r?\n/)
      .filter((line) => line.startsWith("SHOT "))
      .map((line) => JSON.parse(line.slice("SHOT ".length)));
    assert.equal(captures.length, plan.length, output.slice(-6000));
    return captures;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const displayMissing = process.platform === "linux" && !process.env.DISPLAY;

test(
  "the workbench, the sidebar's task rows and the task header render as laid out, in both themes",
  { skip: displayMissing ? "Electron requires a display" : false },
  async (t) => {
    const stylesheet = await compileStylesheet(await mkdtemp(join(tmpdir(), "pi-bot-css-")));
    const captures = await runCaptures(stylesheet);
    const shot = (theme, name) => {
      const hit = captures.find((entry) => entry.theme === theme && entry.shot === name);
      assert.ok(hit, `missing capture ${theme}/${name}`);
      return hit;
    };

    await t.test("every capture is a full frame with a rendered page", () => {
      for (const entry of captures) {
        const { width, height } = entry.pixels;
        assert.equal(entry.report.page.innerWidth, entry.width, `${entry.theme}/${entry.shot} viewport width`);
        assert.equal(entry.report.page.innerHeight, 900, `${entry.theme}/${entry.shot} viewport height`);
        // The capture is in device pixels; only its shape has to match here.
        assert.ok(
          width >= entry.width && Math.abs(width / height - entry.width / 900) < 0.01,
          `${entry.theme}/${entry.shot} captured ${width}x${height}`,
        );
        assert.ok(entry.pixels.colors > 40, `${entry.theme}/${entry.shot} painted only ${entry.pixels.colors} colours`);
        assert.ok(
          entry.report.page.scrollWidth <= entry.report.page.innerWidth + 1,
          `${entry.theme}/${entry.shot} overflows horizontally (${entry.report.page.scrollWidth} > ${entry.report.page.innerWidth})`,
        );
      }
    });

    await t.test("dark is dark and light is light", () => {
      const dark = shot("dark", "workbench-tasks").pixels.luma;
      const light = shot("light", "workbench-tasks").pixels.luma;
      assert.ok(dark < 90, `dark frame is too bright (${dark})`);
      assert.ok(light > 180, `light frame is too dark (${light})`);
    });

    for (const theme of ["dark", "light"]) {
      await t.test(`workbench header, new-task row and tabs hold their layout (${theme})`, () => {
        const report = shot(theme, "workbench-tasks").report;
        const bench = report.workbench;
        assert.ok(bench, "the workbench did not mount");
        assert.equal(report.page.mainPaneBackground, report.tokens.bgPrimary, "the pane is not on the theme surface");
        // Header: an avatar, the name a step larger, the duty line, the count.
        assert.ok(bench.avatar && bench.avatar.w >= 36, "the header shows no avatar");
        assert.ok(bench.name.size >= 16, `the employee name is not the larger size (${bench.name.size}px)`);
        assert.equal(bench.name.weight, "600", "the employee name is not bold");
        assert.match(
          bench.sub,
          /网关、数据面与远端接入·minih-router\/gemini-3\.8-pro·免确认改文件·全部仓库/,
          "the header does not read as duty · model · permission · scope: " + bench.sub,
        );
        assert.match(bench.waiting.text, /1 件等你/, "the header does not say how many are waiting");
        assert.equal(bench.waiting.attention, true, "a waiting task is not marked as attention");
        assert.equal(bench.waiting.color, report.tokens.warning, "the waiting count is not the warning colour");

        // New task: one row — field takes the room, repository and start follow it.
        const { field, repository, start } = bench.newTask;
        assert.equal(bench.newTask.border, "dashed", "the new-task block is not a dashed frame");
        assert.ok(field && repository && start, "the new-task row is missing a control");
        const centres = [field, repository, start].map((item) => item.y + item.h / 2);
        assert.ok(
          Math.max(...centres) - Math.min(...centres) <= 3,
          `the three controls are not on one line (${centres.join(", ")})`,
        );
        assert.ok(start.x > repository.x && repository.x > field.x + field.w - 4, "the controls are not left to right");
        assert.ok(field.w > repository.w * 1.5, "the field does not take the remaining width");
        assert.ok(bench.newTask.hint.size <= 12, "the hint is not the small size");
        assert.equal(bench.newTask.hint.color, report.tokens.textFaint, "the hint is not the faint ink");

        // Tabs: one row, increasing lefts, the selection underlined.
        const tabs = bench.tabs;
        assert.equal(tabs.length, 4, "the workbench lost a tab");
        assert.ok(
          Math.max(...tabs.map((tab) => tab.box.y)) - Math.min(...tabs.map((tab) => tab.box.y)) <= 2,
          "the tabs are not on one line",
        );
        assert.deepEqual(tabs.map((tab) => tab.id), ["tasks", "done", "profile", "memory"]);
        for (let index = 1; index < tabs.length; index += 1) {
          assert.ok(tabs[index].box.x > tabs[index - 1].box.x, "the tabs are not laid out left to right");
        }
        const selected = tabs.find((tab) => tab.selected);
        assert.ok(selected, "no tab is selected");
        assert.notEqual(selected.underline, "rgba(0, 0, 0, 0)", "the selected tab has no underline");

        // Groups: small, quiet, uppercased words.
        assert.deepEqual(bench.groups.map((group) => group.text), ["等你", "进行中"]);
        for (const group of bench.groups) {
          assert.ok(group.size <= 12, `a group title is not small (${group.size}px)`);
          assert.equal(group.transform, "uppercase", "a group title is not uppercased");
          assert.equal(group.color, report.tokens.textFaint, "a group title is not the faint ink");
        }

        // Rows: cards, stage on the right, and the task's own word for it.
        assert.equal(bench.rows.length, 2, "the tasks tab shows the wrong number of rows");
        for (const row of bench.rows) {
          assert.ok(row.box.h >= 44, `a task row is too short (${row.box.h}px)`);
          assert.notEqual(row.radius, "0px", "a task row is not a card");
          assert.ok(row.meta.x > row.title.x + row.title.w - 6, "the stage column is not on the right");
          assert.ok(row.progress, "a task row lost its latest step");
        }
        const waitingRow = bench.rows.find((row) => row.stage === "person/accept");
        const workingRow = bench.rows.find((row) => row.stage === "working");
        assert.equal(waitingRow.stageText, "待验收", "a task waiting for review does not say so");
        assert.equal(waitingRow.stageColor, report.tokens.warning, "the waiting stage is not orange");
        assert.equal(workingRow.stageText, "进行中", "a working task reads as the employee, not the task");
        assert.equal(workingRow.stageColor, report.tokens.busy, "the in-progress stage is not blue");
      });

      await t.test(`the band names the employee instead of the last conversation (${theme})`, () => {
        const bands = shot(theme, "workbench-tasks").report.band;
        assert.ok(bands, "the workbench has no titlebar band");
        assert.match(bands.className, /main-titlebar/, "the workbench kept the conversation band");
        assert.equal(bands.headingTitle, "Router 后端", "the band does not name the employee");
        assert.equal(bands.headingSub, "工作台", "the band does not name the surface");
        assert.equal(bands.title, null, "the band still shows a conversation title");
        assert.equal(bands.breadcrumb, null, "the band still shows the previous conversation's breadcrumb");
        assert.equal(bands.chips.length, 0, "the band still shows conversation chips");
      });

      await t.test(`the done tab colours finished rows green (${theme})`, () => {
        const report = shot(theme, "workbench-done").report;
        const rows = report.workbench.rows;
        assert.equal(rows.length, 1, "the done tab does not show the finished task");
        assert.equal(rows[0].archived, true, "the finished task is not marked archived");
        assert.equal(rows[0].stageText, "待验收", "a finished task does not name its stage");
        assert.equal(rows[0].stageColor, report.tokens.success, "a finished task is not green");
      });
      await t.test(`the sidebar indents its task rows and shows history (${theme})`, () => {
        const report = shot(theme, "sidebar-history").report;
        const side = report.sidebar;
        assert.ok(side, "the employee group did not mount");
        assert.equal(side.count.text, "2", "the employee row does not count its open tasks");
        assert.equal(side.count.color, report.tokens.textMuted, "the open count is not the quiet ink");
        assert.ok(side.list.paddingLeft >= 12, `the task list is not indented (${side.list.paddingLeft}px)`);
        assert.ok(side.tasks.length >= 3, "the expanded list lost a row");
        const waitingTask = side.tasks.find((row) => row.tone === "attention" && !row.archived);
        assert.ok(waitingTask, "the waiting task is not in the sidebar");
        assert.equal(waitingTask.stageColor, report.tokens.warning, "the waiting task is not orange in the sidebar");
        assert.equal(waitingTask.dot, report.tokens.warning, "the waiting task's dot is not orange");
        const historyRow = side.tasks.find((row) => row.archived);
        assert.ok(historyRow, "opening history revealed no archived row");
        assert.match(historyRow.stage, /已归档/, "the archived row does not say so");
        assert.equal(side.history.text, "历史（1）", "the history row is missing its count");
        assert.equal(side.history.color, report.tokens.textFaint, "the history row is not the quiet ink");
        for (const row of side.tasks) {
          assert.ok(row.box.x > side.employeeRow.x + 8, "a task row is not indented under its employee");
          assert.ok(row.box.h >= 20 && row.box.h <= 32, `a sidebar task row is the wrong pitch (${row.box.h}px)`);
        }
      });

      await t.test(`the task header is one row of chips (${theme})`, () => {
        const report = shot(theme, "task-session").report;
        const band = report.band;
        assert.ok(band, "the task header did not mount");
        assert.match(band.className, /conversation-topbar/, "a task session lost its conversation band");
        assert.equal(band.title, "修 E2E 超时", "the header does not name the task");
        const texts = band.chips.map((chip) => chip.text);
        assert.match(
          texts.join(" | "),
          /Router 后端 @ Minih-Agent-Desktop/,
          "the header does not name the employee and repository",
        );
        // The task's own vocabulary, not the employee's status words.
        assert.ok(texts.includes("待验收"), `the header lost the task's stage word: ${texts.join(" | ")}`);
        assert.ok(!texts.includes("等你处理"), "the header reads the employee's status, not the task's stage");
        const tops = band.chips.map((chip) => chip.box.y);
        assert.ok(Math.max(...tops) - Math.min(...tops) <= 2, "the chips are not one row");
        const xs = band.chips.map((chip) => chip.box.x);
        assert.deepEqual([...xs].sort((a, b) => a - b), xs, "the chips are not laid out left to right");
        for (const chip of band.chips) {
          assert.notEqual(chip.radius, "0px", "a chip has no rounding");
          assert.notEqual(chip.color, report.tokens.textPrimary, "a chip is shouting in primary ink");
        }
        const stageChip = band.chips.find((chip) => chip.text === "待验收");
        assert.equal(stageChip.color, report.tokens.warning, "the waiting stage chip is not orange");

        // A ready workspace puts nothing but chips in the band, and nothing the
        // band draws may hang outside it.
        assert.equal(band.carriesError, false, "the band carries the whole error text");
        assert.equal(band.carriesRetry, false, "the band carries the retry button");
        assert.equal(report.banner, undefined, "a ready workspace shows a banner");
        assert.deepEqual(band.leaking, [], "something in the band hangs outside it");

        // Archiving is an action beside the other actions, not a chip.
        assert.equal(band.archive, true, "the task header lost its archive control");
        assert.match(band.archiveText, /归档任务/, "the archive control is not labelled");
        assert.ok(
          band.archiveBox.y >= band.box.y - 1 &&
            band.archiveBox.y + band.archiveBox.h <= band.box.y + band.box.h + 1,
          "the archive action hangs outside the band",
        );
        assert.ok(!texts.includes("归档任务"), "the archive action still reads as one more chip");
      });

      await t.test(`a failed workspace keeps one red chip and says the rest below the band (${theme})`, () => {
        const report = shot(theme, "task-session-failed").report;
        const band = report.band;
        assert.ok(band, "the failed task header did not mount");
        const failedChip = band.chips.find((chip) => chip.text === "工作区准备失败");
        assert.ok(failedChip, `the band lost the failed-workspace chip: ${band.chips.map((chip) => chip.text).join(" | ")}`);
        assert.equal(failedChip.color, report.tokens.error, "the failed-workspace chip is not red");
        assert.equal(band.carriesError, false, "the band still carries the error text");
        assert.equal(band.carriesRetry, false, "the band still carries the retry button");
        assert.deepEqual(band.leaking, [], "something in the band hangs outside it");

        const banner = report.banner;
        assert.ok(banner, "a failed workspace shows no banner");
        assert.equal(banner.errorColor, report.tokens.error, "the workspace failure is not red");
        assert.match(banner.error, /磁盘空间不足/, "the failure reason is not shown");
        assert.match(banner.retry.text, /重试准备/, "the retry control is not labelled for what it does");
        assert.ok(banner.retry.box.w > 0 && banner.retry.box.h > 0, "the retry control has no size");
        assert.equal(banner.borderStyle, "solid", "the banner has no border");
        const bandEnd = band.box.y + band.box.h;
        assert.ok(
          banner.box.y >= bandEnd - 1,
          `the banner overlaps the band (banner y ${banner.box.y}, band ends ${bandEnd})`,
        );
        assert.ok(
          banner.box.x >= -1 && banner.box.x + banner.box.w <= report.page.innerWidth + 1,
          "the banner runs past the window",
        );
      });

      await t.test(`a narrow window sheds chips instead of overflowing (${theme})`, () => {
        const narrow = captures.find(
          (entry) => entry.theme === theme && entry.shot === "task-session-failed" && entry.width === 1024,
        );
        assert.ok(narrow, `missing the 1024 capture for ${theme}`);
        assert.equal(narrow.report.page.innerWidth, 1024, "the narrow frame is not 1024 wide");
        const band = narrow.report.band;
        const texts = band.chips.map((chip) => chip.text);
        assert.deepEqual(band.leaking, [], "something in the narrow band hangs outside it");
        // The two chips the person must not lose, and nothing that made it wrap.
        assert.ok(texts.some((text) => /Router 后端 @ Minih-Agent-Desktop/.test(text)), "the narrow band lost who and where");
        assert.ok(texts.includes("待验收"), "the narrow band lost the task's stage");
        assert.ok(!texts.includes("fix/e2e-timeout"), "the narrow band kept the branch");
        assert.ok(!texts.includes("#37"), "the narrow band kept the short id");
        assert.ok(band.titleBox.w >= 90, `the task title kept only ${band.titleBox.w}px`);
        const banner = narrow.report.banner;
        assert.ok(banner, "the narrow frame lost the banner");
        assert.ok(banner.box.y >= band.box.y + band.box.h - 1, "the narrow banner overlaps the band");
        assert.ok(banner.box.x >= -1 && banner.box.x + banner.box.w <= 1025, "the narrow banner runs past the window");
      });
    }
  },
);