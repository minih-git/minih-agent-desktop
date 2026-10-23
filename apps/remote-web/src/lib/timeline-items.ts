/**
 * Wire payload to timeline row projection (PR-4; unified in rollout D).
 *
 * `AgentHost` publishes turn-scoped kinds with the normalized `AgentEvent`
 * under `payload.event` plus `payload.itemType` / `payload.itemId`, and a
 * snapshot row carries the same content under `ItemSummary.content`. Both
 * shapes are `unknown` on the wire, so this module is the single place that
 * narrows them into the rows the H5 client renders.
 *
 * Two paths used to disagree: a history row is a whole `UiMessage` (a tool call
 * arrives as a `role: "tool"` message with its name, status, arguments and
 * result in separate fields), while the live path sees `tool_start` /
 * `tool_end` events. History rows were projected by reading only `role`,
 * `content` and `thinking`, so a phone showed an unnamed, empty tool box for
 * every call the desktop showed by name. `projectMessage` is now the one
 * projection both paths use, and it drops the rows the desktop hides
 * (`isVisibleMessage`).
 */
import {
  isVisibleMessage,
  type AgentEvent,
  type RacpEventEnvelope,
  type RacpItemSummary,
  type RacpItemType,
  type UiMessage,
  type UiMessageRole,
} from "@minih-agent/shared";

import type { TimelineItem } from "./timeline-types.js";

export const MAX_TIMELINE_ITEMS = 400;
export const MAX_ITEM_TEXT_CHARS = 200_000;
/** Names shown for the attachments of one row; the rest are counted, not listed. */
export const MAX_ITEM_ATTACHMENTS = 8;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function agentEvent(payload: Record<string, unknown>): AgentEvent | undefined {
  const event = asRecord(payload.event);
  return typeof event?.type === "string" ? (event as unknown as AgentEvent) : undefined;
}

export function itemTypeOf(payload: Record<string, unknown>): RacpItemType {
  const value = payload.itemType;
  return value === "tool" || value === "compaction" ? value : "message";
}

/** An over-sized frame is published as `{ truncated: true, preview }` (§5.3). */
export function isTruncatedPayload(payload: Record<string, unknown>): boolean {
  return payload.truncated === true;
}

/** Bounded plain text for anything that is not already a string. */
export function plainText(value: unknown, limit = MAX_ITEM_TEXT_CHARS): { text: string; truncated: boolean } {
  if (value === undefined || value === null) return { text: "", truncated: false };
  const text = typeof value === "string" ? value : safeStringify(value);
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The cap on a transcript that grows at the newest end.
 *
 * Only an append is trimmed, and always from the oldest end: the newest rows are
 * what a reader is looking at. Older history the user asked for is *not* trimmed
 * (`prependItems`), because dropping the rows that were just loaded would undo
 * the action that loaded them.
 */
export function boundItems(items: TimelineItem[]): TimelineItem[] {
  return items.length <= MAX_TIMELINE_ITEMS ? items : items.slice(items.length - MAX_TIMELINE_ITEMS);
}

/** Older rows in front of the current ones, deduped by id and never trimmed. */
export function prependItems(items: TimelineItem[], older: readonly TimelineItem[]): TimelineItem[] {
  if (older.length === 0) return items;
  const known = new Set(items.map((item) => item.id));
  const fresh = older.filter((item) => !known.has(item.id));
  return fresh.length > 0 ? [...fresh, ...items] : items;
}

/**
 * Add one row at the newest end, or replace it if the client already has it.
 *
 * `droppedOldest` says whether the cap threw a row away, which the caller has to
 * know: that row came from `session/history`, so the Host still has it and the
 * "load earlier" entry must stay offered or it could never come back.
 */
export function appendItem(
  items: TimelineItem[],
  next: TimelineItem,
): { items: TimelineItem[]; droppedOldest: boolean } {
  const index = items.findIndex((item) => item.id === next.id);
  if (index >= 0) {
    const copy = items.slice();
    copy[index] = next;
    return { items: copy, droppedOldest: false };
  }
  const grown = [...items, next];
  const bounded = boundItems(grown);
  return { items: bounded, droppedOldest: bounded.length < grown.length };
}

export function upsertItem(items: TimelineItem[], next: TimelineItem): TimelineItem[] {
  return appendItem(items, next).items;
}

/**
 * What a user row reads as.
 *
 * A slash command is stored apart from the text it produced, and both clients
 * show the command the user typed. This stays here rather than in
 * `@minih-agent/shared` because the desktop's editable row adds an edit-mode
 * condition of its own (`features/chat/transcript/MessageRow.tsx`), so the
 * shared module would hold a rule only this client follows.
 */
export function userMessageText(message: UiMessage): string {
  const command = typeof message.command === "string" ? message.command : "";
  return command || message.content || "";
}

/** The durable tool state a `role: "tool"` message carries, if any. */
function toolStatusOf(message: UiMessage): TimelineItem["toolStatus"] {
  const status = message.toolStatus;
  return status === "running" || status === "success" || status === "error" || status === "denied"
    ? status
    : undefined;
}

/** Attachment names, bounded, so a phone still shows that a turn carried files. */
function attachmentsOf(message: UiMessage): TimelineItem["attachments"] {
  const attachments = message.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  const named = attachments.slice(0, MAX_ITEM_ATTACHMENTS).map((attachment) => ({
    name: attachment.name || attachment.kind,
    kind: attachment.kind,
  }));
  return named.length > 0 ? named : undefined;
}

export function messageFields(message: UiMessage): Pick<TimelineItem, "role" | "text" | "thinking" | "truncated"> {
  // A user row reads as the command it was sent with; every other role reads
  // as its own content.
  const content = plainText(message.role === "user" ? userMessageText(message) : message.content ?? "");
  const thinking = plainText(message.thinking ?? "");
  return {
    role: message.role,
    text: content.text,
    ...(thinking.text ? { thinking: thinking.text } : {}),
    ...(content.truncated || thinking.truncated ? { truncated: true } : {}),
  };
}

/**
 * One message as a timeline row, or `undefined` when the desktop would not show
 * it either.
 *
 * A `role: "tool"` message becomes a tool row with its name, durable status,
 * structured arguments and structured result: the text previews one or the
 * other so the current plain-text UI keeps working, and the structured fields
 * are what the card renderer (package B) reads instead of parsing text.
 */
export function projectMessage(
  message: UiMessage,
  options: { id?: string; turnId?: string; status?: TimelineItem["status"] } = {},
): TimelineItem | undefined {
  if (!isVisibleMessage(message)) return undefined;
  const id = options.id ?? message.id;
  const turnId = options.turnId ?? "";
  if (message.role === "tool") {
    const toolStatus = toolStatusOf(message);
    const args = plainText(message.toolArgs);
    const result = plainText(message.toolResult);
    const running = toolStatus === "running" || (toolStatus === undefined && options.status === "streaming");
    const shown = running ? args : result;
    return {
      id,
      turnId,
      itemType: "tool",
      status: running ? "streaming" : "completed",
      role: message.role,
      text: shown.text,
      ...(message.toolName ? { toolName: message.toolName } : {}),
      ...(toolStatus ? { toolStatus } : {}),
      ...(message.toolArgs !== undefined ? { toolArgs: message.toolArgs } : {}),
      ...(message.toolResult !== undefined ? { toolResult: message.toolResult } : {}),
      ...(toolStatus === "error" || toolStatus === "denied" || message.error ? { isError: true } : {}),
      ...(shown.truncated ? { truncated: true } : {}),
    };
  }
  const attachments = attachmentsOf(message);
  const mediaIds = Array.isArray(message.attachments)
    ? message.attachments
        .map((att) => (att as { mediaId?: unknown })?.mediaId)
        .filter((mediaId): mediaId is string => typeof mediaId === "string" && mediaId.length > 0)
    : undefined;
  const providerId = typeof message.providerId === "string" && message.providerId.trim() ? message.providerId.trim() : undefined;
  const modelId = typeof message.modelId === "string" && message.modelId.trim() ? message.modelId.trim() : undefined;
  return {
    id,
    turnId,
    itemType: "message",
    status: options.status ?? "completed",
    ...messageFields(message),
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(typeof message.command === "string" && message.command ? { command: message.command } : {}),
    ...(attachments ? { attachments } : {}),
    ...(mediaIds && mediaIds.length > 0 ? { mediaIds } : {}),
    ...(message.sideNote === true ? { sideNote: true } : {}),
    ...(message.error ? { isError: true } : {}),
  };
}

/**
 * One snapshot or history row: `ItemSummary.content` is what `AgentHost` built
 * for the item. Returns `undefined` for a row the desktop would hide.
 */
export function itemFromSummary(summary: RacpItemSummary): TimelineItem | undefined {
  const content = asRecord(summary.content);
  const agent = summary.agentName ? { agentName: summary.agentName } : {};
  if (summary.itemType === "message" && content && typeof content.role === "string") {
    // A whole `UiMessage`: the same projection the live path uses, so a tool
    // call recorded before this client attached looks like one that arrived
    // while it was watching.
    const projected = projectMessage(content as unknown as UiMessage, {
      id: summary.id,
      turnId: summary.turnId,
      status: summary.status,
    });
    return projected ? { ...projected, ...agent } : undefined;
  }
  if (summary.itemType === "tool" && content) {
    const toolName = asString(content.toolName);
    const args = plainText(content.args);
    const result = plainText(content.result);
    return {
      id: summary.id,
      turnId: summary.turnId,
      itemType: summary.itemType,
      status: summary.status,
      text: summary.status === "streaming" ? args.text : result.text,
      ...(toolName ? { toolName } : {}),
      ...(content.args !== undefined ? { toolArgs: content.args } : {}),
      ...(content.result !== undefined ? { toolResult: content.result } : {}),
      ...(content.isError === true ? { isError: true } : {}),
      ...(args.truncated || result.truncated ? { truncated: true } : {}),
      ...agent,
    };
  }
  const fallback = plainText(summary.content);
  return {
    id: summary.id,
    turnId: summary.turnId,
    itemType: summary.itemType,
    status: summary.status,
    text: fallback.text,
    ...(fallback.truncated ? { truncated: true } : {}),
    ...agent,
  };
}

export function itemFromTruncatedPayload(
  payload: Record<string, unknown>,
  envelope: RacpEventEnvelope,
  status: "streaming" | "completed",
): TimelineItem {
  const preview = plainText(payload.preview);
  return {
    id: itemIdOf(payload, envelope),
    turnId: envelope.turnId ?? "",
    itemType: itemTypeOf(payload),
    status,
    text: preview.text,
    truncated: true,
    ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
  };
}

export function itemIdOf(payload: Record<string, unknown>, envelope: RacpEventEnvelope): string {
  return asString(payload.itemId) ?? `item:${envelope.eventId}`;
}

/** Subagent provenance rides the envelope, exactly as on the local path (ADR 0062). */
export function withAgent(item: TimelineItem, envelope: RacpEventEnvelope): TimelineItem {
  return envelope.agentName && !item.agentName ? { ...item, agentName: envelope.agentName } : item;
}

export function roleOf(message: UiMessage): UiMessageRole {
  return message.role;
}
