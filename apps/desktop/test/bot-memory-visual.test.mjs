import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/*
 * The three screens of the employee-experience layer (employee mode 0.5 slice
 * 5), captured from the real stylesheet.
 *
 * What the pictures have to show, because no assertion can:
 *   1. the 经验 section with lessons, each naming the task it came from;
 *   2. the same section with lesson extraction off — one calm line, no list;
 *   3. the sidebar row of an accepted task, which must read 「已接受，待合并」
 *      and must not be orange any more.
 *
 * Dark and light, 1440 and 1024, `finishAnimations()` before every capture.
 */

const root = repositoryRoot();
const { build: bundle } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const artifactRoot = join(root, ".artifacts", "bot-memory");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { EmployeeExperienceSection } from "../../apps/desktop/src/features/bots/EmployeeExperienceSection";
import { BotTaskList } from "../../apps/desktop/src/features/bots/BotTaskList";

await i18n.use(initReactI18next).init({ lng: "zh-CN", keySeparator: false,
  resources: { "zh-CN": { translation: flattenCatalog(catalogs["zh-CN"]) } },
  interpolation: { escapeValue: false } });

const employee = {
  sessionId: "router", title: "Router 后端",
  profile: { name: "Router 后端", duty: "Minih-Router 网关、账号与计费", permissionMode: "accept-edits", mustAsk: [], observe: false },
  status: { kind: "stage", stage: "working" }, projectPath: "/repo/Minih-Agent-Desktop",
  updatedAt: "2026-11-13T02:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z",
};
const designer = {
  sessionId: "desktop", title: "Desktop 前端",
  profile: { name: "Desktop 前端", duty: "桌面端渲染层与外壳", permissionMode: "ask", mustAsk: [], observe: false },
  status: { kind: "idle" }, projectPath: "/repo/Minih-Agent-Desktop",
  updatedAt: "2026-11-13T01:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z",
};
const bots = [employee, designer];

const lesson = (id, content, shortId, taskId, date) => ({
  id, scopeKind: "bot", scopeKey: "router", kind: "fact", content,
  status: "active", origin: "extracted", evidence: "inferred",
  sourceSessionId: "session-" + taskId, sourceMessageIds: [],
  fingerprint: "fp-" + id, revision: 1, createdAt: Date.parse(date), updatedAt: Date.parse(date),
  useCount: 0, sourceTaskId: taskId, sourceTaskShortId: shortId,
  sourceTaskTitle: "示例任务", sourceTaskArchivedAt: date,
});

const lessons = {
  router: [
    lesson("lesson-1", "迁移脚本必须先跑一遍 v38 夹具，否则历史外键违例会让 v39 停下。", "3f8a11", "task-1", "2026-11-13T03:00:00.000Z"),
    lesson("lesson-2", "网关的集成测试要在 8787 端口空闲时跑，CI 上先 kill 旧进程。", "b71c04", "task-2", "2026-11-12T09:00:00.000Z"),
  ],
  desktop: [],
};

const settingsOn = { learnedMemory: { learn: true, model: "fixture/model", dailyTokenBudget: 200000 } };
const settingsOff = { learnedMemory: { learn: false } };

let settings = settingsOn;
window.minihAgent = {
  invoke: async (channel, payload) => {
    // lib/api unwraps the preload envelope ({ ok, data }), so the stub has to
    // speak the same shape a real invoke would.
    if (channel === IPC.invoke.settingsGet) return { ok: true, data: settings };
    if (channel === IPC.invoke.taskExperienceList) {
      return { ok: true, data: { entries: lessons[payload?.employeeSessionId] ?? [] } };
    }
    if (channel === IPC.invoke.memoryDelete) return { ok: true, data: { ok: true } };
    return { ok: false, error: { code: "UNEXPECTED", message: "unexpected channel " + channel } };
  },
  on: () => () => {},
  channels: IPC,
};

const rootNode = createRoot(document.getElementById("root"));
const noop = () => {};
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

const acceptedTask = {
  id: "task-accepted", employeeSessionId: "router", sessionId: "sess-accepted",
  title: "把设置页的滚动问题修掉", origin: "steward", stage: "person/accept",
  projectPath: "/repo/Minih-Agent-Desktop", shortId: "c02d19",
  createdAt: "2026-11-13T00:10:00.000Z", workspaceStatus: "none",
  acceptedAt: "2026-11-13T02:10:00.000Z",
};
const workingTask = {
  id: "task-working", employeeSessionId: "router", sessionId: "sess-working",
  title: "补 remote_gateway 的限流单测", origin: "steward", stage: "working",
  projectPath: "/repo/Minih-Agent-Desktop", shortId: "d41f02",
  createdAt: "2026-11-13T01:30:00.000Z", workspaceStatus: "ready",
};

function settingsSurface(child) {
  return React.createElement("div", { className: "settings-page" },
    React.createElement("div", { className: "settings-stack bot-settings" }, child));
}

let sceneKey = "experience";
function experienceCard() {
  return React.createElement("section", { className: "settings-card" },
    React.createElement("header", { className: "settings-card-header" },
      React.createElement("h3", { className: "settings-card-title" }, i18n.t("bots.experience.title")),
      React.createElement("p", { className: "settings-card-description" }, i18n.t("bots.experience.description"))),
    React.createElement(EmployeeExperienceSection, { bots, key: sceneKey }));
}

async function render(kind) {
  // A new key remounts the section, so each scene reads its own settings: the
  // switch state is read once per mount, exactly as it is in the app.
  sceneKey = kind;
  settings = kind === "experience-off" ? settingsOff : settingsOn;
  const scene = kind === "sidebar-accepted"
    ? React.createElement("div", { className: "shot-sidebar sidebar-surface" },
        React.createElement(BotTaskList, { tasks: [acceptedTask, workingTask], onOpenTask: noop }))
    : settingsSurface(experienceCard());
  flushSync(() => rootNode.render(scene));
  if (kind === "experience") {
    await until(() => document.body.textContent.includes("迁移脚本必须先跑一遍"), "the lessons");
    await until(() => document.body.textContent.includes("任务 #3f8a11"), "the source of a lesson");
  }
  if (kind === "experience-off") {
    await until(() => document.body.textContent.includes("经验提炼没打开"), "the off hint");
  }
  if (kind === "sidebar-accepted") {
    await until(() => document.body.textContent.includes("已接受，待合并"), "the accepted label");
    await until(() => document.body.textContent.includes("补 remote_gateway 的限流单测"), "the working row");
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
  #root { padding: 24px; box-sizing: border-box; }
  .shot-sidebar { width: 320px; }
`;

test(
  "experience: the lessons section and the accepted task row, dark and light, at 1440 and 1024",
  { skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false, timeout: 300_000 },
  async () => {
    await mkdir(artifactRoot, { recursive: true });
    const workDir = await mkdtemp(join(tmpdir(), "pi-bot-memory-shot-"));
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

      const scenes = ["experience", "experience-off", "sidebar-accepted"];
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
    win.setContentSize(1440, 900);
    await win.webContents.executeJavaScript(
      "new Promise((resolve, reject) => { const deadline = Date.now() + 20000; const tick = () => { if (window.shot) return resolve(true); if (Date.now() > deadline) return reject(new Error('renderer never loaded')); setTimeout(tick, 50); }; tick(); })",
    );
    for (const entry of plan) {
      win.setContentSize(entry.width, 900);
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
        // The switch-off scene is one line of text on a flat background, so it
        // compresses to a few kilobytes; the DOM assertions above are what prove
        // it rendered, and this floor only rejects a truly blank capture.
        assert.ok(bytes.length > 4_000, `${shot.file} is only ${bytes.length} bytes`);
        console.log(`✔ ${shot.theme} ${shot.scene} ${shot.width}px → ${shot.file.replace(root + "/", "")}`);
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  },
);