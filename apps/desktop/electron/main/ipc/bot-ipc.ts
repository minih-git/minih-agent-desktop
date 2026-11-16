import {
  IPC,
  type BotHireDraftResult,
  type BotsChangedEvent,
  type SessionCollaborationMessage,
  type TaskArchiveResult,
  type TaskCreateResult,
  type TaskDeliveryMergeResult,
  type TaskRelayDetachResult,
  type TaskRelayHandoffResult,
  type TaskReassignResult,
  type TaskView,
  type TeamNormsSetRequest,
} from "@minih-agent/shared";
import type { HostProcess } from "../host-process";
import type { HireDraftOutcome } from "../services/hire-draft";
import type { SessionCollaborationService } from "../services/session-collaboration";
import type { IpcRegistrar } from "./types";
import type { TaskChangeAnnouncer } from "../services/task-changes";
/** Employee, task, relay and notification IPC handlers. */
export function registerBotIpc({
  registrar,
  getHost,
  sendToRenderer,
  sessionCollaboration,
  onTaskArchived,
  tasks,
  draftHire,
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
  /**
   * A task left the open list — archived by the person, or archive-as-cleanup
   * after a merge. The lesson extractor drains what that archive owes; absent,
   * the archive is simply not announced to an extractor.
   */
  onTaskArchived?: () => void;
  /**
   * One-sentence hiring (slice 6). It returns a draft and writes nothing, so the
   * employee exists only after the person saves the form it filled.
   */
  draftHire: (utterance: string) => Promise<HireDraftOutcome>;
}): void {
  const { handle } = registrar;
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


  // One-sentence hiring (slice 6). A draft, never a create: the renderer fills
  // the form with it and the person still has to save it. A failure is thrown
  // with the message Main wrote, because it is addressed to the person ("the
  // Super Agent has no model yet"), not to a developer.
  handle(IPC.invoke.botDraftHire, async (request) => {
    const { utterance } = (request ?? {}) as { utterance?: string };
    const outcome = await draftHire(utterance ?? "");
    if (!outcome.ok) throw new Error(outcome.message);
    return { draft: outcome.draft } satisfies BotHireDraftResult;
  });

  // The team norms the person writes (slice 6). Both directions are host calls:
  // the rule set lives in the host's local key–value table, so the renderer
  // never sees a stale copy of another computer's settings.
  handle(IPC.invoke.teamNormsGet, async () => host().call("team.norms.get", {}));
  handle(IPC.invoke.teamNormsSet, async (request) => {
    const { norms } = (request ?? {}) as TeamNormsSetRequest;
    if (!norms) throw new Error("norms are required");
    return host().call("team.norms.set", { norms });
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
    // The archive owed one lesson extraction; this is the only place that knows
    // a person's click produced it.
    onTaskArchived?.();
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


  handle(IPC.invoke.taskReassign, async (request) => {
    const { taskId, employeeSessionId, reason } = (request ?? {}) as {
      taskId?: string;
      employeeSessionId?: string;
      reason?: string;
    };
    if (!taskId || !employeeSessionId) throw new Error("taskId and employeeSessionId are required");
    const result = (await host().call("task.reassign", {
      taskId,
      employeeSessionId,
      ...(reason ? { reason } : {}),
    })) as TaskReassignResult & { reassignedFrom?: TaskView };
    if (!result.task || !result.reassignedFrom) throw new Error("the host returned an incomplete reassignment");
    const content = result.task.sourceUtterance?.trim() || result.task.title;
    let startError: string | undefined;
    try {
      await sessionCollaboration.dispatchReassignedTask({
        sourceSessionId: result.reassignedFrom.employeeSessionId,
        targetSessionId: result.task.sessionId,
        content,
        idempotencyKey: `task-reassign:${result.reassignedFrom.id}:${result.task.id}`,
      });
    } catch (error) {
      startError = error instanceof Error ? error.message : String(error);
    }
    announceTask(result.task, "created");
    await reconcileTaskStages();
    sendToRenderer(IPC.event.botsChanged, { reason: "status" } satisfies BotsChangedEvent);
    return { task: result.task, reassignedFrom: result.reassignedFrom, ...(startError ? { startError } : {}) };
  });

  // The completion card (employee mode 0.5 slice 4b). Accepting is the person's
  // own click and nothing else: the host writes `accepted_at`, which is what
  // takes the task out of the sidebar's count without archiving it.
  handle(IPC.invoke.taskAccept, async (request) => {
    const { taskId } = (request ?? {}) as { taskId?: string };
    if (!taskId) throw new Error("taskId is required");
    const result = (await host().call("task.accept", { taskId })) as { task?: TaskView };
    if (result?.task) announceTask(result.task, "stage");
    return result;
  });

  // What the card shows, read once when it opens and again when the person
  // clicks 刷新. There is no poll: `gh` costs a round trip nobody asked for.
  handle(IPC.invoke.taskDeliveryCheck, async (request) => {
    const { taskId } = (request ?? {}) as { taskId?: string };
    if (!taskId) throw new Error("taskId is required");
    return host().call("task.delivery.check", { taskId });
  });

  // 「接受并合并」: the click is the confirmation, so the host runs its own fixed
  // steps and no permission card interrupts them. A failure comes back as a
  // blocked task rather than as a thrown error, because the person's next
  // action is the blocked card's own 重试.
  handle(IPC.invoke.taskDeliveryMerge, async (request) => {
    const { taskId } = (request ?? {}) as { taskId?: string };
    if (!taskId) throw new Error("taskId is required");
    const result = (await host().call(
      "task.delivery.merge",
      { taskId },
    )) as TaskDeliveryMergeResult;
    if (result?.task) announceTask(result.task, result.merged ? "archived" : "stage");
    // A merge archives the task as its cleanup step, so the lesson extraction it
    // owes is scheduled here too.
    if (result?.merged) onTaskArchived?.();
    await reconcileTaskStages();
    sendToRenderer(IPC.event.botsChanged, { reason: "status" } satisfies BotsChangedEvent);
    return result;
  });

  // Relay between steps (employee mode 0.5 slice 7). 「接受并交给下一棒」 is the
  // person's click on a finished step's card: the host records the handoff and
  // answers with the delivery of the step behind it, which was authorized when
  // that card was confirmed. Starting it is the ordinary dispatch, so a handoff
  // never asks the same person twice.
  handle(IPC.invoke.taskRelayHandoff, async (request) => {
    const { taskId } = (request ?? {}) as { taskId?: string };
    if (!taskId) throw new Error("taskId is required");
    const result = (await host().call("task.relay.handoff", { taskId })) as
      TaskRelayHandoffResult & { deliveries?: SessionCollaborationMessage[] };
    // The delivery of the step that follows this one, if it exists and has not
    // started. A start failure must not undo the handoff: the next step's card
    // shows what happened, and the person can start it from there.
    let startError: string | undefined;
    for (const delivery of result.deliveries ?? []) {
      try {
        await sessionCollaboration.dispatchConfirmed(delivery);
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }
    }
    if (result?.task) announceTask(result.task, "stage");
    await reconcileTaskStages();
    sendToRenderer(IPC.event.botsChanged, { reason: "status" } satisfies BotsChangedEvent);
    return {
      task: result.task,
      handedOffAt: result.handedOffAt,
      unlocked: result.unlocked ?? [],
      ...(startError ? { startError } : {}),
    } satisfies TaskRelayHandoffResult;
  });

  // 「改从 main 开工」 on a step whose predecessor is gone: the edge is dropped, the
  // workspace is built from the project's own main, and the delivery that was
  // waiting starts again. The person's own decision — nothing here is automatic.
  handle(IPC.invoke.taskRelayDetach, async (request) => {
    const { taskId } = (request ?? {}) as { taskId?: string };
    if (!taskId) throw new Error("taskId is required");
    const result = (await host().call("task.relay.detach", { taskId })) as
      TaskRelayDetachResult & { deliveries?: SessionCollaborationMessage[] };
    let startError: string | undefined;
    for (const delivery of result.deliveries ?? []) {
      try {
        await sessionCollaboration.dispatchConfirmed(delivery);
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
      }
    }
    if (result?.task) announceTask(result.task, "stage");
    await reconcileTaskStages();
    sendToRenderer(IPC.event.botsChanged, { reason: "status" } satisfies BotsChangedEvent);
    return { task: result.task, ...(startError ? { startError } : {}) };
  });

  // Which other open tasks in this repository are changing files. A hint the
  // card shows before work starts; it never blocks anything.
  handle(IPC.invoke.taskOverlap, async (request) =>
    host().call("task.overlap", (request ?? {}) as Record<string, unknown>),
  );


}
