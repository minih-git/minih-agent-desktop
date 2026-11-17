import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

test("session creation thinking selection persists, resets and respects model capabilities", {
  timeout: 60_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "session-create-thinking-"));
  try {
    await build({
      stdin: { resolveDir: root, loader: "tsx", contents: `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next, I18nextProvider } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { SessionCreateModelRow } from "./apps/desktop/src/components/settings/SessionCreateModelRow";

await i18n.use(initReactI18next).init({
  lng: "zh-CN", keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } },
  interpolation: { escapeValue: false },
});
const provider = {
  id: "p1", name: "Fixture provider", enabled: true, hasSecret: true,
  models: [
    { id: "reasoning", thinkingLevels: ["low", "high"] },
    { id: "plain", thinkingLevels: ["off"] },
    { id: "catalog-plain", thinkingLevels: [] },
  ],
};
const providerModels = { p1: [{ modelId: "catalog-plain", catalogSource: "models.dev", reasoning: false, capabilities: [] }] };
let saved = { providerId: "p1", modelId: "reasoning" };
let update, setBusy, remount;
function Fixture() {
  const [binding, setBinding] = useState(saved);
  const [busy, changeBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  update = setBinding; setBusy = changeBusy; remount = () => setRevision(value => value + 1);
  return <section className="settings-panel model-default-panel">
    <SessionCreateModelRow key={revision} settings={{ sessionCreateModel: binding }}
      providers={[provider]} providerModels={providerModels} busy={busy}
      onChange={next => { saved = next; setBinding(next); }} />
  </section>;
}
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<I18nextProvider i18n={i18n}><Fixture /></I18nextProvider>));
const check = (ok, message) => { if (!ok) throw new Error(message); };
const click = node => { check(node, "Missing click target"); flushSync(() => node.click()); };
const trigger = label => [...document.querySelectorAll('button[aria-haspopup="listbox"]')].find(node => node.getAttribute("aria-label") === label);
const thinking = () => trigger(i18n.t("chat.reasoningLevel"));
const model = () => trigger(i18n.t("settings.sessionCreateModel"));
const options = () => [...document.querySelectorAll('[role="option"]')];
const choose = text => click(options().find(node => node.textContent.trim() === text));
const labels = () => options().map(node => node.textContent.trim());
const inherit = i18n.t("extensions.subagents.thinkingInherit");
check(thinking().textContent.includes(inherit), "Legacy config must inherit");
click(thinking());
check(JSON.stringify(labels()) === JSON.stringify([inherit, "omit", "low", "high"]), "Only enabled model levels may be offered");
choose("low");
check(saved.thinkingLevel === "low" && saved.modelId === "reasoning", "Selection must save the complete binding");
flushSync(() => remount());
check(thinking().textContent.includes("low"), "Selection must survive remount");
click(thinking()); choose("omit");
check(saved.thinkingLevel === "omit", "Omit must be distinct from off");
click(thinking()); choose(inherit);
check(!Object.hasOwn(saved, "thinkingLevel"), "Inheritance must remove the override");
click(thinking()); choose("high");
flushSync(() => setBusy(true));
check(thinking().disabled && model().disabled, "Both controls must block writes while saving");
flushSync(() => setBusy(false));
click(model()); choose("Fixture provider · plain");
check(saved.modelId === "plain" && !Object.hasOwn(saved, "thinkingLevel"), "Switching models must clear the old effort");
click(thinking());
check(JSON.stringify(labels()) === JSON.stringify([inherit, "off"]), "Non-reasoning model must offer only inheritance and off");
choose("off");
check(saved.thinkingLevel === "off", "Off must persist explicitly");
click(model()); choose("Fixture provider · catalog-plain");
click(thinking());
check(JSON.stringify(labels()) === JSON.stringify([inherit, "off"]), "Known non-reasoning catalog model must not gain synthetic levels");
choose("off");
flushSync(() => update({ providerId: "p1", modelId: "reasoning", thinkingLevel: "max" }));
check(thinking().textContent.includes(i18n.t("settings.sessionCreateModelUnavailable")), "Unavailable stored level must not masquerade as inheritance");
click(thinking());
check(options().find(node => node.textContent.startsWith("max")).disabled, "Unavailable stored level must not be selectable");
choose("low");
flushSync(() => update({ providerId: "p1", modelId: "gone" }));
check(!thinking(), "Unavailable model must not expose an effort selector");
click(model()); choose("Fixture provider · reasoning");
click(model()); choose(i18n.t("settings.sessionCreateModelNone"));
check(saved === null && !thinking(), "Clearing the model must remove the effort selector");
click(model()); choose("Fixture provider · reasoning");
click(thinking()); choose("high");
window.probe = { ok: true, saved, checks: 16 };
` },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
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
    let css = "";
    for (const name of ["tokens", "base", "ui-kit", "settings", "providers", "model-config"]) {
      css += (await readFile(join(root, `apps/desktop/src/styles/${name}.css`), "utf8")).replace(/@theme(?: inline)?/g, ":root") + "\n";
    }
    await writeFile(join(temp, "style.css"), css);
    await writeFile(join(temp, "index.html"), '<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="style.css"><body><main id="root" class="model-config-page" style="max-width:760px;margin:40px auto"></main><script type="module" src="renderer.js"></script></html>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 960, height: 600, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const probe = await win.webContents.executeJavaScript("window.probe");
    if (!probe?.ok) throw new Error("Renderer did not complete the user path");
    if (process.env.MINIH_TEST_ARTIFACTS) {
      await fs.mkdir(process.env.MINIH_TEST_ARTIFACTS, { recursive: true });
      await fs.writeFile(path.join(process.env.MINIH_TEST_ARTIFACTS, "session-create-thinking.png"), (await win.webContents.capturePage()).toPNG());
    }
    console.log("SESSION_CREATE_THINKING " + JSON.stringify(probe));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 55_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timeout); }
    assert.equal(code, 0, output);
    assert.match(output, /SESSION_CREATE_THINKING \{"ok":true/);
  } finally {
    if (!process.env.MINIH_KEEP_UI_FIXTURE) await rm(temp, { recursive: true, force: true });
    else console.log(`SESSION_CREATE_FIXTURE ${temp}`);
  }
});
