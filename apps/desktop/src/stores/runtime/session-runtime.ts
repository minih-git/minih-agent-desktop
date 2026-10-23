import type {
  AgentEventEnvelope,
  SessionSummary,
  UiMessage,
} from "@minih-agent/shared";
import { applyMessageUpdate } from "@minih-agent/shared";
import { api } from "../../lib/api";
import { createNavigationIntentController } from "../../lib/navigation-intent";
import {
  dedupeSessionMessages,
  durableCoversLiveSessionMessages,
  estimateMessageBytes,
  mergeLiveSessionMessages,
  projectMessageEnd,
  removeLiveSessionMessage,
  reuseIdenticalMessages,
  trimTranscriptTail,
  upsertLiveSessionMessage,
} from "../../lib/session-transcript";
import { getSessionMessageSnapshot, getSessionToolMessagePositions } from "../../lib/session-transcript-updates";
import { sessionReadLooksEmpty } from "../../lib/session-transcript-read";
import { isAutomationSession } from "../../lib/session-origin";
import { sessionIsArchived, type SessionMeta } from "../../lib/sidebar-preferences";
import {
  normalizeProjectPath,
  sessionMatchesProject,
} from "../../lib/sidebar-session-groups";
import type { ComposerDraftSnapshot } from "../../lib/composer-smart-stop";
import { formatToolValue } from "../../lib/tool-display";
import { recordPaneTranscript } from "../../lib/session-panes";
import type { AppState, SessionHistoryWindow } from "../app-state";
import type { StoreAccess } from "../slices/types";

export const SESSION_TRANSCRIPT_CACHE_LIMIT = 20;
/** Byte budget for everything the transcript cache holds across sessions. */
export const SESSION_TRANSCRIPT_CACHE_BYTES = 48 * 1024 * 1024;
export const SESSION_TRANSCRIPT_PAGE_SIZE = 100;
export const SESSION_TRANSCRIPT_CONTENT_LIMIT = 64 * 1024;

export type SubmittedComposerDraft = {
  messageCountBeforeSend: number;
  draft: ComposerDraftSnapshot;
  abortResolution?: Promise<boolean>;
  resolveAbort?: (restored: boolean) => void;
};

export type SessionConfiguration = Pick<
  SessionSummary,
  "mode" | "providerId" | "modelId" | "thinkingLevel"
> &
  Partial<Pick<SessionSummary, "permissionMode">>;

export type SessionSelection = { id: string; intent: number };

export type SessionRuntime = {
  readonly pendingNewSessionRequests: Map<string, Promise<void>>;
  readonly sessionTranscriptCache: Map<string, UiMessage[]>;
  readonly liveSessionTranscripts: Set<string>;
  readonly sessionHistoryCache: Map<string, SessionHistoryWindow>;
  readonly submittedComposerDrafts: Map<string, SubmittedComposerDraft>;
  readonly pendingSessionConfigurations: Map<string, SessionConfiguration>;
  readonly sessionConfigurationFlushes: Map<string, Promise<void>>;
  beginNavigationIntent: () => number;
  navigationIntentIsCurrent: (intent: number) => boolean;
  newSessionScopeKey: (projectPath?: string | null) => string;
  latestSessionInScope: (
    sessions: SessionSummary[],
    projectPath: string | null,
    sessionMeta: Record<string, SessionMeta>,
  ) => SessionSummary | undefined;
  liveMessageCountForSession: (
    id: string,
    state: Pick<AppState, "activeSessionId" | "messages" | "retainedTranscripts">,
  ) => number;
  cacheSessionTranscript: (
    id: string,
    messages: UiMessage[],
    window?: SessionHistoryWindow,
  ) => void;
  syncTranscriptProjection: (state: AppState, previous: AppState) => void;
  loadSessionDetail: (
    id: string,
    options?: {
      messageBefore?: number;
      messageLimit?: number;
      contentLimit?: number;
    },
  ) => ReturnType<typeof api.getSession>;
  loadFullSessionMessages: (id: string, cache?: boolean) => Promise<UiMessage[] | null>;
  insertOptimisticUserMessage: (sessionId: string, message: UiMessage) => void;
  retractOptimisticUserMessage: (sessionId: string, message: UiMessage) => void;
  cacheBackgroundTranscriptEvent: (envelope: AgentEventEnvelope) => void;
  mergeSessionConfiguration: (
    current: SessionConfiguration | undefined,
    next: SessionConfiguration,
  ) => SessionConfiguration;
  queueWorkspaceAlignment: <T>(task: () => Promise<T>) => Promise<T>;
  beginSessionSelection: (id: string, intent: number) => SessionSelection;
  isCurrentSessionSelection: (selection: SessionSelection) => boolean;
  isSessionSelectionPending: (sessionId: string) => boolean;
  clearSessionSelection: (selection: SessionSelection) => void;
  isSessionSelectionForIntent: (intent: number) => boolean;
  recordToolStart: (
    toolCallId: string,
    value: {
      toolName: string;
      args: unknown;
      createdAt: string;
      parentToolCallId?: string;
      nestedParentToolCallId?: string;
      agentName?: string;
    },
  ) => void;
  getToolStart: (toolCallId: string) => {
    toolName: string;
    args: unknown;
    createdAt: string;
    parentToolCallId?: string;
    nestedParentToolCallId?: string;
    agentName?: string;
  } | undefined;
  removeToolStart: (toolCallId: string) => void;
  nextPlanSyncGeneration: (sessionId: string) => number;
  planSyncGeneration: (sessionId: string) => number;
};

type ToolStart = NonNullable<ReturnType<SessionRuntime["getToolStart"]>>;

export function createSessionRuntime({ get, set }: StoreAccess): SessionRuntime {
  const navigationIntents = createNavigationIntentController();
  let pendingSessionSelection: SessionSelection | null = null;
  let sessionWorkspaceQueue: Promise<unknown> = Promise.resolve();

  const pendingNewSessionRequests = new Map<string, Promise<void>>();
  const sessionTranscriptCache = new Map<string, UiMessage[]>();
  /** Bytes per cached transcript, memoized against the array it was counted on. */
  const sessionTranscriptBytes = new Map<string, { messages: UiMessage[]; bytes: number }>();
  const liveSessionTranscripts = new Set<string>();
  const sessionHistoryCache = new Map<string, SessionHistoryWindow>();
  const submittedComposerDrafts = new Map<string, SubmittedComposerDraft>();
  const pendingSessionConfigurations = new Map<string, SessionConfiguration>();
  const sessionConfigurationFlushes = new Map<string, Promise<void>>();
  const sessionDetailLoads = new Map<string, ReturnType<typeof api.getSession>>();
  const toolStartsByCallId = new Map<string, ToolStart>();
  const planSyncGenerations = new Map<string, number>();

  /**
   * Bytes one cached entry holds, counted once per array instance: every writer
   * replaces the array, so identity is enough to invalidate the count.
   */
  function entryBytes(id: string, messages: UiMessage[]): number {
    const known = sessionTranscriptBytes.get(id);
    if (known && known.messages === messages) return known.bytes;
    let bytes = 0;
    for (const message of messages) bytes += estimateMessageBytes(message);
    sessionTranscriptBytes.set(id, { messages, bytes });
    return bytes;
  }

  function cacheSessionTranscript(
    id: string,
    messages: UiMessage[],
    window?: SessionHistoryWindow,
  ): void {
    const normalized = dedupeSessionMessages(messages);
    sessionTranscriptCache.delete(id);
    sessionTranscriptCache.set(id, normalized);
    sessionTranscriptBytes.delete(id);
    if (window) sessionHistoryCache.set(id, window);
    while (sessionTranscriptCache.size > SESSION_TRANSCRIPT_CACHE_LIMIT) {
      const oldestId = sessionTranscriptCache.keys().next().value;
      if (typeof oldestId !== "string") break;
      sessionTranscriptCache.delete(oldestId);
      sessionTranscriptBytes.delete(oldestId);
      sessionHistoryCache.delete(oldestId);
      liveSessionTranscripts.delete(oldestId);
    }
    // The byte budget is enforced by the read path (`loadSessionDetail`), not
    // here: a live delta republishes the projection on every frame, and walking
    // every cached row from this write would read content the delta path is
    // explicitly not allowed to touch.
  }

  /**
   * Hold the transcript cache to its byte budget. Sessions that are off screen
   * are first cut back to their tail window; if that is not enough, the least
   * recently written entries go entirely. The session just written, the active
   * session and the retained panes (ADR 0137) are never touched, because the
   * user can switch back to them without another read.
   */
  function enforceTranscriptCacheBudget(touchedId: string): void {
    const state = get();
    const pinned = new Set<string>(Object.keys(state.retainedTranscripts ?? {}));
    if (state.activeSessionId) pinned.add(state.activeSessionId);
    pinned.add(touchedId);

    let total = 0;
    for (const [id, messages] of sessionTranscriptCache) {
      if (!pinned.has(id)) {
        const trimmed = trimTranscriptTail(messages, SESSION_TRANSCRIPT_PAGE_SIZE);
        if (trimmed !== messages) {
          sessionTranscriptCache.set(id, trimmed);
          sessionTranscriptBytes.delete(id);
          // The cached transcript no longer starts at the top, so the next
          // activation has to page older rows instead of assuming it has all.
          const cachedWindow = sessionHistoryCache.get(id);
          if (cachedWindow && !cachedWindow.hasMoreBefore) {
            sessionHistoryCache.set(id, { ...cachedWindow, hasMoreBefore: true });
          }
        }
      }
      total += entryBytes(id, sessionTranscriptCache.get(id) ?? []);
    }
    if (total <= SESSION_TRANSCRIPT_CACHE_BYTES) return;
    for (const [id, messages] of [...sessionTranscriptCache]) {
      if (total <= SESSION_TRANSCRIPT_CACHE_BYTES) break;
      if (pinned.has(id)) continue;
      total -= entryBytes(id, messages);
      sessionTranscriptCache.delete(id);
      sessionTranscriptBytes.delete(id);
      sessionHistoryCache.delete(id);
      liveSessionTranscripts.delete(id);
    }
  }

  function loadSessionDetail(
    id: string,
    options?: {
      messageBefore?: number;
      messageLimit?: number;
      contentLimit?: number;
    },
  ) {
    const active = sessionDetailLoads.get(id);
    if (active && options?.messageBefore === undefined) return active;
    const request = api.getSession(id, options).then((detail) => {
      if (detail.session && options?.messageBefore === undefined) {
        const state = get();
        const liveMessages =
          sessionTranscriptCache.get(id) ?? state.retainedTranscripts[id];
        const freshMessages =
          (liveSessionTranscripts.has(id) || state.runningSessions[id]) &&
          liveMessages
            ? mergeLiveSessionMessages(detail.session.messages ?? [], liveMessages)
            : detail.session.messages ?? [];
        // A read rebuilds plain objects from the IPC payload. Reuse the rows we
        // already had so the cache, the retained pane snapshot and the
        // projection share one copy of a large tool result instead of three.
        const messages = reuseIdenticalMessages(freshMessages, liveMessages);
        // Never cache a suspiciously empty window (issue #795): hover prefetch
        // would then re-serve that emptiness on every later open, and the
        // session could not recover without a restart.
        if (messages.length > 0 || !sessionReadLooksEmpty(detail.session)) {
          cacheSessionTranscript(id, messages, {
            messageStart: detail.session.messageStart ?? 0,
            hasMoreBefore: detail.session.hasMoreBefore === true,
            contentLimited: options?.contentLimit !== undefined,
          });
          // A session that has just been read is the one place the cache may
          // measure content: enforce the byte budget and trim what is off
          // screen here, so the delta path never has to look.
          enforceTranscriptCacheBudget(id);
        }
      }
      return detail;
    });
    if (options?.messageBefore === undefined) sessionDetailLoads.set(id, request);
    const clear = () => {
      if (
        options?.messageBefore === undefined &&
        sessionDetailLoads.get(id) === request
      ) {
        sessionDetailLoads.delete(id);
      }
    };
    void request.then(clear, clear);
    return request;
  }

  /** Every canonical writer (streaming, edits, retries) shares this cache boundary. */
  function syncTranscriptProjection(state: AppState, previous: AppState) {
    if (state.messages === previous.messages && state.activeSessionId === previous.activeSessionId) return;
    const id = state.activeSessionId;
    if (!id) return;
    if (state.runningSessions[id] || previous.runningSessions[id]) liveSessionTranscripts.add(id);
    cacheSessionTranscript(id, state.messages, state.sessionHistory[id]);
    if (state.retainedTranscripts[id] === state.messages) return;
    set((current) => current.activeSessionId === id
      ? recordPaneTranscript(current, id, current.messages) : {});
  }

  async function loadFullSessionMessages(id: string, cache = true): Promise<UiMessage[] | null> {
    const detail = await api.getSession(id);
    if (!detail.session) return null;
    const messages = detail.session.messages ?? [];
    if (cache) cacheSessionTranscript(id, messages, {
        messageStart: 0,
        hasMoreBefore: false,
      });
    return messages;
  }

  function insertOptimisticUserMessage(sessionId: string, message: UiMessage): void {
    const state = get();
    if (state.activeSessionId === sessionId) {
      set((current) => ({
        messages: upsertLiveSessionMessage(current.messages, message),
      }));
      return;
    }
    const cached = sessionTranscriptCache.get(sessionId);
    if (cached) {
      sessionTranscriptCache.set(
        sessionId,
        upsertLiveSessionMessage(cached, message),
      );
    }
  }

  function retractOptimisticUserMessage(sessionId: string, message: UiMessage): void {
    const state = get();
    if (state.activeSessionId === sessionId) {
      set((current) =>
        current.messages.includes(message)
          ? { messages: removeLiveSessionMessage(current.messages, message.id) }
          : current,
      );
      return;
    }
    const cached = sessionTranscriptCache.get(sessionId);
    if (cached?.includes(message)) {
      sessionTranscriptCache.set(
        sessionId,
        removeLiveSessionMessage(cached, message.id),
      );
    }
  }

  function projectTranscriptEvent(current: UiMessage[], envelope: AgentEventEnvelope): UiMessage[] {
    const { event } = envelope;
    let next = current;
    switch (event.type) {
      case "message_start":
        next = upsertLiveSessionMessage(current, event.message);
        break;
      case "message_update": {
        const normalized = dedupeSessionMessages(current);
        const index = getSessionMessageSnapshot(normalized).positions.get(event.message.id);
        const previous = index === undefined ? undefined : normalized[index];
        next = upsertLiveSessionMessage(normalized, applyMessageUpdate(previous, event));
        break;
      }
      case "message_end": {
        next = projectMessageEnd(current, event);
        break;
      }
      case "tool_start":
        next = upsertLiveSessionMessage(current, {
          id: event.toolCallId,
          role: "tool",
          content: "",
          createdAt: new Date(envelope.ts).toISOString(),
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolArgs: event.args,
          toolStatus: "running",
          status: "streaming",
          ...(envelope.parentToolCallId
            ? { parentToolCallId: envelope.parentToolCallId }
            : {}),
          ...(envelope.nestedParentToolCallId ? { nestedParentToolCallId: envelope.nestedParentToolCallId } : {}),
          ...(envelope.agentName ? { agentName: envelope.agentName } : {}),
        });
        break;
      case "tool_update": {
        if (event.partialResult === undefined) return current;
        const index = getSessionToolMessagePositions(current, event.toolCallId)
          .find((position) => current[position].toolStatus === "running");
        if (index === undefined) return current;
        const existing = current[index];
        next = upsertLiveSessionMessage(current, {
          ...existing,
          content:
            typeof event.partialResult === "string"
              ? event.partialResult
              : formatToolValue(event.partialResult),
          toolResult: event.partialResult,
        });
        break;
      }
      case "tool_end": {
        const toolStart = toolStartsByCallId.get(event.toolCallId);
        const completedAt = new Date(envelope.ts).toISOString();
        const completed: UiMessage = {
          id: event.toolCallId,
          role: "tool",
          content:
            typeof event.result === "string"
              ? event.result
              : JSON.stringify(event.result, null, 2),
          createdAt: toolStart?.createdAt ?? completedAt,
          toolCallId: event.toolCallId,
          ...(toolStart?.toolName ? { toolName: toolStart.toolName } : {}),
          ...(toolStart ? { toolArgs: toolStart.args } : {}),
          toolCompletedAt: completedAt,
          toolDurationMs: toolStart
            ? Math.max(0, envelope.ts - Date.parse(toolStart.createdAt))
            : 0,
          toolStatus: event.isError ? "error" : "success",
          toolResult: event.result,
          ...(event.toolUsage ? { toolUsage: event.toolUsage } : {}),
          status: "complete",
          isError: event.isError,
        };
        const existing = current.find(
          (message) => message.toolCallId === event.toolCallId,
        );
        next = existing
          ? upsertLiveSessionMessage(current, {
              ...existing,
              ...completed,
              toolName: existing.toolName ?? completed.toolName,
              toolArgs: existing.toolArgs ?? completed.toolArgs,
              createdAt: existing.createdAt || completed.createdAt,
            })
          : upsertLiveSessionMessage(current, completed);
        break;
      }
      default:
        return current;
    }

    return next;
  }

  function cacheBackgroundTranscriptEvent(envelope: AgentEventEnvelope): void {
    const { sessionId } = envelope;
    const state = get();
    const current =
      sessionTranscriptCache.get(sessionId) ?? state.retainedTranscripts[sessionId];
    if (!current) return;

    const next = projectTranscriptEvent(current, envelope);
    if (next === current) return;
    liveSessionTranscripts.add(sessionId);
    cacheSessionTranscript(
      sessionId,
      next,
      sessionHistoryCache.get(sessionId) ?? state.sessionHistory[sessionId],
    );
  }

  function queueWorkspaceAlignment<T>(task: () => Promise<T>): Promise<T> {
    const next = sessionWorkspaceQueue.then(task, task);
    sessionWorkspaceQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function recordToolStart(toolCallId: string, value: ToolStart): void {
    if (toolStartsByCallId.size >= 512) {
      const oldest = toolStartsByCallId.keys().next().value;
      if (oldest !== undefined) toolStartsByCallId.delete(oldest);
    }
    toolStartsByCallId.set(toolCallId, value);
  }

  return {
    pendingNewSessionRequests,
    sessionTranscriptCache,
    liveSessionTranscripts,
    sessionHistoryCache,
    syncTranscriptProjection,
    submittedComposerDrafts,
    pendingSessionConfigurations,
    sessionConfigurationFlushes,
    beginNavigationIntent: () => navigationIntents.begin(),
    navigationIntentIsCurrent: (intent) => navigationIntents.isCurrent(intent),
    newSessionScopeKey: (projectPath) =>
      normalizeProjectPath(projectPath) ?? "<temporary>",
    latestSessionInScope: (sessions, projectPath, sessionMeta) =>
      sessions
        .filter(
          (session) =>
            !isAutomationSession(session) &&
            sessionMatchesProject(session, projectPath),
        )
        .sort((a, b) => {
          const aUpdated = Date.parse(a.updatedAt);
          const bUpdated = Date.parse(b.updatedAt);
          const aTime = Number.isFinite(aUpdated) ? aUpdated : 0;
          const bTime = Number.isFinite(bUpdated) ? bUpdated : 0;
          return bTime - aTime || b.id.localeCompare(a.id);
        })
        .find((session) => !sessionIsArchived(session.id, sessionMeta)),
    liveMessageCountForSession: (id, state) =>
      state.activeSessionId === id
        ? state.messages.length
        : sessionTranscriptCache.get(id)?.length ??
          state.retainedTranscripts[id]?.length ??
          0,
    cacheSessionTranscript,
    loadSessionDetail,
    loadFullSessionMessages,
    insertOptimisticUserMessage,
    retractOptimisticUserMessage,
    cacheBackgroundTranscriptEvent,
    mergeSessionConfiguration: (current, next) => {
      if (!current) return next;
      const merged: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(next)) {
        if (value !== undefined) merged[key] = value;
      }
      return merged as SessionConfiguration;
    },
    queueWorkspaceAlignment,
    beginSessionSelection: (id, intent) => {
      const selection = { id, intent };
      pendingSessionSelection = selection;
      return selection;
    },
    isCurrentSessionSelection: (selection) =>
      pendingSessionSelection === selection,
    isSessionSelectionPending: (sessionId) =>
      pendingSessionSelection?.id === sessionId,
    clearSessionSelection: (selection) => {
      if (pendingSessionSelection === selection) pendingSessionSelection = null;
    },
    isSessionSelectionForIntent: (intent) =>
      pendingSessionSelection?.intent === intent,
    recordToolStart,
    getToolStart: (toolCallId) => toolStartsByCallId.get(toolCallId),
    removeToolStart: (toolCallId) => toolStartsByCallId.delete(toolCallId),
    nextPlanSyncGeneration: (sessionId) => {
      const next = (planSyncGenerations.get(sessionId) ?? 0) + 1;
      planSyncGenerations.set(sessionId, next);
      return next;
    },
    planSyncGeneration: (sessionId) => planSyncGenerations.get(sessionId) ?? 0,
  };
}

export function sessionMessagesCoverLiveTail(
  durable: UiMessage[],
  live: UiMessage[] | undefined,
): boolean {
  return durableCoversLiveSessionMessages(durable, live);
}
