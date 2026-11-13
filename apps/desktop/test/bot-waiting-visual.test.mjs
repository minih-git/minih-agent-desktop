import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * The waiting channel's six screens, captured from the real stylesheet
 * (employee mode 0.5 slice 4a).
 *
 * The pictures are the deliverable this test protects: dark and light, 1440 and
 * 1024, with the shipped Tailwind/Vite stylesheet compiled from
 * `apps/desktop/src/styles/globals.css` — not a hand-written approximation. Each
 * capture calls `finishAnimations()` first, because a route surface fades in over
 * ~200 ms and a mid-fade capture paints everything under a veil.
 *
 * The six screens are the six ways the waiting channel reaches the person:
 *   1. the task session, with its question card and the header saying 等你;
 *   2. the steward's dock row, with the question's own options inline;
 *   3. the task session's blocked card;
 *   4. the steward's dock holding that blocked card;
 *   5. the sidebar's 「等你 N 件」 and the list it opens;
 *   6. the dock when the pending request cannot be read here.
 */

const root = repositoryRoot();
const { build: bundle } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const artifactRoot = join(root, ".artifacts", "bot-waiting");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { ConversationTopbar } from "../../apps/desktop/src/components/ConversationTopbar";
import { AskToolCard } from "../../apps/desktop/src/components/AskToolCard";
import { StewardTaskDock, TaskBlockedCardForSession } from "../../apps/desktop/src/features/bots/TaskWaitingDock";
import { BotSidebarGroup } from "../../apps/desktop/src/features/bots/BotSidebarGroup";
import { Composer } from "../../apps/desktop/src/components/Composer";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({ lng: "zh-CN", keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } },
  interpolation: { escapeValue: false } });

const employee = {
  sessionId: "router", title: "Router 后端",
  profile: { name: "Router 后端", permissionMode: "accept-edits", mustAsk: [], observe: false },
  status: { kind: "stage", stage: "person/answer" }, projectPath: "/repo/Minih-Agent-Desktop",
  updatedAt: "2026-11-13T02:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z",
};
const steward = {
  sessionId: "steward", title: "Super Agent",
  profile: { name: "Super Agent", definition: "steward", permissionMode: "ask", mustAsk: [], observe: false },
  status: { kind: "idle" }, projectPath: "/repo/Minih-Agent-Desktop",
  updatedAt: "2026-11-13T02:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z",
};

const question = {
  id: "task-question", employeeSessionId: "router", sessionId: "sess-question",
  title: "修一下登录超时", origin: "steward", stage: "person/answer",
  projectPath: "/repo/Minih-Agent-Desktop", shortId: "3f8a11",
  createdAt: "2026-11-13T01:00:00.000Z", workspaceStatus: "ready", baseRef: "refs/remotes/origin/main",
  deliveryMode: "pr", workspaceBranch: "fix/login-timeout",
  waiting: [{ requestId: "req-1", kind: "ask", question: "要保留旧的登录接口吗？",
    options: ["保留，另开一个 v2 接口", "直接删掉旧接口"], openedAt: "2026-11-13T01:40:00.000Z" }],
};
const blocked = {
  id: "task-blocked", employeeSessionId: "router", sessionId: "sess-blocked",
  title: "补 remote_gateway 单测", origin: "steward", stage: "blocked",
  projectPath: "/repo/Minih-Agent-Desktop", shortId: "b71c04",
  createdAt: "2026-11-13T00:30:00.000Z", workspaceStatus: "ready",
  blocker: { status: "blocked", where: "迁移脚本要先在测试库上跑一遍",
    tried: "本地跑过一次，缺 staging 的数据库权限",
    suggestion: "给我一份 staging 的只读账号" },
};
const finished = {
  id: "task-finished", employeeSessionId: "router", sessionId: "sess-finished",
  title: "把设置页的滚动问题修掉", origin: "steward", stage: "person/accept",
  projectPath: "/repo/Minih-Agent-Desktop", shortId: "c02d19",
  createdAt: "2026-11-13T00:10:00.000Z", workspaceStatus: "none",
};
const unreadable = {
  id: "task-unreadable", employeeSessionId: "router", sessionId: "sess-unreadable",
  title: "看一下缓存命中率", origin: "steward", stage: "person/answer",
  projectPath: "/repo/Minih-Agent-Desktop", shortId: "9a0f52",
  createdAt: "2026-11-13T00:50:00.000Z", workspaceStatus: "none",
  waiting: [{ requestId: "req-9", kind: "ask", question: "缓存预热要不要一起做？",
    openedAt: "2026-11-13T01:50:00.000Z" }],
};
const tasks = [question, blocked, finished, unreadable];

window.minihAgent = {
  platform: "darwin",
  on: () => () => undefined,
  async invoke(channel, input) {
    if (channel === IPC.invoke.botList) return { ok: true, data: { bots: [steward, employee] } };
    if (channel === IPC.invoke.taskList) return { ok: true, data: { tasks } };
    if (channel === IPC.invoke.taskCardList) {
      // A real proposed card, so the steward's dock shows the card row the person
      // actually sees next to the waiting rows.
      return {
        ok: true,
        data: {
          drafts: [{
            id: "draft-1",
            sessionId: "steward",
            status: "proposed",
            cardHash: "hash-1",
            targetSessionId: "",
            sourceUtterance: "慢查询也顺手看一下。",
            createdAt: "2026-11-13T02:10:00.000Z",
            updatedAt: "2026-11-13T02:10:00.000Z",
            card: {
              goal: "把慢查询的索引补齐",
              criteria: [{ id: "c1", text: "慢查询降到 200ms 以内" }],
              boundaries: [],
              permissionMode: "accept-edits",
              mustAsk: [],
              risk: "low",
            },
          }],
        },
      };
    }
    if (channel === IPC.invoke.pendingInteractive) {
      if (input?.sessionId === "sess-unreadable") {
        return { ok: false, error: { code: "NOT_FOUND", message: "no open request" } };
      }
      return { ok: true, data: { asks: [{ requestId: "req-1", sessionId: "sess-question",
        toolCallId: "call-1", turnId: "turn-1",
        questions: [{ question: "要保留旧的登录接口吗？", options: ["保留，另开一个 v2 接口", "直接删掉旧接口"] }] }],
        permissions: [] } };
    }
    return { ok: true, data: undefined };
  },
};

const sessions = [
  { id: "steward", title: "Super Agent", role: "bot", projectPath: "/repo/Minih-Agent-Desktop",
    botProfile: { name: "Super Agent", definition: "steward", permissionMode: "ask", mustAsk: [], observe: false },
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-13T02:00:00.000Z" },
  { id: "sess-question", title: "修一下登录超时", role: "task", projectPath: "/repo/Minih-Agent-Desktop",
    createdAt: "2026-11-13T01:00:00.000Z", updatedAt: "2026-11-13T01:40:00.000Z" },
  { id: "sess-blocked", title: "补 remote_gateway 单测", role: "task", projectPath: "/repo/Minih-Agent-Desktop",
    createdAt: "2026-11-13T00:30:00.000Z", updatedAt: "2026-11-13T01:20:00.000Z" },
];

useAppStore.setState({
  sessions,
  activeSessionId: "sess-question",
  selectSession: async () => undefined,
  sendPrompt: async () => true,
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

const noop = () => undefined;
/** The last error the page saw: a scene that throws renders nothing at all. */
let lastError = null;
window.addEventListener("error", (event) => {
  lastError = String((event.error && (event.error.stack || event.error.message)) || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  lastError = String(event.reason && event.reason.message ? event.reason.message : event.reason);
});
const frame = () => new Promise(requestAnimationFrame);
async function settle(count = 3) { for (let n = 0; n < count; n += 1) await frame(); }
async function until(predicate, label) {
  for (let n = 0; n < 300; n += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(
    "timed out waiting for " + label + ": " + document.body.textContent + " | lastError=" + lastError,
  );
}

/**
 * Finish every finite animation before a capture: the route surfaces fade in over
 * ~200 ms, and a mid-fade capture paints the whole card under a veil.
 */
function finishAnimations() {
  for (const animation of document.getAnimations()) {
    const timing = animation.effect && animation.effect.getTiming ? animation.effect.getTiming() : null;
    if (timing && timing.iterations === Infinity) continue;
    try {
      animation.finish();
    } catch {
      // An idle or infinite effect: nothing to finish.
    }
  }
}

const askRequest = {
  requestId: "req-1", sessionId: "sess-question", toolCallId: "call-1", turnId: "turn-1",
  questions: [{ question: "要保留旧的登录接口吗？", options: ["保留，另开一个 v2 接口", "直接删掉旧接口"] }],
};

const topbar = () => React.createElement(ConversationTopbar, {
  sidebarCollapsed: false,
  workPanelOpen: false,
  onToggleSidebar: noop,
  onNewTask: noop,
  onOpenSearch: noop,
});

/**
 * The conversation a dock scene sits in: the real sidebar, the real topbar, a
 * short exchange, and the real composer — which is what renders the dock above
 * its input, so the picture shows where the row actually appears.
 */
function shell({ sessionId, conversation, dock }) {
  useAppStore.setState({ activeSessionId: sessionId });
  return React.createElement("div", { className: "app-shell" },
    React.createElement("aside", { className: "sidebar sidebar-surface" },
      React.createElement("div", { className: "shot-sidebar-body" },
        React.createElement(BotSidebarGroup, {
          activeSessionId: sessionId,
          onOpenBot: noop,
          onOpenTask: noop,
        }))),
    React.createElement("section", { className: "main-pane" },
      React.createElement(ConversationTopbar, {
        sidebarCollapsed: false,
        workPanelOpen: false,
        onToggleSidebar: noop,
        onNewTask: noop,
        onOpenSearch: noop,
      }),
      React.createElement("div", { className: "route-surface route-page shot-stack" },
        React.createElement("div", { className: "shot-turn" },
          React.createElement("p", { className: "shot-user" }, conversation.user),
          React.createElement("p", { className: "shot-steward" }, conversation.answer)),
        React.createElement("div", { className: "shot-spacer" })),
      dock
        ? // The card a task session shows sits in the composer's own stack; the
          // wrapper is the real one, so the position is the product's.
          React.createElement("div", { className: "composer-dock composer-dock-docked" },
            React.createElement("div", { className: "composer-stack" }, dock))
        : React.createElement(Composer, { variant: "docked" })));
}

let rootNode = null;
async function render(kind) {
  const container = document.getElementById("root");
  if (rootNode) {
    flushSync(() => rootNode.unmount());
    rootNode = null;
  }
  container.innerHTML = "";
  rootNode = createRoot(container);
  // Every scene is the real conversation shell: the sidebar, the header, a short
  // exchange, and the composer whose stack renders whatever waits above the
  // input. A picture of the dock alone cannot show where the person finds it.
  const scenes = {
    // 1. The task session: the header says 等你 and the question card is the one
    //    the runtime raised.
    question: () => shell({
      sessionId: "sess-question",
      conversation: {
        user: "登录超时今天修掉。",
        answer: "在改。有个接口要问一下再动。",
      },
      dock: React.createElement(AskToolCard, { request: askRequest }),
    }),
    // 2. The steward's conversation: one orange row per open question.
    "dock-question": () => shell({
      sessionId: "steward",
      conversation: {
        user: "Desktop 的登录超时要今天修掉。",
        answer: "已派给 Router 后端，她在改；有结果我叫你。",
      },
    }),
    // 3. The task session of a stuck task.
    blocked: () => shell({
      sessionId: "sess-blocked",
      conversation: {
        user: "补一下 remote_gateway 的单测。",
        answer: "写了一半，迁移脚本这边过不去，我先报给你。",
      },
      dock: React.createElement(TaskBlockedCardForSession, { sessionId: "sess-blocked" }),
    }),
    // 4. The steward's conversation holding that card.
    "dock-blocked": () => shell({
      sessionId: "steward",
      conversation: {
        user: "remote_gateway 那批单测也补上。",
        answer: "交给 Router 后端了；有一项卡在 staging 权限上。",
      },
    }),
    // 5. The sidebar's count and the list it opens.
    sidebar: () => React.createElement("div", { className: "shot-sidebar" },
      React.createElement(BotSidebarGroup, {
        activeSessionId: "sess-question",
        onOpenBot: noop,
        onOpenTask: noop,
        bots: [steward, employee],
        tasks,
      })),
    // 6. The dock when this screen cannot read the request.
    "dock-fallback": () => shell({
      sessionId: "steward",
      conversation: {
        user: "缓存命中率也看一下。",
        answer: "在查；有个预热的问题要你定。",
      },
    }),
  };
  const scene = scenes[kind]();
  // A task's own question is the card the runtime raised, so it rides in the
  // store exactly as an incoming asktool_request puts it there.
  useAppStore.setState({ pendingAsks: kind === "question" ? [askRequest] : [] });
  flushSync(() => rootNode.render(scene));
  if (kind === "question") {
    await until(() => document.querySelector("[data-task-stage='person/answer']"), "the 等你 chip");
    await until(
      () => document.body.textContent.includes("要保留旧的登录接口吗？"),
      "the question card",
    );
  }
  if (kind === "blocked") {
    await until(() => document.querySelector("[data-task-blocked]"), "the blocked card");
  }
  if (kind === "question" || kind === "blocked") {
    await until(() => document.querySelector(".composer-dock"), "the composer slot");
  }
  if (kind === "dock-question" || kind === "dock-blocked" || kind === "dock-fallback") {
    await until(() => document.querySelector("[data-testid='task-waiting-dock']"), "the dock");
  }
  if (kind === "dock-fallback") {
    // Only the unreadable request is left in this scene.
    await until(() => document.querySelector("[data-waiting-can-answer='false']"), "the fallback row");
  }
  if (kind === "sidebar") {
    await until(() => document.querySelector("[data-sidebar-waiting]"), "the waiting count");
    flushSync(() => document.querySelector("[data-sidebar-waiting]").click());
    await until(() => document.querySelector("[data-testid='sidebar-waiting-list']"), "the list");
  }
  await settle(4);
  finishAnimations();
  await settle(2);
}

window.shot = {
  async render(kind, theme) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.platform = "darwin";
    try {
      await render(kind);
      return { ok: true };
    } catch (error) {
      // A scene that fails must fail loudly with its reason, not with a blank
      // picture: the capture below is rejected on this.
      return { ok: false, error: String((error && error.message) || error) };
    }
  },
};
`;

/** Compile the shipped stylesheet (Tailwind included) into one CSS file. */
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

/**
 * The harness layout: the captured element is the scene, so a picture shows the
 * card at the width the person would see it, not a full page of chrome.
 */
const harnessCss = `
  html, body, #root { height: 100%; margin: 0; }
  body { background: var(--ds-bg-primary); color: var(--ds-text-primary); }
  #root { padding: 24px; box-sizing: border-box; }
  .shot-surface { display: flex; flex-direction: column; gap: 16px; }
  .shot-topbar > * { position: static; }
  .shot-dock { display: flex; flex-direction: column; gap: 10px; }
  .shot-sidebar { width: 300px; }
`;

test(
  "waiting: the six waiting-channel screens, dark and light, at 1440 and 1024",
  { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false, timeout: 300_000 },
  async () => {
    await mkdir(artifactRoot, { recursive: true });
    const workDir = await mkdtemp(join(tmpdir(), "pi-bot-waiting-shot-"));
    try {
      // The real composer mounts the live-voice controller, whose only Vite-ism is
      // `?url` on a worklet file. One stub keeps the composer real in a picture
      // (the worklet itself never runs here).
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
          // One bundled dependency reads `process.env.DEV` directly; a browser
          // build has no `process` at all.
          "process.env": '{"NODE_ENV":"production","DEV":false}',
          // Vite's own flag, read by one bundled dependency.
          "import.meta.env": '{"DEV":false,"PROD":true,"MODE":"production"}',
        },
        plugins: [
          {
            name: "vite-url-import-stub",
            setup(build) {
              build.onResolve({ filter: /\?url$/ }, () => ({ path: workletStub }));
            },
          },
        ],
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

      const scenes = ["question", "dock-question", "blocked", "dock-blocked", "sidebar", "dock-fallback"];
      const plan = [];
      for (const theme of ["dark", "light"]) {
        for (const width of [1440, 1024]) {
          for (const scene of scenes) plan.push({ theme, width, scene });
        }
      }

      await writeFile(
        join(workDir, "main.cjs"),
        `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { writeFileSync } = require("node:fs");
app.setPath("userData", path.join(__dirname, "profile"));
const plan = ${JSON.stringify(plan)};
const outDir = ${JSON.stringify(artifactRoot)};
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    win.setContentSize(1440, 900);
    await win.webContents.executeJavaScript(
      "new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const tick = () => { if (window.shot) return resolve(true); if (Date.now() > deadline) return reject(new Error('renderer never loaded')); setTimeout(tick, 50); }; tick(); })",
    );
    for (const entry of plan) {
      win.setContentSize(entry.width, 900);
      const rendered = await win.webContents.executeJavaScript("window.shot.render(" + JSON.stringify(entry.scene) + "," + JSON.stringify(entry.theme) + ")");
      if (!rendered || rendered.ok !== true) {
        throw new Error("scene " + entry.scene + " did not render: " + JSON.stringify(rendered));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      const image = await win.webContents.capturePage();
      const file = path.join(outDir, entry.theme + "-" + entry.scene + "-" + entry.width + ".png");
      writeFileSync(file, image.toPNG());
      console.log("SHOT " + JSON.stringify({ ...entry, file }));
    }
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
      const shots = output
        .split(/\r?\n/)
        .filter((line) => line.startsWith("SHOT "))
        .map((line) => JSON.parse(line.slice("SHOT ".length)));
      assert.equal(shots.length, plan.length, `captured ${shots.length} of ${plan.length}`);
      for (const shot of shots) {
        assert.ok(existsSync(shot.file), `${shot.file} is missing`);
        const bytes = readFileSync(shot.file);
        // A blank capture is a real failure: the scene rendered nothing.
        assert.ok(bytes.length > 8_000, `${shot.file} is only ${bytes.length} bytes`);
        console.log(`✔ ${shot.theme} ${shot.scene} ${shot.width}px → ${shot.file.replace(root + "/", "")}`);
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  },
);