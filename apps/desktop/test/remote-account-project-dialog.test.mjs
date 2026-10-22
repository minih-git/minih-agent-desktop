/**
 * New project on an account computer — the user path (rollout R8 package E,
 * layer 2).
 *
 * The real dialog is bundled and rendered in Electron against a fake IPC bridge
 * and the English catalogs. What this pins is the part no unit test can: that
 * picking "Account computer", browsing a folder on that machine, and pressing
 * create sends `project/register` → `session/create` → the local project group
 * **in that order**, and that the SSH source still sends only the project group
 * — the local-Agent-with-remote-tools flow this release does not touch.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";
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
import { ProjectCreateDialog } from "../../apps/desktop/src/components/ProjectCreateDialog";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { remoteEn } from "../../apps/desktop/src/locales/remote";
import "../../apps/desktop/src/styles/project-create-dialog.css";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en), remote: remoteEn } },
  interpolation: { escapeValue: false } });

const calls = [];
const unexpectedCalls = [];
const group = { id: "g1", name: "app", primaryPath: "remote-project:g1",
  roots: [{ id: "r1", path: "remote-project:g1", position: 0 }],
  createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z", pinned: false, lastOpenedAt: 1 };
const hosts = [
  { hostKey: "account-host_b", label: "Studio Mac", url: "wss://gateway.example.com/v1/hosts/host_b/ws",
    status: "connected", connected: true, transport: "account",
    capabilities: { remoteHostProfile: true, workspaceRead: true, workspaceFiles: false, workspaceTools: false } },
  { hostKey: "account-host_c", label: "Old Laptop", url: "wss://gateway.example.com/v1/hosts/host_c/ws",
    status: "connected", connected: true, transport: "account",
    capabilities: { remoteHostProfile: true, workspaceRead: true, workspaceFiles: false, workspaceTools: false },
    needsUpgrade: { reason: "HOST_MISSING_CAPABILITIES", missing: ["workspaceRead"] } },
  { hostKey: "account-host_d", label: "Sleeping Mac", url: "wss://gateway.example.com/v1/hosts/host_d/ws",
    status: "disconnected", connected: false, transport: "account" },
  { hostKey: "ssh:studio", label: "Build Server", url: "ws://127.0.0.1:9/racp",
    status: "connected", connected: true, transport: "ssh" },
];

window.minihAgent = { platform: "darwin", channels: IPC, on() { return () => {}; },
  async invoke(channel, input) {
    calls.push({ channel, input });
    const data = await (async () => { switch (channel) {
      case IPC.invoke.remoteHostList: return { hosts };
      case IPC.invoke.remoteHostBrowseProjects:
        return { path: input.path ?? "/Users/b", parent: "/Users",
          entries: [{ name: "app", path: (input.path ?? "/Users/b") + "/app" }] };
      case IPC.invoke.remoteHostRegisterProject:
        return { project: { id: "42", label: "app", path: "/Users/b/app" } };
      case IPC.invoke.remoteHostCreateSession:
        return { session: { id: "remote:account-host_b:s1", projectId: input.projectId, title: "Chat" } };
      case IPC.invoke.projectGroupCreateRemote: return { group: { ...group, name: input.name } };
      // The store lists sessions after creating so the new row is selectable; the
      // fake answers with the one the sibling reported.
      case IPC.invoke.sessionList: return { sessions: [{ id: "remote:account-host_b:s1", source: "remote", remoteHostKey: "account-host_b", remoteProjectId: "42", title: "Chat", updatedAt: "2026-10-21T00:00:00Z" }] };
      case IPC.invoke.projectSet: return { workspace: { path: input, name: group.name, remote: { hostKey: "ssh:studio", path: "/srv/app" } } };
      case IPC.invoke.appGetOnboarding: return { completed: true };
      default: unexpectedCalls.push(channel); throw new Error("Unexpected IPC: " + channel);
    } })();
    return { ok: true, data };
  }
};

const view = createRoot(document.getElementById("root"));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }
async function until(predicate, message) {
  for (let n = 0; n < 160; n++) { if (predicate()) return; await frame(); }
  throw new Error(message + " body=" + document.body.textContent + " calls=" + JSON.stringify(calls.map((c) => c.channel)));
}
const button = (label, scope = document) => [...scope.querySelectorAll("button")].find((node) => node.textContent.trim() === label);
function choose(node, value) {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function input(node, value) {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const picker = () => document.querySelector(".remote-folder-dialog");
const channels = () => calls.map((entry) => entry.channel);

window.accountProjectProbe = async () => {
  // Session selection pulls in the whole transcript pipeline, which this test is
  // not about: record the id the dialog asked for instead.
  const selections = [];
  useAppStore.setState({
    sessions: [], workspace: null, activeProjectPath: undefined, page: "chat",
    selectSession: async (id) => { selections.push(id); },
  });
  flushSync(() => view.render(React.createElement(ProjectCreateDialog)));
  useAppStore.getState().openProject();
  await until(() => document.querySelector(".project-create-dialog"), "new project dialog did not open");

  // Both remote shapes are offered, and the dialog says who runs the Agent.
  check(button("Account computer"), "account computer source missing");
  check(button("SSH host"), "ssh host source missing");
  check(document.querySelector('[data-agent-location="local"]')?.textContent.includes("runs on this computer"),
    "local source did not state that the Agent runs here");

  button("Account computer").click();
  await until(() => document.querySelector(".remote-project-picker select"), "account picker missing");
  const select = document.querySelector(".remote-project-picker select");
  // Prefilled with the first computer that can actually be used: an offline or
  // outdated machine is never the default.
  check(select.value === "account-host_b", "account picker did not preselect a usable computer, got " + select.value);
  check([...select.options].map((option) => option.value).join(",") === "account-host_b,account-host_c,account-host_d",
    "account picker listed the wrong computers: " + [...select.options].map((option) => option.textContent).join(" | "));
  check(![...select.options].some((option) => option.value === "ssh:studio"), "SSH host leaked into the account computer list");
  check(document.querySelector('[data-agent-location="remote-computer"]')?.textContent.includes("runs on that computer"),
    "account source did not state that the Agent runs there");

  // A computer that cannot be used explains why instead of vanishing.
  choose(select, "account-host_d");
  await until(() => document.querySelector("[data-account-computer-blocked]"), "offline computer gave no reason");
  check(document.querySelector("[data-account-computer-blocked]").textContent.includes("offline"), "offline reason missing");
  check(document.querySelector('button[type="submit"]').disabled, "create stayed enabled for an offline computer");
  choose(select, "account-host_c");
  await until(() => document.querySelector("[data-account-computer-blocked]")?.textContent.includes("update"), "outdated computer gave no reason");
  check(document.querySelector('button[type="submit"]').disabled, "create stayed enabled for an outdated computer");
  check(!calls.some((entry) => entry.channel === IPC.invoke.remoteHostRegisterProject), "an unusable computer still registered a project");

  choose(select, "account-host_b");
  await settle();
  check(!document.querySelector("[data-account-computer-blocked]"), "usable computer still showed a reason");

  // Browse that machine's folders: the folder becomes a project there.
  button("Browse folders").click();
  await until(() => picker()?.querySelector(".remote-project-browser-path")?.textContent === "/Users/b", "folder dialog did not open");
  picker().querySelector('[aria-label="Open app"]').click();
  await until(() => picker()?.querySelector(".remote-project-browser-path")?.textContent === "/Users/b/app", "directory navigation failed");
  button("Use this folder", picker()).click();
  await until(() => !picker(), "choosing a folder did not close the dialog");
  await settle();
  check(document.querySelector(".remote-project-picker input").value === "/Users/b/app", "chosen folder not retained");

  const beforeCreate = calls.length;
  const form = document.querySelector(".project-create-dialog form");
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await until(() => selections.length === 1, "creating on the account computer did not select a session");
  const created = calls.slice(beforeCreate).map((entry) => entry.channel);
  // Register on the sibling, then open a session there. No local project group:
  // the project belongs to that computer, and recording a local group would make
  // this desktop run a local Agent with tools over there — the SSH shape.
  check(created[0] === IPC.invoke.remoteHostRegisterProject, "project was not registered on the sibling first: " + created.join(","));
  check(created[1] === IPC.invoke.remoteHostCreateSession, "session was not created on the sibling: " + created.join(","));
  check(!created.includes(IPC.invoke.projectGroupCreateRemote), "an account project recorded a local project group: " + created.join(","));
  const register = calls.find((entry) => entry.channel === IPC.invoke.remoteHostRegisterProject);
  check(register.input.hostKey === "account-host_b" && register.input.path === "/Users/b/app", "registered the wrong folder");
  const session = calls.find((entry) => entry.channel === IPC.invoke.remoteHostCreateSession);
  check(session.input.projectId === "42", "session was created for the wrong project");
  check(selections[0] === "remote:account-host_b:s1", "opened the wrong session: " + selections[0]);
  await until(() => !document.querySelector(".project-create-dialog"), "dialog stayed open after creating");

  // The SSH source is untouched: it still only records the local project group.
  const sshBefore = calls.length;
  useAppStore.getState().openProject();
  await until(() => document.querySelector(".project-create-dialog"), "dialog did not reopen");
  button("SSH host").click();
  await until(() => document.querySelector(".remote-project-picker select"), "ssh picker missing");
  const sshSelect = document.querySelector(".remote-project-picker select");
  check(sshSelect.value === "ssh:studio", "ssh picker did not preselect the ssh host, got " + sshSelect.value);
  check(![...sshSelect.options].some((option) => option.value.startsWith("account-")),
    "account computer leaked into the ssh host list");
  input(document.querySelector(".remote-project-picker input"), "/srv/app");
  await settle();
  check(document.querySelector('[data-agent-location="local-with-remote-tools"]')?.textContent.includes("tools on the remote host"),
    "ssh source did not state that the Agent runs here");
  document.querySelector(".project-create-dialog form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await until(() => calls.slice(sshBefore).some((entry) => entry.channel === IPC.invoke.projectGroupCreateRemote), "ssh project was not created");
  const sshChannels = calls.slice(sshBefore).map((entry) => entry.channel);
  check(!sshChannels.includes(IPC.invoke.remoteHostRegisterProject), "ssh flow registered a remote project: " + sshChannels.join(","));
  check(!sshChannels.includes(IPC.invoke.remoteHostCreateSession), "ssh flow created a remote session: " + sshChannels.join(","));

  flushSync(() => view.unmount());
  check(unexpectedCalls.length === 0, "unexpected IPC calls: " + unexpectedCalls.join(", "));
  return { passed: true };
};
`;

test("new project on an account computer registers, opens a session there, and keeps ssh unchanged", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.account-project-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      plugins: [{ name: "vite-url-assets", setup(plugin) {
        plugin.onResolve({ filter: /\?url$/ }, ({ path }) => ({ path, namespace: "url-asset" }));
        plugin.onLoad({ filter: /.*/, namespace: "url-asset" }, () => ({ contents: 'export default "fixture-asset";', loader: "js" }));
      } }],
      loader: { ".css": "empty", ".png": "dataurl", ".gif": "dataurl" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
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
    await writeFile(join(temp, "renderer.css"), (await loadStyles()).replace(/@theme(?: inline)?\s*\{/g, ":root {"));
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 420, height: 780,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (...args) => console.log("RENDERER", (args[0].message ?? args[2] ?? "").slice(0, 500)));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("ACCOUNT_PROJECT_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.accountProjectProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("ACCOUNT_PROJECT_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("ACCOUNT_PROJECT_PROBE ".length)), { passed: true });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
