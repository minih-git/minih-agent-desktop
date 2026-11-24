import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * The employee profile form as a person operates it (ADR
 * bot-sessions-and-steward §1), in a real Electron renderer with real clicks.
 *
 * One promise is tested, and it cannot be shown by rendering HTML: deploy,
 * delete and spend stay checked when they are clicked, because the executing
 * side adds them regardless of what the control says.
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
import { BotFormCard } from "../../apps/desktop/src/features/bots/BotFormCard";
import { draftFromBot } from "../../apps/desktop/src/features/bots/bot-draft";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });

// A stored profile that carries none of the three: the form has to show them
// checked anyway, because the host adds them to every card.
const stored = {
  sessionId: "s-1", title: "Router 后端",
  profile: { name: "Router 后端", permissionMode: "ask", mustAsk: [], observe: true },
  status: { kind: "idle" },
  updatedAt: "2026-11-11T00:00:00.000Z", createdAt: "2026-11-11T00:00:00.000Z",
};

const rootNode = createRoot(document.getElementById("root"));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }

window.employeeFormProbe = async () => {
  const report = {};
  flushSync(() => rootNode.render(React.createElement(BotFormCard, {
    initial: draftFromBot(stored),
    definitions: [{ id: "steward", label: "steward" }],
    title: "Edit employee", busy: false, error: null,
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

test("employee form: deploy, delete and spend cannot be un-asked", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  await runProbe("EMPLOYEE_FORM_PROBE", "window.employeeFormProbe()", (report) => {
    assert.equal(report.passed, true);
    assert.deepEqual(report.beforeClick, [true, true, true]);
    assert.deepEqual(report.afterClick, [true, true, true]);
    assert.deepEqual(report.freeBefore, [false, false, false]);
    assert.equal(report.freeAfterPush, true);
  });
});

async function runProbe(marker, expression, expect) {
  const temp = await mkdtemp(join(tmpdir(), "pi-employee-form-ui-"));
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