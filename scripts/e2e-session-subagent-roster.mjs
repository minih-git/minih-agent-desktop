import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
// Resolve Electron from this worktree. A task worktree that reuses another
// checkout's installed environment points `PI_E2E_ELECTRON_ROOT` at it, so the
// script never hard-codes one machine's layout.
const { electronBinary } = resolveElectronBinary(
  process.env.PI_E2E_ELECTRON_ROOT || root,
);
const temp = await mkdtemp(join(tmpdir(), "pi-session-subagent-roster-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/session-subagent-roster.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: {
      ".css": "css",
      ".woff": "file",
      ".woff2": "file",
      ".ttf": "file",
      ".png": "file",
      ".svg": "file",
    },
    alias: {
      "@minih-agent/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  const rosterCss = readFileSync(
    join(root, "scripts/e2e/session-subagent-roster.css"),
    "utf8",
  );
  const fixtureTokens = [
    "--ds-bg-dock:#212121",
    "--ds-bg-dock-raised:transparent",
    "--ds-bg-hover:rgba(255,255,255,.06)",
    "--ds-bg-chip:rgba(255,255,255,.06)",
    "--ds-text-primary:#fff",
    "--ds-text-secondary:rgba(255,255,255,.7)",
    "--ds-text-muted:rgba(255,255,255,.52)",
    "--ds-text-faint:rgba(255,255,255,.38)",
    "--ds-border-subtle:rgba(255,255,255,.05)",
    "--ds-border-strong:rgba(255,255,255,.14)",
    "--ds-success:#40c977",
    "--ds-error:#ff6764",
    "--ds-warning:#ff8549",
    "--ds-tile-deep:rgba(255,255,255,.08)",
    "--radius-xs:8px",
    "--radius-full:9999px",
    "--font-mono:monospace",
    "--text-sm:12px",
    "--text-xs:11px",
    "--text-2xs:11px",
    "--text-3xs:10.5px",
    "--leading-compact:1.3",
    "--leading-body:1.45",
    "--font-weight-semibold:600",
    "--tracking-wide:.06em",
    "--motion-duration-fast:150ms",
    "--motion-ease-out:ease-out",
  ].join(";");
  await writeFile(
    join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'">' +
      "<title>Session subagent roster</title>" +
      '<link rel="stylesheet" href="renderer.css">' +
      "<style>:root{" + fixtureTokens + "}" + rosterCss + "</style>" +
      '<body><script src="renderer.js"></script>',
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const result = await window.webContents.executeJavaScript("globalThis.sessionSubagentRosterProbe()");
    console.log("SESSION_SUBAGENT_ROSTER_PROBE " + JSON.stringify(result));
    app.exit(result?.ok === true ? 0 : 1);
  } catch (error) {
    console.error("SESSION_SUBAGENT_ROSTER_PROBE " + JSON.stringify({ ok: false, error: String(error) }));
    app.exit(1);
  }
});
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output += data;
    });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
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
    .find((line) => line.startsWith("SESSION_SUBAGENT_ROSTER_PROBE "));
  assert(line, `renderer returned no result (exit=${code}): ${output.slice(-4000)}`);
  const result = JSON.parse(line.slice("SESSION_SUBAGENT_ROSTER_PROBE ".length));
  console.log(line);
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true);
} finally {
  await rm(temp, { recursive: true, force: true });
}
