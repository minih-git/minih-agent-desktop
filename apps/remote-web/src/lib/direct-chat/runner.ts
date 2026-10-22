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

/** One conversation that is receiving a reply right now. */
export type DirectChatLiveReply = { conversationId: string; attemptId: string };

/**
 * What the runner is doing. Several conversations may reply at once (ADR §5:
 * no app-wide cap), so the state is a list rather than one id.
 */
export type DirectChatRunState =
  | { phase: "idle" }
  | { phase: "running"; replies: readonly DirectChatLiveReply[] };

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
  /** Every conversation receiving a reply right now. */
  state(): DirectChatRunState;
  /** Run one reply for an already-saved pending attempt in this conversation. */
  start(input: StartReplyInput): Promise<StartReplyOutcome>;
  /** Whether this conversation already has a reply in flight. */
  isRunning(conversationId: string): boolean;
  /** Stop one conversation's reply: a local abort that keeps what arrived. */
  stop(conversationId: string): Promise<void>;
  /**
   * Cancel every reply and mark it interrupted, keeping each checkpoint.
   * Account change and unlink use it; there is no other reason to stop all.
   */
  interrupt(reason?: string): Promise<void>;
  /** Write every live reply's received text now (leaving the foreground). */
  flushAll(): Promise<void>;
  /** Retry a finished attempt: a new attempt for the same user message. */
  retry(input: {
    attempt: DirectChatAttempt;
    scope: DirectChatScope;
    model: MinihRouterModel;
    protocol: DirectProtocol;
    authKey: string;
  }): Promise<StartReplyOutcome>;
  /** The text a conversation has received, for a view that paints before a checkpoint. */
  streamingText(conversationId: string): string;
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

  /**
   * One run per conversation, keyed by conversation id. Several may stream at
   * once (ADR §5: no app-wide cap); a second send in the *same* conversation
   * waits for its reply to end.
   */
  type Run = {
    runId: number;
    conversationId: string;
    attemptId: string;
    controller: AbortController;
    /** Text received so far, so an interrupt can keep it without the stream. */
    received: string;
    /** Write what has arrived now, in this run's own ordered chain. */
    flush: () => Promise<void>;
  };

  const runs = new Map<string, Run>();
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

    const isLive = (): boolean => runs.get(input.conversationId)?.runId === input.runId;

    /**
     * Every write goes through this chain, in order.
     *
     * A timed checkpoint and the final write would otherwise race: a slow one
     * could land after the reply was finished and set its state back to
     * streaming, which is a lie the record would keep. Nothing writes the
     * attempt outside the chain, so the last write is always the last state.
     */
    let writes: Promise<void> = Promise.resolve();

    const enqueue = (work: () => Promise<void>): Promise<void> => {
      writes = writes.then(work, work);
      return writes;
    };

    /** Write the text received so far, and report a write that failed. */
    const flush = (): Promise<void> =>
      enqueue(async () => {
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
      });

    // The run is registered before the stream starts so the app can ask what is
    // live; attaching the chain here is what lets a background flush reach it.
    const own = runs.get(input.conversationId);
    if (own?.runId === input.runId) own.flush = flush;

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
            const run = runs.get(input.conversationId);
            if (run?.runId === input.runId) run.received = latest;
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
              // Queued, not fired and forgotten: the chain keeps it in order.
              void flush();
            }
          }
        },
      },
      input.controller.signal,
    );

    // Drain the chain first: any checkpoint still in flight must land before the
    // terminal state, or it would overwrite it.
    await writes;
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
    // Re-checked after every await: the run may have been stopped or replaced
    // while this write was in flight.
    if (!isLive()) return attempt;
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

  /** End an attempt that never reached the network, as a storage failure. */
  async function failAttempt(attempt: DirectChatAttempt, cause: unknown): Promise<DirectChatAttempt> {
    const message = cause instanceof Error ? cause.message : "the conversation could not be read";
    try {
      return await options.history.finish(attempt, {
        state: "failed",
        text: "",
        error: message,
        errorKind: "storage",
        now: stamp(),
      });
    } catch {
      // Even the write failed: the attempt stays as it was and startup will mark
      // it interrupted, which is still honest.
      return attempt;
    }
  }

  const liveReplies = (): DirectChatLiveReply[] =>
    [...runs.values()].map((run) => ({ conversationId: run.conversationId, attemptId: run.attemptId }));

  return {
    state() {
      const replies = liveReplies();
      return replies.length > 0 ? { phase: "running", replies } : { phase: "idle" };
    },

    isRunning(conversationId) {
      return runs.has(conversationId);
    },

    async start(input) {
      if (runs.has(input.conversationId)) {
        // Within one conversation a new send waits for its reply to end: the
        // timeline has one open exchange, and the composer already offers Stop.
        return { ok: false, reason: "busy" };
      }
      // The read is guarded before the run exists: a closed database here must
      // end the attempt, not strand the app in "busy" for the rest of the session.
      let conversation: DirectChatTranscript | null;
      try {
        conversation = await options.history.transcript(input.conversationId);
      } catch (cause) {
        return { ok: true, attempt: await failAttempt(input.attempt, cause) };
      }
      if (!conversation) {
        return { ok: false, reason: "conversation-missing" };
      }
      if (scopeKey(conversation.conversation.scope) !== scopeKey(input.scope)) {
        // The request would carry this device's key to another account's
        // conversation, which must never happen (§2).
        return { ok: false, reason: "foreign-scope" };
      }
      if (runs.has(input.conversationId)) {
        // The read above is an await: a second send for the same conversation
        // could have taken the run meanwhile.
        return { ok: false, reason: "busy" };
      }
      runCounter += 1;
      const runId = runCounter;
      const controller = new AbortController();
      runs.set(input.conversationId, {
        runId,
        conversationId: input.conversationId,
        attemptId: input.attempt.id,
        controller,
        received: "",
        flush: () => Promise.resolve(),
      });
      // Context assembly is pure, but it runs inside the cleanup anyway: nothing
      // between taking the run and releasing it may skip the release.
      let context: { turns: DirectTurn[]; lastUserText: string };
      try {
        context = buildDirectContext(conversation);
      } catch (cause) {
        runs.delete(input.conversationId);
        announce();
        return { ok: true, attempt: await failAttempt(input.attempt, cause) };
      }

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
        if (runs.get(input.conversationId)?.runId === runId) runs.delete(input.conversationId);
        announce();
      }
    },

    async stop(conversationId) {
      const live = runs.get(conversationId);
      if (!live) return;
      // A local abort: that run's drive() turns it into a `stopped` state with
      // the text received so far. Other conversations keep streaming.
      live.controller.abort();
      announce();
    },

    async interrupt(reason) {
      const live = [...runs.values()];
      if (live.length === 0) return;
      // Interrupt takes each run over before aborting, so its driver cannot also
      // write a terminal state: this path writes `interrupted`, not `stopped`.
      for (const run of live) runs.delete(run.conversationId);
      for (const run of live) run.controller.abort();
      for (const run of live) {
        const transcript = await options.history.transcript(run.conversationId).catch(() => null);
        const attempt = transcript?.attempts.find(
          (candidate) => candidate.state === "pending" || candidate.state === "streaming",
        );
        if (!attempt) continue;
        // The checkpoint text is kept, so returning shows what arrived and
        // offers Retry rather than a silent paid re-request.
        await options.history.finish(
          {
            ...attempt,
            assistantMessageId: attempt.assistantMessageId ?? (run.received ? `${attempt.id}-assistant` : null),
          },
          {
            state: "interrupted",
            text: run.received,
            error: reason ?? null,
            errorKind: "interrupted",
            now: stamp(),
          },
        );
      }
      announce();
    },

    async flushAll() {
      // One reply failing to save must not stop the others from being saved.
      await Promise.all([...runs.values()].map((run) => run.flush().catch(() => undefined)));
    },

    async retry(input) {
      if (runs.has(input.attempt.conversationId)) return { ok: false, reason: "busy" };
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

    streamingText(conversationId) {
      return runs.get(conversationId)?.received ?? "";
    },

    dispose() {
      // The page is going away: nothing will flush later, so every live attempt
      // is left as it stands and the next startup marks it interrupted.
      for (const run of runs.values()) run.controller.abort();
      runs.clear();
    },
  };
}
