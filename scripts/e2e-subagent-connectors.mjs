#!/usr/bin/env node
/** Measure production topology connectors in isolated Chromium, without a Host or provider. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/desktop/package.json"));
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createInstance } = require("i18next");
const { createServer } = await import(pathToFileURL(require.resolve("vite")));
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "subagent-connectors-"));
const vite = await createServer({
  root: join(root, "apps/desktop"), configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  esbuild: { jsx: "automatic" }, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  ssr: { noExternal: ["react-i18next"] },
});

try {
  const { SubagentTopology } = await vite.ssrLoadModule("/src/features/chat/transcript/SubagentDetail.tsx");
  const { I18nextProvider } = await vite.ssrLoadModule("react-i18next");
  const { catalogs } = await vite.ssrLoadModule(join(root, "packages/i18n/src/index.ts"));
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
  const fixtures = [];
  for (const count of [1, 2]) {
    for (const description of ["Investigate", "Investigate the account recovery mechanism and verify the complete retry behavior without changing the running session"]) {
      const items = Array.from({ length: count }, (_, index) => ({
        message: {
          id: `task-${index}`, role: "tool", content: "",
          createdAt: "2026-10-15T00:00:00.000Z", toolName: "Task",
          toolCallId: `task-${index}`, toolStatus: "success",
          toolArgs: { agent: "explorer", task: description, description },
          toolResult: { details: { delegationId: `delegate-${index}`, status: "running" } },
        },
      }));
      fixtures.push({ count, long: description.length > 20, html: renderToStaticMarkup(
        createElement(I18nextProvider, { i18n }, createElement("div",
          { className: "tool-activity-group has-subagents" },
          createElement(SubagentTopology, { items }))),
      ) });
      assert.match(fixtures.at(-1).html, /Main agent/);
    }
  }
  let css = "";
  for (const name of ["tokens", "base", "ui-kit", "messages"]) {
    css += (await readFile(join(root, `apps/desktop/src/styles/${name}.css`), "utf8"))
      .replace(/@theme(?: inline)?/g, ":root") + "\n";
  }
  await writeFile(join(temp, "style.css"), css);
  await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="style.css"><title>Subagent connector regression</title><body>');
  await writeFile(join(temp, "fixtures.json"), JSON.stringify(fixtures));
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fixtures = require("./fixtures.json");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const cases = [];
    for (const width of [700, 521, 520, 420]) {
      for (const theme of ["dark", "light"]) {
        for (const fixture of fixtures) {
          const setup = "document.documentElement.dataset.theme = " + JSON.stringify(theme) + "; document.body.innerHTML = " + JSON.stringify(fixture.html) + "; document.querySelector('.tool-activity-group').style.width = '" + width + "px';";
          const geometry = await window.webContents.executeJavaScript(setup + "(" + ${JSON.stringify(measure.toString())} + ")()");
          cases.push({ width, theme, count: fixture.count, long: fixture.long, ...geometry });
        }
      }
    }
    console.log("SUBAGENT_CONNECTORS " + JSON.stringify(cases));
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
});
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  } finally { clearTimeout(timeout); }
  assert.equal(code, 0, output.slice(-4000));
  const line = output.split(/\r?\n/).find((line) => line.startsWith("SUBAGENT_CONNECTORS "));
  assert.ok(line, output.slice(-4000));
  const cases = JSON.parse(line.slice("SUBAGENT_CONNECTORS ".length));
  assert.equal(cases.length, 32);
  for (const item of cases) {
    const label = JSON.stringify(item);
    assert.equal(item.nodeCount, item.count, label);
    assert.equal(item.containerWidth, item.width, label);
    assert.ok(item.overflow <= 1, label);
    if (item.width > 520 && item.count === 1) {
      assert.equal(item.trunkDisplay, "none", `A single delegate must not retain a fan-out trunk: ${label}`);
      assert.ok(Math.abs(item.parentCenter - item.branchCenter) <= 0.5, `Single delegate connector is not continuous: ${label}`);
      assert.ok(item.branchLeft <= item.parentRight && item.branchRight >= item.parentRight, label);
      assert.ok(Math.abs(item.parentLeft - item.rootRight) <= 0.5, label);
      assert.ok(Math.abs(item.branchRight - item.nodeLeft) <= 0.5, label);
    } else {
      assert.notEqual(item.trunkDisplay, "none", `Fan-out and stacked layouts retain their trunk: ${label}`);
      assert.equal(item.branchTop, 35, label);
      assert.equal(item.branchWidth, item.width <= 520 ? 14 : 15, label);
    }
  }
  console.log(`PASS: ${cases.length} production topology layouts (single/fan-out, short/wrapped, wide/stacked, dark/light).`);
} finally {
  await vite.close();
  await rm(temp, { recursive: true, force: true });
}

function measure() {
  const query = (selector) => document.querySelector(selector);
  const container = query(".tool-activity-group");
  const parent = query(".subagent-topology-connector").getBoundingClientRect();
  const root = query(".subagent-topology-root").getBoundingClientRect();
  const node = query(".subagent-topology-node");
  const bounds = node.getBoundingClientRect();
  const branch = getComputedStyle(node, "::before");
  const branchWidth = parseFloat(branch.width);
  const branchTop = parseFloat(branch.top);
  return {
    nodeCount: document.querySelectorAll(".subagent-topology-node").length,
    containerWidth: container.getBoundingClientRect().width,
    overflow: container.scrollWidth - container.clientWidth,
    trunkDisplay: getComputedStyle(query(".subagent-topology-agents"), "::before").display,
    parentCenter: parent.top + parent.height / 2,
    parentLeft: parent.left, parentRight: parent.right, rootRight: root.right,
    branchCenter: bounds.top + branchTop + parseFloat(branch.height) / 2,
    branchLeft: bounds.left - branchWidth, branchRight: bounds.left, nodeLeft: bounds.left,
    branchTop, branchWidth,
  };
}
