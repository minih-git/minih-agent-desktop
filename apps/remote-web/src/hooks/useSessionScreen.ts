/**
 * One remote session: the attach snapshot, the live event stream, and every
 * mutation the screen can send (PR-4).
 *
 * The client, the supervisor and the visibility listener are all created in one
 * effect and torn down together, so switching host or session, unmounting, or a
 * React StrictMode remount cannot leave a stream or a timer behind.
 */
import type { RacpApprovalDecision, RacpPermissionMode, RacpTurnAdmission } from "@minih-agent/shared";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { watchForeground } from "../lib/app-state.js";
import type { HostCredential } from "../lib/credential-port.js";
import type { OperationFailure } from "../lib/errors.js";
import { createHostClient, sessionEventsPath, type HostClient } from "../lib/host-client.js";
import { probeHostStatus } from "../lib/host-status.js";
import {
  attachSession,
  interruptTurn,
  respondApproval as respondApprovalCommand,
  respondInput as respondInputCommand,
  startTurn,
  stopTurn,
  type MutationResult,
} from "../lib/mutations.js";
import { appStateSource } from "../lib/runtime.js";
import { StreamSupervisor, type StreamState } from "../lib/stream-supervisor.js";
import { createInitialTimelineState, timelineReducer, type TimelineState } from "../lib/timeline.js";


export type TurnAttempt = {
  text: string;
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
  /** Restart a stream that exhausted its retry budget. */
  reconnect: () => void;
  dismissFailure: () => void;
};

export type SessionScreenState = {
  timeline: TimelineState;
  streamState: StreamState;
  failure: { failure: OperationFailure; operationKey: string } | null;
  pending: Record<string, boolean>;
  turnId?: string;
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
  const clientRef = useRef<HostClient | null>(null);
  const supervisorRef = useRef<StreamSupervisor | null>(null);
  const attachRef = useRef<() => Promise<void>>(async () => undefined);

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

    const attach = async (): Promise<void> => {
      const result = await attachSession(client, sessionId);
      if (cancelled) return;
      if (!result.ok) {
        setFailure({ failure: result.failure, operationKey: "operation.sessionAttach" });
        return;
      }
      dispatch({
        type: "attach",
        session: result.value.session,
        ...(result.value.snapshot ? { snapshot: result.value.snapshot } : {}),
        ...(result.value.replayComplete === undefined ? {} : { replayComplete: result.value.replayComplete }),
        ...(result.value.resyncReason ? { resyncReason: result.value.resyncReason } : {}),
      });
    };
    attachRef.current = attach;
    void attach();

    const supervisor = new StreamSupervisor({
      openStream: () => client.stream(sessionEventsPath(sessionId)),
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
    supervisor.start();
    // Two foreground sources: the page visibility (web and webview) and the
    // native app state (a backgrounded webview does not always report
    // `visibilitychange`). Both resume the supervisor through one call.
    const stopWatching = watchForeground(
      {
        onHidden: () => supervisor.pause(),
        // Visible again: resume a paused loop, or restart one that gave up.
        onVisible: () => supervisor.onVisible(),
      },
      {
        appState: appStateSource(),
        onError: (error) => console.warn("[remote-web] the native app-state listener failed", error),
      },
    );

    return () => {
      cancelled = true;
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
    ...(activeTurnId ? { turnId: activeTurnId } : {}),
    actions,
  };
}
