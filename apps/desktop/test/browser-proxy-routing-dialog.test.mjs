import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary, scaledTimeout } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

test("browser routing compact entry and modal preserve editing contracts", {
  timeout: scaledTimeout(90_000),
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const output = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "routing-dialog-"));
  const aliases = Object.fromEntries(["react", "react-dom", "i18next", "react-i18next"]
    .map((name) => [name, join(root, "apps/desktop/node_modules", name)]));
  await build({
    entryPoints: [join(root, "scripts/e2e/browser-proxy-routing-dialog.tsx")],
    outfile: join(output, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "true" },
    alias: { ...aliases, "@minih-agent/i18n": join(root, "packages/i18n/src"), "@minih-agent/shared": join(root, "packages/shared/src") },
    nodePaths: [join(root, "apps/desktop/node_modules")],
    plugins: [{ name: "url-assets", setup(b) {
      b.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({ path: join(resolveDir, path.slice(0, -4)), namespace: "url-asset" }));
      b.onLoad({ filter: /.*/, namespace: "url-asset" }, async ({ path }) => ({ contents: await readFile(path), loader: "file" }));
    } }],
  });
  const renderer = join(root, "apps/desktop/out/renderer");
  const rendererHtml = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...rendererHtml.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Build Desktop in the request worktree before this test");
  await cp(join(renderer, "assets"), join(output, "assets"), { recursive: true });
  await writeFile(join(output, "index.html"), `<!doctype html><html data-theme="light" data-platform="darwin"><head><meta charset="utf-8">${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`);
  await writeFile(join(output, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 820,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  console.log("routing-main: loading");
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("routing-main: loaded");
    const result = await win.webContents.executeJavaScript("window.routingProbe()");
    console.log("routing-main: interaction complete");
    const visuals = [];
    for (const [language, theme, width, height] of [["en", "light", 1180, 820], ["zh-CN", "dark", 1180, 820], ["zh-CN", "light", 430, 760]]) {
      win.setContentSize(width, height);
      console.log("routing-main: visual " + language + " " + theme + " " + width);
      visuals.push(await win.webContents.executeJavaScript("window.routingVisual(" + JSON.stringify(language) + "," + JSON.stringify(theme) + ")"));
      fs.writeFileSync(path.join(__dirname, language + "-" + theme + "-" + width + ".png"), (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript("window.routingProfiles()");
      fs.writeFileSync(path.join(__dirname, language + "-" + theme + "-profiles-" + width + ".png"), (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript("window.routingClose()");
      fs.writeFileSync(path.join(__dirname, language + "-" + theme + "-summary-" + width + ".png"), (await win.webContents.capturePage()).toPNG());
    }
    console.log("ROUTING_DIALOG " + JSON.stringify({ ...result, visuals }));
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(__dirname, "failure.png"), (await win.webContents.capturePage()).toPNG());
    console.error(error?.stack ?? error);
    console.error(await win.webContents.executeJavaScript("document.body.innerText"));
    app.exit(1);
  }
});
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary, [join(output, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { logs += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), scaledTimeout(60_000));
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
  finally { clearTimeout(timer); }
  console.log("Screenshots: " + output);
  assert.equal(code, 0, logs);
  const line = logs.split(/\r?\n/).find((value) => value.startsWith("ROUTING_DIALOG "));
  assert(line, logs);
  const result = JSON.parse(line.slice("ROUTING_DIALOG ".length));
  assert.equal(result.passed, true);
  assert.equal(result.errorsReported, 1);
  assert.equal(result.visuals.length, 3);
  assert(result.visuals.every((value) => value.fits && value.rows === 99));
  console.log(JSON.stringify(result));
});
