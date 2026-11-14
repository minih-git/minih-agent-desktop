import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * Relay between roles, through real clicks and the real stylesheet (employee
 * mode 0.5 slice 7).
 *
 * The renderer is the shipped one; the host is scripted, because what this test
 * is about is what the person sees and what the renderer sends. The rules
 * themselves — the card edge, the handoff, the chain merge, the overlap read —
 * are proven against the host in `task_relay_tests.rs`, `task_overlap_tests.rs`
 * and `task_delivery_tests.rs`.
 *
 * Six pictures are the deliverable this guards: the two chained cards, the step
 * that collapsed into 「已确认，等 <员工> 的 #a」, the middle step's completion
 * card, the step that lost its predecessor, the start card with the overlap
 * hint, and the summary card where a chain is one row. Dark and light, 1440 and
 * 1024, in the full shell (sidebar, transcript, composer).
 */

const root = repositoryRoot();
const { build: bundle } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const artifactRoot = join(root, ".artifacts", "bot-relay");

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
import { TaskCardDock } from "../../apps/desktop/src/features/bots/TaskCardDock";
import { TaskCompletionCard } from "../../apps/desktop/src/features/bots/TaskCompletionCard";
import { TaskBlockedCard } from "../../apps/desktop/src/features/bots/TaskBlockedCard";
import { TaskBatchCard } from "../../apps/desktop/src/features/bots/TaskBatchCard";
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
  updatedAt: "2026-11-14T02:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z",
};
const router = {
  sessionId: "router", title: "Router 后端",
  profile: { name: "Router 后端", permissionMode: "accept-edits", mustAsk: [], observe: false },
  status: { kind: "busy", stage: "working" }, projectPath: "/repo/Minih-Agent-Desktop",
  updatedAt: "2026-11-14T02:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z",
};
const desk = {
  sessionId: "desk", title: "桌面端",
  profile: { name: "桌面端", permissionMode: "accept-edits", mustAsk: [], observe: false },
  status: { kind: "busy", stage: "working" }, projectPath: "/repo/Minih-Agent-Desktop",
  updatedAt: "2026-11-14T02:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z",
};

const stepOne = {
  id: "11111111-1111-4111-8111-111111111111", shortId: "111111",
  employeeSessionId: "router", sessionId: "sess-step-one", title: "加上 active 列",
  origin: "steward", stage: "person/accept", projectPath: "/repo/Minih-Agent-Desktop",
  workspaceBranch: "minih-agent/111111", deliveryMode: "pr",
  createdAt: "2026-11-14T01:00:00.000Z", workspaceStatus: "ready",
  relayStep: 1, relayTotal: 2, deliveryId: "delivery-step-one",
  result: { summary: "列加好了，回填脚本放在下一步。", acceptance: [{ criterion: "迁移脚本可重复执行", met: true }] },
};
const stepTwo = {
  id: "22222222-2222-4222-8222-222222222222", shortId: "222222",
  employeeSessionId: "router", sessionId: "sess-step-two", title: "回填并切换读路径",
  origin: "steward", stage: "person/accept", projectPath: "/repo/Minih-Agent-Desktop",
  workspaceBranch: "minih-agent/222222", deliveryMode: "pr",
  createdAt: "2026-11-14T01:05:00.000Z", workspaceStatus: "ready",
  relayStep: 2, relayTotal: 2, relayParentTaskId: stepOne.id, deliveryId: "delivery-step-two",
};
const stepThree = {
  ...stepTwo,
  id: "33333333-3333-4333-8333-333333333333", shortId: "333333",
  sessionId: "sess-step-three", title: "删掉旧读路径",
  createdAt: "2026-11-14T01:10:00.000Z", relayStep: 3, relayTotal: 3,
  relayParentTaskId: stepTwo.id, deliveryId: "delivery-step-three",
};

const checks = {
  [stepOne.id]: {
    canMerge: false, reason: "no-project", changes: { commits: [], files: 0, truncated: false },
    relay: { step: 1, total: 2, isLast: false }, elapsedMs: 3_600_000,
    usage: { inputTokens: 1200, outputTokens: 400, turns: 3 },
  },
  [stepTwo.id]: {
    canMerge: true, prUrl: "https://github.com/minih-git/minih-agent-desktop/pull/7",
    checks: { passed: 2, total: 2 },
    changes: {
      commits: [
        { sha: "aaaa1111", subject: "feat: 加上 active 列" },
        { sha: "bbbb2222", subject: "feat: 回填并切换读路径" },
      ],
      files: 4, truncated: false,
      steps: [
        { taskId: stepOne.id, shortId: "111111", title: "加上 active 列",
          commits: [{ sha: "aaaa1111", subject: "feat: 加上 active 列" }], files: 2, truncated: false },
        { taskId: stepTwo.id, shortId: "222222", title: "回填并切换读路径",
          commits: [{ sha: "bbbb2222", subject: "feat: 回填并切换读路径" }], files: 2, truncated: false },
      ],
    },
    relay: { step: 2, total: 2, isLast: true }, elapsedMs: 7_200_000,
    usage: { inputTokens: 2600, outputTokens: 900, turns: 5 },
  },
};

const state = {
  drafts: [],
  tasks: [],
  overlaps: { readable: true, tasks: [], intersections: [] },
  calls: { confirm: [], handoff: [], detach: [], merge: [], overlap: [] },
  // The overlap answer this scene was rendered with, set by the render call.
  renderedOverlap: null,
  handoffStarted: false,
};

function draft(id, goal, afterDraftId) {
  return {
    id, sessionId: "steward", status: "proposed",
    card: {
      goal, criteria: [{ id: "c1", text: "迁移可重复执行" }],
      boundaries: ["只改 Router 的迁移"],
      repo: { origin: "github.com/minih-git/minih-agent-desktop" },
      permissionMode: "accept-edits", readOnly: false,
      mustAsk: ["deploy", "delete", "spend"], risk: "medium",
      reason: "这是 Router 的迁移，你提到了 Desktop。",
    },
    cardHash: "hash-" + id,
    sourceUtterance: "把 active 列分两步加上：先加列，再回填。",
    targetSessionId: "router", targetTitle: "Router 后端",
    batchId: "turn-1", afterDraftId,
    createdAt: "2026-11-14T01:00:00.000Z", updatedAt: "2026-11-14T01:00:00.000Z",
  };
}

window.minihAgent = {
  platform: "darwin",
  on: () => () => undefined,
  async invoke(channel, input) {
    if (channel === IPC.invoke.botList) return { ok: true, data: { bots: [router, desk, steward] } };
    if (channel === IPC.invoke.taskList) return { ok: true, data: { tasks: state.tasks } };
    if (channel === IPC.invoke.taskCardList) return { ok: true, data: { drafts: state.drafts } };
    if (channel === IPC.invoke.backgroundTasksList) return { ok: true, data: { tasks: [] } };
    if (channel === IPC.invoke.todosGet) {
      return { ok: true, data: { sessionId: input && input.sessionId, todos: [] } };
    }
    if (channel === IPC.invoke.pendingInteractive) return { ok: true, data: { asks: [], permissions: [] } };
    if (channel === IPC.invoke.taskOverlap) {
      state.calls.overlap.push(input);
      return { ok: true, data: state.overlaps };
    }
    if (channel === IPC.invoke.taskDeliveryCheck) {
      return { ok: true, data: checks[input.taskId] || { canMerge: false, reason: "pr-missing" } };
    }
    if (channel === IPC.invoke.taskCardConfirm) {
      state.calls.confirm.push(input.draftId);
      const draft = state.drafts.find((entry) => entry.id === input.draftId);
      const waiting = Boolean(draft.afterDraftId);
      const taskId = waiting ? "44444444-4444-4444-8444-444444444444" : "55555555-5555-4555-8555-555555555555";
      const task = {
        id: taskId,
        shortId: waiting ? "444444" : "555555",
        // The task and its card are matched by the delivery the confirmation
        // wrote, which is how the dock finds the line a confirmed card folds to.
        deliveryId: "delivery-" + taskId,
        employeeSessionId: "router",
        sessionId: waiting ? "sess-step-two" : "sess-step-one",
        title: draft.card.goal, origin: "steward", stage: "queued",
        projectPath: "/repo/Minih-Agent-Desktop",
        createdAt: "2026-11-14T02:00:00.000Z",
        relayStep: waiting ? 2 : 1, relayTotal: 2,
        ...(waiting ? { relayState: "waiting", relayParentTaskId: "55555555-5555-4555-8555-555555555555" } : {}),
      };
      state.drafts = state.drafts.map((entry) => entry.id === input.draftId
        ? { ...entry, status: "confirmed", confirmedBy: "user",
            confirmedAt: "2026-11-14T02:00:00.000Z", deliveryId: task.deliveryId }
        : entry);
      state.tasks = [...state.tasks, task];
      return { ok: true, data: { draft: state.drafts.find((entry) => entry.id === input.draftId),
        deliveryId: task.deliveryId } };
    }
    if (channel === IPC.invoke.taskRelayHandoff) {
      state.calls.handoff.push(input.taskId);
      state.handoffStarted = true;
      return { ok: true, data: { task: stepOne, handedOffAt: "2026-11-14T03:00:00.000Z",
        unlocked: [{ taskId: stepTwo.id, deliveryId: "delivery-step-two" }] } };
    }
    if (channel === IPC.invoke.taskRelayDetach) {
      state.calls.detach.push(input.taskId);
      return { ok: true, data: { task: { ...stepTwo, relayState: undefined, relayParentTaskId: undefined } } };
    }
    if (channel === IPC.invoke.taskDeliveryMerge) {
      state.calls.merge.push(input.taskId);
      return { ok: true, data: { merged: true, task: stepTwo } };
    }
    if (channel === IPC.invoke.taskAccept) {
      return { ok: true, data: { task: stepOne } };
    }
    return { ok: true, data: {} };
  },
};

function Line({ role, text }) {
  return <p className={role === "user" ? "shot-user" : "shot-steward"}>{text}</p>;
}

function Shell({ dock, children }) {
  return (
    <div className="shot-surface">
      <div className="shot-topbar">
        <ConversationTopbar sessionId="steward" title="Super Agent" />
      </div>
      <div style={{ display: "flex", gap: 16, flex: "1 1 auto", minHeight: 0 }}>
        <aside className="shot-sidebar">
          <BotSidebarGroup bots={sortBots([router, desk, steward])} activeSessionId="steward" />
        </aside>
        <main style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <div className="shot-stack">
            <Line role="user" text="把 active 列分两步加上：先加列，再回填。" />
            <Line role="steward" text="这一步要按顺序做，我把它拆成了两棒：第一棒加列，第二棒回填并切换读路径。第二棒接在第一棒之后。" />
          </div>
          <div className="shot-spacer" />
          {dock}
          {children}
          <div className="composer-dock">
            <Composer />
          </div>
        </main>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root"));
const rendered = { scene: null, theme: "dark" };
// A scene is mounted fresh each time: the dock keeps its own reads, and a test
// that wants to see a changed read has to give it a new mount.
let mount = 0;

function finishAnimations() {
  for (const animation of document.getAnimations()) animation.finish();
}

function montage(scene) {
  if (scene === "dock-chain" || scene === "overlap-hint") {
    state.drafts = [draft("draft-a", "加上 active 列"), draft("draft-b", "回填并切换读路径", "draft-a")];
    state.tasks = [];
    state.overlaps = state.renderedOverlap ?? (scene === "overlap-hint"
      ? { readable: true, tasks: [{ taskId: stepTwo.id, shortId: "3f8a11", title: "换个登录页", fileCount: 2 }], intersections: [] }
      : { readable: true, tasks: [], intersections: [] });
    return <Shell dock={<TaskCardDock key={"dock-" + mount} sessionId="steward" />} />;
  }
  if (scene === "dock-waiting") {
    state.drafts = [
      { ...draft("draft-a", "加上 active 列"), status: "confirmed", confirmedBy: "user",
        confirmedAt: "2026-11-14T02:00:00.000Z", deliveryId: "delivery-step-one" },
      { ...draft("draft-b", "回填并切换读路径", "draft-a"), status: "confirmed", confirmedBy: "user",
        confirmedAt: "2026-11-14T02:05:00.000Z", deliveryId: "delivery-step-two" },
    ];
    state.tasks = [stepOne, { ...stepTwo, relayState: "waiting" }];
    state.overlaps = { readable: true, tasks: [], intersections: [] };
    return <Shell dock={<TaskCardDock key={"dock-" + mount} sessionId="steward" />} />;
  }
  if (scene === "completion-middle") {
    state.drafts = [];
    state.tasks = [];
    return (
      <Shell dock={null}>
        <TaskCompletionCard task={stepOne} employeeName="Router 后端" stewardSessionId="steward" variant="dock" />
      </Shell>
    );
  }
  if (scene === "blocked-relay") {
    state.drafts = [];
    state.tasks = [];
    return (
      <Shell dock={null}>
        <TaskBlockedCard
          task={{ ...stepTwo, stage: "blocked", relayState: "orphaned",
            blocker: { reason: "relay-orphaned", parent: "111111" } }}
          employeeName="Router 后端"
          stewardName="Super Agent"
          stewardSessionId="steward"
        />
      </Shell>
    );
  }
  if (scene === "batch-chain") {
    state.drafts = [];
    state.tasks = [];
    return (
      <Shell dock={null}>
        <TaskBatchCard
          batch={{ batchId: "turn-1", tasks: [stepOne, stepTwo, stepThree] }}
          names={{ router: "Router 后端" }}
          stewardSessionId="steward"
        />
      </Shell>
    );
  }
  throw new Error("unknown scene " + scene);
}

async function settle(turns = 6) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    flushSync(() => undefined);
  }
}

window.shot = {
  async render(scene, theme, overlap) {
    try {
      state.renderedOverlap = overlap ?? null;
      document.documentElement.dataset.theme = theme;
      rendered.scene = scene;
      rendered.theme = theme;
      mount += 1;
      const element = montage(scene);
      flushSync(() => root.render(element));
      await settle();
      finishAnimations();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  },
  async act(name) {
    try {
      if (name === "start-a" || name === "start-b") {
        const id = name === "start-a" ? "draft-a" : "draft-b";
        const card = document.querySelector("[data-draft-id='" + id + "']");
        if (!card) throw new Error("card " + id + " is not on screen");
        const button = card.querySelector(".task-card-actions button:last-of-type");
        button.click();
        await settle(8);
        return { ok: true };
      }
      if (name === "handoff") {
        const button = document.querySelector("[data-completion-handoff]");
        if (!button) throw new Error("the handoff button is missing");
        button.click();
        await settle(8);
        return { ok: true };
      }
      if (name === "overlap-unreadable") {
        await window.shot.render("overlap-hint", rendered.theme,
          { readable: false, reason: "git: not a repository", tasks: [], intersections: [] });
        finishAnimations();
        return { ok: true };
      }
      if (name === "detach") {
        const button = document.querySelector("[data-blocked-start-from-main]");
        if (!button) throw new Error("the start-from-main button is missing");
        button.click();
        await settle(8);
        return { ok: true };
      }
      throw new Error("unknown action " + name);
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  },
  probe() {
    const text = (selector) => [...document.querySelectorAll(selector)].map((node) => node.textContent || "");
    return {
      follows: text("[data-card-follows]"),
      overlap: text("[data-card-overlap]"),
      waiting: text("[data-relay-waiting='true']"),
      confirmedLine: text(".task-card-dispatched"),
      disabledStart: [...document.querySelectorAll(".task-card-actions button[disabled]")]
        .map((node) => node.textContent || ""),
      startLabels: text(".task-card-actions button:last-of-type"),
      handoff: Boolean(document.querySelector("[data-completion-handoff]")),
      merge: Boolean(document.querySelector("[data-completion-merge]")),
      handoffWaiting: text("[data-completion-accepted-note]"),
      relayStep: text("[data-completion-relay]"),
      chainSteps: document.querySelectorAll("[data-completion-chain] [data-chain-step]").length,
      batchText: (document.querySelector("[data-task-batch]") || {}).textContent || "",
      chainRows: document.querySelectorAll("[data-batch-chain='true']").length,
      batchRows: document.querySelectorAll("[data-batch-row]").length,
      // The pictures are of the whole shell, so the sidebar, the transcript and
      // the composer are part of what this test proves.
      shell: {
        sidebar: Boolean(document.querySelector(".shot-sidebar .bot-group")),
        transcript: document.querySelectorAll(".shot-stack > p").length,
        composer: Boolean(document.querySelector(".composer-dock textarea, .composer-dock [contenteditable='true']")),
      },
      calls: state.calls,
    };
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
      rollupOptions: {
        input: entry,
        output: { entryFileNames: "style-entry.js", assetFileNames: "styles[extname]" },
      },
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
  #root { padding: 20px; box-sizing: border-box; }
  .shot-surface { display: flex; flex-direction: column; gap: 16px; height: 100%; }
  .shot-topbar > * { position: static; }
  .shot-sidebar { width: 280px; flex: 0 0 auto; }
  .shot-stack { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; }
  .shot-user { align-self: flex-end; max-width: 72%; margin: 0; padding: 8px 12px;
    border-radius: var(--radius-md); background: var(--ds-bg-secondary); color: var(--ds-text-primary); }
  .shot-steward { max-width: 92%; margin: 0; color: var(--ds-text-secondary); }
  .shot-spacer { flex: 1 1 auto; min-height: 0; }
`;

test(
  "relay: the six screens, dark and light, at 1440 and 1024",
  {
    skip:
      process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
    timeout: 300_000,
  },
  async () => {
    await mkdir(artifactRoot, { recursive: true });
    const workDir = await mkdtemp(join(tmpdir(), "pi-bot-relay-shot-"));
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

    const scenes = [
      "dock-chain",
      "dock-waiting",
      "completion-middle",
      "blocked-relay",
      "overlap-hint",
      "batch-chain",
    ];
    const plan = [];
    for (const theme of ["dark", "light"]) {
      for (const width of [1440, 1024]) {
        for (const scene of scenes) plan.push({ kind: "shot", theme, width, scene });
      }
    }
    // The click flow runs first and asserts as it goes: the pictures are one
    // pass, and the behaviour is another, so neither depends on the other's
    // final screen.
    plan.unshift({ kind: "flow" });

    await writeFile(
      join(workDir, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
const plan = ${JSON.stringify(plan)};
const outDir = ${JSON.stringify(artifactRoot)};
const call = (win, script) => win.webContents.executeJavaScript(script);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  let failure = null;
  const check = (value, label) => { if (!value || value.ok !== true) throw new Error(label + ": " + JSON.stringify(value)); };
  const probe = () => call(win, "JSON.stringify(window.shot.probe())").then((raw) => JSON.parse(raw));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    win.setContentSize(1440, 900);
    await call(win, "new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const tick = () => { if (window.shot) return resolve(true); if (Date.now() > deadline) return reject(new Error('renderer never loaded')); setTimeout(tick, 50); }; tick(); })");
    for (const entry of plan) {
      if (entry.kind === "flow") {
        // Two chained cards: the second cannot start until the first has, and
        // once it is confirmed it collapses into the waiting line.
        check(await call(win, "window.shot.render('dock-chain','dark')"), "flow render");
        let seen = await probe();
        if (seen.follows.length !== 1) throw new Error("the chained card does not say what it follows");
        if (!seen.shell.composer) throw new Error("the shell has no composer");
        if (seen.shell.transcript < 2) throw new Error("the shell has no transcript: " + JSON.stringify(seen.shell));
        if (!seen.shell.sidebar) throw new Error("the shell has no sidebar: " + JSON.stringify(seen.shell));
        if (!seen.disabledStart.includes("先开前一张")) throw new Error("the second card's start is not disabled: " + JSON.stringify(seen.disabledStart));
        check(await call(win, "window.shot.act('start-a')"), "start a");
        seen = await probe();
        if (!seen.calls.confirm.includes("draft-a")) throw new Error("the first card was not confirmed");
        if (seen.disabledStart.includes("先开前一张")) throw new Error("the second card stayed disabled after the first was started");
        check(await call(win, "window.shot.act('start-b')"), "start b");
        seen = await probe();
        if (!seen.calls.confirm.includes("draft-b")) throw new Error("the second card was not confirmed");
        if (seen.waiting.length !== 1) throw new Error("the waiting step did not collapse into one line: " + JSON.stringify(seen.waiting));
        if (!seen.waiting[0].includes("等 Router 后端 的 #555555")) throw new Error("the waiting line does not name the step it waits for: " + seen.waiting[0]);
        // The middle step's completion card hands on instead of merging.
        check(await call(win, "window.shot.render('completion-middle','dark')"), "completion render");
        seen = await probe();
        if (!seen.handoff) throw new Error("the middle step has no handoff button");
        if (seen.merge) throw new Error("the middle step still offers a merge button");
        if (seen.chainSteps !== 0) throw new Error("the middle step listed a chain it cannot merge");
        check(await call(win, "window.shot.act('handoff')"), "handoff");
        seen = await probe();
        if (seen.calls.handoff.length !== 1) throw new Error("the handoff click did not reach the host");
        if (seen.calls.merge.length !== 0) throw new Error("the handoff click merged something");
        // A step that lost its predecessor offers the two decisions, not a retry.
        check(await call(win, "window.shot.render('blocked-relay','dark')"), "blocked render");
        check(await call(win, "window.shot.act('detach')"), "detach");
        seen = await probe();
        if (seen.calls.detach.length !== 1) throw new Error("「改从 main 开工」 did not reach the host");
        // The overlap hint is a warning; a read that failed says so.
        check(await call(win, "window.shot.render('overlap-hint','dark')"), "overlap render");
        seen = await probe();
        if (seen.overlap.length !== 2) throw new Error("the overlap hint is missing: " + JSON.stringify(seen.overlap));
        if (!seen.overlap[0].includes("#3f8a11")) throw new Error("the hint does not name the other task: " + seen.overlap[0]);
        check(await call(win, "window.shot.act('overlap-unreadable')"), "overlap unreadable");
        seen = await probe();
        if (!seen.overlap.some((line) => line.includes("查不到其他任务的改动"))) throw new Error("an unreadable read was shown as an empty list: " + JSON.stringify(seen.overlap));
        // A chain is one row in the summary.
        check(await call(win, "window.shot.render('batch-chain','dark')"), "batch render");
        seen = await probe();
        if (seen.chainRows !== 1) throw new Error("the chain is not one row: " + seen.chainRows);
        if ((seen.batchText.match(/链：/g) || []).length !== 1) throw new Error("the chain title is not one line: " + seen.batchText);
        continue;
      }
      if (entry.kind === "shot") {
        win.setContentSize(entry.width, 900);
        const rendered = await call(win, "window.shot.render(" + JSON.stringify(entry.scene) + "," + JSON.stringify(entry.theme) + ")");
        if (!rendered || rendered.ok !== true) throw new Error("scene " + entry.scene + " did not render: " + JSON.stringify(rendered));
        await new Promise((resolve) => setTimeout(resolve, 150));
        const image = await win.webContents.capturePage();
        require("node:fs").writeFileSync(path.join(outDir, entry.scene + "-" + entry.theme + "-" + entry.width + ".png"), image.toPNG());
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
    assert.equal(code, 0, "the relay run failed; see stderr above");
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

test("relay: the task session is told which step it is", () => {
  const source = readFileSync(
    join(root, "apps/desktop/electron/main/services/task-status.ts"),
    "utf8",
  );
  assert.match(
    source,
    /You are step \$\{step\} of \$\{total\}: commit your work; do not push or open a PR — the next step continues from your branch\./,
    "the middle step's rule is missing",
  );
  assert.match(
    source,
    /You are the last step: push the branch and open one PR for the whole chain\./,
    "the last step's rule is missing",
  );
});

/** Run one Electron child and resolve with its exit code, forwarding its output. */
function spawnProcess(binary, args) {
  const { spawn } = createRequire(import.meta.url)("node:child_process");
  const child = spawn(binary, args, { stdio: ["ignore", "inherit", "inherit"], env: process.env });
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
}