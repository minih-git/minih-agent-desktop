/**
 * A rename that lands in host-core must be announced to the RACP Host.
 *
 * The desktop's sidebar refreshes from `sessionsChanged`, so the local window
 * looked right while a phone holding the same session kept the old task name.
 * The phone has nothing to poll for a title: it refreshes its header from a
 * `session.changed` event, which the RACP operations publish themselves and the
 * IPC handlers here did not.
 */
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import { IPC, IPC_WHITELIST } from "../../../packages/shared/src/protocol.ts";
import { modelWireIdsEqual } from "../../../packages/shared/src/types/models.ts";
import { imageGenerationBindings, isImageGenerationModel } from "../../../packages/shared/src/image-generation.ts";

function load(relative, imports, globals = {}) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", ...Object.keys(globals), outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected IPC dependency: ${id}`);
    return imports[id];
  }, module.exports, module, ...Object.values(globals));
  return module.exports;
}

const shared = {
  ErrorCodes,
  IPC,
  IPC_WHITELIST,
  modelWireIdsEqual,
  imageGenerationBindings,
  isImageGenerationModel,
};

const collaboration = load("../electron/main/services/session-collaboration.ts", {
  "node:crypto": crypto,
  "@minih-agent/shared": shared,
  "../agent-host-bridge": {},
  "../plugin-agent-complete": {},
});
const { registerSessionIpc } = load("../electron/main/ipc/session-ipc.ts", {
  electron: { shell: {} },
  "node:fs": fs,
  "node:path": path,
  "@minih-agent/shared": shared,
  "../importers": {},
  "../services/session-collaboration": collaboration,
  "../bootstrap/remote-hosts.js": { getActiveRemoteHostsBoot: () => null },
  "../services/session-search": { searchSessionsAcrossSources: async () => ({ hits: [], nextOffset: null }) },
});

function harness(answer = async () => ({ ok: true })) {
  const handlers = new Map();
  const calls = [];
  const announced = [];
  const host = {
    call: async (method, input) => {
      calls.push({ method, input });
      return answer(method, input);
    },
  };
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => null,
    dataDir: "/tmp/pi-session-ipc-test",
    activeTurns: new Map(),
    sessionProjects: new Map(),
    persistenceOutbox: { dropSession: () => undefined },
    logger: { app: () => undefined },
    plugins: { broadcastEvent: () => undefined },
    sessionCapabilityContext: async () => ({ providers: {}, defaults: {} }),
    enrichSession: (session) => session,
    acquireSessionOperation: async () => () => undefined,
    beginTranscriptRewrite: () => ({ commit: () => undefined, rollback: () => undefined }),
    forgetTranscriptRewriteHistory: () => undefined,
    stripWinLongPrefix: (value) => value,
    announceTitleChange: (sessionId) => announced.push(sessionId),
  });
  return { handlers, calls, announced };
}

test("a rename announces the new title to the RACP Host", async () => {
  const { handlers, calls, announced } = harness(async () => ({ ok: true }));
  const handle = handlers.get(IPC.invoke.sessionRename);
  assert.equal(typeof handle, "function");
  assert.deepEqual(await handle("s1", "Renamed by the desktop"), { ok: true });
  assert.deepEqual(calls, [{ method: "session.rename", input: { id: "s1", title: "Renamed by the desktop" } }]);
  assert.deepEqual(announced, ["s1"]);
});

test("a derived title is announced only when the Host actually updated it", async () => {
  const updated = harness(async () => ({ updated: true }));
  await updated.handlers.get(IPC.invoke.sessionDeriveTitle)("s1", "Derived");
  assert.deepEqual(updated.announced, ["s1"]);

  // The Host owns eligibility: a session the user renamed keeps its name, and
  // announcing that would tell every client to re-read an unchanged title.
  const refused = harness(async () => ({ updated: false }));
  await refused.handlers.get(IPC.invoke.sessionDeriveTitle)("s2", "Derived");
  assert.deepEqual(refused.announced, []);
});

test("a failed rename announces nothing", async () => {
  const { handlers, announced } = harness(async () => {
    throw new Error("host refused");
  });
  await assert.rejects(handlers.get(IPC.invoke.sessionRename)("s1", "Renamed"));
  assert.deepEqual(announced, []);
});
