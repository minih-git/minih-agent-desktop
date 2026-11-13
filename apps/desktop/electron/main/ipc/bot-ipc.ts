import {
  IPC,
  type BotsChangedEvent,
  type SessionCollaborationMessage,
  type TaskArchiveResult,
  type TaskCardConfirmResult,
  type TaskCardDraftView,
  type TaskCreateResult,
  type TaskView,
} from "@minih-agent/shared";
import type { HostProcess } from "../host-process";
import type { SessionCollaborationService } from "../services/session-collaboration";
import type { IpcRegistrar } from "./types";
import { taskCardsChangedSender } from "../services/task-cards-changed";
import type { TaskChangeAnnouncer } from "../services/task-changes";
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
  tasks,
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
  /**
   * The one writer of the task channel. Every direction a task can change —
   * this module's own calls, and the delivery settlements `session.collaboration`
   * performs — goes through this same object.
   */
  tasks: TaskChangeAnnouncer;
}): void {
  const { handle } = registrar;
  const notifyTaskCardsChanged = taskCardsChangedSender(sendToRenderer);
  const { announce: announceTask, reconcileStages: reconcileTaskStages } = tasks;
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
    // Renaming an employee also rewrites its session title, and the renderer
    // only re-reads the session list on this event — the conversation topbar
    // kept showing the old name until something else refreshed it.
    sendToRenderer(IPC.event.sessionsChanged, { reason: "bot.updated" });
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

  // A failed workspace preparation is retried from the task's own header; the
  // host prepares again in the same folder and answers with the row.
  handle(IPC.invoke.taskWorkspaceRetry, async (request) => {
    const result = (await host().call("task.workspace.retry", (request ?? {}) as Record<
      string,
      unknown
    >)) as { task?: TaskView };
    if (result?.task) announceTask(result.task, "stage");
    return result;
  });

  // Start a task again after the startup fence interrupted it (employee mode
  // 0.5 slice 3). The host writes a new delivery from the same mandate; starting
  // it is the same dispatch a confirmed card uses, and the person's click is the
  // authorization that it resumes.
  handle(IPC.invoke.taskRestart, async (request) => {
    const { taskId } = (request ?? {}) as { taskId?: string };
    if (!taskId) throw new Error("taskId is required");
    const result = (await host().call("task.restart", { taskId })) as {
      task?: TaskView;
      delivery?: SessionCollaborationMessage;
    };
    let startError: string | undefined;
    if (result.delivery) {
      try {
        await sessionCollaboration.dispatchConfirmed(result.delivery);
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }
    }
    if (result.task) announceTask(result.task, "stage");
    await reconcileTaskStages();
    return { task: result.task, ...(startError ? { startError } : {}) };
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

  // The person changes the employee on a proposed card (employee mode 0.5 slice
  // 3). It is their click, like confirming: the host narrows the card to what
  // the new employee may do, recomputes the hash, and leaves the card proposed,
  // so starting it is still a separate act nobody can do for them.
  handle(IPC.invoke.taskCardReassign, async (request) => {
    const { draftId, targetSessionId } = (request ?? {}) as {
      draftId?: string;
      targetSessionId?: string;
    };
    if (!draftId || !targetSessionId) throw new Error("draftId and targetSessionId are required");
    const result = (await host().call("taskCard.reassign", { draftId, targetSessionId })) as {
      draft?: TaskCardDraftView;
      repoAvailable?: boolean;
      projectPath?: string;
    };
    // The card on screen changed, so the dock has to re-read the version the
    // host now holds; a stale hash would refuse the person's next click.
    notifyTaskCardsChanged({ sessionId: result.draft?.sessionId ?? "", draftId });
    sendToRenderer(IPC.event.botsChanged, { reason: "status" } satisfies BotsChangedEvent);
    return result;
  });
}
