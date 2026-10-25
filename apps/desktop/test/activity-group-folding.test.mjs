import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";
import { readTranscriptModule } from "./helpers/source-contracts.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { ACTIVITY_GROUP_AUTO_OPEN_MAX_ITEMS, activityGroupStartsOpen } = await import(
  "../src/lib/activity-group-folding.ts"
);

const items = (count, kind = "tool") =>
  Array.from({ length: count }, () => ({ kind }));
const settled = {
  subagentTopology: false,
  turnActive: false,
  groupActive: false,
};

test("a settled group of plain tool rows follows the small-group rule", () => {
  assert.equal(ACTIVITY_GROUP_AUTO_OPEN_MAX_ITEMS, 4);
  assert.equal(activityGroupStartsOpen(items(4), settled), true);
  assert.equal(activityGroupStartsOpen(items(5), settled), false);
});

test("work the turn still owns stays open regardless of group size", () => {
  assert.equal(
    activityGroupStartsOpen(items(20), { ...settled, turnActive: true }),
    true,
    "an assistant turn that is still running keeps every group visible",
  );
  assert.equal(
    activityGroupStartsOpen(items(20), { ...settled, groupActive: true }),
    true,
    "a group that still owns live work keeps its rows visible",
  );
  assert.equal(
    activityGroupStartsOpen(items(20), { ...settled, subagentTopology: true }),
    true,
    "Task topology keeps its released open default",
  );
});

test("reasoning the reader asked to see never folds away", () => {
  assert.equal(
    activityGroupStartsOpen([...items(20), { kind: "thinking" }], settled),
    true,
    "a visible Thinking row is reader-requested content",
  );
  // Reasoning hidden by `Show thinking` never reaches this list, so a group of
  // plain tool rows is still allowed to fold.
  assert.equal(activityGroupStartsOpen(items(20), settled), false);
});

test("issue counters stay on one inline line in the group header", async () => {
  const [styles, groupSource] = await Promise.all([
    loadStyles(),
    readTranscriptModule("ProcessActivityGroup.tsx"),
  ]);
  assert.match(groupSource, /className="activity-issue-count"/);
  assert.match(
    groupSource,
    /<IconCircleAlert size=\{14\} aria-hidden \/>\s*<span>\{t\("chat\.activityFailures"/,
  );
  const badge = styles.match(/\.activity-issue-count \{([^}]*)\}/)?.[1];
  assert.ok(badge, "the activity issue counter has no layout rule");
  assert.match(badge, /display:\s*inline-flex;/);
  assert.match(badge, /align-items:\s*center;/);
  assert.match(badge, /white-space:\s*nowrap;/);
  assert.match(
    styles,
    /\.activity-issue-count > span \{[^}]*text-overflow:\s*ellipsis;/,
  );
  assert.doesNotMatch(groupSource, /turn-process-error/);
});

test("rendered transcript disclosures fold deterministically and release reading-hub listeners on unmount", {
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
  const root = repositoryRoot();
  const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
  const temp = await mkdtemp(join(root, "apps/desktop/.transcript-auto-collapse-ui-"));
  try {
    const entrySource = `
import { createRoot } from "react-dom/client";
import { transcriptAutoCollapseProbe } from "./transcript-auto-collapse";
import { turnProcessProbe } from "./turn-process";

// Let React install its document-level synthetic event delegation first so the
// tracker below measures only listeners owned by transcript disclosures.
createRoot(document.createElement("div")).unmount();

const activeListeners = new Map();
for (const [target, name] of [[document, "document"], [window, "window"]]) {
  const origAdd = target.addEventListener.bind(target);
  const origRemove = target.removeEventListener.bind(target);
  target.addEventListener = (type, listener, options) => {
    if (["focusin", "selectionchange", "pointerup"].includes(type)) {
      const key = name + ":" + type;
      const set = activeListeners.get(key) ?? new Set();
      set.add(listener);
      activeListeners.set(key, set);
    }
    return origAdd(type, listener, options);
  };
  target.removeEventListener = (type, listener, options) => {
    if (["focusin", "selectionchange", "pointerup"].includes(type)) {
      const key = name + ":" + type;
      activeListeners.get(key)?.delete(listener);
    }
    return origRemove(type, listener, options);
  };
}

window.runFoldProbes = async () => {
  const autoCollapse = await transcriptAutoCollapseProbe();
  const turnProcess = await turnProcessProbe();
  const remainingReadingListeners = {};
  for (const [key, set] of activeListeners.entries()) {
    remainingReadingListeners[key] = set.size;
  }
  return { autoCollapse, turnProcess, remainingReadingListeners };
};
`;
    await build({
      stdin: {
        contents: entrySource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "fold-probes-entry.tsx"),
        loader: "tsx",
      },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      loader: { ".css": "empty", ".woff": "file", ".woff2": "file", ".ttf": "file" },
      alias: {
        "@minih-agent/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(
      join(temp, "renderer.css"),
      (await loadStyles()).replace(/@theme(?: inline)?\s*\{/g, ":root {"),
    );
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="renderer.css"><title>Transcript auto-collapse regression</title><body><div id="root"></div><script type="module" src="renderer.js"></script>',
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.runFoldProbes()");
    console.log("TRANSCRIPT_AUTO_COLLAPSE_PROBE " + JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});
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
      .find((item) => item.startsWith("TRANSCRIPT_AUTO_COLLAPSE_PROBE "));
    assert(line, output.slice(-6000));
    const parsed = JSON.parse(line.slice("TRANSCRIPT_AUTO_COLLAPSE_PROBE ".length));
    assert.equal(parsed.autoCollapse.ok, true);
    assert.equal(parsed.turnProcess.ok, true);
    assert.deepEqual(parsed.remainingReadingListeners, {
      "document:focusin": 0,
      "document:selectionchange": 0,
      "window:pointerup": 0,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
