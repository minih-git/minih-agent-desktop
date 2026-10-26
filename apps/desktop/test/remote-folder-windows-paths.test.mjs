import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * A Windows Host in the remote folder picker.
 *
 * The Host answers `project/browse` in its own platform's spelling. Every gate
 * on the way to the renderer used to require a leading `/`, so a Windows Host's
 * `C:\Users\me` answer was refused as malformed and the picker showed neither
 * the root nor a single directory — reported as "check the Host connection" for
 * a connection that was working. These cases pin the Windows answer as well
 * formed at each gate, and pin the malformed ones as still refused.
 *
 * Two of the three gates are main-process modules; the third is the picker's
 * own decision helper. The renderer component itself is covered by the helper,
 * not by a window: this runs without Electron.
 */

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { validateProjectBrowse } = await import("../electron/main/remote/remote-session-catalog.ts");
const { registerRemoteSessionIpc } = await import("../electron/main/ipc/remote-session-ipc.ts");
const { IPC } = await import("@minih-agent/shared");
const { canChooseRemoteFolder, canGoToRemoteFolder, initialRemoteBrowsePath, needsAbsoluteRemotePath } =
  await import("../src/lib/remote-folder-navigation.ts");

const WINDOWS_ROOT = "C:\\Users\\me";
const windowsAnswer = {
  path: WINDOWS_ROOT,
  parent: "C:\\Users",
  entries: [{ name: "Projects", path: "C:\\Users\\me\\Projects" }],
};

test("a Windows Host's browse answer is well formed", () => {
  assert.deepEqual(validateProjectBrowse(windowsAnswer), {
    path: WINDOWS_ROOT,
    parent: "C:\\Users",
    entries: [{ name: "Projects", path: "C:\\Users\\me\\Projects" }],
  });
});

test("a drive root, a UNC share and a POSIX root are all well formed", () => {
  assert.deepEqual(validateProjectBrowse({ path: "C:\\", entries: [{ name: "Users", path: "C:\\Users" }] }).entries,
    [{ name: "Users", path: "C:\\Users" }]);
  assert.deepEqual(validateProjectBrowse({ path: "\\\\server\\share", entries: [{ name: "app", path: "\\\\server\\share\\app" }] }).path,
    "\\\\server\\share");
  assert.deepEqual(validateProjectBrowse({ path: "/", entries: [{ name: "home", path: "/home" }] }).entries,
    [{ name: "home", path: "/home" }]);
});

test("a POSIX Host's answer is still accepted unchanged", () => {
  const answer = { path: "/home/me", parent: "/home", entries: [{ name: "app", path: "/home/me/app" }] };
  assert.deepEqual(validateProjectBrowse(answer), answer);
});

test("an answer this release cannot read is reported as an unreadable response, not a bad request", () => {
  const refused = (value) => assert.throws(() => validateProjectBrowse(value), (error) => {
    assert.equal(error.errorCode, "REMOTE_RESPONSE_INVALID");
    assert.doesNotMatch(error.message, /C:\\|\/home/);
    return true;
  });
  for (const value of [
    null,
    [],
    { path: "relative/dir", entries: [] },
    // A name that is a path, a parent, or a different directory entirely.
    { path: WINDOWS_ROOT, entries: [{ name: "Projects\\sub", path: "C:\\Users\\me\\Projects\\sub" }] },
    { path: WINDOWS_ROOT, entries: [{ name: "..", path: "C:\\Users\\me\\.." }] },
    { path: WINDOWS_ROOT, entries: [{ name: "Projects", path: "C:\\Users\\me2\\Projects" }] },
    { path: WINDOWS_ROOT, entries: [{ name: "Projects", path: "/home/me/Projects" }] },
    { path: "/home/me", entries: [{ name: "app", path: "/home/me/app/nested" }] },
    { path: "/home/me", parent: "relative", entries: [] },
    { path: "/home/me\u0000", entries: [] },
    { path: "/home/me", entries: "not a list" },
    { path: "/home/me", entries: Array.from({ length: 501 }, (_, index) => ({ name: `d${index}`, path: `/home/me/d${index}` })) },
  ]) {
    refused(value);
  }
});

/** The IPC registrar, reduced to the one thing this test needs from it. */
function captureRegistrar() {
  const handlers = new Map();
  return { handlers, registrar: { handle(channel, handler) { handlers.set(channel, handler); } } };
}

function captureBoot() {
  const calls = [];
  const boot = {
    browseProjects: async (hostKey, path) => { calls.push({ kind: "browse", hostKey, path }); return { path: path ?? "", entries: [] }; },
    registerProject: async (hostKey, path) => { calls.push({ kind: "register", hostKey, path }); return { id: "1", path }; },
  };
  return { calls, boot };
}

test("the browse and register handlers accept a Windows absolute path", async () => {
  const { handlers, registrar } = captureRegistrar();
  const { calls, boot } = captureBoot();
  registerRemoteSessionIpc(registrar, () => boot);

  // No path asks for the Host's browse root, so the picker can open at all.
  await handlers.get(IPC.invoke.remoteHostBrowseProjects)({ hostKey: "account-host_1" });
  await handlers.get(IPC.invoke.remoteHostBrowseProjects)({ hostKey: "account-host_1", path: WINDOWS_ROOT });
  await handlers.get(IPC.invoke.remoteHostRegisterProject)({ hostKey: "account-host_1", path: WINDOWS_ROOT });

  assert.deepEqual(calls, [
    { kind: "browse", hostKey: "account-host_1", path: undefined },
    { kind: "browse", hostKey: "account-host_1", path: WINDOWS_ROOT },
    { kind: "register", hostKey: "account-host_1", path: WINDOWS_ROOT },
  ]);
});

test("the handlers still refuse a relative path and a control character", async () => {
  const { handlers, registrar } = captureRegistrar();
  const { calls, boot } = captureBoot();
  registerRemoteSessionIpc(registrar, () => boot);

  for (const path of ["Users\\me", "~/projects", "C:relative", "\\Users", "/home/\u0000me"]) {
    for (const channel of [IPC.invoke.remoteHostBrowseProjects, IPC.invoke.remoteHostRegisterProject]) {
      await assert.rejects(handlers.get(channel)({ hostKey: "account-host_1", path }), { errorCode: "INVALID_ARGUMENT" }, path);
    }
  }
  assert.deepEqual(calls, []);
});

test("the picker browses and submits a Windows path", () => {
  // Opening the dialog: a typed Windows path is browsed as-is, anything else
  // asks the Host for its root.
  assert.equal(initialRemoteBrowsePath(WINDOWS_ROOT), WINDOWS_ROOT);
  assert.equal(initialRemoteBrowsePath("relative"), undefined);
  assert.equal(initialRemoteBrowsePath(""), undefined);

  // "Go to folder" is enabled for an absolute path in either spelling.
  assert.equal(canGoToRemoteFolder(WINDOWS_ROOT, false), true);
  assert.equal(canGoToRemoteFolder("C:/Users/me", false), true);
  assert.equal(canGoToRemoteFolder("/home/me", false), true);
  assert.equal(canGoToRemoteFolder("relative", false), false);
  assert.equal(canGoToRemoteFolder(WINDOWS_ROOT, true), false);

  // "Use this folder" submits the directory the Host listed.
  const settled = { browsing: false, failed: false };
  assert.equal(canChooseRemoteFolder({ ...settled, directoryPath: WINDOWS_ROOT, path: WINDOWS_ROOT }), true);
  assert.equal(canChooseRemoteFolder({ ...settled, directoryPath: WINDOWS_ROOT, path: "C:\\Users\\me2" }), false);
  assert.equal(canChooseRemoteFolder({ ...settled, directoryPath: WINDOWS_ROOT, path: WINDOWS_ROOT, failed: true }), false);
  assert.equal(canChooseRemoteFolder({ ...settled, directoryPath: WINDOWS_ROOT, path: WINDOWS_ROOT, browsing: true }), false);
  assert.equal(canChooseRemoteFolder({ ...settled, directoryPath: undefined, path: "" }), false);

  // The inline warning is only for something that is not a path at all.
  assert.equal(needsAbsoluteRemotePath(WINDOWS_ROOT), false);
  assert.equal(needsAbsoluteRemotePath("/home/me"), false);
  assert.equal(needsAbsoluteRemotePath("relative"), true);
  assert.equal(needsAbsoluteRemotePath(""), false);
});