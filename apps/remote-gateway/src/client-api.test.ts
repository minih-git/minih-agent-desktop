import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sendAdminRequest } from "./admin-socket.js";
import { command, enrollTestHost, pairDevice, startTestGateway, transcriptFixture, waitFor, type TestGateway, type TestHost } from "./test-support.js";

/**
 * The Gateway client API (security §3.1, §3.7, §5.2, gates 24–26): the two
 * authentication profiles, CSRF, the Origin allowlist, URL credentials,
 * revocation, and the pairing cookie attributes.
 */

function cookieValue(setCookie: string[], name: string): string | null {
  for (const cookie of setCookie) {
    const match = new RegExp(`^${name}=([^;]+)`).exec(cookie);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

describe("gateway client API", () => {
  let gateway: TestGateway;
  let host: TestHost;
  let deviceToken: string;
  let deviceId: string;

  beforeEach(async () => {
    gateway = await startTestGateway();
    // A twelve-item transcript lets a `limit` query prove it reached the Host.
    host = await enrollTestHost(gateway, { history: { items: transcriptFixture(12) } });
    const paired = await pairDevice(gateway, host, { client: "ios", label: "phone" });
    expect(paired.status).toBe(200);
    deviceToken = paired.token ?? "";
    deviceId = paired.deviceId;
    expect(deviceToken.startsWith("pdt1.")).toBe(true);
  });

  afterEach(async () => {
    await host?.stop();
    await gateway?.close();
  });

  it("reports the paired Host as online", async () => {
    const response = await fetch(`${gateway.clientBaseUrl}/v1/hosts`, { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { hosts: Array<{ hostId: string; online: boolean; label: string }> } };
    expect(body.result.hosts).toHaveLength(1);
    expect(body.result.hosts[0]).toMatchObject({ hostId: host.hostId, online: true });
  });

  it("serves RACP commands over HTTP with a header credential", async () => {
    const listed = await command(gateway, { hostId: host.hostId, token: deviceToken, method: "session/list", params: {} });
    expect(listed.status).toBe(200);
    expect(listed.payload.result).toMatchObject({ sessions: [{ id: "s1" }] });
  });

  it("refuses a request without a credential and one with an unknown credential", async () => {
    const missing = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/sessions`);
    expect(missing.status).toBe(401);
    const unknown = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/sessions`, {
      headers: { authorization: "Bearer pdt1.unknown_fixture_token" },
    });
    expect(unknown.status).toBe(401);
    const body = (await unknown.json()) as { error: { data: { code: string } } };
    expect(body.error.data.code).toBe("UNAUTHORIZED");
  });

  it("refuses a credential in the URL or query string", async () => {
    const inQuery = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/sessions?token=${deviceToken}`);
    expect(inQuery.status).toBe(401);
    const inPath = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/sessions/${deviceToken}`);
    expect(inPath.status).toBe(401);
  });

  it("refuses a pairing token on the device API and a device token on pairing", async () => {
    const asDevice = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/sessions`, {
      headers: { authorization: "Bearer ppt1.fixture_pairing_token" },
    });
    expect(asDevice.status).toBe(401);
    const asPairing = await fetch(`${gateway.clientBaseUrl}/v1/hosts/${host.hostId}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ deviceLabel: "x", client: "ios" }),
    });
    expect(asPairing.status).toBe(401);
  });

  it("keeps the browser profile behind cookies, CSRF, and the Origin allowlist", async () => {
    const paired = await pairDevice(gateway, host, { client: "web", label: "browser", origin: "https://app.test" });
    expect(paired.status).toBe(200);
    // Browser pairing must not put the device token in the body.
    expect(paired.token).toBeUndefined();
    const deviceCookie = cookieValue(paired.setCookie, "racp_device");
    const csrfCookie = cookieValue(paired.setCookie, "racp_csrf");
    expect(deviceCookie).toMatch(/^pdt1\./);
    expect(csrfCookie).toBe(paired.csrfToken);
    const deviceHeader = paired.setCookie.find((cookie) => cookie.startsWith("racp_device=")) ?? "";
    expect(deviceHeader).toContain("HttpOnly");
    expect(deviceHeader).toContain("Secure");
    expect(deviceHeader).toContain("SameSite=Strict");
    expect(deviceHeader).toContain(`Path=/hosts/${host.hostId}`);
    const csrfHeader = paired.setCookie.find((cookie) => cookie.startsWith("racp_csrf=")) ?? "";
    expect(csrfHeader).not.toContain("HttpOnly");

    const cookieAuth = { cookie: `racp_device=${encodeURIComponent(deviceCookie ?? "")}`, origin: "https://app.test" };
    const url = `${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/sessions`;
    const read = await fetch(url, { headers: cookieAuth });
    expect(read.status).toBe(200);
    expect(read.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(read.headers.get("access-control-allow-credentials")).toBe("true");

    // A mutation without CSRF is refused; with the HMAC it succeeds.
    const create = (csrf?: string) =>
      fetch(url, {
        method: "POST",
        headers: { ...cookieAuth, "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: "c1", method: "session/create", params: { title: "from browser" } }),
      });
    expect((await create()).status).toBe(403);
    expect((await create("wrong-csrf")).status).toBe(403);
    const created = await create(paired.csrfToken);
    expect(created.status).toBe(200);

    // Cookie auth without Origin, and an Origin outside the allowlist, are refused.
    expect((await fetch(url, { headers: { cookie: cookieAuth.cookie } })).status).toBe(403);
    expect((await fetch(url, { headers: { ...cookieAuth, origin: "https://evil.test" } })).status).toBe(403);
  });

  it("never echoes a CORS origin outside the allowlist", async () => {
    const response = await fetch(`${gateway.clientBaseUrl}/healthz`, { headers: { origin: "https://evil.test" } });
    // Healthz is unauthenticated, but a cross-site caller learns nothing.
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/sessions`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.test", "access-control-request-method": "GET" },
    });
    expect(preflight.status).toBe(403);
    const allowed = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/sessions`, {
      method: "OPTIONS",
      headers: { origin: "https://app.test", "access-control-request-method": "GET" },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.test");
  });

  it("refuses a device that targets another Host", async () => {
    const other = await enrollTestHost(gateway, { hostId: "host_other" });
    try {
      const response = await fetch(`${gateway.clientBaseUrl}/hosts/${other.hostId}/v1/sessions`, {
        headers: { authorization: `Bearer ${deviceToken}` },
      });
      expect(response.status).toBe(403);
      expect(other.handle.status().state).toBe("connected");
    } finally {
      await other.stop();
    }
  });

  it("refuses an idempotency key on an operation that does not support one", async () => {
    const result = await command(gateway, {
      hostId: host.hostId,
      token: deviceToken,
      method: "session/create",
      params: { title: "once" },
      idempotencyKey: "key_fixture_1",
    });
    expect(result.status).toBe(400);
    expect(result.payload.error?.data?.code).toBe("INVALID_ARGUMENT");
  });

  it("rejects a body whose method does not match the route", async () => {
    const response = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "turn/start", params: {} }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { data: { code: string } } };
    expect(body.error.data.code).toBe("INVALID_ARGUMENT");
  });

  it("fails fast with AGENT_UNAVAILABLE while the Host is offline (no queueing)", async () => {
    await host.stop();
    await waitFor(() => !gateway.gateway.hostLinks.isOnline(host.hostId));
    const result = await command(gateway, { hostId: host.hostId, token: deviceToken, method: "session/list", params: {} });
    expect(result.status).toBe(503);
    expect(result.payload.error?.data?.code).toBe("AGENT_UNAVAILABLE");
  });

  it("revokes a device on the Gateway: 401 for new work and the open stream ends", async () => {
    const controller = new AbortController();
    const stream = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/events`, {
      headers: { authorization: `Bearer ${deviceToken}`, accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();

    const revoked = await sendAdminRequest(gateway.dataDir, { op: "devices.revoke", payload: { deviceId } });
    expect(revoked).toMatchObject({ ok: true, revoked: true });

    // The existing stream ends without the client closing it.
    const ended = await waitFor(async () => {
      const read = await Promise.race([reader!.read(), new Promise<{ done: boolean }>((resolve) => setTimeout(() => resolve({ done: false }), 4000))]);
      if (read.done) return true;
      return undefined;
    });
    expect(ended).toBe(true);
    controller.abort();

    const after = await command(gateway, { hostId: host.hostId, token: deviceToken, method: "session/list", params: {} });
    expect(after.status).toBe(401);
    expect(after.payload.error?.data?.code).toBe("UNAUTHORIZED");
  });

  it("forwards a declared GET query parameter as its declared type", async () => {
    // The Host receives `limit` as a number: the Gateway parsed the query
    // string, and the fixture transcript is long enough to prove it applied.
    const page = await command(gateway, {
      hostId: host.hostId,
      token: deviceToken,
      method: "session/history",
      params: { sessionId: "s1" },
      query: "?limit=3",
    });
    expect(page.status).toBe(200);
    expect((page.payload.result as { items: unknown[] }).items).toHaveLength(3);
  });

  it("rejects an undeclared, repeated, or mistyped GET query parameter", async () => {
    const cases: Array<{ query: string; reason: string }> = [
      { query: "?offset=3", reason: "undeclared key" },
      { query: "?limit=2&limit=3", reason: "repeated key" },
      { query: "?limit=many", reason: "non-numeric integer" },
      { query: "?limit=2.5", reason: "fractional integer" },
      { query: "?limit=1e3", reason: "exponent integer" },
      { query: "?limit=", reason: "empty integer" },
      { query: "?last-event-id=1", reason: "event cursor in the URL" },
    ];
    for (const { query, reason } of cases) {
      const response = await command(gateway, {
        hostId: host.hostId,
        token: deviceToken,
        method: "session/history",
        params: { sessionId: "s1" },
        query,
      });
      expect({ query, reason, status: response.status }).toEqual({ query, reason, status: 400 });
      expect({ query, code: response.payload.error?.data?.code }).toEqual({ query, code: "INVALID_ARGUMENT" });
    }
  });
});
