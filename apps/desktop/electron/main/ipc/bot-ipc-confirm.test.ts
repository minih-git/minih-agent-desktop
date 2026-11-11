import { describe, expect, it, vi } from "vitest";

import { createSessionCollaborationService } from "../services/session-collaboration";
import { registerBotIpc } from "./bot-ipc";

/**
 * The person's click, end to end inside Main.
 *
 * `taskCardConfirm` is the only path in the product that confirms a card, and
 * confirming used to write the delivery and stop there: the card said
 * "dispatched" while the ledger row sat `queued` forever. This drives the real
 * handler through the real service and asserts the workspace actually starts.
 *
 * The host is a stub that behaves like the Rust side where it matters here:
 * confirming writes a queued row, and claiming it for a turn stamps `turn_id`
 * and leaves `queued`. Nothing talks to a model.
 */

type Row = {
  id: string;
  status: string;
  turnId?: string;
  kind: string;
  targetSessionId: string;
  pluginId: string;
  content: string;
};

function ledgerHost(options: { startTurnError?: unknown } = {}) {
  let row: Row = {
    id: "delivery-1",
    status: "queued",
    kind: "task",
    targetSessionId: "router-backend",
    pluginId: "minih-agent-desktop",
    content: "查一下 router 项目进度",
  };
  const startTurn = vi.fn(async () => {
    if (options.startTurnError) throw options.startTurnError;
    // What the host does once a turn exists for this delivery.
    row = { ...row, status: "running", turnId: "turn-1" };
    return { turn: { id: "turn-1", status: "running" } };
  });
  const call = vi.fn(async (method: string) => {
    switch (method) {
      case "taskCard.confirm":
        return {
          draft: {
            id: "draft-1",
            sessionId: "steward-session",
            status: "confirmed",
            card: {
              goal: "查一下 router 项目进度",
              criteria: [],
              boundaries: [],
              permissionMode: "ask",
              mustAsk: [],
              risk: "low",
            },
            cardHash: "a".repeat(64),
            sourceUtterance: "你帮我查查 router 项目现在进度如何了",
            targetSessionId: "router-backend",
            createdAt: "2026-11-10T09:00:00.000Z",
            updatedAt: "2026-11-10T09:00:00.000Z",
          },
          delivery: { ...row },
        };
      case "session.collaboration.message":
        return { message: { ...row } };
      default:
        return {};
    }
  });
  return { call, startTurn, row: () => row };
}

function harness(host: ReturnType<typeof ledgerHost>) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  // `registerBotIpc` asks the process whether the host is usable before calling it.
  const hostIdentity = { call: host.call, isAvailable: () => true } as never;
  const bridge = {
    agentHost: { startTurn: host.startTurn },
    queue: { list: () => [], prioritize: vi.fn(async () => undefined) },
  } as never;
  const sidecar = {} as never;
  const sessionCollaboration = createSessionCollaborationService({
    getHost: () => hostIdentity,
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
  const events: Array<{ channel: string; payload: unknown }> = [];
  registerBotIpc({
    registrar: {
      ipcMain: {} as never,
      handle: (channel, handler) => handlers.set(channel, handler),
      handleWithEvent: (channel, handler) => handlers.set(channel, handler as never),
      assertMainWindowSender: () => undefined,
    },
    getHost: () => hostIdentity,
    sendToRenderer: (channel, payload) => events.push({ channel, payload }),
    sessionCollaboration,
  });
  return { handlers, events };
}

describe("clicking start on a card", () => {
  it("starts a turn in the employee session and stamps the delivery", async () => {
    const host = ledgerHost();
    const { handlers, events } = harness(host);
    const confirm = handlers.get("minih-agent-desktop/taskCard/confirm");
    expect(confirm).toBeTypeOf("function");

    await confirm!({ draftId: "draft-1", cardHash: "a".repeat(64) });

    // The delivery left `queued` and now names its turn: that is what "the task
    // is actually running" means in the ledger.
    expect(host.startTurn).toHaveBeenCalledTimes(1);
    expect(host.row()).toMatchObject({ status: "running", turnId: "turn-1" });
    // The dock still hears about the click through the one shared channel.
    expect(events.some((event) => event.channel === "minih-agent-desktop/taskCard/event/changed")).toBe(true);
  });

  it("keeps the confirmation when the start fails, and says why", async () => {
    const host = ledgerHost({
      startTurnError: Object.assign(new Error("session already has an active turn"), {
        errorCode: "AGENT_BUSY",
      }),
    });
    const { handlers } = harness(host);
    const confirm = handlers.get("minih-agent-desktop/taskCard/confirm");

    const result = (await confirm!({ draftId: "draft-1", cardHash: "a".repeat(64) })) as {
      draft?: { status?: string };
      startError?: string;
    };

    // The person's decision stands; the card reports the start failure instead of
    // pretending nothing happened or silently retrying.
    expect(result.draft?.status).toBe("confirmed");
    expect(result.startError).toContain("active turn");
    expect(host.row().status).toBe("queued");
  });
});