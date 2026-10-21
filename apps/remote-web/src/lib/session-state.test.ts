import { describe, expect, it } from "vitest";

import {
  SESSION_VIEWS_STORAGE_KEY,
  createSessionViews,
  memorySessionViews,
  needsUser,
  sessionStateOf,
} from "./session-state.js";

const NOW = "2026-10-21T10:00:00.000Z";

describe("sessionStateOf", () => {
  it("puts an approval ahead of a running turn the Host reports beside it", () => {
    expect(sessionStateOf({ status: "waiting_permission", updatedAt: NOW })).toBe("approval");
    expect(sessionStateOf({ status: "running", planningState: "awaiting_approval" })).toBe("approval");
  });

  it("reads an answer learned from a push, because the session itself stays running", () => {
    const local = { inputPendingAt: "2026-10-21T09:59:00.000Z" };
    expect(sessionStateOf({ status: "running" }, local)).toBe("input");
    // Without the push the same session is indistinguishable from a busy one: that
    // is the documented limit of §17.4.1, not a bug.
    expect(sessionStateOf({ status: "running" })).toBe("running");
  });

  it("reports a failure as settled, whatever it saw", () => {
    expect(sessionStateOf({ status: "error" }, { inputPendingAt: NOW })).toBe("error");
  });

  it("calls a finished session unseen until this device has opened it", () => {
    const updated = "2026-10-21T09:30:00.000Z";
    expect(sessionStateOf({ status: "idle", updatedAt: updated })).toBe("idle");
    expect(sessionStateOf({ status: "idle", updatedAt: updated }, { lastViewedAt: "2026-10-21T09:00:00.000Z" })).toBe("unseen");
    expect(sessionStateOf({ status: "idle", updatedAt: updated }, { lastViewedAt: "2026-10-21T10:00:00.000Z" })).toBe("idle");
    expect(sessionStateOf({ status: "aborted", updatedAt: updated }, { lastViewedAt: "2026-10-21T09:00:00.000Z" })).toBe("unseen");
  });

  it("treats a missing or unparsable timestamp as looked at rather than as new work", () => {
    expect(sessionStateOf({ status: "idle" }, { lastViewedAt: NOW })).toBe("idle");
    expect(sessionStateOf({ status: "idle", updatedAt: "not a date" }, { lastViewedAt: NOW })).toBe("idle");
  });

  it("collects exactly the two attention states", () => {
    expect(needsUser("approval")).toBe(true);
    expect(needsUser("input")).toBe(true);
    expect(needsUser("running")).toBe(false);
    expect(needsUser("unseen")).toBe(false);
  });
});

describe("session views store", () => {
  it("remembers when a session was opened, and forgets the pending answer with it", () => {
    const storage = memorySessionViews();
    const views = createSessionViews(storage, () => NOW);

    views.markInputPending("h1", "s1", "2026-10-21T09:50:00.000Z");
    expect(views.get("h1", "s1")).toEqual({ inputPendingAt: "2026-10-21T09:50:00.000Z" });

    views.markViewed("h1", "s1");
    expect(views.get("h1", "s1")).toEqual({ lastViewedAt: NOW });
  });

  it("keeps hosts and sessions apart", () => {
    const views = createSessionViews(memorySessionViews(), () => NOW);
    views.markViewed("h1", "s1");
    views.markViewed("h2", "s2");

    expect(views.get("h1", "s1")).toEqual({ lastViewedAt: NOW });
    expect(views.get("h2", "s2")).toEqual({ lastViewedAt: NOW });
    expect(views.get("h1", "s2")).toBeUndefined();
  });

  it("drops the entry rather than writing an empty one", () => {
    const storage = memorySessionViews();
    const views = createSessionViews(storage, () => NOW);
    views.markViewed("h1", "s1");
    views.clear("h1", "s1");

    expect(views.get("h1", "s1")).toBeUndefined();
    expect(storage.getItem(SESSION_VIEWS_STORAGE_KEY)).toBe('{"version":1,"hosts":{}}');
  });

  it("survives a file it did not write", () => {
    const storage = memorySessionViews();
    storage.setItem(SESSION_VIEWS_STORAGE_KEY, "{not json");
    expect(createSessionViews(storage).get("h1", "s1")).toBeUndefined();

    storage.setItem(SESSION_VIEWS_STORAGE_KEY, JSON.stringify({ version: 1, hosts: { h1: { s1: { lastViewedAt: NOW, extra: 1 } } } }));
    expect(createSessionViews(storage).get("h1", "s1")).toEqual({ lastViewedAt: NOW });
  });
});
