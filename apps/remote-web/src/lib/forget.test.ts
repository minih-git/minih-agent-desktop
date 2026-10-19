import { describe, expect, it } from "vitest";

import { createHostRegistry, type HostRegistry, type HostRegistryEntry, type RegistryStorage } from "./host-registry.js";
import { forgetAllHosts, forgetHost } from "./forget.js";
import type { CredentialPort, HostCredential } from "./credential-port.js";

/**
 * Forgetting a Host (protocol §11.4, §11.6).
 *
 * The order is the whole point: the device token authorizes `DELETE
 * /v1/push/registration`, so deleting it first leaves the phone receiving
 * notifications for a Host the user has taken away, with no way to ask it to
 * stop. These tests pin the order down, and the account-device case where one
 * token serves several Hosts.
 */
const ORIGIN = "https://gateway.example.com";

function memoryStorage(): RegistryStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

function entry(hostId: string, deviceId: string): HostRegistryEntry {
  return { hostId, label: hostId, deviceId, pairedAt: "2026-10-18T00:00:00.000Z", profile: "native" };
}

/** A credential port that records what happened, in order. */
function fakePort(registry: HostRegistry, tokens: Record<string, string>) {
  const order: string[] = [];
  const port: CredentialPort = {
    credentialFor: (hostId) => {
      const token = tokens[hostId];
      return token ? { kind: "header", token } : null;
    },
    pair: async () => {
      throw new Error("not used");
    },
    forget: async (hostId) => {
      order.push(`forget:${hostId}`);
      delete tokens[hostId];
      registry.forget(hostId);
    },
    adoptAccountDevice: async () => ({ ok: true, hostIds: [] }),
  };
  return { port, order };
}

function recordingFetch(calls: string[], status = 200) {
  return (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)} ${String((init?.headers as Record<string, string>)?.authorization ?? "")}`);
    return new Response(JSON.stringify({ result: { removed: true } }), { status });
  }) as unknown as typeof fetch;
}

describe("forgetHost", () => {
  it("unregisters push before the credential is deleted", async () => {
    const registry = createHostRegistry(memoryStorage());
    registry.save(entry("host_a", "dev_a"));
    const tokens = { host_a: "pdt1.a" };
    const { port, order } = fakePort(registry, tokens);
    const calls: string[] = [];

    await forgetHost("host_a", {
      registry,
      credentialPort: port,
      push: { gatewayOrigin: ORIGIN, fetchImpl: recordingFetch(calls) },
    });

    // The DELETE happened while the token still existed, and before the forget.
    expect(calls).toEqual([`DELETE ${ORIGIN}/v1/push/registration Bearer pdt1.a`]);
    expect(order).toEqual(["forget:host_a"]);
    expect(registry.get("host_a")).toBeUndefined();
  });

  it("keeps an account device's registration while another Host still uses it", async () => {
    const registry = createHostRegistry(memoryStorage());
    registry.save(entry("host_a", "dev_account"));
    registry.save(entry("host_b", "dev_account"));
    const tokens = { host_a: "pdt1.account", host_b: "pdt1.account" };
    const { port } = fakePort(registry, tokens);
    const calls: string[] = [];

    await forgetHost("host_a", {
      registry,
      credentialPort: port,
      push: { gatewayOrigin: ORIGIN, fetchImpl: recordingFetch(calls) },
    });

    // `host_b` still reaches the account through the same device: a DELETE here
    // would silence it.
    expect(calls).toEqual([]);
    expect(registry.get("host_a")).toBeUndefined();
    expect(registry.get("host_b")).toBeDefined();
  });

  it("deletes the registration when the last Host of the device goes", async () => {
    const registry = createHostRegistry(memoryStorage());
    registry.save(entry("host_a", "dev_account"));
    registry.save(entry("host_b", "dev_account"));
    const tokens = { host_a: "pdt1.account", host_b: "pdt1.account" };
    const { port } = fakePort(registry, tokens);
    const calls: string[] = [];

    await forgetHost("host_a", { registry, credentialPort: port, push: { gatewayOrigin: ORIGIN, fetchImpl: recordingFetch(calls) } });
    const failures: unknown[] = [];
    await forgetHost("host_b", {
      registry,
      credentialPort: port,
      push: {
        gatewayOrigin: ORIGIN,
        fetchImpl: recordingFetch(calls),
        onFailure: (error) => failures.push(error),
      },
    });

    expect(calls).toEqual([`DELETE ${ORIGIN}/v1/push/registration Bearer pdt1.account`]);
    expect(failures).toEqual([]);
  });

  it("forgets the Host even when the unregistration fails, and reports it", async () => {
    const registry = createHostRegistry(memoryStorage());
    registry.save(entry("host_a", "dev_a"));
    const { port } = fakePort(registry, { host_a: "pdt1.a" });
    const failures: unknown[] = [];

    await forgetHost("host_a", {
      registry,
      credentialPort: port,
      push: {
        gatewayOrigin: ORIGIN,
        fetchImpl: recordingFetch([], 503),
        onFailure: (error) => failures.push(error),
      },
    });

    // A token left on the device is worse than a stale registration, so the
    // forget goes ahead — but the failure is not silent.
    expect(registry.get("host_a")).toBeUndefined();
    expect(failures).toHaveLength(1);
  });

  it("does nothing about push in a build without it", async () => {
    const registry = createHostRegistry(memoryStorage());
    registry.save(entry("host_a", "dev_a"));
    const { port } = fakePort(registry, { host_a: "pdt1.a" });
    const calls: string[] = [];
    await forgetHost("host_a", { registry, credentialPort: port });
    expect(calls).toEqual([]);
    expect(registry.list()).toEqual([]);
  });
});

describe("forgetAllHosts", () => {
  it("unregisters each device once, before any token is deleted", async () => {
    const registry = createHostRegistry(memoryStorage());
    registry.save(entry("host_a", "dev_account"));
    registry.save(entry("host_b", "dev_account"));
    registry.save(entry("host_c", "dev_c"));
    const tokens: Record<string, string> = { host_a: "pdt1.account", host_b: "pdt1.account", host_c: "pdt1.c" };
    const { port } = fakePort(registry, tokens);
    const calls: string[] = [];

    await forgetAllHosts({ registry, credentialPort: port, push: { gatewayOrigin: ORIGIN, fetchImpl: recordingFetch(calls) } });

    // Two devices, two DELETEs: the shared account token is not deleted twice.
    expect(calls).toEqual([
      `DELETE ${ORIGIN}/v1/push/registration Bearer pdt1.account`,
      `DELETE ${ORIGIN}/v1/push/registration Bearer pdt1.c`,
    ]);
    expect(registry.list()).toEqual([]);
    expect(Object.keys(tokens)).toEqual([]);
  });
});

/** A `CredentialPort` is the only seam the forget path needs; keep it honest. */
export type ForgetTestPort = { credentialFor(hostId: string): HostCredential | null };
