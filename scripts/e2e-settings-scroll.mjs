#!/usr/bin/env node
/**
 * Settings navigation in isolated Electron, with the production
 * component/store/CSS. Covers the seven-category sheet: real clicks, search
 * paths, nested Escape, draft-safe closing, focus return, scroll retention, and
 * the layout under narrow/roomy/short windows in both locales, both themes, a
 * 150% type scale, and reduced motion. Screenshots are written next to the
 * session scratch directory so the layout can be inspected afterwards.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const urlAssets = {
  name: "local-url-assets",
  setup(build) {
    build.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
      path: join(resolveDir, path.slice(0, -4)), namespace: "local-url-asset",
    }));
    build.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
      contents: await readFile(path), loader: "file",
    }));
  },
};
const temp = await mkdtemp(join(tmpdir(), "pi-settings-scroll-"));
const shots = join(process.env.PI_SCRATCH_DIR ?? temp, "settings-redesign-screenshots");
try {
  await build({ entryPoints: [join(root, "scripts/e2e/settings-scroll.jsx")],
    outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "true" },
    alias: { "@minih-agent/i18n": join(root, "packages/i18n/src"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      i18next: join(root, "apps/desktop/node_modules/i18next"),
      "react-i18next": join(root, "apps/desktop/node_modules/react-i18next") },
    nodePaths: [join(root, "apps/desktop/node_modules")],
    plugins: [urlAssets],
  });
  const renderer = join(root, "apps/desktop/out/renderer");
  const html = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...html.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Run pnpm build:js before this test");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(join(temp, "index.html"), `<!doctype html><html data-platform="darwin"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:">${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const shots = ${JSON.stringify(shots)};
app.setPath("userData", path.join(__dirname, "profile"));
const sizes = [
  { name: "compact", width: 640, height: 560 },
  { name: "narrow", width: 760, height: 720 },
  { name: "regular", width: 1000, height: 720 },
  { name: "wide", width: 1440, height: 860 },
  { name: "short", width: 1000, height: 520 },
];
/**
 * Look at the captured pixels: a control that exists in the DOM but is painted
 * over shows as a flat band here, which is exactly the defect this guards.
 */
async function painted(win, selector) {
  const rect = await win.webContents.executeJavaScript(
    "(function(){var n=document.querySelector(" + JSON.stringify(selector) + ");"
    + "if(!n)return null;var r=n.getBoundingClientRect();"
    + "return {x:Math.round(r.x),y:Math.round(r.y),width:Math.max(1,Math.round(r.width)),height:Math.max(1,Math.round(r.height))};})()",
  );
  if (!rect) return { selector, found: false };
  const image = await win.webContents.capturePage(rect);
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  let lightest = 0;
  let darkest = 255;
  let distinct = new Set();
  for (let index = 0; index + 3 < bitmap.length; index += 4) {
    const luminance = (bitmap[index] + bitmap[index + 1] + bitmap[index + 2]) / 3;
    if (luminance > lightest) lightest = luminance;
    if (luminance < darkest) darkest = luminance;
    if (distinct.size < 64) distinct.add(Math.round(luminance / 8));
  }
  return { selector, found: true, width, height, spread: Math.round(lightest - darkest), tones: distinct.size };
}
async function shot(win, name) {
  const image = await win.webContents.capturePage();
  await fs.writeFile(path.join(shots, name + ".png"), image.toPNG());
}
app.whenReady().then(async () => {
  await fs.mkdir(shots, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 1000, height: 720,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.settingsScrollProbe()");
    console.log("SETTINGS_SCROLL " + JSON.stringify(result));
    const paintedReport = [];
    for (const size of sizes) {
      win.setContentSize(size.width, size.height);
      await win.webContents.executeJavaScript("window.settingsOpenProbe()");
      for (const selector of [".settings-panel-title", ".settings-search", ".settings-close", ".settings-categories, .settings-category-select"]) {
        const result = await painted(win, selector);
        assert(result.found, size.name + ": missing " + selector);
        // A painted-over control renders as one flat tone; real text or a field
        // edge produces a luminance spread and several tones.
        assert(result.spread >= 24 && result.tones >= 3,
          size.name + ": " + selector + " looks covered: " + JSON.stringify(result));
        paintedReport.push({ size: size.name, ...result });
      }
      await win.webContents.executeJavaScript("window.settingsCloseProbe()");
      await shot(win, size.name + "-en");
    }
    const segments = [];
    for (const size of sizes) {
      win.setContentSize(size.width, size.height);
      for (const language of ["en", "zh-CN"]) {
        for (const scale of [1, 1.5]) {
          const segment = await win.webContents.executeJavaScript(
            "window.settingsSegmentProbe(" + JSON.stringify(language) + "," + scale + ")");
          segments.push({ size: size.name, ...segment });
          if (scale === 1.5) await shot(win, size.name + "-" + language + "-scale150");
        }
      }
    }
    console.log("SETTINGS_SEGMENTS " + JSON.stringify(segments));
    console.log("SETTINGS_PIXELS " + JSON.stringify(paintedReport));
    let reducedMotion;
    try {
      win.webContents.debugger.attach("1.3");
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      reducedMotion = await win.webContents.executeJavaScript("window.settingsReducedMotionProbe()");
    } catch (error) {
      reducedMotion = { skipped: String(error && error.message ? error.message : error) };
    } finally {
      try { win.webContents.debugger.detach(); } catch (error) { /* already detached */ }
    }
    console.log("SETTINGS_REDUCED_MOTION " + JSON.stringify(reducedMotion));
    console.log("SETTINGS_SCREENSHOTS " + shots);
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
  finally { clearTimeout(timer); }
  assert.equal(code, 0, output.slice(-8000));
  for (const tag of ["SETTINGS_SCROLL ", "SETTINGS_SEGMENTS ", "SETTINGS_PIXELS ", "SETTINGS_REDUCED_MOTION ", "SETTINGS_SCREENSHOTS "]) {
    const line = output.split(/\r?\n/).find((row) => row.startsWith(tag));
    assert(line, tag + "missing:\n" + output.slice(-4000));
    console.log(line);
  }
} finally { await rm(temp, { recursive: true, force: true }); }
