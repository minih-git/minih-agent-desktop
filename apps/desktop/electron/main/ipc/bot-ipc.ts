import {
  IPC,
  type BotsChangedEvent,
  type SessionCollaborationMessage,
  type TaskArchiveResult,
  type TaskCardConfirmResult,
  type TaskCardDraftView,
  type TaskCreateResult,
  type TaskList,
  type TaskView,
} from "@minih-agent/shared";
import type { HostProcess } from "../host-process";
import type { SessionCollaborationService } from "../services/session-collaboration";
import type { IpcRegistrar } from "./types";
import { taskCardsChangedSender } from "../services/task-cards-changed";
import { taskChangedSender } from "../services/tasks-changed";

/**
 * The employee surface (ADR bot-sessions-and-steward §5).
 *
 * Two rules are why this is its own module rather than more `session.*` calls:
 *
 * - **Confirming a card is a person's click.** `taskCardConfirm` is reachable
 *   only from the renderer, and the model has no tool that reaches it, no
 *   `confirm` action on `TaskCard` and no `mandate` argument on `SessionSend`.
 *   This module is the only place in the product that confirms.
 * - **Seeding is explicit.** `botSeedDefaults` runs when the user asks for it
 *   and never at startup, so no install silently grows four sessions.
 */
export function registerBotIpc({
  registrar,
  getHost,
  sendToRenderer,
  sessionCollaboration,
}: {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  sendToRenderer: (channel: string, payload: unknown) => void;
  /**
   * The one dispatcher for a confirmed delivery. Confirming only writes the
   * ledger row, so the click also has to start it — through the same path an
   * ordinary send uses, never a second starter.
   */
  sessionCollaboration: SessionCollaborationService;
}): void {
  const { handle } = registrar;
  const notifyTaskCardsChanged = taskCardsChangedSender(sendToRenderer);
  const notifyTaskChanged = taskChangedSender(sendToRenderer);
  /**
   * The stage Main last announced per task, so a stage the host moved on its
   * own (a ledger report or settlement) is still delivered exactly once.
   */
  const lastKnownStage = new Map<string, string>();

  function announceTask(task: TaskView, reason: "created" | "stage" | "archived"): void {
    const previous = lastKnownStage.get(task.id);
    lastKnownStage.set(task.id, task.stage);
    if (reason === "stage" && previous === task.stage) return;
    notifyTaskChanged({
      employeeSessionId: task.employeeSessionId,
      taskId: task.id,
      reason,
    });
  }

  /**
   * Ask the host what changed since the last answer.
   *
   * Nothing in the ledger calls Main, so a stage the host moved is discovered
   * by reading the tasks that are still open. The compare-and-emit lives here,
   * and every path that can move a stage funnels through it.
   */
  async function reconcileTaskStages(): Promise<void> {
    let tasks: TaskView[];
    try {
      tasks = ((await host().call("task.list", {})) as TaskList).tasks ?? [];
    } catch {
      // A host that is restarting answers nothing; the next event reconciles.
      return;
    }
    const open = new Set(tasks.map((task) => task.id));
    for (const task of tasks) announceTask(task, "stage");
    for (const id of [...lastKnownStage.keys()]) {
      if (!open.has(id)) lastKnownStage.delete(id);
    }
  }
  const host = (): HostProcess => {
    const current = getHost();
    if (!current?.isAvailable()) throw new Error("host unavailable");
    return current;
  };

  handle(IPC.invoke.botList, async () => host().call("bot.list", {}));

  handle(IPC.invoke.botCreate, async (request) => {
    const result = await host().call("bot.create", (request ?? {}) as Record<string, unknown>);
    const event: BotsChangedEvent = { reason: "created" };
    sendToRenderer(IPC.event.botsChanged, event);
    return result;
  });

  handle(IPC.invoke.botUpdate, async (request) => {
    const result = await host().call("bot.update", (request ?? {}) as Record<string, unknown>);
    sendToRenderer(IPC.event.botsChanged, { reason: "updated" } satisfies BotsChangedEvent);
    return result;
  });

  handle(IPC.invoke.botDismiss, async (request) => {
    const result = await host().call("bot.dismiss", (request ?? {}) as Record<string, unknown>);
    sendToRenderer(IPC.event.botsChanged, { reason: "dismissed" } satisfies BotsChangedEvent);
    return result;
  });

  handle(IPC.invoke.botSeedDefaults, async () => {
    const result = await host().call("bot.seedDefaults", {});
    sendToRenderer(IPC.event.botsChanged, { reason: "seeded" } satisfies BotsChangedEvent);
    return result;
  });

  handle(IPC.invoke.taskCardList, async (request) => {
    const { sessionId } = (request ?? {}) as { sessionId?: string };
    if (!sessionId) throw new Error("sessionId is required");
    return host().call("taskCard.list", { sessionId });
  });

  // The click. `cardHash` is the hash of the card the person was looking at, so
  // a revise between render and click is refused by the host instead of
  // approving text nobody read.
  handle(IPC.invoke.taskCardConfirm, async (request) => {
    const { draftId, cardHash, notifyOnCompletion } = (request ?? {}) as {
      draftId?: string;
      cardHash?: string;
      notifyOnCompletion?: boolean;
    };
    if (!draftId || !cardHash) throw new Error("draftId and cardHash are required");
    const result = (await host().call("taskCard.confirm", {
      draftId,
      cardHash,
      confirmedBy: "user",
      ...(typeof notifyOnCompletion === "boolean" ? { notifyOnCompletion } : {}),
      // The host scopes this key to (plugin, source session), so the draft id is
      // the natural identity: a retried click cannot dispatch the work twice.
      idempotencyKey: `taskcard-confirm:${draftId}`,
      policyVersion: "steward-1",
    })) as {
      draft?: TaskCardDraftView;
      delivery?: SessionCollaborationMessage;
      task?: TaskView;
    };
    // Confirming writes the delivery and stops there. Starting it is the same
    // step an ordinary send takes, so it goes through the same dispatch; without
    // it the work stays queued and the person sees a card that did nothing.
    // A start failure must not undo the person's decision: the card says the
    // work was dispatched but did not start, and the delivery keeps whatever
    // state the ledger recorded.
    let startError: string | undefined;
    if (result.delivery) {
      try {
        await sessionCollaboration.dispatchConfirmed(result.delivery);
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }
    }
    // The confirmed card created a task under its employee (the host does that
    // in the confirmation's own transaction), so the work now lives in that
    // task's session. Announced once, before anything else can report it.
    if (result.task) announceTask(result.task, "created");
    // A dispatch moves the task's stage from `queued` to `working`; the
    // reconcile reads it back rather than guessing, and emits once.
    await reconcileTaskStages();
    // The person's click is one of three ways a card changes; the emitter keeps
    // every direction on one channel, so the dock has a single thing to listen to.
    notifyTaskCardsChanged({
      sessionId: result.draft?.sessionId ?? "",
      draftId: draftId ?? "",
    });
    sendToRenderer(IPC.event.botsChanged, { reason: "status" } satisfies BotsChangedEvent);
    if (!result.draft) throw new Error("the host confirmed a card but returned no draft");
    return {
      draft: result.draft,
      deliveryId: result.delivery?.id ?? "",
      ...(startError ? { startError } : {}),
    } satisfies TaskCardConfirmResult;
  });

  // Tasks under an employee (ADR bot-sessions-and-steward §7). Creating one also
  // makes its session, so the renderer opens the session the host returned; the
  // first user message is sent afterwards through the normal send path.
  handle(IPC.invoke.taskCreate, async (request) => {
    const result = (await host().call("task.create", (request ?? {}) as Record<string, unknown>)) as
      TaskCreateResult;
    announceTask(result.task, "created");
    return result;
  });

  handle(IPC.invoke.taskList, async (request) =>
    host().call("task.list", (request ?? {}) as Record<string, unknown>),
  );

  handle(IPC.invoke.taskGet, async (request) =>
    host().call("task.get", (request ?? {}) as Record<string, unknown>),
  );

  handle(IPC.invoke.taskArchive, async (request) => {
    const result = (await host().call("task.archive", (request ?? {}) as Record<string, unknown>)) as
      TaskArchiveResult;
    announceTask(result.task, "archived");
    return result;
  });

  handle(IPC.invoke.taskCardDrop, async (request) => {
    const { draftId } = (request ?? {}) as { draftId?: string };
    if (!draftId) throw new Error("draftId is required");
    const result = (await host().call("taskCard.drop", { draftId })) as {
      draft?: { sessionId?: string };
    };
    notifyTaskCardsChanged({
      sessionId: result.draft?.sessionId ?? "",
      draftId,
    });
    return result;
  });
}
