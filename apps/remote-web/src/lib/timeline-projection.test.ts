/**
 * One projection for history and live rows (rollout D).
 *
 * The phone used to show two different things for the same tool call: a history
 * row was projected by reading only `role`/`content`/`thinking` (so a call the
 * Host recorded as a `role: "tool"` message lost its name, its status, and both
 * of its payloads), while the live `tool_start`/`tool_end` path kept the name.
 * These cases pin the unified shape and the desktop's visibility rules.
 */
import { describe, expect, it } from "vitest";

import type { RacpEventEnvelope, RacpItemSummary, UiMessage } from "@minih-agent/shared";

import { itemFromSummary, projectMessage } from "./timeline-items.js";
import { createInitialTimelineState, timelineReducer } from "./timeline.js";

function message(overrides: Partial<UiMessage> & Pick<UiMessage, "role">): UiMessage {
  return {
    id: "m1",
    content: "",
    createdAt: "2026-10-20T00:00:00.000Z",
    ...overrides,
  } as UiMessage;
}

function summary(content: unknown, overrides: Partial<RacpItemSummary> = {}): RacpItemSummary {
  return {
    id: "item_1",
    turnId: "turn_1",
    itemType: "message",
    status: "completed",
    content,
    ...overrides,
  } as RacpItemSummary;
}

function envelope(overrides: Partial<RacpEventEnvelope>): RacpEventEnvelope {
  return {
    eventId: "evt_1",
    kind: "item.started",
    epoch: "e1",
    sequence: 1,
    payload: {},
    ...overrides,
  } as RacpEventEnvelope;
}

describe("projectMessage", () => {
  it("projects a recorded tool call with its name, status, arguments and result", () => {
    const item = projectMessage(
      message({
        id: "tool_1",
        role: "tool",
        toolName: "Bash",
        toolCallId: "call_1",
        toolStatus: "success",
        toolArgs: { command: "npm run build" },
        toolResult: { output: "built" },
      }),
    );

    expect(item).toMatchObject({
      id: "tool_1",
      itemType: "tool",
      status: "completed",
      toolName: "Bash",
      toolStatus: "success",
    });
    // The structured payloads survive for the card renderer, and the text is a
    // preview of the result rather than the whole record.
    expect(item?.toolArgs).toEqual({ command: "npm run build" });
    expect(item?.toolResult).toEqual({ output: "built" });
    expect(item?.text).toContain("built");
  });

  it("shows the arguments while a recorded call is still running", () => {
    const item = projectMessage(
      message({ role: "tool", toolName: "Read", toolStatus: "running", toolArgs: { path: "a.ts" } }),
    );

    expect(item).toMatchObject({ status: "streaming", toolStatus: "running", toolName: "Read" });
    expect(item?.text).toContain("a.ts");
  });

  it("marks a failed or denied call as an error", () => {
    for (const toolStatus of ["error", "denied"] as const) {
      const item = projectMessage(message({ role: "tool", toolName: "Bash", toolStatus, toolResult: "nope" }));
      expect(item?.isError).toBe(true);
      expect(item?.toolStatus).toBe(toolStatus);
    }
  });

  it("hides internal model instructions and empty assistant rows", () => {
    expect(projectMessage(message({ role: "system", modelSystem: { version: 1, messageJson: "{}" } }))).toBeUndefined();
    expect(projectMessage(message({ role: "assistant", content: "   " }))).toBeUndefined();
  });

  it("keeps an assistant row that failed, or that only searched", () => {
    const failed = projectMessage(message({ role: "assistant", error: { code: "X", message: "boom" } as never }));
    expect(failed?.isError).toBe(true);
    const searched = projectMessage(message({ role: "assistant", hostedSearch: { rounds: [] } as never }));
    expect(searched).toBeDefined();
  });

  it("reads a user row as the command it was sent with, and keeps its attachments", () => {
    const item = projectMessage(
      message({
        role: "user",
        content: "expanded prompt",
        command: "/review 123",
        attachments: [{ kind: "file", name: "a.ts" } as never, { kind: "image", name: "b.png" } as never],
      }),
    );

    expect(item?.text).toBe("/review 123");
    expect(item?.command).toBe("/review 123");
    expect(item?.attachments).toEqual([
      { name: "a.ts", kind: "file" },
      { name: "b.png", kind: "image" },
    ]);
  });

  it("keeps a fetchable image's media id and leaves an unfetchable one bare", () => {
    // A Host that serves media says so on the attachment; a row without the id
    // has no thumbnail, and the row must be able to tell the two apart.
    const item = projectMessage(
      message({
        role: "user",
        content: "look",
        attachments: [
          { kind: "image", name: "IMG_3516.jpeg", mediaId: "media_bTEvaWR4LTA" } as never,
          { kind: "image", name: "IMG_3517.jpeg" } as never,
        ],
      }),
    );

    expect(item?.attachments).toEqual([
      { name: "IMG_3516.jpeg", kind: "image", mediaId: "media_bTEvaWR4LTA" },
      { name: "IMG_3517.jpeg", kind: "image" },
    ]);
    expect(item?.mediaIds).toEqual(["media_bTEvaWR4LTA"]);
  });

  it("marks a side note", () => {
    expect(projectMessage(message({ role: "user", content: "hi", sideNote: true }))?.sideNote).toBe(true);
  });
});

describe("history rows and live events agree", () => {
  it("gives a recorded tool call the same shape as a live one", () => {
    // History: the Host stored the finished call as a `role: "tool"` message.
    const fromHistory = itemFromSummary(
      summary(
        message({
          id: "tool_1",
          role: "tool",
          toolName: "Bash",
          toolStatus: "success",
          toolArgs: { command: "ls" },
          toolResult: "file.txt",
        }),
        { id: "tool_1", turnId: "turn_1" },
      ),
    );

    // Live: the same call arrived as `tool_start` then `tool_end`, after the
    // snapshot was applied (the stream opens at the snapshot's cursor).
    let state = timelineReducer(createInitialTimelineState(), {
      type: "attach",
      session: {
        id: "s1",
        title: "t",
        mode: "agent",
        status: "running",
        planningState: "inactive",
        permissionMode: "ask",
        queuedTurnIds: [],
        revision: 1,
        createdAt: "",
        updatedAt: "",
      },
      snapshot: {
        session: {
          id: "s1",
          title: "t",
          mode: "agent",
          status: "running",
          planningState: "inactive",
          permissionMode: "ask",
          queuedTurnIds: [],
          revision: 1,
          createdAt: "",
          updatedAt: "",
        },
        items: [],
        activeItems: [],
        queuedTurns: [],
        pendingApprovals: [],
        pendingInputs: [],
        hasMoreHistory: false,
        cursor: { epoch: "e1", sequence: 0 },
        revision: 1,
        generatedAt: "",
      },
    } as never);
    state = timelineReducer(state, {
      type: "event",
      envelope: envelope({
        kind: "item.started",
        sequence: 1,
        payload: {
          itemId: "tool_1",
          itemType: "tool",
          event: { type: "tool_start", toolName: "Bash", args: { command: "ls" } },
        },
      }),
    });
    state = timelineReducer(state, {
      type: "event",
      envelope: envelope({
        eventId: "evt_2",
        kind: "item.completed",
        sequence: 2,
        turnId: "turn_1",
        payload: {
          itemId: "tool_1",
          itemType: "tool",
          event: { type: "tool_end", toolName: "Bash", result: "file.txt", isError: false },
        },
      }),
    });
    const fromLive = state.items.find((item) => item.id === "tool_1");

    expect(fromLive).toBeDefined();
    // Same fields, same meaning: this is what "one projection" buys.
    for (const key of ["itemType", "status", "toolName", "toolStatus", "isError"] as const) {
      expect(fromLive?.[key]).toEqual(fromHistory?.[key]);
    }
    expect(fromLive?.toolArgs).toEqual(fromHistory?.toolArgs);
    expect(fromLive?.text).toEqual(fromHistory?.text);
  });

  it("drops a hidden row from a snapshot and from the live stream", () => {
    const internal = message({ id: "sys_1", role: "system", modelSystem: { version: 1, messageJson: "{}" } });
    const attach = timelineReducer(createInitialTimelineState(), {
      type: "attach",
      session: { id: "s1", title: "t", mode: "agent", status: "idle", planningState: "inactive", permissionMode: "ask", queuedTurnIds: [], revision: 1, createdAt: "", updatedAt: "" },
      snapshot: {
        session: { id: "s1", title: "t", mode: "agent", status: "idle", planningState: "inactive", permissionMode: "ask", queuedTurnIds: [], revision: 1, createdAt: "", updatedAt: "" },
        items: [summary(internal, { id: "sys_1" }), summary(message({ id: "u1", role: "user", content: "hello" }), { id: "u1" })],
        activeItems: [],
        queuedTurns: [],
        pendingApprovals: [],
        pendingInputs: [],
        hasMoreHistory: false,
        cursor: { epoch: "e1", sequence: 1 },
        revision: 1,
        generatedAt: "2026-10-20T00:00:00.000Z",
      },
    } as never);

    expect(attach.items.map((item) => item.id)).toEqual(["u1"]);

    // The live path drops it as well (the state is attached, so the guard is
    // the visibility rule rather than the pre-snapshot rule).
    const attachedState = timelineReducer(createInitialTimelineState(), {
      type: "attach",
      session: {
        id: "s1",
        title: "t",
        mode: "agent",
        status: "idle",
        planningState: "inactive",
        permissionMode: "ask",
        queuedTurnIds: [],
        revision: 1,
        createdAt: "",
        updatedAt: "",
      },
      snapshot: {
        session: {
          id: "s1",
          title: "t",
          mode: "agent",
          status: "idle",
          planningState: "inactive",
          permissionMode: "ask",
          queuedTurnIds: [],
          revision: 1,
          createdAt: "",
          updatedAt: "",
        },
        items: [],
        activeItems: [],
        queuedTurns: [],
        pendingApprovals: [],
        pendingInputs: [],
        hasMoreHistory: false,
        cursor: { epoch: "e1", sequence: 0 },
        revision: 1,
        generatedAt: "",
      },
    } as never);
    const live = timelineReducer(attachedState, {
      type: "event",
      envelope: envelope({
        payload: {
          itemId: "sys_1",
          itemType: "message",
          event: { type: "message_start", message: internal },
        },
      }),
    });
    expect(live.items).toEqual([]);
  });
});
