import { randomUUID } from "node:crypto";
import type {
  AgentStatus,
  AppSettings,
  SessionCollaborationDelivery,
  SessionCollaborationMessage,
  SessionCollaborationSummary,
  TaskView,
} from "@minih-agent/shared";
import {
  decodeMandate,
  encodeMandate,
  imageGenerationBindings,
  isImageGenerationModel,
  modelWireIdsEqual,
  taskStartsOnConfirm,
} from "@minih-agent/shared";
import { readTaskBoard } from "./task-status";
import { DESKTOP_PRINCIPAL, type AgentHostBridge } from "../agent-host-bridge";
import { listReadyPluginModels, parsePluginModelKey } from "../plugin-agent-complete";
import type { McpControlInvokeInput } from "../mcp-control";

type Host = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };
type Sidecar = { call<T>(method: string, params: Record<string, unknown>): Promise<T> };

/** Shared by the plugin and the sidebar: durable outcomes plus live activity. */
export async function readSessionCollaboration(
  host: Host,
  sidecar: Sidecar | null,
  sessionId: string,
): Promise<SessionCollaborationSummary> {
  const [summary, live] = await Promise.all([
    host.call<SessionCollaborationSummary>("session.collaboration.status", { sessionId }),
    sidecar?.call<{ status: AgentStatus }>("agent.getStatus", { sessionId }),
  ]);
  if (live?.status.sessionId === sessionId && live.status.isRunning) {
    return {
      ...summary,
      status: live.status.pendingToolConfirmations > 0 ? "waiting_permission" : "running",
      observedAt: new Date().toISOString(),
    };
  }
  return summary;
}

export type SessionCollaborationDependencies = {
  getHost: () => Host | null;
  getSidecar: () => Sidecar | null;
  getBridge: () => AgentHostBridge | null;
  getActiveTurn: (sessionId: string) => string | undefined;
  flushTranscript: () => Promise<boolean>;
  isPluginLoaded: (pluginId: string) => boolean;
  isQuitting: () => boolean;
  onChanged: () => void;
  /**
   * Announce the task stages a delivery move produced.
   *
   * A task's stage lives on its own row and moves inside the host transaction
   * that settles, fails or cancels a delivery — so a terminal path here is the
   * only signal Main ever gets. Without it the sidebar kept showing "working"
   * after the work had finished (#B4). Optional so a test double need not wire
   * it, and it never rejects: the announcer logs its own failures.
   */
  onTaskChanged?: () => Promise<void>;
  log: (message: string, data: Record<string, unknown>) => void;
  /**
   * This machine's stable identity, stamped into a task card's `requestedBy`.
   *
   * The Mandate records who asked, not where the work runs, so this is display
   * and audit data: it never authorizes anything and a wrong value cannot widen
   * permission. It stays optional so a test double need not supply one.
   */
  hostId?: () => string;
};

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, errorCode: code });
}

function text(input: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) fail("INVALID_ARGUMENT", `${key} must be a nonempty string`);
  return value.trim();
}

function messageKind(value: unknown): "task" | "message" {
  if (value === undefined) return "message";
  if (value !== "task" && value !== "message") fail("INVALID_ARGUMENT", "kind must be task or message");
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: string; errorCode?: string; data?: { errorCode?: string } };
  return value.data?.errorCode ?? value.errorCode ?? value.code;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error) ?? String(error); } catch { return String(error); }
}

/**
 * Failures that can plausibly succeed on the next attempt.
 *
 * `drain` keeps picking up whatever is still queued, so a failure that will never
 * succeed must be closed instead of retried forever: a target whose ceiling
 * refuses this work, a session that no longer exists, or a sender that was
 * switched off stays broken no matter how often we ask.
 *
 * Only "the runtime is not up yet" stays queued: the next drain will find it
 * running. Everything else keeps the existing behaviour of being recorded as a
 * failure — a busy target included, since the ledger already reports that
 * condition and `completion` keeps its own deferred treatment below.
 */
const TRANSIENT_DELIVERY_FAILURES = new Set(["HOST_UNAVAILABLE"]);

function isTransientDeliveryFailure(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && TRANSIENT_DELIVERY_FAILURES.has(code);
}

/** How a delivery enters the target session's queue. */
type SessionDeliveryMode = "queue" | "now";

/** A delivery plus whether `now` could promote it in the target's queue. */
type SessionDelivery = SessionCollaborationDelivery & { readonly inserted?: boolean };

/**
 * Validate the model-facing `delivery` argument.
 *
 * `now` reuses the queue's own send-now: after the delivery is queued, the
 * Host promotes it so it is steered into the target's running turn. It is a
 * send-time choice, never ledger state, so a replay after a restart falls back
 * to plain queueing instead of claiming an insertion.
 */
function deliveryMode(value: unknown): SessionDeliveryMode {
  if (value === undefined) return "queue";
  if (value !== "queue" && value !== "now") fail("INVALID_ARGUMENT", "delivery must be queue or now");
  return value;
}

function delivery(message: SessionCollaborationMessage): SessionCollaborationDelivery {
  return {
    sessionId: message.targetSessionId,
    messageId: message.id,
    status: message.status,
    ...(message.turnId ? { turnId: message.turnId } : {}),
  };
}

/**
 * Ledger owner for a delivery a built-in Agent tool started, never a plugin.
 *
 * Rust keys idempotency, ownership and completion callbacks by this value, so
 * it is reserved: Main's plugin path refuses a plugin context that presents it.
 */
export const BUILTIN_SESSION_OWNER = "builtin:session-messaging";

/**
 * A delivery's real origin.
 *
 * `ownerId` becomes the ledger's `plugin_id`, so every part of it must come
 * from an authenticated invocation context — never from tool arguments.
 */
type Sender = { ownerId: string; sourceSessionId: string; sourceTurnId: string };

function senderFields(sender: Sender): Record<string, string> {
  return {
    pluginId: sender.ownerId,
    sourceSessionId: sender.sourceSessionId,
    sourceTurnId: sender.sourceTurnId,
  };
}

/**
 * A task-card draft as host-core reports it (ADR bot-sessions-and-steward §3).
 *
 * `status` is the host's own word: a model cannot set it, and `confirmedBy`
 * distinguishes a person's click from the host's auto-start policy, so an audit
 * never has to trust what a caller claims.
 */
export type TaskCardDraftRecord = {
  id: string;
  sessionId: string;
  status: "proposed" | "confirmed" | "dropped";
  card: Record<string, unknown>;
  cardHash: string;
  sourceUtterance: string;
  targetSessionId: string;
  confirmedBy?: "user" | "policy";
  confirmedAt?: string;
  deliveryId?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * Confirm a freshly proposed card when — and only when — the host's own policy
 * allows starting it without a person.
 *
 * The decision is asked of the host (`taskCard.autoStart`), not computed here:
 * the rule reads the employee's stored `observe` flag and the card's narrowed
 * ceiling, and both live in host-core. A refusal leaves the card proposed, which
 * is what a person then sees in the UI.
 */
/**
 * Confirm a freshly proposed card when — and only when — the host's own policy
 * allows starting it without a person.
 *
 * The decision is asked of the host (`taskCard.autoStart`), not computed here:
 * the rule reads the employee's stored `observe` flag and the card's narrowed
 * ceiling, and both live in host-core. A refusal leaves the card proposed, which
 * is what a person then sees in the UI.
 *
 * A confirmation writes the delivery; starting it is a separate step, so it is
 * handed to the caller's `start` (the same `dispatch` an ordinary send uses).
 * Without that step the card is confirmed but nothing ever runs.
 */
async function autoConfirmIfAllowed(
  host: Host,
  draft: TaskCardDraftRecord,
  start: (message: SessionCollaborationMessage) => Promise<unknown>,
): Promise<TaskCardDraftRecord> {
  if (draft.status !== "proposed") return draft;
  const decision = await host.call<{ refusal?: string | null }>("taskCard.autoStart", {
    targetSessionId: draft.targetSessionId,
    card: draft.card,
  });
  if (decision.refusal) return draft;
  const started = await host.call<{
    draft: TaskCardDraftRecord;
    delivery?: SessionCollaborationMessage;
    task?: TaskView;
  }>("taskCard.confirm", {
    draftId: draft.id,
    cardHash: draft.cardHash,
    confirmedBy: "policy",
    policyVersion: "steward-1",
    notifyOnCompletion: true,
    // One confirmation per card: the draft id is the natural key, so a retried
    // auto-start cannot deliver the same work twice.
    idempotencyKey: `taskcard:${draft.id}`,
  });
  // A card that follows another is confirmed now and starts at that step's
  // handoff, not before (employee mode 0.5 slice 7). The policy decides whether
  // the person has to be asked; it never decides an order the steward declared.
  if (started.delivery && taskStartsOnConfirm(started.task)) await start(started.delivery);
  return started.draft;
}

/** Coordinates reviewed operations; Rust owns all identity and outcome state. */
export function createSessionCollaborationService(deps: SessionCollaborationDependencies) {
  const dispatching = new Map<string, Promise<SessionDelivery>>();
  // Turn IDs awaiting settlement. The host keys the receipt by the turn row in
  // its own database, so an entry orphaned by a host restart is replayed there.
  const settlements = new Set<string>();
  let draining: Promise<void> | undefined;
  let dirty = false;

  function requireHost(): Host {
    if (deps.isQuitting()) fail("ABORTED", "The application is shutting down");
    const host = deps.getHost();
    if (!host) fail("HOST_UNAVAILABLE", "The host is unavailable");
    return host;
  }

  function checkCurrent(host: Host, signal?: AbortSignal): void {
    if (signal?.aborted || deps.isQuitting()) fail("ABORTED", "The session operation was cancelled");
    if (deps.getHost() !== host) fail("HOST_UNAVAILABLE", "The host restarted during the session operation");
  }

  function sender(input: McpControlInvokeInput): Sender {
    const context = input.pluginContext;
    if (!context?.sessionId || !context.turnId || !context.invocationId
      || deps.getActiveTurn(context.sessionId) !== context.turnId) {
      fail("PERMISSION_DENIED", "Sending requires an active, host-authenticated Agent tool invocation");
    }
    // The built-in owner is Main's own; a plugin adopting it would receive
    // built-in deliveries' completion callbacks.
    if (context.pluginId === BUILTIN_SESSION_OWNER) {
      fail("PERMISSION_DENIED", "The session collaboration owner is reserved");
    }
    return { ownerId: context.pluginId, sourceSessionId: context.sessionId, sourceTurnId: context.turnId };
  }

  /**
   * Promote a just-queued delivery to the head of its target's queue.
   *
   * A refusal is not a failed delivery: the message stays queued behind the
   * target's current work, and the caller reports that instead of claiming an
   * insertion the running turn did not take.
   */
  async function promote(bridge: AgentHostBridge, turnId: string): Promise<boolean> {
    try {
      await bridge.queue.prioritize(turnId);
      return true;
    } catch (error) {
      deps.log("Session delivery could not be promoted into the running turn", {
        turnId,
        error: errorMessage(error),
      });
      return false;
    }
  }

  async function dispatch(
    message: SessionCollaborationMessage,
    signal?: AbortSignal,
    mode: SessionDeliveryMode = "queue",
  ): Promise<SessionDelivery> {
    const existing = dispatching.get(message.id);
    if (existing) return existing;
    const operation = (async () => {
      const host = requireHost();
      try {
        checkCurrent(host, signal);
        const current = (await host.call<{ message?: SessionCollaborationMessage }>(
          "session.collaboration.message", { messageId: message.id },
        )).message;
        checkCurrent(host, signal);
        if (!current) fail("NOT_FOUND", "Session message not found");
        if (current.status !== "queued") return delivery(current);
        const bridge = deps.getBridge();
        if (!bridge || !deps.getSidecar()) fail("HOST_UNAVAILABLE", "The Agent runtime is unavailable");
        if (bridge.queue.list(current.targetSessionId).some((entry) => entry.sessionMessageId === current.id)) {
          return delivery(current);
        }
        // A built-in delivery has no plugin row to look up: its sender is the
        // desktop itself.
        if (current.pluginId !== BUILTIN_SESSION_OWNER && !deps.isPluginLoaded(current.pluginId)) {
          fail("ABORTED", "The sending plugin is no longer enabled");
        }
        // beginTurn rechecks the persisted authorization ceiling at execution,
        // including when a queued turn resumes after settings have changed.
        const started = await bridge.agentHost.startTurn(DESKTOP_PRINCIPAL, {
          sessionId: current.targetSessionId,
          input: { text: current.content, sessionMessageId: current.id },
          admission: "queue",
          idempotencyKey: `session-message:${current.id}`,
          context: { requestId: `session-message:${current.id}` },
        });
        // A busy target queues the delivery, so `now` promotes it and the Host
        // steers it into the running turn; an idle target already started its
        // own turn and has nothing to promote.
        const inserted =
          mode === "now" && started?.turn?.status === "queued"
            ? await promote(bridge, started.turn.id)
            : false;
        checkCurrent(host);
        const accepted = (await host.call<{ message: SessionCollaborationMessage }>(
          "session.collaboration.message", { messageId: current.id },
        )).message;
        if (signal?.aborted) await cancel(host, { sessionId: current.targetSessionId, messageId: current.id });
        deps.onChanged();
        return inserted ? { ...delivery(accepted), inserted } : delivery(accepted);
      } catch (error) {
        // Only a failure that can never succeed closes the delivery. A busy
        // target or an unavailable runtime leaves it queued, so the next drain
        // retries it instead of the person losing the work to a temporary
        // condition. A full callback inbox is likewise deferred until a later
        // queue/turn change: it must not turn a completed task into a failure.
        const deferredCompletion =
          message.kind === "completion" && errorCode(error) === "AGENT_BUSY";
        if (deps.getHost() === host && !deferredCompletion && !isTransientDeliveryFailure(error)) {
          // The host persists free text, so the code is embedded to keep the
          // stored failure machine-readable and bounded.
          const persisted = `${errorCode(error) ?? "FAILED"}: ${errorMessage(error)}`;
          await host.call("session.collaboration.fail", {
            messageId: message.id,
            error: persisted.slice(0, 2000),
          })
            .then(() => deps.onTaskChanged?.())
            .catch((persistenceError: unknown) => deps.log("Session delivery failure could not be saved", {
              messageId: message.id, error: String(persistenceError),
            }));
        }
        throw error;
      }
    })();
    dispatching.set(message.id, operation);
    try { return await operation; }
    finally { if (dispatching.get(message.id) === operation) dispatching.delete(message.id); }
  }

  async function cancel(host: Host, args: Record<string, unknown>) {
    const result = await host.call<{
      sessionId: string; cancelled: true; sessionRetained: true; messageIds: string[]; runningTurnIds: string[];
    }>("session.collaboration.cancel", args);
    checkCurrent(host);
    const bridge = deps.getBridge();
    if (bridge) {
      for (const messageId of result.messageIds) await bridge.queue.cancelSessionMessage(result.sessionId, messageId);
      for (const turnId of result.runningTurnIds) {
        // The exact turn guard prevents a late cancellation from stopping a
        // newer task in this reusable session.
        if (deps.getActiveTurn(result.sessionId) === turnId) {
          await bridge.interruptSessionMessage(result.sessionId, turnId);
        }
      }
    }
    deps.onChanged();
    // Cancelled work is not the person's turn and nothing is running, so the
    // task's stage moved with the delivery: announce it through the one exit.
    await deps.onTaskChanged?.();
    return { sessionId: result.sessionId, cancelled: true, sessionRetained: true };
  }

  async function drain(): Promise<void> {
    // Re-entrant, self-healing: a caller arriving while a pass is running flags
    // dirty and awaits it, then re-checks. This also closes the narrow window
    // where a settlement is queued right as a running pass decides to stop, so a
    // completion callback is never deferred to an unrelated later trigger.
    for (;;) {
      if (draining) {
        dirty = true;
        await draining;
        if (!dirty) return;
        continue;
      }
      if (!deps.getHost() || deps.isQuitting()) return;
      draining = (async () => {
        do {
          // Cleared first so a throwing pass cannot keep re-running the loop.
          dirty = false;
          const host = requireHost();
          if (settlements.size && await deps.flushTranscript()) {
            checkCurrent(host);
            let settled = 0;
            for (const turnId of settlements) {
              // Settling is idempotent host-side, so entries recorded against a
              // previous host are replayed rather than dropped. A failing call
              // keeps its entry for a later drain.
              await host.call("session.collaboration.settle", { turnId });
              settlements.delete(turnId);
              settled += 1;
            }
            // A settled turn is a stage change: finished work now waits for the
            // person, a failure is the machine's. One reconcile per pass, after
            // the loop, so several settlements in one pass cost one host read.
            if (settled > 0) await deps.onTaskChanged?.();
          }
          // Everything that still needs a turn: a completion callback, or a
          // confirmed card nobody started (a start that failed, or an app that
          // closed between confirm and start). `dispatch` skips a row that
          // already has a turn, so a replay cannot run the same work twice.
          const pending = await host.call<{ messages: SessionCollaborationMessage[] }>(
            "session.collaboration.pendingDispatch",
            {},
          );
          checkCurrent(host);
          await Promise.all(pending.messages.map(async (message) => {
            try { await dispatch(message); }
            catch (error) {
              deps.log("Session delivery is pending or failed", { messageId: message.id, kind: message.kind, error: String(error) });
            }
          }));
        } while (dirty);
      })();
      try { await draining; }
      finally { draining = undefined; }
      if (dirty) continue;
      return;
    }
  }

  return {
    async invoke(input: McpControlInvokeInput): Promise<unknown> {
      if (input.source !== "plugin" || !input.pluginContext?.pluginId) {
        fail("PERMISSION_DENIED", "Session collaboration requires a trusted plugin context");
      }
      const args = input.args?.[0];
      if (input.args?.length !== 1 || !args || typeof args !== "object" || Array.isArray(args)) {
        fail("INVALID_ARGUMENT", "One session operation object is required");
      }
      const data = args as Record<string, unknown>;
      const host = requireHost();
      checkCurrent(host, input.signal);
      switch (input.operation) {
        case "session/collaboration/status":
          await drain();
          return readSessionCollaboration(host, deps.getSidecar(), text(data, "sessionId")!);
        case "session/collaboration/list":
          await drain();
          return host.call("session.collaboration.list", {});
        case "session/collaboration/result":
          await drain();
          return host.call("session.collaboration.result", {
            sessionId: text(data, "sessionId"), messageId: text(data, "messageId", false), turnId: text(data, "turnId", false),
          });
        case "session/collaboration/cancel": {
          const result = await cancel(host, {
            sessionId: text(data, "sessionId"), messageId: text(data, "messageId", false),
            pluginId: input.pluginContext.pluginId,
            ...(input.pluginContext.sessionId ? { sourceSessionId: input.pluginContext.sessionId } : {}),
          });
          await drain();
          return result;
        }
        case "session/collaboration/spawn":
        case "session/collaboration/send": {
          const source = sender(input);
          const spawn = input.operation.endsWith("/spawn");
          const content = text(data, spawn ? "task" : "content");
          const notify = data.notifyOnCompletion;
          if (notify !== undefined && typeof notify !== "boolean") fail("INVALID_ARGUMENT", "notifyOnCompletion must be a boolean");
          let model: { providerId: string; modelId: string } | null = null;
          if (spawn) {
            const [listed, settings] = await Promise.all([
              host.call<{ providers: Parameters<typeof listReadyPluginModels>[0] }>("providers.list", { includeDisabled: false }),
              host.call<AppSettings>("settings.get"),
            ]);
            checkCurrent(host, input.signal);
            const models = listReadyPluginModels(listed.providers, settings);
            const requested = text(data, "modelKey", false);
            // No isDefault fallback here: naming a default the user never
            // opted into delegation would spend a model the Task gate
            // refuses (issue #1183). Omitting modelKey must fall back to the
            // spawn path's own inheritance, not to an un opted-in default.
            const chosen = requested
              ? models.find((item) => item.key === requested)
              : models.find((item) => item.availableForSubagents);
            if (!chosen) fail("MODEL_NOT_CONFIGURED", "No matching configured model is available");
            // A worker the agent starts is AI-driven delegation, so naming a model here
            // needs that model's own `availableForSubagents` opt-in — the gate `Task.model`
            // already applies (ADR subagent-model-opt-in; #386). Inheriting stays open, and
            // naming the default is that inheritance spelled out, the way repeating a
            // definition's own pin is on the Task path.
            if (requested && !chosen.availableForSubagents && !chosen.isDefault) {
              fail("PERMISSION_DENIED", `Model "${requested}" is not enabled for AI delegation. Turn on "Available for AI delegation" for it in model settings, or omit modelKey to inherit.`);
            }
            model = parsePluginModelKey(chosen.key);
          }
          checkCurrent(host, input.signal);
          sender(input);
          const response = await host.call<{ message: SessionCollaborationMessage }>(`session.collaboration.${spawn ? "spawn" : "send"}`, {
            ...senderFields(source), content,
            idempotencyKey: text(data, "idempotencyKey", false) ?? randomUUID(),
            ...(typeof notify === "boolean" ? { notifyOnCompletion: notify } : {}),
            ...(spawn ? { ...model, title: text(data, "title", false) }
              : { sessionId: text(data, "sessionId"), kind: messageKind(data.kind) }),
          });
          return dispatch(response.message, input.signal);
        }
        default: fail("NOT_FOUND", "Unknown session collaboration operation");
      }
    },
    /**
     * Delivery path for Main's own Agent tools rather than a plugin.
     *
     * The calling session and turn both come from the sidecar's local-tool
     * context, so a model cannot claim another sender, and an approval that
     * outlives its turn cannot authorise a later one. Spawning a worker for a
     * plugin and cancelling another sender's delivery stay plugin-only; the
     * built-in `create` operation makes an ordinary Agent session instead.
     */
    async invokeBuiltin(input: {
      sessionId: string;
      turnId: string;
      operation:
        | "list"
        | "send"
        | "result"
        | "create"
        | "propose"
        | "revise"
        | "drop"
        // The steward's two reads (employee mode 0.5 slice 3): her roster, and
        // the task board. Both stay out of the sidecar's allowlist, so the model
        // cannot call `bot.*` / `task.*` itself; these operations are how the
        // tools she does have reach them.
        | "roster"
        | "taskStatus";
      args: Record<string, unknown>;
      signal?: AbortSignal;
    }): Promise<unknown> {
      const sourceSessionId = input.sessionId.trim();
      if (!sourceSessionId) fail("PERMISSION_DENIED", "A session tool requires an active Agent session");
      const sourceTurnId = input.turnId.trim();
      if (!sourceTurnId) fail("PERMISSION_DENIED", "Sending requires an active Agent turn");
      // The same rule the plugin path applies: the invocation's own turn must
      // still own the session. Without it a stale approval would be delivered
      // under whatever turn happens to run next.
      if (deps.getActiveTurn(sourceSessionId) !== sourceTurnId) {
        fail("PERMISSION_DENIED", "The requesting turn is no longer active");
      }
      const host = requireHost();
      checkCurrent(host, input.signal);
      switch (input.operation) {
        case "list":
          await drain();
          return host.call("session.collaboration.list", {});
        case "roster":
          // The steward must not see herself among the people she hands work
          // to; the host applies that from the caller's own session id.
          return host.call("bot.roster", { sessionId: sourceSessionId });
        case "taskStatus": {
          const board = await readTaskBoard((method, params) => host.call(method, params));
          const only = text(input.args, "employeeSessionId", false);
          return only
            ? { ...board, tasks: board.tasks.filter((task) => task.employeeSessionId === only) }
            : board;
        }
        case "result": {
          const messageId = text(input.args, "messageId", false);
          await drain();
          const outcome = await host.call<{
            ready?: boolean;
            message?: SessionCollaborationMessage | null;
          }>("session.collaboration.result", {
            sessionId: text(input.args, "sessionId"),
            messageId,
          });
          const message = outcome.message;
          // A built-in read reports only this session's own deliveries: another
          // sender's task text is not this session's to read, and it must not
          // enter this context as if it were.
          if (message && message.sourceSessionId !== sourceSessionId) {
            if (messageId) fail("PERMISSION_DENIED", "That delivery was sent by another session");
            return { ready: false, message: null };
          }
          return outcome;
        }
        case "send": {
          const content = text(input.args, "content");
          // A steward addresses the task, not the session (slice 3): the host
          // names the task's own session, and an archived or unknown task is
          // refused here rather than delivered to a session she guessed at.
          const taskId = text(input.args, "taskId", false);
          let targetSessionId = text(input.args, "sessionId", false);
          if (taskId) {
            const fetched = await host.call<{ task?: { sessionId?: string; archivedAt?: string; shortId?: string } }>(
              "task.get",
              { taskId },
            );
            const task = fetched?.task;
            if (!task?.sessionId) fail("TASK_NOT_FOUND", `No task with id ${taskId}.`);
            if (task.archivedAt) {
              fail(
                "TASK_ARCHIVED",
                `Task #${task.shortId ?? ""} is archived, so nothing runs in it any more. Ask the person whether to start a new task.`,
              );
            }
            targetSessionId = task.sessionId;
          }
          if (!targetSessionId) fail("INVALID_ARGUMENT", "`taskId` or `sessionId` is required");
          const notify = input.args.notifyOnCompletion;
          if (notify !== undefined && typeof notify !== "boolean") fail("INVALID_ARGUMENT", "notifyOnCompletion must be a boolean");
          // A task is the reason a user hands work to another session; a plain
          // message is the explicit exception.
          const kind = input.args.kind === undefined ? "task" : messageKind(input.args.kind);
          const mode = deliveryMode(input.args.delivery);
          const sender: Sender = { ownerId: BUILTIN_SESSION_OWNER, sourceSessionId, sourceTurnId };
          // A confirmed task card travels with the delivery: the host writes it
          // in the same row, so an authorized delivery is never briefly an
          // unauthorized one (ADR bot-sessions-and-steward §3).
          let mandate: string | undefined;
          if (input.args.mandate !== undefined) {
            const decoded = decodeMandate(input.args.mandate);
            if (!decoded.ok) {
              fail("INVALID_ARGUMENT", `The mandate is not a valid task card: ${decoded.reason}`);
            }
            mandate = encodeMandate(decoded.mandate);
          }
          const response = await host.call<{ message: SessionCollaborationMessage }>("session.collaboration.send", {
            ...senderFields(sender), content, kind,
            idempotencyKey: text(input.args, "idempotencyKey", false) ?? randomUUID(),
            ...(typeof notify === "boolean" ? { notifyOnCompletion: notify } : {}),
            ...(mandate ? { mandate } : {}),
            sessionId: targetSessionId,
            // Kept so the host can apply `require_open_task` to a bot target: a
            // follow-up that names the task it continues is authorized by it.
            ...(taskId ? { taskId } : {}),
          });
          return dispatch(response.message, input.signal, mode);
        }
        case "create": {
          const title = text(input.args, "title");
          const [settings, listed, source] = await Promise.all([
            host.call<AppSettings>("settings.get"),
            host.call<{ providers: Parameters<typeof listReadyPluginModels>[0] }>(
              "providers.list",
              { includeDisabled: false },
            ),
            // Only the project and thinking level are wanted, so the transcript
            // is not loaded to create a session.
            host.call<{ session?: { projectPath?: string; thinkingLevel?: string } }>(
              "session.get",
              { id: sourceSessionId, messageLimit: 1 },
            ),
          ]);
          checkCurrent(host, input.signal);
          const binding = settings?.sessionCreateModel;
          if (!binding?.providerId || !binding?.modelId) {
            fail(
              "MODEL_NOT_CONFIGURED",
              "No session creation model is configured. Choose one in Settings > AI (session creation model) before creating a session.",
            );
          }
          // The same ready-model catalog the settings row offers, minus the
          // image models it excludes, so a pairing the row shows as unavailable
          // can never create a session either. Both sides resolve that set with
          // the shared image helper, and the row adds nothing of its own. The
          // choice is the user's, never the model's: no argument can name it.
          const imageModels = imageGenerationBindings(
            settings.imageGenerationModels,
            settings.imageGeneration,
          );
          const chosen = listReadyPluginModels(listed.providers, settings)
            .filter((item) => !isImageGenerationModel(imageModels, item.providerId, item.modelId))
            .find((item) =>
              item.providerId === binding.providerId && modelWireIdsEqual(item.modelId, binding.modelId),
            );
          if (!chosen) {
            fail(
              "MODEL_UNAVAILABLE",
              `The configured session creation model "${binding.providerId}/${binding.modelId}" is not available. Pick another one in Settings > AI.`,
            );
          }
          const created = await host.call<{ session?: { id?: string; title?: string } }>("session.create", {
            title,
            mode: "agent",
            providerId: binding.providerId,
            modelId: binding.modelId,
            // A hand-off belongs in the session's own project, and a session
            // the Agent creates must not carry a wider permission mode than
            // the one it was started from.
            ...(source.session?.projectPath ? { projectPath: source.session.projectPath } : {}),
            ...(source.session?.thinkingLevel ? { thinkingLevel: source.session.thinkingLevel } : {}),
            inheritPermissionFromSessionId: sourceSessionId,
          });
          checkCurrent(host, input.signal);
          const createdId = created.session?.id;
          if (!createdId) fail("FAILED", "The host did not return the created session");
          deps.onChanged();
          return { sessionId: createdId, title: created.session?.title ?? title };
        }
        case "propose": {
          const targetSessionId = text(input.args, "targetSessionId");
          if (targetSessionId === sourceSessionId) {
            fail("INVALID_ARGUMENT", "A card cannot target its own session");
          }
          const result = await host.call<{ draft: TaskCardDraftRecord; created?: boolean }>(
            "taskCard.propose",
            {
              sessionId: sourceSessionId,
              targetSessionId,
              sourceUtterance: text(input.args, "sourceUtterance"),
              card: input.args.card,
              // The turn, not the card: one sentence split into three cards is
              // one batch, and the summary card appears when all three finish.
              batchId: sourceTurnId,
              // The card this one follows, when the steward declared an order
              // (employee mode 0.5 slice 7). The host validates the edge: same
              // batch, no loop, one repository, at most five steps.
              after: text(input.args, "after"),
            },
          );
          // Auto-start is the host's own rule, never the model's judgement: a
          // narrow card for an employee that is not observing is dispatched at
          // once and recorded as confirmed by policy (ADR §4).
          const confirmed = await autoConfirmIfAllowed(
            host,
            result.draft,
            (message) => dispatch(message, input.signal),
          );
          return { draft: confirmed };
        }
        case "revise": {
          const result = await host.call<{ draft: TaskCardDraftRecord }>("taskCard.revise", {
            draftId: text(input.args, "draftId"),
            card: input.args.card,
            // Re-checked by the host like a first proposal: either side of the
            // edge can have moved since the card was proposed.
            after: text(input.args, "after"),
          });
          return { draft: result.draft };
        }
        case "drop": {
          const result = await host.call<{ draft: TaskCardDraftRecord }>("taskCard.drop", {
            draftId: text(input.args, "draftId"),
          });
          return { draft: result.draft };
        }
        default:
          return fail("NOT_FOUND", "Unknown session tool operation");
      }
    },
    // The session ID stays part of the runtime callback contract; the host
    // resolves the receipt from the turn ID alone.
    async settle(_sessionId: string, turnId: string): Promise<void> {
      const host = deps.getHost();
      if (!host || deps.isQuitting()) return;
      settlements.add(turnId);
      // Let final message_end enqueues from this event-loop turn reach the outbox.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await drain();
      deps.onChanged();
    },
    /**
     * Start a delivery a confirmed card produced.
     *
     * Confirming a card writes the ledger row inside the host's transaction, and
     * that is all it does: the row stays `queued` until something starts a turn
     * in the target session. An ordinary `SessionSend` starts it right after
     * sending, so a confirmed card must go through the same `dispatch` — not a
     * second starter — or the work sits queued forever, which is exactly what
     * happened to the card the user confirmed.
     *
     * `dispatch` already owns deduplication (`dispatching`), the re-check of the
     * persisted ceiling, and failed-delivery bookkeeping, so a retried
     * confirmation and a concurrent drain cannot start the same work twice.
     */
    dispatchConfirmed(
      message: SessionCollaborationMessage,
      signal?: AbortSignal,
    ): Promise<SessionDelivery> {
      return dispatch(message, signal);
    },
    drain,
    /**
     * Identity a confirmed card is stamped with, or undefined when this build
     * has no host identity to offer. It is audit data only and never an
     * authorization, so an absent value is honest and better than a guess.
     */
    taskCardHostId: (): string | undefined => deps.hostId?.(),
  };
}

/** Surface Main's built-in session tools call; plugins never see it. */
export type SessionCollaborationService = ReturnType<typeof createSessionCollaborationService>;
