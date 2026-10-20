import { describe, expect, it } from "vitest";

import { createHostQueueStore, createHostSessionPort, fromHostQueueEntry, toSessionSummary } from "./host-ports.js";

describe("host ports", () => {
  it("maps a host session record to the Agent Host summary without leaking the absolute path", () => {
    const summary = toSessionSummary({
      id: "s1",
      title: "Fix build",
      projectId: "proj",
      projectPath: "/home/user/work/pi",
      mode: "plan",
      permissionMode: "accept-edits",
      planningState: "awaiting_approval",
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    expect(summary).toEqual({
      id: "s1",
      title: "Fix build",
      projectId: "proj",
      workspaceIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u),
      workspaceLabel: "pi",
      mode: "plan",
      permissionMode: "accept-edits",
      planningState: "awaiting_approval",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    expect(JSON.stringify(summary)).not.toContain("/home/user/work/pi");
    expect(toSessionSummary({ id: "x", mode: "weird", permissionMode: "yolo", planningState: "?" })).toMatchObject({
      mode: "agent",
      permissionMode: "ask",
      planningState: "inactive",
    });
  });

  /**
   * The contract a paging client must follow, pinned over a conversation long
   * enough to need several pages: a page is ordered oldest to newest (protocol
   * §7.6) and `beforeItemId` is the page's *oldest* row, so each request walks
   * back exactly `limit` rows. A client that assumes the opposite order reads
   * the same page repeatedly and inserts it backwards.
   */
  it("walks a long transcript back one full page at a time", async () => {
    const messages = Array.from({ length: 260 }, (_, index) => ({
      id: `m${String(index).padStart(3, "0")}`,
      role: "assistant" as const,
      content: `row ${index}`,
      createdAt: "2026-09-18T00:00:00.000Z",
      status: "complete" as const,
    }));
    const port = createHostSessionPort(() => ({
      async call<T>() {
        return { session: { id: "s1", messages } } as T;
      },
    }));

    const collected: string[] = [];
    let beforeItemId: string | undefined;
    const sizes: number[] = [];
    for (;;) {
      const page = await port.history("s1", { limit: 100, ...(beforeItemId ? { beforeItemId } : {}) });
      sizes.push(page.items.length);
      collected.unshift(...page.items.map((item) => item.id));
      if (!page.hasMore) break;
      beforeItemId = page.items[0]?.id;
      expect(beforeItemId).toBeDefined();
    }

    expect(sizes).toEqual([100, 100, 60]);
    expect(collected).toEqual(messages.map((message) => message.id));
    expect(new Set(collected).size).toBe(collected.length);
  });

  it("pages history backwards from an item id", async () => {
    const messages = ["m1", "m2", "m3", "m4"].map((id) => ({
      id,
      role: "assistant" as const,
      content: id,
      createdAt: "2026-09-18T00:00:00.000Z",
      status: "complete" as const,
    }));
    const port = createHostSessionPort(() => ({
      async call<T>() {
        return { session: { id: "s1", messages } } as T;
      },
    }));
    const page = await port.history("s1", { limit: 2, beforeItemId: "m4" });
    expect(page.items.map((item) => item.id)).toEqual(["m2", "m3"]);
    expect(page.hasMore).toBe(true);
    const tail = await port.history("s1", { limit: 10 });
    expect(tail.items.map((item) => item.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(tail.hasMore).toBe(false);
    expect(await createHostSessionPort(() => null).get("s1")).toBeNull();
  });

  it("round-trips queue records through the host-core RPC shape", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const store = createHostQueueStore(() => ({
      async call<T>(method: string, params: Record<string, unknown> = {}) {
        calls.push({ method, params });
        if (method === "session.queueList") {
          return {
            entries: [
              {
                id: "q1",
                sessionId: "s1",
                principal: "phone",
                inputHash: "h",
                content: "later",
                permissionMode: "auto",
                position: 1,
                priority: 2,
                createdAt: "2026-09-18T00:00:00.000Z",
              },
            ],
          } as T;
        }
        if (method === "session.queueRemove") return { removed: true } as T;
        if (method === "session.queueReorder") return { moved: false } as T;
        return {} as T;
      },
    }));
    const [record] = await store.listAll();
    expect(record).toMatchObject({ id: "q1", principalSubject: "phone", effectivePermissionMode: "auto", priority: 2 });
    expect(record?.createdAt).toBe(Date.parse("2026-09-18T00:00:00.000Z"));
    await store.push({ ...record!, attachments: [{ path: "/x", name: "x", kind: "file" }] });
    expect(calls.at(-1)?.params).toMatchObject({ id: "q1", principal: "phone", permissionMode: "auto" });
    expect(await store.remove("q1")).toBe(true);
    expect(await store.reorder!("q1", "up")).toBe(false);
    expect(fromHostQueueEntry({ id: "q", sessionId: "s", principal: "p", inputHash: "h", content: "c", permissionMode: "nope", position: 1, createdAt: "bad" })).toMatchObject({
      effectivePermissionMode: "ask",
      createdAt: 0,
    });
  });

  it("fails closed when the host is gone", async () => {
    const store = createHostQueueStore(() => null);
    expect(await store.listAll()).toEqual([]);
    await expect(store.remove("q1")).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
  });
});
