import assert from "node:assert/strict";
import test from "node:test";

import { UserMcpRuntime } from "../electron/main/user-mcp.ts";

/**
 * Idle release is the only thing these tests exercise: a connection per service
 * and working directory used to stay open for the life of the process, so a
 * single server could be observed running seven times at once.
 */
function serverRecord(overrides = {}) {
  return {
    id: "srv-knowledge",
    label: "Knowledge",
    transport: "stdio",
    command: "node",
    args: ["server.mjs"],
    enabled: true,
    createdAt: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}

function fakeClient(state) {
  return {
    async connect() {
      state.connects += 1;
      return [{ name: "lookup", description: "Look something up" }];
    },
    getTools() {
      return [{ name: "lookup" }];
    },
    async callTool() {
      state.calls += 1;
      return await state.callPromise?.();
    },
    isConnected() {
      return !state.closed;
    },
    close() {
      state.closes += 1;
      state.closed = true;
    },
    async ping() {},
  };
}

function buildRuntime(options = {}) {
  const state = { connects: 0, closes: 0, calls: 0, closed: false, callPromise: undefined };
  const runtime = new UserMcpRuntime({
    idleCloseMs: 1_000,
    // The sweep runs from a timer in the app; these tests drive it by hand.
    idleSweepIntervalMs: 0,
    createClient: () => fakeClient(state),
    ...options,
  });
  runtime.setRecords([serverRecord()]);
  return { runtime, state };
}

test("an idle stdio connection is closed and reconnects on the next call", async () => {
  const { runtime, state } = buildRuntime();
  const tools = await runtime.toolsForProject("/tmp/project");
  assert.equal(tools.length, 1);
  assert.equal(state.connects, 1);

  // Fresh connection: nothing to close.
  assert.deepEqual(runtime.sweepIdleConnections(Date.now()), []);

  // Past the idle window the connection goes away.
  assert.equal(runtime.sweepIdleConnections(Date.now() + 60_000).length, 1);
  assert.equal(state.closes, 1);
  assert.equal(state.closed, true);

  // The next call connects again instead of reusing a dead client.
  state.closed = false;
  await runtime.toolsForProject("/tmp/project");
  assert.equal(state.connects, 2);
  runtime.disposeAll();
});

test("a call in flight is never closed under itself", async () => {
  const { runtime, state } = buildRuntime();
  await runtime.toolsForProject("/tmp/project");

  let release;
  state.callPromise = () =>
    new Promise((resolve) => {
      release = () => resolve({ ok: true });
    });
  const call = runtime.callTool("mcp_srv_knowledge_lookup", {}, "/tmp/project");
  // `callTool` goes through the call registry, so the client is reached on a
  // later turn; wait for that instead of sleeping.
  const started = Date.now();
  while (state.calls === 0 && Date.now() - started < 1_000) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(state.calls, 1);

  // The call is pending, so the connection is busy even though it is `lastUsed`
  // long ago as far as the clock is concerned.
  assert.deepEqual(runtime.sweepIdleConnections(Date.now() + 600_000), []);
  assert.equal(state.closes, 0);
  release();
  await call;
  assert.equal(runtime.sweepIdleConnections(Date.now() + 600_000).length, 1);
  runtime.disposeAll();
});

test("a connection that is still connecting is left alone", async () => {
  let releaseConnect;
  const state = { connects: 0, closes: 0, calls: 0, closed: false };
  const runtime = new UserMcpRuntime({
    idleCloseMs: 1_000,
    idleSweepIntervalMs: 0,
    createClient: () => ({
      ...fakeClient(state),
      connect: async () => {
        state.connects += 1;
        return await new Promise((resolve) => {
          releaseConnect = () => resolve([{ name: "lookup" }]);
        });
      },
    }),
  });
  runtime.setRecords([serverRecord()]);
  const pending = runtime.toolsForProject("/tmp/project");
  assert.equal(state.connects, 1);

  assert.deepEqual(runtime.sweepIdleConnections(Date.now() + 600_000), []);
  assert.equal(state.closes, 0);

  releaseConnect();
  await pending;
  runtime.disposeAll();
});

test("disposing the runtime closes every connection and stops the sweep", async () => {
  const { runtime, state } = buildRuntime();
  await runtime.toolsForProject("/tmp/project");
  runtime.disposeAll();
  assert.equal(state.closes, 1);
  // Nothing is left to sweep afterwards.
  assert.deepEqual(runtime.sweepIdleConnections(Date.now() + 600_000), []);
});