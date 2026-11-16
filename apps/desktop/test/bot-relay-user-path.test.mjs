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
 * The renderer is the shipped one, in the shipped shell: the app grid, the
 * sidebar, the topbar inside the main pane, the transcript, and the composer
 * with its own dock stack. Nothing is placed by hand — the dock, the completion
 * card, the blocked card and the summary card mount themselves from the store and
 * the host, exactly as they do in the product, so a picture cannot show a layout
 * the app does not have.
 *
 * The host is scripted, because what this test is about is what the person sees
 * and what the renderer sends. The rules themselves — the card edge, the handoff,
 * the chain merge, the overlap read — are proven against the host in
 * `task_relay_tests.rs`, `task_overlap_tests.rs` and `task_delivery_tests.rs`.
 *
 * Four pictures are the deliverable this guards: the two chained cards, the step
 * that collapsed into 「已确认，等 <员工> 的 #a」, the middle step's completion
 * card, the step that lost its predecessor, the start card with the overlap
 * hint, and the summary card where a chain is one row. Dark and light, 1440 and
 * 1024, zh-CN, with `finishAnimations()` before every capture.
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
import { BotSidebarGroup } from "../../apps/desktop/src/features/bots/BotSidebarGroup";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({ lng: "zh-CN", keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } },
  interpolation: { escapeValue: false } });

const noop = () => undefined;

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

/** The summaries the store reads to decide whether a conversation is the employee's. */
const summaries = [
  { id: "sess-step-one", title: "加上 active 列", role: "task",
    projectPath: "/repo/Minih-Agent-Desktop", updatedAt: "2026-11-14T02:00:00.000Z",
    createdAt: "2026-11-14T01:00:00.000Z", mode: "agent" },
  { id: "sess-step-two", title: "回填并切换读路径", role: "task",
    projectPath: "/repo/Minih-Agent-Desktop", updatedAt: "2026-11-14T02:00:00.000Z",
    createdAt: "2026-11-14T01:05:00.000Z", mode: "agent" },
];

const stepOne = {
  id: "11111111-1111-4111-8111-111111111111", shortId: "111111",
  employeeSessionId: "router", sessionId: "sess-step-one", title: "加上 active 列",
  origin: "direct", stage: "person/accept", projectPath: "/repo/Minih-Agent-Desktop",
  workspaceBranch: "minih-agent/111111", deliveryMode: "pr",
  createdAt: "2026-11-14T01:00:00.000Z", workspaceStatus: "ready",
  relayStep: 1, relayTotal: 2, batchId: "turn-1", deliveryId: "delivery-step-one",
  result: { summary: "列加好了，回填脚本放在下一步。", acceptance: [{ criterion: "迁移脚本可重复执行", met: true }] },
};
const stepTwo = {
  id: "22222222-2222-4222-8222-222222222222", shortId: "222222",
  employeeSessionId: "router", sessionId: "sess-step-two", title: "回填并切换读路径",
  origin: "direct", stage: "person/accept", projectPath: "/repo/Minih-Agent-Desktop",
  workspaceBranch: "minih-agent/222222", deliveryMode: "pr",
  createdAt: "2026-11-14T01:05:00.000Z", workspaceStatus: "ready",
  relayStep: 2, relayTotal: 2, relayParentTaskId: stepOne.id, batchId: "turn-1",
  deliveryId: "delivery-step-two",
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
  tasks: [],
  sessions: summaries,
  overlaps: { readable: true, tasks: [], intersections: [] },
  renderedOverlap: null,
  calls: { confirm: [], handoff: [], detach: [], merge: [], overlap: [] },
};

window.minihAgent = {
  platform: "darwin",
  on: () => () => undefined,
  async invoke(channel, input) {
    if (channel === IPC.invoke.botList) return { ok: true, data: { bots: [router, desk] } };
    if (channel === IPC.invoke.sessionList) {
      return { ok: true, data: { sessions: state.sessions, runningSessionIds: [] } };
    }
    if (channel === IPC.invoke.taskList) return { ok: true, data: { tasks: state.tasks } };
    if (channel === IPC.invoke.taskGet) {
      return { ok: true, data: { task: state.tasks.find((task) => task.id === input.taskId) } };
    }
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
    if (channel === IPC.invoke.taskRelayHandoff) {
      state.calls.handoff.push(input.taskId);
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
    if (channel === IPC.invoke.taskAccept) return { ok: true, data: { task: stepOne } };
    return { ok: true, data: {} };
  },
};

/**
 * The shipped shell, assembled the way the app assembles it: the sidebar beside
 * the app grid, the topbar inside the main pane, the transcript, and the composer
 * — which owns the dock stack the cards live in. Nothing here places a card; the
 * components mount themselves from the store and the host.
 */
function Shell() {
  return (
    <div className="app-shell">
      <aside className="sidebar sidebar-surface">
        <div className="shot-sidebar-body">
          <BotSidebarGroup activeSessionId={state.activeSessionId} onOpenBot={noop} onOpenTask={noop} />
        </div>
      </aside>
      <section className="main-pane">
        <ConversationTopbar
          sidebarCollapsed={false}
          workPanelOpen={false}
          onToggleSidebar={noop}
          onNewTask={noop}
          onOpenSearch={noop}
        />
        <div className="route-surface route-page shot-stack">
          <div className="shot-turn">
            <p className="shot-user">把 active 列分两步加上：先加列，再回填。</p>
            <p className="shot-employee">
              这一步要按顺序做，我把它拆成了两棒：第一棒加列，第二棒回填并切换读路径。第二棒接在第一棒之后。
            </p>
          </div>
          <div className="shot-spacer" />
        </div>
        <Composer variant="docked" />
      </section>
    </div>
  );
}

const root = createRoot(document.getElementById("root"));
const rendered = { scene: null, theme: "dark" };
// A scene is mounted fresh each time: the dock keeps its own reads, and a test
// that wants to see a changed read has to give it a new mount.
let mount = 0;

function finishAnimations() {
  for (const animation of document.getAnimations()) {
    const timing = animation.effect && animation.effect.getTiming ? animation.effect.getTiming() : null;
    if (timing && timing.iterations === Infinity) continue;
    try { animation.finish(); } catch { /* idle or infinite */ }
  }
}

function scene(name) {
  state.sessions = summaries;
  state.overlaps = { readable: true, tasks: [], intersections: [] };
  if (name === "completion-middle") {
    state.activeSessionId = "sess-step-one";
    state.tasks = [stepOne];
    return;
  }
  if (name === "blocked-relay") {
    state.activeSessionId = "sess-step-two";
    state.tasks = [{ ...stepTwo, stage: "blocked", relayState: "orphaned",
      blocker: { reason: "relay-orphaned", parent: "111111" } }];
    return;
  }
  if (name === "batch-chain") {
    state.activeSessionId = "sess-step-two";
    state.tasks = [stepOne, stepTwo, stepThree];
    return;
  }
  if (name === "completion-last") {
    state.activeSessionId = "sess-step-two";
    state.tasks = [stepOne, stepTwo];
    return;
  }
  throw new Error("unknown scene " + name);
}

async function settle(turns = 6) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    flushSync(() => undefined);
  }
}

/**
 * Wait for something the app reads from the host to arrive.
 *
 * The cards mount inside the composer and ask the host for their drafts and
 * tasks, so a fixed number of turns is a race: it passes on an idle machine and
 * fails on a loaded one. Every wait here has a deadline and names what it was
 * waiting for, so a failure says which read never landed.
 */
async function until(check, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
    flushSync(() => undefined);
  }
  throw new Error(label + " never appeared");
}

const CARD = "[data-draft-id], [data-task-completion], [data-task-blocked], [data-task-batch]";

function rectOf(selector) {
  const node = document.querySelector(selector);
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return { top: Math.round(rect.top), bottom: Math.round(rect.bottom),
    left: Math.round(rect.left), right: Math.round(rect.right) };
}

window.shot = {
  async render(name, theme, overlap) {
    try {
      state.renderedOverlap = overlap ?? null;
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.platform = "darwin";
      rendered.scene = name;
      rendered.theme = theme;
      mount += 1;
      scene(name);
      useAppStore.setState({ activeSessionId: state.activeSessionId, sessions: state.sessions });
      flushSync(() => root.render(<Shell key={"shell-" + mount} />));
      await settle();
      await until(() => document.querySelector(CARD), "the dock card in " + name);
      await settle();
      finishAnimations();
      await settle(2);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  },
  async act() { return { ok: true }; },
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
      // A stuck task's note must not claim the person stopped it unless the
      // host recorded exactly that.
      stoppedNote: Boolean(document.querySelector("[data-blocked-stopped]")),
      calls: state.calls,
      // The pictures are of the whole shell, so the layout is part of what this
      // test proves: the card sits above the input, and the topbar sits in the
      // main pane rather than across the sidebar.
      layout: {
        input: rectOf(".composer-dock textarea, .composer-dock [contenteditable='true']"),
        card: rectOf("[data-draft-id], [data-task-completion], [data-task-blocked], [data-task-batch]"),
        // The topbar is absolutely positioned by the product's own CSS; inside
        // the main pane it spans the pane, not the window.
        topbar: rectOf(".main-pane > .conversation-topbar"),
        sidebar: rectOf(".sidebar"),
        sidebarRow: rectOf("[data-sidebar-bot-group]"),
        composer: rectOf(".composer-dock"),
        viewportBottom: Math.round(window.innerHeight),
        // The card must be a child of the composer's own stack, above the input:
        // that is what makes it follow the input wherever the dock moves.
        cardInStack: (() => {
          const stack = document.querySelector(".composer-dock > .composer-stack");
          const card = document.querySelector("[data-draft-id], [data-task-completion], [data-task-blocked], [data-task-batch]");
          return Boolean(stack && card && stack.contains(card));
        })(),
      },
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
  #root { height: 100%; }
  .shot-sidebar-body { display: flex; flex-direction: column; gap: 8px; padding: 8px;
    overflow-y: auto; height: 100%; box-sizing: border-box; }
  .shot-stack { display: flex; flex-direction: column; gap: 12px; padding: 12px 16px; }
  .shot-turn { display: flex; flex-direction: column; gap: 10px; }
  .shot-user { align-self: flex-end; max-width: 72%; margin: 0; padding: 8px 12px;
    border-radius: var(--radius-md); background: var(--ds-bg-secondary); color: var(--ds-text-primary); }
  .shot-employee { max-width: 92%; margin: 0; color: var(--ds-text-secondary); }
  .shot-spacer { flex: 1 1 auto; min-height: 0; }
`;

test(
  "relay: the four retained screens, dark and light, at 1440 and 1024",
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

    const scenes = ["completion-middle", "blocked-relay", "batch-chain", "completion-last"];
    const plan = [];
    for (const theme of ["dark", "light"]) {
      for (const width of [1440, 1024]) {
        for (const scene of scenes) plan.push({ kind: "shot", theme, width, scene });
      }
    }

    await writeFile(
      join(workDir, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
const plan = ${JSON.stringify(plan)};
const outDir = ${JSON.stringify(artifactRoot)};
const scenes = ${JSON.stringify(scenes)};
const call = (win, script) => win.webContents.executeJavaScript(script);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  let failure = null;
  const check = (value, label) => { if (!value || value.ok !== true) throw new Error(label + ": " + JSON.stringify(value)); };
  const probe = () => call(win, "JSON.stringify(window.shot.probe())").then((raw) => JSON.parse(raw));
  // Every picture is measured, not eyeballed: the card sits above the composer's
  // input, and the topbar sits in the main pane instead of across the sidebar.
  const assertLayout = (seen, scene) => {
    const { input, card, topbar, sidebar, sidebarRow, composer } = seen.layout;
    if (!input) throw new Error(scene + ": the composer input is not on screen");
    if (!sidebar) throw new Error(scene + ": the sidebar is not on screen");
    if (!topbar) throw new Error(scene + ": the topbar is not inside the main pane");
    if (!sidebarRow) throw new Error(scene + ": the sidebar's bot group is not on screen");
    // Every picture is of a card; an empty dock would be a picture of a failed
    // read, not of the product.
    if (!card) throw new Error(scene + ": no card is on screen");
    if (!seen.layout.cardInStack) {
      throw new Error(scene + ": the card is not inside the composer's stack");
    }
    // R1: a dock card is layered above the input, inside the composer's own
    // dock — never under it, and never off the top of the window.
    if (card.bottom > input.top + 2) {
      throw new Error(scene + ": the card (" + card.bottom + ") runs under the input (" + input.top + ")");
    }
    if (card.top < 0) throw new Error(scene + ": the card starts above the window (" + card.top + ")");
    if (composer && composer.bottom > seen.layout.viewportBottom + 2) {
      throw new Error(scene + ": the composer (" + composer.bottom + ") runs past the window ("
        + seen.layout.viewportBottom + ")");
    }
    // R2: the topbar is absolutely positioned, so it spans whichever box is
    // positioned around it — the main pane, not the window over the sidebar.
    if (topbar.left < sidebar.right) {
      throw new Error(scene + ": the topbar (" + topbar.left + ") overlaps the sidebar (" + sidebar.right + ")");
    }
    if (sidebarRow.top < 0) {
      throw new Error(scene + ": the sidebar's first row is clipped (" + sidebarRow.top + ")");
    }
  };
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    win.setContentSize(1440, 900);
    await call(win, "new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const tick = () => { if (window.shot) return resolve(true); if (Date.now() > deadline) return reject(new Error('renderer never loaded')); setTimeout(tick, 50); }; tick(); })");
    for (const entry of plan) {
      if (entry.kind === "shot") {
        win.setContentSize(entry.width, 900);
        const rendered = await call(win, "window.shot.render(" + JSON.stringify(entry.scene) + "," + JSON.stringify(entry.theme) + ")");
        if (!rendered || rendered.ok !== true) throw new Error("scene " + entry.scene + " did not render: " + JSON.stringify(rendered));
        await new Promise((resolve) => setTimeout(resolve, 150));
        assertLayout(await probe(), entry.scene);
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
  const child = createRequire(import.meta.url)("node:child_process").spawn(binary, args, {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
}