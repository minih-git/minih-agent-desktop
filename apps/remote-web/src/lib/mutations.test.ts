import { RacpError } from "@minih-agent/racp/browser";
import { describe, expect, it } from "vitest";

import {
  attachSession,
  interruptTurn,
  listSessions,
  respondApproval,
  respondInput,
  startTurn,
  stopTurn,
  createSession,
  listProjects,
  newSessionMode,
  type CommandClient,
} from "./mutations.js";

type Call = { method: string; params: Record<string, unknown>; idempotencyKey?: string };
function recordingClient(result: unknown = {}): { client: CommandClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: CommandClient = {
    request: async <T,>(method: string, params: Record<string, unknown> = {}, idempotencyKey?: string) => {
      calls.push({ method, params, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
      return result as T;
    },
  };
  return { client, calls };
}

describe("mutations", () => {
  it("starts a turn with the idempotency key on the command body", async () => {
    const { client, calls } = recordingClient({ accepted: true, turn: { id: "t1" } });
    const result = await startTurn(client, {
      sessionId: "s1",
      text: "hello",
      admission: "queue",
      idempotencyKey: "idem_1",
      requestId: "req_1",
    });

    expect(result).toEqual({ ok: true, value: { accepted: true, turn: { id: "t1" } } });
    expect(calls[0]).toEqual({
      method: "turn/start",
      params: {
        sessionId: "s1",
        admission: "queue",
        input: { text: "hello" },
        context: { requestId: "req_1" },
      },
      idempotencyKey: "idem_1",
    });
  });

  it("carries the approval idempotency key inside the request context only", async () => {
    const { client, calls } = recordingClient({ approvalId: "a1", status: "resolved", alreadyResolved: false, revision: 3 });
    const result = await respondApproval(client, {
      approvalId: "a1",
      decision: "allow-once",
      idempotencyKey: "idem_2",
      requestId: "req_2",
    });

    expect(result.ok).toBe(true);
    expect(calls[0]!.method).toBe("approval/respond");
    // A body-level key is refused by the Gateway for this operation.
    expect(calls[0]!.idempotencyKey).toBeUndefined();
    expect(calls[0]!.params).toEqual({
      approvalId: "a1",
      decision: "allow-once",
      context: { requestId: "req_2", idempotencyKey: "idem_2" },
    });
  });

  it("passes a permission mode with a contract approval", async () => {
    const { client, calls } = recordingClient({});
    await respondApproval(client, {
      approvalId: "a1",
      decision: "approve",
      permissionMode: "accept-edits",
      idempotencyKey: "idem_3",
      requestId: "req_3",
    });
    expect(calls[0]!.params.permissionMode).toBe("accept-edits");
  });

  it("answers an input request with one entry per question", async () => {
    const { client, calls } = recordingClient({ inputId: "i1", status: "resolved" });
    const result = await respondInput(client, {
      inputId: "i1",
      answers: [["Yes"], null],
      idempotencyKey: "idem_4",
      requestId: "req_4",
    });

    expect(result).toEqual({ ok: true, value: { inputId: "i1", status: "resolved" } });
    expect(calls[0]!.idempotencyKey).toBeUndefined();
    expect(calls[0]!.params.answers).toEqual([["Yes"], null]);
    expect(calls[0]!.params.context).toEqual({ requestId: "req_4", idempotencyKey: "idem_4" });
  });

  it("sends stop and interrupt with the turn id only", async () => {
    const { client, calls } = recordingClient({ turn: { id: "t1" } });
    expect(await stopTurn(client, "t1")).toEqual({ ok: true, value: { id: "t1" } });
    expect(await interruptTurn(client, "t1")).toEqual({ ok: true, value: { id: "t1" } });
    expect(calls).toEqual([
      { method: "turn/stop", params: { turnId: "t1" } },
      { method: "turn/interrupt", params: { turnId: "t1" } },
    ]);
  });

  it("unwraps the list and attach results", async () => {
    const list = recordingClient({ sessions: [{ id: "s1" }] });
    expect(await listSessions(list.client)).toEqual({ ok: true, value: [{ id: "s1" }] });


    const attach = recordingClient({ session: { id: "s1" }, role: "controller", replayComplete: true });
    const attached = await attachSession(attach.client, "s1");
    expect(attached.ok && attached.value.role).toBe("controller");
    expect(attach.calls[0]!.params).toEqual({ sessionId: "s1", includeSnapshot: true });
  });

  it("reports a failure as a code and a reason instead of throwing", async () => {
    const failing: CommandClient = {
      request: () => Promise.reject(new RacpError("AGENT_BUSY", "another turn is running")),
    };
    expect(await startTurn(failing, { sessionId: "s1", text: "x", admission: "reject_if_busy", idempotencyKey: "k", requestId: "r" })).toEqual({
      ok: false,
      failure: { code: "AGENT_BUSY", message: "another turn is running", retriable: false },
    });
  });

  it("reads the project catalog", async () => {
    const { client, calls } = recordingClient({ projects: [{ id: "p1", label: "Desktop", archived: false }] });
    expect(await listProjects(client)).toEqual({
      ok: true,
      value: [{ id: "p1", label: "Desktop", archived: false }],
    });
    expect(calls).toEqual([{ method: "project/list", params: {} }]);
  });

  it("creates a session with the project id and nothing the Host did not define", async () => {
    const session = { id: "s_new", title: "New session", projectId: "p1" };
    const { client, calls } = recordingClient({ session });

    expect(await createSession(client, { projectId: "p1" })).toEqual({ ok: true, value: session });
    // `SessionCreateParams` is `{ title?, projectId?, mode?, ... }`; the Host
    // fills in mode, permission mode and model, so sending them would be an
    // invented contract.
    expect(calls).toEqual([{ method: "session/create", params: { projectId: "p1" } }]);
  });

  it("sends a title only when one was given", async () => {
    const titled = recordingClient({ session: { id: "s1" } });
    await createSession(titled.client, { projectId: "p1", title: "  " });
    expect(titled.calls[0]!.params).toEqual({ projectId: "p1" });

    const named = recordingClient({ session: { id: "s1" } });
    await createSession(named.client, { projectId: "p1", title: "Fix the flaky test" });
    expect(named.calls[0]!.params).toEqual({ projectId: "p1", title: "Fix the flaky test" });
  });

  it("reports a refused create as the Host's own code", async () => {
    const forbidden: CommandClient = {
      request: () =>
        Promise.reject(
          new RacpError("FORBIDDEN", "not available to remote devices on the desktop Host"),
        ),
    };
    expect(await createSession(forbidden, { projectId: "p1" })).toEqual({
      ok: false,
      failure: {
        code: "FORBIDDEN",
        message: "not available to remote devices on the desktop Host",
        retriable: false,
      },
    });
  });

  it("treats an answer without a session as a failure instead of an empty success", async () => {
    const { client } = recordingClient({});
    const result = await createSession(client, { projectId: "p1" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.code).toBe("INTERNAL");
  });
});

describe("newSessionMode", () => {
  const project = (id: string, archived = false) => ({ id, label: id, archived });

  it("hides the entry when the Gateway recorded roles without controller", () => {
    expect(newSessionMode(["viewer"], [project("p1")])).toBe("hidden");
    expect(newSessionMode([], [project("p1")])).toBe("hidden");
  });

  it("offers the entry when the roles are unknown or include controller", () => {
    // No roles recorded (an entry from an earlier build): the entry is offered
    // and a FORBIDDEN answer is shown as itself.
    expect(newSessionMode(undefined, null)).toBe("unknown");
    expect(newSessionMode(["viewer", "controller"], null)).toBe("unknown");
  });

  it("goes straight to the only usable project", () => {
    expect(newSessionMode(["controller"], [project("p1"), project("p2", true)])).toBe("direct");
  });

  it("asks which project when there is a real choice", () => {
    expect(newSessionMode(["controller"], [project("p1"), project("p2")])).toBe("choose");
  });

  it("reports that nothing can be created when no usable project is left", () => {
    expect(newSessionMode(["controller"], [])).toBe("unavailable");
    expect(newSessionMode(["controller"], [project("p1", true)])).toBe("unavailable");
  });
});
