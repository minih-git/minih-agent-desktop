import { describe, expect, it } from "vitest";

import { previousScreen } from "./screen-stack.js";

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
});
