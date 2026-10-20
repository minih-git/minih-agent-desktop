import type { UiMessage } from "@minih-agent/shared";

/** Legacy marked questions only; new Q&A lives outside the main transcript. */
export function sideNotesFromMessages(
  messages: readonly UiMessage[],
): UiMessage[] {
  return messages.filter(
    (message) => message.role === "user" && message.sideNote === true,
  );
}

/** Keep admission limited to the currently running task snapshot. */
export function sideNoteInputState(input: {
  running: boolean;
  turnId?: string;
  planPending: boolean;
}): "ready" | "idle" {
  return input.running && Boolean(input.turnId) && !input.planPending
    ? "ready"
    : "idle";
}
