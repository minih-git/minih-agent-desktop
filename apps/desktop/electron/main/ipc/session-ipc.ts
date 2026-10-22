import { shell } from "electron";
import { isAbsolute, join, relative, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import {
  ErrorCodes,
  IPC,
  modelConfigImportKey,
  publicModelConfigCandidate,
  draftMatchesExisting,
  providerCreateInputFromDraft,
  isModelConfigImportSource,
  type ModelConfigImportDraft,
  type Mode,
  type SessionThinkingLevel,
} from "@minih-agent/shared";
import {
  convertSession,
  scanAllSources,
  scanModelConfigs,
  type ExternalSessionSummary,
  type ExternalSource,
} from "../importers";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PersistenceOutbox } from "../persistence-outbox";
import type { PluginRuntime } from "../plugin-runtime";
import { readSessionCollaboration } from "../services/session-collaboration";
import { searchSessionsAcrossSources } from "../services/session-search";
import type { IpcRegistrar } from "./types";
import { getActiveRemoteHostsBoot } from "../bootstrap/remote-hosts.js";

type RuntimeSession = {
  id?: string;
  projectPath?: string | null;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: SessionThinkingLevel;
  [key: string]: unknown;
};

let scannedImportSessions = new Map<string, ExternalSessionSummary>();
let scannedModelConfigs = new Map<string, ModelConfigImportDraft>();

const IMPORT_SOURCES = new Set<ExternalSource>([
  "claude-code",
  "opencode",
  "codex",
  "pi",
]);

function importSelectionKey(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const source = Reflect.get(value, "source");
  const externalId = Reflect.get(value, "externalId");
  if (
    typeof source !== "string" ||
    !IMPORT_SOURCES.has(source as ExternalSource) ||
    typeof externalId !== "string" ||
    !externalId
  ) {
    return null;
  }
  return `${source}:${externalId}`;
}

function rejectNativeMutation(sessionId: unknown, action: string): void {
  if (typeof sessionId === "string" && sessionId.startsWith("native-pi:")) {
    throw Object.assign(new Error(`Native Pi session ${action} is not supported`), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
}

function modelConfigSelectionKey(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const source = Reflect.get(value, "source");
  const externalId = Reflect.get(value, "externalId");
  if (
    !isModelConfigImportSource(source) ||
    typeof externalId !== "string" ||
    !externalId
  ) {
    return null;
  }
  return modelConfigImportKey(source, externalId);
}

export type SessionIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  dataDir: string;
  activeTurns: ReadonlyMap<string, string>;
  sessionProjects: Map<string, string | null>;
  persistenceOutbox: PersistenceOutbox;
  logger: Pick<Logger, "app">;
  plugins: Pick<PluginRuntime, "broadcastEvent">;
  sessionCapabilityContext: () => Promise<{ providers: any; defaults: any }>;
  enrichSession: (session: any, providers: any, defaults: any) => any;
  acquireSessionOperation: (sessionId: string) => Promise<() => void>;
  beginTranscriptRewrite: (sessionId: string) => {
    commit: () => void;
    rollback: () => void;
  };
  forgetTranscriptRewriteHistory: (sessionId: string) => void;
  stripWinLongPrefix: (path: string) => string;
  /**
   * Drop any pending extraction for a deleted session, so a debounce timer
   * cannot outlive the conversation it belonged to
   * (ADR agent-long-term-memory §4).
   */
  cancelMemoryExtraction?: (sessionId: string) => void;
  /**
   * Tell the RACP Host that a title this handler wrote has landed. A phone
   * holding the session refreshes its header from the resulting
   * `session.changed`; without it the old name stayed on screen.
   */
  announceTitleChange?: (sessionId: string) => void;
};

export function registerSessionIpc({
  registrar,
  getHost,
  getSidecar,
  dataDir,
  activeTurns,
  sessionProjects,
  persistenceOutbox,
  logger,
  plugins,
  sessionCapabilityContext,
  enrichSession,
  acquireSessionOperation,
  beginTranscriptRewrite,
  forgetTranscriptRewriteHistory,
  stripWinLongPrefix,
  cancelMemoryExtraction,
  announceTitleChange,
}: SessionIpcDependencies): void {
  let host: HostProcess | null = null;
  let sidecar: AgentSidecar | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      sidecar = getSidecar();
      return fn(...args);
    });
  };

  /**
   * The one gate for the two transcript-rewrite entrances — replacement and
   * revision activation rewrite the same host-side transcript rows, so both
   * go through this boundary instead of each entrance remembering its own
   * (#1612, #1613): refuse while a turn is running (consistent with fork and
   * move), serialize overlapping operations per session, and drain the
   * persistence outbox so writes queued before the rewrite land in the old
   * transcript rather than replaying into the new one. The persistence fence
   * also holds callbacks delivered after that drain: successful rewrites
   * invalidate pre-rewrite turns, while failed rewrites replay their events.
   * The sidecar runtime is dropped after the drain so the next prompt reseeds
   * from the rewritten transcript instead of replaying the discarded branch
   * in memory.
   */
  const runTranscriptRewrite = async <T>(
    sessionId: string,
    purpose: string,
    currentHost: HostProcess,
    run: () => Promise<T>,
  ): Promise<T> => {
    rejectNativeMutation(sessionId, purpose);
    const releaseSessionOperation = await acquireSessionOperation(sessionId);
    let rewriteFence: ReturnType<typeof beginTranscriptRewrite> | undefined;
    try {
      if (activeTurns.has(sessionId)) {
        throw Object.assign(
          new Error("Cannot rewrite the transcript of a running session"),
          { errorCode: ErrorCodes.AGENT_BUSY },
        );
      }
      rewriteFence = beginTranscriptRewrite(sessionId);
      await persistenceOutbox.prepareSessionReplacement(sessionId, () => currentHost);
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(sessionId);
        sidecar.clearVendorAuthBindings(sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId })
          .catch(() => undefined);
      }
      const result = await run();
      rewriteFence.commit();
      return result;
    } catch (error) {
      rewriteFence?.rollback();
      throw error;
    } finally {
      releaseSessionOperation();
    }
  };

  handle(IPC.invoke.sessionSearch, async (input) => {
    if (!host) throw new Error("host unavailable");
    return searchSessionsAcrossSources(host, sidecar, input);
  });
  handle(IPC.invoke.sessionSearchContext, async (input) => {
    if (!host) throw new Error("host unavailable");
    return host.call("search.context", input);
  });
  handle(IPC.invoke.todosGet, async (input: { sessionId?: unknown } = {}) => {
    if (!host) throw new Error("host unavailable");
    if (typeof input.sessionId !== "string" || !input.sessionId.trim()) {
      throw Object.assign(new Error("sessionId is required"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    return host.call("todos.get", { sessionId: input.sessionId });
  });
  handle(IPC.invoke.sessionList, async () => {
    if (!host) throw new Error("host unavailable");
    const [result, native, { providers, defaults }] = await Promise.all([
      host.call<{ sessions: RuntimeSession[] }>("session.list"),
      sidecar
        ? sidecar.call<{ sessions: RuntimeSession[] }>("native.session.list").catch(() => ({ sessions: [] }))
        : Promise.resolve({ sessions: [] }),
      sessionCapabilityContext(),
    ]);
    return {
      ...result,
      sessions: [
        ...result.sessions.map((session) => ({
          ...enrichSession(session, providers, defaults),
          source: "desktop",
        })),
        ...native.sessions,
        ...(getActiveRemoteHostsBoot()?.sessionSummaries() ?? []),
      ].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    };
  });
  handle(IPC.invoke.sessionCreate, async (input = {}) => {
    if (!host) throw new Error("host unavailable");
    const capabilityPromise = sessionCapabilityContext();
    const res = await host.call<{ session?: (RuntimeSession & { id?: string }) | null }>(
      "session.create",
      input,
    );
    logger.app("session", "info", "session created", { sessionId: res.session?.id });
    if (!res.session) return res;
    const { providers, defaults } = await capabilityPromise;
    return { ...res, session: enrichSession(res.session, providers, defaults) };
  });
  handle(
    IPC.invoke.sessionFork,
    async (
      input: { sessionId?: string; title?: string; throughMessageId?: string } = {},
    ) => {
      const sessionId = String(input.sessionId ?? "").trim();
      if (sessionId.startsWith("native-pi:")) {
        // Native forks read the canonical JSONL and publish a new child file in
        // the sidecar; the Rust host and the Desktop queue are never involved.
        if (!sidecar) throw new Error("sidecar unavailable");
        const title = typeof input.title === "string" ? input.title.trim().replace(/\s+/g, " ").slice(0, 200) : "";
        const throughMessageId =
          typeof input.throughMessageId === "string" ? input.throughMessageId.trim() : "";
        if (throughMessageId.length > 256) {
          throw Object.assign(new Error("throughMessageId is too long"), {
            errorCode: ErrorCodes.INVALID_ARGUMENT,
          });
        }
        const result = await sidecar.call<{ session?: RuntimeSession | null }>(
          "native.session.fork",
          {
            id: sessionId,
            ...(title ? { title } : {}),
            ...(throughMessageId ? { throughMessageId } : {}),
          },
        );
        logger.app("session", "info", "native session forked", {
          sessionId: (result.session as { id?: string } | null)?.id,
          data: { sourceSessionId: sessionId },
        });
        return result;
      }
      if (!host) throw new Error("host unavailable");
      if (!sessionId) {
        throw Object.assign(new Error("sessionId required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      if (activeTurns.has(sessionId) && !String(input.throughMessageId ?? "").trim()) {
        throw Object.assign(new Error("Cannot fork a running session"), {
          errorCode: ErrorCodes.AGENT_BUSY,
        });
      }
      // Resolve enrichment before the mutation so a provider-list failure
      // cannot report a failed IPC after the child has already been committed.
      const { providers, defaults } = await sessionCapabilityContext();
      let result: { session?: RuntimeSession | null };
      try {
        result = await host.call("session.fork", {
          sessionId,
          title: String(input.title ?? "").trim() || undefined,
          throughMessageId:
            String(input.throughMessageId ?? "").trim() || undefined,
        });
      } catch (error: any) {
        if (error?.data?.errorCode === ErrorCodes.CONFLICT) {
          throw Object.assign(new Error("Cannot fork a running session"), {
            errorCode: ErrorCodes.AGENT_BUSY,
          });
        }
        throw error;
      }
      if (!result.session) return result;
      logger.app("session", "info", "session forked", {
        sessionId: (result.session as { id?: string }).id,
        data: { sourceSessionId: sessionId },
      });
      return {
        ...result,
        session: enrichSession(result.session, providers, defaults),
      };
    },
  );
  handle(
    IPC.invoke.sessionGet,
    async (
      input:
        | string
        | {
            id?: string;
            messageBefore?: number;
            messageAround?: string;
            messageLimit?: number;
            contentLimit?: number;
          },
    ) => {
      if (!host) throw new Error("host unavailable");
      const request = typeof input === "string" ? { id: input } : input ?? {};
      const id = String(request.id ?? "").trim();
      if (!id) throw new Error("session id required");
      if (id.startsWith("native-pi:")) {
        if (!sidecar) throw new Error("sidecar unavailable");
        return sidecar.call("native.session.get", { id, ...request });
      }
      const [result, { providers, defaults }] = await Promise.all([
        host.call<{ session?: RuntimeSession | null }>("session.get", {
          id,
          ...(typeof request.messageAround === "string" && request.messageAround.trim()
            ? { messageAround: request.messageAround }
            : {}),
          ...(Number.isInteger(request.messageBefore) && request.messageBefore! >= 0
            ? { messageBefore: request.messageBefore }
            : {}),
          ...(Number.isInteger(request.messageLimit) && request.messageLimit! > 0
            ? { messageLimit: request.messageLimit }
            : {}),
          ...(Number.isInteger(request.contentLimit) && request.contentLimit! > 0
            ? { contentLimit: request.contentLimit }
            : {}),
        }),
        sessionCapabilityContext(),
      ]);
      return result.session
        ? { ...result, session: enrichSession(result.session, providers, defaults) }
        : result;
    },
  );
  handle(IPC.invoke.sessionCollaboration, async (input?: { sessionId?: unknown }) => {
    if (!host) throw new Error("host unavailable");
    const sessionId = typeof input?.sessionId === "string" ? input.sessionId.trim() : "";
    rejectNativeMutation(sessionId, "collaboration");
    if (!sessionId || sessionId.length > 256) {
      throw Object.assign(new Error("sessionId must be a non-empty string of at most 256 characters"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    return readSessionCollaboration(host, sidecar, sessionId);
  });
  handle(IPC.invoke.sessionOpen, async (rawSessionId: string) => {
    if (!host) throw new Error("host unavailable");
    const sessionId = String(rawSessionId ?? "").trim();
    if (!sessionId) throw new Error("session id required");
    if (sessionId.startsWith("native-pi:")) {
      if (!sidecar) throw new Error("sidecar unavailable");
      return sidecar.call("native.session.get", { id: sessionId, messageLimit: 1 });
    }
    const [result, { providers, defaults }] = await Promise.all([
      host.call<{ session?: RuntimeSession | null }>("session.get", {
        id: sessionId,
        messageLimit: 1,
      }),
      sessionCapabilityContext(),
    ]);
    if (!result.session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    return { ...result, session: enrichSession(result.session, providers, defaults) };
  });
  handle(
    IPC.invoke.sessionDelegations,
    async (input?: { sessionId?: unknown }) => {
      if (!host) throw new Error("host unavailable");
      const sessionId =
        typeof input?.sessionId === "string" ? input.sessionId.trim() : "";
      if (!sessionId || sessionId.length > 256) {
        throw Object.assign(
          new Error(
            "sessionId must be a non-empty string of at most 256 characters",
          ),
          { errorCode: ErrorCodes.INVALID_ARGUMENT },
        );
      }
      // A native/imported session's transcript belongs to the sidecar, not to
      // this host, and a remote session owns its rows on the remote host. Both
      // would otherwise answer with an empty roster, which reads as "no
      // subagents ever ran" instead of "this source cannot answer here".
      if (sessionId.startsWith("native-pi:") || sessionId.startsWith("remote:")) {
        throw Object.assign(
          new Error("delegation roster is unavailable for this session source"),
          { errorCode: ErrorCodes.UNSUPPORTED },
        );
      }
      return host.call("session.delegations", { sessionId });
    },
  );
  handle(
    IPC.invoke.sessionDelegation,
    async (input?: { sessionId?: unknown; delegationId?: unknown }) => {
      if (!host) throw new Error("host unavailable");
      const sessionId =
        typeof input?.sessionId === "string" ? input.sessionId.trim() : "";
      const delegationId =
        typeof input?.delegationId === "string" ? input.delegationId.trim() : "";
      if (!sessionId || sessionId.length > 256 || !delegationId || delegationId.length > 256) {
        throw Object.assign(
          new Error("sessionId and delegationId are required"),
          { errorCode: ErrorCodes.INVALID_ARGUMENT },
        );
      }
      if (sessionId.startsWith("native-pi:") || sessionId.startsWith("remote:")) {
        throw Object.assign(
          new Error("delegation detail is unavailable for this session source"),
          { errorCode: ErrorCodes.UNSUPPORTED },
        );
      }
      return host.call("session.delegation", { sessionId, delegationId });
    },
  );
  handle(IPC.invoke.sessionDelete, async (id: string) => {
    if (id.startsWith("native-pi:")) {
      throw Object.assign(new Error("Native Pi sessions cannot be deleted from Minih-Agent-Desktop"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (!host) throw new Error("host unavailable");
    const res = await host.call("session.delete", { id });
    cancelMemoryExtraction?.(id);
    await persistenceOutbox.dropSession(id);
    forgetTranscriptRewriteHistory(id);
    // Drop the session's pi-agent so a later session with the same id (or a
    // stale runtime) can't answer with this session's context.
    if (sidecar) {
      sidecar.clearProjectInstructionRoot(id);
      sidecar.clearVendorAuthBindings(id);
      await sidecar
        .call("agent.disposeSession", { sessionId: id })
        .catch(() => undefined);
    }
    sessionProjects.delete(id);
    logger.app("session", "info", "session deleted", { sessionId: id });
    return res;
  });
  handle(IPC.invoke.sessionRename, async (id: string, title: string) => {
    if (id.startsWith("native-pi:")) {
      throw Object.assign(new Error("Native Pi session rename is not supported"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (!host) throw new Error("host unavailable");
    const result = await host.call("session.rename", { id, title });
    // The row is durable; an attached phone only learns the new name from RACP.
    announceTitleChange?.(id);
    return result;
  });
  handle(IPC.invoke.sessionDeriveTitle, async (id: string, title: string) => {
    if (id.startsWith("native-pi:")) {
      throw Object.assign(new Error("Native Pi session title derivation is not supported"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (!host) throw new Error("host unavailable");
    const result = await host.call("session.deriveTitle", { id, title });
    // The Host owns eligibility, so only a real update is worth announcing.
    if ((result as { updated?: boolean } | undefined)?.updated === true) announceTitleChange?.(id);
    return result;
  });
  handle(
    IPC.invoke.sessionMoveProject,
    async (input: { sessionId?: string; projectPath?: string } = {}) => {
      if (!host) throw new Error("host unavailable");
      const sessionId = String(input.sessionId ?? "").trim();
      rejectNativeMutation(sessionId, "project move");
      const projectPath = String(input.projectPath ?? "").trim();
      if (!sessionId) {
        throw Object.assign(new Error("sessionId required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      if (!projectPath) {
        throw Object.assign(new Error("projectPath required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      const releaseSessionOperation = await acquireSessionOperation(sessionId);
      try {
      if (activeTurns.has(sessionId)) {
        throw Object.assign(new Error("Cannot move a running session"), {
          errorCode: ErrorCodes.AGENT_BUSY,
        });
      }
      let result: { session?: (RuntimeSession & { projectPath?: string | null }) | null };
      try {
        result = await host.call("session.moveProject", { sessionId, projectPath });
      } catch (error: any) {
        // The durable running-turn guard can still reject a session whose turn
        // began between the check above and the host call.
        if (error?.data?.errorCode === ErrorCodes.CONFLICT) {
          throw Object.assign(new Error("Cannot move a running session"), {
            errorCode: ErrorCodes.AGENT_BUSY,
          });
        }
        throw error;
      }
      if (!result.session) return result;
      const movedProjectPath = result.session.projectPath?.trim() || null;
      sessionProjects.set(sessionId, movedProjectPath);
      // The live pi-agent caches the project instruction root and vendor auth
      // bindings. Drop it after a successful move so the next turn is rebuilt
      // from the moved session's own project instead of the previous one.
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(sessionId);
        sidecar.clearVendorAuthBindings(sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId })
          .catch(() => undefined);
        if (movedProjectPath) {
          sidecar.setProjectInstructionRoot(sessionId, movedProjectPath);
        }
      }
      const { providers, defaults } = await sessionCapabilityContext();
      logger.app("session", "info", "session project moved", {
        sessionId,
        data: { projectPath: movedProjectPath },
      });
      return {
        ...result,
        session: enrichSession(result.session, providers, defaults),
      };
      } finally {
        releaseSessionOperation();
      }
    },
  );
  handle(
    IPC.invoke.sessionReplaceMessages,
    async (input: { sessionId: string; messages: unknown[] }) => {
      if (!host) throw new Error("host unavailable");
      const sessionId = String(input?.sessionId || "");
      if (!sessionId) throw new Error("sessionId required");
      const currentHost = host;
      return runTranscriptRewrite(
        sessionId,
        "transcript replacement",
        currentHost,
        () =>
          currentHost.call("session.replaceMessages", {
            sessionId,
            messages: input.messages ?? [],
          }),
      );
    },
  );
  handle(
    IPC.invoke.sessionSaveRevision,
    async (input: {
      sessionId: string;
      rootUserId: string;
      messages: unknown[];
      makeActive?: boolean;
    }) => {
      if (!host) throw new Error("host unavailable");
      rejectNativeMutation(input?.sessionId, "revision save");
      return host.call("session.saveRevision", {
        sessionId: String(input?.sessionId || ""),
        rootUserId: String(input?.rootUserId || ""),
        messages: input?.messages ?? [],
        makeActive: input?.makeActive === true,
      });
    },
  );
  handle(
    IPC.invoke.sessionListRevisions,
    async (input: { sessionId: string; rootUserId: string }) => {
      if (!host) throw new Error("host unavailable");
      rejectNativeMutation(input?.sessionId, "revision listing");
      return host.call("session.listRevisions", {
        sessionId: String(input?.sessionId || ""),
        rootUserId: String(input?.rootUserId || ""),
      });
    },
  );
  handle(
    IPC.invoke.sessionActivateRevision,
    async (input: {
      sessionId: string;
      rootUserId: string;
      revisionIndex: number;
      prefix?: unknown[];
    }) => {
      if (!host) throw new Error("host unavailable");
      const sessionId = String(input?.sessionId || "");
      if (!sessionId) throw new Error("sessionId required");
      const currentHost = host;
      return runTranscriptRewrite(
        sessionId,
        "revision activation",
        currentHost,
        () =>
          currentHost.call("session.activateRevision", {
            sessionId,
            rootUserId: String(input?.rootUserId || ""),
            revisionIndex: Number(input?.revisionIndex || 0),
            prefix: input?.prefix ?? [],
          }),
      );
    },
  );
  handle(IPC.invoke.sessionGetScratchPath, async (input: { sessionId: string }) => {
    rejectNativeMutation(input?.sessionId, "scratch access");
    if (!host) throw new Error("host unavailable");
    return host.call<{ path: string }>("session.getScratchPath", {
      sessionId: String(input?.sessionId || ""),
    });
  });
  handle(IPC.invoke.sessionOpenScratchPath, async (input: { sessionId: string }) => {
    rejectNativeMutation(input?.sessionId, "scratch access");
    if (!host) throw new Error("host unavailable");
    const sessionId = String(input?.sessionId || "").trim();
    const result = await host.call<{ path: string }>("session.getScratchPath", {
      sessionId,
    });
    const scratchPath = resolve(String(result?.path ?? ""));
    const scratchRoot = resolve(join(dataDir, "scratch"));
    const rel = relative(scratchRoot, scratchPath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw Object.assign(new Error("invalid session id"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    mkdirSync(scratchPath, { recursive: true });
    const openError = await shell.openPath(stripWinLongPrefix(scratchPath));
    if (openError) throw new Error(openError);
    return { ok: true, path: scratchPath };
  });
  handle(
    IPC.invoke.sessionConfigure,
    async (
      id: string,
      config: {
        mode: Mode;
        providerId?: string;
        modelId?: string;
        thinkingLevel?: SessionThinkingLevel;
        permissionMode?: "inherit" | "ask" | "accept-edits" | "auto";
      },
    ) => {
      rejectNativeMutation(id, "configuration");
      if (!host) throw new Error("host unavailable");
      const result = await host.call<{ session?: RuntimeSession | null }>(
        "session.configure",
        { id, ...config },
      );
      if (!result.session) return result;
      const { providers, defaults } = await sessionCapabilityContext();
      const session = enrichSession(result.session, providers, defaults);
      if (
        config.providerId !== undefined ||
        config.modelId !== undefined ||
        config.thinkingLevel !== undefined
      ) {
        const modelKey =
          session.providerId && session.modelId
            ? `${session.providerId}/${session.modelId}`
            : null;
        plugins.broadcastEvent("session:modelChanged", [
          {
            sessionId: id,
            modelKey,
            thinkingLevel: session.thinkingLevel,
          },
        ]);
      }
      return { ...result, session };
    },
  );

  // The model catalog belongs to the host that owns the session. Local sessions
  // read this desktop's provider rows through `providersList`, so a local call is
  // refused; a remote session id is answered by the remote backend before this
  // handler ever runs, and the channel must be registered for that routing to
  // happen at all.
  handle(IPC.invoke.sessionModels, async () => {
    throw Object.assign(new Error("local sessions use the configured provider list"), {
      errorCode: ErrorCodes.CAPABILITY_UNAVAILABLE,
    });
  });

  handle(IPC.invoke.sessionImportScan, async () => {
    const { sessions, truncated } = await scanAllSources();
    scannedImportSessions = new Map(
      sessions.map((session) => [`${session.source}:${session.externalId}`, session]),
    );
    return {
      sessions: sessions.map(({ filePath: _filePath, ...candidate }) => candidate),
      ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
    };
  });

  handle(
    IPC.invoke.sessionImportRun,
    async (selections: unknown) => {
      if (!host) throw new Error("host unavailable");
      let imported = 0;
      let skipped = 0;
      let failed = 0;
      const items = Array.isArray(selections) ? selections : [];
      for (const selection of items) {
        const key = importSelectionKey(selection);
        const item = key ? scannedImportSessions.get(key) : undefined;
        if (!item) {
          failed += 1;
          logger.app("session", "warn", "session import selection rejected", {
            data: { reason: "candidate was not returned by the latest scan" },
          });
          continue;
        }
        try {
          const converted = await convertSession(item);
          const res = await host.call<{ imported?: boolean }>("session.import", {
            session: converted.session,
            messages: converted.messages,
          });
          if (res.imported) imported += 1;
          else skipped += 1;
        } catch (e) {
          failed += 1;
          logger.app("session", "warn", "session import failed", {
            data: { source: item?.source, externalId: item?.externalId, error: String(e) },
          });
        }
      }
      logger.app("session", "info", "session import finished", {
        data: { imported, skipped, failed },
      });
      return { imported, skipped, failed };
    },
  );

  handle(IPC.invoke.modelConfigImportScan, async () => {
    const drafts = await scanModelConfigs();
    scannedModelConfigs = new Map(
      drafts.map((draft) => [modelConfigImportKey(draft.source, draft.externalId), draft]),
    );
    return { providers: drafts.map(publicModelConfigCandidate) };
  });
  handle(
    IPC.invoke.modelConfigImportRun,
    async (selections: unknown) => {
      if (!host) throw new Error("host unavailable");
      let imported = 0;
      let skipped = 0;
      let failed = 0;
      const items = Array.isArray(selections) ? selections : [];
      const existing = await host.call<{
        providers: Array<{
          id: string;
          baseUrl?: string | null;
          apiStyle?: string | null;
          vendorKey?: string | null;
          hasSecret?: boolean;
        }>;
      }>("providers.list", { includeDisabled: true });
      // Matching an import by endpoint alone collapses distinct credentials.
      // Resolve existing API keys in Electron main so same-endpoint profiles
      // remain independent without exposing secrets to the renderer.
      const known = await Promise.all(
        (existing.providers ?? []).map(async (provider) => {
          let secretValue: string | undefined;
          if (provider.hasSecret) {
            try {
              secretValue = (
                await host!.call<{ value?: string }>("providers.getSecret", {
                  id: provider.id,
                })
              ).value;
            } catch {
              // A provider may only have an OAuth credential, or its secret
              // backend may be temporarily unavailable. In either case,
              // failing closed here avoids collapsing a new profile.
            }
          }
          return { ...provider, secretValue };
        }),
      );
      let firstImported:
        | { id: string; defaultModelId?: string; models?: Array<{ id: string }> }
        | undefined;
      for (const selection of items) {
        const key = modelConfigSelectionKey(selection);
        const draft = key ? scannedModelConfigs.get(key) : undefined;
        if (!draft) {
          failed += 1;
          logger.app("provider", "warn", "model config import selection rejected", {
            data: { reason: "candidate was not returned by the latest scan" },
          });
          continue;
        }
        if (draftMatchesExisting(draft, known)) {
          skipped += 1;
          continue;
        }
        try {
          const created = await host.call<{
            provider: { id: string; defaultModelId?: string; models?: Array<{ id: string }> };
          }>("providers.create", providerCreateInputFromDraft(draft));
          imported += 1;
          known.push({
            ...draft,
            id: created.provider.id,
            secretValue: draft.secretValue,
          });
          firstImported ??= created.provider;
        } catch (e) {
          failed += 1;
          logger.app("provider", "warn", "model config import failed", {
            data: {
              source: draft.source,
              externalId: draft.externalId,
              name: draft.name,
              hasSecret: draft.hasSecret,
              error: String(e),
            },
          });
        }
      }
      if (firstImported) {
        try {
          const settings = await host.call<{ defaultProviderId?: string }>("settings.get");
          if (!settings?.defaultProviderId) {
            await host.call("settings.set", {
              defaultProviderId: firstImported.id,
              defaultModelId:
                firstImported.models?.[0]?.id ?? firstImported.defaultModelId,
            });
          }
        } catch (e) {
          logger.app("provider", "warn", "model config import default not set", {
            data: { error: String(e) },
          });
        }
      }
      logger.app("provider", "info", "model config import finished", {
        data: { imported, skipped, failed },
      });
      return { imported, skipped, failed };
    },
  );

}
