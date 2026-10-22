import type { RacpProjectSummary, RacpSession } from "@minih-agent/shared";
import { describe, expect, it } from "vitest";

import { UNGROUPED_KEY, projectSessions, soleProjectForNewSession, summarizeProjects } from "./session-groups.js";
import { sessionStateOf, type SessionStateView } from "./session-state.js";

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

/** The screen's own verdict, faked so this file tests ordering and counting only. */
const stateOf = (view: SessionStateView) => () => view;
const plain = () => sessionStateOf;

describe("summarizeProjects", () => {
  it("counts sessions, attention, and running per project, and keeps the newest activity", () => {
    const [card] = summarizeProjects(
      [
        session("s1", { projectId: "p1", status: "waiting_permission", updatedAt: "2026-09-18T12:00:00.000Z" }),
        session("s2", { projectId: "p1", status: "running", updatedAt: "2026-09-18T11:00:00.000Z" }),
        session("s3", { projectId: "p1", updatedAt: "2026-09-18T09:00:00.000Z" }),
      ],
      [project("p1", "Desktop")],
      plain(),
    );

    expect(card).toMatchObject({ key: "p1", label: "Desktop", total: 3, waiting: 1, running: 1 });
    expect(card!.lastActivity).toBe("2026-09-18T12:00:00.000Z");
  });

  it("orders waiting before running before quiet before empty", () => {
    const cards = summarizeProjects(
      [
        session("q", { projectId: "quiet", updatedAt: "2026-09-18T12:00:00.000Z" }),
        session("r", { projectId: "running", status: "running" }),
        session("w", { projectId: "waiting", status: "waiting_permission" }),
      ],
      [project("quiet", "Quiet"), project("running", "Running"), project("waiting", "Waiting"), project("empty", "Empty")],
      plain(),
    );

    expect(cards.map((card) => card.key)).toEqual(["waiting", "running", "quiet", "empty"]);
  });

  it("shows a project that holds no session, last, because it can be started in", () => {
    const cards = summarizeProjects([session("s1", { projectId: "p1" })], [project("p1", "Desktop"), project("p2", "Empty")], plain());

    expect(cards.map((card) => [card.key, card.total])).toEqual([
      ["p1", 1],
      ["p2", 0],
    ]);
    expect(cards[1]!.lastActivity).toBeUndefined();
  });

  it("keeps a session whose project left the catalog in one trailing Other card", () => {
    const cards = summarizeProjects(
      [session("s1", { projectId: "p1" }), session("s2", { projectId: "p_deleted" }), session("s3")],
      [project("p1", "Desktop")],
      plain(),
    );

    expect(cards.map((card) => card.key)).toEqual(["p1", UNGROUPED_KEY]);
    expect(cards[1]).toMatchObject({ label: null, other: true, total: 2 });
  });

  it("pins Other last even when its sessions need the user", () => {
    const cards = summarizeProjects(
      [
        session("s1", { projectId: "p1" }),
        session("s2", { projectId: "gone", status: "waiting_permission" }),
      ],
      [project("p1", "Desktop")],
      plain(),
    );

    expect(cards.map((card) => card.key)).toEqual(["p1", UNGROUPED_KEY]);
    expect(cards[1]!.waiting).toBe(1);
  });

  it("hides an archived project and parks its sessions in Other", () => {
    const cards = summarizeProjects(
      [session("s1", { projectId: "old" }), session("s2", { projectId: "live" })],
      [project("old", "Archived", true), project("live", "Live")],
      plain(),
    );

    expect(cards.map((card) => card.key)).toEqual(["live", UNGROUPED_KEY]);
  });

  it("counts an answer the device learned from a push as waiting", () => {
    const cards = summarizeProjects(
      [session("s1", { projectId: "p1", status: "running" })],
      [project("p1", "Desktop")],
      stateOf("input"),
    );

    expect(cards[0]).toMatchObject({ waiting: 1, running: 0 });
  });

  it("breaks a tie by label, so two refreshes order the same way", () => {
    const build = () =>
      summarizeProjects(
        [session("s1", { projectId: "a" }), session("s2", { projectId: "b" })],
        [project("b", "Beta"), project("a", "Alpha")],
        plain(),
      ).map((card) => card.key);

    expect(build()).toEqual(["a", "b"]);
    expect(build()).toEqual(build());
  });
});

describe("projectSessions", () => {
  it("returns one project's sessions, newest first, and nothing else", () => {
    const rows = projectSessions(
      [
        session("old", { projectId: "p1", updatedAt: "2026-09-18T09:00:00.000Z" }),
        session("new", { projectId: "p1", updatedAt: "2026-09-18T12:00:00.000Z" }),
        session("other", { projectId: "p2" }),
      ],
      "p1",
    );

    expect(rows.map((row) => row.id)).toEqual(["new", "old"]);
  });
});

describe("soleProjectForNewSession", () => {
  it("answers the one usable project, and stays silent when the choice is real", () => {
    expect(soleProjectForNewSession([project("a", "A"), project("b", "B", true)])?.id).toBe("a");
    expect(soleProjectForNewSession([project("a", "A"), project("b", "B")])).toBeNull();
    expect(soleProjectForNewSession([])).toBeNull();
  });
});
