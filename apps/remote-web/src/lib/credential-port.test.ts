import { describe, expect, it } from "vitest";

import { WebCookieCredentialPort, credentialHeaders } from "./credential-port.js";
import { HOST_REGISTRY_STORAGE_KEY, createHostRegistry, createMemoryStorage } from "./host-registry.js";

function port(storage = createMemoryStorage()) {
  const registry = createHostRegistry(storage);
  const fetchImpl = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ deviceId: "dev_1", hostId: "host1", roles: ["viewer"], csrfToken: "csrf-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;
  return {
    storage,
    registry,
    credentialPort: new WebCookieCredentialPort({
      registry,
      fetchImpl,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1 Safari/605.1",
      now: () => new Date("2026-09-18T10:00:00.000Z"),
    }),
  };
}

describe("WebCookieCredentialPort", () => {
  it("has no credential before pairing", () => {
    expect(port().credentialPort.credentialFor("host1")).toBeNull();
  });

  it("stores the paired device as a cookie credential and never the token", async () => {
    const { credentialPort, registry, storage } = port();
    const outcome = await credentialPort.pair({
      gatewayOrigin: "https://gw.example.com",
      hostId: "host1",
      pairingToken: "ppt1.secret",
    });

    expect(outcome).toEqual({
      ok: true,
      entry: {
        hostId: "host1",
        label: "Safari on macOS",
        deviceId: "dev_1",
        csrfToken: "csrf-1",
        pairedAt: "2026-09-18T10:00:00.000Z",
      },
    });
    expect(registry.get("host1")?.deviceId).toBe("dev_1");
    expect(credentialPort.credentialFor("host1")).toEqual({ kind: "cookie", csrfToken: "csrf-1" });
    expect(storage.getItem(HOST_REGISTRY_STORAGE_KEY)).not.toContain("ppt1.secret");
    expect(storage.getItem(HOST_REGISTRY_STORAGE_KEY)).not.toContain("pdt1.");
  });

  it("honours an explicit device label", async () => {
    const { credentialPort, registry } = port();
    await credentialPort.pair({
      gatewayOrigin: "https://gw.example.com",
      hostId: "host1",
      pairingToken: "ppt1.secret",
      deviceLabel: "  Pixel 9  ",
    });
    expect(registry.get("host1")?.label).toBe("Pixel 9");
  });

  it("forgets a host credential", async () => {
    const { credentialPort } = port();
    await credentialPort.pair({ gatewayOrigin: "https://gw.example.com", hostId: "host1", pairingToken: "ppt1.secret" });
    credentialPort.forget("host1");
    expect(credentialPort.credentialFor("host1")).toBeNull();
  });

  it("does not store anything when pairing fails", async () => {
    const registry = createHostRegistry(createMemoryStorage());
    const failing = new WebCookieCredentialPort({
      registry,
      fetchImpl: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { data: { code: "PAIRING_FAILED", message: "bad code" } } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        )) as typeof fetch,
    });
    const outcome = await failing.pair({ gatewayOrigin: "https://gw.example.com", hostId: "host1", pairingToken: "ppt1.x" });
    expect(outcome.ok).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  /**
   * One account device, granted once and stored on every Host of the account
   * (protocol §11.5). The browser never sees the device token: the Gateway set
   * an `HttpOnly` cookie per Host, and what this port keeps is the CSRF value
   * that makes a mutation to each of those Hosts possible.
   */
  describe("adoptAccountDevice", () => {
    const adoption = {
      deviceId: "dev_account",
      label: "iPad",
      hosts: [
        { hostId: "host1", label: "desk", requiresOwnConfirmation: false },
        // The strict computer of the roster: it will never adopt a sibling's
        // grant, so the entry remembers that only a new request can reach it.
        { hostId: "host2", label: "laptop", requiresOwnConfirmation: true },
      ],
      csrfTokens: { host1: "csrf-device-1", host2: "csrf-device-2" },
    };

    it("stores one Host entry per computer and never a device token", async () => {
      const { credentialPort, registry, storage } = port();

      const outcome = await credentialPort.adoptAccountDevice(adoption);

      expect(outcome).toEqual({ ok: true, hostIds: ["host1", "host2"] });
      expect(registry.list()).toEqual([
        {
          hostId: "host1",
          label: "desk",
          deviceId: "dev_account",
          csrfToken: "csrf-device-1",
          pairedAt: "2026-09-18T10:00:00.000Z",
        },
        {
          hostId: "host2",
          label: "laptop",
          deviceId: "dev_account",
          csrfToken: "csrf-device-2",
          pairedAt: "2026-09-18T10:00:00.000Z",
          requiresOwnConfirmation: true,
        },
      ]);
      // Every Host of the account is now usable exactly like a paired one.
      expect(credentialPort.credentialFor("host1")).toEqual({ kind: "cookie", csrfToken: "csrf-device-1" });
      expect(credentialPort.credentialFor("host2")).toEqual({ kind: "cookie", csrfToken: "csrf-device-2" });
      expect(storage.getItem(HOST_REGISTRY_STORAGE_KEY)).not.toContain("pdt1.");
    });

    it("replaces the device of every Host when a device is granted again", async () => {
      const { credentialPort, registry } = port();
      await credentialPort.adoptAccountDevice(adoption);

      const second = await credentialPort.adoptAccountDevice({
        ...adoption,
        deviceId: "dev_second",
        csrfTokens: { host1: "csrf-second-1", host2: "csrf-second-2" },
      });

      expect(second).toEqual({ ok: true, hostIds: ["host1", "host2"] });
      // Asking again swaps the device out: no entry keeps the old id or CSRF
      // value, so no Host is left pointing at a device that is gone.
      expect(registry.list().map((entry) => [entry.hostId, entry.deviceId, entry.csrfToken])).toEqual([
        ["host1", "dev_second", "csrf-second-1"],
        ["host2", "dev_second", "csrf-second-2"],
      ]);
      expect(credentialPort.credentialFor("host1")).toEqual({ kind: "cookie", csrfToken: "csrf-second-1" });
    });

    it("refuses to record a Host the Gateway handed over no CSRF token for", async () => {
      const { credentialPort, registry } = port();

      const outcome = await credentialPort.adoptAccountDevice({
        ...adoption,
        csrfTokens: { host1: "csrf-device-1" },
      });

      expect(outcome.ok ? null : outcome.failure.code).toBe("STORAGE_FAILED");
      // All or nothing: a Host stored without its CSRF value would be listed
      // and unusable, which is worse than not being listed at all.
      expect(registry.list()).toEqual([]);
    });
  });
});

describe("credentialHeaders", () => {
  it("sends the CSRF token for the cookie profile", () => {
    expect(credentialHeaders({ kind: "cookie", csrfToken: "csrf-1" })).toEqual({ "x-csrf-token": "csrf-1" });
  });

  it("sends a bearer token for the header profile", () => {
    expect(credentialHeaders({ kind: "header", token: "pdt1.x" })).toEqual({ authorization: "Bearer pdt1.x" });
  });
});
