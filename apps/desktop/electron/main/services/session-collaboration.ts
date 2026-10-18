import { randomUUID } from "node:crypto";
import type {
  AgentStatus,
  AppSettings,
  SessionCollaborationDelivery,
  SessionCollaborationMessage,
  SessionCollaborationSummary,
} from "@minih-agent/shared";
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
  log: (message: string, data: Record<string, unknown>) => void;
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

/** Coordinates reviewed operations; Rust owns all identity and outcome state. */
export function createSessionCollaborationService(deps: SessionCollaborationDependencies) {
  const dispatching = new Map<string, Promise<SessionCollaborationDelivery>>();
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

  async function dispatch(message: SessionCollaborationMessage, signal?: AbortSignal): Promise<SessionCollaborationDelivery> {
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
        await bridge.agentHost.startTurn(DESKTOP_PRINCIPAL, {
          sessionId: current.targetSessionId,
          input: { text: current.content, sessionMessageId: current.id },
          admission: "queue",
          idempotencyKey: `session-message:${current.id}`,
          context: { requestId: `session-message:${current.id}` },
        });
        checkCurrent(host);
        const accepted = (await host.call<{ message: SessionCollaborationMessage }>(
          "session.collaboration.message", { messageId: current.id },
        )).message;
        if (signal?.aborted) await cancel(host, { sessionId: current.targetSessionId, messageId: current.id });
        deps.onChanged();
        return delivery(accepted);
      } catch (error) {
        // A full callback inbox is deferred until a later queue/turn change.
        // It must not turn a successfully completed original task into failure.
        if (deps.getHost() === host && !(message.kind === "completion" && errorCode(error) === "AGENT_BUSY")) {
          // The host persists free text, so the code is embedded to keep the
          // stored failure machine-readable and bounded.
          const persisted = `${errorCode(error) ?? "FAILED"}: ${errorMessage(error)}`;
          await host.call("session.collaboration.fail", {
            messageId: message.id,
            error: persisted.slice(0, 2000),
          }).catch((persistenceError: unknown) => deps.log("Session delivery failure could not be saved", {
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
            for (const turnId of settlements) {
              // Settling is idempotent host-side, so entries recorded against a
              // previous host are replayed rather than dropped. A failing call
              // keeps its entry for a later drain.
              await host.call("session.collaboration.settle", { turnId });
              settlements.delete(turnId);
            }
          }
          const pending = await host.call<{ messages: SessionCollaborationMessage[] }>("session.collaboration.pending", {});
          checkCurrent(host);
          await Promise.all(pending.messages.map(async (message) => {
            try { await dispatch(message); }
            catch (error) {
              deps.log("Session completion delivery is pending or failed", { messageId: message.id, error: String(error) });
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
     * outlives its turn cannot authorise a later one. Spawning workers and
     * cancelling another sender's delivery stay plugin-only.
     */
    async invokeBuiltin(input: {
      sessionId: string;
      turnId: string;
      operation: "list" | "send" | "result";
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
          const notify = input.args.notifyOnCompletion;
          if (notify !== undefined && typeof notify !== "boolean") fail("INVALID_ARGUMENT", "notifyOnCompletion must be a boolean");
          // A task is the reason a user hands work to another session; a plain
          // message is the explicit exception.
          const kind = input.args.kind === undefined ? "task" : messageKind(input.args.kind);
          const sender: Sender = { ownerId: BUILTIN_SESSION_OWNER, sourceSessionId, sourceTurnId };
          const response = await host.call<{ message: SessionCollaborationMessage }>("session.collaboration.send", {
            ...senderFields(sender), content, kind,
            idempotencyKey: text(input.args, "idempotencyKey", false) ?? randomUUID(),
            ...(typeof notify === "boolean" ? { notifyOnCompletion: notify } : {}),
            sessionId: text(input.args, "sessionId"),
          });
          return dispatch(response.message, input.signal);
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
    drain,
  };
}

/** Surface Main's built-in session tools call; plugins never see it. */
export type SessionCollaborationService = ReturnType<typeof createSessionCollaborationService>;
