import { describe, expect, it, vi } from "vitest";

import { createSessionCollaborationService } from "./session-collaboration";

/**
 * What happens after a card is confirmed.
 *
 * Confirming writes the ledger row inside the host's transaction and starts
 * nothing. A delivery therefore only runs because something calls `dispatch`
 * afterwards — an ordinary send does that itself, and a confirmed card did not,
 * which is how a real task sat `queued` forever while the person watched a card
 * that said "dispatched".
 */

type Row = {
  id: string;
  status: string;
  kind: string;
  targetSessionId: string;
  pluginId: string;
  content: string;
  turnId?: string;
};

const delivery = (overrides: Partial<Row> = {}): Row => ({
  id: "delivery-1",
  status: "queued",
  kind: "task",
  targetSessionId: "worker-session",
  pluginId: "minih-agent-desktop",
  content: "查询 router 进度",
  ...overrides,
});

/**
 * A host that holds one ledger row and records every call. `startTurn` is the
 * only thing that starts work, so counting it is counting dispatches.
 */
function harness(options: {
  row?: Row;
  startTurnError?: unknown;
  failCall?: (method: string, params: Record<string, unknown>) => unknown;
} = {}) {
  let row = options.row ?? delivery();
  const startTurn = vi.fn(async () => {
    if (options.startTurnError) throw options.startTurnError;
    // The real host claims the row for the turn it started, so a second dispatch
    // sees a row that is no longer queued.
    row = { ...row, status: "running", turnId: "turn-1" };
    return { turn: { id: "turn-1", status: "running" } };
  });
  const failCall = vi.fn(options.failCall ?? (async () => ({ ok: true })));
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    switch (method) {
      case "session.collaboration.message":
        return { message: { ...row } };
      case "session.collaboration.fail":
        row = { ...row, status: "failed" };
        return failCall(method, params);
      default:
        return {};
    }
  });
  // One stable identity per dependency: `checkCurrent` retires an operation whose
  // host was replaced mid-flight, so a fresh object per call would look like a
  // restart and fail every dispatch.
  const host = { call } as never;
  const sidecar = {} as never;
  const bridge = {
    agentHost: { startTurn },
    queue: { list: () => [], prioritize: vi.fn(async () => undefined) },
  } as never;
  const service = createSessionCollaborationService({
    getHost: () => host,
    getSidecar: () => sidecar,
    getBridge: () => bridge,
    getActiveTurn: () => undefined,
    flushTranscript: async () => true,
    isPluginLoaded: () => true,
    isQuitting: () => false,
    onChanged: () => undefined,
    log: () => undefined,
    hostId: () => "mac-mini",
  });
  return { service, startTurn, failCall, call, row: () => row };
}

const message = (row: Row) => ({ ...row }) as never;

describe("a confirmed card starts exactly one turn", () => {
  it("starts the delivery once, even when the confirmation is retried", async () => {
    const { service, startTurn } = harness();
    const row = delivery();

    await service.dispatchConfirmed(message(row));
    await service.dispatchConfirmed(message(row));

    // `dispatching` is keyed by message id and the row is no longer queued, so a
    // retried click cannot run the same work twice.
    expect(startTurn).toHaveBeenCalledTimes(1);
  });
});

describe("a delivery that cannot start", () => {
  it("stays queued when the runtime is not available yet", async () => {
    const { service, failCall } = harness({
      startTurnError: Object.assign(new Error("The Agent runtime is unavailable"), {
        errorCode: "HOST_UNAVAILABLE",
      }),
    });

    await expect(service.dispatchConfirmed(message(delivery()))).rejects.toBeTruthy();
    // This one can succeed on the next drain, so the row must stay queued
    // instead of being closed as a failure.
    expect(failCall).not.toHaveBeenCalled();
  });

  it("is closed as failed when the target refuses the work permanently", async () => {
    const { service, failCall, row } = harness({
      startTurnError: Object.assign(new Error("PERMISSION_DENIED: ceiling"), {
        errorCode: "PERMISSION_DENIED",
      }),
    });

    await expect(service.dispatchConfirmed(message(delivery()))).rejects.toBeTruthy();
    // Retrying a refusal forever would only flood the log; the steward is told
    // instead through the host's existing failure callback.
    expect(failCall).toHaveBeenCalledTimes(1);
    expect(row().status).toBe("failed");
  });
});
