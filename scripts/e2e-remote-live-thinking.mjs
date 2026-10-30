#!/usr/bin/env node
/** Isolated production-screen regression for E2E-REMOTE-MOBILE-live-thinking-and-response. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/remote-web/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "remote-live-thinking-"));
const artifacts = process.env.E2E_ARTIFACT_DIR ?? join(temp, "artifacts");
await mkdir(artifacts, { recursive: true });
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/remote-live-thinking.tsx")],
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    alias: {
      react: join(root, "apps/remote-web/node_modules/react"),
      "react-dom": join(root, "apps/remote-web/node_modules/react-dom"),
      "@minih-agent/shared": join(root, "packages/shared/dist/index.js"),
    },
    nodePaths: [join(root, "apps/remote-web/node_modules")],
  });
  const assets = join(root, "apps/remote-web/dist/assets");
  const styles = (await readdir(assets)).filter((name) => name.endsWith(".css"));
  assert.ok(styles.length, "Build apps/remote-web before running this regression");
  for (const name of styles) await cp(join(assets, name), join(temp, name));
  await writeFile(join(temp, "index.html"), `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:"><title>Remote live thinking regression</title>${styles.map((name) => `<link rel="stylesheet" href="${name}">`).join("")}</head><body><script src="renderer.js"></script></body></html>`);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const results = [];
  try {
    for (const width of [320, 390]) {
      for (const locale of ["en", "zh-CN"]) {
        const window = new BrowserWindow({ width, height: 844, useContentSize: true, show: false,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        const errors = [];
        window.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
        await window.loadFile(path.join(__dirname, "index.html"));
        const active = await window.webContents.executeJavaScript("activeProbe(" + JSON.stringify(locale) + ")");
        window.webContents.debugger.attach("1.3");
        await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        const reducedMotion = await window.webContents.executeJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches && getComputedStyle(document.querySelector('main [role=status] [aria-hidden]')).animationName === 'none'");
        if (!reducedMotion) throw new Error("Response indicator did not respect reduced motion");
        await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
        window.webContents.debugger.detach();
        const screenshot = path.join(${JSON.stringify(artifacts)}, "live-" + locale + "-" + width + ".png");
        await fs.writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
        const states = await window.webContents.executeJavaScript("stateProbe()");
        const terminal = await window.webContents.executeJavaScript("terminalProbe(" + JSON.stringify(locale) + ")");
        if (errors.length) throw new Error(errors.join("\\n"));
        results.push({ width, locale, active, states, terminal, reducedMotion, screenshot });
        window.destroy();
      }
    }
    console.log("REMOTE_LIVE_THINKING " + JSON.stringify({ ok: true, results }));
    app.quit();
  } catch (error) {
    console.error("REMOTE_LIVE_THINKING " + JSON.stringify({ ok: false, error: String(error?.stack ?? error), results }));
    app.exit(1);
  }
});
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 90000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
  finally { clearTimeout(timeout); }
  const result = output.split(/\r?\n/).find((line) => line.startsWith("REMOTE_LIVE_THINKING "));
  assert.ok(result, `No regression report (exit ${code}): ${output.slice(-6000)}`);
  console.log(result);
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(JSON.parse(result.slice("REMOTE_LIVE_THINKING ".length)).ok, true);
} finally {
  // Preserve screenshots and failure artifacts for inspection, never a user profile.
  await rm(join(temp, "profile"), { recursive: true, force: true });
}
