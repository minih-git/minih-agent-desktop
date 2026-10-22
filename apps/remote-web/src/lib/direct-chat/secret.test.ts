import { describe, expect, it } from "vitest";

import { NativeCredentialPort } from "../native-credential-port.js";
import { createHostRegistry, createMemoryStorage } from "../host-registry.js";
import { createMemorySecureStore, deviceTokenKey, hostIdFromKey } from "../secure-store.js";
import {
  DIRECT_CHAT_KEY_ITEM,
  createDirectChatSecret,
  createUnavailableSecretStore,
  isDirectChatKeyItem,
} from "./secret.js";

/**
 * The AccessKey and the remote-control device tokens share one platform store,
 * so the two must not be able to reach each other (ADR
 * mobile-direct-gateway-chat §2): a device token cannot call the model API, and
 * the reconciliation that deletes orphaned device tokens must never delete the
 * AccessKey.
 */
describe("direct-chat secret", () => {
  it("stores the key under its own item, not under the device-token prefix", async () => {
    const store = createMemorySecureStore();
    const secret = createDirectChatSecret(store);
    await secret.write("sk-test-key");
    expect(store.entries()).toEqual({ [DIRECT_CHAT_KEY_ITEM]: "sk-test-key" });
    expect(hostIdFromKey(DIRECT_CHAT_KEY_ITEM)).toBeNull();
    expect(DIRECT_CHAT_KEY_ITEM.startsWith("device-token.")).toBe(false);
  });

  it("reads back only the direct-chat item", async () => {
    const store = createMemorySecureStore({
      [deviceTokenKey("host-1")]: "device-token-value",
      [DIRECT_CHAT_KEY_ITEM]: "sk-test-key",
    });
    const secret = createDirectChatSecret(store);
    expect(await secret.read()).toBe("sk-test-key");
    expect(await secret.exists()).toBe(true);
  });

  it("treats a blank or missing item as no connection", async () => {
    const secret = createDirectChatSecret(createMemorySecureStore({ [DIRECT_CHAT_KEY_ITEM]: "   " }));
    expect(await secret.read()).toBeNull();
    expect(await secret.exists()).toBe(false);
    expect(await createDirectChatSecret(createMemorySecureStore()).read()).toBeNull();
  });

  it("refuses to store an empty key", async () => {
    const secret = createDirectChatSecret(createMemorySecureStore());
    await expect(secret.write("  ")).rejects.toThrow(/empty/);
  });

  it("unlinks by deleting the item and leaves the device tokens alone", async () => {
    const store = createMemorySecureStore({
      [deviceTokenKey("host-1")]: "device-token-value",
      [DIRECT_CHAT_KEY_ITEM]: "sk-test-key",
    });
    await createDirectChatSecret(store).remove();
    expect(store.entries()).toEqual({ [deviceTokenKey("host-1")]: "device-token-value" });
    // Idempotent: a second unlink is not an error.
    await expect(createDirectChatSecret(store).remove()).resolves.toBeUndefined();
  });

  it("survives the device-token reconciliation that runs on every launch", async () => {
    // The registry holds no computer, so `ready()` deletes every orphaned
    // device token. The AccessKey has to be there afterwards, which is the whole
    // reason it does not live under `device-token.*`.
    const store = createMemorySecureStore({
      [deviceTokenKey("forgotten-host")]: "orphan-token",
      [DIRECT_CHAT_KEY_ITEM]: "sk-test-key",
    });
    const port = new NativeCredentialPort({
      registry: createHostRegistry(createMemoryStorage()),
      client: "android",
      userAgent: "test",
    });
    port.attach(store);
    await port.ready();

    expect(store.entries()).toEqual({ [DIRECT_CHAT_KEY_ITEM]: "sk-test-key" });
    expect(await createDirectChatSecret(store).read()).toBe("sk-test-key");
  });

  it("keeps a paired computer's token and the key side by side", async () => {
    const registry = createHostRegistry(createMemoryStorage());
    registry.save({
      hostId: "host-1",
      label: "Desktop",
      deviceId: "dev-1",
      csrfToken: "csrf-1",
      pairedAt: "2026-10-21T00:00:00.000Z",
    });
    const store = createMemorySecureStore({
      [deviceTokenKey("host-1")]: "device-token-value",
      [DIRECT_CHAT_KEY_ITEM]: "sk-test-key",
    });
    const port = new NativeCredentialPort({ registry, client: "android", userAgent: "test" });
    port.attach(store);
    await port.ready();

    expect(store.entries()).toEqual({
      [deviceTokenKey("host-1")]: "device-token-value",
      [DIRECT_CHAT_KEY_ITEM]: "sk-test-key",
    });
    expect(port.credentialFor("host-1")).toEqual({ kind: "header", token: "device-token-value" });
  });

  it("recognizes exactly its own item", () => {
    expect(isDirectChatKeyItem(DIRECT_CHAT_KEY_ITEM)).toBe(true);
    expect(isDirectChatKeyItem(deviceTokenKey("host-1"))).toBe(false);
    expect(isDirectChatKeyItem("direct-chat.access-key")).toBe(false);
  });
});

describe("the browser build's secret store", () => {
  it("holds nothing and refuses to write, rather than using localStorage", async () => {
    const store = createUnavailableSecretStore();
    expect(await store.get(DIRECT_CHAT_KEY_ITEM)).toBeNull();
    await expect(store.set(DIRECT_CHAT_KEY_ITEM, "sk-test-key")).rejects.toThrow(/secure store/);
    // Removing is a no-op, so a screen can always offer Unlink.
    await expect(store.remove(DIRECT_CHAT_KEY_ITEM)).resolves.toBeUndefined();
  });
});
