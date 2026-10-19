import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enrollTestHost, pairDevice, startTestGateway, waitForAsync, type TestGateway, type TestHost } from "./test-support.js";

/** One `Set-Cookie` value by name, for the browser profile's cases. */
function cookieValue(setCookie: string[], name: string): string | null {
  for (const cookie of setCookie) {
    const match = new RegExp(`^${name}=([^;]+)`).exec(cookie);
    if (match) return decodeURIComponent(match[1]!);
  }
  return null;
}

/**
 * `PUT` / `DELETE /v1/push/registration` (protocol §11.6, R5 PR-6).
 *
 * The route's job is to decide the audience from the *credential*, not from
 * anything the client says: a §11.4 device registers for its own Host, an
 * account-mode device for every Host of its account. Push off is an explicit
 * `enabled: false` answer rather than an error, so a client can stop asking.
 */
/**
 * A real operator-side APNs key: mode 0600 in a temporary directory, exactly
 * what `--apns-key-file` accepts. It is generated in the test process and never
 * leaves it.
 */
async function apnsKeyFile(): Promise<string> {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const dir = await mkdtemp(join(tmpdir(), "push-route-key-"));
  const path = join(dir, "apns.p8");
  await writeFile(path, pem, { mode: 0o600 });
  return path;
}

describe("push registration route", () => {
  let gateway: TestGateway;
  let host: TestHost;

  async function register(token: string, body: unknown, origin = "https://app.test") {
    const response = await fetch(`${gateway.clientBaseUrl}/v1/push/registration`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
  }

  async function unregister(token: string) {
    const response = await fetch(`${gateway.clientBaseUrl}/v1/push/registration`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, origin: "https://app.test" },
    });
    return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
  }

  let keyPath: string;

  beforeEach(async () => {
    keyPath = await apnsKeyFile();
    gateway = await startTestGateway(
      { push: { apnsKeyFile: keyPath, apnsKeyId: "KEY123", apnsTeamId: "TEAM123", apnsTopic: "app.test" } },
      // A provider that never leaves the process: the route is what is tested.
      { pushProviders: { apns: { send: async () => ({ ok: true }) } } },
    );
    host = await enrollTestHost(gateway);
  });

  afterEach(async () => {
    await host?.stop();
    await gateway?.close();
  });

  it("registers a §11.4 device for its own Host only", async () => {
    const paired = await pairDevice(gateway, host, { client: "ios" });
    const answer = await register(paired.token!, { platform: "ios", token: "apns-token-1" });

    expect(answer.status).toBe(200);
    expect(answer.payload["result"]).toEqual({ enabled: true, platform: "ios", hostIds: [host.hostId] });
    const stored = gateway.gateway.store.findPushRegistration(paired.deviceId);
    expect(stored).toMatchObject({ hostId: host.hostId, hostIds: [host.hostId], platform: "ios", token: "apns-token-1" });
    expect(stored?.accountId).toBeUndefined();
  });

  it("never echoes the provider token back", async () => {
    const paired = await pairDevice(gateway, host, { client: "ios" });
    const answer = await register(paired.token!, { platform: "ios", token: "apns-token-secret" });
    expect(JSON.stringify(answer.payload)).not.toContain("apns-token-secret");
    expect(await unregister(paired.token!)).toMatchObject({ status: 200 });
    expect(gateway.gateway.store.findPushRegistration(paired.deviceId)).toBeNull();
  });

  it("answers enabled:false and stores nothing when push is not configured", async () => {
    const plain = await startTestGateway();
    try {
      const plainHost = await enrollTestHost(plain, { hostId: "host_plain" });
      const paired = await pairDevice(plain, plainHost, { client: "ios" });
      const response = await fetch(`${plain.clientBaseUrl}/v1/push/registration`, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${paired.token}`, origin: "https://app.test" },
        body: JSON.stringify({ platform: "ios", token: "apns-token-1" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result: { enabled: false, platform: "ios", hostIds: [] } });
      expect(plain.gateway.store.findPushRegistration(paired.deviceId)).toBeNull();
      await plainHost.stop();
    } finally {
      await plain.close();
    }
  });

  it("refuses a platform this Gateway has no provider for", async () => {
    const paired = await pairDevice(gateway, host, { client: "ios" });
    const answer = await register(paired.token!, { platform: "android", token: "fcm-token-1" });
    // The Gateway is configured for APNs only; storing an FCM token would be a
    // registration nothing can ever deliver to.
    expect(answer.status).toBe(501);
    expect((answer.payload["error"] as { data: { code: string } }).data.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(gateway.gateway.store.findPushRegistration(paired.deviceId)).toBeNull();
  });

  it("replaces the token of a device that registers again", async () => {
    const paired = await pairDevice(gateway, host, { client: "ios" });
    await register(paired.token!, { platform: "ios", token: "apns-token-1" });
    await register(paired.token!, { platform: "ios", token: "apns-token-2" });
    const stored = gateway.gateway.store.findPushRegistration(paired.deviceId);
    expect(stored?.token).toBe("apns-token-2");
    expect(gateway.gateway.store.listPushRegistrations()).toHaveLength(1);
  });

  it("rejects a malformed body, an empty token, and a non-device credential", async () => {
    const paired = await pairDevice(gateway, host, { client: "ios" });
    expect((await register(paired.token!, { platform: "ios", token: "" })).status).toBe(400);
    expect((await register(paired.token!, { platform: "web", token: "x" })).status).toBe(400);
    expect((await register(paired.token!, { token: "x" })).status).toBe(400);

    const noCredential = await fetch(`${gateway.clientBaseUrl}/v1/push/registration`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "https://app.test" },
      body: JSON.stringify({ platform: "ios", token: "x" }),
    });
    expect(noCredential.status).toBe(401);
  });

  it("drops the registration when the Gateway revokes the device", async () => {
    const paired = await pairDevice(gateway, host, { client: "ios" });
    await register(paired.token!, { platform: "ios", token: "apns-token-1" });
    expect(gateway.gateway.store.findPushRegistration(paired.deviceId)).not.toBeNull();

    await gateway.gateway.store.revokeDevice(paired.deviceId, new Date().toISOString());
    expect(gateway.gateway.store.findPushRegistration(paired.deviceId)).toBeNull();
  });

  it("refuses a registration whose device was revoked while the body was being read", async () => {
    const paired = await pairDevice(gateway, host, { client: "ios" });
    // The real race: the request authenticates, and the revocation lands while
    // its body is still being read. The route must reach the write and be
    // refused there — an `authenticate()` refusal would prove nothing about the
    // in-write re-check, which is what stops the registration coming back.
    const original = gateway.gateway.store.savePushRegistration.bind(gateway.gateway.store);
    let reached = false;
    gateway.gateway.store.savePushRegistration = async (record) => {
      reached = true;
      await gateway.gateway.store.revokeDevice(record.deviceId, new Date().toISOString());
      return original(record);
    };
    try {
      const answer = await register(paired.token!, { platform: "ios", token: "apns-token-1" });
      expect(reached, "the route never reached the write").toBe(true);
      expect(answer.status).toBe(401);
      expect((answer.payload["error"] as { data: { code: string } }).data.code).toBe("UNAUTHORIZED");
      expect(gateway.gateway.store.findPushRegistration(paired.deviceId)).toBeNull();
    } finally {
      gateway.gateway.store.savePushRegistration = original;
    }
  });

  it("writes nothing for a device the store rejects, and says UNAUTHORIZED", async () => {
    const paired = await pairDevice(gateway, host, { client: "ios" });
    // The store's own guard, exercised directly: a device that exists but was
    // revoked is refused, and so is one that never existed.
    await gateway.gateway.store.revokeDevice(paired.deviceId, new Date().toISOString());
    const revoked = await gateway.gateway.store.savePushRegistration({
      deviceId: paired.deviceId,
      hostId: host.hostId,
      hostIds: [host.hostId],
      platform: "ios",
      token: "token",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(revoked).toBe(false);
    expect(gateway.gateway.store.findPushRegistration(paired.deviceId)).toBeNull();
    const saved = await gateway.gateway.store.savePushRegistration({
      deviceId: "dev_unknown",
      hostId: host.hostId,
      hostIds: [host.hostId],
      platform: "ios",
      token: "token",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(saved).toBe(false);
    expect(gateway.gateway.store.findPushRegistration("dev_unknown")).toBeNull();
  });

  it("marks its answers no-store: they name a credential-bearing device", async () => {
    const paired = await pairDevice(gateway, host, { client: "ios" });
    const response = await fetch(`${gateway.clientBaseUrl}/v1/push/registration`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${paired.token}`, origin: "https://app.test" },
      body: JSON.stringify({ platform: "ios", token: "apns-token-1" }),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const removed = await fetch(`${gateway.clientBaseUrl}/v1/push/registration`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${paired.token}`, origin: "https://app.test" },
    });
    expect(removed.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the browser profile behind its cookie, CSRF token, and the Origin allowlist", async () => {
    const paired = await pairDevice(gateway, host, { client: "web", label: "browser", origin: "https://app.test" });
    expect(paired.status).toBe(200);
    // The browser profile has no bearer token: the route must work from the
    // cookie, and refuse a mutation that carries no CSRF value.
    expect(paired.token).toBeUndefined();
    const cookie = `racp_device=${encodeURIComponent(cookieValue(paired.setCookie, "racp_device") ?? "")}`;
    // The device cookie is scoped to the Host's path, so the route is reached
    // through that prefix in a browser — which is why the test uses it here.
    const url = `${gateway.clientBaseUrl}/v1/push/registration`;
    const put = (headers: Record<string, string>) =>
      fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ platform: "ios", token: "apns-token-1" }),
      });

    expect((await put({ cookie, origin: "https://app.test" })).status).toBe(403);
    expect((await put({ cookie, origin: "https://app.test", "x-csrf-token": "wrong" })).status).toBe(403);
    // Cookie auth without Origin, and an Origin outside the allowlist, are refused.
    expect((await put({ cookie, "x-csrf-token": paired.csrfToken! })).status).toBe(403);
    expect((await put({ cookie, origin: "https://evil.test", "x-csrf-token": paired.csrfToken! })).status).toBe(403);

    const accepted = await put({ cookie, origin: "https://app.test", "x-csrf-token": paired.csrfToken! });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ result: { enabled: true, platform: "ios", hostIds: [host.hostId] } });
    expect(gateway.gateway.store.findPushRegistration(paired.deviceId)?.token).toBe("apns-token-1");
  });

  it("keeps the registration across a Gateway restart", async () => {
    const paired = await pairDevice(gateway, host, { client: "ios" });
    await register(paired.token!, { platform: "ios", token: "apns-token-1" });
    const reopened = await (await import("./store.js")).GatewayStore.open(gateway.dataDir);
    await waitForAsync(async () => reopened.findPushRegistration(paired.deviceId) !== null, "the reloaded registration");
    expect(reopened.findPushRegistration(paired.deviceId)?.token).toBe("apns-token-1");
    await reopened.flush();
  });
});
