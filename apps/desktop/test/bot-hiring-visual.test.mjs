import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * The five screens of hiring and team norms (employee mode 0.5 slice 6),
 * captured inside the real settings shell.
 *
 * A picture of a lone component would not answer the questions this slice has to
 * answer: where the team norms sit, whether the templates read like a row of
 * jobs, what the prefilled form looks like *in the page*, and — the one that
 * matters most — that a host with four employees still shows all four of them.
 *
 * So every shot is the window: the settings title, the category rail, the
 * content column, and the employee page inside it. Dark and light, 1440 and
 * 1024, `finishAnimations()` before every capture.
 */

const root = repositoryRoot();
const { build: bundle } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const artifactRoot = join(root, ".artifacts", "bot-hiring");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { BotsSettingsPage } from "../../apps/desktop/src/features/bots/BotsSettingsPage";
import { SettingsNavigation } from "../../apps/desktop/src/features/settings/SettingsNavigation";
import { visibleSettingsCategories } from "../../apps/desktop/src/lib/settings-search";

await i18n.use(initReactI18next).init({ lng: "zh-CN", keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } },
  interpolation: { escapeValue: false } });

function employee(sessionId, name, duty, extra = {}) {
  return {
    sessionId, title: name,
    profile: { name, duty, permissionMode: "ask", mustAsk: [], observe: false, ...extra },
    status: { kind: "idle" },
    updatedAt: "2026-11-14T02:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z",
  };
}

// The crew a person already had before this slice: the steward plus the three
// jobs the old seed created. Scene 5 exists to prove none of them disappear.
const existingCrew = [
  employee("steward", "Super Agent", "接你的话、拟卡片、回报进展", { definition: "steward" }),
  employee("router", "Router 后端", "Minih-Router 网关、账号与计费", { permissionMode: "accept-edits" }),
  employee("desktop", "Desktop 前端", "桌面端渲染层与外壳", { permissionMode: "accept-edits" }),
  employee("docs", "调研与文档", "调研、笔记与文档"),
];
const reviewCrew = [
  existingCrew[0],
  employee("reviewer", "审查员", "只读代码并指出问题", { definition: "code-reviewer" }),
];

let bots = [];
let drafted = false;
window.minihAgent = {
  invoke: async (channel, input) => {
    if (channel === IPC.invoke.botList) return { ok: true, data: { bots } };
    if (channel === IPC.invoke.subagentCatalog) {
      const names = ["explorer", "code-reviewer", "test-runner", "fixer", "ui-designer", "steward"];
      return { ok: true, data: { subagents: [], builtins: names.map((name) => ({ name, enabled: true })), diagnostics: [], projectPath: null } };
    }
    if (channel === IPC.invoke.providersList) {
      return { ok: true, data: { providers: [
        { id: "anthropic", name: "Anthropic", enabled: true, hasSecret: true, models: [{ id: "claude-x", label: "Claude X" }] },
        { id: "google", name: "Google", enabled: true, hasSecret: true, models: [{ id: "gemini-3-pro", label: "Gemini 3 Pro" }] },
      ] } };
    }
    if (channel === IPC.invoke.projectList) {
      return { ok: true, data: { projects: [
        { path: "/repo/Minih-Router", name: "Minih-Router" },
        { path: "/repo/Minih-Agent-Desktop", name: "Minih-Agent-Desktop" },
      ] } };
    }
    if (channel === IPC.invoke.teamNormsGet) {
      return { ok: true, data: { norms: scene === "enable-steward" ? null : {
        version: 1,
        communication: "用中文汇报，先给结论；不要汇报过程流水账。",
        scope: "不要重排你没改过的文件；动共享配置前先问。",
        delivery: "判断「做完了」时，改动要带证明它的测试，以及你实际跑过的命令。",
      } } };
    }
    if (channel === IPC.invoke.botDraftHire) {
      return { ok: true, data: { draft: {
        templateId: "backend",
        name: "Router 计费",
        duty: "Minih-Router 的计费、额度与账单。",
        permissionMode: "accept-edits",
        mustAsk: ["deploy", "delete", "spend"],
        projectPath: "/repo/Minih-Router",
        reason: "你说的是网关的计费代码，而且它是空闲的。",
      } } };
    }
    return { ok: false, error: { code: "UNEXPECTED", message: "unexpected channel " + channel } };
  },
  on: () => () => {},
  channels: IPC,
};

let scene = "hiring";
const rootNode = createRoot(document.getElementById("root"));
const settle = (frames) => new Promise((resolve) => {
  let left = frames;
  const tick = () => (left-- <= 0 ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
});
const until = async (predicate, label) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("timed out waiting for " + label + " — body: " + document.body.textContent.slice(0, 400));
};
async function finishAnimations() {
  if (document.getAnimations) {
    for (const animation of document.getAnimations()) {
      try { animation.finish(); } catch {}
    }
  }
  await settle(2);
}
const button = (label) => [...document.querySelectorAll("button")]
  .find((node) => node.textContent.replace(/\s+/g, " ").trim() === label);
const template = (id) => document.querySelector("[data-template-id='" + id + "']");
const noop = () => {};
const settingsCategories = visibleSettingsCategories(false, false);
const settingsBarRef = React.createRef();
const employeesCategory =
  settingsCategories.find((category) => category.entries.some((entry) => entry.id === "employees")) ??
  settingsCategories[0];

/** Settings → Employees, with the real settings chrome around the page. */
function settingsEmployeesPage() {
  return React.createElement("div", { className: "settings-page" },
    React.createElement("div", { className: "settings-page-content", role: "main" },
      React.createElement("header", { className: "settings-panel-head drag" },
        React.createElement("h1", { className: "settings-panel-title" }, i18n.t("settings.title"))),
      React.createElement(SettingsNavigation, {
        t: i18n.t.bind(i18n),
        categories: settingsCategories,
        activeCategory: employeesCategory,
        activeTab: "employees",
        activeExtension: null,
        extensions: [],
        extensionHits: [],
        searching: false,
        categoryOverflow: false,
        barRef: settingsBarRef,
        onSelectCategory: noop,
        onSelectDestination: noop,
        onOpenExtension: noop,
      }),
      React.createElement("div", { className: "settings-content-area" },
        React.createElement("div", { className: "settings-content" },
          React.createElement("div", { className: "settings-content-inner" },
            React.createElement("div", { className: "settings-content-enter" },
              React.createElement(BotsSettingsPage, { bots, key: scene })))))));
}

/** The window as AppShell lays it out: settings replaces the chat shell. */
function windowShell() {
  return React.createElement("div", { className: "app-shell" },
    React.createElement("div", { className: "app-chat-shell", hidden: true, inert: true }),
    settingsEmployeesPage());
}

async function render(kind) {
  scene = kind;
  drafted = false;
  bots = kind === "existing-crew" ? existingCrew : kind === "enable-steward" ? [] : reviewCrew;
  flushSync(() => rootNode.render(windowShell()));
  await until(() => document.body.textContent.includes("团队规范"), "the norms card");
  await until(() => document.body.textContent.includes("招聘"), "the hiring card");
  await until(() => document.querySelector(".settings-page"), "the settings chrome");
  await until(() => document.querySelector(".settings-panel-head"), "the settings title");
  // The page must be the window, not a pasted card.
  const pageBox = document.querySelector(".settings-page").getBoundingClientRect();
  if (pageBox.width < window.innerWidth * 0.95) {
    throw new Error("the settings page does not fill the window: " + JSON.stringify(pageBox));
  }
  const titleBox = document.querySelector(".settings-panel-head").getBoundingClientRect();
  if (titleBox.top > 140) {
    throw new Error("the settings title is not at the top: " + JSON.stringify(titleBox));
  }

  if (kind === "template-form") {
    await until(() => template("review"), "the review template");
    flushSync(() => template("review").click());
    await until(() => document.body.textContent.includes("新建员工"), "the prefilled form");
  }
  if (kind === "draft-form") {
    const box = document.querySelector("input[aria-label='用一句话描述你要招的人']");
    if (!box) throw new Error("the one-sentence box is missing");
    const setter = Object.getOwnPropertyDescriptor(box.constructor.prototype, "value").set;
    flushSync(() => {
      setter.call(box, "招一个管 Router 计费的后端");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle(2);
    flushSync(() => button("起草").click());
    await until(() => document.body.textContent.includes("为什么是这个岗位"), "the draft reason");
  }

  // A form scene is about the form: bring it into the picture, then check it is
  // really on screen.
  if (kind === "template-form" || kind === "draft-form") {
    const form = [...document.querySelectorAll(".settings-card-block")]
      .find((element) => element.textContent.includes("新建员工"));
    if (!form) throw new Error("the form is not on the page");
    form.scrollIntoView({ block: "center" });
    await settle(2);
    const box = form.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight + 1) {
      throw new Error("the form is below the fold");
    }
  } else {
    window.scrollTo({ top: 0 });
    await settle(1);
  }

  if (kind === "existing-crew") {
    // The point of the scene: four employees, all of them, none renamed.
    for (const name of ["Super Agent", "Router 后端", "Desktop 前端", "调研与文档"]) {
      await until(() => document.body.textContent.includes(name), "employee " + name);
    }
    const card = [...document.querySelectorAll(".settings-card-block")]
      .find((element) => element.textContent.includes("你的员工"));
    if (!card) throw new Error("the employee list is not on the page");
    card.scrollIntoView({ block: "center" });
    await settle(2);
  }
  if (kind === "enable-steward") {
    await until(() => button("启用 Super Agent"), "the enable button");
  } else if (kind === "hiring") {
    if (button("启用 Super Agent")) throw new Error("the enable button shows with a crew present");
  }
  await settle(4);
  await finishAnimations();
  await settle(2);
}

window.shot = {
  async render(kind, theme) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.platform = "darwin";
    try {
      await render(kind);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  },
};
`;

/** Compile the shipped stylesheet (Tailwind included) into one CSS file. */
async function compileStylesheet(workDir) {
  const { build: viteBuild } = await import("vite");
  const { default: tailwindcss } = await import("@tailwindcss/vite");
  const appDir = join(root, "apps/desktop");
  const entry = join(workDir, "style-entry.js");
  const outDir = join(workDir, "styles");
  await writeFile(entry, `import ${JSON.stringify(join(appDir, "src/styles/globals.css"))};\n`);
  await viteBuild({
    configFile: false,
    root: appDir,
    logLevel: "error",
    plugins: [tailwindcss()],
    build: {
      outDir,
      emptyOutDir: true,
      cssCodeSplit: false,
      rollupOptions: { input: entry, output: { entryFileNames: "style-entry.js", assetFileNames: "styles[extname]" } },
    },
  });
  const files = await readdir(outDir);
  const stylesheet = files.find((name) => name.endsWith(".css"));
  assert.ok(stylesheet, "the stylesheet did not compile");
  return join(outDir, stylesheet);
}

const harnessCss = `
  html, body, #root { height: 100%; margin: 0; }
  body { background: var(--ds-bg-primary); color: var(--ds-text-primary); }
`;

test(
  "hiring and team norms: five screens inside the real settings shell, dark and light, at 1440 and 1024",
  { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false, timeout: 300_000 },
  async () => {
    await mkdir(artifactRoot, { recursive: true });
    const workDir = await mkdtemp(join(tmpdir(), "pi-bot-hiring-shot-"));
    try {
      const workletStub = join(workDir, "pcm-worklet-stub.js");
      await writeFile(workletStub, 'export default "";\n');
      await bundle({
        stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
        outfile: join(workDir, "renderer.js"),
        bundle: true,
        platform: "browser",
        format: "esm",
        jsx: "automatic",
        define: {
          "process.env.NODE_ENV": '"production"',
          "process.env": '{"NODE_ENV":"production","DEV":false}',
          "import.meta.env": '{"DEV":false,"PROD":true,"MODE":"production"}',
        },
        plugins: [
          {
            name: "vite-url-import-stub",
            setup(build) {
              build.onResolve({ filter: /\?url$/ }, () => ({ path: workletStub }));
            },
          },
        ],
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
      const stylesheet = await compileStylesheet(workDir);
      await writeFile(
        join(workDir, "index.html"),
        `<!doctype html><meta charset="utf-8"><style>${harnessCss}</style>
         <link rel="stylesheet" href="${stylesheet}">
         <div id="root"></div><script type="module" src="renderer.js"></script>`,
      );

      const scenes = ["hiring", "template-form", "draft-form", "enable-steward", "existing-crew"];
      const plan = [];
      for (const theme of ["dark", "light"]) {
        for (const width of [1440, 1024]) {
          for (const scene of scenes) plan.push({ theme, width, scene });
        }
      }

      await writeFile(
        join(workDir, "main.cjs"),
        `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { writeFileSync } = require("node:fs");
app.setPath("userData", path.join(__dirname, "profile"));
const plan = ${JSON.stringify(plan)};
const outDir = ${JSON.stringify(artifactRoot)};
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    await win.webContents.executeJavaScript(
      "new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const tick = () => { if (window.shot) return resolve(true); if (Date.now() > deadline) return reject(new Error('renderer never loaded')); setTimeout(tick, 50); }; tick(); })",
    );
    for (const entry of plan) {
      win.setContentSize(entry.width, 1180);
      const rendered = await win.webContents.executeJavaScript("window.shot.render(" + JSON.stringify(entry.scene) + "," + JSON.stringify(entry.theme) + ")");
      if (!rendered || rendered.ok !== true) {
        throw new Error("scene " + entry.scene + " did not render: " + JSON.stringify(rendered));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      const image = await win.webContents.capturePage();
      const file = path.join(outDir, entry.theme + "-" + entry.scene + "-" + entry.width + ".png");
      writeFileSync(file, image.toPNG());
      console.log("SHOT " + JSON.stringify({ ...entry, file }));
    }
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`,
      );

      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(resolveElectronBinary(root).electronBinary, [join(workDir, "main.cjs")], {
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
      const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
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
      const shots = output
        .split(/\r?\n/)
        .filter((line) => line.startsWith("SHOT "))
        .map((line) => JSON.parse(line.slice("SHOT ".length)));
      assert.equal(shots.length, plan.length, `captured ${shots.length} of ${plan.length}`);
      for (const shot of shots) {
        assert.ok(existsSync(shot.file), `${shot.file} is missing`);
        const bytes = readFileSync(shot.file);
        // A blank capture compresses to almost nothing; the DOM assertions above
        // are what prove the scene rendered, and this floor only rejects blank.
        assert.ok(bytes.length > 4_000, `${shot.file} is only ${bytes.length} bytes`);
        console.log(`✔ ${shot.theme} ${shot.scene} ${shot.width}px → ${shot.file.replace(root + "/", "")}`);
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  },
);