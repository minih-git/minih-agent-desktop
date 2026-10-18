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
});

describe("credentialHeaders", () => {
  it("sends the CSRF token for the cookie profile", () => {
    expect(credentialHeaders({ kind: "cookie", csrfToken: "csrf-1" })).toEqual({ "x-csrf-token": "csrf-1" });
  });

  it("sends a bearer token for the header profile", () => {
    expect(credentialHeaders({ kind: "header", token: "pdt1.x" })).toEqual({ authorization: "Bearer pdt1.x" });
  });
});
