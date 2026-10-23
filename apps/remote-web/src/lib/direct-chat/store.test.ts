import { describe, expect, it } from "vitest";

import type { DirectChatConversation, DirectChatMedia, DirectChatScope } from "./history-store.js";
import { createMemoryDirectChatStore } from "./memory-store.js";

const SCOPE_A: DirectChatScope = { gatewayRoot: "https://models.example.test", accessKeyId: "key-a" };
const SCOPE_B: DirectChatScope = { gatewayRoot: "https://models.example.test", accessKeyId: "key-b" };

describe("DirectChatStore draft & media storage", () => {
  it("isolates drafts across different accounts and supports clearDraft", async () => {
    const store = createMemoryDirectChatStore();

    expect(await store.draft(SCOPE_A)).toBe("");
    expect(await store.draft(SCOPE_B)).toBe("");

    await store.transact(async (tx) => {
      await tx.putDraft(SCOPE_A, "draft for account A");
      await tx.putDraft(SCOPE_B, "draft for account B");
    });

    expect(await store.draft(SCOPE_A)).toBe("draft for account A");
    expect(await store.draft(SCOPE_B)).toBe("draft for account B");

    await store.transact(async (tx) => {
      await tx.clearDraft(SCOPE_A);
    });

    expect(await store.draft(SCOPE_A)).toBe("");
    expect(await store.draft(SCOPE_B)).toBe("draft for account B");
  });

  it("stores media, filters by conversation and cascades deletion on deleteConversation", async () => {
    const store = createMemoryDirectChatStore();
    const convId = "conv-1";

    const conv: DirectChatConversation = {
      id: convId,
      scope: SCOPE_A,
      title: "Test Chat",
      createdAt: "2026-10-23T10:00:00.000Z",
      updatedAt: "2026-10-23T10:00:00.000Z",
      pinned: false,
      archived: false,
      nextModelId: "test-model",
      nextProtocol: "openai-completions",
      draft: "",
    };

    const media1: DirectChatMedia = {
      id: "media-1",
      scope: SCOPE_A,
      conversationId: convId,
      mime: "image/png",
      byteLength: 1024,
      width: 100,
      height: 100,
      data: new Blob(["sample png"], { type: "image/png" }),
      createdAt: "2026-10-23T10:00:00.000Z",
    };

    const media2: DirectChatMedia = {
      id: "media-2",
      scope: SCOPE_B,
      conversationId: "conv-other",
      mime: "image/jpeg",
      byteLength: 2048,
      data: new Blob(["sample jpeg"], { type: "image/jpeg" }),
      createdAt: "2026-10-23T10:01:00.000Z",
    };
    await store.transact(async (tx) => {
      await tx.putConversation(conv);
      await tx.putMedia(media1);
      await tx.putMedia(media2);
    });

    expect(await store.media("media-1")).toEqual(media1);
    expect(await store.media("media-2")).toEqual(media2);
    expect(await store.mediaForConversation(convId)).toEqual([media1]);
    expect(await store.mediaForConversation("conv-other")).toEqual([media2]);

    // Deleting conversation cascades deletion of media1, while media2 remains
    await store.transact(async (tx) => {
      await tx.deleteConversation(convId);
    });

    expect(await store.conversation(convId)).toBeNull();
    expect(await store.media("media-1")).toBeNull();
    expect(await store.mediaForConversation(convId)).toEqual([]);
    expect(await store.media("media-2")).toEqual(media2);
  });
});
