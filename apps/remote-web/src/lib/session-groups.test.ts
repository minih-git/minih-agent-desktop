import type { RacpProjectSummary, RacpSession } from "@minih-agent/shared";
import { describe, expect, it } from "vitest";

import { UNGROUPED_KEY, groupSessionsByProject, soleProjectForNewSession } from "./session-groups.js";

function session(id: string, overrides: Partial<RacpSession> = {}): RacpSession {
  return {
    id,
    title: `session ${id}`,
    mode: "agent",
    status: "idle",
    planningState: "inactive",
    permissionMode: "ask",
    queuedTurnIds: [],
    revision: 1,
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

function project(id: string, label: string, archived = false): RacpProjectSummary {
  return { id, label, archived };
}

describe("groupSessionsByProject", () => {
  it("puts each session under its project, and sessions without one under Other", () => {
    const groups = groupSessionsByProject(
      [
        session("s1", { projectId: "p1", updatedAt: "2026-09-18T12:00:00.000Z" }),
        session("s2", { projectId: "p2", updatedAt: "2026-09-18T11:00:00.000Z" }),
        session("s3", { updatedAt: "2026-09-18T10:00:00.000Z" }),
      ],
      [project("p1", "Desktop"), project("p2", "Router")],
    );

    expect(groups.map((group) => [group.key, group.label, group.sessions.map((item) => item.id)])).toEqual([
      ["p1", "Desktop", ["s1"]],
      ["p2", "Router", ["s2"]],
      [UNGROUPED_KEY, null, ["s3"]],
    ]);
  });

  it("keeps a session whose project is gone from the catalog instead of dropping it", () => {
    const groups = groupSessionsByProject(
      [session("s1", { projectId: "p1" }), session("s2", { projectId: "p_deleted" })],
      [project("p1", "Desktop")],
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]!.key).toBe("p1");
    expect(groups[1]!.key).toBe(UNGROUPED_KEY);
    expect(groups[1]!.sessions.map((item) => item.id)).toEqual(["s2"]);
  });

  it("leaves out projects that hold no session", () => {
    const groups = groupSessionsByProject([session("s1", { projectId: "p2" })], [
      project("p1", "Desktop"),
      project("p2", "Router"),
      project("p3", "Empty"),
    ]);

    expect(groups.map((group) => group.key)).toEqual(["p2"]);
  });

  it("returns nothing for an empty session list", () => {
    expect(groupSessionsByProject([], [project("p1", "Desktop")])).toEqual([]);
  });

  it("orders sessions inside a group by most recent activity, then newest, then id", () => {
    const groups = groupSessionsByProject(
      [
        session("older", { projectId: "p1", updatedAt: "2026-09-17T09:00:00.000Z" }),
        session("newer", { projectId: "p1", updatedAt: "2026-09-18T09:00:00.000Z" }),
        // Same `updatedAt`: the newer `createdAt` wins.
        session("recently-created", {
          projectId: "p1",
          updatedAt: "2026-09-17T09:00:00.000Z",
          createdAt: "2026-09-16T09:00:00.000Z",
        }),
        session("same-b", {
          projectId: "p1",
          updatedAt: "2026-09-16T09:00:00.000Z",
          createdAt: "2026-09-15T09:00:00.000Z",
        }),
        session("same-a", {
          projectId: "p1",
          updatedAt: "2026-09-16T09:00:00.000Z",
          createdAt: "2026-09-15T09:00:00.000Z",
        }),
      ],
      [project("p1", "Desktop")],
    );

    expect(groups[0]!.sessions.map((item) => item.id)).toEqual([
      "newer",
      "older",
      "recently-created",
      "same-a",
      "same-b",
    ]);
  });

  it("orders groups by their most recent session, and Other last", () => {
    const groups = groupSessionsByProject(
      [
        session("a1", { projectId: "p1", updatedAt: "2026-09-16T09:00:00.000Z" }),
        session("b1", { projectId: "p2", updatedAt: "2026-09-19T09:00:00.000Z" }),
        session("c1", { projectId: "p3", updatedAt: "2026-09-18T09:00:00.000Z" }),
        // The most recent session of all still trails the projects: "Other"
        // has no heading of its own to sort, so it stays at the bottom.
        session("o1", { updatedAt: "2026-09-20T09:00:00.000Z" }),
      ],
      [project("p1", "Alpha"), project("p2", "Beta"), project("p3", "Gamma")],
    );

    expect(groups.map((group) => group.key)).toEqual(["p2", "p3", "p1", UNGROUPED_KEY]);
  });

  it("breaks a tie between groups by label so the order is stable", () => {
    const at = "2026-09-18T09:00:00.000Z";
    const groups = groupSessionsByProject(
      [session("s1", { projectId: "p1", updatedAt: at }), session("s2", { projectId: "p2", updatedAt: at })],
      [project("p1", "Zulu"), project("p2", "Alpha")],
    );

    expect(groups.map((group) => group.label)).toEqual(["Alpha", "Zulu"]);
  });

  it("still groups sessions of an archived project, under its name", () => {
    // The catalog is the authority on names; archiving hides the project from
    // the new-session choice, not its history.
    const groups = groupSessionsByProject(
      [session("s1", { projectId: "p1" }), session("s2", { projectId: "p2" })],
      [project("p1", "Old", true), project("p2", "Current")],
    );

    expect(groups.map((group) => group.label).sort()).toEqual(["Current", "Old"]);
  });
});

describe("soleProjectForNewSession", () => {
  it("returns the only project that may hold a new session", () => {
    expect(soleProjectForNewSession([project("p1", "Desktop")])).toEqual(project("p1", "Desktop"));
  });

  it("ignores archived projects when counting", () => {
    expect(soleProjectForNewSession([project("p1", "Desktop"), project("p2", "Old", true)])).toEqual(
      project("p1", "Desktop"),
    );
  });

  it("returns null when the choice is real, including no usable project at all", () => {
    expect(soleProjectForNewSession([project("p1", "Desktop"), project("p2", "Router")])).toBeNull();
    expect(soleProjectForNewSession([project("p1", "Old", true)])).toBeNull();
    expect(soleProjectForNewSession([])).toBeNull();
  });
});
