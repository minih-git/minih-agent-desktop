/**
 * A plugin view is a native `WebContentsView`: it draws above the renderer,
 * including the browser top layer, so a renderer overlay cannot be painted in
 * front of it. The only working answer is to hide the view while an overlay is
 * open, restore it afterwards, and give the keyboard back to the overlay.
 *
 * The fixture runs the real components inside a real Chromium window:
 *
 * * the sidebar-placement page (`PluginViewPage`, the reported bug) hides while
 *   another surface registers a blocking overlay and comes back when it closes;
 * * the host's credential dialog registers while it is up, focuses its first
 *   field, answers Escape with `cancel`, and hands the view back on close;
 * * the notification popover registers while open and unregisters on Escape.
 *
 * Visibility is asserted on the IPC the renderer actually sends
 * (`plugin/view/setVisible`), not on a class name or a test hook.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { PluginViewPage } from "../../apps/desktop/src/features/plugins/PluginViewPage";
import { PluginCredentialDialog } from "../../apps/desktop/src/components/plugins/PluginCredentialDialog";
import { NotificationCenter } from "../../apps/desktop/src/components/NotificationCenter";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { useBlockingOverlay, isBlockingOverlayActive } from "../../apps/desktop/src/lib/blocking-overlay";
import { pluginViewIcon } from "../../apps/desktop/src/lib/plugin-view-icons";
import "../../apps/desktop/src/styles/plugins.css";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });

const PLUGIN_ID = "com.example.mail";
const VIEW_REF = PLUGIN_ID + "/inbox";
const calls = [];
const listeners = new Map();
window.minihAgent = {
  platform: "darwin",
  on(channel, listener) {
    listeners.set(channel, listener);
    return () => { listeners.delete(channel); };
  },
  async invoke(channel, payload = {}) {
    calls.push({ channel, payload });
    if (channel === IPC.invoke.pluginCredentialsStatus) {
      return { ok: true, data: { slots: [{
        id: "account",
        title: "Mailbox",
        kind: "basic",
        configured: false,
        lastUsedAt: null,
        fields: [
          { key: "username", label: "Address" },
          { key: "password", label: "Password", secret: true },
        ],
      }] } };
    }
    return { ok: true, data: {} };
  },
};

let closedViews = 0;
useAppStore.setState({
  pluginViewRef: VIEW_REF,
  pluginViews: [{
    pluginId: PLUGIN_ID,
    viewId: "inbox",
    ref: VIEW_REF,
    title: "Inbox",
    pluginName: "Mail",
    icon: "mail",
    order: 0,
    placement: "sidebar",
  }],
  closeSidebarPluginView: () => { closedViews += 1; },
  notifications: [],
  plugins: [],
  refreshNotifications: async () => {},
  markAllNotificationsRead: async () => {},
  clearNotifications: async () => {},
  openNotification: async () => {},
  showToast: () => {},
});

function OverlayProbe() {
  useBlockingOverlay();
  return React.createElement("div", { className: "fixture-blocking-overlay" }, "overlay");
}

function Surface() {
  const [overlay, setOverlay] = React.useState(false);
  return React.createElement("div", null,
    React.createElement(PluginViewPage),
    React.createElement(PluginCredentialDialog),
    React.createElement(NotificationCenter),
    overlay ? React.createElement(OverlayProbe) : null,
    React.createElement("button", { id: "add-overlay", onClick: () => setOverlay(true) }, "open overlay"),
    React.createElement("button", { id: "remove-overlay", onClick: () => setOverlay(false) }, "close overlay"),
  );
}

const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(React.createElement(Surface)));

const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }
async function until(predicate, message) {
  for (let n = 0; n < 120; n += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(message + " | body=" + document.body.textContent);
}
const visibility = () => calls
  .filter((call) => call.channel === IPC.invoke.pluginViewSetVisible)
  .map((call) => call.payload.visible);
const lastVisible = () => visibility().at(-1);

window.pluginViewOcclusionProbe = async () => {
  await settle();
  check(document.querySelector("[data-plugin-view-page]"), "sidebar plugin page did not render");
  check(lastVisible() === true, "plugin view was not shown on open, saw " + JSON.stringify(visibility()));

  flushSync(() => document.getElementById("add-overlay").click());
  await settle();
  check(lastVisible() === false, "plugin view stayed visible under a blocking overlay");
  check(document.querySelector(".fixture-blocking-overlay"), "overlay probe did not mount");

  flushSync(() => document.getElementById("remove-overlay").click());
  await settle();
  await until(() => lastVisible() === true, "plugin view did not come back after the overlay closed");

  // The host's credential dialog: a plugin asks for an account while the
  // sidebar page is the surface on screen.
  const answers = () => calls.filter((call) => call.channel === IPC.invoke.pluginCredentialDialogAnswer);
  const ask = listeners.get(IPC.event.pluginCredentialDialog);
  check(typeof ask === "function", "the shell never subscribed to credential requests");
  flushSync(() => ask({ requestId: "req-1", kind: "add", pluginId: PLUGIN_ID,
    pluginName: "Mail", slotId: "account" }));
  await settle();
  check(answers().length === 0, "the dialog answered before the user did");
  check(isBlockingOverlayActive(), "the credential dialog did not register as a blocking overlay");
  const field = document.querySelector(".plugin-credential-dialog input");
  check(field, "the credential form rendered no field");
  check(document.activeElement === field,
    "the first field did not take focus, focus=" + (document.activeElement?.tagName ?? "none") +
    "." + (document.activeElement?.className ?? ""));
  check(lastVisible() === false, "the plugin view stayed above the credential dialog");

  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await settle();
  check(answers().length === 1, "Escape did not answer the dialog");
  check(answers()[0].payload.answer.action === "cancel",
    "Escape answered " + JSON.stringify(answers()[0].payload.answer) + " instead of cancel");
  check(!document.querySelector(".plugin-credential-dialog"), "Escape left the dialog on screen");
  check(!isBlockingOverlayActive(), "the overlay registration survived the dialog");
  await until(() => lastVisible() === true, "the plugin view did not come back after the dialog closed");

  // The notification popover is portaled and fixed, so it can cover a view too.
  const bell = document.querySelector(".footer-notification");
  check(bell, "the notification trigger did not render");
  flushSync(() => bell.click());
  await settle();
  check(document.querySelector("#notification-popover"), "the notification popover did not open");
  check(isBlockingOverlayActive(), "the notification popover did not register as a blocking overlay");
  check(lastVisible() === false, "the plugin view stayed above the notification popover");

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle();
  check(!document.querySelector("#notification-popover"), "Escape left the notification popover open");
  check(!isBlockingOverlayActive(), "the notification registration survived the popover close");
  await until(() => lastVisible() === true, "the plugin view did not come back after the popover closed");

  // The token a mail-like plugin names has to draw an envelope, not a letter tile.
  check(typeof pluginViewIcon("mail") === "function", "the mail token has no icon in this build");
  check(closedViews === 0, "the page closed itself while it still had a view");

  flushSync(() => rootNode.unmount());
  return { passed: true };
};
`;

test("plugin view hides under renderer overlays, restores, and answers the credential dialog", {
  timeout: 120_000,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-plugin-view-occlusion-"));
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
    await writeFile(join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 820,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("PLUGIN_VIEW_OCCLUSION " + JSON.stringify(await win.webContents.executeJavaScript("window.pluginViewOcclusionProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith("PLUGIN_VIEW_OCCLUSION "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("PLUGIN_VIEW_OCCLUSION ".length)), { passed: true });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});