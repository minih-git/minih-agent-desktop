import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * The task row's body toggles the log: the clickable surface is the whole lead
 * band (state dot, command, metadata) via the shared Button primitive, while
 * stop / remove keep their own behavior and stay outside it.
 */

const [dock, todoDock, composerStyles] = await Promise.all([
  readFile(new URL("../src/components/TaskDock.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/TodoDock.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/styles/composer.css", import.meta.url), "utf8"),
]);

test("the row body is a shared Button that toggles the log", () => {
  const main = dock.match(/<Button[\s\S]*?className="task-main"[\s\S]*?<\/Button>/);
  assert.ok(main, "row body Button missing");
  assert.match(main[0], /type="button"/);
  assert.match(main[0], /variant="ghost"/);
  assert.match(main[0], /aria-expanded=\{expanded\}/);
  assert.match(main[0], /onClick=\{\(\) => onToggleOutput\(task\.id\)\}/);
});

test("the toggle surface covers the state dot, command and meta rows", () => {
  const main = dock.match(/<Button[\s\S]*?className="task-main"[\s\S]*?<\/Button>/)[0];
  for (const className of ["task-state", "task-command", "task-meta"]) {
    assert.match(main, new RegExp(`className="${className}"`));
  }
});

test("the dock header uses the explicit disclosure button and introduces no shimmer", () => {
  assert.match(dock, /<div className="dock-header-main">/);
  assert.doesNotMatch(dock, /<button[^>]*className="dock-header-main"/);
  assert.doesNotMatch(dock, /shimmer/i);
  assert.doesNotMatch(todoDock, /shimmer/i);
});

test("stop and remove stay outside the toggle surface", () => {
  const toggleEnd = dock.indexOf('className="task-main"');
  const bandAt = dock.indexOf('className="task-band"');
  const stopAt = dock.indexOf('"task-action is-stop"');
  const removeAt = dock.indexOf('className="task-action"');
  assert.ok(bandAt > 0 && bandAt < toggleEnd, "the band must wrap the row body");
  assert.ok(stopAt > toggleEnd && removeAt > toggleEnd, "actions must follow the body");
});

test("a running task offers stop and never remove", () => {
  // The two actions are chosen by state in one branch: the stop control gates on
  // `running`, and the remove control lives in the other arm.
  assert.match(dock, /className="task-action is-stop"\s+onClick=\{\(\) => onStop\(task\.id\)\}/);
  assert.match(dock, /className="task-action"\s+onClick=\{\(\) => onRemove\(task\.id\)\}/);
  assert.match(dock, /backgroundTasks\.dismiss/);
  assert.ok(
    dock.indexOf('"task-action is-stop"') < dock.indexOf('className="task-action"'),
    "the stop control comes from the running arm",
  );
});

test("the row styles keep the body clickable and focus-visible", () => {
  assert.match(composerStyles, /\.task-main\s*\{[^{}]*flex: 1 1 auto/);
  assert.match(composerStyles, /\.task-main\s*\{[^{}]*cursor: pointer/);
  assert.match(
    composerStyles,
    /\.task-main:focus-visible\s*\{[^{}]*outline: 2px solid var\(--ds-focus\)/,
  );
});

test("a long command ellipsizes on one line instead of wrapping the row", () => {
  // The band must not wrap, and the command must own the ellipsis, or a long
  // command would push the metadata and its action onto a second line.
  assert.match(composerStyles, /\.task-band\s*\{[^{}]*flex-wrap: nowrap/);
  assert.match(composerStyles, /\.task-command\s*\{[^{}]*text-overflow: ellipsis/);
  assert.match(composerStyles, /\.task-command\s*\{[^{}]*white-space: nowrap/);
});

test("TaskDock renders session-scoped TodoPanel and omits shimmer", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createInstance } = await import("i18next");
  const { I18nextProvider } = await import("react-i18next");
  const { catalogs } = await import("@minih-agent/i18n");
  const { createServer } = await import("vite");
  const { fileURLToPath } = await import("node:url");

  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { TaskDock } = await server.ssrLoadModule("/src/components/TaskDock.tsx");
    const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
    const i18n = createInstance();
    const enCatalog = {
      ...catalogs.en,
      backgroundTasks: {
        ...catalogs.en.backgroundTasks,
        headerCount: "{{count}} background tasks",
        removeFailed: "Could not remove this task.",
      },
      taskDock: {
        title: "Todo and background tasks",
        tabTodo: "Todo",
        tabTasks: "Background tasks",
        newTasks: "{{count}} new tasks",
        runningCount: "{{count}} running",
        expand: "Expand {{label}}",
        collapse: "Collapse {{label}}",
      },
    };
    await i18n.init({ lng: "en", resources: { en: { translation: enCatalog } } });
    Object.assign(useAppStore.getInitialState(), {
      sessionTodos: {
        "session-dock-test": {
          sessionId: "session-dock-test",
          revision: 1,
          updatedAt: 100,
          todos: [
            { content: "Ship shared dock", status: "in_progress", priority: "high" },
          ],
        },
      },
    });

    const html = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(TaskDock, { sessionId: "session-dock-test" }),
      ),
    );
    assert.match(html, /class="dock"/);
    assert.doesNotMatch(html, /class="dock is-expanded"/);
    assert.match(html, /class="dock-header-current" title="Ship shared dock">Ship shared dock<\/span>/);
    assert.match(html, /class="[^"]*\bdock-toggle\b[^"]*"[^>]*aria-expanded="false"/);
    assert.doesNotMatch(html, /shimmer/i);
  } finally {
    await server.close();
  }
});

test("TaskDock starts collapsed, keeps collapse across session switches, and passes interactive background-tasks probe", {
  timeout: 60_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const { spawn } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { repositoryRoot, resolveElectronBinary } = await import("../../../scripts/e2e/boot.mjs");
  const { loadStyles } = await import("./helpers/styles.mjs");
  const root = repositoryRoot();
  const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
  const temp = await mkdtemp(join(root, "apps/desktop/.background-tasks-dock-ui-"));
  try {
    await build({
      entryPoints: [join(root, "scripts/e2e/background-tasks.tsx")],
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
      loader: { ".css": "empty", ".woff": "file", ".woff2": "file", ".ttf": "file" },
      alias: {
        "@minih-agent/i18n": join(root, "packages/i18n/src/index.ts"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
      plugins: [{
        name: "local-url-assets",
        setup(b) {
          b.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
            path: join(resolveDir, path.slice(0, -4)),
            namespace: "local-url-asset",
          }));
          b.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
            contents: await readFile(path),
            loader: "file",
          }));
        },
      }],
    });
    await writeFile(
      join(temp, "styles.css"),
      (await loadStyles()).replace(/@theme(?: inline)?\s*\{/g, ":root {"),
    );
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src \'self\' data:"><link rel="stylesheet" href="styles.css"><style>body { margin: 0; } textarea { display: block; width: 100%; min-height: 60px; box-sizing: border-box; }</style></head><body><script src="renderer.js"></script></body></html>',
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
app.setPath("userData", join(__dirname, "profile"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.debugger.attach("1.3");
  window.webContents.on("console-message", event => {
    if (event.message === "BACKGROUND_NATIVE_KEY Return" || event.message === "BACKGROUND_NATIVE_KEY Space") {
      const enter = event.message.endsWith("Return");
      const key = enter ? "Enter" : " ";
      const code = enter ? "Enter" : "Space";
      const windowsVirtualKeyCode = enter ? 13 : 32;
      void window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
        type: "keyDown", key, code, windowsVirtualKeyCode, text: enter ? "\\r" : " ",
      }).then(() => window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp", key, code, windowsVirtualKeyCode,
      })).catch(error => { console.error(error); app.exit(1); });
    }
  });
  try {
    await window.loadFile(join(__dirname, "index.html"));
    const result = await window.webContents.executeJavaScript("globalThis.backgroundTasksProbe()");
    console.log("BACKGROUND_TASKS_UNIT_PROBE " + JSON.stringify(result));
    app.exit(result.ok ? 0 : 1);
  } finally { window.destroy(); }
}).catch(error => { console.error(error); app.exit(1); });
`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/)
      .find((item) => item.startsWith("BACKGROUND_TASKS_UNIT_PROBE "));
    assert(line, output.slice(-6000));
    const parsed = JSON.parse(line.slice("BACKGROUND_TASKS_UNIT_PROBE ".length));
    assert.equal(parsed.ok, true, JSON.stringify(parsed.results));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
