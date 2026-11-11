import { IPC, type TaskCardsChangedEvent } from "@minih-agent/shared";

/**
 * The one place a task-card change reaches the renderer.
 *
 * A card can be created or changed from three directions: the steward's
 * `TaskCard` tool, the host's own auto-start policy, and the person's click on
 * confirm or drop. Only the last one used to notify, so a card the model
 * proposed stayed invisible until the person switched sessions — the dock had
 * fetched once, before the card existed.
 *
 * Every direction therefore ends here, and the dock stays a pure listener.
 */
export type TaskCardsChangedNotifier = (change: { sessionId: string; draftId: string }) => void;

/** The renderer channel every task-card change is delivered on. */
export const TASK_CARDS_CHANGED_CHANNEL = IPC.event.taskCardsChanged;

export function createTaskCardsChangedNotifier(
  send: (payload: TaskCardsChangedEvent) => void,
): TaskCardsChangedNotifier {
  return ({ sessionId, draftId }) => send({ sessionId, draftId });
}

/**
 * Bind the notifier to a renderer sender.
 *
 * Callers get one function and never name the channel or the payload shape, so
 * there is exactly one place a task-card change becomes an event.
 */
export function taskCardsChangedSender(
  sendToRenderer: (channel: string, payload: unknown) => void,
): TaskCardsChangedNotifier {
  return createTaskCardsChangedNotifier((payload) =>
    sendToRenderer(TASK_CARDS_CHANGED_CHANNEL, payload),
  );
}
