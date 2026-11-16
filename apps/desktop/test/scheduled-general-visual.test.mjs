import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const artifactRoot = join(root, ".artifacts", "scheduled-general");
const { build: bundle } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { ScheduledEditor } from "../../apps/desktop/src/features/scheduled/ScheduledEditor";
import { ScheduledTaskRail } from "../../apps/desktop/src/features/scheduled/ScheduledTaskRail";

await i18n.use(initReactI18next).init({
  lng: "zh-CN", keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } },
  interpolation: { escapeValue: false },
});

const generalTask = {
  id: "general-task", title: "每日全局检查", prompt: "汇总所有项目的风险与待办事项。",
  cadence: "daily", mode: "agent", enabled: true,
  createdAt: "2026-11-17T00:00:00Z", updatedAt: "2026-11-17T00:00:00Z",
  schedule: { hour: 9, minute: 0, weekday: 0 }, nextRunAt: "2026-11-18T09:00:00Z",
  workspacePath: undefined, permissionMode: "ask", sessionMode: "perRun",
};
const projectTask = {
  ...generalTask, id: "project-task", title: "项目检查", workspacePath: "/repo/Minih-Agent-Desktop",
};
const projects = [{ path: "/repo/Minih-Agent-Desktop", name: "Minih-Agent-Desktop" }];
useAppStore.setState({
  workspace: { path: "/repo/Minih-Agent-Desktop", name: "Minih-Agent-Desktop" },
  settings: {},
});

const noop = () => undefined;
function finishAnimations() {
  for (const animation of document.getAnimations()) {
    const timing = animation.effect && animation.effect.getTiming ? animation.effect.getTiming() : null;
    if (timing && timing.iterations === Infinity) continue;
    try { animation.finish(); } catch {}
  }
}
function mount(element) {
  const container = document.getElementById("root");
  container.innerHTML = "";
  const rootNode = createRoot(container);
  flushSync(() => rootNode.render(element));
  return rootNode;
}
function shell(content) {
  return React.createElement("div", { className: "app-shell" },
    React.createElement("main", { className: "main-pane route-scroll" }, content));
}
function editor() {
  return shell(React.createElement("div", { className: "page-frame scheduled-frame" },
    React.createElement("div", { className: "scheduled-editor-slot" },
      React.createElement(ScheduledEditor, {
        task: generalTask, projects, currentWorkspacePath: "/repo/Minih-Agent-Desktop",
        busy: false, save: async () => {}, cancel: noop,
      }))));
}
function list() {
  return shell(React.createElement("div", { className: "page-frame scheduled-frame" },
    React.createElement("div", { className: "scheduled-workspace" },
      React.createElement(ScheduledTaskRail, {
        tasks: [generalTask, projectTask], latestRuns: new Map(), liveTaskIds: new Set(),
        selectedTaskId: "general-task", now: Date.parse("2026-11-17T12:00:00Z"), locale: "zh-CN",
        onSelect: noop,
      }))));
}
window.shot = {
  async render(scene, theme) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.platform = "darwin";
    mount(scene === "editor" ? editor() : list());
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    finishAnimations();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return { ok: true };
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
    configFile: false, root: appDir, logLevel: "error", plugins: [tailwindcss()],
    build: { outDir, emptyOutDir: true, cssCodeSplit: false,
      rollupOptions: { input: entry, output: { entryFileNames: "style-entry.js", assetFileNames: "styles[extname]" } } },
  });
  const stylesheet = (await readdir(outDir)).find((name) => name.endsWith(".css"));
  assert.ok(stylesheet, "the stylesheet did not compile");
  return join(outDir, stylesheet);
}

async function capture() {
  await mkdir(artifactRoot, { recursive: true });
  const workDir = await mkdtemp(join(tmpdir(), "pi-scheduled-general-shot-"));
  try {
    await bundle({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(workDir, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "process.env": '{"NODE_ENV":"production","DEV":false}', "import.meta.env": '{"DEV":false,"PROD":true,"MODE":"production"}' },
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
    await writeFile(join(workDir, "index.html"), `<!doctype html><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}body{background:var(--ds-bg-primary);color:var(--ds-text-primary)}#root{min-height:100%}</style><link rel="stylesheet" href="${stylesheet}"><div id="root"></div><script type="module" src="renderer.js"></script>`);
    const plan = ["editor", "list"].flatMap((scene) => ["dark", "light"].map((theme) => ({ scene, theme })));
    await writeFile(join(workDir, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const plan = ${JSON.stringify(plan)}; const outDir = ${JSON.stringify(artifactRoot)};
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => { const win = new BrowserWindow({ show:false, width:1440, height:900, useContentSize:true, webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false} });
try { await win.loadFile(path.join(__dirname,"index.html")); await win.webContents.executeJavaScript("new Promise((resolve,reject)=>{const deadline=Date.now()+20000; (function tick(){if(window.shot)return resolve(true); if(Date.now()>deadline)return reject(new Error('fixture did not mount')); requestAnimationFrame(tick)})();})");
for (const entry of plan) { await win.webContents.executeJavaScript("window.shot.render("+JSON.stringify(entry.scene)+","+JSON.stringify(entry.theme)+")"); await new Promise(r=>setTimeout(r,150)); const image=await win.webContents.capturePage(); writeFileSync(path.join(outDir, entry.scene+"-"+entry.theme+"-1440.png"), image.toPNG()); }
app.exit(0); } catch(error) { console.error(error&&error.stack||error); app.exit(1); } });`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(workDir, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; for (const stream of [child.stdout, child.stderr]) { stream.setEncoding("utf8"); stream.on("data", (chunk) => { output += chunk; }); }
    const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); clearTimeout(timer);
    assert.equal(code, 0, output.slice(-6000));
    for (const entry of plan) assert.ok(readFileSync(join(artifactRoot, entry.scene+"-"+entry.theme+"-1440.png")).length > 1000);
  } finally { await rm(workDir, { recursive: true, force: true }); }
}

test("scheduled general task editor and list screenshots", { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false, timeout: 300000 }, async () => {
  await capture();
});
