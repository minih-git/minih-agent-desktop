/**
 * A reference outside every allowed root is not readable, but it is still
 * something a reader may want to find.
 *
 * `fs/revealChatRef` exists for that and nothing else: it resolves the path,
 * confirms the entry exists, and shows it in the system file manager. It never
 * opens, reads, or lists anything, and it is local-only. These tests register the
 * real handler with stubbed Electron primitives, so the contract under test is
 * the host call each case makes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
// Only `electron` is stubbed; the handler under test is production code.
register(new URL("./helpers/shell-record-stub-hook.mjs", import.meta.url));

const { IPC } = await import("@minih-agent/shared");
const { registerWorkspaceIpc } = await import("../electron/main/ipc/workspace-ipc.ts");
const { resetShellCalls, shellCalls } = await import("./helpers/shell-record-electron-stub.mjs");

const tempDirs = [];
test.afterEach(() => {
  resetShellCalls();
});
test.after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A host that answers the two questions the remote check asks: which path the
 * session (or workspace) is bound to, and whether that path is a remote group.
 */
function fakeHost({ remote = false } = {}) {
  return {
    binaryPath: "/fake/host-core",
    async call(method) {
      if (method === "session.get") {
        return { session: { projectPath: remote ? "remote-project:/srv/app" : "/local/app" } };
      }
      if (method === "workspace.get") {
        return { workspace: { path: remote ? "remote-project:/srv/app" : "/local/app" } };
      }
      if (method === "project.groups.list") {
        return {
          groups: remote
            ? [{ primaryPath: "remote-project:/srv/app", remote: { hostKey: "host", path: "/srv/app" } }]
            : [],
        };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

/** Register the real workspace IPC against a captured handler map. */
async function handlers({ remote = false } = {}) {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-ref-outside-")));
  tempDirs.push(dataDir);
  const workspace = join(dataDir, "project");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "inside.ts"), "inside\n");
  const outsideFile = join(dataDir, "outside.txt");
  writeFileSync(outsideFile, "outside\n");
  const outsideFolder = join(dataDir, "outside-folder");
  mkdirSync(outsideFolder);

  const map = new Map();
  // One instance for the whole registration: the module compares the host it
  // captured against the one it sees later, so a factory would look replaced.
  const host = fakeHost({ remote });
  registerWorkspaceIpc({
    registrar: {
      handle: (channel, handler) => map.set(channel, handler),
      handleWithEvent: (channel, handler) => map.set(channel, handler),
    },
    getMainWindow: () => null,
    getHost: () => host,
    getSidecar: () => null,
    dataDir,
    isDevelopmentBuild: false,
    plugins: () => [],
    browserHost: () => null,
    clipboardHistory: () => null,
    recordPastedClipboardFiles: () => {},
    currentWorkspacePath: () => workspace,
    setCurrentWorkspacePath: () => {},
    withGitBranch: (value) => value,
    stripWinLongPrefix: (value) => value,
  });
  return { map, workspace, outsideFile, outsideFolder, dataDir };
}

test("reveal is local-only: a remote session is refused", async () => {
  const { map, outsideFolder } = await handlers({ remote: true });
  const reveal = map.get(IPC.invoke.fsRevealChatRef);
  assert.equal(typeof reveal, "function");
  await assert.rejects(
    reveal({ path: outsideFolder, sessionId: "remote:host:session" }),
    /remote references cannot be revealed/,
  );
  assert.deepEqual(shellCalls, []);
});

test("reveal refuses a relative path and a path that does not exist", async () => {
  const { map, dataDir } = await handlers();
  const reveal = map.get(IPC.invoke.fsRevealChatRef);
  await assert.rejects(reveal({ path: "outside.txt" }), /absolute path/);
  await assert.rejects(reveal({ path: join(dataDir, "missing") }), /no entry at that path/);
  assert.deepEqual(shellCalls, []);
});

test("a file and a folder outside the roots are only ever shown", async () => {
  const { map, outsideFile, outsideFolder } = await handlers();
  const reveal = map.get(IPC.invoke.fsRevealChatRef);
  assert.deepEqual(await reveal({ path: outsideFile }), { ok: true });
  assert.deepEqual(await reveal({ path: outsideFolder }), { ok: true });
  // Two reveals and nothing else: no open, no read, no listing.
  assert.deepEqual(shellCalls, [
    ["showItemInFolder", outsideFile],
    ["showItemInFolder", outsideFolder],
  ]);
});

/* ---------- a resolution that reports the entry without reading it ---------- */

test("resolveRef reports an outside folder and file, and nothing for a missing path", async () => {
  const { map, outsideFile, outsideFolder, dataDir } = await handlers();
  const resolve = map.get(IPC.invoke.fsResolveRef);
  for (const [path, entryKind] of [[outsideFile, "file"], [outsideFolder, "directory"]]) {
    const result = await resolve({ ref: path });
    // It is not a match: nothing may open or read it. It is an observation.
    assert.equal(result.match, null, path);
    assert.equal(result.reason, "outside-allowed-roots", path);
    assert.deepEqual(result.outside, { absolutePath: realpathSync(path), entryKind });
  }
  const missing = await resolve({ ref: join(dataDir, "missing") });
  assert.equal(missing.match, null);
  assert.equal(missing.outside, undefined);
  // Probing existence is a stat: the file manager is never asked anything.
  assert.deepEqual(shellCalls, []);
});
