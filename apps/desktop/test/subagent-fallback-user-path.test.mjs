import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { SubagentEditorSheet } from "../../apps/desktop/src/components/settings/SubagentEditorSheet";
import { AgentSubagentsPage } from "../../apps/desktop/src/components/settings/AgentSubagentsPage";
import { IPC, fallbackBuiltinDefinitions } from "@minih-agent/shared";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import "../../apps/desktop/src/styles/model-config.css";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });
let ownedRecords = [];
const bodies = new Map();
const disabledBuiltins = new Set();
window.minihAgent = { platform: "win32", on() { return () => {}; },
  async invoke(channel, payload = {}) {
    const ok = (data) => ({ ok: true, data });
    if (channel === IPC.invoke.subagentList) return ok({ subagents: [...ownedRecords] });
    if (channel === IPC.invoke.subagentCatalog) {
      const activeUserIds = new Set(ownedRecords.filter((r) => r.enabled).map((r) => r.id));
      const builtins = fallbackBuiltinDefinitions()
        .filter((item) => !activeUserIds.has(item.name))
        .map((item) => ({
          ...item,
          enabled: !disabledBuiltins.has(item.name),
        }));
      return ok({ subagents: builtins, builtins, diagnostics: [], projectPath: null });
    }
    if (channel === IPC.invoke.subagentCreate) {
      const s = payload;
      const rec = {
        id: s.name,
        name: s.name,
        description: s.description,
        path: "/tmp/" + s.name + ".md",
        tools: s.tools,
        enabled: s.enabled ?? true,
        level: "global",
        sizeBytes: 64,
        createdAt: "",
        updatedAt: "",
      };
      ownedRecords = [...ownedRecords.filter((r) => r.id !== rec.id), rec];
      bodies.set(rec.id, s.body);
      return ok({ subagent: rec });
    }
    if (channel === IPC.invoke.subagentUpdate) {
      const { id, ...s } = payload;
      ownedRecords = ownedRecords.map((r) =>
        r.id === id
          ? { ...r, description: s.description, tools: s.tools, enabled: s.enabled ?? r.enabled }
          : r,
      );
      bodies.set(id, s.body);
      return ok({ subagent: ownedRecords.find((r) => r.id === id) });
    }
    if (channel === IPC.invoke.subagentRead) {
      const id = typeof payload === "string" ? payload : payload.id;
      return ok({
        subagent: ownedRecords.find((r) => r.id === id) ?? null,
        body: bodies.get(id) ?? "",
      });
    }
    if (channel === IPC.invoke.subagentRemove) {
      const id = typeof payload === "string" ? payload : payload.id;
      ownedRecords = ownedRecords.filter((r) => r.id !== id);
      bodies.delete(id);
      return ok({ ok: true });
    }
    if (channel === IPC.invoke.subagentSetBuiltinEnabled) {
      if (payload.enabled) disabledBuiltins.delete(payload.id);
      else disabledBuiltins.add(payload.id);
      return ok({ id: payload.id, enabled: payload.enabled });
    }
    throw new Error("Unexpected IPC in subagent user-path test: " + channel);
  } };
const provider = (id, name) => ({ id, name, vendorKey: "custom", enabled: true,
  hasSecret: true, hasOauth: false, authKind: "api_key_and_base_url", models: [{ id: "model" }] });
const providers = [provider("account-a", "Shared Workspace"),
  provider("account-b", "Shared Workspace"), provider("account-c", "Other Workspace")];
useAppStore.setState({ providers });
let draft = { id: "test", name: "Test", description: "Test delegate", tools: ["Read"],
  inheritTools: false, model: "", fallbackModels: ["account-a/model", "account-b/model", "deleted/model"],
  thinkingLevel: "", maxTokens: 0, enabled: true, body: "Read the workspace." };
let saved;
function Surface() {
  const [value, setValue] = React.useState(draft);
  return React.createElement(SubagentEditorSheet, { draft: value,
    setDraft: (next) => { draft = next; setValue(next); }, editing: { id: "test" }, saving: false,
    onClose() {}, onSave() { saved = [...draft.fallbackModels]; } });
}
const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(React.createElement(Surface)));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }
const rows = () => [...document.querySelectorAll("ol > li")];
const action = (label) => [...document.querySelectorAll("button")]
  .find((button) => button.getAttribute("aria-label") === label);
const labelA = "Shared Workspace/model (account-a)";
const labelB = "Shared Workspace/model (account-b)";
window.fallbackProbe = async () => {
  await settle();
  check(rows()[0].textContent.includes(labelA) && rows()[1].textContent.includes(labelB), "distinct provider identity missing");
  check(rows()[0].querySelector("button").disabled, "first row move-up must stay disabled");
  check(rows()[2].textContent.includes("deleted/model (unavailable)"), "unknown pin status missing");
  flushSync(() => useAppStore.setState({ providers: providers.map((p, index) => ({ ...p, enabled: index === 2 })) }));
  await settle();
  check(rows()[0].textContent.includes(labelA + " (Disabled)"), "disabled provider name missing");
  check(action("Remove " + labelB + " (Disabled)"), "disabled accessible identity missing");
  flushSync(() => action("Move " + labelA + " (Disabled) down").click());
  await settle();
  check(JSON.stringify(draft.fallbackModels) === JSON.stringify(["account-b/model", "account-a/model", "deleted/model"]), "move rewrote saved pins");
  flushSync(() => action("Remove " + labelB + " (Disabled)").click());
  await settle();
  check(JSON.stringify(draft.fallbackModels) === JSON.stringify(["account-a/model", "deleted/model"]), "remove rewrote remaining pins");
  const add = action(i18n.t("extensions.subagents.fallbackAdd"));
  flushSync(() => add.click());
  await settle();
  const menu = [...document.querySelectorAll('[role="listbox"]')]
    .find((candidate) => candidate.getAttribute("aria-label") === i18n.t("extensions.subagents.fallbackAdd"));
  check(menu, "fallback add menu did not stay open");
  const options = [...menu.querySelectorAll('[role="option"]')];
  check(options.length === 1 && menu.querySelector(".provider-service-group")?.textContent === "Other Workspace", "disabled provider offered for addition");
  const search = menu.querySelector('input[aria-label="' + i18n.t("extensions.subagents.modelSearch") + '"]');
  check(document.activeElement === search, "add picker did not focus search");
  flushSync(() => search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await settle();
  check(options[0].classList.contains("is-active"), "keyboard navigation did not select the eligible model");
  flushSync(() => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await settle();
  check(draft.fallbackModels[2] === "Other Workspace/model", "keyboard addition failed");
  flushSync(() => useAppStore.setState({ providers }));
  await settle();
  check(rows()[0].textContent.includes("Shared Workspace/model") && !rows()[0].textContent.includes("Disabled"), "re-enabled display stayed disabled");
  const save = [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === i18n.t("common.save"));
  flushSync(() => save.click());
  check(JSON.stringify(saved) === JSON.stringify(["account-a/model", "deleted/model", "Other Workspace/model"]), "save changed pin identity or order");

  // Representative user path for built-in subagent in-place editing and one-click restore:
  rootNode.render(React.createElement(AgentSubagentsPage));
  await settle();
  await settle();
  const editExplorer = action("Actions for Explorer");
  check(editExplorer, "builtin Explorer edit button missing: " + [...document.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || b.textContent).join(", "));
  flushSync(() => editExplorer.click());
  await settle();
  const dialog = document.querySelector('[role="dialog"]');
  check(dialog, "builtin edit sheet did not open");
  const nameInput = dialog.querySelector("input.field-input");
  check(nameInput?.value === "Explorer" && nameInput.disabled, "builtin Name input should show Explorer and be disabled");
  const sheetReset = [...dialog.querySelectorAll("button")].find((b) => b.textContent.includes("Restore default"));
  check(sheetReset && sheetReset.disabled, "unedited builtin sheet Restore default button should start disabled");
  const descArea = dialog.querySelector("textarea");
  const setNativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  flushSync(() => {
    setNativeValue.call(descArea, "Custom explorer description.");
    descArea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  check(!sheetReset.disabled, "Restore default button should enable once draft is modified");
  const saveBtn = [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save");
  flushSync(() => saveBtn.click());
  await settle();
  await settle();
  check(!document.querySelector('[role="dialog"]'), "sheet did not close after saving builtin");
  check(document.body.textContent.includes("Custom explorer description."), "customized description not rendered on builtin row");
  check(document.body.textContent.includes("Modified"), "Modified badge not rendered on customized builtin row");
  check(document.querySelectorAll(".agent-capability-row").length === 5, "customized builtin must stay in Built-in and not duplicate into Global");
  const rowRestore = action("Restore Explorer to default");
  check(rowRestore, "one-click Restore Explorer to default button missing on row");
  flushSync(() => rowRestore.click());
  await settle();
  await settle();
  check(!document.body.textContent.includes("Custom explorer description."), "restored builtin still shows customized description");
  check(!document.body.textContent.includes("Modified"), "Modified badge still present after restore");
  check(!action("Restore Explorer to default"), "restore button still present after restore");

  flushSync(() => rootNode.unmount());
  return { passed: true, saved };
};
`;

test("saved fallback names survive provider disable, move, remove, keyboard add and save", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.fallback-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
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
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("FALLBACK_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.fallbackProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("FALLBACK_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("FALLBACK_PROBE ".length)), {
      passed: true, saved: ["account-a/model", "deleted/model", "Other Workspace/model"],
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
