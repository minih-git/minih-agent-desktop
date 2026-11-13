import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
import { loadStyles } from "./helpers/styles.mjs";

/*
 * The secretary's slice-3 surfaces, as a person operates them (employee mode 0.5
 * §3), in a real Electron renderer with real clicks:
 *
 * - the card's **reason** ("why this employee") is rendered as the steward wrote
 *   it, and the **assignee is a dropdown**: changing it calls `taskCard.reassign`,
 *   the card comes back with the hash the host recomputed, and it is still
 *   waiting for "Start";
 * - a card the host started by itself folds into the quiet "started
 *   automatically" line instead of a card nobody has to act on;
 * - a task the startup fence interrupted says **"Interrupted"** in the sidebar,
 *   and its 「重新开工」 button calls `task.restart` with that task's id.
 *
 * It also writes the four screenshots the review asks for — dark and light, the
 * cards and the interrupted task — into `.artifacts/`, from the same window with
 * `capturePage()`, so the styling is evidence rather than a claim.
 *
 * The host is stubbed at `window.minihAgent`, the same seam the renderer uses in
 * production, so the assertions are about what the person sees and what the app
 * asks the host to do.
 */

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const artifacts = join(root, ".artifacts");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { TaskCardDock } from "../../apps/desktop/src/features/bots/TaskCardDock";
import { BotTaskList } from "../../apps/desktop/src/features/bots/BotTaskList";
import { TaskRestartButton } from "../../apps/desktop/src/features/bots/TaskRestartButton";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });

const calls = [];
const listeners = new Map();
let drafts = [proposal("hash-1")];
let autoStarted = false;

function proposal(cardHash) {
  return {
    id: "draft-1", sessionId: "steward-1",
    status: autoStarted ? "confirmed" : "proposed",
    ...(autoStarted ? { confirmedBy: "policy", confirmedAt: "2026-11-12T10:00:00.000Z" } : {}),
    card: {
      goal: "Add an employee board page: the sidebar group opens the workbench",
      criteria: [{ id: "c1", text: "The sidebar lists employees" }],
      boundaries: ["Do not touch the send path"],
      permissionMode: "accept-edits",
      mustAsk: ["deploy", "delete", "spend"],
      risk: "low",
      reason: "The task is pages and interaction; you mentioned Desktop; it is idle.",
    },
    cardHash, sourceUtterance: "Desktop 加一个员工看板页面",
    targetSessionId: "bot-1", targetTitle: "Desktop 前端",
    createdAt: "2026-11-12T09:00:00.000Z", updatedAt: "2026-11-12T09:00:00.000Z",
  };
}

const interruptedTask = {
  id: "task-interrupted", employeeSessionId: "bot-1", sessionId: "task-session-1",
  title: "Fix the login timeout", origin: "steward", stage: "working",
  deliveryId: "delivery-1", deliveryStatus: "interrupted",
  deliveryUpdatedAt: "2026-11-12T09:30:00.000Z",
  projectPath: "/repo/minih-agent-desktop", workspaceStatus: "ready",
  createdAt: "2026-11-12T09:00:00.000Z", shortId: "task-i",
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
    if (channel === IPC.invoke.taskCardList) return { ok: true, data: { drafts } };
    if (channel === IPC.invoke.botList) {
      return { ok: true, data: { bots: [
        bot("bot-1", "Desktop 前端"),
        bot("bot-2", "Router 后端"),
      ] } };
    }
    if (channel === IPC.invoke.taskCardReassign) {
      // The host narrowed the card and recomputed its hash; it is still proposed.
      const narrowed = input.targetSessionId === "bot-2" ? "ask" : "accept-edits";
      drafts = [{ ...proposal("hash-reassigned"), targetSessionId: input.targetSessionId,
        targetTitle: input.targetSessionId === "bot-2" ? "Router 后端" : "Desktop 前端",
        card: { ...proposal("hash-reassigned").card, permissionMode: narrowed } }];
      return { ok: true, data: { draft: drafts[0], repoAvailable: true } };
    }
    if (channel === IPC.invoke.taskRestart) {
      return { ok: true, data: { task: { ...interruptedTask, deliveryStatus: "queued", stage: "queued" } } };
    }
    if (channel === IPC.invoke.taskList) return { ok: true, data: { tasks: [interruptedTask] } };
    return { ok: true, data: undefined };
  },
};

function bot(sessionId, name) {
  return {
    sessionId, title: name,
    profile: { name, duty: "Desktop renderer and shell", permissionMode: "accept-edits", mustAsk: [], observe: false },
    status: { kind: "idle" }, projectPath: "/repo/minih-agent-desktop",
    updatedAt: "2026-11-12T09:00:00.000Z", createdAt: "2026-11-11T09:00:00.000Z",
  };
}

const rootNode = createRoot(document.getElementById("root"));
const frame = () => new Promise(requestAnimationFrame);
async function settle(times = 2) { for (let n = 0; n < times; n += 1) await frame(); }
// The product fades its surfaces in; a capture taken mid-animation is a dark
// smear, not a screenshot. Same rule as bot-workbench-visual.test.mjs:
// finish every finite effect, leave the infinite ones alone.
function finishAnimations() {
  for (const animation of document.getAnimations()) {
    const timing = animation.effect && animation.effect.getTiming ? animation.effect.getTiming() : null;
    if (timing && timing.iterations === Infinity) continue;
    try { animation.finish(); } catch { /* idle or infinite: nothing to finish */ }
  }
}
document.documentElement.dataset.platform = "darwin";
function check(condition, message) { if (!condition) throw new Error(message); }
async function until(predicate, label) {
  for (let n = 0; n < 240; n += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error("timed out waiting for " + label + " body=" + document.body.textContent);
}
const button = (label) => [...document.querySelectorAll("button")]
  .find((node) => node.textContent.replace(/\s+/g, " ").trim() === label);
const callsTo = (channel) => calls.filter((call) => call.channel === channel);
const clearCalls = () => { calls.length = 0; };

function showCards() {
  flushSync(() => rootNode.render(null));
  flushSync(() => rootNode.render(React.createElement(TaskCardDock, { sessionId: "steward-1" })));
}

function showInterrupted() {
  flushSync(() => rootNode.render(null));
  flushSync(() => rootNode.render(React.createElement("div", { className: "bot-task-list" },
    React.createElement(BotTaskList, { tasks: [interruptedTask], onOpenTask: () => {} }),
    React.createElement(TaskRestartButton, { task: interruptedTask }))));
}

window.stewardSlice3Probe = async () => {
  const report = {};

  // 1. The card, as the steward proposed it: goal, the reason, the picker.
  showCards();
  await until(() => button("Start"), "the proposed card");
  const reason = document.querySelector("[data-card-reason]");
  check(reason, "the card did not render the steward's reason");
  report.reason = reason.textContent.trim();
  check(report.reason === "The task is pages and interaction; you mentioned Desktop; it is idle.",
    "the reason was not shown as written: " + report.reason);
  const select = document.querySelector("[data-card-assign]");
  check(select, "the assignee was not a picker");
  report.options = [...select.options].map((option) => option.textContent.trim());
  check(report.options.length === 3, "the picker did not offer the roster: " + report.options.join(","));

  // 2. Picking another employee is a click, and it re-asks nothing: the host
  //    answers with the narrowed card and its new hash, which is what is shown.
  clearCalls();
  flushSync(() => {
    select.value = "bot-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await until(() => callsTo(IPC.invoke.taskCardReassign).length === 1, "the reassign call");
  report.reassign = callsTo(IPC.invoke.taskCardReassign)[0].input;
  await until(() => document.querySelector("[data-card-hash]")?.getAttribute("data-card-hash") === "hash-reassigned",
    "the reassigned card");
  check(document.querySelector("[data-card-assign]").value === "bot-2",
    "the picker did not keep the person's choice");
  check(button("Start"), "the reassigned card no longer waits for the person");

  // 3. A card the host started on its own folds into one quiet line.
  autoStarted = true;
  drafts = [proposal("hash-auto")];
  showCards();
  await until(() => document.querySelector("[data-auto-started]"), "the auto-started line");
  report.autoStarted = document.querySelector("[data-auto-started]").textContent.trim();
  check(/Started automatically for/.test(report.autoStarted),
    "the collapsed row did not say what happened: " + report.autoStarted);
  check(!document.querySelector("[data-card-reason]"), "an auto-started card still asked to be read");

  // 4. The interrupted task says so, and 「重新开工」 is one click.
  showInterrupted();
  await until(() => document.querySelector("[data-task-restart]"), "the interrupted task");
  report.sidebarStage = [...document.querySelectorAll(".sidebar-bot-task-stage")]
    .map((node) => node.textContent.trim())[0];
  check(report.sidebarStage === "Interrupted",
    "the sidebar did not show the interruption: " + report.sidebarStage);
  clearCalls();
  flushSync(() => button("Start again").click());
  await until(() => callsTo(IPC.invoke.taskRestart).length === 1, "the restart call");
  report.restart = callsTo(IPC.invoke.taskRestart)[0].input;
  check(report.restart.taskId === "task-interrupted", "restart sent " + report.restart.taskId);

  report.passed = true;
  return report;
};

// The two surfaces, as the screenshots capture them. Main drives the capture:
// it asks the page to render one screen in one theme, waits two frames, and
// captures the window it is already looking at.
window.stewardScreens = {
  cards: async (theme) => {
    document.documentElement.dataset.theme = theme;
    autoStarted = false;
    drafts = [proposal("hash-1")];
    showCards();
    await until(() => button("Start"), "the card for the screenshot");
    finishAnimations();
    await settle(2);
    return true;
  },
  autoStarted: async (theme) => {
    document.documentElement.dataset.theme = theme;
    autoStarted = true;
    drafts = [proposal("hash-auto")];
    showCards();
    await until(() => document.querySelector("[data-auto-started]"), "the auto row for the screenshot");
    finishAnimations();
    await settle(2);
    return true;
  },
  interrupted: async (theme) => {
    document.documentElement.dataset.theme = theme;
    showInterrupted();
    await until(() => document.querySelector("[data-task-restart]"), "the interrupted row for the screenshot");
    finishAnimations();
    await settle(2);
    return true;
  },
};
`;

test(
  "employee mode 0.5 slice 3: card reason, assignee picker, auto-start row, interrupted task",
  { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "pi-steward-slice3-"));
    await mkdir(artifacts, { recursive: true });
    try {
      // The effective stylesheet, exactly as `globals.css` sequences it, so a
      // screenshot can never show rules the app does not load (that is the bug
      // `bot-ui-class-styles` guards, seen from the other side). Two edits for
      // this host only: the Tailwind import has no bundler here, and `@theme` is
      // the Tailwind v4 block — it becomes a plain `:root` so the same custom
      // properties the app ships are defined.
      const styles = [
        (await loadStyles())
          .replace(/^@import "tailwindcss";\s*$/m, "")
          .replace(/@theme\s*\{/, ":root {"),
      ];

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
        `<!doctype html><meta charset="utf-8"><style>${styles.join("\n")}</style>` +
          '<div id="root"></div><script type="module" src="renderer.js"></script>',
      );
      await writeFile(
        join(temp, "main.cjs"),
        `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const artifacts = ${JSON.stringify(artifacts)};
app.disableHardwareAcceleration();
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("STEWARD_SLICE3_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.stewardSlice3Probe()")));
    // Screenshots come from this very window: what the page rendered is what the
    // PNG shows. Two frames settle React and the layout before each capture.
    const shots = [];
    const step = async (name, script) => {
      await win.webContents.executeJavaScript(script);
      await win.webContents.executeJavaScript(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const image = await win.webContents.capturePage();
      const file = path.join(artifacts, name + ".png");
      const png = image.toPNG();
      fs.writeFileSync(file, png);
      shots.push({ file, bytes: png.length, size: image.getSize() });
    };
    await step("steward-cards-dark", "window.stewardScreens.cards('dark')");
    await step("steward-cards-light", "window.stewardScreens.cards('light')");
    await step("steward-auto-started-dark", "window.stewardScreens.autoStarted('dark')");
    await step("steward-auto-started-light", "window.stewardScreens.autoStarted('light')");
    await step("task-interrupted-dark", "window.stewardScreens.interrupted('dark')");
    await step("task-interrupted-light", "window.stewardScreens.interrupted('light')");
    console.log("STEWARD_SLICE3_SCREENS " + JSON.stringify(shots));
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
      const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
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
      const line = output.split(/\r?\n/).find((item) => item.startsWith("STEWARD_SLICE3_PROBE "));
      assert.ok(line, output.slice(-6000));
      const report = JSON.parse(line.slice("STEWARD_SLICE3_PROBE ".length));
      assert.equal(report.passed, true);
      assert.equal(
        report.reason,
        "The task is pages and interaction; you mentioned Desktop; it is idle.",
      );
      assert.equal(report.options.length, 3);
      assert.deepEqual(report.reassign, { draftId: "draft-1", targetSessionId: "bot-2" });
      assert.match(report.autoStarted, /Started automatically for/);
      assert.equal(report.sidebarStage, "Interrupted");
      assert.deepEqual(report.restart, { taskId: "task-interrupted" });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);