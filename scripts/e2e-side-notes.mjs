import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(process.env.PI_E2E_ELECTRON_ROOT || root);
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-side-notes-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/side-notes.tsx")],
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    loader: { ".css": "css", ".woff": "file", ".woff2": "file", ".ttf": "file", ".png": "file", ".svg": "file" },
    alias: { "@minih-agent/i18n": join(root, "packages/i18n/src/index.ts"), react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom") },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await writeFile(join(temp, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'"><title>Side notes regression</title><link rel="stylesheet" href="renderer.css"><style>body{margin:0;background:#212121;color:#fff;font:14px system-ui}button,textarea{font:inherit}button{cursor:pointer}textarea{color:inherit;background:#303030} :root{--ds-bg-dock:#212121;--ds-text-primary:#fff;--ds-text-secondary:#bbb;--ds-text-muted:#aaa;--ds-text-faint:#888;--ds-border-subtle:#444;--ds-border-strong:#666}</style><body><script src="renderer.js"></script>`);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const result = await window.webContents.executeJavaScript("globalThis.sideNotesProbe()");
    console.log("SIDE_NOTES_PROBE " + JSON.stringify(result));
    app.exit(result?.ok === true ? 0 : 1);
  } catch (error) {
    console.error("SIDE_NOTES_PROBE " + JSON.stringify({ ok: false, error: String(error) }));
    app.exit(1);
  }
});`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
  finally { clearTimeout(timer); }
  const line = output.split(/\r?\n/).find((line) => line.startsWith("SIDE_NOTES_PROBE "));
  assert(line, `No renderer result (exit=${code}): ${output.slice(-5000)}`);
  console.log(line);
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(JSON.parse(line.slice("SIDE_NOTES_PROBE ".length)).ok, true);
} finally {
  if (process.env.PI_E2E_KEEP_FIXTURE === "1") console.log(`SIDE_NOTES_FIXTURE ${temp}`);
  else await rm(temp, { recursive: true, force: true });
}
