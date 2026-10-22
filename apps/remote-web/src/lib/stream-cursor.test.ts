/**
 * The start cursor of an event stream (rollout D, review B2).
 *
 * The regression this pins: the hook passed the snapshot's cursor on *every*
 * open, so a reconnect after a drop replayed the whole page from the snapshot
 * instead of resuming where the stream stopped. On a long conversation that can
 * fall outside the Host's replay window and cost a full re-attach.
 */
import { describe, expect, it } from "vitest";

import { createStartCursor } from "./stream-cursor.js";

const cursor = { epoch: "epoch-1", sequence: 42 };

describe("createStartCursor", () => {
  it("hands the snapshot's cursor to the first open only", () => {
    const start = createStartCursor();
    start.set(cursor);

    expect(start.take()).toEqual(cursor);
    // The reconnect is a different question: it resumes from the last event the
    // stream delivered, which the stream itself remembers.
    expect(start.take()).toBeUndefined();
    expect(start.take()).toBeUndefined();
  });

  it("has nothing to offer before a snapshot arrives", () => {
    const start = createStartCursor();

    expect(start.take()).toBeUndefined();
  });

  it("arms the next open again after a fresh snapshot", () => {
    const start = createStartCursor();
    start.set(cursor);
    expect(start.take()).toEqual(cursor);

    const resynced = { epoch: "epoch-2", sequence: 7 };
    start.set(resynced);
    expect(start.take()).toEqual(resynced);
    expect(start.take()).toBeUndefined();
  });

  it("treats a snapshot without a cursor as nothing to start from", () => {
    const start = createStartCursor();
    start.set(cursor);
    start.set(null);

    expect(start.take()).toBeUndefined();
  });
});
