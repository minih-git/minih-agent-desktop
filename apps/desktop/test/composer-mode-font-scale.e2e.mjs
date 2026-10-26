import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));

test("production mode picker scales localized labels and stays stable across menu choices", { timeout: 60_000 }, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "composer-mode-font-"));
  const { build } = require("esbuild");
  try {
    await build({
      entryPoints: [join(root, "scripts/e2e/composer-mode-font-scale.tsx")],
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@minih-agent/i18n": join(root, "packages/i18n/src/index.ts"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    const renderer = join(root, "apps/desktop/out/renderer");
    const appHtml = await readFile(join(renderer, "index.html"), "utf8");
    const styles = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
    assert(styles.length, "Build the task renderer before this interaction check");
    await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
    await writeFile(join(temp, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:"><title>Composer mode font regression</title>${styles.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<body><script src="renderer.js"></script>`);
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const { writeFile } = require("node:fs/promises");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const cases = [];
    for (const width of [450, 900]) {
      window.setContentSize(width, 600);
      for (const language of ["en", "zh-CN"]) for (const scale of [1, 1.15, 1.5]) {
        cases.push(await window.webContents.executeJavaScript("globalThis.modeFontProbe(" + JSON.stringify(language) + "," + scale + "," + width + ")"));
        if (width === 450) await writeFile(path.join(__dirname, language + "-" + scale + ".png"), (await window.webContents.capturePage()).toPNG());
      }
    }
    const baselineRejected = await window.webContents.executeJavaScript("(async () => { const old = document.createElement('style'); old.textContent = '.composer-mode-chip { width:96px; min-width:96px; max-width:96px; flex:0 0 96px; }'; document.head.append(old); try { await globalThis.modeFontProbe('zh-CN', 1.15, 900); return false; } catch (error) { if (!String(error).includes('differs from')) throw error; return true; } finally { old.remove(); } })()");
    console.log("MODE_FONT_RESULT " + JSON.stringify({ cases, baselineRejected }));
    app.quit();
  } catch (error) {
    console.error(String(error?.stack || error));
    app.exit(1);
  }
});
`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("MODE_FONT_RESULT "));
    assert(line, output.slice(-6000));
    const result = JSON.parse(line.slice("MODE_FONT_RESULT ".length));
    assert.equal(result.cases.length, 12);
    assert.equal(result.baselineRejected, true);
    console.log(`PASS 12 locale/font/width cases, 36 menu selections; screenshots: ${temp}`);
  } finally {
    await rm(join(temp, "profile"), { recursive: true, force: true });
  }
});
