import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  ROUTE_LOCAL,
  createBackendRouter,
  createDeleteOnlyOfflineBackend,
  makeRemoteSessionId,
  parseRemoteSessionId,
  isRemoteSessionId,
  sessionIdForCall,
} = await import("../electron/main/remote/backend-router.ts");

test("namespaces and parses remote session ids", () => {
  const id = makeRemoteSessionId("hostA", "sess_1");
  assert.equal(id, "remote:hostA:sess_1");
  assert.ok(isRemoteSessionId(id));
  assert.ok(!isRemoteSessionId("sess_1"));
  assert.ok(!isRemoteSessionId("native-pi:codex:abc"));
  assert.deepEqual(parseRemoteSessionId(id), { hostKey: "hostA", hostSessionId: "sess_1" });
  // A host session id may itself contain ':'; only the first separator splits.
  assert.deepEqual(parseRemoteSessionId("remote:hostA:a:b"), {
    hostKey: "hostA",
    hostSessionId: "a:b",
  });
  assert.equal(parseRemoteSessionId("remote:onlyhost"), null);
  assert.equal(parseRemoteSessionId("desktop-session"), null);
});

test("rejects a hostKey containing the separator", () => {
  assert.throws(() => makeRemoteSessionId("host:bad", "s"), /hostKey must not contain/);
});

test("sessionIdForCall reads positional and object session ids", () => {
  const remote = makeRemoteSessionId("h", "s");
  assert.equal(sessionIdForCall([remote]), remote);
  assert.equal(sessionIdForCall([{ sessionId: remote }]), remote);
  assert.equal(sessionIdForCall(["local-session"]), null);
  assert.equal(sessionIdForCall([{ sessionId: "local-session" }]), null);
  assert.equal(sessionIdForCall([]), null);
  assert.equal(sessionIdForCall([42]), null);
});

test("remote routing fails closed before registration and after disconnect", async () => {
  const router = createBackendRouter();
  const remote = makeRemoteSessionId("h", "s");
  await assert.rejects(router.route("session.get", [{ sessionId: remote }]), { errorCode: "AGENT_UNAVAILABLE" });

  const calls = [];
  router.registerBackend(remote, {
    handles: (channel) => channel === "session.get",
    invoke: async (channel, args) => {
      calls.push([channel, args]);
      return { id: remote, source: "remote" };
    },
  });

  const outcome = await router.route("session.get", [{ sessionId: remote }]);
  assert.notEqual(outcome, ROUTE_LOCAL);
  assert.deepEqual(outcome, { remote: true, value: { id: remote, source: "remote" } });
  assert.equal(calls.length, 1);

  // Unsupported remote channels must never reach a local side effect.
  await assert.rejects(router.route("settings.get", [{ sessionId: remote }]), { errorCode: "CAPABILITY_UNAVAILABLE" });
  // A local session id is never routed even after a remote backend exists.
  assert.equal(await router.route("session.get", [{ sessionId: "local" }]), ROUTE_LOCAL);

  router.unregisterBackend(remote);
  await assert.rejects(router.route("session.get", [{ sessionId: remote }]), { errorCode: "AGENT_UNAVAILABLE" });
});

test("route surfaces a backend failure to the caller", async () => {
  const router = createBackendRouter();
  const remote = makeRemoteSessionId("h", "s");
  router.registerBackend(remote, {
    handles: () => true,
    invoke: async () => {
      throw Object.assign(new Error("host gone"), { errorCode: "HOST_DISCONNECTED" });
    },
  });
  await assert.rejects(() => router.route("session.get", [remote]), /host gone/);
});

test("malformed remote identifiers cannot fall through to local handlers", async () => {
  const router = createBackendRouter();
  await assert.rejects(router.route("files/read", [{ sessionId: "remote:broken", path: "/private/data" }]), {
    errorCode: "INVALID_ARGUMENT",
  });
});

const SESSION_DELETE = "minih-agent-desktop/session/delete";

test("an offline fallback answers only the channels it claims", async () => {
  const asked = [];
  const router = createBackendRouter({
    offline: {
      handles: (channel) => channel === SESSION_DELETE,
      invoke: async (channel, sessionId, args) => {
        asked.push({ channel, sessionId, args });
        return { ok: true };
      },
    },
  });
  const remote = makeRemoteSessionId("h", "s");

  // A session whose Host is offline has no backend. Deleting it used to fail
  // with "remote session is disconnected", so the row could never leave.
  assert.deepEqual(await router.route(SESSION_DELETE, [remote]), { remote: true, value: { ok: true } });
  assert.deepEqual(asked, [{ channel: SESSION_DELETE, sessionId: remote, args: [remote] }]);

  // Everything that must reach the Host still fails: nothing local can answer it.
  await assert.rejects(router.route("session:get", [{ sessionId: remote }]), {
    errorCode: "AGENT_UNAVAILABLE",
  });
});

test("the delete-only seam refuses until the session directory is bound", async () => {
  const remote = makeRemoteSessionId("h", "s");

  // Boot creates the router before the directory that answers a delete exists.
  // Until the handler is bound the seam must refuse, exactly as the router did
  // before the seam existed — never report a delete nobody performed.
  const unbound = createBackendRouter({ offline: createDeleteOnlyOfflineBackend(SESSION_DELETE, null) });
  await assert.rejects(unbound.route(SESSION_DELETE, [remote]), { errorCode: "AGENT_UNAVAILABLE" });
  await assert.rejects(unbound.route("session:get", [{ sessionId: remote }]), {
    errorCode: "AGENT_UNAVAILABLE",
  });

  const asked = [];
  const bound = createBackendRouter({
    offline: createDeleteOnlyOfflineBackend(SESSION_DELETE, async (sessionId) => {
      asked.push(sessionId);
      return { ok: true };
    }),
  });
  assert.deepEqual(await bound.route(SESSION_DELETE, [remote]), { remote: true, value: { ok: true } });
  assert.deepEqual(asked, [remote]);
});
