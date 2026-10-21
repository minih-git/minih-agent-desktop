/**
 * One remote session: the attach snapshot, the live event stream, and every
 * mutation the screen can send (PR-4).
 *
 * The client, the supervisor and the visibility listener are all created in one
 * effect and torn down together, so switching host or session, unmounting, or a
 * React StrictMode remount cannot leave a stream or a timer behind.
 *
 * **Order matters (rollout D).** `session/attach` runs first and the stream is
 * then opened *at the snapshot's cursor*, because a snapshot is valid only
 * together with its cursor (protocol §5.4). Subscribing at the same time as
 * attaching, with no cursor, loses whatever happened in between: the event is
 * applied to an empty state, the snapshot then replaces the items without it,
 * and the event id is already remembered — so the turn can stay "running" with
 * its last reply missing. Every later subscription (a reconnect, or the reopen
 * after a resync snapshot) starts from the newest cursor for the same reason.
 */
import type {
  RacpApprovalDecision,
  RacpInlineAttachment,
  RacpModelSummary,
  RacpPermissionMode,
  RacpTurnAdmission,
} from "@minih-agent/shared";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { watchForeground } from "../lib/app-state.js";
import type { HostCredential } from "../lib/credential-port.js";
import type { OperationFailure } from "../lib/errors.js";
import { createHostClient, sessionEventsPath, type HostClient } from "../lib/host-client.js";
import { probeHostStatus } from "../lib/host-status.js";
import {
  attachSession,
  configureSession,
  interruptTurn,
  listHistory,
  listModels,
  renameSession,
  respondApproval as respondApprovalCommand,
  respondInput as respondInputCommand,
  startTurn,
  stopTurn,
  type MutationResult,
} from "../lib/mutations.js";
import { appStateSource } from "../lib/runtime.js";
import { StreamSupervisor, type StreamState } from "../lib/stream-supervisor.js";
import { createStartCursor } from "../lib/stream-cursor.js";
import { loadOlderPages, singleFlight } from "../lib/timeline-history.js";
import { createInitialTimelineState, snapshotItems, timelineReducer, type TimelineState } from "../lib/timeline.js";
import type { TimelineItem } from "../lib/timeline-types.js";


export type TurnAttempt = {
  text: string;
  /** Inline files for this prompt (§10 step 1); absent means text only. */
  attachments?: RacpInlineAttachment[];
  /** Created once per user action; a retry of the same action reuses it. */
  idempotencyKey: string;
  requestId: string;
};

export type ResponseAttempt = Pick<TurnAttempt, "idempotencyKey" | "requestId">;

export type SessionActions = {
  sendTurn: (attempt: TurnAttempt) => Promise<boolean>;
  respondApproval: (input: {
    approvalId: string;
    decision: RacpApprovalDecision;
    permissionMode?: RacpPermissionMode;
    attempt: ResponseAttempt;
  }) => Promise<boolean>;
  respondInput: (input: {
    inputId: string;
    answers: Array<string[] | null>;
    attempt: ResponseAttempt;
  }) => Promise<boolean>;
  stop: () => Promise<boolean>;
  interrupt: () => Promise<boolean>;
  resync: () => Promise<void>;
  /**
   * Load one more page of older rows (`manual`), or run the automatic top-up
   * that fills the opening view (see `loadEarlier` in the hook).
   */
  loadEarlier: () => Promise<void>;
  /** Restart a stream that exhausted its retry budget. */
  reconnect: () => void;
  dismissFailure: () => void;
  /**
   * Change what this session runs on (R7). The Host owns the rule that a turn in
   * progress blocks it, so a refusal comes back as `AGENT_BUSY` and is shown as
   * itself rather than guessed at here.
   */
  configure: (input: {
    providerId?: string;
    modelId?: string;
    thinkingLevel?: string;
    mode?: "agent" | "plan" | "goal";
    permissionMode?: RacpPermissionMode;
  }) => Promise<void>;
  /** Rename this session (controller role). */
  rename: (title: string) => Promise<void>;
  /** Read the Host's model catalog once; later calls are no-ops. */
  loadModels: () => Promise<void>;
};

export type SessionScreenState = {
  timeline: TimelineState;
  streamState: StreamState;
  failure: { failure: OperationFailure; operationKey: string } | null;
  pending: Record<string, boolean>;
  /** Whether a history page is in flight, so the button can say so. */
  loadingEarlier: boolean;
  turnId?: string;
  /** The Host's model catalog, empty until `actions.loadModels` ran (R7). */
  models: RacpModelSummary[];
  actions: SessionActions;
};

export function useSessionScreen(options: {
  hostId: string;
  sessionId: string;
  credential: HostCredential;
  gatewayOrigin: string;
}): SessionScreenState {
  const { hostId, sessionId, credential, gatewayOrigin } = options;
  const credentialKey = credential.kind === "cookie" ? credential.csrfToken : credential.token;

  const [timeline, dispatch] = useReducer(timelineReducer, undefined, createInitialTimelineState);
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const [failure, setFailure] = useState<{ failure: OperationFailure; operationKey: string } | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  /** R7: the Host's model catalog, and whether it was asked for already. */
  const [models, setModels] = useState<RacpModelSummary[]>([]);
  const modelsLoadedRef = useRef(false);
  const clientRef = useRef<HostClient | null>(null);
  const supervisorRef = useRef<StreamSupervisor | null>(null);
  const attachRef = useRef<() => Promise<void>>(async () => undefined);
  /** The cursor the next stream open uses, armed by each snapshot and used once. */
  const startCursorRef = useRef(createStartCursor());
  /**
   * The newest timeline state, for the history loop: the effect that loads older
   * pages runs outside React's render, so it cannot read `timeline` directly
   * without seeing a stale snapshot.
   */
  const timelineRef = useRef<TimelineState>(timeline);
  timelineRef.current = timeline;
  /** Whether the effect's client is still the live one (unmount, session switch). */
  const cancelledRef = useRef(false);
  type LoadEarlierOptions = { manual?: boolean; items?: TimelineItem[]; hasMoreHistory?: boolean };
  const loadEarlierRef = useRef<(options?: LoadEarlierOptions) => Promise<void>>(async () => undefined);
  /**
   * The single-flight entry point: the automatic top-up on open and a press of
   * **Load earlier** must never walk from the same cursor at the same time.
   */
  const loadEarlierRunRef = useRef<(options?: LoadEarlierOptions) => Promise<void>>((options) => loadEarlierRef.current(options));

  /**
   * Older rows, one page at a time.
   *
   * The automatic pass runs when a conversation opens: it keeps asking while the
   * transcript still shows fewer than the user's last two messages and fewer
   * than about thirty rows, and stops after `MAX_HISTORY_PAGES` so opening a
   * very long session cannot become an unbounded download. A manual press loads
   * exactly one page, because that is what the person pressing it expects.
   */
  const loadEarlier = useCallback(
    async (options: { manual?: boolean; items?: TimelineItem[]; hasMoreHistory?: boolean } = {}): Promise<void> => {
      const client = clientRef.current;
      if (!client) return;
      const manual = options.manual === true;
      setLoadingEarlier(true);
      try {
        // The walk keeps its own view of the transcript, because a dispatch does
        // not update `timelineRef` until React re-renders; the opening call hands
        // it the snapshot it was just given for the same reason.
        const load = await loadOlderPages({
          items: options.items ?? timelineRef.current.items,
          hasMoreHistory: options.hasMoreHistory ?? timelineRef.current.hasMoreHistory,
          manual,
          fetchPage: (request) => listHistory(client, sessionId, request),
        });
        if (cancelledRef.current) return;
        if (!load.ok) {
          setFailure({ failure: load.failure, operationKey: "operation.sessionHistory" });
          return;
        }
        for (const page of load.value.pages) {
          dispatch({ type: "prepend", items: page.items, hasMoreHistory: page.hasMoreHistory });
        }
      } finally {
        if (!cancelledRef.current) setLoadingEarlier(false);
      }
    },
    [sessionId],
  );
  loadEarlierRef.current = loadEarlier;

  useEffect(() => {
    const client = createHostClient({
      gatewayOrigin,
      hostId,
      credential,
      onEvent: (envelope) => {
        // A delivered event proves the stream was healthy: the supervisor
        // resets its retry budget on the next drop instead of spending the
        // session's whole allowance on it.
        supervisorRef.current?.noteActivity();
        dispatch({ type: "event", envelope });
      },
      log: (level, message, data) => console.warn(`[remote-web] ${message}`, data ?? {}),
    });
    clientRef.current = client;
    let cancelled = false;
    cancelledRef.current = false;

    // One load at a time for this client: a press of **Load earlier** while the
    // opening top-up is still running joins it instead of walking from the same
    // cursor again.
    loadEarlierRunRef.current = singleFlight((options: LoadEarlierOptions = {}) => loadEarlierRef.current(options));
    const supervisor = new StreamSupervisor({
      // The snapshot's cursor opens the first subscription; every later open (a
      // reconnect, or the reopen after a fresh snapshot) resumes from the last
      // event the stream delivered, which is what `take()` leaves behind.
      openStream: () => client.stream(sessionEventsPath(sessionId), startCursorRef.current.take()),
      closeStream: () => client.closeStream(sessionEventsPath(sessionId)),
      probe: () => probeHostStatus({ gatewayOrigin, hostId, credential }),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      random: Math.random,
      onState: (state) => {
        if (cancelled) return;
        setStreamState(state);
        // A manual reconnect is in flight only while the loop is still stopped.
        setPending((current) => (current["stream/reconnect"] ? { ...current, "stream/reconnect": false } : current));
      },
    });
    supervisorRef.current = supervisor;

    const attach = async (): Promise<void> => {
      const result = await attachSession(client, sessionId);
      if (cancelled) return;
      if (!result.ok) {
        setFailure({ failure: result.failure, operationKey: "operation.sessionAttach" });
        // Nothing to subscribe at without a snapshot; the supervisor keeps
        // running so a later retry (the Resync control) can still start it.
        return;
      }
      startCursorRef.current.set(result.value.snapshot?.cursor ?? null);
      dispatch({
        type: "attach",
        session: result.value.session,
        ...(result.value.snapshot ? { snapshot: result.value.snapshot } : {}),
        ...(result.value.replayComplete === undefined ? {} : { replayComplete: result.value.replayComplete }),
        ...(result.value.resyncReason ? { resyncReason: result.value.resyncReason } : {}),
      });
      // Subscribe only now: the snapshot is applied and the cursor is armed.
      if (firstAttach) {
        firstAttach = false;
        supervisor.start();
        if (!modelsLoadedRef.current) {
          modelsLoadedRef.current = true;
          void listModels(client).then((res) => {
            if (!cancelled && res.ok) setModels(res.value);
          });
        }
        // The snapshot is the newest page only; top the view up to something
        // readable (protocol §5.4: older pages come from `session/history`). The
        // reducer has not re-rendered, so the snapshot goes in as it arrived.
        void loadEarlierRunRef.current({
          items: snapshotItems(result.value.snapshot),
          hasMoreHistory: result.value.snapshot?.hasMoreHistory === true,
        });
        return;
      }
      // A re-attach moved the cursor, so the open stream is subscribed from an
      // older one: reopen it at the new cursor without spending a retry.
      supervisor.reopen();
    };
    attachRef.current = attach;
    let firstAttach = true;
    void attach();
    // Two foreground sources: the page visibility (web and webview) and the
    // native app state (a backgrounded webview does not always report
    // `visibilitychange`). Both resume the supervisor through one call.
    const stopWatching = watchForeground(
      {
        onHidden: () => supervisor.pause(),
        // Visible again: resume a paused loop, or restart one that gave up, and
        // refresh the attach snapshot so approvals/inputs raised while hidden
        // appear immediately.
        onVisible: () => {
          supervisor.onVisible();
          void attachRef.current();
        },
      },
      {
        appState: appStateSource(),
        onError: (error) => console.warn("[remote-web] the native app-state listener failed", error),
      },
    );

    return () => {
      cancelled = true;
      cancelledRef.current = true;
      stopWatching();
      supervisor.stop();
      supervisorRef.current = null;
      client.close();
      clientRef.current = null;
    };
  }, [gatewayOrigin, hostId, sessionId, credentialKey]);

  // A gap the client cannot repair locally: re-attach for a fresh snapshot.
  useEffect(() => {
    if (timeline.needsResync) void attachRef.current();
  }, [timeline.needsResync]);

  const runMutation = useCallback(
    async <T,>(key: string, operationKey: string, call: () => Promise<MutationResult<T>>): Promise<boolean> => {
      setPending((current) => ({ ...current, [key]: true }));
      const result = await call();
      setPending((current) => ({ ...current, [key]: false }));
      if (!result.ok) {
        setFailure({ failure: result.failure, operationKey });
        return false;
      }
      setFailure(null);
      return true;
    },
    [],
  );

  const activeTurnId = timeline.activeTurnId;

  const actions: SessionActions = {
    sendTurn: async (attempt) => {
      const client = clientRef.current;
      if (!client) return false;
      // Queuing keeps a second message instead of rejecting it while a turn
      // still occupies the session (spec §5.6).
      const admission: RacpTurnAdmission = activeTurnId ? "queue" : "reject_if_busy";
      return runMutation("turn/start", "operation.turnStart", () =>
        startTurn(client, {
          sessionId,
          text: attempt.text,
          ...(attempt.attachments ? { attachments: attempt.attachments } : {}),
          admission,
          idempotencyKey: attempt.idempotencyKey,
          requestId: attempt.requestId,
        }),
      );
    },
    respondApproval: async ({ approvalId, decision, permissionMode, attempt }) => {
      const client = clientRef.current;
      if (!client) return false;
      return runMutation(`approval:${approvalId}`, "operation.approvalRespond", () =>
        respondApprovalCommand(client, {
          approvalId,
          decision,
          ...(permissionMode ? { permissionMode } : {}),
          idempotencyKey: attempt.idempotencyKey,
          requestId: attempt.requestId,
        }),
      );
    },
    respondInput: async ({ inputId, answers, attempt }) => {
      const client = clientRef.current;
      if (!client) return false;
      return runMutation(`input:${inputId}`, "operation.inputRespond", () =>
        respondInputCommand(client, {
          inputId,
          answers,
          idempotencyKey: attempt.idempotencyKey,
          requestId: attempt.requestId,
        }),
      );
    },
    stop: async () => {
      const client = clientRef.current;
      if (!client || !activeTurnId) return false;
      return runMutation("turn/stop", "operation.turnStop", () => stopTurn(client, activeTurnId));
    },
    interrupt: async () => {
      const client = clientRef.current;
      if (!client || !activeTurnId) return false;
      return runMutation("turn/interrupt", "operation.turnInterrupt", () => interruptTurn(client, activeTurnId));
    },
    resync: async () => {
      await attachRef.current();
    },
    loadEarlier: async () => {
      await loadEarlierRunRef.current({ manual: true });
    },
    configure: async (input) => {
      const client = clientRef.current;
      if (!client) return;
      setPending((current) => ({ ...current, "session/configure": true }));
      const result = await configureSession(client, { sessionId, ...input });
      setPending((current) => {
        const next = { ...current };
        delete next["session/configure"];
        return next;
      });
      if (!result.ok) {
        setFailure({ failure: result.failure, operationKey: "operation.sessionConfigure" });
        return;
      }
      // The Host answers with the session it now has: adopting it is what
      // makes the sheet and the composer label agree with the server.
      dispatch({ type: "event", envelope: {
        kind: "session.changed",
        sessionId,
        payload: { session: result.value },
      } as never });
      setFailure(null);
    },
    rename: async (title) => {
      const client = clientRef.current;
      if (!client) return;
      setPending((current) => ({ ...current, "session/rename": true }));
      const result = await renameSession(client, sessionId, title);
      setPending((current) => {
        const next = { ...current };
        delete next["session/rename"];
        return next;
      });
      if (!result.ok) {
        setFailure({ failure: result.failure, operationKey: "operation.sessionRename" });
        return;
      }
      dispatch({ type: "event", envelope: {
        kind: "session.changed",
        sessionId,
        payload: { session: { id: sessionId, title: result.value } },
      } as never });
      setFailure(null);
    },
    loadModels: async () => {
      if (modelsLoadedRef.current) return;
      const client = clientRef.current;
      if (!client) return;
      modelsLoadedRef.current = true;
      const result = await listModels(client);
      // A Host too old to list models is not an error the user can act on: the
      // session then keeps showing whatever model it already reported.
      if (result.ok) setModels(result.value);
    },
    reconnect: () => {
      setPending((current) => ({ ...current, "stream/reconnect": true }));
      supervisorRef.current?.start();
    },
    dismissFailure: () => setFailure(null),
  };

  return {
    timeline,
    streamState,
    failure,
    pending,
    loadingEarlier,
    ...(activeTurnId ? { turnId: activeTurnId } : {}),
    models,
    actions,
  };
}
