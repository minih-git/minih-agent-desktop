/**
 * Direct records as the shared timeline shows them (ADR
 * mobile-direct-gateway-chat §5).
 *
 * The chat panel is not copied: `ChatTimeline` already renders user rows,
 * assistant Markdown, centered dividers and a per-reply label, so this module's
 * only job is to turn stored records into that shape. No RACP event, cursor or
 * remote session id is invented on the way.
 *
 * Two rules from the ADR appear here rather than in the screen:
 *
 * - A reply carries the model that produced it, so a conversation continued on
 *   another model still shows which reply came from which.
 * - Changing the model is a separator ("switched to X, applies to the next
 *   message"), which is a compaction-style row: it is not part of the
 *   conversation and must not be mistaken for content.
 */
import type { TimelineItem } from "../timeline-types.js";
import type { DirectChatAttempt, DirectChatTranscript } from "./history-store.js";
import { liveAttemptOf } from "./history.js";

export type DirectChatView = {
  items: TimelineItem[];
  /** The text arriving right now, so the screen can show it before it is saved. */
  pendingText: string | null;
  /** The live attempt, if one is being received. */
  liveAttempt: DirectChatAttempt | null;
  /** The last attempt that ended in a state worth a footer and a retry. */
  retryable: DirectChatAttempt | null;
};

/** The label above a reply: the model that produced it. */
function labelOf(attempt: DirectChatAttempt | undefined): string | undefined {
  return attempt?.modelLabel || attempt?.modelId || undefined;
}

export function projectDirectTranscript(
  transcript: DirectChatTranscript,
  options: { liveText?: string } = {},
): DirectChatView {
  const liveText = options.liveText ?? "";
  const attemptsById = new Map(transcript.attempts.map((attempt) => [attempt.id, attempt]));
  const items: TimelineItem[] = [];
  let previousModel: string | null = null;
  /**
   * Read from the attempts, not from the messages: a reply that has not produced
   * text yet still has no row, and the screen must offer Stop for it.
   */
  const liveAttempt = liveAttemptOf(transcript.attempts);

  for (const message of transcript.messages) {
    const attempt = message.attemptId ? attemptsById.get(message.attemptId) : undefined;
    if (message.role === "user") {
      items.push({
        id: message.id,
        turnId: message.id,
        itemType: "message",
        status: "completed",
        role: "user",
        text: message.text,
      });
      // Not reset: the separator compares consecutive *replies*, and a user
      // message always sits between them.
      continue;
    }
    if (!attempt) continue;
    // A model change between replies is a separator, not content.
    if (previousModel !== null && previousModel !== attempt.modelId) {
      items.push({
        id: `switch-${attempt.id}`,
        turnId: attempt.id,
        itemType: "compaction",
        status: "completed",
        role: "system",
        text: attempt.modelLabel || attempt.modelId,
      });
    }
    previousModel = attempt.modelId;
    const live = attempt.state === "streaming" || attempt.state === "pending";
    items.push({
      id: message.id,
      turnId: attempt.id,
      itemType: "message",
      status: live ? "streaming" : "completed",
      role: "assistant",
      // A live reply shows what has arrived, even before its first checkpoint.
      text: live && liveText.length >= message.text.length ? liveText : message.text,
      ...(labelOf(attempt) ? { agentName: labelOf(attempt) } : {}),
      modelId: attempt.modelId,
    });
  }

  // A live reply that has not produced its first token still gets a row, so the
  // reader sees that an answer is coming rather than an idle composer.
  if (liveAttempt && !transcript.messages.some((message) => message.attemptId === liveAttempt.id)) {
    items.push({
      id: `live-${liveAttempt.id}`,
      turnId: liveAttempt.id,
      itemType: "message",
      status: "streaming",
      role: "assistant",
      text: liveText,
      ...(labelOf(liveAttempt) ? { agentName: labelOf(liveAttempt) } : {}),
      modelId: liveAttempt.modelId,
    });
  }

  // An attempt that produced no text still has to be visible: a failed or
  // interrupted reply is a fact about the conversation, not nothing.
  const last = transcript.attempts[transcript.attempts.length - 1];
  const answered = new Set(transcript.messages.map((message) => message.attemptId).filter(Boolean));
  const visibleWithoutText =
    last && !answered.has(last.id) && (last.state === "failed" || last.state === "interrupted")
      ? last
      : null;
  if (visibleWithoutText) {
    items.push({
      id: `state-${visibleWithoutText.id}`,
      turnId: visibleWithoutText.id,
      itemType: "compaction",
      status: "completed",
      role: "system",
      text: visibleWithoutText.error ?? "",
    });
  }

  const retryable =
    last && (last.state === "interrupted" || last.state === "failed" || last.state === "stopped")
      ? last
      : null;

  return { items, pendingText: null, liveAttempt, retryable };
}

/**
 * The transcript as Markdown, for "Copy as Markdown" (ADR §4).
 *
 * Each reply is labelled with its model and closed with its completion marker,
 * and nothing else travels: no request payload, no key, no internal id. A copied
 * transcript is meant to be pasted somewhere, so it carries only what a reader
 * needs.
 */
export function transcriptAsMarkdown(transcript: DirectChatTranscript): string {
  const attemptsById = new Map(transcript.attempts.map((attempt) => [attempt.id, attempt]));
  const lines: string[] = [`# ${transcript.conversation.title}`, ""];
  for (const message of transcript.messages) {
    if (message.role === "user") {
      lines.push("## User", "", message.text, "");
      continue;
    }
    const attempt = message.attemptId ? attemptsById.get(message.attemptId) : undefined;
    lines.push(`## ${attempt?.modelLabel || attempt?.modelId || "Assistant"}`, "", message.text, "");
    if (attempt) lines.push(`_${completionMarker(attempt)}_`, "");
  }
  return `${lines.join("\n").trim()}\n`;
}

/** How a reply ended, in the words a reader of the copy needs. */
export function completionMarker(attempt: DirectChatAttempt): string {
  switch (attempt.state) {
    case "complete":
      return "Complete";
    case "stopped":
      return "Stopped · the text above is what arrived";
    case "interrupted":
      return "Interrupted · the text above is what arrived";
    case "failed":
      return attempt.error ? `Failed · ${attempt.error}` : "Failed";
    case "streaming":
    case "pending":
      return "Still being received";
    default:
      return attempt.state;
  }
}
