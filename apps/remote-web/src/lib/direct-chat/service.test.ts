import { describe, expect, it } from "vitest";

import type { MinihRouterModel } from "@minih-agent/shared";

import { createMemorySecureStore } from "../secure-store.js";
import {
  DIRECT_CHAT_CONNECTION_KEY,
  isSameAccount,
  readConnection,
  writeConnection,
  type DirectChatStorage,
} from "./connection.js";
import type { ControlClient, ControlResult, DirectChatFailure } from "./control.js";
import { DIRECT_CHAT_KEY_ITEM, createDirectChatSecret } from "./secret.js";
import { createDirectChatService } from "./service.js";

const ROOT = "https://models.example.test";
const KEY = "sk-gl-sentinel-key-0001";

function memoryStorage(initial: Record<string, string> = {}): DirectChatStorage & {
  entries(): Record<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    entries: () => Object.fromEntries(map),
  };
}

type Answer = ControlResult<unknown>;

/** A full `/api/models` page; the control client returns the parsed shape. */
const page = (items: MinihRouterModel[], totalPages = 1) => ({
  items,
  page: 1,
  pageSize: 100,
  totalItems: items.length,
  totalPages,
});

/** A control client that answers from a script and records the calls. */
function fakeControl(script: {
  session?: Answer;
  models?: Answer | Answer[];
}) {
  const calls = { verify: [] as string[], models: [] as Array<{ page: number; pageSize: number }> };
  const queue: Answer[] | null = Array.isArray(script.models) ? [...script.models] : null;
  const control: ControlClient = {
    async verifyKey(key) {
      calls.verify.push(key);
      const answer = script.session ?? { ok: true, value: null };
      if (!answer.ok) return answer as never;
      return {
        ok: true,
        value: {
          accessKeyId: "7",
          keyName: "phone",
          status: "active",
          maskedKey: "sk-gl-…0001",
          allowedPeerCidrs: [],
        },
      };
    },
    async fetchModels(_key, input) {
      calls.models.push({ page: input.page, pageSize: input.pageSize });
      const answer: Answer | undefined = queue ? queue.shift() : (script.models as Answer | undefined);
      if (!answer) return { ok: true, value: page([], 1) } as never;
      return answer as never;
    },
  };
  return { calls, control };
}

const model = (id: string): MinihRouterModel => ({
  id,
  upstreamIds: [],
  vendor: "Test",
  category: "chat",
  protocols: ["openai-completions"],
  price: { input: "1", output: "2", cacheRead: null, cacheWrite: null },
  multiplePrices: false,
  tieredPricing: false,
  contextWindow: 8192,
  maxOutput: 2048,
});

function harness(script: Parameters<typeof fakeControl>[0]) {
  const storage = memoryStorage();
  const store = createMemorySecureStore();
  const { calls, control } = fakeControl(script);
  const service = createDirectChatService({
    control,
    secret: createDirectChatSecret(store),
    storage,
    gatewayRoot: ROOT,
    now: () => new Date("2026-10-21T09:00:00.000Z"),
  });
  return { storage, store, calls, service };
}

const failure = (kind: DirectChatFailure["kind"]): ControlResult<never> => ({
  ok: false,
  failure: { kind, message: `failed: ${kind}` },
});

/**
 * Connecting is the one place a key enters the device, so these tests pin the
 * order of operations as much as the outcomes: verify, then store, then cache.
 */
describe("connecting a model account", () => {
  it("stores the key and a credential-free record once the key verifies", async () => {
    const { storage, store, service } = harness({
      models: { ok: true, value: page([model("gpt-4.1")], 1) },
    });
    const outcome = await service.connect(` ${KEY} `);
    expect(outcome.ok).toBe(true);

    // The secret is in the secure store under its own item, nowhere else.
    expect(store.entries()).toEqual({ [DIRECT_CHAT_KEY_ITEM]: KEY });
    const record = readConnection(storage);
    expect(record).toMatchObject({
      gatewayRoot: ROOT,
      accessKeyId: "7",
      keyName: "phone",
      maskedKey: "sk-gl-…0001",
      lastModelId: null,
      connectedAt: "2026-10-21T09:00:00.000Z",
    });
    expect(record?.models.map((entry) => entry.id)).toEqual(["gpt-4.1"]);
    // The key itself must not be in the metadata record, which is not encrypted.
    expect(JSON.stringify(record)).not.toContain(KEY);
  });

  it("refuses to store a key the gateway rejects", async () => {
    const { storage, store, service } = harness({ session: failure("unauthorized") });
    const outcome = await service.connect(KEY);
    expect(outcome.ok).toBe(false);
    expect(store.entries()).toEqual({});
    expect(readConnection(storage)).toBeNull();
  });

  it("keeps a working connection when a new key is rejected", async () => {
    const { storage, store, service } = harness({
      models: { ok: true, value: page([model("gpt-4.1")], 1) },
    });
    await service.connect(KEY);
    const before = readConnection(storage);

    // A second service over the same storage, whose gateway rejects the key.
    const rejected = createDirectChatService({
      control: fakeControl({ session: failure("unauthorized") }).control,
      secret: createDirectChatSecret(store),
      storage,
      gatewayRoot: ROOT,
    });
    expect((await rejected.connect("sk-bad")).ok).toBe(false);

    expect(store.entries()).toEqual({ [DIRECT_CHAT_KEY_ITEM]: KEY });
    expect(readConnection(storage)).toEqual(before);
  });

  it("reports a key restricted to particular networks", async () => {
    const { service } = harness({ models: { ok: true, value: page([], 1) } });
    const outcome = await service.connect(KEY);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.restricted).toBe(false);
  });

  it("refuses to connect when the build has no model gateway", async () => {
    const store = createMemorySecureStore();
    const storage = memoryStorage();
    const service = createDirectChatService({
      control: fakeControl({}).control,
      secret: createDirectChatSecret(store),
      storage,
      gatewayRoot: null,
    });
    const outcome = await service.connect(KEY);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe("gateway");
    expect(store.entries()).toEqual({});
  });

  it("fails without storing the key when the account record cannot be saved", async () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error("quota exceeded");
    };
    const store = createMemorySecureStore();
    const service = createDirectChatService({
      control: fakeControl({ models: { ok: true, value: page([model("gpt-4.1")], 1) } }).control,
      secret: createDirectChatSecret(store),
      storage,
      gatewayRoot: ROOT,
    });
    const outcome = await service.connect(KEY);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe("gateway");
    expect(store.entries()).toEqual({});
    expect((await service.status()).state).toBe("disconnected");
  });

  it("puts the previous account back when the new key cannot be stored", async () => {
    const storage = memoryStorage();
    const store = createMemorySecureStore();
    const first = createDirectChatService({
      control: fakeControl({ models: { ok: true, value: page([model("gpt-4.1")], 1) } }).control,
      secret: createDirectChatSecret(store),
      storage,
      gatewayRoot: ROOT,
    });
    await first.connect(KEY);
    const before = storage.getItem(DIRECT_CHAT_CONNECTION_KEY);

    // A different account whose key the secure store refuses.
    const control = fakeControl({ models: { ok: true, value: page([model("other")], 1) } }).control;
    const verifyKey = control.verifyKey;
    control.verifyKey = async (key) => {
      const result = await verifyKey(key);
      return result.ok ? { ok: true, value: { ...result.value, accessKeyId: "8", keyName: "other" } } : result;
    };
    const refusing = { ...store, set: async () => Promise.reject(new Error("keychain locked")) };
    const second = createDirectChatService({
      control,
      secret: createDirectChatSecret(refusing),
      storage,
      gatewayRoot: ROOT,
    });
    const outcome = await second.connect("sk-other");
    expect(outcome.ok).toBe(false);
    expect(storage.getItem(DIRECT_CHAT_CONNECTION_KEY)).toBe(before);
    expect(store.entries()).toEqual({ [DIRECT_CHAT_KEY_ITEM]: KEY });
    expect(readConnection(storage)?.accessKeyId).toBe("7");
  });

  it("keeps the cached catalog across a rotation of the same account", async () => {
    const storage = memoryStorage();
    const store = createMemorySecureStore();
    const first = createDirectChatService({
      control: fakeControl({ models: { ok: true, value: page([model("gpt-4.1")], 1) } }).control,
      secret: createDirectChatSecret(store),
      storage,
      gatewayRoot: ROOT,
    });
    await first.connect(KEY);
    first.rememberModel("gpt-4.1");

    // Same access_key_id, new key text: a rotation, not a new account.
    const rotated = createDirectChatService({
      control: fakeControl({ models: { ok: true, value: page([model("gpt-4.1")], 1) } }).control,
      secret: createDirectChatSecret(store),
      storage,
      gatewayRoot: ROOT,
    });
    const outcome = await rotated.connect("sk-rotated");
    expect(outcome.ok).toBe(true);
    expect(store.entries()).toEqual({ [DIRECT_CHAT_KEY_ITEM]: "sk-rotated" });
    expect(readConnection(storage)?.lastModelId).toBe("gpt-4.1");
  });

  it("drops the remembered model when the key belongs to another account", async () => {
    const storage = memoryStorage();
    const store = createMemorySecureStore();
    const first = createDirectChatService({
      control: fakeControl({ models: { ok: true, value: page([model("gpt-4.1")], 1) } }).control,
      secret: createDirectChatSecret(store),
      storage,
      gatewayRoot: ROOT,
    });
    await first.connect(KEY);
    first.rememberModel("gpt-4.1");

    const otherAccount = createDirectChatService({
      control: {
        async verifyKey() {
          return {
            ok: true,
            value: {
              accessKeyId: "8",
              keyName: "tablet",
              status: "active",
              maskedKey: "sk-gl-…0002",
              allowedPeerCidrs: [],
            },
          };
        },
        async fetchModels() {
          return { ok: true, value: page([model("qwen")], 1) };
        },
      },
      secret: createDirectChatSecret(store),
      storage,
      gatewayRoot: ROOT,
    });
    const outcome = await otherAccount.connect("sk-other");
    expect(outcome.ok).toBe(true);
    const record = readConnection(storage);
    expect(record?.accessKeyId).toBe("8");
    expect(record?.lastModelId).toBeNull();
  });

  it("reports a first-page catalog failure instead of connecting without one", async () => {
    const { storage, store, service } = harness({ models: failure("quota") });
    const outcome = await service.connect(KEY);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe("quota");
    expect(store.entries()).toEqual({});
    expect(readConnection(storage)).toBeNull();
  });

  it("keeps the rows it could read when a later page fails", async () => {
    const { service } = harness({
      models: [
        { ok: true, value: page([model("a"), model("b")], 3) },
        { ok: true, value: page([model("c")], 3) },
        failure("transport"),
      ],
    });
    const outcome = await service.connect(KEY);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.connection.models.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("stops paging once the gateway reports the last page", async () => {
    const { calls, service } = harness({
      models: { ok: true, value: page([model("a")], 1) },
    });
    await service.connect(KEY);
    expect(calls.models).toHaveLength(1);
  });
});

describe("the connection's status", () => {
  it("is disconnected with no record", async () => {
    const { service } = harness({});
    expect(await service.status()).toEqual({ state: "disconnected" });
  });

  it("is disconnected when the record survived but the secret did not", async () => {
    const { storage, service } = harness({});
    writeConnection(storage, {
      gatewayRoot: ROOT,
      accessKeyId: "7",
      keyName: "phone",
      maskedKey: "",
      lastModelId: null,
      connectedAt: "2026-10-21T09:00:00.000Z",
      models: [],
    });
    expect(await service.status()).toEqual({ state: "disconnected" });
  });

  it("is connected once both exist", async () => {
    const { service } = harness({ models: { ok: true, value: page([], 1) } });
    await service.connect(KEY);
    const status = await service.status();
    expect(status.state).toBe("connected");
    if (status.state === "connected") expect(status.connection.accessKeyId).toBe("7");
  });
});

describe("refreshing the catalog", () => {
  it("reads with the stored key and updates the cache", async () => {
    const storage = memoryStorage();
    const store = createMemorySecureStore();
    let round = 0;
    const control: ControlClient = {
      async verifyKey() {
        return {
          ok: true,
          value: { accessKeyId: "7", keyName: "phone", status: "active", maskedKey: "", allowedPeerCidrs: [] },
        };
      },
      async fetchModels() {
        round += 1;
        return { ok: true, value: page([model(round === 1 ? "old" : "new")], 1) };
      },
    };
    const service = createDirectChatService({
      control,
      secret: createDirectChatSecret(store),
      storage,
      gatewayRoot: ROOT,
    });
    await service.connect(KEY);
    const refreshed = await service.refreshModels();
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) expect(refreshed.models.map((entry) => entry.id)).toEqual(["new"]);
    expect(readConnection(storage)?.models.map((entry) => entry.id)).toEqual(["new"]);
  });

  it("says so when there is no key to read with", async () => {
    const { service } = harness({});
    const refreshed = await service.refreshModels();
    expect(refreshed.ok).toBe(false);
    if (!refreshed.ok) expect(refreshed.failure.kind).toBe("unauthorized");
  });
});

describe("unlinking", () => {
  it("removes the secret first and the record with it", async () => {
    const { storage, store, service } = harness({ models: { ok: true, value: page([], 1) } });
    await service.connect(KEY);
    await service.disconnect();

    expect(store.entries()).toEqual({});
    expect(readConnection(storage)).toBeNull();
    expect(await service.status()).toEqual({ state: "disconnected" });
  });

  it("still removes the secret when the record cannot be cleared", async () => {
    const store = createMemorySecureStore();
    const storage: DirectChatStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const service = createDirectChatService({
      control: fakeControl({ models: { ok: true, value: page([], 1) } }).control,
      secret: createDirectChatSecret(store),
      storage,
      gatewayRoot: ROOT,
    });
    await service.connect(KEY);
    await expect(service.disconnect()).resolves.toBeUndefined();
    expect(store.entries()).toEqual({});
  });
});

describe("the connection record", () => {
  it("is one versioned key that holds no secret", async () => {
    const storage = memoryStorage();
    writeConnection(storage, {
      gatewayRoot: ROOT,
      accessKeyId: "7",
      keyName: "phone",
      maskedKey: "sk-gl-…0001",
      lastModelId: null,
      connectedAt: "2026-10-21T09:00:00.000Z",
      models: [],
    });
    expect(Object.keys(storage.entries())).toEqual([DIRECT_CHAT_CONNECTION_KEY]);
    expect(DIRECT_CHAT_CONNECTION_KEY).toBe("minih.remote-web.direct-chat.v1");
  });

  it("reads unreadable state as no connection instead of throwing", () => {
    expect(readConnection(memoryStorage({ [DIRECT_CHAT_CONNECTION_KEY]: "{oops" }))).toBeNull();
    expect(readConnection(memoryStorage({ [DIRECT_CHAT_CONNECTION_KEY]: '{"gatewayRoot":"x"}' }))).toBeNull();
    expect(readConnection(null)).toBeNull();
  });

  it("compares accounts by root and key id, never by key text", () => {
    const record = {
      gatewayRoot: ROOT,
      accessKeyId: "7",
      keyName: "",
      maskedKey: "",
      lastModelId: null,
      connectedAt: "",
      models: [],
    };
    expect(isSameAccount(record, { gatewayRoot: ROOT, accessKeyId: "7" })).toBe(true);
    expect(isSameAccount(record, { gatewayRoot: ROOT, accessKeyId: "8" })).toBe(false);
    expect(isSameAccount(record, { gatewayRoot: "https://other.test", accessKeyId: "7" })).toBe(false);
    expect(isSameAccount(null, { gatewayRoot: ROOT, accessKeyId: "7" })).toBe(false);
  });
});
