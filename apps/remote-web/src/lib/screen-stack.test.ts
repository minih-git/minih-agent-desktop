import { describe, expect, it } from "vitest";

import { isRootKind, isRootScreen, previousScreen } from "./screen-stack.js";

/**
 * Every back path — the header button, Android's hardware back, the browser's
 * Back, and the iOS edge swipe — goes through this one rule (spec §17.3), so it
 * is tested as a rule rather than through a screen.
 */
describe("previousScreen", () => {
  it("goes from a session to the project it was opened from", () => {
    expect(
      previousScreen({
        kind: "session",
        hostId: "host1",
        sessionId: "s1",
        title: "one",
        projectId: "p1",
        projectLabel: "Desktop",
      }),
    ).toEqual({ kind: "projectSessions", hostId: "host1", projectId: "p1", projectLabel: "Desktop" });
  });

  it("goes from a pushed session to the project list, because a payload names no project", () => {
    expect(previousScreen({ kind: "session", hostId: "host1", sessionId: "s1", title: "" })).toEqual({
      kind: "projects",
      hostId: "host1",
    });
  });

  it("goes from one project's sessions back to the project list", () => {
    expect(
      previousScreen({ kind: "projectSessions", hostId: "host1", projectId: "p1", projectLabel: "Desktop" }),
    ).toEqual({ kind: "projects", hostId: "host1" });
  });

  it("skips the project list when there was only one project to choose from", () => {
    expect(
      previousScreen({
        kind: "projectSessions",
        hostId: "host1",
        projectId: "p1",
        projectLabel: "Desktop",
        viaProjects: false,
      }),
    ).toEqual({ kind: "hosts" });
  });

  it("goes from the project list, the pairing screen, or the account screen back to the computer list", () => {
    expect(previousScreen({ kind: "projects", hostId: "host1" })).toEqual({ kind: "hosts" });
    expect(previousScreen({ kind: "pair" })).toEqual({ kind: "hosts" });
    expect(previousScreen({ kind: "account" })).toEqual({ kind: "hosts" });
  });

  it("has nowhere to go from the computer list", () => {
    expect(previousScreen({ kind: "hosts" })).toBeNull();
  });

  it("goes from a direct-chat page back to the Chats root", () => {
    expect(previousScreen({ kind: "chat" })).toEqual({ kind: "chats" });
    expect(previousScreen({ kind: "chatArchive" })).toEqual({ kind: "chats" });
  });

  it("returns D2 to the page it was opened from", () => {
    // From D1's empty state, or a new chat without a key: back is Chats.
    expect(previousScreen({ kind: "modelGateway", from: "chats" })).toEqual({ kind: "chats" });
    // From Settings: back is Settings, which itself returns to its own root.
    expect(previousScreen({ kind: "modelGateway", from: "chats", viaSettings: true })).toEqual({
      kind: "settings",
      from: "chats",
    });
    expect(previousScreen({ kind: "modelGateway", from: "hosts", viaSettings: true })).toEqual({
      kind: "settings",
      from: "hosts",
    });
  });

  it("returns Settings to the root its gear was opened from", () => {
    expect(previousScreen({ kind: "settings", from: "chats" })).toEqual({ kind: "chats" });
    expect(previousScreen({ kind: "settings", from: "hosts" })).toEqual({ kind: "hosts" });
  });

  it("has nowhere to go from either root, so hardware back there exits", () => {
    expect(previousScreen({ kind: "chats" })).toBeNull();
    expect(previousScreen({ kind: "hosts" })).toBeNull();
  });

  it("recognizes exactly the two roots", () => {
    expect(isRootScreen({ kind: "chats" })).toBe(true);
    expect(isRootScreen({ kind: "hosts" })).toBe(true);
    expect(isRootScreen({ kind: "session", hostId: "h1", sessionId: "s1", title: "" })).toBe(false);
    expect(isRootScreen({ kind: "settings", from: "chats" })).toBe(false);
    expect(isRootKind("chats")).toBe(true);
    expect(isRootKind("hosts")).toBe(true);
    expect(isRootKind("session")).toBe(false);
    expect(isRootKind("nope")).toBe(false);
  });
});
