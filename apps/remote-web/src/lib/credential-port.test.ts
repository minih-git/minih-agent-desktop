import { describe, expect, it } from "vitest";

import { WebCookieCredentialPort, credentialHeaders } from "./credential-port.js";
import { HOST_REGISTRY_STORAGE_KEY, createHostRegistry, createMemoryStorage } from "./host-registry.js";

function port(storage = createMemoryStorage(), answer: Record<string, unknown> = {}) {
  const registry = createHostRegistry(storage);
  const fetchImpl = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          deviceId: "dev_1",
          hostId: "host1",
          roles: ["viewer"],
          csrfToken: "csrf-1",
          hostLabel: "minih-mbp",
          ...answer,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
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
        // The computer's name from the pairing answer, not this browser's own
        // label: the header over a conversation names the computer.
        label: "minih-mbp",
        deviceId: "dev_1",
        csrfToken: "csrf-1",
        pairedAt: "2026-09-18T10:00:00.000Z",
        // The roles the Gateway granted travel with the entry, so a screen can
        // tell a read-only device from one that may create sessions.
        roles: ["viewer"],
      },
    });
    expect(registry.get("host1")?.deviceId).toBe("dev_1");
    expect(credentialPort.credentialFor("host1")).toEqual({ kind: "cookie", csrfToken: "csrf-1" });
    expect(storage.getItem(HOST_REGISTRY_STORAGE_KEY)).not.toContain("ppt1.secret");
    expect(storage.getItem(HOST_REGISTRY_STORAGE_KEY)).not.toContain("pdt1.");
  });

  it("sends the device label but keeps the computer's name on the entry", async () => {
    const sent: unknown[] = [];
    const registry = createHostRegistry(createMemoryStorage());
    const credentialPort = new WebCookieCredentialPort({
      registry,
      fetchImpl: ((_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return Promise.resolve(
          new Response(JSON.stringify({ deviceId: "dev_1", hostId: "host1", roles: ["viewer"], csrfToken: "csrf-1", hostLabel: "minih-mbp" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }) as unknown as typeof fetch,
      userAgent: "Mozilla/5.0 (Macintosh) Safari/605.1",
      now: () => new Date("2026-09-18T10:00:00.000Z"),
    });
    await credentialPort.pair({
      gatewayOrigin: "https://gw.example.com",
      hostId: "host1",
      pairingToken: "ppt1.secret",
      deviceLabel: "  Pixel 9  ",
    });
    // The phone names itself so its owner can recognise it on the computer…
    expect(sent[0]).toMatchObject({ deviceLabel: "Pixel 9" });
    // …and the entry keeps the computer's name, which is what the bar shows.
    expect(registry.get("host1")?.label).toBe("minih-mbp");
  });

  it("falls back to the host id when the Gateway sends no computer name", async () => {
    // A Gateway older than the field answers without it; an empty bar over a
    // conversation is worse than the id the person can match in the terminal.
    const { credentialPort, registry } = port(createMemoryStorage(), { hostLabel: undefined });
    await credentialPort.pair({ gatewayOrigin: "https://gw.example.com", hostId: "host1", pairingToken: "ppt1.secret" });
    expect(registry.get("host1")?.label).toBe("host1");
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

    it("records the roles the grant carried on every Host of the account", async () => {
      const { credentialPort, registry } = port();

      // The status route's granted answer carries the roles, and an account
      // device is one principal, so every Host of the account records them.
      const outcome = await credentialPort.adoptAccountDevice({
        ...adoption,
        roles: ["viewer", "controller", "approver"],
      });

      expect(outcome).toEqual({ ok: true, hostIds: ["host1", "host2"] });
      expect(registry.list().map((entry) => entry.roles)).toEqual([
        ["viewer", "controller", "approver"],
        ["viewer", "controller", "approver"],
      ]);
    });

    it("leaves the roles off when the grant reported none", async () => {
      const { credentialPort, registry } = port();

      await credentialPort.adoptAccountDevice(adoption);

      // "Not reported" must stay distinguishable from "reported, and
      // `controller` is not one of them": an entry from an earlier build reads
      // as unknown, which offers the entry point instead of hiding it.
      expect(registry.list().every((entry) => entry.roles === undefined)).toBe(true);
    });

    it("drops blank roles instead of recording an unusable list", async () => {
      const { credentialPort, registry } = port();

      await credentialPort.adoptAccountDevice({ ...adoption, roles: ["", "viewer"] });

      expect(registry.list().map((entry) => entry.roles)).toEqual([["viewer"], ["viewer"]]);
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
