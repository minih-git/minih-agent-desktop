/**
 * The direct-chat send runner (ADR mobile-direct-gateway-chat §5, §6).
 *
 * This belongs to the app runtime, not to a mounted screen: leaving D3 or
 * switching to Computers must not stop a reply, so the run owns its own
 * AbortController and the screens observe it. Two consequences follow, and both
 * are enforced here rather than asked of the caller:
 *
 * - One direct generation at a time. A second conversation that wants to send
 *   while one is running gets a refusal it can turn into "return" or "stop",
 *   never a hidden queue.
 * - Events from a run that was stopped, superseded or disposed are dropped. The
 *   check is the run's own id captured in its closure, so a stale delta can never
 *   write into whatever attempt is live now.
 *
 * Checkpoints coalesce streamed text into the stored assistant row on a cadence,
 * and every terminal path flushes: completion, stop, failure, and the
 * backgrounding the caller signals through `interrupt`.
 */
import type { MinihRouterModel } from "@minih-agent/shared";

import type { DirectProtocol } from "./catalog.js";
import {
  scopeKey,
  type DirectChatAttempt,
  type DirectChatScope,
  type DirectChatStore,
  type DirectChatTranscript,
} from "./history-store.js";
import type { DirectChatHistory } from "./history.js";
import { streamDirectReply, type DirectStreamResult, type DirectTurn } from "./stream.js";

/** How often streamed text is written while a reply arrives. */
const CHECKPOINT_INTERVAL_MS = 700;
/** How often the view is told about text that has not been written yet. */
const PAINT_INTERVAL_MS = 100;

export type DirectChatRunState =
  | { phase: "idle" }
  | { phase: "running"; conversationId: string; attemptId: string };

export type StartReplyInput = {
  conversationId: string;
  /** The account this device is connected as; a mismatch is refused. */
  scope: DirectChatScope;
  /** The attempt that was just saved as pending. */
  attempt: DirectChatAttempt;
  model: MinihRouterModel;
  protocol: DirectProtocol;
  authKey: string;
};

export type StartReplyOutcome =
  | { ok: true; attempt: DirectChatAttempt }
  | {
      ok: false;
      /** `foreign-scope`: the conversation belongs to another access key. */
      reason: "busy" | "cancelled" | "foreign-scope" | "conversation-missing";
      attempt?: DirectChatAttempt;
    };

export type DirectChatRunnerOptions = {
  store: DirectChatStore;
  history: DirectChatHistory;
  /** The model gateway origin; `null` means this build has none. */
  origin: string | null;
  /** Injected for tests; defaults to the WebView's `fetch`. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Announcement for the screens: they re-read rather than hold the truth. */
  onChange?: () => void;
};

export type DirectChatRunner = {
  state(): DirectChatRunState;
  /** Run one reply for an already-saved pending attempt. */
  start(input: StartReplyInput): Promise<StartReplyOutcome>;
  /** Stop the live reply: a local abort that keeps what arrived. */
  stop(): Promise<void>;
  /** Leave the foreground: cancel and mark interrupted, keeping the checkpoint. */
  interrupt(reason?: string): Promise<void>;
  /** Retry a finished attempt: a new attempt for the same user message. */
  retry(input: {
    attempt: DirectChatAttempt;
    scope: DirectChatScope;
    model: MinihRouterModel;
    protocol: DirectProtocol;
    authKey: string;
  }): Promise<StartReplyOutcome>;
  /** The text received by the live run, for a view that paints before a checkpoint. */
  streamingText(): string;
  /** Record that the app is going away, so a live attempt is not left pending. */
  dispose(): void;
};

/** The context a request carries: completed exchanges, then the new message. */
export function buildDirectContext(transcript: DirectChatTranscript): { turns: DirectTurn[]; lastUserText: string } {
  const completed = new Map(
    transcript.attempts
      .filter((attempt) => attempt.state === "complete")
      .map((attempt) => [attempt.id, attempt]),
  );
  const turns: DirectTurn[] = [];
  let lastUserText = "";
  for (const message of transcript.messages) {
    if (message.role === "user") {
      lastUserText = message.text;
      // A user message whose reply never completed is not a finished exchange,
      // so it is not context: only the newest one goes as the new message.
      const answered = transcript.attempts.some(
        (attempt) => attempt.userMessageId === message.id && completed.has(attempt.id),
      );
      if (answered) turns.push({ role: "user", text: message.text });
      continue;
    }
    const attempt = message.attemptId ? completed.get(message.attemptId) : undefined;
    // Partial, failed and stopped replies are never context (§3).
    if (attempt) turns.push({ role: "assistant", text: message.text });
  }
  return { turns, lastUserText };
}

export function createDirectChatRunner(options: DirectChatRunnerOptions): DirectChatRunner {
  const now = options.now ?? (() => new Date());
  const stamp = (): string => now().toISOString();

  let current: {
    runId: number;
    conversationId: string;
    controller: AbortController;
    /** Text received so far, so an interrupt can keep it without the stream. */
    received: string;
  } | null = null;
  let runCounter = 0;

  const announce = (): void => options.onChange?.();

  /**
   * Drive one stream to its end, writing checkpoints and the terminal state.
   *
   * `runId` is captured so every write can ask "am I still the live run?"; a
   * stopped or superseded run stops touching the store even if its socket is
   * still delivering.
   */
  async function drive(input: {
    runId: number;
    controller: AbortController;
    conversationId: string;
    attempt: DirectChatAttempt;
    model: MinihRouterModel;
    protocol: DirectProtocol;
    authKey: string;
    /** The user message the reply answers, excluded from history. */
    message: string;
    history: readonly DirectTurn[];
  }): Promise<DirectChatAttempt> {
    let attempt = input.attempt;
    let stopped = false;
    let latest = "";
    let lastFlush = 0;
    let lastPaint = 0;
    let flushFailure: string | null = null;

    const isLive = (): boolean => current?.runId === input.runId;

    /** Write the text received so far, and report a write that failed. */
    const flush = async (): Promise<void> => {
      if (!isLive() || latest === "") return;
      try {
        attempt = await options.history.checkpoint(attempt, latest, stamp());
        announce();
      } catch (cause) {
        // A failed checkpoint stops the request: continuing would show text the
        // phone cannot keep, and the user must be told.
        flushFailure = cause instanceof Error ? cause.message : "the reply could not be saved";
        input.controller.abort();
      }
    };

    const result: DirectStreamResult = await streamDirectReply(
      {
        model: input.model,
        protocol: input.protocol,
        history: input.history,
        message: input.message,
        authKey: input.authKey,
      },
      {
        origin: options.origin,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        onEvent: (event) => {
          if (!isLive()) return;
          if (event.type === "text") {
            latest += event.text;
            if (current?.runId === input.runId) current.received = latest;
            // The screen shows the reply as it arrives rather than waiting for the
            // next checkpoint; the gate keeps a fast stream from re-rendering per
            // token while still feeling live.
            const stamp = now().getTime();
            if (stamp - lastPaint >= PAINT_INTERVAL_MS) {
              lastPaint = stamp;
              announce();
            }
            // Coalesce: one write per interval, not one per delta.
            const nowMs = now().getTime();
            if (nowMs - lastFlush >= CHECKPOINT_INTERVAL_MS) {
              lastFlush = nowMs;
              void flush();
            }
          }
        },
      },
      input.controller.signal,
    );

    // The stream finished one way or another: write the final text once.
    if (!isLive()) {
      // A newer run owns the conversation now; leave its records alone.
      return attempt;
    }
    if (latest !== "") {
      try {
        attempt = await options.history.checkpoint(attempt, latest, stamp());
      } catch (cause) {
        flushFailure ??= cause instanceof Error ? cause.message : "the reply could not be saved";
      }
    }
    const finalText = latest;
    if (flushFailure) {
      return options.history.finish(attempt, {
        state: "failed",
        text: finalText,
        error: flushFailure,
        errorKind: "storage",
        now: stamp(),
      });
    }
    if (!result.ok) {
      return options.history.finish(attempt, {
        state: "failed",
        text: finalText,
        error: result.failure.message,
        errorKind: result.failure.kind,
        now: stamp(),
      });
    }
    stopped = result.stopped;
    return options.history.finish(attempt, {
      state: stopped ? "stopped" : "complete",
      text: finalText,
      usage: result.usage,
      now: stamp(),
    });
  }

  function isBusy(): boolean {
    return current !== null;
  }

  return {
    state() {
      return current
        ? { phase: "running", conversationId: current.conversationId, attemptId: "" }
        : { phase: "idle" };
    },

    async start(input) {
      if (isBusy()) {
        // One direct generation at a time: the caller offers Return or Stop
        // instead of quietly queueing the request.
        return { ok: false, reason: "busy" };
      }
      const conversation = await options.history.transcript(input.conversationId);
      if (!conversation) {
        return { ok: false, reason: "conversation-missing" };
      }
      if (scopeKey(conversation.conversation.scope) !== scopeKey(input.scope)) {
        // The request would carry this device's key to another account's
        // conversation, which must never happen (§2).
        return { ok: false, reason: "foreign-scope" };
      }
      runCounter += 1;
      const runId = runCounter;
      const controller = new AbortController();
      current = { runId, conversationId: input.conversationId, controller, received: "" };
      announce();

      const context = buildDirectContext(conversation);

      try {
        const finished = await drive({
          runId,
          controller,
          conversationId: input.conversationId,
          attempt: input.attempt,
          model: input.model,
          protocol: input.protocol,
          authKey: input.authKey,
          message: context.lastUserText,
          // Completed exchanges only, and without the message just sent.
          history: context.turns,
        });
        return { ok: true, attempt: finished };
      } finally {
        if (current?.runId === runId) current = null;
        announce();
      }
    },

    async stop() {
      const live = current;
      if (!live) return;
      // A local abort: the runner's drive() turns it into a `stopped` state
      // with the text received so far, and no further event is applied.
      live.controller.abort();
      announce();
    },

    async interrupt(reason) {
      const live = current;
      if (!live) return;
      // Interrupt takes the run over before aborting, so the driver cannot also
      // write a terminal state: backgrounding is `interrupted`, not `stopped`,
      // and only one of the two may reach the record.
      current = null;
      live.controller.abort();
      const transcript = await options.history.transcript(live.conversationId);
      const attempt = transcript?.attempts.find(
        (candidate) => candidate.state === "pending" || candidate.state === "streaming",
      );
      if (attempt) {
        // The checkpoint text is kept, so returning shows what arrived and
        // offers Retry rather than a silent paid re-request.
        await options.history.finish({
          ...attempt,
          assistantMessageId: attempt.assistantMessageId ?? (live.received ? `${attempt.id}-assistant` : null),
        }, {
          state: "interrupted",
          text: live.received,
          error: reason ?? null,
          errorKind: "interrupted",
          now: stamp(),
        });
      }
      announce();
    },

    async retry(input) {
      if (isBusy()) return { ok: false, reason: "busy" };
      const created = await options.history.retry({
        scope: input.scope,
        modelId: input.model.id,
        modelLabel: input.model.id,
        protocol: input.protocol,
        now: stamp(),
        attempt: input.attempt,
        newConversationId: input.attempt.conversationId,
        newMessageId: input.attempt.userMessageId,
        newAttemptId: `${input.attempt.id}-retry-${runCounter + 1}`,
      });
      if (!created.ok) return { ok: false, reason: created.reason === "foreign-scope" ? "foreign-scope" : "conversation-missing" };
      const attempt = created.attempt;
      announce();
      return this.start({
        conversationId: input.attempt.conversationId,
        scope: input.scope,
        attempt,
        model: input.model,
        protocol: input.protocol,
        authKey: input.authKey,
      });
    },

    streamingText() {
      return current?.received ?? "";
    },

    dispose() {
      // The page is going away: nothing will flush later, so the live attempt is
      // left as it stands and the next startup marks it interrupted.
      current?.controller.abort();
      current = null;
    },
  };
}
