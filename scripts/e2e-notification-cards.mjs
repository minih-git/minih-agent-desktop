#!/usr/bin/env node
/** Real React/Chromium notification user path; no host, profile, or provider access. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "notification-cards-"));
const artifacts = process.env.NOTIFICATION_ARTIFACT_DIR || temp;
await mkdir(artifacts, { recursive: true });
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/notification-cards.tsx")],
    outfile: join(artifacts, "renderer.js"), bundle: true, platform: "browser", format: "iife",
    jsx: "automatic", loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    alias: {
      "@minih-agent/i18n": join(root, "packages/i18n/src/index.ts"),
      "@minih-agent/shared/protocol": join(root, "packages/shared/src/protocol.ts"),
      "@minih-agent/shared": join(root, "packages/shared/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  const styles = await Promise.all(["tokens.css", "ui-kit.css", "overlays.css"].map((name) =>
    readFile(join(root, "apps/desktop/src/styles", name), "utf8")));
  await writeFile(join(artifacts, "index.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'">
<title>Notification cards</title><style>${styles.join("\n").replace(/@theme\b/g, ":root")}
*{box-sizing:border-box}body{margin:0;background:var(--ds-bg-primary);color:var(--ds-text-primary);font-family:system-ui}
button{font:inherit;cursor:pointer}.selectable{user-select:text}.notification-demo{padding:80px 40px;max-width:620px}
.notification-demo>p{color:var(--ds-text-secondary);line-height:1.6}.notification-demo-actions{display:flex;gap:10px;flex-wrap:wrap}
</style><body><script src="renderer.js"></script></body></html>`);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const { writeFile } = require("node:fs/promises");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, title: "Isolated notification test", width: 1100, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const artifacts = ${JSON.stringify(artifacts)};
  try {
    await win.loadFile(path.join(artifacts, "index.html"));
    const result = await win.webContents.executeJavaScript("globalThis.notificationCardsProbe()");
    const layouts = [];
    win.webContents.debugger.attach("1.3");
    for (const [width, height, theme, reduced] of [[1100,800,"dark",false],[1100,800,"light",false],[360,640,"dark",true],[360,640,"light",true]]) {
      win.setContentSize(width, height);
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
      await win.webContents.executeJavaScript("document.documentElement.dataset.theme=" + JSON.stringify(theme));
      layouts.push(await win.webContents.executeJavaScript("globalThis.notificationLayoutProbe()"));
      await win.webContents.executeJavaScript("globalThis.notificationDemo()");
      await writeFile(path.join(artifacts, theme + "-" + width + ".png"), (await win.webContents.capturePage()).toPNG());
    }
    win.webContents.debugger.detach();
    console.log("NOTIFICATION_CARDS " + JSON.stringify({ ...result, layouts }));
    app.exit(0);
  } catch (error) {
    console.error("NOTIFICATION_CARDS " + JSON.stringify({ ok: false, error: error?.stack ?? String(error) }));
    app.exit(1);
  }
});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  } finally { clearTimeout(timer); }
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith("NOTIFICATION_CARDS "));
  assert(line, `Missing test result (exit=${code}): ${output.slice(-6000)}`);
  const result = JSON.parse(line.slice("NOTIFICATION_CARDS ".length));
  console.log(JSON.stringify(result, null, 2));
  assert.equal(code, 0, result.error || output.slice(-6000));
  assert.equal(result.ok, true);
  console.log(`Notification screenshots and interactive fixture: ${artifacts}`);
} finally {
  // Keep explicit artifacts for visual inspection, but never the isolated profile.
  if (artifacts === temp) await rm(join(temp, "profile"), { recursive: true, force: true });
  else await rm(temp, { recursive: true, force: true });
}
