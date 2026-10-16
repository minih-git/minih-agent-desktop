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
  const { SlotSessionProvider } = await vite.ssrLoadModule("/src/plugins/renderer-slots/use-slots.tsx");
  const { catalogs } = await vite.ssrLoadModule(join(root, "packages/i18n/src/index.ts"));
  const fixtures = [];
  for (const locale of ["en", "zh-CN"]) {
    const i18n = createInstance();
    await i18n.init({ lng: locale, resources: { [locale]: { translation: catalogs[locale] } } });
    for (const count of [1, 2, 3]) {
      for (const layout of ["mixed", "short", "wrapped", "mixed-reversed"]) {
        const items = Array.from({ length: count }, (_, index) => {
          const long = layout === "wrapped" || (layout === "mixed" ? index % 2 === 1 : layout === "mixed-reversed" && index % 2 === 0);
          const description = long
            ? "Investigate the account recovery mechanism and verify the complete retry behavior without changing the running session"
            : "Investigate";
          return {
            kind: "tool",
            message: {
              id: `task-${index}`, role: "tool", content: "",
              createdAt: "2026-10-15T00:00:00.000Z", toolName: "Task",
              toolCallId: `task-${index}`, toolStatus: "success",
              toolArgs: { agent: "explorer", task: description, description },
              toolResult: { details: {
                delegationId: `delegate-${index}`, status: index % 2 === 0 ? "running" : "completed",
                modelId: "fixture-model", effectiveThinkingLevel: "high",
              } },
            },
            delegate: {
              agentName: "explorer",
              items: [{ kind: "tool", message: {
                id: `step-${index}`, role: "tool", content: "Fixture step",
                toolName: "Read", toolStatus: "success", createdAt: "2026-10-15T00:00:00.000Z",
              } }],
            },
          };
        });
        const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n },
          createElement(SlotSessionProvider, { sessionId: "connector-fixture" },
            createElement("div", { className: "tool-activity-group has-subagents" },
              createElement(SubagentTopology, { items })))));
        assert.ok(html.includes(i18n.t("chat.subagentCoordinator")));
        assert.match(html, /subagent-stop-button/);
        assert.match(html, /subagent-topology-node-steps/);
        fixtures.push({ count, layout, locale, html });
      }
    }
  }
  let css = "";
  for (const name of ["tokens", "base", "ui-kit", "messages"]) {
    css += (await readFile(join(root, `apps/desktop/src/styles/${name}.css`), "utf8"))
      .replace(/@theme(?: inline)?/g, ":root") + "\n";
  }
  // The fixture loads source CSS without Tailwind; keep its screen-reader utility out of flow.
  css += ".sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border-width: 0; }";
  await writeFile(join(temp, "style.css"), css);
  await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="style.css"><title>Subagent connector regression</title><body>');
  await writeFile(join(temp, "fixtures.json"), JSON.stringify(fixtures));
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const fixtures = require("./fixtures.json");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 850, height: 1000, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const cases = [];
    for (const width of [700, 521, 520, 420]) {
      for (const theme of ["dark", "light"]) {
        for (const scale of [1, 1.5]) {
          for (const fixture of fixtures) {
            const setup = "document.documentElement.dataset.theme = " + JSON.stringify(theme) + "; document.documentElement.style.setProperty('--font-scale', " + scale + "); document.body.innerHTML = " + JSON.stringify(fixture.html) + "; document.querySelector('.tool-activity-group').style.width = '" + width + "px';";
            const geometry = await window.webContents.executeJavaScript(setup + "(" + ${JSON.stringify(measure.toString())} + ")()");
            cases.push({ width, theme, scale, count: fixture.count, layout: fixture.layout, locale: fixture.locale, ...geometry });
            if (process.env.E2E_SCREENSHOT_DIR && [700, 420].includes(width) && theme === "dark" && scale === 1 && fixture.locale === "zh-CN" && fixture.count === 2 && fixture.layout === "mixed") {
              const image = await window.webContents.capturePage();
              writeFileSync(path.join(process.env.E2E_SCREENSHOT_DIR, "subagent-connectors-" + width + ".png"), image.toPNG());
            }
          }
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
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  } finally { clearTimeout(timeout); }
  assert.equal(code, 0, output.slice(-4000));
  const line = output.split(/\r?\n/).find((line) => line.startsWith("SUBAGENT_CONNECTORS "));
  assert.ok(line, output.slice(-4000));
  const cases = JSON.parse(line.slice("SUBAGENT_CONNECTORS ".length));
  assert.equal(cases.length, 384);
  for (const item of cases) {
    const label = JSON.stringify(item);
    const close = (actual, expected, reason) => assert.ok(Math.abs(actual - expected) <= 0.5, `${reason}: ${label}`);
    assert.equal(item.branches.length, item.count, label);
    assert.equal(item.containerWidth, item.width, label);
    assert.ok(item.overflow <= 1, label);
    for (const branch of item.branches) close(branch.right, branch.nodeLeft, "Branch must reach its card");
    if (item.width > 520 && item.count === 1) {
      assert.equal(item.trunks.length, 0, `A single delegate must not retain a fan-out trunk: ${label}`);
      close(item.parent.centerY, item.branches[0].centerY, "Single delegate connector must be continuous");
      close(item.parent.left, item.rootRight, "Parent connector must reach the root");
      assert.ok(item.branches[0].left <= item.parent.right && item.branches[0].right >= item.parent.right, label);
    } else {
      assert.ok(item.trunks.length > 0, label);
      const first = item.trunks[0];
      const last = item.trunks.at(-1);
      close(last.bottom, item.branches.at(-1).centerY, "Trunk must end at the final branch without an overhang");
      close(first.top, item.width > 520 ? item.branches[0].centerY : item.parent.bottom, "Trunk must begin at its first junction");
      for (let index = 1; index < item.trunks.length; index++) {
        close(item.trunks[index - 1].bottom, item.trunks[index].top, "Trunk segments must join without gaps");
      }
      for (const branch of item.branches) {
        assert.ok(branch.centerY >= first.top - 0.5 && branch.centerY <= last.bottom + 0.5, label);
        assert.ok(branch.left <= first.right && branch.right >= first.left, label);
      }
      if (item.width > 520) {
        assert.ok(item.parent.centerY >= first.top && item.parent.centerY <= last.bottom, label);
        close(item.parent.right, first.left, "Parent line must reach the trunk");
      } else {
        close(item.parent.left, first.left, "Stacked parent line must align with the trunk");
      }
    }
  }
  assert.ok(cases.some(item => item.layout === "mixed" && Math.abs(item.branches[0].nodeHeight - item.branches.at(-1).nodeHeight) > 10), "Fixtures must include unequal-height cards");
  console.log(`PASS: ${cases.length} production topology layouts (1/2/3 delegates, mixed heights/statuses, font scaling, wide/stacked, dark/light, en/zh-CN).`);
} finally {
  await vite.close();
  await rm(temp, { recursive: true, force: true });
}

function measure() {
  const container = document.querySelector(".tool-activity-group");
  const agents = document.querySelector(".subagent-topology-agents");
  const parent = document.querySelector(".subagent-topology-connector").getBoundingClientRect();
  const pseudoBox = (element, pseudo) => {
    const style = getComputedStyle(element, pseudo);
    if (style.display === "none" || style.content === "none" || style.content === "normal") return null;
    const box = element.getBoundingClientRect();
    const top = box.top + parseFloat(style.top);
    const left = box.left + parseFloat(style.left);
    return { top, bottom: top + parseFloat(style.height), left, right: left + parseFloat(style.width) };
  };
  const nodes = [...agents.querySelectorAll(".subagent-topology-node")];
  const oldTrunk = pseudoBox(agents, "::before");
  const trunks = oldTrunk ? [oldTrunk] : nodes.map(node => pseudoBox(node, "::after")).filter(Boolean);
  return {
    containerWidth: container.getBoundingClientRect().width,
    overflow: container.scrollWidth - container.clientWidth,
    rootRight: document.querySelector(".subagent-topology-root").getBoundingClientRect().right,
    parent: { left: parent.left, right: parent.right, bottom: parent.bottom, centerY: parent.top + parent.height / 2 },
    branches: nodes.map(node => {
      const box = node.getBoundingClientRect();
      const branch = pseudoBox(node, "::before");
      return { ...branch, centerY: (branch.top + branch.bottom) / 2, nodeLeft: box.left, nodeHeight: box.height };
    }),
    trunks,
  };
}
