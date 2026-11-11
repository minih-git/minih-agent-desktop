import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * The employee settings page as a person operates it (ADR
 * bot-sessions-and-steward §1/§5), in a real Electron renderer with real
 * clicks.
 *
 * Three promises are tested, and none of them can be shown by rendering HTML:
 *
 * - opening the page creates nothing; the crew button calls `bot.seedDefaults`
 *   exactly once when clicked;
 * - one click on dismiss only asks; `bot.dismiss` is called after the second;
 * - deploy, delete and spend stay checked when they are clicked, because the
 *   executing side adds them regardless.
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
import { BotsSettingsPage } from "../../apps/desktop/src/features/bots/BotsSettingsPage";
import { BotFormCard } from "../../apps/desktop/src/features/bots/BotFormCard";
import { EMPTY_BOT_DRAFT } from "../../apps/desktop/src/features/bots/bot-draft";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });

const calls = [];
let bots = [];
window.minihAgent = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, input) {
    calls.push({ channel, input });
    if (channel === IPC.invoke.botList) return { ok: true, data: { bots } };
    if (channel === IPC.invoke.subagentCatalog) {
      return { ok: true, data: { subagents: [], builtins: [], diagnostics: [], projectPath: null } };
    }
    if (channel === IPC.invoke.botSeedDefaults) {
      bots = [employee("steward-seeded", "Steward")];
      return { ok: true, data: { created: [{ sessionId: "steward-seeded", name: "Steward" }], skipped: [] } };
    }
    if (channel === IPC.invoke.botDismiss) {
      bots = [];
      return { ok: true, data: { session: {} } };
    }
    return { ok: true, data: undefined };
  },
};

function employee(sessionId, name) {
  return {
    sessionId, title: name,
    profile: { name, permissionMode: "ask", mustAsk: ["deploy", "delete", "spend"], observe: true },
    status: { kind: "idle" },
    updatedAt: "2026-11-11T00:00:00.000Z", createdAt: "2026-11-11T00:00:00.000Z",
  };
}

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
const ariaButton = (label) => document.querySelector('button[aria-label="' + label + '"]');
const callsTo = (channel) => calls.filter((call) => call.channel === channel);
const clearCalls = () => { calls.length = 0; };

window.botsSettingsProbe = async () => {
  const report = {};

  // 1. With no employees, the page offers the crew and creates nothing on mount.
  bots = [];
  flushSync(() => rootNode.render(React.createElement(BotsSettingsPage, { bots: [] })));
  await settle();
  check(button("Create the default crew"), "the crew button was not offered");
  check(callsTo(IPC.invoke.botSeedDefaults).length === 0, "mounting the page seeded the crew");

  // 2. One click seeds exactly once.
  flushSync(() => button("Create the default crew").click());
  await until(() => callsTo(IPC.invoke.botSeedDefaults).length === 1, "the seed call");
  await settle();
  check(callsTo(IPC.invoke.botSeedDefaults).length === 1, "the crew was seeded more than once");
  report.seedCalls = callsTo(IPC.invoke.botSeedDefaults).length;

  // 3. Dismiss asks first: the first click issues no dismiss call.
  bots = [employee("s-1", "Steward")];
  clearCalls();
  flushSync(() => rootNode.render(React.createElement(BotsSettingsPage, { bots })));
  await settle();
  check(ariaButton("Dismiss employee"), "the dismiss control was not offered");
  flushSync(() => ariaButton("Dismiss employee").click());
  await settle();
  check(document.querySelector("[role='alertdialog']"), "no confirmation was asked");
  check(/becomes an ordinary session again/.test(document.body.textContent),
    "the confirmation does not say the conversation is kept");
  check(callsTo(IPC.invoke.botDismiss).length === 0, "one click already dismissed the employee");
  report.dismissAfterFirstClick = callsTo(IPC.invoke.botDismiss).length;

  // 4. Confirming dismisses exactly once.
  const confirm = [...document.querySelectorAll("[role='alertdialog'] button")]
    .find((node) => node.textContent.trim() === "Dismiss");
  flushSync(() => confirm.click());
  await until(() => callsTo(IPC.invoke.botDismiss).length === 1, "the dismiss call");
  await settle();
  check(callsTo(IPC.invoke.botDismiss)[0].input.sessionId === "s-1", "dismiss sent the wrong session");
  check(callsTo(IPC.invoke.botDismiss).length === 1, "dismiss ran more than once");
  report.dismissAfterConfirm = callsTo(IPC.invoke.botDismiss).length;

  flushSync(() => rootNode.unmount());
  report.passed = true;
  return report;
};

window.botsFormProbe = async () => {
  const report = {};
  flushSync(() => rootNode.render(React.createElement(BotFormCard, {
    initial: EMPTY_BOT_DRAFT,
    definitions: [{ id: "steward", label: "steward" }],
    title: "New employee", busy: false, error: null,
    onCancel() {}, onSubmit() {},
  })));
  await settle();
  const locked = ["Deploy", "Delete", "Spend"];
  const free = ["Push", "Merge", "Change criteria"];
  const box = (label) => document.querySelector('input[aria-label="' + label + '"]');

  report.beforeClick = locked.map((label) => box(label).checked);
  check(report.beforeClick.every(Boolean), "the always-asked actions were not checked to begin with");
  check(locked.every((label) => box(label).disabled), "the always-asked actions were clickable");

  // Every way a person can reach the control leaves it checked: the input
  // itself and the wrapping label (which forwards clicks to it).
  for (const label of locked) flushSync(() => box(label).click());
  await settle();
  for (const label of locked) flushSync(() => box(label).closest("label")?.click());
  await settle();
  report.afterClick = locked.map((label) => box(label).checked);
  check(report.afterClick.every(Boolean), "a click cleared an always-asked action");

  // The optional actions do toggle.
  report.freeBefore = free.map((label) => box(label).checked);
  flushSync(() => box("Push").click());
  await settle();
  report.freeAfterPush = box("Push").checked;
  check(report.freeAfterPush === true, "an optional action could not be added");
  flushSync(() => box("Push").click());
  await settle();
  check(box("Push").checked === false, "an optional action could not be removed");

  flushSync(() => rootNode.unmount());
  report.passed = true;
  return report;
};
`;

test("employee settings: seeding needs a click and dismissing needs two", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  await runProbe("BOTS_SETTINGS_PROBE", "window.botsSettingsProbe()", (report) => {
    assert.equal(report.passed, true);
    assert.equal(report.seedCalls, 1);
    assert.equal(report.dismissAfterFirstClick, 0);
    assert.equal(report.dismissAfterConfirm, 1);
  });
});

test("employee form: deploy, delete and spend cannot be un-asked", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  await runProbe("BOTS_FORM_PROBE", "window.botsFormProbe()", (report) => {
    assert.equal(report.passed, true);
    assert.deepEqual(report.beforeClick, [true, true, true]);
    assert.deepEqual(report.afterClick, [true, true, true]);
    assert.deepEqual(report.freeBefore, [false, false, false]);
    assert.equal(report.freeAfterPush, true);
  });
});

async function runProbe(marker, expression, expect) {
  const temp = await mkdtemp(join(tmpdir(), "pi-bots-settings-ui-"));
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
  const win = new BrowserWindow({ show: false, width: 900, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log(${JSON.stringify(marker)} + " " + JSON.stringify(await win.webContents.executeJavaScript(${JSON.stringify(expression)})));
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith(`${marker} `));
    assert.ok(line, output.slice(-6000));
    expect(JSON.parse(line.slice(marker.length + 1)));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
