/**
 * Session timeline reducer (PR-4).
 *
 * Pure and framework-free so the whole event contract is unit-testable: the
 * screen dispatches `attach` (the `session/attach` result) and then one `event`
 * per SSE envelope, and this module decides what the transcript shows.
 *
 * Contract notes (protocol spec §5.3–§5.5):
 *   - durable events carry `sequence` and are deduped by `(epoch, sequence)`;
 *     ephemeral ones (`item.delta`, `tool.progress`, `terminal.output`) carry
 *     `afterSequence` and are deduped by `eventId`. A resumed stream therefore
 *     never duplicates what the client already applied.
 *   - a sequence jump, or a new epoch, cannot be repaired locally: the reducer
 *     raises `needsResync` and the screen re-attaches.
 *   - turn-scoped kinds carry the normalized `AgentEvent` under `payload.event`
 *     (plus `payload.itemType` / `payload.itemId` for item kinds), so message
 *     deltas are applied with the shared `applyMessageUpdate`.
 */
import { applyMessageUpdate, type RacpApprovalRequest, type RacpEventEnvelope, type RacpInputRequest, type RacpSession, type RacpSessionSnapshot, type SessionTodoList, type RacpTurn, type RacpTurnStatus, type UiMessage } from "@minih-agent/shared";

import {
  agentEvent,
  appendItem,
  asRecord,
  asString,
  isTruncatedPayload,
  itemFromSummary,
  itemFromTruncatedPayload,
  itemIdOf,
  itemTypeOf,
  plainText,
  prependItems,
  projectMessage,
  withAgent,
} from "./timeline-items.js";
import { createInitialTimelineState, type TimelineAction, type TimelineFailure, type TimelineItem, type TimelineState } from "./timeline-types.js";
import { newerTodos } from "./session-todos-view.js";

/**
 * Add or replace one row, and remember whether the cap dropped the oldest row.
 *
 * A row dropped by the cap came from `session/history`, so the Host still has
 * it: `hasMoreHistory` must stay true, or "load earlier" would be gone and the
 * row could never come back (D666 follow-up D2, review m1).
 */
function withItem(state: TimelineState, items: TimelineItem[], item: TimelineItem): TimelineState {
  const appended = appendItem(items, item);
  return {
    ...state,
    items: appended.items,
    ...(appended.droppedOldest ? { hasMoreHistory: true } : {}),
  };
}

export { MAX_ITEM_TEXT_CHARS, MAX_TIMELINE_ITEMS, itemFromSummary, plainText } from "./timeline-items.js";
export { createInitialTimelineState } from "./timeline-types.js";
export type { TimelineAction, TimelineFailure, TimelineItem, TimelineState } from "./timeline-types.js";

export const MAX_SEEN_EVENT_IDS = 2_000;

export function timelineReducer(state: TimelineState, action: TimelineAction): TimelineState {
  switch (action.type) {
    case "reset":
      return createInitialTimelineState();
    case "attach":
      return applyAttach(state, action);
    case "event":
      return applyEnvelope(state, action.envelope);
    case "prepend":
      // Older rows keep their place: the cap trims appends, not what the user
      // explicitly loaded (see `boundItems`).
      return {
        ...state,
        items: prependItems(state.items, action.items),
        hasMoreHistory: action.hasMoreHistory,
      };
  }
}

/**
 * The rows one snapshot shows: its newest page with the in-flight items
 * overlaid. The one place this projection is decided, so the reducer and the
 * history loop that tops a freshly opened view up cannot disagree about what the
 * client already has.
 */
export function snapshotItems(snapshot: RacpSessionSnapshot | undefined): TimelineItem[] {
  const items: TimelineItem[] = [];
  // `itemFromSummary` answers `undefined` for a row the desktop hides (internal
  // model instructions, an assistant row with nothing in it), so the phone does
  // not show a box the computer would not.
  for (const summary of snapshot?.items ?? []) {
    const item = itemFromSummary(summary);
    if (item) items.push(item);
  }
  for (const summary of snapshot?.activeItems ?? []) {
    const item = itemFromSummary(summary);
    if (!item) continue;
    const index = items.findIndex((existing) => existing.id === item.id);
    if (index < 0) items.push(item);
    else items[index] = item;
  }
  return items;
}

function applyAttach(state: TimelineState, action: Extract<TimelineAction, { type: "attach" }>): TimelineState {
  const snapshot = action.snapshot;
  const items = snapshotItems(snapshot);
  return {
    ...createInitialTimelineState(),
    attached: true,
    session: snapshot?.session ?? action.session,
    items,
    ...(snapshot?.activeTurn
      ? { activeTurnId: snapshot.activeTurn.id, activeTurnStatus: snapshot.activeTurn.status }
      : {}),
    hasMoreHistory: snapshot?.hasMoreHistory === true,
    queuedTurnIds: (snapshot?.queuedTurns ?? []).map((turn) => turn.id),
    pendingApprovals: [...(snapshot?.pendingApprovals ?? [])],
    pendingInputs: [...(snapshot?.pendingInputs ?? [])],
    ...(snapshot?.cursor ? { epoch: snapshot.cursor.epoch, lastSequence: snapshot.cursor.sequence } : {}),
    // The dedupe memory survives a re-attach: a replayed event must still be
    // dropped, and the snapshot cursor only covers durable events.
    seenEventIds: state.seenEventIds,
    ...(action.replayComplete === false ? { replayIncomplete: action.resyncReason ?? "replay-incomplete" } : {}),
  };
}

function applyEnvelope(state: TimelineState, envelope: RacpEventEnvelope): TimelineState {
  if (state.seenEventIds.includes(envelope.eventId)) return state;
  const sequence = envelope.sequence;
  if (!state.attached && sequence !== undefined) {
    // Before the first snapshot there is nothing to apply to: the snapshot is
    // about to replace this state, and an event it does not contain would be
    // lost for good if it were marked seen. The stream is opened at the
    // snapshot's cursor (protocol §5.4: a snapshot is valid only with its
    // cursor), so the Host replays exactly the events this client has not
    // applied yet. Dropping it here is what makes that replay the only source.
    return state;
  }
  if (sequence === undefined) {
    // Ephemeral: no cursor, so the event id is the only duplicate guard.
    const applied = applyKind(state, envelope);
    return { ...applied, seenEventIds: rememberEventId(state.seenEventIds, envelope.eventId) };
  }
  if (state.epoch !== undefined && envelope.epoch !== state.epoch) {
    // A new epoch means the Host cannot prove continuity: re-attach.
    return {
      ...state,
      epoch: envelope.epoch,
      lastSequence: sequence,
      needsResync: true,
      seenEventIds: rememberEventId(state.seenEventIds, envelope.eventId),
    };
  }
  if (state.lastSequence !== undefined && sequence <= state.lastSequence) return state;
  const applied = applyKind(state, envelope);
  // `applied` already carries `state.needsResync`; a jump in the sequence adds
  // to it, and a kind that demands a resync (`resync.required`) sets it itself.
  const needsResync =
    applied.needsResync || (state.lastSequence !== undefined && sequence > state.lastSequence + 1);
  return {
    ...applied,
    epoch: envelope.epoch,
    lastSequence: sequence,
    needsResync,
    seenEventIds: rememberEventId(state.seenEventIds, envelope.eventId),
  };
}

function rememberEventId(seenEventIds: string[], eventId: string): string[] {
  const next = [...seenEventIds, eventId];
  return next.length <= MAX_SEEN_EVENT_IDS ? next : next.slice(next.length - MAX_SEEN_EVENT_IDS);
}

function applyKind(state: TimelineState, envelope: RacpEventEnvelope): TimelineState {
  const payload = asRecord(envelope.payload) ?? {};
  switch (envelope.kind) {
    case "item.started":
      return applyItemStarted(state, envelope, payload);
    case "item.delta":
      return applyItemDelta(state, envelope, payload);
    case "item.completed":
      return applyItemCompleted(state, envelope, payload);
    case "turn.queued": {
      const turn = asRecord(payload.turn) as unknown as RacpTurn | undefined;
      const turnId = asString(turn?.id) ?? envelope.turnId;
      if (!turnId) return state;
      return {
        ...state,
        queuedTurnIds: state.queuedTurnIds.includes(turnId) ? state.queuedTurnIds : [...state.queuedTurnIds, turnId],
        ...(state.activeTurnId ? {} : { activeTurnStatus: "queued" as RacpTurnStatus }),
      };
    }
    case "turn.started": {
      const turnId = envelope.turnId ?? asString(asRecord(payload.turn)?.id);
      return {
        ...state,
        ...(turnId ? { activeTurnId: turnId } : {}),
        activeTurnStatus: "running",
        queuedTurnIds: turnId ? state.queuedTurnIds.filter((id) => id !== turnId) : state.queuedTurnIds,
      };
    }
    case "turn.completed":
    case "turn.interrupted":
    case "turn.canceled":
    case "turn.failed":
      return applyTurnClosed(state, envelope);
    case "turn.activity":
      return state;
    case "approval.requested": {
      const request = approvalRequestFrom(payload);
      if (!request || state.pendingApprovals.some((entry) => entry.id === request.id)) return state;
      return { ...state, pendingApprovals: [...state.pendingApprovals, request] };
    }
    case "approval.resolved": {
      const approvalId = asString(payload.approvalId);
      if (!approvalId) return state;
      return { ...state, pendingApprovals: state.pendingApprovals.filter((entry) => entry.id !== approvalId) };
    }
    case "input.requested": {
      const request = inputRequestFrom(payload);
      if (!request || state.pendingInputs.some((entry) => entry.id === request.id)) return state;
      return { ...state, pendingInputs: [...state.pendingInputs, request] };
    }
    case "input.resolved": {
      const inputId = asString(payload.inputId);
      if (!inputId) return state;
      return { ...state, pendingInputs: state.pendingInputs.filter((entry) => entry.id !== inputId) };
    }
    case "session.created":
    case "session.changed":
      return applySessionChanged(state, payload);
    case "session.archived":
      return { ...state, archived: true };
    case "resync.required":
      return { ...state, needsResync: true };
    default:
      // tool.progress, terminal.*, host.changed: no transcript effect in v1.
      return state;
  }
}

function applyItemStarted(
  state: TimelineState,
  envelope: RacpEventEnvelope,
  payload: Record<string, unknown>,
): TimelineState {
  if (isTruncatedPayload(payload)) {
    return withItem(state, state.items, itemFromTruncatedPayload(payload, envelope, "streaming"));
  }
  const itemType = itemTypeOf(payload);
  const event = agentEvent(payload);
  const id = itemIdOf(payload, envelope);
  const turnId = envelope.turnId ?? "";
  if (itemType === "message" && event?.type === "message_start") {
    const item = projectMessage(event.message, { id, turnId, status: "streaming" });
    if (!item) return state;
    return withItem(state, state.items, withAgent(item, envelope));
  }
  if (itemType === "tool" && event?.type === "tool_start") {
    const args = plainText(event.args);
    const item: TimelineItem = {
      id,
      turnId,
      itemType,
      status: "streaming",
      role: "tool",
      toolName: event.toolName,
      toolStatus: "running",
      ...(event.args !== undefined ? { toolArgs: event.args } : {}),
      text: args.text,
      ...(args.truncated ? { truncated: true } : {}),
    };
    return withItem(state, state.items, withAgent(item, envelope));
  }
  if (itemType === "compaction") {
    const reason = event?.type === "compaction_start" ? plainText(event.reason) : { text: "" };
    const item: TimelineItem = { id, turnId, itemType, status: "streaming", text: reason.text };
    return withItem(state, state.items, withAgent(item, envelope));
  }
  return state;
}

function applyItemDelta(
  state: TimelineState,
  envelope: RacpEventEnvelope,
  payload: Record<string, unknown>,
): TimelineState {
  if (isTruncatedPayload(payload) || itemTypeOf(payload) !== "message") return state;
  const event = agentEvent(payload);
  if (event?.type !== "message_update") return state;
  const id = itemIdOf(payload, envelope);
  const existing = state.items.find((item) => item.id === id);
  // Reuse the shared delta application (D412) instead of a second merge rule.
  const seed: UiMessage =
    existing?.role !== undefined
      ? {
          id,
          role: existing.role,
          content: existing.text,
          createdAt: "",
          ...(existing.thinking ? { thinking: existing.thinking } : {}),
        }
      : { id, role: "assistant", content: existing?.text ?? "", createdAt: "" };
  const merged = applyMessageUpdate(seed, event);
  const item = projectMessage(merged, {
    id,
    turnId: envelope.turnId ?? existing?.turnId ?? "",
    status: "streaming",
  });
  if (!item) return state;
  return withItem(state, state.items, withAgent(item, envelope));
}

function applyItemCompleted(
  state: TimelineState,
  envelope: RacpEventEnvelope,
  payload: Record<string, unknown>,
): TimelineState {
  if (isTruncatedPayload(payload)) {
    return withItem(state, state.items, itemFromTruncatedPayload(payload, envelope, "completed"));
  }
  const itemType = itemTypeOf(payload);
  const event = agentEvent(payload);
  const id = itemIdOf(payload, envelope);
  const turnId = envelope.turnId ?? "";
  if (itemType === "message" && event?.type === "message_end") {
    const item = projectMessage(event.message, { id, turnId, status: "completed" });
    const items =
      event.replacesMessageId && event.replacesMessageId !== id
        ? state.items.filter((entry) => entry.id !== event.replacesMessageId)
        : state.items;
    // A row that became invisible (an assistant message that turned out to be
    // empty) is removed rather than left behind.
    if (!item) return { ...state, items: items.filter((entry) => entry.id !== id) };
    return withItem(state, items, withAgent(item, envelope));
  }
  if (event?.type === "user_message_persisted") {
    const item = projectMessage(event.message, {
      id: event.message.id,
      turnId,
      status: "completed",
    });
    // The optimistic row the composer rendered is replaced by the durable one.
    const items = state.items.filter((entry) => entry.id !== event.optimisticMessageId);
    if (!item) return { ...state, items };
    return withItem(state, items, withAgent(item, envelope));
  }
  if (itemType === "tool" && event?.type === "tool_end") {
    const existing = state.items.find((entry) => entry.id === id);
    const result = plainText(event.result);
    const item: TimelineItem = {
      id,
      turnId,
      itemType,
      status: "completed",
      role: "tool",
      text: result.text,
      ...(existing?.toolName ? { toolName: existing.toolName } : {}),
      ...(existing?.toolArgs !== undefined ? { toolArgs: existing.toolArgs } : {}),
      ...(event.result !== undefined ? { toolResult: event.result } : {}),
      toolStatus: event.isError === true ? "error" : "success",
      ...(event.isError === true ? { isError: true } : {}),
      ...(result.truncated ? { truncated: true } : {}),
    };
    return withItem(state, state.items, withAgent(item, envelope));
  }
  if (itemType === "compaction" && event?.type === "compaction_end") {
    const detail = plainText(event.error?.message ?? event.reason);
    const item: TimelineItem = {
      id,
      turnId,
      itemType,
      status: "completed",
      text: detail.text,
      ...(event.ok === false ? { isError: true } : {}),
    };
    return withItem(state, state.items, withAgent(item, envelope));
  }
  const existing = state.items.find((entry) => entry.id === id);
  if (!existing) return state;
  return withItem(state, state.items, { ...existing, status: "completed" });
}

function applyTurnClosed(state: TimelineState, envelope: RacpEventEnvelope): TimelineState {
  const status: RacpTurnStatus =
    envelope.kind === "turn.completed"
      ? "completed"
      : envelope.kind === "turn.interrupted"
        ? "interrupted"
        : envelope.kind === "turn.canceled"
          ? "canceled"
          : "failed";
  const turnId = envelope.turnId ?? asString(asRecord(envelope.payload)?.turnId);
  const errorRecord = asRecord(asRecord(asRecord(envelope.payload)?.event)?.error);
  const failure: TimelineFailure | undefined =
    envelope.kind === "turn.failed"
      ? {
          kind: envelope.kind,
          ...(turnId ? { turnId } : {}),
          ...(asString(errorRecord?.code) ? { code: asString(errorRecord?.code) as string } : {}),
          ...(asString(errorRecord?.message) ? { message: asString(errorRecord?.message) as string } : {}),
        }
      : undefined;
  // A terminal event for a *queued* turn must not relabel the turn that is
  // still running; only the active turn (or an idle session) sets the status.
  const closesActive = turnId !== undefined && state.activeTurnId === turnId;
  const closesAnother = turnId !== undefined && state.activeTurnId !== undefined && !closesActive;
  return {
    ...state,
    ...(closesAnother ? {} : { activeTurnStatus: status }),
    ...(closesActive ? { activeTurnId: undefined } : {}),
    queuedTurnIds: turnId ? state.queuedTurnIds.filter((id) => id !== turnId) : state.queuedTurnIds,
    // The Host also resolves them explicitly; this is the belt for a missed
    // resolution, so a closed turn never leaves an actionable card behind.
    pendingApprovals: turnId ? state.pendingApprovals.filter((entry) => entry.turnId !== turnId) : state.pendingApprovals,
    pendingInputs: turnId ? state.pendingInputs.filter((entry) => entry.turnId !== turnId) : state.pendingInputs,
    ...(failure ? { lastFailure: failure } : {}),
  };
}

function approvalRequestFrom(payload: Record<string, unknown>): RacpApprovalRequest | undefined {
  if (typeof payload.id !== "string" || typeof payload.kind !== "string") return undefined;
  return payload as unknown as RacpApprovalRequest;
}

function inputRequestFrom(payload: Record<string, unknown>): RacpInputRequest | undefined {
  if (typeof payload.id !== "string" || !Array.isArray(payload.questions)) return undefined;
  return payload as unknown as RacpInputRequest;
}

/** `session.changed` rides three shapes; all of them only refresh the session header. */
function applySessionChanged(state: TimelineState, payload: Record<string, unknown>): TimelineState {
  const planning = asRecord(payload.event);
  if (planning && typeof planning.state === "string" && state.session) {
    return { ...state, session: { ...state.session, planningState: planning.state as RacpSession["planningState"] } };
  }
  const incoming = asRecord(payload.session);
  if (incoming && typeof incoming.id === "string") {
    if (state.session && state.session.id !== incoming.id) return state;
    const merged = {
      ...(state.session ?? emptySession(incoming.id)),
      ...(incoming as unknown as RacpSession),
    };
    // A summary that raced an event can carry the older checklist: the higher
    // revision wins, exactly as it does for the event-shaped payload below.
    const todos = newerTodos(state.session?.todos, merged.todos);
    return { ...state, session: todos ? { ...merged, todos } : merged };
  }
  if (!state.session) return state;
  if (typeof payload.sessionId === "string" && payload.sessionId !== state.session.id) return state;
  // The Host republishes a committed checklist on `session.changed` (§5.8), so
  // a list the Host has already replaced is dropped instead of shown.
  const todos =
    payload.todos === undefined
      ? state.session.todos
      : newerTodos(state.session.todos, payload.todos as SessionTodoList | null);
  return {
    ...state,
    session: {
      ...state.session,
      ...(todos ? { todos } : {}),
      ...(typeof payload.status === "string" ? { status: payload.status as RacpSession["status"] } : {}),
      ...(typeof payload.planningState === "string"
        ? { planningState: payload.planningState as RacpSession["planningState"] }
        : {}),
    },
  };
}

function emptySession(id: string): RacpSession {
  return {
    id,
    title: "",
    mode: "agent",
    status: "idle",
    planningState: "inactive",
    permissionMode: "ask",
    queuedTurnIds: [],
    revision: 0,
    createdAt: "",
    updatedAt: "",
  };
}
