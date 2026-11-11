import { describe, expect, it, vi } from "vitest";

import { createTaskCardTool } from "./task-card-tool";

/**
 * The steward's TaskCard tool (ADR bot-sessions-and-steward §3).
 *
 * The point of these tests is the capability the tool does **not** have: the
 * model may propose, revise and drop, and it may not confirm. Removing the action
 * is what makes "the steward cannot approve its own work" true, so it is asserted
 * first and separately from the argument plumbing.
 */

const card = {
  goal: "Fix the login timeout",
  criteria: [{ text: "A failing repro exists" }],
  boundaries: ["Do not touch billing"],
  permissionMode: "accept-edits" as const,
  mustAsk: ["push"],
};

/**
 * A service stub that records one call. Typed as the real parameter so the
 * assertions below can read the argument instead of casting it.
 */
type ToolService = Parameters<typeof createTaskCardTool>[0];
type InvokeInput = { operation: string; args: Record<string, unknown> };

function service(result: unknown = { draft: { id: "d1", status: "proposed" } }) {
  const calls: InvokeInput[] = [];
  const invokeBuiltin = vi.fn(async (input: InvokeInput) => {
    calls.push(input);
    return result;
  });
  return {
    service: { invokeBuiltin } as unknown as ToolService,
    invokeBuiltin,
    calls,
  };
}

const call = (
  handler: ReturnType<typeof createTaskCardTool>,
  args: unknown,
  turn: { sessionId?: string; turnId?: string } = {},
) =>
  handler({
    sessionId: turn.sessionId ?? "steward-session",
    turnId: turn.turnId ?? "turn-1",
    toolCallId: "call-1",
    args,
    signal: new AbortController().signal,
  });

const draftRecord = (overrides: Record<string, unknown> = {}) => ({
  id: "d1",
  sessionId: "steward-session",
  status: "proposed",
  card: { ...card, criteria: [{ id: "c1", text: "A failing repro exists" }], boundaries: [], risk: "medium" },
  cardHash: "a".repeat(64),
  sourceUtterance: "登录超时今天修掉",
  targetSessionId: "worker-session",
  createdAt: "2026-11-10T09:00:00.000Z",
  updatedAt: "2026-11-10T09:00:00.000Z",
  ...overrides,
});

describe("the model cannot confirm a card", () => {
  it("refuses `confirm` without reaching the host", async () => {
    const { service: stub, invokeBuiltin } = service();
    const result = await call(createTaskCardTool(stub), {
      action: "confirm",
      draftId: "d1",
      sourceUtterance: "yes go ahead",
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("PERMISSION_DENIED");
    expect(String(result.content)).toContain("person's decision");
    expect(invokeBuiltin).not.toHaveBeenCalled();
  });

  it("accepts only propose, revise and drop", async () => {
    const { service: stub, invokeBuiltin } = service();
    const result = await call(createTaskCardTool(stub), { action: "approve" });
    expect(result.errorCode).toBe("INVALID_ARGUMENT");
    expect(invokeBuiltin).not.toHaveBeenCalled();
  });
});

describe("propose", () => {
  it("sends the normalized card with its target and the person's words", async () => {
    const { service: stub, calls } = service({ draft: draftRecord() });
    const result = await call(createTaskCardTool(stub), {
      action: "propose",
      targetSessionId: "worker-session",
      sourceUtterance: "登录超时今天修掉",

      draft: card,
    });
    expect(result.ok).toBe(true);
    expect(String(result.content)).toContain("card d1 (proposed)");
    expect(String(result.content)).toContain("deploy, delete, spend");
    expect(String(result.content)).toContain("Nothing runs until the person confirms it");
    const sent = calls[0];
    expect(sent.operation).toBe("propose");
    expect(sent.args.targetSessionId).toBe("worker-session");
    expect(sent.args.sourceUtterance).toBe("登录超时今天修掉");
    expect(sent.args.card).toMatchObject({ permissionMode: "accept-edits" });
  });

  it("reports a policy dispatch instead of asking for a click", async () => {
    const { service: stub } = service({ draft: draftRecord({ status: "confirmed" }) });
    const result = await call(createTaskCardTool(stub), {
      action: "propose",
      targetSessionId: "worker-session",
      sourceUtterance: "原话",
      draft: card,
    });
    expect(String(result.content)).toContain("dispatched automatically (policy)");
  });

  it("refuses a card with no permission mode or no request behind it", async () => {
    const { service: stub, invokeBuiltin } = service();
    const noMode = await call(createTaskCardTool(stub), {
      action: "propose",
      targetSessionId: "worker-session",
      sourceUtterance: "x",
      draft: { ...card, permissionMode: undefined },
    });
    expect(noMode.errorCode).toBe("INVALID_TASK_CARD_PERMISSION_MODE");

    const noRequest = await call(createTaskCardTool(stub), {
      action: "propose",
      targetSessionId: "worker-session",
      draft: card,
    });
    expect(noRequest.errorCode).toBe("INVALID_ARGUMENT");
    expect(invokeBuiltin).not.toHaveBeenCalled();
  });
});

describe("revise and drop", () => {
  it("revises only by draft id", async () => {
    const { service: stub, calls } = service({ draft: draftRecord() });
    const result = await call(createTaskCardTool(stub), {
      action: "revise",
      draftId: "d1",
      sourceUtterance: "原话",
      draft: card,
    });
    expect(result.ok).toBe(true);
    const sent = calls[0];
    expect(sent.operation).toBe("revise");
    expect(sent.args.draftId).toBe("d1");
  });

  it("drops by draft id and says nothing was dispatched", async () => {
    const { service: stub } = service({ draft: draftRecord({ status: "dropped" }) });
    const result = await call(createTaskCardTool(stub), { action: "drop", draftId: "d1" });
    expect(result.ok).toBe(true);
    expect(String(result.content)).toContain("Nothing was dispatched");
  });

  it("refuses drop without a draft id", async () => {
    const { service: stub } = service();
    const result = await call(createTaskCardTool(stub), { action: "drop" });
    expect(result.errorCode).toBe("INVALID_ARGUMENT");
  });
});

describe("host refusals reach the model verbatim", () => {
  it("surfaces a conflict as an error, not a silent success", async () => {
    const stub = {
      invokeBuiltin: vi.fn(async () => {
        throw Object.assign(new Error("CONFLICT: only a proposed card can be revised"), {
          errorCode: "CONFLICT",
        });
      }),
    } as unknown as Parameters<typeof createTaskCardTool>[0];
    const result = await call(createTaskCardTool(stub), {
      action: "revise",
      draftId: "d1",
      sourceUtterance: "原话",
      draft: card,
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("CONFLICT");
  });
});

describe("a card the model creates is announced to the app", () => {
  it("reports the new draft after propose, with its session", async () => {
    const { service: stub } = service({ draft: draftRecord(), created: true });
    const changed: Array<{ sessionId: string; draftId: string }> = [];
    const handler = createTaskCardTool(stub, (change) => changed.push(change));

    const result = await call(handler, {
      action: "propose",
      targetSessionId: "worker-session",
      sourceUtterance: "帮我查查 router 进度",
      draft: card,
    });

    expect(result.ok).toBe(true);
    // Without this the dock keeps the list it fetched on mount, so a card
    // proposed afterwards stays invisible until the person switches sessions.
    expect(changed).toEqual([{ sessionId: "steward-session", draftId: "d1" }]);
  });

  it("reports a dropped card too", async () => {
    const { service: stub } = service({ draft: draftRecord({ status: "dropped" }) });
    const changed: Array<{ sessionId: string; draftId: string }> = [];
    const handler = createTaskCardTool(stub, (change) => changed.push(change));

    await call(handler, { action: "drop", draftId: "d1" });

    expect(changed).toEqual([{ sessionId: "steward-session", draftId: "d1" }]);
  });
});
