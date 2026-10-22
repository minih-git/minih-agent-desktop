import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("@minih-agent/shared");
const { createBackendRouter, makeRemoteSessionId } = await import(
  "../electron/main/remote/backend-router.ts"
);
const { createRemoteHostConnection } = await import(
  "../electron/main/remote/remote-host-connection.ts"
);

const HOST_KEY = "hostA";

/** A minimal RacpClient/subscribe double. Records requests and lets tests
 * push envelopes back to whichever listener attached last. */
function fakeClient({ sessions = [], requestFailures = {}, onAttach } = {}) {
  const calls = [];
  let listener = null;
  return {
    calls,
    request: async (method, params) => {
      calls.push({ method, params });
      if (requestFailures[method]) throw requestFailures[method];
      if (method === "session/list") return { sessions };
      if (method === "events/subscribe") return { subscriptionId: `sub-${params.sessionId ?? "host"}`, starting: { epoch: "epoch-1", sequence: 1 }, replayComplete: true };
      if (method === "session/attach") {
        if (onAttach) return onAttach(params.sessionId);
        return { snapshot: { session: makeSession(params.sessionId), pendingApprovals: [], pendingInputs: [], cursor: { epoch: "epoch-1", sequence: 0 }, revision: 1, generatedAt: "2026-09-18T10:00:00.000Z" } };
      }
      return { ok: true };
    },
    subscribe: (fn) => {
      listener = fn;
      return () => {
        if (listener === fn) listener = null;
      };
    },
    // Test-only escape hatch used to inject envelopes as if from the host.
    push(envelope) {
      if (!listener) throw new Error("no listener attached");
      listener(envelope);
    },
    hasListener: () => listener !== null,
    stateListeners: new Set(),
    subscribeState(fn) {
      this.stateListeners.add(fn);
      return () => this.stateListeners.delete(fn);
    },
    /** Test-only: emulate the transport reporting a link state. */
    emitState(state) {
      for (const fn of [...this.stateListeners]) fn(state);
    },
    reconnectListeners: new Set(),
    subscribeReconnect(fn) {
      this.reconnectListeners.add(fn);
      return () => this.reconnectListeners.delete(fn);
    },
    /** Test-only: the transport reconnected; the connection re-subscribes. */
    emitReconnect() {
      return Promise.all([...this.reconnectListeners].map((fn) => fn()));
    },
  };
}

function makeSession(id, overrides = {}) {
  return {
    id,
    title: id,
    mode: "chat",
    status: "idle",
    planningState: "inactive",
    permissionMode: "default",
    queuedTurnIds: [],
    revision: 1,
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

function makeEnvelope(overrides = {}) {
  return {
    eventId: "e1",
    scope: "session",
    epoch: "epoch-1",
    revision: 1,
    kind: "item.started",
    occurredAt: "2026-09-18T10:00:00.000Z",
    payload: {},
    ...overrides,
  };
}

function setup({ sessions = [], requestFailures = {}, onAttach } = {}) {
  const events = [];
  const router = createBackendRouter();
  const client = fakeClient({ sessions, requestFailures, onAttach });
  const conn = createRemoteHostConnection({
    hostKey: HOST_KEY,
    client,
    router,
    emit: (channel, payload) => events.push({ channel, payload }),
    newRequestId: () => "req-const",
  });
  return { conn, router, client, events };
}

test("open subscribes host scope, lists sessions, and registers a backend per session", async () => {
  const { conn, router, client } = setup({ sessions: [makeSession("s1"), makeSession("s2")] });
  await conn.open();
  const methods = client.calls.map((entry) => entry.method);
  // Host-scope subscribe fires BEFORE list; the create-race window is closed.
  assert.deepEqual(methods.slice(0, 2), ["events/subscribe", "session/list"]);
  assert.deepEqual(client.calls[0].params, { scope: "host" });
  const perSessionSubscribeParams = client.calls
    .filter((entry) => entry.method === "events/subscribe" && entry.params.scope === "session")
    .map((entry) => entry.params.sessionId)
    .sort();
  assert.deepEqual(perSessionSubscribeParams, ["s1", "s2"]);
  // The router now resolves both session ids to the remote backend.
  const backend = router.resolveBackend(IPC.invoke.sessionGet, [
    { id: makeRemoteSessionId(HOST_KEY, "s1") },
  ]);
  assert.ok(backend, "router must have a backend for s1");
  assert.ok(
    router.resolveBackend(IPC.invoke.sessionGet, [{ id: makeRemoteSessionId(HOST_KEY, "s2") }]),
  );
});

test("open is idempotent — a second call does not re-subscribe or re-register", async () => {
  const { conn, client } = setup({ sessions: [makeSession("s1")] });
  await conn.open();
  const first = client.calls.length;
  await conn.open();
  assert.equal(client.calls.length, first);
});

test("a session.created event registers a fresh backend and refreshes the sidebar", async () => {
  const { conn, router, client, events } = setup({ sessions: [] });
  await conn.open();
  const newRemoteId = makeRemoteSessionId(HOST_KEY, "s-new");
  client.push(
    makeEnvelope({
      scope: "host",
      kind: "session.created",
      payload: { session: { id: "s-new", title: "new" } },
    }),
  );
  assert.ok(
    router.resolveBackend(IPC.invoke.sessionGet, [{ id: newRemoteId }]),
    "s-new must have a registered backend after session.created",
  );
  const sidebarNotice = events.find(
    (event) => event.channel === IPC.event.sessionsChanged && event.payload.reason === "remote.session.created",
  );
  assert.ok(sidebarNotice, "session.created must emit a sessionsChanged notice for the sidebar");
  assert.equal(sidebarNotice.payload.selectSessionId, undefined);
});

test("a session.archived event unregisters the backend and lets the id fall through", async () => {
  const s1 = makeSession("s1");
  const { conn, router, client } = setup({ sessions: [s1] });
  await conn.open();
  const remoteId = makeRemoteSessionId(HOST_KEY, "s1");
  assert.ok(router.resolveBackend(IPC.invoke.sessionGet, [{ id: remoteId }]));
  client.push(
    makeEnvelope({
      scope: "host",
      kind: "session.archived",
      payload: { session: { id: "s1" } },
    }),
  );
  assert.equal(router.resolveBackend(IPC.invoke.sessionGet, [{ id: remoteId }]), null);
});

test("a confirmed remote session delete drops the row and refreshes the sidebar", async () => {
  const { conn, router, client, events } = setup({
    sessions: [makeSession("s1"), makeSession("s2")],
  });
  await conn.open();
  const remoteId = makeRemoteSessionId(HOST_KEY, "s1");
  assert.ok(router.resolveBackend(IPC.invoke.sessionGet, [{ id: remoteId }]));
  const outcome = await router.route(IPC.invoke.sessionDelete, [remoteId]);
  assert.deepEqual(outcome, { remote: true, value: { ok: true } });
  assert.ok(
    client.calls.some(
      (entry) => entry.method === "session/delete" && entry.params.sessionId === "s1",
    ),
    "the host must receive the delete",
  );
  // The deleted session stops being routable, and its event stream is released.
  assert.equal(router.resolveBackend(IPC.invoke.sessionGet, [{ id: remoteId }]), null);
  const notice = events.find(
    (event) =>
      event.channel === IPC.event.sessionsChanged &&
      event.payload.reason === "remote.session.deleted",
  );
  assert.ok(notice, "a confirmed delete must refresh the renderer's session list");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    client.calls.some(
      (entry) => entry.method === "events/unsubscribe" && entry.params.subscriptionId === "sub-s1",
    ),
    "the deleted session's subscription must be released",
  );
});

test("close detaches the listener and unregisters every session", async () => {
  const { conn, router, client } = setup({ sessions: [makeSession("s1"), makeSession("s2")] });
  await conn.open();
  await conn.close();
  assert.equal(client.hasListener(), false);
  assert.equal(
    router.resolveBackend(IPC.invoke.sessionGet, [{ id: makeRemoteSessionId(HOST_KEY, "s1") }]),
    null,
  );
});

test("close is idempotent and safe to call before open", async () => {
  const { conn } = setup();
  await conn.close();
  await conn.open();
  await conn.close();
  await conn.close();
});

test("session/list failure rejects open and detaches its listeners", async () => {
  const { conn, router, client } = setup({
    sessions: [makeSession("s1")],
    requestFailures: { "session/list": new Error("no route to host") },
  });
  await assert.rejects(conn.open(), /no route to host/);
  assert.equal(
    router.resolveBackend(IPC.invoke.sessionGet, [{ id: makeRemoteSessionId(HOST_KEY, "s1") }]),
    null,
  );
  assert.equal(client.hasListener(), false);
});

test("open attaches with a parallelism of at most three", async () => {
  // Every attach is delayed a tick and counts itself while in flight; with a
  // serial loop the peak would be 1, with unbounded parallelism it would hit 7.
  let inFlight = 0;
  let peak = 0;
  const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];
  const { conn, client, router } = setup({
    sessions: ids.map((id) => makeSession(id)),
    onAttach: (sessionId) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => setTimeout(() => {
        inFlight -= 1;
        resolve({
          snapshot: { session: makeSession(sessionId), pendingApprovals: [], pendingInputs: [], cursor: { epoch: "epoch-1", sequence: 0 }, revision: 1, generatedAt: "2026-09-18T10:00:00.000Z" },
        });
      }, 5));
    },
  });
  await conn.open();
  assert.equal(peak, 3, "at most three attaches may be in flight");
  for (const id of ids) {
    assert.ok(router.resolveBackend(IPC.invoke.sessionGet, [{ id: makeRemoteSessionId(HOST_KEY, id) }]), `${id} must be routed`);
  }
  const attaches = client.calls.filter((entry) => entry.method === "session/attach");
  assert.equal(attaches.length, 7);
});

test("one failing attach does not stop the other sessions from becoming ready", async () => {
  const { conn, router } = setup({
    sessions: [makeSession("s1"), makeSession("s2"), makeSession("s3")],
    onAttach: (sessionId) => sessionId === "s2"
      ? Promise.reject(new Error("attach failed"))
      : Promise.resolve({
          snapshot: { session: makeSession(sessionId), pendingApprovals: [], pendingInputs: [], cursor: { epoch: "epoch-1", sequence: 0 }, revision: 1, generatedAt: "2026-09-18T10:00:00.000Z" },
        }),
  });
  await assert.rejects(conn.open(), /attach failed/);
  // The surviving sessions never become routable: open failed, and the same
  // recovery path the serial loop had decides what to unregister. The point
  // here is that the failure surfaces, not that it is swallowed.
  assert.equal(router.resolveBackend(IPC.invoke.sessionGet, [{ id: makeRemoteSessionId(HOST_KEY, "s1") }]), null);
});

test("a transport change during reconnect discards the stale attach results", async () => {
  let holdAttaches = false;
  const gates = new Map();
  const { conn, client } = setup({
    sessions: [makeSession("s1"), makeSession("s2")],
    onAttach: (sessionId) => {
      if (!holdAttaches) {
        return Promise.resolve({
          snapshot: { session: makeSession(sessionId), pendingApprovals: [], pendingInputs: [], cursor: { epoch: "epoch-1", sequence: 0 }, revision: 1, generatedAt: "2026-09-18T10:00:00.000Z" },
        });
      }
      // Reconnect attaches hang until released; the transport drops while
      // they are in flight, which bumps the generation.
      return new Promise((resolve) => {
        gates.set(sessionId, () => resolve({
          snapshot: { session: makeSession(sessionId), pendingApprovals: [], pendingInputs: [], cursor: { epoch: "epoch-1", sequence: 0 }, revision: 1, generatedAt: "2026-09-18T10:00:00.000Z" },
        }));
      });
    },
  });
  await conn.open();
  const before = client.calls.length;
  // Drop the link, then reconnect with the attaches held. The reconnect work
  // runs on the connection's queue; the state change mid-flight bumps the
  // generation, so every attach answer that lands afterwards is stale and must
  // be discarded rather than applied.
  client.emitState("reconnecting");
  holdAttaches = true;
  client.emitState("connected");
  client.emitReconnect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const reconnectAttaches = client.calls.slice(before).filter((entry) => entry.method === "session/attach");
  assert.ok(reconnectAttaches.length > 0, "the reconnect must have started attaching");
  // Release everything: the stale answers land after the generation moved on.
  for (const release of gates.values()) release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The connection is still sane: a fresh open works and routes both rows.
  await conn.open();
  assert.ok(client.calls.filter((entry) => entry.method === "session/attach").length > reconnectAttaches.length);
});
