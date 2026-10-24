import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { BrowserHost } from "../../apps/desktop/electron/main/browser-host";
import { BrowserPane } from "../../apps/desktop/electron/main/browser-view";

const artifactDir = process.env.BROWSER_BACKGROUND_ARTIFACT_DIR;
if (!artifactDir) throw new Error("BROWSER_BACKGROUND_ARTIFACT_DIR is required");
app.setPath("userData", join(artifactDir, "profile"));
const stage = (value: string) => appendFileSync(join(artifactDir, "progress.log"), `${value}\n`);

function uidFor(tree: string, role: string, name: string): string {
  const match = tree.match(new RegExp(`- (e\\d+) ${role} "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert(match, `snapshot has no ${role} "${name}":\n${tree}`);
  return match[1];
}

async function main() {
  stage("app-ready");
  const server = createServer((request, response) => {
    const background = request.url?.includes("background");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>${background ? "background" : "visible"}</title>
      <style>body{margin:0;font:20px sans-serif;background:${background ? "#eef" : "#fee"}}</style>
      <main style="padding:24px">
        <h1 id="heading">${background ? "Background" : "Visible"} page</h1>
        <label>Name <input id="field" aria-label="Name"></label>
        <button id="go">Increment</button>
        <output id="clicks" aria-label="Clicks">0</output>
        <script>
          let clicks = 0;
          document.getElementById("go").addEventListener("click", () => {
            clicks += 1;
            document.getElementById("clicks").textContent = String(clicks);
          });
        </script>
      </main>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const window = new BrowserWindow({ width: 1020, height: 720, show: true });
  await window.loadURL(`data:text/html,${encodeURIComponent(
    `<!doctype html><style>body{margin:0;background:#1d1d22;color:#eee;font:18px sans-serif}
     #panel{position:fixed;right:0;top:0;bottom:0;width:40%;background:#101014}</style>
     <main style="padding:24px">Conversation stays visible.</main><section id=panel></section>`,
  )}`);
  stage("shell-loaded");

  const panes: BrowserPane[] = [];
  const host = new BrowserHost({
    createPane: (onState, onOpenUrl) => {
      const pane = new BrowserPane(onState, onOpenUrl);
      panes.push(pane);
      return pane;
    },
    isPluginLoaded: () => true,
    getFileRoots: async () => [join(artifactDir, "project")],
    getScratchDir: (sessionId) => {
      const dir = join(artifactDir, "scratch", sessionId || "none");
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    onState: () => {},
  });
  host.setWindow(window);
  const panel = { x: 612, y: 0, width: 408, height: 720 };
  host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true, bounds: panel });
  host.setGuestHole("pi.browser", { x: 0, y: 0, width: panel.width, height: panel.height });

  // Session A owns the measured side-panel hole.
  host.setChromeSession("A", "plugin:pi.browser/browser");
  const visible = host.navigate({ url: `${base}/visible` }, "A");
  await visible;
  stage("visible-loaded");

  // Session B runs in the background while A stays presented.
  const background = await host.navigate({ url: `${base}/background` }, "B");
  assert.equal(background?.sessionId, "B");
  stage("background-loaded");
  const backing = BrowserWindow.getAllWindows().find((candidate) => candidate !== window);
  assert(backing, "a hidden backing window hosts the background page");
  assert.equal(backing.isVisible(), false, "the backing window is never shown");
  assert.equal(backing.isMinimized(), false);
  const focusedBefore = BrowserWindow.getFocusedWindow()?.id ?? null;
  assert.equal(host.getState()?.sessionId, "A", "the visible session keeps its page");

  // Real pointer/text input in the background page, by snapshot uid.
  const tree = await host.snapshot("B");
  assert.match(tree.url, /background/);
  const field = uidFor(tree.tree, "textbox", "Name");
  await host.fill(field, "background-input", "B");
  let clicks = uidFor(tree.tree, "button", "Increment");
  const clicked = host.click(clicks, "B");
  await clicked;
  const state = await host.evaluate(
    `({value: document.getElementById("field").value, clicks: document.getElementById("clicks").textContent})`,
    "B",
  ) as { value: string; clicks: string };
  assert.equal(BrowserWindow.getFocusedWindow()?.id ?? null, focusedBefore, "background input takes no focus");
  assert.equal(state.value, "background-input");
  assert.equal(state.clicks, "1");
  stage("background-input");

  const shot = await host.screenshot({}, "B");
  assert(shot.path, "the background screenshot is written to the session scratch");
  assert(statSync(shot.path).size > 1000, "the background capture has image content");
  writeFileSync(join(artifactDir, "background-page.jpg"), Buffer.from(shot.data, "base64"));
  const shellShot = await window.webContents.capturePage();
  writeFileSync(join(artifactDir, "main-window.png"), shellShot.toPNG());
  assert.equal(host.getState()?.sessionId, "A", "capture does not change presentation");
  assert.equal(backing.isVisible(), false);
  stage("background-capture");

  // Collapsing the panel parks the page; it keeps answering.
  host.setChromeSurface(null);
  assert.equal((await host.snapshot("B")).url, `${base}/background`);
  host.setChromeSurface({ pluginId: "pi.browser", viewId: "browser", visible: true, bounds: panel });
  host.setGuestHole("pi.browser", { x: 0, y: 0, width: panel.width, height: panel.height });
  host.setChromeSession("A", "plugin:pi.browser/browser");
  stage("collapse-reshow");

  // Renderer reload: presentation detaches, pages survive, metadata restores.
  host.detachPresentation();
  assert.equal(host.getState(), null);
  assert.deepEqual(host.getPages("A").map((page) => page.tabId), ["plugin:pi.browser/browser"]);
  assert.deepEqual(host.getPages("B").map((page) => page.tabId), ["plugin:pi.browser/browser"]);
  assert.equal((await host.snapshot("B")).url, `${base}/background`);
  host.setChromeSession("A", "plugin:pi.browser/browser");
  assert.equal(host.getState()?.url, `${base}/visible`);
  stage("renderer-reload");

  // A closed connected target fails instead of borrowing the visible page.
  host.closeTab("B", "plugin:pi.browser/browser");
  await assert.rejects(host.snapshot("B"), (error: { code?: string }) => error.code === "UNAVAILABLE");
  assert.equal(host.getState()?.sessionId, "A");
  assert.match((await host.snapshot("A")).url, /visible/);
  const reconnected = await host.navigate({ url: `${base}/background?reconnected` }, "B");
  assert.match(reconnected?.url ?? "", /reconnected/);
  stage("cross-session");

  // Explicit close releases both the page and the backing window.
  host.closeSession("A");
  host.closeSession("B");
  assert.equal(host.getPages("A").length, 0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const leftover = BrowserWindow.getAllWindows().filter((candidate) => candidate !== window && !candidate.isDestroyed());
  assert.deepEqual(leftover, [], "the final parked page released the backing window");
  host.dispose();
  server.close();
  window.destroy();
  stage("released");
  console.log(`BROWSER_BACKGROUND_SESSION ${JSON.stringify({
    ok: true,
    artifactDir,
    stages: [
      "background-navigation-without-presentation",
      "background-input-and-capture",
      "collapse-reshow",
      "renderer-reload-restore",
      "cross-session-closed-target",
      "explicit-close-release",
    ],
  })}`);
}

app.whenReady().then(main).then(
  () => app.exit(0),
  (error: unknown) => {
    console.error(error);
    stage(`failed: ${error instanceof Error ? error.stack : String(error)}`);
    app.exit(1);
  },
);