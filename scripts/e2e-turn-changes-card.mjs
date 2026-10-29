/** Production card/Review interaction in isolated Electron profiles. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
const root = repositoryRoot();
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "minih-turn-changes-"));
try {
  await build({ entryPoints: [join(root, "scripts/e2e/turn-changes-card.tsx")], outfile: join(temp, "renderer.js"),
    bundle: true, platform: "browser", format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    loader: { ".css": "empty", ".png": "dataurl", ".gif": "dataurl", ".svg": "dataurl" },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  const renderer = join(root, "apps/desktop/out/renderer");
  const html = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...html.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  for (const name of await readdir(join(renderer, "assets"))) {
    if (!name.endsWith(".css") || css.some((path) => path.endsWith(`/${name}`))) continue;
    const content = await readFile(join(renderer, "assets", name), "utf8");
    if (/turn-changes-card|other-providers-section/.test(content)) css.push(`./assets/${name}`);
  }
  assert.ok(css.length, "build task Desktop first");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(join(temp, "index.html"), `<!doctype html><meta charset="utf-8">${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<div id="root"></div><script type="module" src="renderer.js"></script>`);
  await writeFile(join(temp, "main.cjs"), `
    const { app, BrowserWindow } = require("electron"); const path = require("node:path");
    app.setPath("userData", path.join(__dirname, "profile")); app.on("window-all-closed", () => {});
    app.whenReady().then(async () => { try {
      const results = [];
      for (const language of ["en", "zh-CN"]) for (const width of [320, 900]) {
        const window = new BrowserWindow({ show: false, width, height: 900,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        window.webContents.on("console-message", (event) => console.error(event.message));
        await window.loadFile(path.join(__dirname, "index.html"));
        results.push(await window.webContents.executeJavaScript("window.turnChangesProbe(" + JSON.stringify(language) + ")"));
        if (process.env.PI_SCRATCH_DIR) await require("node:fs/promises").writeFile(
          path.join(process.env.PI_SCRATCH_DIR, "turn-changes-" + language + "-" + width + ".png"), (await window.webContents.capturePage()).toPNG());
        results[results.length - 1].providers = await window.webContents.executeJavaScript("window.rowBusyProbe()");
        window.destroy();
      }
      console.log("TURN_CHANGES_PROBE " + JSON.stringify(results)); app.exit(0);
    } catch (error) { console.error(error.stack || error); app.exit(1); } });
  `);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) { stream.setEncoding("utf8"); stream.on("data", (chunk) => { output += chunk; }); }
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
  finally { clearTimeout(timer); }
  assert.equal(code, 0, output.slice(-6000));
  const line = output.split(/\r?\n/).find((item) => item.startsWith("TURN_CHANGES_PROBE "));
  assert.ok(line, output.slice(-6000));
  const results = JSON.parse(line.slice("TURN_CHANGES_PROBE ".length));
  assert.equal(results.length, 4);
  assert.ok(results.every((result) => result.historicalFocus && result.rows === 12 && result.counts === 15));
  console.log(line);
} finally { await rm(temp, { recursive: true, force: true }); }
