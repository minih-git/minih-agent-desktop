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
const projects: Screen = { kind: "projects", hostId: "h1" };
const sessions: Screen = { kind: "projectSessions", hostId: "h1", projectId: "p1", projectLabel: "Desktop" };
const session: Screen = {
  kind: "session",
  hostId: "h1",
  sessionId: "s1",
  title: "one",
  projectId: "p1",
  projectLabel: "Desktop",
};

/**
 * The screen stack is written into the browser's history, so a browser Back and
 * Safari's edge gesture step up one level instead of leaving the site. These pin
 * the two things that can go wrong: an entry that cannot be read back, and a
 * navigation that stacks a duplicate entry so one gesture pops twice.
 */
describe("screenFromHistoryState", () => {
  it("round-trips every screen", () => {
    for (const screen of [
      hosts,
      sessions,
      session,
      { kind: "pair" } as Screen,
      { kind: "account" } as Screen,
      { kind: "chats" } as Screen,
      { kind: "chat" } as Screen,
      { kind: "chatArchive" } as Screen,
      { kind: "modelGateway", from: "chats" } as Screen,
      { kind: "modelGateway", from: "hosts", viaSettings: true } as Screen,
      { kind: "settings", from: "hosts" } as Screen,
    ]) {
      expect(screenFromHistoryState({ screen })).toEqual(screen);
    }
  });

  it("refuses a settings entry whose origin is not a root", () => {
    expect(screenFromHistoryState({ screen: { kind: "settings", from: "session" } })).toBeNull();
  });

  it("treats the two roots as different destinations", () => {
    expect(sameScreen({ kind: "chats" }, { kind: "hosts" })).toBe(false);
    expect(sameScreen({ kind: "chats" }, { kind: "chats" })).toBe(true);
    expect(sameScreen({ kind: "settings", from: "chats" }, { kind: "settings", from: "hosts" })).toBe(false);
    expect(sameScreen({ kind: "settings", from: "chats" }, { kind: "settings", from: "chats" })).toBe(true);
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
      screen: { kind: "projectSessions", hostId: "h1", projectId: "p1", projectLabel: "Desktop" },
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
    expect(calls.map((call) => call.kind)).toEqual(["replace", "push", "push", "push"]);
    expect(calls.map((call) => call.screen.kind)).toEqual(["hosts", "projects", "projectSessions", "session"]);
  });

  it("never stacks a duplicate entry for the screen already shown", () => {
    const { calls, port: history } = port();
    const writer = createScreenHistory(history);
    writer.sync(hosts);
    writer.sync(hosts);
    writer.sync(hosts);
    expect(calls.filter((call) => call.kind === "push")).toHaveLength(0);
  });

  it("replaces the Chats root when a notification switches the root to Computers", () => {
    // A computer notification owns its path (ADR): the root becomes Computers.
    // The sideways move rewrites the entries the stack had mirrored — the Chats
    // root is replaced by `hosts`, the skipped level is left for a back step —
    // so Back from the restored stack never walks back to Chats.
    const { calls, port: history } = port();
    const writer = createScreenHistory(history);
    writer.sync({ kind: "chats" });
    writer.sync({ kind: "projects", hostId: "h1" });
    expect(calls.map((call) => call.kind)).toEqual(["replace", "replace", "push"]);
    expect(calls.map((call) => call.screen.kind)).toEqual(["chats", "hosts", "projects"]);
    writer.sync({ kind: "session", hostId: "h1", sessionId: "s1", title: "" });
    expect(calls.at(-1)?.kind).toBe("push");
    expect(calls.at(-1)?.screen).toEqual({ kind: "session", hostId: "h1", sessionId: "s1", title: "" });
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
    // Pairing is replaced, not stacked: the project list is the level a back step
    // from those sessions has to land on (§17.3), and the pairing screen is not.
    expect(calls.map((call) => call.kind)).toEqual(["replace", "push", "replace", "push"]);
    expect(calls.at(-1)?.screen).toEqual(sessions);
    expect(calls.map((call) => call.screen.kind)).toEqual(["hosts", "pair", "projects", "projectSessions"]);
    expect(writer.peek()).toEqual(sessions);
  });

  it("pushes every level a notification shortcut jumps over", () => {
    const { calls, port: history } = port();
    const writer = createScreenHistory(history);
    writer.sync(hosts);
    writer.sync(session);
    expect(calls.map((call) => call.kind)).toEqual(["replace", "push", "push", "push"]);
    expect(calls[1]?.screen).toEqual(projects);
    expect(calls[2]?.screen).toEqual(sessions);
    expect(calls[3]?.screen).toEqual(session);
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
    expect(screenChain(projects)).toEqual([hosts, projects]);
    expect(screenChain(sessions)).toEqual([hosts, projects, sessions]);
    expect(screenChain(session)).toEqual([hosts, projects, sessions, session]);
    expect(screenChain({ kind: "pair" })).toEqual([hosts, { kind: "pair" }]);
  });
});

describe("sameScreen", () => {
  it("compares by destination, not by object identity", () => {
    expect(sameScreen(sessions, { ...sessions })).toBe(true);
    expect(sameScreen(projects, { kind: "projects", hostId: "h2" })).toBe(false);
    expect(sameScreen(sessions, { ...sessions, projectId: "p2" })).toBe(false);
    expect(sameScreen(session, { ...session })).toBe(true);
    expect(sameScreen(session, { ...session, title: "renamed" })).toBe(false);
    expect(sameScreen(hosts, projects)).toBe(false);
  });
});
