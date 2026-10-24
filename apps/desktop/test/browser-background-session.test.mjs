import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readMainSource } from "./helpers/source-contracts.mjs";

// Only Electron is replaced. Everything below is the production BrowserHost,
// BrowserPane, backing host and CDP layer.
const electron = `data:text/javascript,${encodeURIComponent(`
  import { EventEmitter } from "node:events";
  export const shell = {};
  export class View {
    children = [];
    parent = null;
    visible = true;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    addChildView(view) { this.children.push(view); view.parent = this; }
    removeChildView(view) {
      const index = this.children.indexOf(view);
      if (index >= 0) this.children.splice(index, 1);
      view.parent = null;
    }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    getBounds() { return { ...this.bounds }; }
    setVisible(visible) { this.visible = visible; }
  }
  export class BrowserWindow {
    static instances = [];
    contentView = new View();
    destroyed = false;
    constructor(options) {
      this.options = options;
      this.size = [options.width, options.height];
      BrowserWindow.instances.push(this);
    }
    getContentSize() { return this.size; }
    setContentSize(width, height) { this.size = [width, height]; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  export class WebContentsView extends View {
    static instances = [];
    constructor() {
      super();
      const wc = Object.assign(new EventEmitter(), {
        id: WebContentsView.instances.length + 1,
        url: "", destroyed: false, page: {},
        async loadURL(url) { this.url = url; this.emit("did-navigate", {}, url); },
        getURL() { return this.url; },
        getTitle: () => "fixture",
        isLoading: () => false,
        isDestroyed() { return this.destroyed; },
        close() { this.destroyed = true; this.emit("destroyed"); },
        getBackgroundThrottling() { return true; },
        setBackgroundThrottling() {},
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        setWindowOpenHandler: () => {},
        session: { setPermissionRequestHandler: () => {} },
      });
      wc.debugger = Object.assign(new EventEmitter(), {
        attached: false,
        isAttached() { return this.attached; },
        attach() { this.attached = true; },
        detach() { this.attached = false; },
        async sendCommand(method) {
          if (method === "Accessibility.getFullAXTree") {
            return { nodes: [{ nodeId: "1", role: { value: "WebArea" }, backendDOMNodeId: 7 }] };
          }
          if (method === "DOM.resolveNode") return { object: { objectId: "fixture-object" } };
          if (method === "Runtime.callFunctionOn") return { result: { value: { x: 12, y: 34 } } };
          return {};
        },
      });
      this.webContents = wc;
      WebContentsView.instances.push(this);
    }
  }
`)}`;
registerHooks({ resolve(specifier, context, next) {
  return specifier === "electron" ? { url: electron, shortCircuit: true } : next(specifier, context);
} });
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { BrowserHost } = await import("../electron/main/browser-host.ts");
const { BrowserPane } = await import("../electron/main/browser-view.ts");
const { BrowserBackingHost } = await import("../electron/main/browser-backing-host.ts");
const { WebContentsView, BrowserWindow, View } = await import("electron");

const settled = () => new Promise(setImmediate);

function harness() {
  const roots = [], published = [], presented = [], reveals = [], panes = [];
  const host = new BrowserHost({
    createPane: (onState, onOpenUrl) => {
      const pane = new BrowserPane(onState, onOpenUrl);
      panes.push(pane);
      return pane;
    },
    isPluginLoaded: () => true,
    getFileRoots: async (sessionId) => {
      roots.push(sessionId);
      return ["/projects/current"];
    },
    onState: (state) => published.push(state),
    onPresentationState: (state) => presented.push(state),
    onRevealView: (sessionId, tabId, location) => reveals.push({ sessionId, tabId, location }),
  });
  const contentView = new View();
  const window = { isDestroyed: () => false, contentView };
  const children = contentView.children;
  host.setWindow(window);
  host.setChromeSurface({
    pluginId: "pi.browser", viewId: "browser", visible: true,
    bounds: { x: 620, y: 60, width: 430, height: 640 },
  });
  host.setGuestHole("pi.browser", { x: 0, y: 0, width: 430, height: 640 });
  return { host, panes, children, published, presented, reveals, roots };
}

test("a background session's click runs on its own parked page and takes no focus", async (t) => {
  const h = harness();
  t.after(() => h.host.dispose());
  const visible = h.host.navigate({ url: "https://fixture.invalid/visible" }, "A");
  await settled();
  const first = WebContentsView.instances.at(-1);
  assert.equal(first.webContents.url, "https://fixture.invalid/visible");

  // Session B navigates while A owns the visible panel.
  const background = h.host.navigate({ url: "https://fixture.invalid/background" }, "B");
  await settled();
  const parked = WebContentsView.instances.at(-1);
  assert.notEqual(parked, first);
  assert.equal(parked.webContents.url, "https://fixture.invalid/background");
  assert(!h.children.includes(parked.parent), "the background guest never joins the main window");
  const backing = BrowserWindow.instances.at(-1);
  assert.equal(backing.options.show, false, "the backing host stays hidden");
  assert.equal(backing.options.skipTaskbar, true);
  assert.equal(backing.options.webPreferences.sandbox, true);
  assert(backing.contentView.children.includes(parked.parent), "Chromium keeps the parked surface");
  await Promise.all([visible, background]);
  // The renderer mounts A's tab; the presentation selects A only.
  h.host.setChromeSession("A", "plugin:pi.browser/browser");
  const presentedBefore = h.presented.length;
  assert.equal(h.presented.at(-1).sessionId, "A");
  assert(h.children.includes(first.parent), "A's page fills the measured hole");

  // A snapshot uid from the background page is clickable without revealing it.
  const snapshot = await h.host.snapshot("B");
  assert.match(snapshot.tree, /e1 WebArea/);
  await h.host.click("e1", "B");
  assert.equal(h.children.includes(parked.parent), false, "input never attaches the page");
  assert.equal(h.presented.length, presentedBefore, "the visible presentation is not repainted");
  assert.equal(h.host.getState().sessionId, "A");
});

test("collapsing the panel parks the page instead of destroying it", async (t) => {
  const h = harness();
  t.after(() => h.host.dispose());
  const navigation = h.host.navigate({ url: "https://fixture.invalid/collapse" }, "A");
  await settled();
  const view = WebContentsView.instances.at(-1);
  await navigation;
  const created = WebContentsView.instances.length;
  h.host.setChromeSession("A", "plugin:pi.browser/browser");
  assert(h.children.includes(view.parent), "the visible page is attached");

  h.host.setChromeSurface(null);
  assert(!h.children.includes(view.parent), "hiding detaches the surface");
  assert.equal(view.webContents.isDestroyed(), false);
  assert.equal(BrowserWindow.instances.at(-1).destroyed, false);
  assert.equal((await h.host.snapshot("A")).url, "https://fixture.invalid/collapse");

  h.host.setChromeSurface({
    pluginId: "pi.browser", viewId: "browser", visible: true,
    bounds: { x: 620, y: 60, width: 430, height: 640 },
  });
  h.host.setGuestHole("pi.browser", { x: 0, y: 0, width: 430, height: 640 });
  h.host.setChromeSession("A", "plugin:pi.browser/browser");
  assert(h.children.includes(view.parent), "showing reuses the same native view");
  assert.equal(WebContentsView.instances.length, created, "no second page is created");
});

test("renderer reload keeps pages and getPages restores only that session", async (t) => {
  const h = harness();
  t.after(() => h.host.dispose());
  const a = h.host.navigate({ url: "https://fixture.invalid/a" }, "A");
  await settled();
  const b = h.host.navigate({ url: "https://fixture.invalid/b" }, "B");
  await settled();
  await Promise.all([a, b]);

  h.host.detachPresentation();
  assert.deepEqual(h.children, [], "presentation is detached on reload");
  assert.equal(BrowserWindow.instances.at(-1).destroyed, false, "pages stay parked");
  const pages = h.host.getPages("A");
  assert.deepEqual(pages.map((page) => [page.sessionId, page.tabId, page.url]), [
    ["A", "plugin:pi.browser/browser", "https://fixture.invalid/a"],
  ]);
  assert.equal((await h.host.snapshot("A")).url, "https://fixture.invalid/a");
});

test("explicit close and session delete release the parked page and backing window", async (t) => {
  const h = harness();
  t.after(() => h.host.dispose());
  const navigation = h.host.navigate({ url: "https://fixture.invalid/close" }, "A");
  await settled();
  const view = WebContentsView.instances.at(-1);
  await navigation;
  const backing = BrowserWindow.instances.at(-1);

  h.host.closeSession("A");
  assert.equal(view.webContents.isDestroyed(), true);
  assert.equal(backing.destroyed, true, "the final parked surface releases the backing window");
  assert.deepEqual(h.host.getPages("A"), []);
  await assert.rejects(h.host.snapshot("A"), { code: "UNAVAILABLE" });
});

test("a standalone backing host is lazy and shared across panes", () => {
  const host = new BrowserBackingHost();
  const first = new WebContentsView();
  const second = new WebContentsView();
  const window = host.attach(first, { width: 800, height: 600 });
  assert.equal(window.getContentSize()[0] >= 800, true);
  assert.equal(host.attach(second, { width: 100, height: 100 }), window, "one backing window");
  host.detach(first);
  assert.equal(window.isDestroyed(), false);
  host.detach(second);
  assert.equal(window.destroyed, true);
});

test("window reload detaches presentation instead of disposing pages", async () => {
  const source = await readMainSource();
  const reload = source.slice(
    source.indexOf('window.webContents.on("did-start-loading"'),
    source.indexOf('window.webContents.on("render-process-gone"'),
  );
  assert.match(reload, /browserHost\.detachPresentation\(\)/);
  assert.doesNotMatch(reload, /browserHost\.disposeGuest\(\)/);
});

test("the session-filtered getPages IPC is additive and ignores remote sessions", async () => {
  const main = await readMainSource();
  const handler = main.slice(
    main.indexOf("IPC.invoke.browserGetPages"),
    main.indexOf("const workspaceRootInfo"),
  );
  assert.match(handler, /String\(input\.sessionId \?\? ""\)\.trim\(\)/);
  assert.match(handler, /sessionId\.startsWith\("remote:"\)/);
  assert.match(handler, /browserHost\.getPages\(sessionId\)/);
  const protocol = await import("../../../packages/shared/src/protocol.ts");
  assert.equal(protocol.IPC.invoke.browserGetPages, "minih-agent-desktop/browser/getPages");
  assert.equal(protocol.IPC_WHITELIST.has(protocol.IPC.invoke.browserGetPages), true);
});

test("BrowserPreview asks Main for its page instead of navigating the renderer tab", async () => {
  const main = await readMainSource();
  const handler = main.slice(
    main.indexOf('s.setLocalTool("BrowserPreview"'),
    main.indexOf("sidecar = s;"),
  );
  assert.match(handler, /await browserHost\.openTab\(\{ path: file \}, sessionId\)/);
  assert.doesNotMatch(handler, /sendToRenderer\(IPC\.event\.browserPreview/);
});

test("every plugin Browser API forwards the trusted invocation session", async () => {
  const { readFileSync } = await import("node:fs");
  const runtime = readFileSync(new URL("../electron/main/plugin-runtime.ts", import.meta.url), "utf8");
  const session = /this\.browserSessionId\(pluginId\) \?\? browserContext\?\.sessionId/;
  for (const call of [
    "action(action, ", "getState(", "openExternal(", "snapshot(", "click(uid, ",
    "fill(uid, text, ", "evaluate(expression, ", "console(limit, ", "cdp(method, params, ",
  ]) {
    const index = runtime.indexOf(`this.services.browser.${call}`);
    assert.ok(index > 0, `missing forwarded call: ${call}`);
    const line = runtime.slice(index, runtime.indexOf("\n", index));
    assert.match(line, session, `${call} must carry the trusted session`);
  }
  assert.match(runtime, /Browser tool calls require a session\./);
  assert.match(
    runtime,
    /const sessionId = invocation\.sessionId\.trim\(\);\s*\n\s*if \(!sessionId\) throw apiError/,
  );
});

test("BrowserPreview temp file roots and containment stay untouched", async () => {
  const temp = mkdtempSync(join(tmpdir(), "browser-preview-guard-"));
  try {
    const { readFileSync } = await import("node:fs");
    const view = readFileSync(new URL("../electron/main/browser-view.ts", import.meta.url), "utf8");
    const { resolveLocalFile } = await import("../electron/main/browser-view.ts");
    const { writeFileSync } = await import("node:fs");
    const file = join(temp, "page.html");
    writeFileSync(file, "<html></html>");
    assert.equal(resolveLocalFile("page.html", temp), realpathSync(file));
    assert.equal(resolveLocalFile("page.html", temp), realpathSync(file));
    assert.equal(resolveLocalFile("../outside.html", temp), null);
    assert.match(view, /isWithinRoot\(real, root\)/);
    assert.match(view, /partition: PARTITION/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});