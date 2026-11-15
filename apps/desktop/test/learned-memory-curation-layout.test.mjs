import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * "Recently curated" has to read as a control, not as a column of text
 * (ADR learned-memory-consolidation §3).
 *
 * The block shipped unstyled once: the disclosure head was a bare line with the
 * arrow glued to the title, the undo was a ghost text button, and the before /
 * after / reason layers looked identical. Nothing in typecheck, lint or the
 * behaviour tests can see that, so this test asserts the rendered geometry and
 * computed styles of the real dialog inside a real Electron window.
 */

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const { catalogs, flattenCatalog } = await import("../../../packages/i18n/src/index.ts");

// The catalogs are read here only to prove the fixture resolves the same import
// the app does; the assertions use the labels the fixture itself reads.
assert.ok(flattenCatalog(catalogs.en)["settings.learnedMemory"]);

/** Inline `?url` asset imports resolve to file loaders, as in the app build. */
const urlAssets = {
  name: "local-url-assets",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
      path: join(resolveDir, path.slice(0, -4)),
      namespace: "local-url-asset",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
      contents: await readFile(path),
      loader: "file",
    }));
  },
};

const now = Date.now();
const snapshot = (content, status, revision) => ({ content, status, revision });
const records = [
  {
    id: 1,
    batchId: "batch-merge",
    entryId: "note-merged",
    op: "merge_new",
    actor: "auto",
    after: snapshot("Run fmt and clippy before committing.", "active", 3),
    reason: "Two notes said the same thing.",
    createdAt: now - 3_600_000,
  },
  {
    id: 2,
    batchId: "batch-merge",
    entryId: "note-old-1",
    op: "merge_archive",
    actor: "auto",
    before: snapshot("Run the formatter first.", "active", 1),
    after: snapshot("Run the formatter first.", "archived", 2),
    reason: "Two notes said the same thing.",
    createdAt: now - 3_600_000,
  },
  {
    id: 3,
    batchId: "batch-merge",
    entryId: "note-old-2",
    op: "merge_archive",
    actor: "auto",
    before: snapshot("Format, then commit.", "active", 1),
    after: snapshot("Format, then commit.", "archived", 2),
    reason: "Two notes said the same thing.",
    createdAt: now - 3_600_000,
  },
  {
    id: 4,
    batchId: "batch-reword",
    entryId: "note-reword",
    op: "reword",
    actor: "auto",
    before: snapshot("cliipy first", "active", 1),
    after: snapshot("Run clippy before committing.", "active", 2),
    reason: "Clearer wording.",
    createdAt: now - 90_000,
  },
];

const fixtureSource = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { SettingsPage } from "../../apps/desktop/src/features/settings/SettingsPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const en = flattenCatalog(catalogs.en);
const cardTitle = en["settings.learnedMemory"];
const managerRowTitle = en["settings.learnedMemoryManager"];
const recordSet = ${JSON.stringify(records)};

const rendererErrors = [];
const originalConsoleError = console.error;
console.error = (...args) => { rendererErrors.push(args.map((value) => String(value && value.stack ? value.stack : value)).join(" ")); originalConsoleError(...args); };
window.addEventListener("error", (event) => rendererErrors.push(String(event.error?.stack ?? event.message)));

window.minihAgent = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, ...args) {
    switch (channel) {
      case IPC.invoke.pluginScenicThemesDestinations:
      case IPC.invoke.systemFontsList:
        return { ok: true, data: [] };
      case IPC.invoke.providersList:
        return { ok: true, data: { providers: [] } };
      case IPC.invoke.storageGet:
        return { ok: true, data: { dataPath: "/fixture/data", browserPath: "/fixture/browser", managed: true, cacheBytes: 0, pendingPath: null, lastError: null, backupPaths: [] } };
      case IPC.invoke.agentInstructionsGet:
        return { ok: true, data: { global: { path: "/fixture/instructions.md", content: "" }, project: null } };
      case IPC.invoke.memoryExtractionStatus:
        return { ok: true, data: { budget: { day: args[0]?.day ?? "", tokens: 0, runs: 0 } } };
      case IPC.invoke.commandShellList:
        return { ok: true, data: { configuredId: null, effective: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true }, fallback: false, choices: [{ id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true }] } };
      case IPC.invoke.memoryList:
        return { ok: true, data: { entries: [], count: 0 } };
      case IPC.invoke.memoryStats:
        return { ok: true, data: { stats: {
          index: { entries: 0, bytes: 0, omitted: 0, capturedAt: null },
          suggestions: { accepted: 0, rejected: 0 },
          tombstones: { fromExtraction: 0, fromCreate: 0 },
          extraction: { day: "2026-11-15", tokens: 0, runs: 0 },
        } } };
      case IPC.invoke.memorySuggestionsList:
        return { ok: true, data: { entries: [], count: 0 } };
      case IPC.invoke.memoryCurationList:
        return { ok: true, data: { records: recordSet, changes: recordSet.length, days: 7 } };
      default:
        return { ok: true, data: {} };
    }
  },
};

await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
useAppStore.setState({
  settings: {
    theme: "light",
    language: "en",
    developerMode: false,
    learnedMemory: { learn: false, curate: true, model: "fixture-provider/fixture-model" },
  },
  settingsTab: "general",
  page: "settings",
});
document.documentElement.dataset.theme = "light";
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(React.createElement(SettingsPage)));

const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await settle();
    const value = predicate();
    if (value) return value;
  }
  throw new Error(message);
}
function categoryItem(label) {
  return [...document.querySelectorAll(".settings-category")].find((button) => button.textContent.trim() === label);
}
function navItem(label) {
  return [...document.querySelectorAll(".settings-subnav-item")].find((button) => button.querySelector(".settings-nav-label")?.textContent.trim() === label);
}
function row(title) {
  return [...document.querySelectorAll(".settings-row")].find((node) => node.querySelector(".settings-row-title")?.textContent.trim().startsWith(title));
}

/** CSS colour with its alpha resolved, so "transparent" is measurable. */
function paint(value) {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const rgba = resolved.match(/rgba?\(([^)]+)\)/);
  if (!rgba) return { color: resolved, alpha: 1 };
  const parts = rgba[1].split(",").map((part) => Number.parseFloat(part.trim()));
  return { color: resolved, alpha: parts.length > 3 ? parts[3] : 1 };
}
function styleSignature(node) {
  const style = getComputedStyle(node);
  return {
    color: style.color,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    textDecoration: style.textDecorationLine,
    opacity: style.opacity,
  };
}

window.learnedMemoryCurationLayoutProbe = async () => {
  await waitFor(() => categoryItem("AI"), "Settings navigation did not render: " + rendererErrors.join(" | "));
  flushSync(() => categoryItem("AI").click());
  await settle();
  flushSync(() => navItem("Instructions & memory").click());
  await waitFor(() => [...document.querySelectorAll(".settings-card-block")].some((card) => card.querySelector(".settings-card-heading")?.textContent.trim() === cardTitle), "The learned-memory card did not render");

  // (1) The curation row is reachable and, once scrolled to, fully inside the
  // window: a screenshot of the top of the page would miss it.
  const curation = row(en["settings.learnedMemoryCurate"]);
  if (!curation) throw new Error("the curation row is missing");
  curation.scrollIntoView({ block: "center" });
  await settle();
  const rect = curation.getBoundingClientRect();
  const rowInViewport =
    rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;

  // (2) Open the manager and the block, and measure the block it renders.
  const manager = row(managerRowTitle);
  if (!manager) throw new Error("the memory-manager row is missing");
  flushSync(() => manager.querySelector(".settings-row-control button").click());
  const head = await waitFor(() => document.querySelector(".learned-memory-curation-head"), "the curation block did not render");
  flushSync(() => head.click());
  await waitFor(() => document.querySelectorAll(".learned-memory-curation-batch").length === 2, "both batches did not render");

  const batches = [...document.querySelectorAll(".learned-memory-curation-batch")];
  const panel = head.closest(".learned-memory-curation");
  panel.scrollIntoView({ block: "center" });
  await settle();

  const headStyle = getComputedStyle(head);
  const arrow = head.querySelector(".learned-memory-curation-arrow");
  const arrowRect = arrow.getBoundingClientRect();
  const headRect = head.getBoundingClientRect();
  const padRight = Number.parseFloat(headStyle.paddingRight) || 0;

  const undo = batches[0].querySelector(".learned-memory-curation-undo");
  const undoStyle = getComputedStyle(undo);
  const undoPaint = paint(undoStyle.backgroundColor);
  const undoRect = undo.getBoundingClientRect();

  const firstRow = batches[0].querySelector(".learned-memory-curation-row");
  const before = firstRow.querySelector(".learned-memory-curation-before");
  const after = firstRow.querySelector(".learned-memory-curation-after");
  const reason = firstRow.querySelector(".learned-memory-curation-reason");

  const firstRect = batches[0].getBoundingClientRect();
  const secondRect = batches[1].getBoundingClientRect();

  return {
    rowInViewport,
    rowRect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) },
    headTag: head.tagName,
    headExpanded: head.getAttribute("aria-expanded"),
    headIsFullWidth: Math.abs(headRect.width - panel.getBoundingClientRect().width) <= 1,
    arrowToHeadRightEdge: Math.round(headRect.right - padRight - arrowRect.right),
    arrowCenterY: Math.round(arrowRect.top + arrowRect.height / 2),
    headCenterY: Math.round(headRect.top + headRect.height / 2),
    undoTag: undo.tagName,
    undoText: undo.textContent.trim(),
    undoWidth: Math.round(undoRect.width),
    undoHeight: Math.round(undoRect.height),
    undoBackgroundAlpha: undoPaint.alpha,
    undoBorderWidth: Number.parseFloat(undoStyle.borderTopWidth) || 0,
    before: styleSignature(before),
    after: styleSignature(after),
    reason: styleSignature(reason),
    beforeStruck: getComputedStyle(before.querySelector("s")).textDecorationLine,
    batchGap: Math.round(secondRect.top - firstRect.bottom),
    batchHasBorder: Number.parseFloat(getComputedStyle(batches[0]).borderTopWidth) > 0,
    batchCount: batches.length,
    rendererErrors,
  };
};
`;

test(
  "recently curated renders as a control, not as bare text",
  {
    timeout: 90_000,
    skip:
      process.platform === "linux" && !process.env.DISPLAY
        ? "Isolated Electron UI test requires a display"
        : false,
  },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "pi-curation-layout-"));
    try {
      await build({
        stdin: {
          contents: fixtureSource,
          resolveDir: join(root, "apps", "desktop"),
          sourcefile: join(root, "apps", "desktop", "test", "learned-memory-curation-fixture.tsx"),
          loader: "tsx",
        },
        outfile: join(temp, "renderer.js"),
        bundle: true,
        platform: "browser",
        format: "esm",
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "true" },
        alias: {
          "@minih-agent/i18n": join(root, "packages/i18n/src"),
          "@minih-agent/shared": join(root, "packages/shared/src"),
          react: join(root, "apps/desktop/node_modules/react"),
          "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
          i18next: join(root, "apps/desktop/node_modules/i18next"),
          "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
        },
        nodePaths: [join(root, "apps/desktop/node_modules")],
        plugins: [urlAssets],
      });

      const renderer = join(root, "apps/desktop/out/renderer");
      const indexHtml = await readFile(join(renderer, "index.html"), "utf8");
      const css = [...indexHtml.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
      assert(css.length, "Run pnpm --filter @minih-agent/desktop build before this test");
      await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
      await writeFile(
        join(temp, "index.html"),
        `<!doctype html><html data-platform="darwin"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:">${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`,
      );
      await writeFile(
        join(temp, "main.cjs"),
        `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 820,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.learnedMemoryCurationLayoutProbe()");
    console.log("LEARNED_MEMORY_CURATION_LAYOUT " + JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error(error?.stack ?? error);
    app.exit(1);
  }
});
`,
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
      const timer = setTimeout(() => child.kill("SIGKILL"), 80_000);
      let code;
      try {
        code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
      } finally {
        clearTimeout(timer);
      }
      assert.equal(code, 0, output);
      const line = output
        .split(/\r?\n/)
        .find((row) => row.startsWith("LEARNED_MEMORY_CURATION_LAYOUT "));
      assert(line, output);
      const result = JSON.parse(line.slice("LEARNED_MEMORY_CURATION_LAYOUT ".length));

      assert.deepEqual(result.rendererErrors, [], "the renderer logged an error");
      assert.equal(
        result.rowInViewport,
        true,
        `the curation row must fit in the viewport once scrolled to: ${JSON.stringify(result.rowRect)}`,
      );
      assert.equal(result.headTag, "BUTTON", "the whole title line is the disclosure control");
      assert.equal(result.headExpanded, "true", "the block is expanded");
      assert.equal(result.headIsFullWidth, true, "the head spans the block");
      assert.ok(
        Math.abs(result.arrowToHeadRightEdge) <= 2,
        `the arrow sits at the head's trailing edge: ${result.arrowToHeadRightEdge}px`,
      );
      assert.ok(
        Math.abs(result.arrowCenterY - result.headCenterY) <= 2,
        `the arrow is vertically centred with the title: ${result.arrowCenterY} vs ${result.headCenterY}`,
      );
      assert.equal(result.undoTag, "BUTTON", "undo is a button");
      assert.ok(result.undoText.length > 0, "undo has a visible label");
      assert.ok(result.undoWidth >= 24 && result.undoHeight >= 16, "undo is a hit target, not a word");
      assert.ok(
        result.undoBackgroundAlpha > 0.02 || result.undoBorderWidth >= 1,
        `undo must have a fill or a border: ${JSON.stringify({
          alpha: result.undoBackgroundAlpha,
          border: result.undoBorderWidth,
        })}`,
      );
      const signatures = [
        JSON.stringify(result.before),
        JSON.stringify(result.after),
        JSON.stringify(result.reason),
      ];
      assert.equal(
        new Set(signatures).size,
        3,
        `before, after and reason must be visually distinct: ${JSON.stringify({
          before: result.before,
          after: result.after,
          reason: result.reason,
        })}`,
      );
      assert.match(result.beforeStruck, /line-through/, "the old wording is struck through");
      assert.ok(result.batchGap >= 4, `batches are separated: ${result.batchGap}px`);
      assert.equal(result.batchHasBorder, true, "a batch is a block, not a paragraph");
      assert.equal(result.batchCount, 2, "both seeded batches render");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);