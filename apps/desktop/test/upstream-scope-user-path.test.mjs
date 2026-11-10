import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

test("global capability scope, legacy overrides and SSH install summaries follow the user path", {
  timeout: 60_000, skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "scope-ui-"));
  try {
    await build({ entryPoints: [join(root, "scripts/e2e/upstream-capability-scope.tsx")],
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "true" },
      alias: {
        "@minih-agent/i18n": join(root, "packages/i18n/src"),
        "@minih-agent/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      }, nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    const css = (await Promise.all(["tokens.css", "ui-kit.css", "settings.css", "overlays.css"]
      .map(file => readFile(join(root, "apps/desktop/src/styles", file), "utf8").catch(error => {
        if (error.code === "ENOENT") return ""; throw error;
      })))).join("\n");
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="root"></div><script type="module" src="renderer.js"></script>');
    const screenshotRoot = process.env.PI_SCRATCH_DIR ?? temp;
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises"), path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", event => console.error(event.message));
  const results = [];
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    for (const kind of ["mcp", "skills", "ssh"]) {
      try {
        const result = await win.webContents.executeJavaScript(kind === "ssh" ? "window.sshBootstrapProbe()" : "window.capabilityScopeProbe(" + JSON.stringify(kind) + ")");
        results.push({ kind, passed: true, result });
      } catch (error) { results.push({ kind, passed: false, error: String(error.message) }); }
      await fs.writeFile(path.join(${JSON.stringify(screenshotRoot)}, "upstream-scope-" + kind + ".png"), (await win.webContents.capturePage()).toPNG());
    }
    console.log("SCOPE_USER_PATH " + JSON.stringify(results));
    app.exit(results.every(result => result.passed) ? 0 : 1);
  } catch (error) { console.error(error.stack); app.exit(1); }
});
`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    const line = output.split(/\r?\n/).find(line => line.startsWith("SCOPE_USER_PATH "));
    assert.ok(line, output);
    console.log(line);
    assert.equal(code, 0, output);
    assert.equal(JSON.parse(line.slice("SCOPE_USER_PATH ".length)).length, 3);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
