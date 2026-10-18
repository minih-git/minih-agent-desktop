import { describe, expect, it } from "vitest";

import { createHostRegistry, createMemoryStorage, type HostRegistryEntry } from "./host-registry.js";
import { NativeCredentialPort } from "./native-credential-port.js";
import { createMemorySecureStore } from "./secure-store.js";

type Call = { url: string; init: RequestInit | undefined };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const paired = { deviceId: "dev_1", hostId: "host1", roles: ["viewer"], token: "pdt1.secret" };

const request = {
  gatewayOrigin: "https://gw.example.test",
  hostId: "host1",
  pairingToken: "ppt1.secret",
  deviceLabel: "iPhone",
};

const entry: HostRegistryEntry = {
  hostId: "host1",
  label: "iPhone",
  deviceId: "dev_1",
  pairedAt: "2026-09-18T10:00:00.000Z",
  profile: "native",
};

function setup(options: { response?: Response; registry?: HostRegistryEntry[]; items?: Record<string, string> } = {}) {
  const storage = createMemoryStorage(
    options.registry ? { "minih.remote-web.hosts.v1": JSON.stringify(options.registry) } : {},
  );
  const registry = createHostRegistry(storage);
  const store = createMemorySecureStore(options.items ?? {});
  const calls: Call[] = [];
  const storageErrors: unknown[] = [];
  const response = options.response ?? jsonResponse(200, paired);
  const port = new NativeCredentialPort({
    registry,
    client: "ios",
    userAgent: "iPhone",
    fetchImpl: ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(response.clone());
    }) as typeof fetch,
    now: () => new Date("2026-09-18T10:00:00.000Z"),
    onStorageError: (error) => storageErrors.push(error),
  });
  port.attach(store);
  return { registry, store, port, calls, storageErrors };
}

describe("native credential port", () => {
  it("stores the token in the secure store and never in the registry entry", async () => {
    const { registry, store, port } = setup();
    const outcome = await port.pair(request);

    expect(outcome).toEqual({ ok: true, entry });
    expect(store.entries()).toEqual({ "device-token.host1": "pdt1.secret" });
    expect(registry.get("host1")).toEqual(entry);
    expect(JSON.stringify(registry.list())).not.toContain("pdt1.secret");
    expect(port.credentialFor("host1")).toEqual({ kind: "header", token: "pdt1.secret" });
    expect(port.credentialFor("host2")).toBeNull();
  });

  it("sends the native profile with no ambient cookie", async () => {
    const { port, calls } = setup();
    await port.pair(request);
    expect(calls[0]!.init?.credentials).toBe("omit");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ deviceLabel: "iPhone", client: "ios" });
  });

  it("does not record a Host whose token could not be stored", async () => {
    const { registry, store, port } = setup();
    store.failWrites(new Error("the Keychain is locked"));

    const outcome = await port.pair(request);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.failure.code).toBe("STORAGE_FAILED");
    expect(registry.list()).toEqual([]);
    expect(store.entries()).toEqual({});
    expect(port.credentialFor("host1")).toBeNull();
  });

  it("reports a Gateway failure without touching either store", async () => {
    const { registry, store, port } = setup({
      response: jsonResponse(400, { error: { data: { code: "PAIRING_TOKEN_EXPIRED", message: "expired" } } }),
    });
    const outcome = await port.pair(request);
    expect(outcome.ok ? "" : outcome.failure.code).toBe("PAIRING_TOKEN_EXPIRED");
    expect(registry.list()).toEqual([]);
    expect(store.entries()).toEqual({});
  });

  it("loads the cached token of every paired host on ready", async () => {
    const { port } = setup({ registry: [entry], items: { "device-token.host1": "pdt1.secret" } });
    await port.ready();
    expect(port.credentialFor("host1")).toEqual({ kind: "header", token: "pdt1.secret" });
  });

  it("deletes a stored token that no registry entry owns", async () => {
    const { store, port } = setup({
      registry: [entry],
      items: { "device-token.host1": "pdt1.secret", "device-token.ghost": "pdt1.orphan", "other.prefix": "x" },
    });
    await port.ready();
    // The iOS Keychain outlives a reinstall while `localStorage` does not, so an
    // unreachable secret is removed; an item another prefix owns is left alone.
    expect(Object.keys(store.entries()).sort()).toEqual(["device-token.host1", "other.prefix"]);
    expect(port.credentialFor("host1")).toEqual({ kind: "header", token: "pdt1.secret" });
  });

  it("treats a registry entry whose token is gone as not paired", async () => {
    const { port } = setup({ registry: [entry] });
    await port.ready();
    expect(port.credentialFor("host1")).toBeNull();
  });

  it("forget removes both the token and the entry", async () => {
    const { registry, store, port } = setup();
    await port.pair(request);
    await port.forget("host1");
    expect(registry.list()).toEqual([]);
    expect(store.entries()).toEqual({});
    expect(port.credentialFor("host1")).toBeNull();
  });

  it("reports a deletion that fails after the Host is forgotten", async () => {
    const { registry, store, port, storageErrors } = setup();
    await port.pair(request);
    const failing = { ...store, remove: async () => Promise.reject(new Error("the Keychain is locked")) };
    port.attach(failing);

    await port.forget("host1");

    expect(registry.list()).toEqual([]);
    expect(port.credentialFor("host1")).toBeNull();
    expect(String(storageErrors[0])).toContain("Keychain");
  });

  it("refuses to run before its secure store is attached", async () => {
    const registry = createHostRegistry(createMemoryStorage());
    const port = new NativeCredentialPort({ registry, client: "android" });
    await expect(port.ready()).rejects.toThrow(/before its secure store/);
    await expect(port.pair(request)).rejects.toThrow(/before its secure store/);
  });
});
