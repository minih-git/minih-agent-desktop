import { describe, expect, it } from "vitest";

import type { MinihRouterModel } from "@minih-agent/shared";

import {
  DIRECT_CHAT_CONNECTION_KEY,
  migrateLastModel,
  readConnection,
  readRawConnection,
  writeConnection,
  type DirectChatConnection,
  type DirectChatStorage,
} from "./connection.js";

function model(overrides: Partial<MinihRouterModel> & { id: string }): MinihRouterModel {
  return {
    upstreamIds: [],
    vendor: "Test",
    category: "chat",
    protocols: ["openai-completions"],
    price: { input: null, output: null, cacheRead: null, cacheWrite: null },
    multiplePrices: false,
    tieredPricing: false,
    contextWindow: null,
    maxOutput: null,
    ...overrides,
  };
}

/** A `localStorage` stand-in that keeps what it was given. */
function storage(initial?: string): DirectChatStorage & { value: () => string | null } {
  let raw: string | null = initial ?? null;
  return {
    getItem: () => raw,
    setItem: (_key, value) => {
      raw = value;
    },
    removeItem: () => {
      raw = null;
    },
    value: () => raw,
  };
}

const chat = model({ id: "gpt-5", outputModalities: ["text"] });
const image = model({ id: "gpt-image-2", outputModalities: ["image"] });

function record(overrides: Partial<DirectChatConnection> = {}): DirectChatConnection {
  return {
    gatewayRoot: "https://router.example",
    accessKeyId: "42",
    keyName: "phone",
    maskedKey: "sk-gl-…4f2a",
    lastModelId: null,
    lastImageModelId: null,
    defaultChatModelId: null,
    defaultImageModelId: null,
    connectedAt: "2026-10-23T00:00:00.000Z",
    models: [chat, image],
    ...overrides,
  };
}

describe("the stored connection", () => {
  it("keeps the chat and image choices apart (ADR mobile-redesign D2)", () => {
    const store = storage();
    writeConnection(store, record({ lastModelId: "gpt-5", lastImageModelId: "gpt-image-2" }));
    const read = readConnection(store);
    expect(read?.lastModelId).toBe("gpt-5");
    expect(read?.lastImageModelId).toBe("gpt-image-2");
  });

  it("reads a record written before the image slot existed", () => {
    // The old build's record has no `lastImageModelId`; it must still open.
    const store = storage(
      JSON.stringify({
        ...record({ lastModelId: "gpt-5" }),
        lastImageModelId: undefined,
      }),
    );
    expect(readConnection(store)?.lastModelId).toBe("gpt-5");
    expect(readConnection(store)?.lastImageModelId).toBeNull();
  });

  it("moves an image-only last model to the image slot, once", () => {
    const store = storage();
    writeConnection(store, record({ lastModelId: "gpt-image-2" }));
    const migrated = readConnection(store);
    expect(migrated?.lastModelId).toBeNull();
    expect(migrated?.lastImageModelId).toBe("gpt-image-2");
    // The move was written back: a second read sees the migrated record, and
    // the raw record no longer names it as the chat model.
    expect(readConnection(store)?.lastModelId).toBeNull();
    expect(readRawConnection(store)).toContain('"lastImageModelId":"gpt-image-2"');
  });

  it("leaves a chat model where it is", () => {
    const store = storage();
    writeConnection(store, record({ lastModelId: "gpt-5" }));
    const read = readConnection(store);
    expect(read?.lastModelId).toBe("gpt-5");
    expect(read?.lastImageModelId).toBeNull();
  });

  it("leaves a model the cache cannot classify alone", () => {
    const store = storage();
    writeConnection(store, record({ lastModelId: "unknown-model", models: [] }));
    expect(readConnection(store)?.lastModelId).toBe("unknown-model");
    expect(readConnection(store)?.lastImageModelId).toBeNull();
  });

  it("keeps the stored image choice when the chat slot is migrated", () => {
    const store = storage();
    writeConnection(store, record({ lastModelId: "gpt-image-2", lastImageModelId: "dall-e-3" }));
    expect(readConnection(store)?.lastImageModelId).toBe("dall-e-3");
  });

  it("never derives the chat default from a stored image model", () => {
    // Before D2 the chat default was filled from `lastModelId`. On an upgraded
    // record that value may be an image model, so the fallback must read the
    // migrated slot and end up empty instead.
    const store = storage();
    writeConnection(store, record({ lastModelId: "gpt-image-2" }));
    const raw = JSON.parse(readRawConnection(store) ?? "{}") as Record<string, unknown>;
    delete raw.defaultChatModelId;
    const legacy = storage(JSON.stringify(raw));
    expect(readConnection(legacy)?.defaultChatModelId).toBeNull();
    expect(readConnection(legacy)?.lastImageModelId).toBe("gpt-image-2");
  });

  it("ignores a record that is not one of ours", () => {
    expect(readConnection(storage(JSON.stringify({ hello: "world" })))).toBeNull();
    expect(DIRECT_CHAT_CONNECTION_KEY).toBe("minih.remote-web.direct-chat.v1");
  });
});

describe("migrating the remembered model", () => {
  it("reports nothing to persist when the stored model is a chat model", () => {
    expect(migrateLastModel({ lastModelId: "gpt-5", lastImageModelId: null, models: [chat] })).toEqual({
      lastModelId: "gpt-5",
      lastImageModelId: null,
      moved: false,
    });
  });

  it("moves only a model that cannot hold a conversation", () => {
    const both = model({ id: "gemini-image", outputModalities: ["text", "image"] });
    // Declares text as well, so it is still a valid chat model.
    expect(
      migrateLastModel({ lastModelId: "gemini-image", lastImageModelId: null, models: [both] }),
    ).toEqual({ lastModelId: "gemini-image", lastImageModelId: null, moved: false });
    expect(
      migrateLastModel({ lastModelId: "gpt-image-2", lastImageModelId: null, models: [image] }),
    ).toEqual({ lastModelId: null, lastImageModelId: "gpt-image-2", moved: true });
  });

  it("does not move a chat model the operator merely closed to mobiles", () => {
    // `mobile_chat` is a permission the operator can flip back; migrating on it
    // would push the user's remembered chat model into the image slot for good,
    // which is a persisted change caused by a temporary switch.
    const both = model({ id: "gemini-3", outputModalities: ["text", "image"], mobileChat: false });
    expect(
      migrateLastModel({ lastModelId: "gemini-3", lastImageModelId: null, models: [both] }),
    ).toEqual({ lastModelId: "gemini-3", lastImageModelId: null, moved: false });
  });
});