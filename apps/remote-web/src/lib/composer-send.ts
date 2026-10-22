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
