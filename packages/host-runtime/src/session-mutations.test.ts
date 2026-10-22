/**
 * The session mutations both Hosts share (rollout R8 package D).
 *
 * What is pinned down here is the rule, not one Host's wiring: configure and
 * delete refuse a session with an active turn (`AGENT_BUSY`), delete runs the
 * Host's own cleanup only after the row is gone, and a rename is presentation
 * so it is allowed while a turn streams.
 */
import { describe, expect, it } from "vitest";

import type { HostRpc } from "./host-ports.js";
import { configureSession, deleteSession, renameSession, type SessionMutationDeps } from "./session-mutations.js";

type Call = { method: string; params: Record<string, unknown> | undefined };

function fakeHost(): { host: HostRpc; calls: Call[] } {
  const calls: Call[] = [];
  const row = {
    id: "s1",
    title: "old",
    mode: "agent",
    permissionMode: "ask",
    status: "idle",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const host = {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      if (method === "session.get") return { session: { ...row } } as T;
      if (method === "session.configure") {
        Object.assign(row, { ...params, id: "s1" });
        return { ok: true } as T;
      }
      if (method === "session.rename") return { ok: true } as T;
      if (method === "session.delete") return { ok: true } as T;
      if (method === "projects.list") return { projects: [] } as T;
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as HostRpc;
  return { host, calls };
}

function deps(overrides: Partial<SessionMutationDeps> = {}): SessionMutationDeps {
  const { host } = fakeHost();
  return { getHost: () => host, ...overrides };
}

describe("session mutations shared by both Hosts", () => {
  it("configures an idle session and returns it as it now stands", async () => {
    const { host, calls } = fakeHost();
    const updated = await configureSession({ getHost: () => host }, "s1", { permissionMode: "accept-edits" });

    expect(updated.permissionMode).toBe("accept-edits");
    // `mode` is always sent: host-core requires it, and the patch did not name one.
    expect(calls.find((call) => call.method === "session.configure")?.params).toMatchObject({
      id: "s1",
      mode: "agent",
      permissionMode: "accept-edits",
    });
  });

  it("answers AGENT_BUSY instead of reconfiguring a session with an active turn", async () => {
    const { host, calls } = fakeHost();
    await expect(
      configureSession({ getHost: () => host, isBusy: () => true }, "s1", { mode: "plan" }),
    ).rejects.toMatchObject({ code: "AGENT_BUSY" });
    // Nothing reached host-core: a busy session is not touched at all.
    expect(calls.some((call) => call.method === "session.configure")).toBe(false);
  });

  it("renames while a turn is streaming, because a title is presentation", async () => {
    const { host, calls } = fakeHost();
    await renameSession({ getHost: () => host, isBusy: () => true }, "s1", "new title");
    expect(calls.find((call) => call.method === "session.rename")?.params).toMatchObject({
      id: "s1",
      title: "new title",
    });
  });

  it("deletes an idle session and then runs the Host's own cleanup", async () => {
    const disposed: string[] = [];
    const { host, calls } = fakeHost();
    await deleteSession(
      { getHost: () => host, disposeSession: async (id) => void disposed.push(id) },
      "s1",
    );

    expect(calls.filter((call) => call.method === "session.delete")).toHaveLength(1);
    expect(disposed).toEqual(["s1"]);
  });

  it("refuses to delete a busy session, and cleans up nothing", async () => {
    const disposed: string[] = [];
    const { host, calls } = fakeHost();
    await expect(
      deleteSession(
        { getHost: () => host, isBusy: () => true, disposeSession: async (id) => void disposed.push(id) },
        "s1",
      ),
    ).rejects.toMatchObject({ code: "AGENT_BUSY" });

    expect(calls.some((call) => call.method === "session.delete")).toBe(false);
    expect(disposed).toEqual([]);
  });

  it("reports a Host that is not running as retriable unavailability", async () => {
    await expect(configureSession({ getHost: () => null }, "s1", { mode: "agent" })).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
      retriable: true,
    });
  });

  it("keeps a delete successful when the cleanup itself fails", async () => {
    // The row is already gone; a disposer that throws is the Host's to log, not
    // a reason to tell the client the delete failed.
    const d = deps({
      disposeSession: async () => {
        throw new Error("sidecar is gone");
      },
    });
    await expect(deleteSession(d, "s1")).resolves.toBeUndefined();
  });
});
