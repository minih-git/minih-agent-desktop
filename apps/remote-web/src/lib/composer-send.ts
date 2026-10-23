/**
 * What the composer hands its caller when the user sends.
 *
 * The type lives here rather than in `useSessionScreen`, because two containers
 * now use the same composer: the remote session screen (which needs the
 * idempotency key for RACP) and the direct conversation (which does not, but
 * pays nothing for sharing the shape). Moving it is behaviour-preserving: the
 * remote hook imports it under its old name.
 */
import type { RacpInlineAttachment } from "@minih-agent/shared";

export type ComposerSend = {
  text: string;
  /** Inline files for this prompt; absent means text only. */
  attachments?: RacpInlineAttachment[];
  /** Created once per user action; a retry of the same action reuses it. */
  idempotencyKey: string;
  requestId: string;
};

/**
 * The parts of a key press both composers decide on.
 *
 * `isComposing` is the browser's own flag for an active IME composition, and
 * `keyCode 229` is the legacy signal some Android IMEs still send. Enter during
 * a composition belongs to the IME — it commits the candidate — and must never
 * send the message instead.
 */
export type ComposerKeyEvent = {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

/** Whether this key press should send the prompt. */
export function submitsOnEnter(event: ComposerKeyEvent): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false;
  if (event.isComposing === true) return false;
  return event.keyCode !== 229;
}
