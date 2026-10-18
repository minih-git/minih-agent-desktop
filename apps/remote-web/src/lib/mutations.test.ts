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
});
