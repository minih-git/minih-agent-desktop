/**
 * What the rename field shows (ADR mobile-redesign D5, bug B5).
 *
 * The info sheet used to seed a `useState` from the transcript, which is `null`
 * on the first render because the record is still loading. The field therefore
 * stayed empty for the whole visit, and Save could never be enabled. Deriving
 * the value from the transcript — with an edit that wins once the user types —
 * makes the load arriving late the ordinary case instead of a broken one.
 */
import type { DirectChatTranscript } from "./history-store.js";

/**
 * `edited` is what the user typed, or `null` while the field still tracks the
 * conversation's own title.
 */
export function renameValueFor(
  transcript: DirectChatTranscript | null,
  edited: string | null,
): string {
  return edited ?? transcript?.conversation.title ?? "";
}