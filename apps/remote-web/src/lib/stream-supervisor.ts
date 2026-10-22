/**
 * Event-stream supervision (PR-4).
 *
 * `createHttpSseClient` owns one stream and resumes it with `Last-Event-ID`;
 * this supervisor owns the *decision* to reopen it. It is deliberately free of
 * `document`, `window` and timers so the reconnect behaviour is unit-testable:
 * the caller injects `sleep`, `random`, the probe and the visibility events.
 *
 * Rules: a drop is retried with jittered exponential backoff; a stream that
 * delivered at least one event earns a fresh retry budget; a revoked credential
 * stops for good; a hidden page pauses (and closes the stream) until it becomes
 * visible again; `stop()` ends the loop and never reopens. `exhausted` is
 * terminal for the loop but recoverable for the user, so the loop releases its
 * ownership and `start()` can run again.
 */
import { STREAM_RECONNECT_POLICY, backoffDelay, type ReconnectPolicy } from "./reconnect-policy.js";
import type { HostStatus } from "./host-status.js";

export type StreamState = "idle" | "open" | "paused" | "retrying" | "revoked" | "exhausted" | "stopped";

export type StreamDetail = {
  attempts: number;
  delayMs?: number;
};

export type StreamSupervisorOptions = {
  /** Resolves when the stream ends, for any reason. */
  openStream: () => Promise<void>;
  /** Aborts the open stream; called on pause and on stop. */
  closeStream: () => void;
  /** Run after every drop; `revoked` ends the loop. */
  probe?: () => Promise<HostStatus>;
  sleep: (ms: number) => Promise<void>;
  /** `[0, 1)` source for the backoff jitter. */
  random: () => number;
  policy?: ReconnectPolicy;
  onState?: (state: StreamState, detail: StreamDetail) => void;
};

export class StreamSupervisor {
  private running = false;
  /** Whether the stream currently open has delivered at least one event. */
  private delivered = false;
  private paused = false;
  private stateValue: StreamState = "idle";
  private attempts = 0;
  private resumeWaiters: Array<() => void> = [];
  private loop: Promise<void> | null = null;
  /** Set by `reopen()`: the next loop iteration skips the drop accounting. */
  private reopenRequested = false;

  constructor(private readonly options: StreamSupervisorOptions) {}

  get state(): StreamState {
    return this.stateValue;
  }

  get retryAttempts(): number {
    return this.attempts;
  }

  /** Idempotent: starting an already running supervisor keeps the current loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.attempts = 0;
    this.delivered = false;
    this.reopenRequested = false;
    this.setState("idle");
    const loop = this.run().catch(() => undefined);
    this.loop = loop;
    void loop.then(() => {
      // Only the loop that still owns the slot may clear it: a restart can
      // already have installed its own loop.
      if (this.loop === loop) this.loop = null;
    });
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.options.closeStream();
    this.setState("paused");
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /**
   * The visibility listener's "page became visible" path. A paused loop
   * resumes; a loop that exhausted its retry budget starts again with a fresh
   * budget, because `exhausted` is recoverable by design. A revoked credential
   * is never restarted: only pairing the Host again can fix it.
   */
  onVisible(): void {
    if (this.stateValue === "exhausted") {
      this.start();
      return;
    }
    this.resume();
  }

  /**
   * Called for every event the open stream delivered. A stream that delivered
   * something is a healthy stream that dropped, not a failing one, so the next
   * drop starts from a fresh retry budget (mirrors `http-sse.ts`).
   */
  noteActivity(): void {
    this.delivered = true;
  }

  /**
   * Reopen the stream immediately, without spending a retry.
   *
   * Used after a fresh snapshot: the cursor has moved to the snapshot's own
   * cursor, and the current stream is subscribed from an older one. Closing it
   * is not a drop, so the loop must not probe, back off, or count an attempt —
   * the next open simply starts from the new cursor.
   */
  reopen(): void {
    if (!this.running) return;
    this.reopenRequested = true;
    this.options.closeStream();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.paused = false;
    this.releaseWaiters();
    this.options.closeStream();
    this.setState("stopped");
  }

  /** Wait for `loop` to settle; used by tests and by the screen on unmount. */
  async settled(): Promise<void> {
    await this.loop;
  }

  private releaseWaiters(): void {
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private waitForResume(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resumeWaiters.push(resolve);
    });
  }

  private async run(): Promise<void> {
    const policy = this.options.policy ?? STREAM_RECONNECT_POLICY;
    while (this.running) {
      if (this.paused) {
        this.setState("paused");
        await this.waitForResume();
        continue;
      }
      // The flag is per open: a stream that delivered an event must never be
      // confused with one that failed immediately.
      this.delivered = false;
      this.setState("open");
      try {
        await this.options.openStream();
      } catch {
        // A thrown stream error is a drop like any other: the probe below
        // decides whether retrying is still meaningful.
      }
      if (!this.running) return;
      if (this.paused) continue;
      if (this.reopenRequested) {
        // A deliberate reopen is not a drop: no probe, no backoff, no attempt.
        this.reopenRequested = false;
        continue;
      }
      if (this.delivered) {
        // A healthy stream earns a fresh budget: a phone that changes networks
        // all day must not spend one session's whole allowance of drops.
        this.attempts = 0;
      }
      if (this.options.probe) {
        const status = await this.options.probe();
        if (!this.running) return;
        if (status.kind === "revoked") {
          this.running = false;
          this.setState("revoked");
          return;
        }
      }
      this.attempts += 1;
      if (this.attempts > policy.maxAttempts) {
        // Terminal for the loop, recoverable for the user: releasing ownership
        // lets `start()` — the Reconnect control, or the page becoming visible —
        // run a fresh loop instead of a no-op.
        this.running = false;
        this.setState("exhausted");
        return;
      }
      const delayMs = backoffDelay(this.attempts, policy, this.options.random());
      this.setState("retrying", { delayMs });
      await this.options.sleep(delayMs);
    }
  }

  private setState(state: StreamState, extra: { delayMs?: number } = {}): void {
    this.stateValue = state;
    this.options.onState?.(state, { attempts: this.attempts, ...extra });
  }
}
