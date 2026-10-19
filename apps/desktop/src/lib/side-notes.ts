import type { UiMessage } from "@minih-agent/shared";

/**
 * Side notes are user input a running turn answers without being redirected by
 * it. The durable row carries `sideNote`, so the panel and the transcript agree
 * about which rows were notes after a reload or a session switch.
 */
export function sideNotesFromMessages(
  messages: readonly UiMessage[],
): UiMessage[] {
  return messages.filter(
    (message) => message.role === "user" && message.sideNote === true,
  );
}

/**
 * Whether the side-notes tab can send right now. A note is delivered into the
 * turn that is running, so an idle session, a turn that already finalized, and
 * a turn waiting for plan approval all have nowhere to deliver it.
 */
export function sideNoteInputState(input: {
  running: boolean;
  turnId?: string;
  planPending: boolean;
}): "ready" | "idle" {
  return input.running && Boolean(input.turnId) && !input.planPending
    ? "ready"
    : "idle";
}
