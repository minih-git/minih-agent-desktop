import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { IPC } from "../../../packages/shared/src/protocol.ts";
const source = fs.readFileSync(new URL("../electron/main/ipc/session-ipc.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const imports = {
  electron: { shell: {} }, "node:fs": fs, "node:path": path,
  "@minih-agent/shared": { IPC }, "../importers": {},
  "../services/session-collaboration": {}, "../services/session-search": {},
  "../bootstrap/remote-hosts.js": { getActiveRemoteHostsBoot: () => null },
};
const loaded = { exports: {} };
new Function("require", "exports", "module", outputText)((id) => {
  assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
  return imports[id];
}, loaded.exports, loaded);

test("session list snapshots live running IDs after its asynchronous reads settle", async () => {
  const handlers = new Map(); const activeTurns = new Map([["completed-during-read", "old-turn"]]);
  const response = Promise.withResolvers();
  const host = { call: async (method) => {
    if (method === "projects.list") return { projects: [] };
    assert.equal(method, "session.list"); return response.promise;
  } };
  loaded.exports.registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) }, getHost: () => host,
    getSidecar: () => null, activeTurns,
    sessionCapabilityContext: async () => ({ providers: [], defaults: {} }), enrichSession: (session) => session,
  });
  const pending = handlers.get(IPC.invoke.sessionList)();
  activeTurns.delete("completed-during-read"); activeTurns.set("still-running", "current-turn");
  response.resolve({ sessions: [{ id: "still-running", updatedAt: "2026-10-27T00:00:00Z" }] });
  const result = await pending;
  assert.deepEqual(result.runningSessionIds, ["still-running"]);
  activeTurns.clear();
  assert.deepEqual(result.runningSessionIds, ["still-running"], "returned IDs must be a detached snapshot");
});
