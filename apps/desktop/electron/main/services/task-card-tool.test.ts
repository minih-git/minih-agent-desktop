import { describe, expect, it } from "vitest";

import { STEWARD_POLICY_VERSION, createTaskCardTool } from "./task-card-tool";

/**
 * The steward's TaskCard handler (0-c).
 *
 * These assert the behaviour the model experiences through the tool boundary:
 * what a card looks like when proposed, what a confirmation freezes, and which
 * attempts are refused. The shared codec owns shapes and bounds, so this file
 * only covers the action protocol and the fact that a confirmation is the only
 * thing that produces an authorization.
 */
const draft = {
  goal: "Fix the login timeout",
  criteria: [{ text: "A failing repro exists" }],
  boundaries: ["Do not touch billing"],
  permissionMode: "accept-edits" as const,
  mustAsk: ["push"],
};

function tool() {
  let counter = 0;
  return createTaskCardTool({
    hostId: () => "mac-mini",
    policyVersion: () => STEWARD_POLICY_VERSION,
    now: () => new Date("2026-11-10T09:00:00.000Z"),
    newTaskId: () => "task-1",
    newDraftId: () => {
      counter += 1;
      return `draft-${counter}`;
    },
  });
}

const call = (handler: ReturnType<typeof tool>, args: unknown) =>
  handler({
    sessionId: "steward-session",
    turnId: "turn-1",
    toolCallId: "call-1",
    args,
    signal: new AbortController().signal,
  });

describe("propose", () => {
  it("shows the normalized card and says it runs nothing yet", async () => {
    const result = await call(tool(), {
      action: "propose",
      sourceUtterance: "登录超时今天修掉",
      draft,
    });
    expect(result.ok).toBe(true);
    const content = String(result.content);
    expect(content).toContain("card draft-1 (proposed)");
    expect(content).toContain("goal: Fix the login timeout");
    expect(content).toContain("deploy, delete, spend");
    expect(content).toContain("Nothing runs until the person confirms it");
  });

  it("refuses a card with no permission mode or no request behind it", async () => {
    const handler = tool();
    const noMode = await call(handler, {
      action: "propose",
      sourceUtterance: "x",
      draft: { ...draft, permissionMode: undefined },
    });
    expect(noMode.ok).toBe(false);
    expect(noMode.errorCode).toBe("INVALID_TASK_CARD_PERMISSION_MODE");

    const noRequest = await call(handler, { action: "propose", draft });
    expect(noRequest.ok).toBe(false);
    expect(noRequest.errorCode).toBe("INVALID_ARGUMENT");
  });

  it("refuses an unknown action name", async () => {
    const result = await call(tool(), { action: "approve", draft });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("INVALID_ARGUMENT");
  });
});

describe("revise", () => {
  it("changes a proposed card without confirming it", async () => {
    const handler = tool();
    await call(handler, { action: "propose", sourceUtterance: "原话", draft });
    const revised = await call(handler, {
      action: "revise",
      draftId: "draft-1",
      draft: { ...draft, goal: "Fix the login timeout and the retry" },
    });
    expect(revised.ok).toBe(true);
    expect(String(revised.content)).toContain("goal: Fix the login timeout and the retry");
    expect(String(revised.content)).toContain("Still a proposal");
  });

  it("refuses to revise a confirmed card", async () => {
    const handler = tool();
    await call(handler, { action: "propose", sourceUtterance: "原话", draft });
    await call(handler, { action: "confirm", draftId: "draft-1", sourceUtterance: "原话" });
    const revised = await call(handler, {
      action: "revise",
      draftId: "draft-1",
      draft: { ...draft, goal: "something wider" },
    });
    expect(revised.ok).toBe(false);
    expect(revised.errorCode).toBe("CONFLICT");
  });
});

describe("confirm", () => {
  it("freezes the card and names the mandate the delivery should carry", async () => {
    const handler = tool();
    await call(handler, { action: "propose", sourceUtterance: "登录超时今天修掉", draft });
    const confirmed = await call(handler, {
      action: "confirm",
      draftId: "draft-1",
      sourceUtterance: "登录超时今天修掉",
    });
    expect(confirmed.ok).toBe(true);
    const content = String(confirmed.content);
    expect(content).toContain("is confirmed; the authorization is frozen");
    expect(content).toContain("taskId: task-1");
    expect(content).toContain("pass this exact card as `mandate`");
    // The card can only narrow what the receiver grants.
    expect(content).toContain("narrower of this card");
  });

  it("refuses a confirmation without the person's words", async () => {
    const handler = tool();
    await call(handler, { action: "propose", sourceUtterance: "原话", draft });
    const confirmed = await call(handler, { action: "confirm", draftId: "draft-1" });
    expect(confirmed.ok).toBe(false);
    expect(confirmed.errorCode).toBe("INVALID_ARGUMENT");
  });

  it("refuses to confirm twice, so scope cannot be widened silently", async () => {
    const handler = tool();
    await call(handler, { action: "propose", sourceUtterance: "原话", draft });
    await call(handler, { action: "confirm", draftId: "draft-1", sourceUtterance: "原话" });
    const again = await call(handler, {
      action: "confirm",
      draftId: "draft-1",
      sourceUtterance: "顺便把 E2E 也看看",
    });
    expect(again.ok).toBe(false);
    expect(again.errorCode).toBe("CONFLICT");
  });

  it("refuses a card it never proposed", async () => {
    const result = await call(tool(), {
      action: "confirm",
      draftId: "draft-9",
      sourceUtterance: "原话",
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("NOT_FOUND");
  });
});

describe("drop", () => {
  it("forgets a proposal and dispatches nothing", async () => {
    const handler = tool();
    await call(handler, { action: "propose", sourceUtterance: "原话", draft });
    const dropped = await call(handler, { action: "drop", draftId: "draft-1" });
    expect(dropped.ok).toBe(true);
    expect(String(dropped.content)).toContain("Nothing was dispatched");
    const confirmed = await call(handler, {
      action: "confirm",
      draftId: "draft-1",
      sourceUtterance: "原话",
    });
    expect(confirmed.ok).toBe(false);
    expect(confirmed.errorCode).toBe("NOT_FOUND");
  });
});

describe("draft bounds", () => {
  it("keeps only the newest cards when the map is full", async () => {
    const handler = createTaskCardTool({
      hostId: () => "mac-mini",
      maxDrafts: 2,
      newDraftId: (() => {
        let n = 0;
        return () => `d${++n}`;
      })(),
    });
    for (let index = 0; index < 4; index += 1) {
      await call(handler, { action: "propose", sourceUtterance: "原话", draft });
    }
    const oldest = await call(handler, {
      action: "confirm",
      draftId: "d1",
      sourceUtterance: "原话",
    });
    expect(oldest.errorCode).toBe("NOT_FOUND");
    const newest = await call(handler, {
      action: "confirm",
      draftId: "d4",
      sourceUtterance: "原话",
    });
    expect(newest.ok).toBe(true);
  });
});
