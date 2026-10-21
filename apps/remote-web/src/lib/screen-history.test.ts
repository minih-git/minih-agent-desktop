import { describe, expect, it } from "vitest";

import {
  createScreenHistory,
  screenChain,
  resolvePop,
  sameScreen,
  screenFromHistoryState,
} from "./screen-history.js";
import type { Screen } from "./screen-stack.js";

const hosts: Screen = { kind: "hosts" };
const sessions: Screen = { kind: "sessions", hostId: "h1" };
const session: Screen = { kind: "session", hostId: "h1", sessionId: "s1", title: "one" };

/**
 * The screen stack is written into the browser's history, so a browser Back and
 * Safari's edge gesture step up one level instead of leaving the site. These pin
 * the two things that can go wrong: an entry that cannot be read back, and a
 * navigation that stacks a duplicate entry so one gesture pops twice.
 */
describe("screenFromHistoryState", () => {
  it("round-trips every screen", () => {
    for (const screen of [hosts, sessions, session, { kind: "pair" } as Screen, { kind: "account" } as Screen]) {
      expect(screenFromHistoryState({ screen })).toEqual(screen);
    }
  });

  it("ignores state that is not ours, rather than throwing", () => {
    for (const state of [null, undefined, 0, "x", {}, { screen: null }, { screen: { kind: "nope" } }]) {
      expect(screenFromHistoryState(state)).toBeNull();
    }
  });

  it("drops a screen with no identity instead of opening a blank one", () => {
    expect(screenFromHistoryState({ screen: { kind: "sessions" } })).toBeNull();
    expect(screenFromHistoryState({ screen: { kind: "session", hostId: "h1" } })).toBeNull();
    // A missing title is not a reason to refuse: the id is what opens it.
    expect(screenFromHistoryState({ screen: { kind: "session", hostId: "h1", sessionId: "s1" } })).toEqual({
      kind: "session",
      hostId: "h1",
      sessionId: "s1",
      title: "",
    });
  });
});

describe("resolvePop", () => {
  it("adopts the screen the entry names", () => {
    expect(resolvePop({ state: { screen: sessions }, current: session })).toEqual({
      kind: "restored",
      screen: sessions,
    });
  });

  it("falls back to previousScreen for an entry written by an older build", () => {
    expect(resolvePop({ state: null, current: session })).toEqual({
      kind: "restored",
      screen: { kind: "sessions", hostId: "h1" },
    });
    expect(resolvePop({ state: null, current: hosts })).toEqual({ kind: "leave" });
  });
});

describe("createScreenHistory", () => {
  const port = () => {
    const calls: Array<{ kind: "push" | "replace"; screen: Screen }> = [];
    return {
      calls,
      port: {
        push: (screen: Screen) => calls.push({ kind: "push", screen }),
        replace: (screen: Screen) => calls.push({ kind: "replace", screen }),
        state: () => null,
      },
    };
  };

  it("replaces the entry the user arrived on, then pushes one per level", () => {
    const { calls, port: history } = port();
    const writer = createScreenHistory(history);
    writer.sync(hosts);
    writer.sync(sessions);
    writer.sync(session);
    expect(calls.map((call) => call.kind)).toEqual(["replace", "push", "push"]);
  });

  it("never stacks a duplicate entry for the screen already shown", () => {
    const { calls, port: history } = port();
    const writer = createScreenHistory(history);
    writer.sync(hosts);
    writer.sync(hosts);
    writer.sync(hosts);
    expect(calls.filter((call) => call.kind === "push")).toHaveLength(0);
  });

  it("leaves the level a navigation skipped, so a back step lands on it", () => {
    const { calls, port: history } = port();
    const writer = createScreenHistory(history);
    const pair: Screen = { kind: "pair" };
    writer.sync(hosts);
    writer.sync(pair);
    // Pairing one computer opens its session list without visiting the host
    // list; the entry a back step needs has to be written anyway.
    writer.sync(sessions);
    expect(calls.map((call) => call.kind)).toEqual(["replace", "push", "replace"]);
    expect(calls.at(-1)?.screen).toEqual(sessions);
    expect(writer.peek()).toEqual(sessions);
  });

  it("pushes every level a notification shortcut jumps over", () => {
    const { calls, port: history } = port();
    const writer = createScreenHistory(history);
    writer.sync(hosts);
    writer.sync(session);
    expect(calls.map((call) => call.kind)).toEqual(["replace", "push", "push"]);
    expect(calls[1]?.screen).toEqual(sessions);
    expect(calls[2]?.screen).toEqual(session);
  });

  it("replaces instead of pushing when the app steps up without a pop", () => {
    const { calls, port: history } = port();
    const writer = createScreenHistory(history);
    writer.sync(hosts);
    writer.sync(sessions);
    writer.sync(session);
    writer.sync(sessions);
    expect(calls.at(-1)?.kind).toBe("replace");
    expect(calls.at(-1)?.screen).toEqual(sessions);
    expect(writer.peek()).toEqual(sessions);
  });

  it("adopting a popped screen does not write history again", () => {
    const { calls, port: history } = port();
    const writer = createScreenHistory(history);
    writer.sync(hosts);
    writer.sync(sessions);
    const before = calls.length;
    writer.adopt(hosts);
    expect(calls).toHaveLength(before);
    expect(writer.peek()).toEqual(hosts);
    // The next forward navigation pushes, because it moved away from the entry.
    writer.sync(sessions);
    expect(calls.at(-1)?.kind).toBe("push");
  });
});

describe("screenChain", () => {
  it("names every level above a screen, root first", () => {
    expect(screenChain(hosts)).toEqual([hosts]);
    expect(screenChain(sessions)).toEqual([hosts, sessions]);
    expect(screenChain(session)).toEqual([hosts, sessions, session]);
    expect(screenChain({ kind: "pair" })).toEqual([hosts, { kind: "pair" }]);
  });
});

describe("sameScreen", () => {
  it("compares by destination, not by object identity", () => {
    expect(sameScreen({ kind: "sessions", hostId: "h1" }, { kind: "sessions", hostId: "h1" })).toBe(true);
    expect(sameScreen({ kind: "sessions", hostId: "h1" }, { kind: "sessions", hostId: "h2" })).toBe(false);
    expect(sameScreen(session, { ...session })).toBe(true);
    expect(sameScreen(session, { ...session, title: "renamed" })).toBe(false);
    expect(sameScreen(hosts, sessions)).toBe(false);
  });
});
