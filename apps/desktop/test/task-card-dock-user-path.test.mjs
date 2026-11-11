import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * The steward's task card as a person operates it (ADR
 * bot-sessions-and-steward §3), in a real Electron renderer: the production
 * component, a stubbed `window.minihAgent`, and real `click()` calls on the
 * buttons the person sees.
 *
 * What this proves, and why it has to be a real render:
 *
 * - "Start" sends the hash that is on screen — read back from the rendered
 *   `data-card-hash`, not from a fixture field.
 * - It sends it exactly once. While the request is in flight both buttons are
 *   disabled, so a second click is not possible and produces no second call.
 * - A CONFLICT repaints from `taskCard.list` and returns in one confirm call:
 *   the confirmation is never retried on the person's behalf.
 * - Discard calls `taskCard.drop` and the card leaves the screen.
 * - A non-steward session mounts no dock and issues no `taskCard.*` call.
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
import { TaskCardDock } from "../../apps/desktop/src/features/bots/TaskCardDock";
import { isStewardSession } from "../../apps/desktop/src/features/bots/bot-status";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });

const calls = [];
const listeners = new Map();
let confirmBehaviour = "ok";
let drafts = [proposal("hash-from-screen", "Ship the employee surface")];
let releaseConfirm = null;

function proposal(cardHash, goal) {
  return {
    id: "draft-1", sessionId: "steward-1", status: "proposed",
    card: {
      goal, criteria: [{ id: "c1", text: "Sidebar lists employees" }],
      boundaries: ["Do not touch main"], permissionMode: "ask",
      mustAsk: ["deploy", "delete", "spend"], risk: "low",
    },
    cardHash, sourceUtterance: "让员工先能看见",
    targetSessionId: "bot-1", targetTitle: "Desktop 前端",
    createdAt: "2026-11-11T00:00:00.000Z", updatedAt: "2026-11-11T00:00:00.000Z",
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
    if (channel === IPC.invoke.taskCardList) return { ok: true, data: { drafts } };
    if (channel === IPC.invoke.taskCardDrop) {
      drafts = [];
      return { ok: true, data: { draft: { id: input.draftId, status: "dropped" } } };
    }
    if (channel === IPC.invoke.taskCardConfirm) {
      if (confirmBehaviour === "hold") await new Promise((resolve) => { releaseConfirm = resolve; });
      if (confirmBehaviour === "conflict") {
        // The host froze a revised card while the screen still showed the old one.
        drafts = [proposal("hash-revised", "Ship the employee surface (revised)")];
        return { ok: false, error: { message: "card changed", code: "CONFLICT" } };
      }
      drafts = [{ ...drafts[0], status: "confirmed", confirmedAt: "2026-11-11T03:04:05.000Z" }];
      return { ok: true, data: { draft: drafts[0], deliveryId: "delivery-1" } };
    }
    return { ok: true, data: undefined };
  },
};

const rootNode = createRoot(document.getElementById("root"));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }
async function until(predicate, label) {
  for (let n = 0; n < 180; n += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error("timed out waiting for " + label + " body=" + document.body.textContent);
}
const button = (label) => [...document.querySelectorAll("button")]
  .find((node) => node.textContent.replace(/\s+/g, " ").trim() === label);
const setDrafts = (next) => { drafts = next; };
const clearCalls = () => { calls.length = 0; };
const callsTo = (channel) => calls.filter((call) => call.channel === channel);

function mount(session) {
  flushSync(() => rootNode.render(React.createElement(React.Fragment, null,
    session && isStewardSession(session)
      ? React.createElement(TaskCardDock, { sessionId: session.id })
      : null)));
}

window.taskCardProbe = async () => {
  const report = {};

  // 1. A proposed card appears from the host, before any event.
  mount({ id: "steward-1", role: "bot", botProfile: { definition: "steward" } });
  await until(() => button("Start"), "the proposed card");
  const firstListCount = callsTo(IPC.invoke.taskCardList).length;
  check(firstListCount === 1, "mount did not read the drafts exactly once");
  const rendered = document.querySelector("[data-card-hash]").getAttribute("data-card-hash");
  check(rendered === "hash-from-screen", "the card did not render the host hash: " + rendered);

  // 2. Start sends the rendered hash once, and both buttons lock while in flight.
  confirmBehaviour = "hold";
  clearCalls();
  flushSync(() => button("Start").click());
  await until(() => callsTo(IPC.invoke.taskCardConfirm).length === 1, "the confirm call");
  const confirmCall = callsTo(IPC.invoke.taskCardConfirm)[0];
  report.confirmInput = confirmCall.input;
  check(confirmCall.input.cardHash === rendered,
    "confirm sent " + confirmCall.input.cardHash + " instead of the rendered " + rendered);
  flushSync(() => {});
  report.startDisabled = button("Starting…")?.disabled ?? button("Start")?.disabled;
  report.dropDisabled = button("Discarding…")?.disabled ?? button("Discard")?.disabled;
  check(report.startDisabled === true && report.dropDisabled === true,
    "the buttons stayed clickable during the request");
  // A second click while the request is in flight must not queue another call.
  const startWhileBusy = button("Starting…") ?? button("Start");
  if (startWhileBusy) flushSync(() => startWhileBusy.click());
  check(callsTo(IPC.invoke.taskCardConfirm).length === 1, "a second click sent a second confirm");
  releaseConfirm();
  await until(() => document.querySelector(".task-card-dispatched"), "the dispatched line");
  check(callsTo(IPC.invoke.taskCardConfirm).length === 1, "the request was sent more than once");

  // 3. A confirm that collides with a revised card reloads and never retries.
  setDrafts([proposal("hash-from-screen", "Ship the employee surface")]);
  confirmBehaviour = "conflict";
  clearCalls();
  mount({ id: "steward-1", role: "bot", botProfile: { definition: "steward" } });
  await until(() => button("Start"), "the card to come back");
  clearCalls();
  flushSync(() => button("Start").click());
  await until(() => document.querySelector(".task-card-error"), "the conflict message");
  await settle();
  check(callsTo(IPC.invoke.taskCardConfirm).length === 1,
    "a conflict sent the confirmation more than once");
  check(callsTo(IPC.invoke.taskCardList).length >= 1, "a conflict did not reload the card");
  check(/The card changed/.test(document.body.textContent), "no conflict explanation was shown");
  check(document.querySelector("[data-card-hash]").getAttribute("data-card-hash") === "hash-revised",
    "the conflict did not repaint the host's revised card");

  // 4. Discard calls drop and the card leaves the screen.
  setDrafts([proposal("hash-abc", "Ship the employee surface")]);
  confirmBehaviour = "ok";
  mount({ id: "steward-1", role: "bot", botProfile: { definition: "steward" } });
  await until(() => button("Discard"), "the card for discard");
  clearCalls();
  flushSync(() => button("Discard").click());
  await until(() => callsTo(IPC.invoke.taskCardDrop).length === 1, "the drop call");
  check(callsTo(IPC.invoke.taskCardDrop)[0].input.draftId === "draft-1", "drop sent the wrong id");
  await until(() => !document.querySelector(".task-card"), "the card to leave the screen");

  // 5. A non-steward session mounts no dock and issues no taskCard call.
  setDrafts([proposal("hash-abc", "Ship the employee surface")]);
  clearCalls();
  mount({ id: "plain-1", role: "bot", botProfile: { definition: "fixer" } });
  await settle();
  check(!document.querySelector("[data-testid='task-card-dock']"), "a non-steward session rendered a dock");
  mount({ id: "user-1", role: "user" });
  await settle();
  check(!document.querySelector("[data-testid='task-card-dock']"), "a user session rendered a dock");
  report.nonStewardCalls = calls.filter((call) => call.channel.includes("taskCard")).length;
  check(report.nonStewardCalls === 0, "a non-steward session issued a taskCard call");

  flushSync(() => rootNode.unmount());
  report.passed = true;
  return report;
};
`;

test("task-card dock: start sends the shown hash once, conflict repaints, discard drops", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-task-card-ui-"));
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
    await writeFile(join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("TASK_CARD_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.taskCardProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith("TASK_CARD_PROBE "));
    assert.ok(line, output.slice(-6000));
    const report = JSON.parse(line.slice("TASK_CARD_PROBE ".length));
    assert.equal(report.passed, true);
    assert.deepEqual(report.confirmInput, { draftId: "draft-1", cardHash: "hash-from-screen" });
    assert.equal(report.startDisabled, true);
    assert.equal(report.dropDisabled, true);
    assert.equal(report.nonStewardCalls, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
