import { describe, expect, it } from "vitest";

import type { RacpLimits } from "@minih-agent/shared";

import { EventHub, EventStream, type Retention } from "./event-log.js";
import { RacpError } from "./errors.js";
import type { Clock, IdSource } from "./ports.js";

class FixedClock implements Clock {
  constructor(public current = 1_000_000) {}
  now(): number {
    return this.current;
  }
}

class SeqIds implements IdSource {
  private counter = 0;
  next(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }
}
function stream(retention: Partial<Retention> = {}, clock = new FixedClock()) {
  return new EventStream(
    "ep_1",
    { maxEvents: 100, maxAgeMs: 60_000, maxBytes: 8 * 1024 * 1024, ...retention },
    clock,
    new SeqIds(),
  );
}

const draft = (kind: "item.completed" | "item.delta", sessionId = "s1") => ({
  scope: "session" as const,
  sessionId,
  revision: 1,
  kind,
  payload: {},
});

describe("EventStream", () => {
  it("sequences durable events and tags ephemeral ones with afterSequence", () => {
    const log = stream();
    const first = log.append(draft("item.completed"));
    const delta = log.append(draft("item.delta"));
    const second = log.append(draft("item.completed"));
    expect(first.sequence).toBe(1);
    expect(first.afterSequence).toBeUndefined();
    expect(delta.sequence).toBeUndefined();
    expect(delta.afterSequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(log.cursor()).toEqual({ epoch: "ep_1", sequence: 2 });
    expect(delta.epoch).toBe("ep_1");
  });

  it("replays retained durable events after a cursor and never a delta", () => {
    const log = stream();
    log.append(draft("item.completed"));
    log.append(draft("item.delta"));
    log.append(draft("item.completed"));
    log.append(draft("item.completed"));
    const decision = log.replay({ epoch: "ep_1", sequence: 1 });
    expect(decision.status).toBe("replay");
    if (decision.status !== "replay") throw new Error("unreachable");
    expect(decision.events.map((event) => event.sequence)).toEqual([2, 3]);
    expect(log.replay({ epoch: "ep_1", sequence: 3 })).toEqual({ status: "replay", events: [] });
  });

  it("resynchronizes on epoch change, eviction, and a cursor ahead of the host", () => {
    const log = stream({ maxEvents: 2, maxAgeMs: 60_000 });
    for (let index = 0; index < 4; index += 1) log.append(draft("item.completed"));
    expect(log.replay({ epoch: "ep_old", sequence: 1 })).toEqual({ status: "resync", reason: "epoch" });
    expect(log.replay({ epoch: "ep_1", sequence: 9 })).toEqual({ status: "resync", reason: "ahead" });
    expect(log.replay({ epoch: "ep_1", sequence: 1 })).toEqual({ status: "resync", reason: "evicted" });
    expect(log.replay({ epoch: "ep_1", sequence: 2 }).status).toBe("replay");
    expect(log.replay(undefined)).toEqual({ status: "live" });
  });

  it("evicts by age", () => {
    const clock = new FixedClock();
    const log = stream({ maxEvents: 100, maxAgeMs: 1_000 }, clock);
    log.append(draft("item.completed"));
    clock.current += 5_000;
    log.append(draft("item.completed"));
    expect(log.oldestRetained).toBe(2);
  });
});

describe("EventHub", () => {
  function hub() {
    return new EventHub({ clock: new FixedClock(), ids: new SeqIds() });
  }

  it("fans out per session and replays from a cursor on subscribe", () => {
    const events = hub();
    events.publish(draft("item.completed", "s1"));
    events.publish(draft("item.completed", "s1"));
    events.publish(draft("item.completed", "s2"));
    const received: number[] = [];
    const result = events.subscribe(
      { scope: "session", sessionId: "s1", after: { epoch: events.stream("s1").epoch, sequence: 1 } },
      { deliver: (envelope) => received.push(envelope.sequence!), close: () => {} },
    );
    expect(result.replayComplete).toBe(true);
    expect(result.starting.sequence).toBe(3);
    expect(received).toEqual([2]);
    events.publish(draft("item.completed", "s2"));
    events.publish(draft("item.completed", "s1"));
    expect(received).toEqual([2, 3]);
  });

  it("reports a resync instead of inventing events", () => {
    const events = hub();
    events.publish(draft("item.completed", "s1"));
    const result = events.subscribe(
      { scope: "session", sessionId: "s1", after: { epoch: "stale", sequence: 1 } },
      { deliver: () => {}, close: () => {} },
    );
    expect(result.replayComplete).toBe(false);
    expect(result.resyncReason).toBe("epoch");
  });

  it("drops ephemeral events first and closes a slow subscriber with a resumable cursor", () => {
    const events = hub();
    const delivered: string[] = [];
    let closed: { error: RacpError; sequence: number } | undefined;
    events.subscribe(
      { scope: "session", sessionId: "s1", maxOutstanding: 2 },
      {
        deliver: (envelope) => delivered.push(envelope.kind + ":" + (envelope.sequence ?? "e")),
        close: (error, cursor) => {
          closed = { error, sequence: cursor.sequence };
        },
      },
    );
    events.publish(draft("item.completed", "s1"));
    events.publish(draft("item.delta", "s1"));
    events.publish(draft("item.completed", "s1"));
    events.publish(draft("item.delta", "s1"));
    events.publish(draft("item.completed", "s1"));
    expect(delivered).toEqual(["item.completed:1", "item.completed:2"]);
    expect(closed?.error.code).toBe("CLIENT_TOO_SLOW");
    expect(closed?.sequence).toBe(2);
    expect(events.subscriptionCount()).toBe(0);
  });

  it("lets an acknowledging subscriber keep receiving", () => {
    const events = hub();
    const delivered: number[] = [];
    const { subscriptionId } = events.subscribe(
      { scope: "session", sessionId: "s1", maxOutstanding: 2 },
      { deliver: (envelope) => delivered.push(envelope.sequence!), close: () => {} },
    );
    events.publish(draft("item.completed", "s1"));
    events.publish(draft("item.completed", "s1"));
    events.ack(subscriptionId, 2);
    events.publish(draft("item.completed", "s1"));
    expect(delivered).toEqual([1, 2, 3]);
  });

  it("keeps a separate host-scope stream", () => {
    const events = hub();
    const received: string[] = [];
    events.subscribe({ scope: "host" }, { deliver: (envelope) => received.push(envelope.kind), close: () => {} });
    events.publish({ scope: "host", revision: 0, kind: "session.created", payload: {} });
    events.publish(draft("item.completed", "s1"));
    expect(received).toEqual(["session.created"]);
    expect(events.hostStream().lastSequence).toBe(1);
  });
});

/** A durable draft whose payload carries `bytes` characters of content. */
function payloadDraft(bytes: number, sessionId = "s1") {
  return {
    scope: "session" as const,
    sessionId,
    revision: 1,
    kind: "item.completed" as const,
    payload: { text: "x".repeat(bytes) },
  };
}

describe("EventStream retention bounds", () => {
  it("evicts the oldest durable events when the byte budget is exceeded", () => {
    const log = stream({ maxBytes: 4_000 });
    for (let index = 0; index < 10; index += 1) log.append(payloadDraft(1_000));
    expect(log.retainedBytes).toBeLessThanOrEqual(4_000);
    expect(log.retainedEvents).toBeLessThan(10);
    // A cursor that fell behind the budget is told to resync, not handed a gap.
    expect(log.replay({ epoch: "ep_1", sequence: 1 })).toEqual({ status: "resync", reason: "evicted" });
    expect(log.replay({ epoch: "ep_1", sequence: log.lastSequence }).status).toBe("replay");
  });

  it("keeps the newest event even when it alone exceeds the budget", () => {
    const log = stream({ maxBytes: 100 });
    log.append(payloadDraft(5_000));
    expect(log.retainedEvents).toBe(1);
    expect(log.lastSequence).toBe(1);
  });

  it("applies the age bound without waiting for another append", () => {
    const clock = new FixedClock();
    const log = stream({ maxAgeMs: 1_000 }, clock);
    log.append(payloadDraft(10));
    clock.current += 5_000;
    // Nothing has been appended, so only an explicit sweep can enforce the age.
    expect(log.retainedEvents).toBe(1);
    log.sweep();
    expect(log.retainedEvents).toBe(0);
    expect(log.replay({ epoch: "ep_1", sequence: 0 })).toEqual({ status: "resync", reason: "evicted" });
  });
});

describe("EventHub release and budgets", () => {
  const hub = (limits: Partial<RacpLimits> = {}) =>
    new EventHub({ clock: new FixedClock(), ids: new SeqIds(), limits });

  it("drops a session stream and closes its subscribers", () => {
    const events = hub();
    events.publish(payloadDraft(10, "s1"));
    const closed: { code: string; sequence: number }[] = [];
    events.subscribe(
      { scope: "session", sessionId: "s1" },
      {
        deliver: () => {},
        close: (error, cursor) => closed.push({ code: error.code, sequence: cursor.sequence }),
      },
    );
    const before = events.stream("s1").epoch;
    expect(events.dropSession("s1")).toBe(true);
    expect(closed).toEqual([{ code: "CURSOR_EXPIRED", sequence: 1 }]);
    expect(events.stats().streams).toBe(0);
    // A recreated stream is a new epoch, so an old cursor resyncs instead of
    // replaying sequences that no longer exist.
    expect(events.stream("s1").epoch).not.toBe(before);
    const result = events.subscribe(
      { scope: "session", sessionId: "s1", after: { epoch: before, sequence: 1 } },
      { deliver: () => {}, close: () => {} },
    );
    expect(result.resyncReason).toBe("epoch");
  });

  it("evicts from the stalest stream when the global byte budget is exceeded", () => {
    const events = hub({ replayWindowBytesPerStream: 100_000, replayWindowBytesTotal: 3_000 });
    events.publish(payloadDraft(1_000, "old"));
    events.publish(payloadDraft(1_000, "new"));
    events.publish(payloadDraft(1_000, "new"));
    events.publish(payloadDraft(1_000, "new"));
    expect(events.stats().bytes).toBeLessThanOrEqual(3_000);
    expect(events.stream("old").retainedEvents).toBe(0);
    expect(events.stream("new").retainedEvents).toBeGreaterThan(0);
  });

  it("reports stream, event and byte totals for diagnostics", () => {
    const events = hub();
    events.publish(payloadDraft(10, "s1"));
    events.publish(payloadDraft(10, "s2"));
    const stats = events.stats();
    expect(stats.streams).toBe(2);
    expect(stats.events).toBe(2);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.maxBytesPerStream).toBe(8 * 1024 * 1024);
    expect(stats.maxBytesTotal).toBe(64 * 1024 * 1024);
  });
});
