import type { RacpCursor, RacpEventEnvelope, RacpEventKind, RacpLimits } from "@minih-agent/shared";
import { RACP_DEFAULT_LIMITS, isDurableEventKind } from "@minih-agent/shared";

import { racpError, type RacpError } from "./errors.js";
import type { Clock, IdSource } from "./ports.js";

/** What a producer hands to the log: everything the Host does not allocate. */
export type EventDraft = {
  scope: "session" | "host";
  sessionId?: string;
  turnId?: string;
  revision: number;
  kind: RacpEventKind;
  parentToolCallId?: string;
  nestedParentToolCallId?: string;
  agentName?: string;
  payload: unknown;
  occurredAt?: string;
};

export type Retention = { maxEvents: number; maxAgeMs: number; maxBytes: number };

/** One retained durable event, with the size it contributes to the budget. */
type DurableEntry = { envelope: RacpEventEnvelope; appendedAt: number; bytes: number };

/**
 * Size estimate for the byte budget. The payload is already bounded by
 * `maxFrameBytes` on the way in, and `JSON.stringify` is the same measurement
 * the frame check performs, so one extra pass per durable event is the cost of
 * having a byte bound at all; UTF-16 length is used as a cheap proxy and is
 * accurate for the ASCII-heavy payloads that dominate transcripts.
 */
function estimateEventBytes(envelope: RacpEventEnvelope): number {
  try {
    return JSON.stringify(envelope)?.length ?? 0;
  } catch {
    return 0;
  }
}

export type ReplayDecision =
  | { status: "live" }
  | { status: "replay"; events: RacpEventEnvelope[] }
  | { status: "resync"; reason: "epoch" | "evicted" | "ahead" };

/**
 * One durable event stream: a Session's, or the Host's own. Durable events
 * get the next `sequence` inside this stream's `epoch`; ephemeral events get
 * `afterSequence` and are never retained (spec §5.3, §8).
 */
export class EventStream {
  readonly epoch: string;
  private sequence = 0;
  private readonly durable: DurableEntry[] = [];
  private bytes = 0;
  /** Last append or subscribe; the idle sweep reads it to find dead streams. */
  private lastActivityAt: number;

  constructor(
    epoch: string,
    private readonly retention: Retention,
    private readonly clock: Clock,
    private readonly ids: IdSource,
  ) {
    this.epoch = epoch;
    this.lastActivityAt = clock.now();
  }

  get lastSequence(): number {
    return this.sequence;
  }

  /** Durable events still retained (the replay window's event count). */
  get retainedEvents(): number {
    return this.durable.length;
  }

  /** Bytes those durable events occupy, as estimated at append time. */
  get retainedBytes(): number {
    return this.bytes;
  }

  get lastActivity(): number {
    return this.lastActivityAt;
  }

  /** When the oldest retained event was appended (`null` when empty). */
  get oldestAppendedAt(): number | null {
    return this.durable.length === 0 ? null : this.durable[0]!.appendedAt;
  }

  cursor(): RacpCursor {
    return { epoch: this.epoch, sequence: this.sequence };
  }

  /** Oldest durable sequence still retained, or `null` when nothing is. */
  get oldestRetained(): number | null {
    return this.durable.length === 0 ? null : (this.durable[0]!.envelope.sequence ?? null);
  }

  /** A subscriber is reading this stream; it must not be reaped as idle. */
  touch(): void {
    this.lastActivityAt = this.clock.now();
  }

  append(draft: EventDraft): RacpEventEnvelope {
    const now = this.clock.now();
    const durable = isDurableEventKind(draft.kind);
    const { occurredAt, ...rest } = draft;
    const envelope: RacpEventEnvelope = {
      ...rest,
      eventId: this.ids.next("evt"),
      epoch: this.epoch,
      occurredAt: occurredAt ?? new Date(now).toISOString(),
      ...(durable ? { sequence: this.sequence + 1 } : { afterSequence: this.sequence }),
    };
    this.lastActivityAt = now;
    if (durable) {
      this.sequence += 1;
      const bytes = estimateEventBytes(envelope);
      this.durable.push({ envelope, appendedAt: now, bytes });
      this.bytes += bytes;
      this.evict(now);
    }
    return envelope;
  }

  /**
   * Apply the age and byte bounds without a new append. An idle session never
   * calls `append`, so without this sweep its 24-hour window is never enforced.
   */
  sweep(now: number = this.clock.now()): void {
    this.evict(now);
  }

  /** Evict from the oldest end, keeping the newest event even when it alone
   * exceeds the byte budget: a stream with no events cannot be replayed at all. */
  evictOldest(count = 1): number {
    let removed = 0;
    while (removed < count && this.durable.length > 0) {
      const entry = this.durable.shift()!;
      this.bytes -= entry.bytes;
      removed += 1;
    }
    return removed;
  }

  private evict(now: number): void {
    while (this.durable.length > this.retention.maxEvents) this.evictOldest();
    while (this.durable.length > 0 && now - this.durable[0]!.appendedAt > this.retention.maxAgeMs) {
      this.evictOldest();
    }
    while (this.durable.length > 1 && this.bytes > this.retention.maxBytes) this.evictOldest();
  }

  /** Decide how a subscriber that presents `after` catches up (spec §8). */
  replay(after: RacpCursor | undefined): ReplayDecision {
    if (!after) return { status: "live" };
    if (after.epoch !== this.epoch) return { status: "resync", reason: "epoch" };
    if (after.sequence > this.sequence) return { status: "resync", reason: "ahead" };
    if (after.sequence === this.sequence) return { status: "replay", events: [] };
    const oldest = this.oldestRetained;
    // Every event with sequence > after must still be retained; the first one
    // needed is after + 1.
    if (oldest === null || oldest > after.sequence + 1) return { status: "resync", reason: "evicted" };
    return {
      status: "replay",
      events: this.durable
        .filter((entry) => (entry.envelope.sequence ?? 0) > after.sequence)
        .map((entry) => entry.envelope),
    };
  }
}

export type SubscriptionSink = {
  deliver(envelope: RacpEventEnvelope): void;
  /** Called once when the Host closes the subscription, e.g. `CLIENT_TOO_SLOW`. */
  close(error: RacpError, lastSafeCursor: RacpCursor): void;
};

export type SubscribeParams = {
  scope: "session" | "host";
  sessionId?: string;
  after?: RacpCursor;
  /** Durable events delivered but not yet acknowledged before the Host
   * considers the subscriber too slow. */
  maxOutstanding?: number;
};

export type SubscribeResult = {
  subscriptionId: string;
  scope: "session" | "host";
  sessionId?: string;
  starting: RacpCursor;
  replayComplete: boolean;
  resyncReason?: "epoch" | "evicted" | "ahead";
};

type Subscription = {
  id: string;
  scope: "session" | "host";
  sessionId?: string;
  sink: SubscriptionSink;
  maxOutstanding: number;
  outstanding: number;
  lastDelivered: RacpCursor;
};

/**
 * Per-session and host-scope streams plus bounded fan-out. Every subscriber
 * keeps an outstanding count of durable events it has not acknowledged;
 * ephemeral events are dropped first, and a durable event that would exceed
 * the bound closes the subscription with `CLIENT_TOO_SLOW` and a resumable
 * cursor instead of losing anything (spec §8).
 */
export type EventHubStats = {
  streams: number;
  events: number;
  bytes: number;
  maxBytesPerStream: number;
  maxBytesTotal: number;
};

export class EventHub {
  private readonly streams = new Map<string, EventStream>();
  private readonly host: EventStream;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly retention: Retention;
  private readonly totalBytesLimit: number;
  private readonly defaultMaxOutstanding: number;

  constructor(
    private readonly deps: { clock: Clock; ids: IdSource; limits?: Partial<RacpLimits> },
  ) {
    const limits = { ...RACP_DEFAULT_LIMITS, ...deps.limits };
    this.retention = {
      maxEvents: limits.replayWindowEvents,
      maxAgeMs: limits.replayWindowMs,
      maxBytes: limits.replayWindowBytesPerStream,
    };
    this.totalBytesLimit = limits.replayWindowBytesTotal;
    this.defaultMaxOutstanding = 1000;
    this.host = new EventStream(deps.ids.next("ep"), this.retention, deps.clock, deps.ids);
  }

  stream(sessionId: string): EventStream {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = new EventStream(this.deps.ids.next("ep"), this.retention, this.deps.clock, this.deps.ids);
      this.streams.set(sessionId, stream);
    }
    return stream;
  }

  hostStream(): EventStream {
    return this.host;
  }

  /** Drop one Session's stream and close whatever was reading it. */
  dropSession(sessionId: string): boolean {
    const removed = this.streams.delete(sessionId);
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.scope !== "session" || subscription.sessionId !== sessionId) continue;
      this.subscriptions.delete(subscription.id);
      subscription.sink.close(
        racpError("CURSOR_EXPIRED", "the session's event stream was released", {
          details: { lastSafeCursor: subscription.lastDelivered },
        }),
        subscription.lastDelivered,
      );
    }
    return removed;
  }

  /**
   * Apply every bound without waiting for an append: the age window to each
   * stream (idle sessions otherwise keep a 24-hour window forever) and the
   * global byte budget across streams.
   */
  sweep(now: number = this.deps.clock.now()): void {
    this.host.sweep(now);
    for (const stream of this.streams.values()) stream.sweep(now);
    this.enforceTotalBytes();
  }

  /**
   * Last durable activity of a session's stream, or `null` when the session
   * never had one. Read-only: it must not create a stream just to answer.
   */
  lastActivityFor(sessionId: string): number | null {
    return this.streams.get(sessionId)?.lastActivity ?? null;
  }

  stats(): EventHubStats {
    let events = this.host.retainedEvents;
    let bytes = this.host.retainedBytes;
    for (const stream of this.streams.values()) {
      events += stream.retainedEvents;
      bytes += stream.retainedBytes;
    }
    return {
      streams: this.streams.size,
      events,
      bytes,
      maxBytesPerStream: this.retention.maxBytes,
      maxBytesTotal: this.totalBytesLimit,
    };
  }

  /**
   * Take whole events from the stalest stream until the total fits. Evicting
   * one event at a time from the oldest end keeps every other stream's replay
   * window intact and degrades to `resync: evicted` only where it must.
   */
  private enforceTotalBytes(): void {
    if (this.totalBytesLimit <= 0) return;
    for (;;) {
      let total = this.host.retainedBytes;
      let stalest: EventStream | undefined;
      let stalestAt = Number.POSITIVE_INFINITY;
      for (const stream of this.streams.values()) {
        total += stream.retainedBytes;
        const oldest = stream.oldestAppendedAt;
        if (oldest !== null && oldest < stalestAt) {
          stalestAt = oldest;
          stalest = stream;
        }
      }
      if (total <= this.totalBytesLimit) return;
      if (!stalest || stalest.evictOldest() === 0) return;
    }
  }

  /** Append to the right stream and fan out. Returns the allocated envelope. */
  publish(draft: EventDraft): RacpEventEnvelope {
    const stream = draft.scope === "host" ? this.host : this.stream(requireSession(draft));
    const envelope = stream.append(draft);
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.scope !== draft.scope) continue;
      if (draft.scope === "session" && subscription.sessionId !== draft.sessionId) continue;
      this.deliver(subscription, envelope);
    }
    if (stream.retainedBytes > 0) this.enforceTotalBytes();
    return envelope;
  }

  subscribe(params: SubscribeParams, sink: SubscriptionSink): SubscribeResult {
    const stream = params.scope === "host" ? this.host : this.stream(requireSessionId(params.sessionId));
    const id = this.deps.ids.next("sub");
    const subscription: Subscription = {
      id,
      scope: params.scope,
      sessionId: params.sessionId,
      sink,
      maxOutstanding: params.maxOutstanding ?? this.defaultMaxOutstanding,
      outstanding: 0,
      lastDelivered: params.after ?? stream.cursor(),
    };
    const decision = stream.replay(params.after);
    this.subscriptions.set(id, subscription);
    let replayComplete = true;
    let resyncReason: SubscribeResult["resyncReason"];
    if (decision.status === "replay") {
      for (const envelope of decision.events) this.deliver(subscription, envelope);
    } else if (decision.status === "resync") {
      replayComplete = false;
      resyncReason = decision.reason;
      subscription.lastDelivered = stream.cursor();
    } else {
      subscription.lastDelivered = stream.cursor();
    }
    return {
      subscriptionId: id,
      scope: params.scope,
      sessionId: params.sessionId,
      starting: { epoch: stream.epoch, sequence: subscription.lastDelivered.sequence + 1 },
      replayComplete,
      ...(resyncReason ? { resyncReason } : {}),
    };
  }

  unsubscribe(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  /** The subscriber applied every durable event up to `sequence`. */
  ack(subscriptionId: string, sequence: number): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    if (sequence >= subscription.lastDelivered.sequence) subscription.outstanding = 0;
    else subscription.outstanding = Math.max(0, subscription.lastDelivered.sequence - sequence);
  }

  subscriptionCount(): number {
    return this.subscriptions.size;
  }

  private deliver(subscription: Subscription, envelope: RacpEventEnvelope): void {
    if (!this.subscriptions.has(subscription.id)) return;
    const durable = typeof envelope.sequence === "number";
    if (!durable) {
      // Ephemeral events are replaceable; a lagging client just misses them.
      if (subscription.outstanding >= subscription.maxOutstanding / 2) return;
      subscription.sink.deliver(envelope);
      return;
    }
    if (subscription.outstanding >= subscription.maxOutstanding) {
      this.subscriptions.delete(subscription.id);
      subscription.sink.close(
        racpError("CLIENT_TOO_SLOW", "subscriber did not acknowledge durable events in time", {
          details: { lastSafeCursor: subscription.lastDelivered },
        }),
        subscription.lastDelivered,
      );
      return;
    }
    subscription.outstanding += 1;
    subscription.lastDelivered = { epoch: envelope.epoch, sequence: envelope.sequence! };
    subscription.sink.deliver(envelope);
  }
}

function requireSession(draft: EventDraft): string {
  return requireSessionId(draft.sessionId);
}

function requireSessionId(sessionId: string | undefined): string {
  if (!sessionId) throw racpError("INVALID_ARGUMENT", "sessionId is required for session-scoped events");
  return sessionId;
}
