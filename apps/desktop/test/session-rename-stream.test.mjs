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

const fixture = String.raw`
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { SessionRenameDialog } from "../../apps/desktop/src/components/SessionRenameDialog";

await i18n.use(initReactI18next).init({
  lng: "en",
  keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});

const closeEvents = [];
let savedTitle = null;
let setHostState = null;

function TestHost() {
  const [state, setState] = useState({ open: false, tick: 0 });
  setHostState = setState;

  return (
    <div style={{ padding: 40 }}>
      <button id="trigger-btn" onClick={() => setState((s) => ({ ...s, open: true }))}>
        Open Rename
      </button>
      {state.open ? (
        <SessionRenameDialog
          session={{ id: "sess-test-1", title: "Original Title" }}
          onClose={() => {
            closeEvents.push("close-tick-" + state.tick);
            setState((s) => ({ ...s, open: false }));
          }}
          onSave={async (title) => {
            savedTitle = title;
          }}
          onError={(err) => {
            console.error("Save error", err);
          }}
        />
      ) : null}
    </div>
  );
}

const rootNode = createRoot(document.getElementById("root"));
flushSync(() => {
  rootNode.render(React.createElement(TestHost));
});

const frame = () => new Promise(requestAnimationFrame);
async function settle() {
  await frame();
  await frame();
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function until(predicate, message) {
  for (let n = 0; n < 120; n += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(message + " body=" + document.body.textContent);
}

window.sessionRenameProbeStream = async () => {
  await settle();
  const triggerBtn = document.getElementById("trigger-btn");
  triggerBtn.focus();
  check(document.activeElement === triggerBtn, "triggerBtn not initially focused");

  // 1. Open dialog
  flushSync(() => {
    setHostState((s) => ({ ...s, open: true }));
  });
  await settle();

  const dialog = document.querySelector('[role="dialog"]');
  check(dialog !== null, "Dialog did not render");
  const input = document.getElementById("session-rename-input");
  check(input !== null, "Rename input not found");
  check(document.activeElement === input, "Input was not focused on dialog mount");
  check(input.value === "Original Title", "Initial value mismatch: " + input.value);
  check(
    input.selectionStart === 0 && input.selectionEnd === "Original Title".length,
    "Initial text not selected: " + input.selectionStart + ".." + input.selectionEnd
  );

  // 2. User edits input draft
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Edited Title Streaming");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  check(input.value === "Edited Title Streaming", "Draft value not updated: " + input.value);

  // 3. User sets partial selection / caret inside edited text
  input.setSelectionRange(7, 12);
  check(
    input.selectionStart === 7 && input.selectionEnd === 12,
    "Partial selection failed to set: " + input.selectionStart + ".." + input.selectionEnd
  );

  // 4. Simulate streaming parent re-render with new callback references
  flushSync(() => {
    setHostState((s) => ({ ...s, tick: s.tick + 1 }));
  });
  await settle();

  // 5. Assert draft and partial selection are preserved
  check(
    input.value === "Edited Title Streaming",
    "Draft was lost on streaming parent re-render: " + input.value
  );
  check(
    input.selectionStart === 7 && input.selectionEnd === 12,
    "Selection was reset by streaming re-render! Expected [7, 12] but got [" +
      input.selectionStart + ", " + input.selectionEnd + "]"
  );
  check(document.activeElement === input, "Input lost focus on streaming parent re-render");

  return { ok: true, phase: "stream-preserved" };
};

window.sessionRenameProbeSaveAndEscape = async () => {
  const triggerBtn = document.getElementById("trigger-btn");
  const input = document.getElementById("session-rename-input");
  check(input !== null, "Rename input not found during save phase");

  // 6. Test save uses intended draft value
  const form = input.closest("form");
  check(form !== null, "Form element not found");
  flushSync(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await until(() => savedTitle === "Edited Title Streaming" && !document.querySelector('[role="dialog"]'), "Save did not complete");
  await settle();
  check(savedTitle === "Edited Title Streaming", "Saved title mismatch: " + savedTitle);
  check(document.activeElement === triggerBtn, "Focus not restored to trigger button after save");

  // 7. Test Escape key with latest callback handler and focus restoration
  triggerBtn.focus();
  flushSync(() => {
    setHostState((s) => ({ ...s, open: true }));
  });
  await settle();
  check(document.querySelector('[role="dialog"]') !== null, "Dialog did not reopen");

  // Simulate another stream re-render with new callbacks (tick = 2)
  const prevCloseLen = closeEvents.length;
  flushSync(() => {
    setHostState((s) => ({ ...s, tick: s.tick + 1 }));
  });
  await settle();

  // Press Escape
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await until(() => document.querySelector('[role="dialog"]') === null, "Dialog did not close on Escape");
  await settle();
  check(closeEvents.length === prevCloseLen + 1, "Close event was not fired on Escape");
  check(
    closeEvents[closeEvents.length - 1] === "close-tick-2",
    "Escape invoked stale callback! Expected close-tick-2, got " + closeEvents[closeEvents.length - 1]
  );
  check(document.activeElement === triggerBtn, "Focus not restored to trigger button on Escape");

  flushSync(() => rootNode.unmount());
  return { passed: true, savedTitle, closeEvents };
};
`;

test("session rename dialog preserves draft, selection and focus during parent streaming re-renders", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-session-rename-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@minih-agent/i18n": join(root, "packages/i18n/src"),
        "@minih-agent/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });

    const styleNames = ["tokens", "base", "ui-kit", "overlays", "sessions"];
    const css = (await Promise.all(
      styleNames.map((name) =>
        readFile(join(root, `apps/desktop/src/styles/${name}.css`), "utf8")
      )
    )).join("\n").replace(/@theme(?: inline)?/g, ":root");

    await writeFile(join(temp, "styles.css"), css);
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>'
    );

    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on("console-message", (_event, level, message) => {
    if (message.includes("Security Warning")) return;
    console.error("RENDERER_LOG:", message);
  });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    await win.webContents.executeJavaScript("window.sessionRenameProbeStream()");
    const image = await win.webContents.capturePage();
    const scratch = process.env.PI_SCRATCH_DIR || __dirname;
    const screenshotPath = path.join(scratch, "session-rename-regression.png");
    fs.writeFileSync(screenshotPath, image.toPNG());
    console.log("SCREENSHOT_SAVED " + screenshotPath);

    const probe = await win.webContents.executeJavaScript("window.sessionRenameProbeSaveAndEscape()");
    console.log("SESSION_RENAME_PROBE " + JSON.stringify(probe));
    app.exit(0);
  } catch (error) {
    console.error("PROBE_ERROR:", error?.stack ?? error);
    try {
      const image = await win.webContents.capturePage();
      const scratch = process.env.PI_SCRATCH_DIR || __dirname;
      const screenshotPath = path.join(scratch, "session-rename-failure.png");
      fs.writeFileSync(screenshotPath, image.toPNG());
      console.log("SCREENSHOT_SAVED " + screenshotPath);
    } catch (_) {}
    app.exit(1);
  }
});
`
    );

    // The harness always has its own temporary directory; a machine-specific
    // scratch path made the suite fail on every other checkout.
    const env = { ...process.env, PI_SCRATCH_DIR: process.env.PI_SCRATCH_DIR || temp };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output += chunk;
      });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith("SESSION_RENAME_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("SESSION_RENAME_PROBE ".length)), {
      passed: true,
      savedTitle: "Edited Title Streaming",
      closeEvents: ["close-tick-1", "close-tick-2"],
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
