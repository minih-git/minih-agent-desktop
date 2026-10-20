/**
 * What a transcript row shows, and whether it is a row at all (shared).
 *
 * The desktop transcript and the phone timeline must agree on these two
 * questions, and they used to answer them separately: the desktop hid its
 * internal model instructions and its empty assistant rows, while the phone
 * rendered every message it received, so a phone showed blank "system" and
 * "assistant" boxes the desktop never showed. The rules now live here and both
 * surfaces import them.
 *
 * They are pure functions over one `UiMessage`, with no React, DOM, or storage
 * dependency, which is why they can be shared at all.
 */
import type { UiMessage } from "./types/messages.js";

const contentFacts = new WeakMap<UiMessage, { trimmedContent: string; hasContent: boolean }>();

/**
 * The message's own text, trimmed once per message object.
 *
 * Renderer snapshots are immutable, so a same-id replacement is a new cache key
 * and a stale entry can never be read back.
 */
export function messageContentFacts(message: UiMessage): { trimmedContent: string; hasContent: boolean } {
  let facts = contentFacts.get(message);
  if (!facts) {
    const trimmedContent = (message.content || "").trim();
    facts = { trimmedContent, hasContent: Boolean(trimmedContent) };
    contentFacts.set(message, facts);
  }
  return facts;
}

/** The message's thinking text, or `""` when it has none worth showing. */
export function messageThinking(message: UiMessage): string {
  if (typeof message.thinking !== "string") return "";
  return message.thinking.trim() ? message.thinking : "";
}

/**
 * Whether a message is a visible transcript row.
 *
 * Two rows are never shown: the internal model instructions (`system` with
 * `modelSystem`, which carry tool declarations and prompt scaffolding rather
 * than anything the user wrote or read) and an assistant row that has nothing
 * to show — no text, no thinking, no hosted-search result, and no error. An
 * assistant row that failed is visible, because the reason it failed is the
 * only thing the user can act on.
 */
export function isVisibleMessage(message: UiMessage): boolean {
  if (message.role === "system" && message.modelSystem) return false;
  return !(
    message.role === "assistant" &&
    !messageContentFacts(message).hasContent &&
    !messageThinking(message) &&
    !message.hostedSearch &&
    !message.error
  );
}
