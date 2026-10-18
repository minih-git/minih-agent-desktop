import type { RacpEventEnvelope, RacpSession, RacpSessionSnapshot } from "@minih-agent/shared";
import { describe, expect, it } from "vitest";

import { createInitialTimelineState, timelineReducer, type TimelineState } from "./timeline.js";

let counter = 0;

function event(
  kind: RacpEventEnvelope["kind"],
  payload: unknown = {},
  overrides: Partial<RacpEventEnvelope> = {},
): RacpEventEnvelope {
  counter += 1;
  return {
    eventId: `e${counter}`,
    scope: "session",
    sessionId: "s1",
    epoch: "ep",
    sequence: counter,
    revision: counter,
    kind,
    occurredAt: "2026-09-18T10:00:00.000Z",
    payload,
    ...overrides,
  };
}

/** Ephemeral kinds carry `afterSequence` and no `sequence` (§5.3). */
function ephemeral(kind: RacpEventEnvelope["kind"], payload: unknown): RacpEventEnvelope {
  counter += 1;
  return {
    eventId: `eph${counter}`,
    scope: "session",
    sessionId: "s1",
    epoch: "ep",
    afterSequence: 0,
    revision: 0,
    kind,
    occurredAt: "2026-09-18T10:00:00.000Z",
    payload,
  };
}

function apply(state: TimelineState, ...envelopes: RacpEventEnvelope[]): TimelineState {
  return envelopes.reduce((acc, envelope) => timelineReducer(acc, { type: "event", envelope }), state);
}

function session(overrides: Partial<RacpSession> = {}): RacpSession {
  return {
    id: "s1",
    title: "Session",
    mode: "agent",
    status: "running",
    planningState: "inactive",
    permissionMode: "ask",
    queuedTurnIds: [],
    revision: 1,
    createdAt: "2026-09-18T09:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

function message(id: string, role: "user" | "assistant", content: string, thinking?: string) {
  return { id, role, content, createdAt: "2026-09-18T10:00:00.000Z", ...(thinking ? { thinking } : {}) };
}

function snapshot(overrides: Partial<RacpSessionSnapshot> = {}): RacpSessionSnapshot {
  return {
    session: session(),
    queuedTurns: [],
    items: [],
    activeItems: [],
    pendingApprovals: [],
    pendingInputs: [],
    hasMoreHistory: false,
    cursor: { epoch: "ep", sequence: 4 },
    revision: 4,
    generatedAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

function attach(state: TimelineState, snapshotValue: RacpSessionSnapshot, replayComplete = true): TimelineState {
  return timelineReducer(state, {
    type: "attach",
    session: snapshotValue.session,
    snapshot: snapshotValue,
    replayComplete,
  });
}

describe("timeline attach", () => {
  it("applies the snapshot items, active items, pending cards and cursor", () => {
    const state = attach(
      createInitialTimelineState(),
      snapshot({
        items: [{ id: "m1", turnId: "t1", itemType: "message", status: "completed", createdAt: "", content: message("m1", "user", "hi") }],
        activeItems: [
          { id: "m2", turnId: "t1", itemType: "message", status: "streaming", createdAt: "", content: message("m2", "assistant", "partial") },
        ],
        pendingApprovals: [
          { id: "a1", sessionId: "s1", turnId: "t1", kind: "tool", summary: "run ls", expiresAt: "", revision: 1, allowedDecisions: ["allow-once", "deny"] },
        ],
        pendingInputs: [
          { id: "i1", sessionId: "s1", turnId: "t1", expiresAt: "", questions: [{ id: "q1", question: "Which?", options: ["A"], multiSelect: false }] },
        ],
        activeTurn: { id: "t1", sessionId: "s1", status: "waiting_approval", admission: "reject_if_busy", effectivePermissionMode: "ask" },
      }),
    );

    expect(state.items.map((item) => [item.id, item.text])).toEqual([
      ["m1", "hi"],
      ["m2", "partial"],
    ]);
    expect(state.activeTurnId).toBe("t1");
    expect(state.activeTurnStatus).toBe("waiting_approval");
    expect(state.pendingApprovals.map((entry) => entry.id)).toEqual(["a1"]);
    expect(state.pendingInputs.map((entry) => entry.id)).toEqual(["i1"]);
    expect(state.epoch).toBe("ep");
    expect(state.lastSequence).toBe(4);
    expect(state.needsResync).toBe(false);
  });

  it("records an incomplete replay without asking for a second resync", () => {
    const state = timelineReducer(createInitialTimelineState(), {
      type: "attach",
      session: session(),
      snapshot: snapshot(),
      replayComplete: false,
      resyncReason: "evicted",
    });
    expect(state.replayIncomplete).toBe("evicted");
    expect(state.needsResync).toBe(false);
  });

  it("resets everything on reset", () => {
    const state = attach(createInitialTimelineState(), snapshot());
    expect(timelineReducer(state, { type: "reset" })).toEqual(createInitialTimelineState());
  });
});

describe("timeline items", () => {
  it("streams a message through started, delta and completed", () => {
    let state = createInitialTimelineState();
    state = apply(
      state,
      event("item.started", { itemType: "message", itemId: "m1", event: { type: "message_start", message: message("m1", "assistant", "") } }, { turnId: "t1" }),
      ephemeral("item.delta", { itemType: "message", itemId: "m1", event: { type: "message_update", stream: "delta", message: message("m1", "assistant", ""), deltaText: "Hel" } }),
      ephemeral("item.delta", { itemType: "message", itemId: "m1", event: { type: "message_update", stream: "delta", message: message("m1", "assistant", ""), deltaThinking: "hmm" } }),
      event("item.completed", { itemType: "message", itemId: "m1", event: { type: "message_end", message: message("m1", "assistant", "Hello", "hmm") } }, { turnId: "t1" }),
    );

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ id: "m1", text: "Hello", thinking: "hmm", status: "completed", turnId: "t1" });
  });

  it("applies a delta-only update onto an existing item", () => {
    let state = createInitialTimelineState();
    state = apply(
      state,
      event("item.started", { itemType: "message", itemId: "m1", event: { type: "message_start", message: message("m1", "assistant", "Hello") } }),
      ephemeral("item.delta", { itemType: "message", itemId: "m1", event: { type: "message_update", stream: "delta", message: message("m1", "assistant", ""), deltaText: " world" } }),
    );
    expect(state.items[0]!.text).toBe("Hello world");
  });

  it("keeps tool args and the final result on one row", () => {
    let state = createInitialTimelineState();
    state = apply(
      state,
      event("item.started", { itemType: "tool", itemId: "t1", event: { type: "tool_start", toolCallId: "t1", toolName: "Read", args: { path: "/tmp" } } }),
      event("item.completed", { itemType: "tool", itemId: "t1", event: { type: "tool_end", toolCallId: "t1", result: { ok: true }, isError: false } }),
    );
    expect(state.items[0]).toMatchObject({ toolName: "Read", text: '{"ok":true}', status: "completed" });
    expect(state.items[0]!.isError).toBeUndefined();
  });

  it("marks a failed tool row", () => {
    const state = apply(
      createInitialTimelineState(),
      event("item.completed", { itemType: "tool", itemId: "t1", event: { type: "tool_end", toolCallId: "t1", result: "boom", isError: true } }),
    );
    expect(state.items[0]!.isError).toBe(true);
  });

  it("shows a compaction row", () => {
    let state = createInitialTimelineState();
    state = apply(
      state,
      event("item.started", { itemType: "compaction", itemId: "c1", event: { type: "compaction_start", reason: "auto" } }),
      event("item.completed", { itemType: "compaction", itemId: "c1", event: { type: "compaction_end", reason: "auto", ok: true, willRetry: false } }),
    );
    expect(state.items[0]).toMatchObject({ itemType: "compaction", text: "auto", status: "completed" });
  });

  it("replaces the optimistic user row with the durable one", () => {
    let state = createInitialTimelineState();
    state = apply(
      state,
      event("item.started", { itemType: "message", itemId: "optimistic", event: { type: "message_start", message: message("optimistic", "user", "hi") } }),
      event("item.completed", {
        itemType: "message",
        itemId: "u1",
        event: { type: "user_message_persisted", optimisticMessageId: "optimistic", message: message("u1", "user", "hi") },
      }),
    );
    expect(state.items.map((item) => item.id)).toEqual(["u1"]);
  });

  it("renders a bounded preview for a truncated payload", () => {
    const state = apply(
      createInitialTimelineState(),
      event("item.completed", { truncated: true, itemType: "message", itemId: "m1", event: { type: "message_end" }, preview: "0123456789" }),
    );
    expect(state.items[0]).toMatchObject({ id: "m1", text: "0123456789", truncated: true, status: "completed" });
  });

  it("keeps subagent provenance from the envelope", () => {
    const state = apply(
      createInitialTimelineState(),
      event(
        "item.started",
        { itemType: "message", itemId: "m1", event: { type: "message_start", message: message("m1", "assistant", "delegated") } },
        { agentName: "explorer" },
      ),
    );
    expect(state.items[0]!.agentName).toBe("explorer");
  });
});

describe("timeline dedupe and resync", () => {
  it("ignores a replayed event with the same id", () => {
    const started = event("item.started", { itemType: "message", itemId: "m1", event: { type: "message_start", message: message("m1", "assistant", "once") } });
    const once = apply(createInitialTimelineState(), started);
    const twice = apply(once, started);
    expect(twice.items).toEqual(once.items);
    expect(twice.seenEventIds).toEqual(once.seenEventIds);
  });

  it("ignores a durable event at or below the applied cursor", () => {
    const first = event("item.started", { itemType: "message", itemId: "m1", event: { type: "message_start", message: message("m1", "assistant", "a") } });
    const state = apply(createInitialTimelineState(), first);
    const stale = event(
      "item.started",
      { itemType: "message", itemId: "m2", event: { type: "message_start", message: message("m2", "assistant", "b") } },
      { sequence: first.sequence, epoch: "ep" },
    );
    expect(apply(state, stale).items).toHaveLength(1);
  });

  it("raises needsResync on a sequence gap but still applies the event", () => {
    const first = event("item.started", { itemType: "message", itemId: "m1", event: { type: "message_start", message: message("m1", "assistant", "a") } });
    const state = apply(createInitialTimelineState(), first);
    const jumped = event(
      "item.started",
      { itemType: "message", itemId: "m2", event: { type: "message_start", message: message("m2", "assistant", "b") } },
      { sequence: first.sequence! + 3 },
    );
    const next = apply(state, jumped);
    expect(next.needsResync).toBe(true);
    expect(next.items).toHaveLength(2);
    expect(next.lastSequence).toBe(jumped.sequence);
  });

  it("raises needsResync when the epoch changes", () => {
    const first = event("turn.started", {});
    const state = apply(createInitialTimelineState(), first);
    const newEpoch = event("turn.started", {}, { epoch: "ep2", sequence: 1 });
    const next = apply(state, newEpoch);
    expect(next.needsResync).toBe(true);
    expect(next.epoch).toBe("ep2");
  });

  it("clears needsResync when a fresh snapshot is attached", () => {
    const state = apply(createInitialTimelineState(), event("resync.required", {}));
    expect(state.needsResync).toBe(true);
    expect(attach(state, snapshot()).needsResync).toBe(false);
  });

  it("keeps the dedupe memory across a re-attach", () => {
    const started = event("item.started", { itemType: "message", itemId: "m1", event: { type: "message_start", message: message("m1", "assistant", "once") } });
    const state = attach(apply(createInitialTimelineState(), started), snapshot());
    expect(apply(state, started).items).toEqual(state.items);
  });

  it("does not move the cursor on an ephemeral event", () => {
    const durable = event("item.started", { itemType: "message", itemId: "m1", event: { type: "message_start", message: message("m1", "assistant", "") } });
    const state = apply(createInitialTimelineState(), durable);
    const next = apply(state, ephemeral("item.delta", { itemType: "message", itemId: "m1", event: { type: "message_update", stream: "delta", message: message("m1", "assistant", ""), deltaText: "x" } }));
    expect(next.lastSequence).toBe(state.lastSequence);
    expect(next.needsResync).toBe(false);
  });

  it("ignores a kind it does not render", () => {
    const state = apply(createInitialTimelineState(), event("tool.progress", { itemType: "tool", itemId: "t1", event: { type: "tool_update", toolCallId: "t1" } }));
    expect(state.items).toEqual([]);
  });
});

describe("timeline turns, approvals and inputs", () => {
  it("tracks the queued and running turns", () => {
    let state = createInitialTimelineState();
    state = apply(
      state,
      event("turn.queued", { turn: { id: "t1", sessionId: "s1", status: "queued", admission: "queue", effectivePermissionMode: "ask" } }, { turnId: "t1" }),
    );
    expect(state.queuedTurnIds).toEqual(["t1"]);
    expect(state.activeTurnStatus).toBe("queued");

    state = apply(state, event("turn.started", {}, { turnId: "t1" }));
    expect(state.activeTurnId).toBe("t1");
    expect(state.activeTurnStatus).toBe("running");
    expect(state.queuedTurnIds).toEqual([]);

    state = apply(state, event("turn.completed", {}, { turnId: "t1" }));
    expect(state.activeTurnId).toBeUndefined();
    expect(state.activeTurnStatus).toBe("completed");
  });

  it("does not relabel the running turn when a queued turn closes", () => {
    let state = createInitialTimelineState();
    state = apply(
      state,
      event("turn.started", {}, { turnId: "t1" }),
      event("turn.queued", { turn: { id: "t2", sessionId: "s1", status: "queued", admission: "queue", effectivePermissionMode: "ask" } }, { turnId: "t2" }),
      event("turn.canceled", {}, { turnId: "t2" }),
    );
    expect(state.activeTurnId).toBe("t1");
    expect(state.activeTurnStatus).toBe("running");
    expect(state.queuedTurnIds).toEqual([]);
  });

  it("records a failed turn with its reason and drops its cards", () => {
    let state = createInitialTimelineState();
    state = apply(
      state,
      event("turn.started", {}, { turnId: "t1" }),
      event(
        "approval.requested",
        { id: "a1", sessionId: "s1", turnId: "t1", kind: "tool", summary: "run ls", expiresAt: "", revision: 1, allowedDecisions: ["allow-once", "deny"] },
        { turnId: "t1" },
      ),
      event(
        "turn.failed",
        { event: { type: "error", error: { code: "AGENT_UNAVAILABLE", message: "the host went away" } } },
        { turnId: "t1" },
      ),
    );

    expect(state.activeTurnStatus).toBe("failed");
    expect(state.lastFailure).toEqual({ kind: "turn.failed", turnId: "t1", code: "AGENT_UNAVAILABLE", message: "the host went away" });
    expect(state.pendingApprovals).toEqual([]);
  });

  it("adds and removes approval and input cards", () => {
    let state = createInitialTimelineState();
    const approval = { id: "a1", sessionId: "s1", turnId: "t1", kind: "tool", summary: "run ls", expiresAt: "", revision: 1, allowedDecisions: ["allow-once", "deny"] };
    const input = { id: "i1", sessionId: "s1", turnId: "t1", expiresAt: "", questions: [{ id: "q1", question: "Which?", options: ["A", "B"], multiSelect: true }] };
    state = apply(state, event("approval.requested", approval, { turnId: "t1" }), event("input.requested", input, { turnId: "t1" }));
    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingInputs).toHaveLength(1);

    state = apply(
      state,
      event("approval.requested", approval, { turnId: "t1" }),
      event("approval.resolved", { approvalId: "a1", status: "resolved", alreadyResolved: false, revision: 2 }, { turnId: "t1" }),
      event("input.resolved", { inputId: "i1", status: "resolved" }, { turnId: "t1" }),
    );
    expect(state.pendingApprovals).toEqual([]);
    expect(state.pendingInputs).toEqual([]);
  });

  it("ignores a malformed approval or input payload", () => {
    const state = apply(createInitialTimelineState(), event("approval.requested", { summary: "no id" }), event("input.requested", { id: "i1" }));
    expect(state.pendingApprovals).toEqual([]);
    expect(state.pendingInputs).toEqual([]);
  });

  it("refreshes the session header from every session.changed shape", () => {
    let state = attach(createInitialTimelineState(), snapshot());
    state = apply(state, event("session.changed", { sessionId: "s1", status: "waiting_permission", planningState: "awaiting_approval" }));
    expect(state.session?.status).toBe("waiting_permission");
    expect(state.session?.planningState).toBe("awaiting_approval");

    state = apply(state, event("session.changed", { event: { type: "planning_state", state: "planning" } }));
    expect(state.session?.planningState).toBe("planning");

    state = apply(state, event("session.changed", { session: session({ title: "renamed" }) }));
    expect(state.session?.title).toBe("renamed");
  });

  it("ignores a session.changed for another session", () => {
    const state = attach(createInitialTimelineState(), snapshot());
    const next = apply(state, event("session.changed", { sessionId: "other", status: "idle" }));
    expect(next.session?.status).toBe("running");
  });

  it("marks an archived session", () => {
    const state = attach(createInitialTimelineState(), snapshot());
    expect(apply(state, event("session.archived", { session: session() })).archived).toBe(true);
  });
});
