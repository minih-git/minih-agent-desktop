import { describe, expect, it } from "vitest";

import {
  listProjectSummaries,
  listSessionSummariesWithProjectIds,
  toRacpHostError,
  withSessionProjectIds,
} from "./host-catalog-reads.js";

type Call = { method: string; params: Record<string, unknown> | undefined };

function fakeHost(options: {
  sessions: Array<{ id: string; title?: string; projectPath?: string }>;
  projects: Array<{ id: number; path: string; name: string }>;
  failSessionList?: unknown;
  failProjectList?: unknown;
}) {
  const calls: Call[] = [];
  return {
    calls,
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      if (method === "session.list") {
        if (options.failSessionList) throw options.failSessionList;
        return { sessions: options.sessions } as T;
      }
      if (method === "projects.list") {
        if (options.failProjectList) throw options.failProjectList;
        return { projects: options.projects } as T;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

describe("host catalog reads", () => {
  it("attaches the project id to sessions and leaves an unknown path undecorated", async () => {
    const host = fakeHost({
      sessions: [
        { id: "s1", title: "One", projectPath: "/work/app" },
        { id: "s2", title: "Two", projectPath: "/work/gone" },
        { id: "s3", title: "Three" },
      ],
      projects: [{ id: 7, path: "/work/app", name: "app" }],
    });
    const summaries = await listSessionSummariesWithProjectIds(host);
    expect(summaries.map((summary) => [summary.id, summary.projectId])).toEqual([
      ["s1", "7"],
      ["s2", undefined],
      ["s3", undefined],
    ]);
    expect(summaries[0]).toMatchObject({ title: "One", workspaceLabel: "app" });
    expect(host.calls.map((call) => call.method)).toEqual(["session.list", "projects.list"]);
  });

  it("skips the projects lookup when no session carries a project path", async () => {
    const host = fakeHost({ sessions: [{ id: "s1", title: "One" }], projects: [] });
    const summaries = await listSessionSummariesWithProjectIds(host);
    expect(summaries).toHaveLength(1);
    expect(host.calls.map((call) => call.method)).toEqual(["session.list"]);
  });

  it("decorates an explicit record set the same way the list read does", async () => {
    const host = fakeHost({
      sessions: [],
      projects: [{ id: 3, path: "/work/api", name: "" }],
    });
    const summaries = await withSessionProjectIds(host, [{ id: "s9", projectPath: "/work/api" }]);
    expect(summaries[0]).toMatchObject({ id: "s9", projectId: "3", workspaceLabel: "api" });
  });

  it("projects the project catalog with a basename label fallback", async () => {
    const host = fakeHost({
      sessions: [],
      projects: [
        { id: 1, path: "/work/app", name: "app" },
        { id: 2, path: "/work/label-me", name: "" },
      ],
    });
    const projects = await listProjectSummaries(host);
    expect(projects).toEqual([
      { id: "1", label: "app", archived: false },
      { id: "2", label: "label-me", archived: false },
    ]);
  });

  it("maps host-core error codes onto the RACP error contract", async () => {
    const mapping: Array<[unknown, string]> = [
      [{ errorCode: "NOT_FOUND" }, "NOT_FOUND"],
      [{ errorCode: "SESSION_NOT_FOUND" }, "NOT_FOUND"],
      [{ errorCode: "CONFLICT" }, "CONFLICT"],
      [{ errorCode: "PLAN_STALE" }, "CONFLICT"],
      [{ errorCode: "INVALID_PARAMS" }, "INVALID_ARGUMENT"],
      [{ errorCode: "HOST_UNAVAILABLE" }, "AGENT_UNAVAILABLE"],
      [new Error("boom"), "INTERNAL"],
    ];
    for (const [error, code] of mapping) {
      expect(() => toRacpHostError(error)).toThrowError(expect.objectContaining({ code }));
    }
    // host-core sometimes nests the code under `data`.
    expect(() => toRacpHostError({ data: { errorCode: "NOT_FOUND" } })).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("surfaces a failing read instead of returning an empty catalog", async () => {
    const host = fakeHost({
      sessions: [],
      projects: [],
      failSessionList: Object.assign(new Error("host is closed"), { errorCode: "HOST_UNAVAILABLE" }),
    });
    await expect(listSessionSummariesWithProjectIds(host)).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
      retriable: true,
    });
  });
});
