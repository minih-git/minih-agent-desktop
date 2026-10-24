import { describe, expect, it } from "vitest";

import { createHostQueueStore, createHostSessionPort, fromHostQueueEntry, toRacpItem, toSessionSummary } from "./host-ports.js";
import { encodeSessionMediaId } from "./session-media.js";

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
    const calls: Array<Record<string, unknown>> = [];
    const port = createHostSessionPort(() => windowedHost(messages, calls));

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
    // The walk costs one bounded window per page: the port never asks for the
    // transcript, which is what made a phone wait on a 12 MB parse per page.
    expect(calls.every((params) => params.messageLimit === 100)).toBe(true);
    // Every page after the first is named. A request without the id is the tail,
    // which is the page the client already has: it would look like a load that
    // never happens, which is exactly how an old Host failed.
    expect(calls[0]).not.toHaveProperty("messageBeforeId");
    expect(calls.slice(1).every((params) => typeof params.messageBeforeId === "string")).toBe(true);
  });

  it("stops the page when the Host no longer resolves the held id", async () => {
    const messages = ["m1", "m2", "m3"].map((id) => ({
      id,
      role: "assistant" as const,
      content: id,
      createdAt: "2026-09-18T00:00:00.000Z",
      status: "complete" as const,
    }));
    const calls: Array<Record<string, unknown>> = [];
    const port = createHostSessionPort(() => windowedHost(messages, calls));
    // A compaction rewrote the transcript after the client read its page: the
    // named row is gone, so the answer is the empty page that ends the walk, not
    // the tail that would replay newer rows into the older-page slot.
    const page = await port.history("s1", { limit: 2, beforeItemId: "gone" });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(calls[0]).toEqual({ id: "s1", messageLimit: 2, messageBeforeId: "gone", contentLimit: 64 * 1024 });
  });

  it("pages history backwards from an item id", async () => {
    const messages = ["m1", "m2", "m3", "m4"].map((id) => ({
      id,
      role: "assistant" as const,
      content: id,
      createdAt: "2026-09-18T00:00:00.000Z",
      status: "complete" as const,
    }));
    const calls: Array<Record<string, unknown>> = [];
    const port = createHostSessionPort(() => windowedHost(messages, calls));
    const page = await port.history("s1", { limit: 2, beforeItemId: "m4" });
    expect(page.items.map((item) => item.id)).toEqual(["m2", "m3"]);
    expect(page.hasMore).toBe(true);
    expect(calls[0]).toEqual({ id: "s1", messageLimit: 2, messageBeforeId: "m4", contentLimit: 64 * 1024 });
    const tail = await port.history("s1", { limit: 10 });
    expect(tail.items.map((item) => item.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(tail.hasMore).toBe(false);
    expect(calls[1]).toEqual({ id: "s1", messageLimit: 10, contentLimit: 64 * 1024 });
    expect(await createHostSessionPort(() => null).get("s1")).toBeNull();
  });

  it("reads session metadata without a transcript", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const port = createHostSessionPort(() => ({
      async call<T>(_method: string, params: Record<string, unknown> = {}) {
        calls.push(params);
        return {
          session: {
            id: "s1",
            title: "Fix build",
            mode: "plan",
            permissionMode: "auto",
            messages: [{ id: "m1" }],
          },
        } as T;
      },
    }));
    const summary = await port.get("s1");
    expect(calls[0]).toEqual({ id: "s1", messageLimit: 1, contentLimit: 64 * 1024 });
    expect(summary).toMatchObject({ id: "s1", title: "Fix build", mode: "plan", permissionMode: "auto" });
  });
  /**
   * A transcript row's raster image must reach a phone as an opaque
   * `mediaId` (`session/mediaRead`), computed from the row the Host recorded and
   * nothing else. Everything a client already read — kind, name, ref, MIME, the
   * message text — is passed through unchanged, and a non-raster row keeps no
   * media id at all: it is not media, and naming one would offer a preview the
   * Host then refuses.
   */
  it("projects a raster attachment to a media id and leaves other attachments alone", () => {
    const sha = "a".repeat(64);
    const item = toRacpItem({
      id: "m-media",
      role: "user",
      content: "look at these",
      createdAt: "2026-09-18T00:00:00.000Z",
      attachments: [
        { id: "att-1", kind: "image", name: "shot.png", ref: `attachments/${sha}`, mimeType: "image/png", size: 12 },
        { id: "att-2", kind: "image", name: "shot.webp", ref: `attachments/${sha}`, mimeType: "image/webp" },
        { id: "att-3", kind: "file", name: "report.pdf", ref: "docs/report.pdf", mimeType: "application/pdf" },
        { id: "att-4", kind: "image", name: "icon.svg", ref: `attachments/${sha}`, mimeType: "image/svg+xml" },
        { id: "att-5", kind: "image", name: "outside.png", ref: "/home/user/Pictures/outside.png", mimeType: "image/png" },
        { id: "att-6", kind: "session", name: "Earlier chat", ref: "session-1" },
        // A row the Host cannot scope to a message id carries no media id.
        { kind: "image", name: "loose.png", ref: `attachments/${sha}`, mimeType: "image/png" },
      ],
    });

    const content = item.content as { content: string; attachments: Array<Record<string, unknown>> };
    const attachments = content.attachments;
    expect(content.content).toBe("look at these");
    expect(attachments[0]).toEqual({
      id: "att-1",
      kind: "image",
      name: "shot.png",
      ref: `attachments/${sha}`,
      mimeType: "image/png",
      size: 12,
      mediaId: encodeSessionMediaId("m-media", "att-1"),
    });
    expect(attachments[1]?.mediaId).toBe(encodeSessionMediaId("m-media", "att-2"));
    // Non-media rows still carry no media id: a document, an SVG, a path outside
    // the attachments directory, a session link.
    for (const attachment of attachments.slice(2, 6)) {
      expect(attachment).not.toHaveProperty("mediaId");
    }
    expect(attachments[2]).toEqual({ id: "att-3", kind: "file", name: "report.pdf", ref: "docs/report.pdf", mimeType: "application/pdf" });
    // A row with no id of its own — every attachment read back from a Host
    // session record — is addressed by its position in the message. Leaving it
    // out is why a user's own photo never reached the phone.
    expect(attachments[6]).toMatchObject({ mediaId: encodeSessionMediaId("m-media", "idx-6") });
  });

  it("leaves a message without raster media byte-for-byte as stored", () => {
    const message = {
      id: "m-plain",
      role: "assistant" as const,
      content: "done",
      createdAt: "2026-09-18T00:00:00.000Z",
      status: "complete" as const,
      attachments: [{ id: "att-9", kind: "file" as const, name: "a.txt", ref: "a.txt" }],
    };
    const item = toRacpItem(message);
    expect(item.content).toBe(message);
    expect(item).toMatchObject({ id: "m-plain", itemType: "message", status: "completed", turnId: "" });
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

/**
 * host-core's bounded read, as the port now depends on it: a window of at most
 * `messageLimit` messages ending where `messageBeforeId` names, plus the two
 * cursors the port reads instead of slicing in JavaScript. A missing id is the
 * empty window the Rust side answers, not the tail.
 */
function windowedHost(
  messages: Array<{ id: string } & Record<string, unknown>>,
  calls: Array<Record<string, unknown>>,
) {
  return {
    async call<T>(_method: string, params: Record<string, unknown> = {}) {
      calls.push(params);
      const limit = Number(params.messageLimit ?? 0);
      const beforeItemId = typeof params.messageBeforeId === "string" ? params.messageBeforeId : undefined;
      const named = beforeItemId ? messages.findIndex((message) => message.id === beforeItemId) : messages.length;
      const cut = named === -1 ? 0 : named;
      const start = Math.max(0, cut - limit);
      return {
        session: {
          id: "s1",
          messages: messages.slice(start, cut),
          messageStart: start,
          hasMoreBefore: start > 0,
        },
      } as T;
    },
  };
}
