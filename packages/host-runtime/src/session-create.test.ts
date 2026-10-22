/**
 * Session creation, shared by both Hosts (rollout A2).
 *
 * `session/create` used to exist only in `agent-host-cli`; a desktop Host
 * refused it. These cases pin the contract both Hosts now run: the project is
 * looked up by id and never invented, only the fields `SessionCreateParams`
 * defines are forwarded, and a permission mode is applied in the second call
 * host-core needs.
 */
import { describe, expect, it } from "vitest";

import type { HostRpc } from "./host-ports.js";
import { createHostSession } from "./session-create.js";

type Call = { method: string; params: Record<string, unknown> | undefined };

function fakeHost(options: { projects?: Array<{ id: number; path: string; name: string }>; create?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const projects = options.projects ?? [{ id: 7, path: "/home/user/app", name: "app" }];
  const host = {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      if (method === "projects.list") return { projects } as T;
      if (method === "session.create") {
        const created = options.create ?? { id: "s_new", title: "New task", mode: "agent", projectPath: "/home/user/app" };
        return { session: { mode: "agent", ...created } } as T;
      }
      if (method === "session.configure") return {} as T;
      if (method === "session.get") {
        return {
          session: {
            id: "s_new",
            title: "New task",
            projectPath: "/home/user/app",
            mode: "agent",
            createdAt: "2026-10-19T00:00:00.000Z",
            updatedAt: "2026-10-19T00:00:00.000Z",
          },
        } as T;
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as HostRpc;
  return { host, calls };
}

describe("createHostSession", () => {
  it("creates a session under the project the id names", async () => {
    const { host, calls } = fakeHost();

    const session = await createHostSession(() => host, { projectId: "7", title: "Fix the test" });

    expect(session).toMatchObject({ id: "s_new", projectId: "7" });
    expect(calls.find((call) => call.method === "session.create")?.params).toEqual({
      title: "Fix the test",
      projectPath: "/home/user/app",
    });
  });

  it("sends no field the operation schema does not define", async () => {
    const { host, calls } = fakeHost();

    await createHostSession(() => host, { projectId: "7" });

    // `SessionCreateParams` is closed: mode, provider, model, and thinking level
    // are only forwarded when the caller named them, and the Host fills in its
    // own defaults otherwise.
    expect(calls.find((call) => call.method === "session.create")?.params).toEqual({
      projectPath: "/home/user/app",
    });
  });

  it("forwards the optional fields when they are given", async () => {
    const { host, calls } = fakeHost();

    await createHostSession(() => host, {
      projectId: "7",
      title: "T",
      mode: "plan",
      providerId: "p1",
      modelId: "m1",
      thinkingLevel: "high",
    });

    expect(calls.find((call) => call.method === "session.create")?.params).toEqual({
      title: "T",
      mode: "plan",
      providerId: "p1",
      modelId: "m1",
      thinkingLevel: "high",
      projectPath: "/home/user/app",
    });
  });

  it("applies a permission mode in the Host's own second call", async () => {
    const { host, calls } = fakeHost();

    await createHostSession(() => host, { projectId: "7", permissionMode: "accept-edits" });

    expect(calls.find((call) => call.method === "session.create")?.params).not.toHaveProperty("permissionMode");
    expect(calls.find((call) => call.method === "session.configure")?.params).toEqual({
      id: "s_new",
      mode: "agent",
      permissionMode: "accept-edits",
    });
  });

  it("refuses a project id the Host does not have, instead of creating a loose session", async () => {
    const { host, calls } = fakeHost();

    await expect(createHostSession(() => host, { projectId: "99" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(calls.some((call) => call.method === "session.create")).toBe(false);
  });

  it("creates a session with no project when none was named", async () => {
    const { host, calls } = fakeHost();

    await createHostSession(() => host, { title: "Loose" });

    expect(calls.find((call) => call.method === "session.create")?.params).toEqual({ title: "Loose" });
  });

  it("reports a Host that is not running as retriable rather than as a missing session", async () => {
    await expect(createHostSession(() => null, { projectId: "7" })).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
      retriable: true,
    });
  });
});
