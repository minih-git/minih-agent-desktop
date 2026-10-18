import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { register, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Only Electron is replaced. The quit handler, the session coordination, the
// turn finalizer and event persistence are the production implementations, so
// the assertions cover the wiring that produced a `completed` turn on quit.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron") return { url: "test:electron", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "test:electron") return {
      format: "module", shortCircuit: true,
      source: `import { EventEmitter } from "node:events";
        export const app = new EventEmitter();
        app.quit = () => {};
        export const globalShortcut = { unregister() {} };`,
    };
    return next(url, context);
  },
});
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { app } = await import("electron");
const { createEventPersistence } = await import("../electron/main/runtime/event-persistence.ts");
const { createPlanRuntime } = await import("../electron/main/runtime/plans.ts");
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");
const { PersistenceOutbox } = await import("../electron/main/persistence-outbox.ts");
const { registerShutdownHandlers } = await import("../electron/main/bootstrap/shutdown.ts");

// Three shapes of the same quit: the runtime reports the cancel, the runtime
// never reports it, and the sidecar is already gone. All three must settle the
// running turn as interrupted; none may leave it `running` or call it complete.
const scenarios = [
  {
    label: "when the runtime answers the cancel with agent_end",
    withSidecar: true,
    emitTerminalEvent: true,
  },
  {
    label: "when the runtime never reports the cancel",
    withSidecar: true,
    emitTerminalEvent: false,
  },
  {
    label: "when the sidecar is already gone",
    withSidecar: false,
    emitTerminalEvent: false,
  },
];

for (const scenario of scenarios) {
  test(`quitting interrupts a running turn ${scenario.label}`, async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-quit-interrupt-"));
    const activeTurns = new Map([["session", "turn"]]);
    const hostCalls = [];
    const host = {
      isAvailable: () => true,
      async call(method, params) {
        hostCalls.push({ method, params });
        return { ok: true };
      },
      async dispose() {},
    };
    const endpoint = { app: () => {} };
    const coordination = createSessionCoordination({
      activeTurns,
      getMainWindow: () => null,
      getViewingSessionId: () => null,
    });
    const runtimeState = { host };
    const persistenceOutbox = new PersistenceOutbox(dataDir, () => undefined);
    const inflightCheckpointer = {
      observe() {}, flush: async () => {}, flushAll: async () => {},
      settleIf() {}, dispose() {},
    };
    const planRuntime = createPlanRuntime({
      runtimeState,
      planState: { approvedExecutionDrain: null },
      logger: endpoint,
      sendToRenderer: () => {},
      coordination,
      scheduledRunsBySession: new Map(),
      activeToolCalls: new Map(),
      planSubmissionTurnIds: new Set(),
      approvedExecutionIdsBySession: new Map(),
      claimedExecutionSessions: new Map(),
      approvedExecutionTurns: new Map(),
      startedApprovedExecutions: new Set(),
      finishedApprovedExecutions: new Set(),
      dispatchingApprovedExecutions: new Set(),
      inFlightExecutionFinishes: new Set(),
      pendingExecutionFinishes: new Map(),
      announceTurnEnded: () => {},
      emitAgentEvent: () => {},
      acquireSessionOperation: async () => () => {},
      resolveAgentRuntimeLaunch: async () => ({}),
      isQuitting: () => true,
    });
    let persistence;
    const markedAborting = [];
    const reasonAtCancel = [];
    const sidecarCalls = [];
    const sidecar = scenario.withSidecar ? {
      async call(method, params) {
        sidecarCalls.push({ method, params });
        // The runtime answers a cancel with a clean `agent_end`; the recorded
        // cancellation reason is the only thing that turns it into an abort.
        reasonAtCancel.push(
          coordination.peekAbortReason(params.sessionId, params.turnId),
        );
        if (scenario.emitTerminalEvent) {
          persistence.persistAgentEvent({
            sessionId: params.sessionId,
            turnId: params.turnId,
            ts: 2,
            event: { type: "agent_end", messageIds: [] },
          });
        }
        return { ok: true };
      },
      async dispose() {},
    } : null;
    persistence = createEventPersistence({
      runtimeState,
      steeringReplies: new Set(),
      activeTurns,
      activeToolCalls: new Map(),
      activeToolCallKey: (sessionId, callId) => `${sessionId}:${callId}`,
      approvedExecutionIdsBySession: new Map(),
      approvedExecutionTurns: new Map(),
      pendingExecutionFinishes: new Map(),
      planSubmissionTurnIds: new Set(),
      planSubmissionTurnKey: (sessionId, turnId) => `${sessionId}:${turnId}`,
      inflightCheckpointer,
      persistenceOutbox,
      transcriptRewrite: {
        beginTranscriptRewrite: () => ({ commit() {}, rollback: () => [] }),
        deferTranscriptEvent: () => false,
        isStaleTranscriptEvent: () => false,
      },
      addActiveTurnUsage() {},
      logger: endpoint,
      finishTurn: planRuntime.finishTurn,
      isStaleTerminalEvent: coordination.isStaleTerminalEvent,
      finishApprovedExecution: async () => {},
      emitAgentEvent() {},
    });
    const state = {
      shutdownComplete: false, shutdownPromise: null, quitting: false,
      quitConfirmed: true, closeBehavior: "quit", tray: null,
      pluginLauncherAccelerator: null, toggleWindowAccelerator: null,
    };
    const dispose = () => undefined;
    registerShutdownHandlers({
      hasSingleInstanceLock: true,
      state,
      getHost: () => host,
      getSidecar: () => sidecar,
      getMcpControl: () => null,
      finishTurn: planRuntime.finishTurn,
      lockAbortReason: coordination.lockAbortReason,
      getAgentHostBridge: () => ({
        markAborting: (sessionId) => markedAborting.push(sessionId),
      }),
      activeTurns,
      persistenceOutbox,
      inflightCheckpointer,
      flushEventPersistence: () => persistence.flush(),
      pluginPanels: { closeAll: async () => {} },
      plugins: { disposeAll: async () => {} },
      userMcp: { disposeAll: dispose },
      browserHost: { dispose },
      pluginViews: { dispose: async () => {} },
      updater: { dispose, isInstallingUpdate: () => false },
      logger: endpoint,
      confirmQuitDialog: async () => true,
      disposePowerSaveBlockers: dispose,
    });
    t.after(async () => {
      await state.shutdownPromise;
      await persistence.flush();
      app.removeAllListeners();
    });

    app.emit("before-quit", { preventDefault() {} });
    await state.shutdownPromise;

    const ends = hostCalls.filter((call) => call.method === "session.endTurn");
    assert.equal(ends.length, 1, "one quit must settle the turn exactly once");
    assert.equal(ends[0].params.turnId, "turn");
    assert.equal(ends[0].params.status, "aborted");
    assert.equal(ends[0].params.errorCode, "TURN_ABORTED");
    assert.deepEqual(markedAborting, ["session"]);
    assert.equal(activeTurns.size, 0);
    if (scenario.withSidecar) {
      assert.deepEqual(sidecarCalls, [
        { method: "agent.abort", params: { sessionId: "session", turnId: "turn" } },
      ]);
      assert.deepEqual(reasonAtCancel, ["aborted"]);
    } else {
      assert.deepEqual(sidecarCalls, []);
      assert.deepEqual(reasonAtCancel, []);
    }
  });
}
