#!/usr/bin/env node
/**
 * The page card's reveal action, clicked in a real Electron renderer.
 *
 * `answer-me-with-html` delivery pages are the one card shape that can offer a
 * system file action, and the three shapes that must not are easy to regress:
 * a plain `html` fence, a remote workspace pane, and a session that may not
 * touch local files. Only the preload bridge is synthetic; the real components,
 * the real resolver, and the real store run in a hidden, isolated window, so a
 * click proves the path and markdown base the host would be asked to reveal.
 * No user profile, no built app, no provider.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-html-preview-reveal-"));
const screenshot = process.env.HTML_PREVIEW_REVEAL_SHOT || null;
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/html-preview-reveal.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": '{"DEV":false,"MODE":"production"}',
    },
    alias: {
      "@minih-agent/i18n": join(root, "packages/i18n/src/index.ts"),
      // Source, because a task worktree has no built package output: the
      // renderer's plugin-slot registry imports this boundary at module scope.
      "@minih-agent/plugin-sdk": join(root, "packages/plugin-sdk/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    loader: { ".css": "empty" },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  // The card's own rules, so the toolbar in the capture is the real one.
  const [prose, tokens] = await Promise.all([
    readFile(join(root, "apps/desktop/src/styles/prose.css"), "utf8"),
    readFile(join(root, "apps/desktop/src/styles/tokens.css"), "utf8"),
  ]);
  await writeFile(
    join(temp, "fixture.css"),
    `${tokens}\n${prose}\nhtml,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}` +
      `.fixture-chat{display:flex;flex-direction:column;gap:12px;padding:16px;max-width:720px}` +
      `.fixture-chat .html-block{border:1px solid var(--ds-border-subtle, #ddd);border-radius:8px;overflow:hidden}` +
      `.fixture-chat .html-frame{width:100%;height:120px;border:0;background:#fff}`,
  );
  await writeFile(
    join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css">' +
      '<div id="root"></div><script src="renderer.js"></script>',
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
// An isolated profile: nothing here reads or writes the user's app data.
app.setPath("userData", path.join(__dirname, "profile"));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 760,
    height: 420,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const result = await window.webContents.executeJavaScript("window.htmlPreviewRevealProbe()");
    const shot = ${JSON.stringify(screenshot)};
    if (shot) {
      const image = await window.webContents.capturePage();
      writeFileSync(shot, image.toPNG());
    }
    console.log("HTML_PREVIEW_REVEAL " + JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error("HTML_PREVIEW_REVEAL " + JSON.stringify({ error: String(error) }));
    app.exit(1);
  }
});
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    electronBinary,
    ["--headless=new", "--disable-gpu", join(temp, "main.cjs")],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output += chunk;
    });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
  }
  const line = output
    .split(/\r?\n/)
    .find((item) => item.startsWith("HTML_PREVIEW_REVEAL {"));
  assert(line, `renderer returned no reveal result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice("HTML_PREVIEW_REVEAL ".length));
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(code, 0, output.slice(-4000));

  // The page is read once per pane the card is rendered for, always from the
  // file the link names — never from a resolved or fabricated path.
  assert.deepEqual([...new Set(result.reads)], ["./report.html"]);
  // The card offers the reveal action next to the panel one, and nothing else
  // moved: source, scripts, panel, reveal, copy.
  assert.deepEqual(result.localLabels, [
    "Show HTML source",
    "Run scripts",
    "Open in work panel",
    "Reveal in Finder",
    "Copy",
  ]);
  assert.deepEqual(result.revealLabels, ["Reveal in Finder"]);
  // The click resolved the reference against the markdown base, then revealed
  // Every resolve in the fixture used the same base-completed reference: the
  // reveal click and the panel click beside it complete `./report.html` against
  // the markdown base, and only the reveal destination touches the filesystem.
  assert.deepEqual(
    [...new Set(result.resolveRefs.map((entry) => entry.ref))],
    ["notes/report.html"],
  );
  assert.deepEqual(
    [...new Set(result.resolveRefs.map((entry) => entry.sessionId))],
    ["local-session"],
  );
  assert.deepEqual(result.reveals, [
    { path: "/work/notes/report.html", sessionId: "local-session" },
  ]);
  assert.deepEqual(result.revealCalls, [
    "minih-agent-desktop/fs/resolveRef",
    "minih-agent-desktop/fs/reveal",
  ]);
  // The panel action resolves the same reference and stops there: it keeps its
  // own destination, so it never reveals and never opens the file through the OS.
  assert.deepEqual(result.panelCalls, ["minih-agent-desktop/fs/resolveRef"]);
  // A plain `html` fence has no file behind it, so no system action.
  assert.deepEqual(result.fenceLabels, ["Show HTML source", "Run scripts", "Copy"]);
  assert.equal(result.fenceHasReveal, false);
  // The same card in a remote workspace pane offers no local file action, and
  // re-rendering reveals nothing.
  assert.deepEqual(result.remoteLabels, [
    "Show HTML source",
    "Run scripts",
    "Open in work panel",
    "Copy",
  ]);
  assert.equal(result.remoteHasReveal, false);
  assert.equal(result.reveals.length, 1);
  // Both cards render their page through the sandboxed frame.
  assert.equal(result.frameCount, 2);
  console.log("HTML_PREVIEW_REVEAL " + JSON.stringify(result));
  if (screenshot) console.log("screenshot " + screenshot);
} finally {
  await rm(temp, { recursive: true, force: true });
}