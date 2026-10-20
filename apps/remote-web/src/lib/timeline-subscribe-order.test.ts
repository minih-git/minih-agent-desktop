/**
 * Nothing is lost between the snapshot and the stream (rollout D).
 *
 * The client used to fire `session/attach` and open the event stream at the same
 * time, and the first stream carried no `Last-Event-ID`. An event that arrived
 * before the attach result was therefore applied to an empty state and marked as
 * seen; the snapshot that followed then replaced the items without it, and
 * because the event id was already remembered it was never applied again. If
 * that event happened to be the last one of the turn, the screen stayed on
 * "running" with the final reply missing.
 *
 * The contract these cases pin (protocol §5.4: "a snapshot is valid only
 * together with its `cursor`"): the snapshot is applied first, the stream is
 * then opened *at the snapshot's cursor*, and the Host replays everything after
 * it — so an early event is dropped rather than remembered, and the replay is
 * what applies it.
 */
import { describe, expect, it } from "vitest";

import type { RacpEventEnvelope, RacpSession, RacpSessionSnapshot } from "@minih-agent/shared";

import { createInitialTimelineState, timelineReducer, type TimelineState } from "./timeline.js";

const session: RacpSession = {
  id: "s1",
  title: "t",
  mode: "agent",
  status: "running",
  planningState: "inactive",
  permissionMode: "ask",
  queuedTurnIds: [],
  revision: 1,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
};

/** A snapshot whose cursor is *behind* the early event, as a real one is. */
function snapshot(cursorSequence: number, items: RacpSessionSnapshot["items"] = []): RacpSessionSnapshot {
  return {
    session,
    items,
    activeItems: [],
    queuedTurns: [],
    pendingApprovals: [],
    pendingInputs: [],
    hasMoreHistory: false,
    cursor: { epoch: "e1", sequence: cursorSequence },
    revision: 1,
    generatedAt: "2026-10-20T00:00:00.000Z",
  };
}

function messageEnd(sequence: number, eventId: string): RacpEventEnvelope {
  return {
    eventId,
    kind: "item.completed",
    epoch: "e1",
    sequence,
    turnId: "turn_1",
    payload: {
      itemId: "msg_final",
      itemType: "message",
      event: {
        type: "message_end",
        message: { id: "msg_final", role: "assistant", content: "the final reply", createdAt: "2026-10-20T00:00:00.000Z" },
      },
    },
  } as RacpEventEnvelope;
}

describe("attach and the event stream", () => {
  it("keeps an event that arrived before the snapshot, through the replay", () => {
    // 1. The event arrives while `session/attach` is still in flight.
    let state: TimelineState = timelineReducer(createInitialTimelineState(), {
      type: "event",
      envelope: messageEnd(5, "evt_5"),
    });

    // 2. The snapshot lands; its cursor is at 4, so it cannot contain event 5.
    state = timelineReducer(state, { type: "attach", session, snapshot: snapshot(4) });
    expect(state.items).toEqual([]);
    // The event must not be remembered as applied: it was never applied.
    expect(state.seenEventIds).not.toContain("evt_5");

    // 3. The stream opens at the snapshot cursor and the Host replays event 5.
    state = timelineReducer(state, { type: "event", envelope: messageEnd(5, "evt_5") });

    expect(state.items.map((item) => item.id)).toEqual(["msg_final"]);
    expect(state.items[0]?.text).toBe("the final reply");
    expect(state.needsResync).toBe(false);
  });

  it("does not raise a resync for a normal open", () => {
    // Snapshot at 4, then the events that follow it in order.
    let state = timelineReducer(createInitialTimelineState(), { type: "attach", session, snapshot: snapshot(4) });
    state = timelineReducer(state, { type: "event", envelope: messageEnd(5, "evt_5") });
    state = timelineReducer(state, {
      type: "event",
      envelope: { eventId: "evt_6", kind: "turn.completed", epoch: "e1", sequence: 6, turnId: "turn_1", payload: {} } as RacpEventEnvelope,
    });

    expect(state.needsResync).toBe(false);
    expect(state.activeTurnStatus).toBe("completed");
  });

  it("still applies an ephemeral event before the snapshot", () => {
    // Ephemeral events carry no sequence and are not replayed, so dropping them
    // would lose them outright; they are applied and deduped by id.
    const state = timelineReducer(createInitialTimelineState(), {
      type: "event",
      envelope: {
        eventId: "evt_delta",
        kind: "item.delta",
        epoch: "e1",
        payload: {
          itemId: "m2",
          itemType: "message",
          event: {
            type: "message_update",
            stream: "delta",
            message: { id: "m2", role: "assistant", content: "", createdAt: "" },
            deltaText: "hi",
          },
        },
      } as RacpEventEnvelope,
    });

    expect(state.seenEventIds).toContain("evt_delta");
  });
});
