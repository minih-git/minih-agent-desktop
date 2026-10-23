/**
 * The learned-memory settings belong to the AI category's instructions-and-memory
 * page, and the automatic
 * learning switch only explains itself when it actually cannot be turned on.
 *
 * This is a real renderer user path: the actual `SettingsPage` is mounted in an
 * isolated Electron window with a stubbed IPC boundary, so the assertions read
 * the rendered DOM per tab instead of the component's source text.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const { catalogs, flattenCatalog } = await import("../../../packages/i18n/src/index.ts");
const { searchSettings } = await import("../src/lib/settings-search.ts");

const english = flattenCatalog(catalogs.en);
const learnedMemoryTitle = english["settings.learnedMemory"];
const extractionTitle = english["settings.learnedMemoryExtraction"];
const needsModelHint = english["settings.learnedMemoryExtractionNeedsModel"];

/** Inline `?url` asset imports resolve to file loaders, as in the app build. */
const urlAssets = {
  name: "local-url-assets",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
      path: join(resolveDir, path.slice(0, -4)),
      namespace: "local-url-asset",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
      contents: await readFile(path),
      loader: "file",
    }));
  },
};
const fixtureSource = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { SettingsPage } from "../../apps/desktop/src/features/settings/SettingsPage";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const en = flattenCatalog(catalogs.en);
const cardTitle = en["settings.learnedMemory"];
const extractionTitle = en["settings.learnedMemoryExtraction"];
const needsModel = en["settings.learnedMemoryExtractionNeedsModel"];

const rendererErrors = [];
const originalConsoleError = console.error;
console.error = (...args) => { rendererErrors.push(args.map((value) => String(value && value.stack ? value.stack : value)).join(" ")); originalConsoleError(...args); };
window.addEventListener("error", (event) => rendererErrors.push(String(event.error?.stack ?? event.message)));

const calls = [];
window.minihAgent = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, ...args) {
    calls.push({ channel, input: args[0] });
    switch (channel) {
      case IPC.invoke.pluginScenicThemesDestinations:
      case IPC.invoke.systemFontsList:
        return { ok: true, data: [] };
      case IPC.invoke.providersList:
        return { ok: true, data: { providers: [] } };
      case IPC.invoke.storageGet:
        return { ok: true, data: {
          dataPath: "/fixture/data",
          browserPath: "/fixture/browser",
          managed: true,
          cacheBytes: 0,
          pendingPath: null,
          lastError: null,
          backupPaths: [],
        } };
      // The instructions page renders the global instruction file beside the
      // learned-memory card, so its read has to answer with a file.
      case IPC.invoke.agentInstructionsGet:
        return { ok: true, data: {
          global: { path: "/fixture/instructions.md", content: "" },
          project: null,
        } };
      case IPC.invoke.memoryExtractionStatus:
        return { ok: true, data: { budget: { day: args[0]?.day ?? "", tokens: 0, runs: 0 } } };
      // The AI tab also carries the command-shell row, which reads a catalog
      // rather than a list; a bare object would break its render.
      case IPC.invoke.commandShellList:
        return { ok: true, data: {
          configuredId: null,
          effective: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
          fallback: false,
          choices: [{ id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true }],
        } };
      default:
        return { ok: true, data: {} };
    }
  },
};

await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  keySeparator: false,
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
useAppStore.setState({
  settings: {
    theme: "light",
    language: "en",
    developerMode: false,
    learnedMemory: { learn: false, model: "fixture-provider/fixture-model" },
  },
  settingsTab: "general",
  page: "settings",
});
document.documentElement.dataset.theme = "light";
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(React.createElement(SettingsPage)));

const frame = () => new Promise(requestAnimationFrame);
async function settle() {
  await frame();
  await frame();
}
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await settle();
    const value = predicate();
    if (value) return value;
  }
  throw new Error(message);
}
function categoryItem(label) {
  return [...document.querySelectorAll(".settings-category")]
    .find((button) => button.textContent.trim() === label);
}
function navItem(label) {
  return [...document.querySelectorAll(".settings-subnav-item")]
    .find((button) => button.querySelector(".settings-nav-label")?.textContent.trim() === label);
}
function cardTitles() {
  return [...document.querySelectorAll(".settings-card-block")]
    .map((card) => card.querySelector(".settings-card-heading")?.textContent.trim() ?? "");
}
function learnedMemoryCard() {
  return [...document.querySelectorAll(".settings-card-block")]
    .find((card) => card.querySelector(".settings-card-heading")?.textContent.trim() === cardTitle);
}
/** The visible value line of one row, which is where the model hint lives. */
function rowDetail(title) {
  const row = [...document.querySelectorAll(".settings-row")]
    .find((node) => node.querySelector(".settings-row-title")?.textContent.trim().startsWith(title));
  if (!row) throw new Error("Settings row is missing: " + title);
  return row.querySelector(".settings-row-detail")?.textContent.trim() ?? "";
}
function rowSwitch(title) {
  const row = [...document.querySelectorAll(".settings-row")]
    .find((node) => node.querySelector(".settings-row-title")?.textContent.trim().startsWith(title));
  if (!row) throw new Error("Settings row is missing: " + title);
  return row.querySelector('[role="switch"]');
}

window.learnedMemoryPlacementProbe = async () => {
  await waitFor(
    () => categoryItem("General"),
    "Settings navigation did not render: " + rendererErrors.join(" | "),
  );
  await waitFor(() => learnedMemoryCard() || cardTitles().length > 0, "Settings cards did not render");

  // (1) The General category must not carry the learned-memory card.
  const generalTitles = cardTitles();
  const generalHasCard = generalTitles.includes(cardTitle);

  // (2) The AI category keeps it on its instructions-and-memory page, next to
  // the global instructions — not on the chat-experience page and not merged
  // into one long AI page.
  flushSync(() => categoryItem("AI").click());
  await settle();
  const chatTitles = cardTitles();
  const chatHasCard = chatTitles.includes(cardTitle);
  flushSync(() => navItem("Instructions & memory").click());
  await waitFor(() => learnedMemoryCard(), "The instructions page did not render the learned-memory card");
  const aiTitles = cardTitles();
  const aiHasCard = aiTitles.includes(cardTitle);

  // (3) A chosen model with the switch off must not claim a model is missing.
  const modelChosenHint = rowDetail(extractionTitle);
  const modelChosenSwitchDisabled = rowSwitch(extractionTitle).disabled;

  // (4) Without a model the row explains why it cannot be turned on.
  flushSync(() => {
    const state = useAppStore.getState();
    useAppStore.setState({
      settings: { ...state.settings, learnedMemory: { learn: false, model: "" } },
    });
  });
  await waitFor(
    () => rowDetail(extractionTitle) === needsModel,
    "Clearing the model did not reveal the reason the switch is off",
  );
  const noModelHint = rowDetail(extractionTitle);
  const noModelSwitchDisabled = rowSwitch(extractionTitle).disabled;

  return {
    generalTitles,
    generalHasCard,
    chatTitles,
    chatHasCard,
    aiHasCard,
    aiTitles,
    modelChosenHint,
    modelChosenSwitchDisabled,
    noModelHint,
    noModelSwitchDisabled,
    calls,
  };
};
`;

test("learned-memory settings render on the AI instructions page only", {
  timeout: 90_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-learned-memory-placement-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "apps", "desktop"),
        sourcefile: join(root, "apps", "desktop", "test", "learned-memory-placement-fixture.tsx"),
        loader: "tsx",
      },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "true" },
      alias: {
        "@minih-agent/i18n": join(root, "packages/i18n/src"),
        "@minih-agent/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
      plugins: [urlAssets],
    });

    const renderer = join(root, "apps/desktop/out/renderer");
    const rendererHtml = await readFile(join(renderer, "index.html"), "utf8");
    const css = [...rendererHtml.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
    assert(css.length, "Run pnpm --filter @minih-agent/desktop build before this test");
    await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
    await writeFile(
      join(temp, "index.html"),
      `<!doctype html><html data-platform="darwin"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:">${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`,
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { writeFile } = require("node:fs/promises");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 820,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.learnedMemoryPlacementProbe()");
    // Optional evidence capture: the screenshots are written only when the
    // caller asks for them, so the test never leaves files behind.
    const directory = process.env.MINIH_AGENT_SETTINGS_SCREENSHOTS;
    if (directory) {
      const shot = async (tab) => {
        await win.webContents.executeJavaScript(
          'document.querySelectorAll(".settings-nav-item")[' + tab + '].click()',
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        const image = await win.webContents.capturePage();
        await writeFile(path.join(directory, tab + ".png"), image.toPNG());
      };
      await shot(0);
      await shot(1);
      result.screenshots = directory;
    }
    console.log("LEARNED_MEMORY_PLACEMENT " + JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error(error?.stack ?? error);
    app.exit(1);
  }
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 80_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output);
    const line = output.split(/\r?\n/).find((row) => row.startsWith("LEARNED_MEMORY_PLACEMENT "));
    assert(line, output);
    const result = JSON.parse(line.slice("LEARNED_MEMORY_PLACEMENT ".length));

    assert.equal(
      result.generalHasCard,
      false,
      `the learned-memory card must not render on General: ${JSON.stringify(result.generalTitles ?? [])}`,
    );
    assert.equal(
      result.chatHasCard,
      false,
      `the chat-experience page must not carry the learned-memory card: ${JSON.stringify(result.chatTitles ?? [])}`,
    );
    assert.equal(
      result.aiHasCard,
      true,
      "the learned-memory card must render on the AI instructions & memory page",
    );
    assert.ok(
      result.aiTitles.length > 1,
      "the instructions page must keep the global instructions card beside it",
    );
    assert.equal(
      result.modelChosenHint,
      "",
      "a chosen model must not be reported as missing",
    );
    assert.equal(result.modelChosenSwitchDisabled, false);
    assert.equal(result.noModelHint, needsModelHint);
    assert.equal(result.noModelSwitchDisabled, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("settings search finds learned memory on the AI instructions page", () => {
  const lookup = (key) => english[key] ?? key;
  for (const query of ["learned memory", "learn automatically", "learning model"]) {
    const hits = searchSettings(query, lookup);
    assert.ok(hits.length > 0, `no settings hit for "${query}"`);
    assert.ok(
      hits.some((hit) => hit.tab === "instructions"),
      `"${query}" must reach the AI instructions page: ${JSON.stringify(hits)}`,
    );
  }
});
