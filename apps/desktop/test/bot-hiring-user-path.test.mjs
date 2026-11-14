import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * Hiring as a person does it (employee mode 0.5 slice 6), in a real Electron
 * renderer with real clicks.
 *
 * Four promises, and none of them can be shown by rendering HTML:
 *
 * - a template opens a **prefilled form**, and the employee exists only after
 *   the person saves it;
 * - a one-sentence draft opens the same form with the model's reason, and
 *   cancelling creates nothing;
 * - the team norms are saved to the host and are still there when the page is
 *   opened again;
 * - the created employee reaches the sidebar, because that is where the person
 *   looks for it.
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
import { BotSidebarGroup } from "../../apps/desktop/src/features/bots/BotSidebarGroup";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });

const calls = [];
let bots = [];
let norms = { communication: "", scope: "", delivery: "" };
const draft = {
  templateId: "backend",
  name: "Router billing",
  duty: "Minih-Router accounts and billing.",
  permissionMode: "accept-edits",
  mustAsk: ["push", "deploy", "delete", "spend"],
  projectPath: "/repo/Minih-Router",
  reason: "the sentence names the gateway's billing code",
};

function employee(sessionId, name) {
  return {
    sessionId, title: name,
    profile: { name, permissionMode: "ask", mustAsk: ["deploy", "delete", "spend"], observe: true },
    status: { kind: "idle" },
    updatedAt: "2026-11-14T00:00:00.000Z", createdAt: "2026-11-14T00:00:00.000Z",
  };
}

function hasNorms() {
  return Boolean(norms.communication || norms.scope || norms.delivery);
}

window.minihAgent = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, input) {
    calls.push({ channel, input });
    if (channel === IPC.invoke.botList) return { ok: true, data: { bots } };
    if (channel === IPC.invoke.subagentCatalog) {
      const names = ["explorer", "code-reviewer", "test-runner", "fixer", "ui-designer", "steward"];
      return { ok: true, data: { subagents: [], builtins: names.map((name) => ({ name, enabled: true })), diagnostics: [], projectPath: null } };
    }
    if (channel === IPC.invoke.providersList) {
      return { ok: true, data: { providers: [
        { id: "anthropic", name: "Anthropic", enabled: true, hasSecret: true, models: [{ id: "claude-x", label: "Claude X" }] },
        { id: "google", name: "Google", enabled: true, hasSecret: true, models: [{ id: "gemini-3-pro", label: "Gemini 3 Pro" }] },
      ] } };
    }
    if (channel === IPC.invoke.projectList) {
      return { ok: true, data: { projects: [{ path: "/repo/Minih-Router", name: "Minih-Router" }] } };
    }
    if (channel === IPC.invoke.botCreate) {
      const created = employee("created-1", input.profile.name);
      created.profile = { ...input.profile };
      created.projectPath = input.projectPath;
      created.modelKey = input.modelKey;
      bots = [created, ...bots];
      return { ok: true, data: { session: { id: "created-1", title: input.profile.name } } };
    }
    if (channel === IPC.invoke.botDraftHire) return { ok: true, data: { draft } };
    if (channel === IPC.invoke.teamNormsGet) return { ok: true, data: { norms: hasNorms() ? norms : null } };
    if (channel === IPC.invoke.teamNormsSet) {
      norms = { ...input.norms };
      return { ok: true, data: { norms } };
    }
    return { ok: true, data: undefined };
  },
};

const rootNode = createRoot(document.getElementById("root"));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
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
const template = (id) => document.querySelector("[data-template-id='" + id + "']");
// The form's fields are inside a <label>; the norms' textareas carry an
// aria-label. Both are "the field with this name" to a person.
const field = (label) => {
  const direct = [...document.querySelectorAll("input, textarea")]
    .find((node) => (node.getAttribute("aria-label") || "") === label);
  if (direct) return direct;
  const labelNode = [...document.querySelectorAll("label")]
    .find((node) => node.textContent.replace(/\s+/g, " ").trim().startsWith(label));
  return labelNode ? labelNode.querySelector("input, textarea") : null;
};
const select = (label) => document.querySelector("[aria-label='" + label + "']");
const text = () => document.body.textContent.replace(/\s+/g, " ");
const callsTo = (channel) => calls.filter((call) => call.channel === channel);
const clearCalls = () => { calls.length = 0; };
const setValue = (node, value) => {
  const setter = Object.getOwnPropertyDescriptor(node.constructor.prototype, "value").set;
  setter.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
};

async function renderPage() {
  flushSync(() => rootNode.render(React.createElement(BotsSettingsPage, { bots })));
  await settle();
}

window.hiringProbe = async () => {
  const report = {};

  // A fresh install: hiring is offered, and nothing exists yet.
  bots = [];
  clearCalls();
  await renderPage();
  check(template("review"), "the templates were not offered");
  check(button("Start from blank"), "the blank path is missing");
  check(callsTo(IPC.invoke.botCreate).length === 0, "opening the page created an employee");

  // 1. A template opens a prefilled form — and creates nothing yet.
  flushSync(() => template("review").click());
  await settle();
  const nameField = field("Name");
  check(nameField, "the form did not open");
  check(nameField.value === "Review", "the template did not prefill the name: " + nameField.value);
  check(field("Duty")?.value.length > 0, "the template did not prefill the duty");
  // The installed definition, not the template's first candidate if it is absent.
  check(text().includes("code-reviewer"),
    "the definition was not resolved: " + text().slice(0, 400));
  check(callsTo(IPC.invoke.botCreate).length === 0, "clicking a template created an employee");
  report.createCallsAfterTemplate = callsTo(IPC.invoke.botCreate).length;

  // 2. Saving creates it, with the template's definition and its ceiling.
  flushSync(() => button("Save").click());
  await until(() => callsTo(IPC.invoke.botCreate).length === 1, "the create call");
  await settle();
  const created = callsTo(IPC.invoke.botCreate)[0].input;
  report.createdDefinition = created.profile.definition;
  report.createdName = created.profile.name;
  check(created.profile.definition === "code-reviewer", "the wrong definition was saved");
  // A review is read-only: its ceiling is ask, whatever the form shows.
  check(created.profile.permissionMode === "ask",
    "a review hire was saved wider than ask: " + created.profile.permissionMode);
  check(created.profile.mustAsk.includes("deploy") && created.profile.mustAsk.includes("spend"),
    "the always-asked actions were dropped");
  check(text().includes("Review"), "the created employee is not on the page");

  // The sidebar renders the same list, so the new employee is where the person
  // looks for it.
  flushSync(() => rootNode.render(React.createElement(BotSidebarGroup, {
    activeSessionId: null, onOpenBot() {}, onOpenTask() {}, bots, tasks: [],
  })));
  await settle();
  check(text().includes("Review"), "the created employee did not reach the sidebar");

  // 3. A one-sentence draft opens the same form, with the model's reason, and
  //    cancelling creates nothing.
  bots = [];
  clearCalls();
  await renderPage();
  const box = field("Describe the person you want to hire, in one sentence");
  check(box, "there is no one-sentence box");
  flushSync(() => setValue(box, "招一个管 Router 计费的后端"));
  await settle();
  flushSync(() => button("Draft").click());
  await until(() => callsTo(IPC.invoke.botDraftHire).length === 1, "the draft call");
  await settle();
  check(callsTo(IPC.invoke.botDraftHire)[0].input.utterance.includes("Router"),
    "the sentence was not sent");
  check(field("Name")?.value === "Router billing",
    "the draft did not prefill the name: " + field("Name")?.value);
  check(text().includes("Why this job"), "the draft's reason is not shown: " + text());
  check(text().includes("Minih-Router"),
    "the draft's project is not preselected: " + text().slice(0, 400));
  check(callsTo(IPC.invoke.botCreate).length === 0, "a draft created an employee by itself");
  flushSync(() => button("Cancel").click());
  await settle();
  report.createCallsAfterCancel = callsTo(IPC.invoke.botCreate).length;
  check(callsTo(IPC.invoke.botCreate).length === 0, "cancelling still created an employee");

  // 4. Team norms: typed, saved, and still there when the page opens again.
  const communication = field("Communication");
  check(communication, "the norms editor is not on the page");
  flushSync(() => setValue(communication, "Lead with the conclusion."));
  await settle();
  flushSync(() => button("Save norms").click());
  await until(() => callsTo(IPC.invoke.teamNormsSet).length === 1, "the norms save");
  await settle();
  report.normsSaved = callsTo(IPC.invoke.teamNormsSet)[0].input.norms.communication;
  check(report.normsSaved === "Lead with the conclusion.", "the norms were not sent");
  check(text().includes("Saved"), "the page did not confirm the save: " + text());

  // Leaving the page and coming back reads the stored set.
  flushSync(() => rootNode.unmount());
  await settle();
  const again = createRoot(document.getElementById("root"));
  flushSync(() => again.render(React.createElement(BotsSettingsPage, { bots })));
  await settle();
  check(field("Communication")?.value === "Lead with the conclusion.",
    "the norms did not survive reopening the page: " + field("Communication")?.value);

  flushSync(() => again.unmount());
  report.passed = true;
  return report;
};
`;

test("hiring: a template prefills, a draft prefills, and nothing is created without a save", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
  timeout: 300_000,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-bot-hiring-ui-"));
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
  const win = new BrowserWindow({ show: false, width: 1000, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const report = await win.webContents.executeJavaScript("window.hiringProbe()");
    console.log("HIRING_PROBE " + JSON.stringify(report));
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith("HIRING_PROBE "));
    assert.ok(line, output.slice(-6000));
    const report = JSON.parse(line.slice("HIRING_PROBE ".length));
    assert.equal(report.passed, true);
    assert.equal(report.createCallsAfterTemplate, 0);
    assert.equal(report.createdDefinition, "code-reviewer");
    assert.equal(report.createdName, "Review");
    assert.equal(report.createCallsAfterCancel, 0);
    assert.equal(report.normsSaved, "Lead with the conclusion.");
    console.log(`✔ template → definition ${report.createdDefinition}`);
    console.log(`✔ draft cancelled → ${report.createCallsAfterCancel} creates`);
    console.log(`✔ norms saved and still there after reopening: ${report.normsSaved}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});