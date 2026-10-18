/**
 * Wire payload to timeline row projection (PR-4).
 *
 * `AgentHost` publishes turn-scoped kinds with the normalized `AgentEvent`
 * under `payload.event` plus `payload.itemType` / `payload.itemId`, and a
 * snapshot row carries the same content under `ItemSummary.content`. Both
 * shapes are `unknown` on the wire, so this module is the single place that
 * narrows them into the plain-text rows the H5 client renders.
 */
import type {
  AgentEvent,
  RacpEventEnvelope,
  RacpItemSummary,
  RacpItemType,
  UiMessage,
  UiMessageRole,
} from "@minih-agent/shared";

import type { TimelineItem } from "./timeline-types.js";

export const MAX_TIMELINE_ITEMS = 400;
export const MAX_ITEM_TEXT_CHARS = 20_000;

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

export function boundItems(items: TimelineItem[]): TimelineItem[] {
  return items.length <= MAX_TIMELINE_ITEMS ? items : items.slice(items.length - MAX_TIMELINE_ITEMS);
}

export function upsertItem(items: TimelineItem[], next: TimelineItem): TimelineItem[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return boundItems([...items, next]);
  const copy = items.slice();
  copy[index] = next;
  return copy;
}

export function messageFields(message: UiMessage): Pick<TimelineItem, "role" | "text" | "thinking" | "truncated"> {
  const content = plainText(message.content ?? "");
  const thinking = plainText(message.thinking ?? "");
  return {
    role: message.role,
    text: content.text,
    ...(thinking.text ? { thinking: thinking.text } : {}),
    ...(content.truncated || thinking.truncated ? { truncated: true } : {}),
  };
}

/** One snapshot row: `ItemSummary.content` is what `AgentHost` built for the item. */
export function itemFromSummary(summary: RacpItemSummary): TimelineItem {
  const content = asRecord(summary.content);
  const base: TimelineItem = {
    id: summary.id,
    turnId: summary.turnId,
    itemType: summary.itemType,
    status: summary.status,
    text: "",
    ...(summary.agentName ? { agentName: summary.agentName } : {}),
  };
  if (summary.itemType === "message" && content && typeof content.role === "string") {
    return { ...base, ...messageFields(content as unknown as UiMessage) };
  }
  if (summary.itemType === "tool" && content) {
    const toolName = asString(content.toolName);
    const args = plainText(content.args);
    const result = plainText(content.result);
    return {
      ...base,
      ...(toolName ? { toolName } : {}),
      text: summary.status === "streaming" ? args.text : result.text,
      ...(content.isError === true ? { isError: true } : {}),
      ...(args.truncated || result.truncated ? { truncated: true } : {}),
    };
  }
  const fallback = plainText(summary.content);
  return { ...base, text: fallback.text, ...(fallback.truncated ? { truncated: true } : {}) };
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
