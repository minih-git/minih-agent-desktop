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

  it("forwards the project routes a phone uses to start a session somewhere new", async () => {
    // Rollout A2 added these two routes; the Gateway derives its host-scoped
    // routes from the shared table, so this proves the wiring and the query
    // parameter rather than a hand-written copy.
    const browsed = await command(gateway, {
      hostId: host.hostId,
      token: deviceToken,
      method: "project/browse",
      params: { path: "/home/user" },
    });
    expect(browsed.status).toBe(200);
    expect(browsed.payload.result).toMatchObject({
      path: "/home/user",
      entries: [{ name: "work", path: "/home/user/work" }],
    });

    const registered = await command(gateway, {
      hostId: host.hostId,
      token: deviceToken,
      method: "project/register",
      params: { path: "/home/user/work/app" },
    });
    expect(registered.status).toBe(200);
    expect(registered.payload.result).toMatchObject({ project: { label: "app", path: "/home/user/work/app" } });
  });

  it("refuses a query parameter the route does not declare", async () => {
    const response = await command(gateway, {
      hostId: host.hostId,
      token: deviceToken,
      method: "project/browse",
      params: {},
      query: "?recursive=true",
    });
    expect(response.status).toBe(400);
    expect(response.payload.error?.data?.code).toBe("INVALID_ARGUMENT");
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
    // The exact attribute set of both cookies: a Host-scoped Path, the
    // 400-day Max-Age that keeps the pairing across a browser restart, Secure,
    // SameSite=Strict, and HttpOnly on the device cookie only.
    const deviceHeader = paired.setCookie.find((cookie) => cookie.startsWith("racp_device=")) ?? "";
    const csrfHeader = paired.setCookie.find((cookie) => cookie.startsWith("racp_csrf=")) ?? "";
    const [devicePair = ""] = deviceHeader.split(";");
    const [csrfPair = ""] = csrfHeader.split(";");
    expect(deviceHeader).toBe(`${devicePair}; Path=/hosts/${host.hostId}; Max-Age=34560000; Secure; SameSite=Strict; HttpOnly`);
    expect(csrfHeader).toBe(`${csrfPair}; Path=/hosts/${host.hostId}; Max-Age=34560000; Secure; SameSite=Strict`);

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

  it("accepts a same-origin cookie GET without Origin and refuses every other cookie request", async () => {
    const paired = await pairDevice(gateway, host, { client: "web", label: "browser", origin: "https://app.test" });
    expect(paired.status).toBe(200);
    const cookie = `racp_device=${encodeURIComponent(cookieValue(paired.setCookie, "racp_device") ?? "")}`;
    const url = `${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/sessions`;

    // A browser omits Origin on a same-origin read and marks the fetch site.
    const read = await fetch(url, { headers: { cookie, "sec-fetch-site": "same-origin" } });
    expect(read.status).toBe(200);

    for (const site of ["cross-site", "same-site", "none"]) {
      const refused = await fetch(url, { headers: { cookie, "sec-fetch-site": site } });
      expect({ site, status: refused.status }).toEqual({ site, status: 403 });
    }
    expect((await fetch(url, { headers: { cookie } })).status).toBe(403);

    // A present but disallowed Origin stays refused whatever the fetch site.
    const disallowed = await fetch(url, {
      headers: { cookie, "sec-fetch-site": "same-origin", origin: "https://evil.test" },
    });
    expect(disallowed.status).toBe(403);

    // The exemption is read-only: a mutation still needs an allowlisted Origin
    // and the CSRF header, and a missing Origin is never enough for one.
    const mutation = (headers: Record<string, string>) =>
      fetch(url, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: "c2", method: "session/create", params: { title: "no origin" } }),
      });
    const csrf = paired.csrfToken ?? "";
    expect((await mutation({ "sec-fetch-site": "same-origin", "x-csrf-token": csrf })).status).toBe(403);
    expect((await mutation({ origin: "https://app.test" })).status).toBe(403);
    expect((await mutation({ origin: "https://app.test", "x-csrf-token": csrf })).status).toBe(200);
  });

  it("opens an event stream for a same-origin cookie GET without Origin", async () => {
    const paired = await pairDevice(gateway, host, { client: "web", label: "browser", origin: "https://app.test" });
    expect(paired.status).toBe(200);
    const cookie = `racp_device=${encodeURIComponent(cookieValue(paired.setCookie, "racp_device") ?? "")}`;
    const controller = new AbortController();
    const stream = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/events`, {
      headers: { cookie, "sec-fetch-site": "same-origin", accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
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

  /**
   * The other revocation path (security gate 26): the user revoked the device
   * on that computer, so the Gateway's own record still accepts the token and
   * the refusal comes from the Host. That stays `UNAUTHORIZED` — the credential
   * really is gone — and must not be reported as the `HOST_UNAUTHORIZED` an
   * account-mode device gets when a Host has not adopted it yet (§11.5): the
   * client would then keep retrying a device that no longer exists.
   */
  it("reports a Host that refused a device revoked on that Host as UNAUTHORIZED", async () => {
    const revoked = await host.harness.store.revokeDevice(deviceId, new Date().toISOString());
    expect(revoked).toBe(true);

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

/**
 * A Capacitor iOS webview is served from `capacitor://localhost` and an
 * Android one from `https://localhost`; both call the Gateway cross-origin, so
 * they use the header profile (a bearer token on every request) and need their
 * exact origin echoed by CORS. The cookie profile is unaffected: a cross-site
 * `localhost` page never receives the `SameSite=Strict` device cookie, and the
 * Origin rule still refuses anything outside the allowlist.
 */
describe("gateway client API from a Capacitor webview origin", () => {
  const IOS_ORIGIN = "capacitor://localhost";
  const ANDROID_ORIGIN = "https://localhost";
  let gateway: TestGateway;
  let host: TestHost;

  beforeEach(async () => {
    gateway = await startTestGateway({ allowedOrigins: [IOS_ORIGIN, ANDROID_ORIGIN] });
    host = await enrollTestHost(gateway, {});
  });

  afterEach(async () => {
    await host?.stop();
    await gateway?.close();
  });

  it("pairs an iOS client through its webview origin with the token in the body and no cookie", async () => {
    const paired = await pairDevice(gateway, host, { client: "ios", label: "iPhone", origin: IOS_ORIGIN });
    expect(paired.status).toBe(200);
    expect(paired.token?.startsWith("pdt1.")).toBe(true);
    expect(paired.csrfToken).toBeUndefined();
    expect(paired.setCookie).toEqual([]);
  });

  it("pairs an Android client through https://localhost the same way", async () => {
    const paired = await pairDevice(gateway, host, { client: "android", label: "Pixel", origin: ANDROID_ORIGIN });
    expect(paired.status).toBe(200);
    expect(paired.token?.startsWith("pdt1.")).toBe(true);
    expect(paired.setCookie).toEqual([]);
  });

  it("serves a Bearer read and an event stream and echoes exactly that origin", async () => {
    const paired = await pairDevice(gateway, host, { client: "ios", label: "iPhone", origin: IOS_ORIGIN });
    const token = paired.token ?? "";
    const read = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/sessions`, {
      headers: { authorization: `Bearer ${token}`, origin: IOS_ORIGIN },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get("access-control-allow-origin")).toBe(IOS_ORIGIN);
    expect(read.headers.get("access-control-allow-credentials")).toBe("true");
    // Only the cookie profile sets a device cookie; a native read sets none.
    expect(read.headers.getSetCookie?.() ?? []).toEqual([]);

    const controller = new AbortController();
    const stream = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/events`, {
      headers: { authorization: `Bearer ${token}`, origin: IOS_ORIGIN, accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.headers.get("access-control-allow-origin")).toBe(IOS_ORIGIN);
    controller.abort();
  });

  it("allows authorization and last-event-id on the webview preflight", async () => {
    const preflight = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/events`, {
      method: "OPTIONS",
      headers: {
        origin: IOS_ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,last-event-id",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(IOS_ORIGIN);
    const allowedHeaders = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowedHeaders).toContain("authorization");
    expect(allowedHeaders).toContain("last-event-id");
  });

  it("refuses a non-allowlisted origin on the native header profile", async () => {
    const paired = await pairDevice(gateway, host, { client: "ios", label: "iPhone", origin: IOS_ORIGIN });
    const token = paired.token ?? "";
    const read = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/sessions`, {
      headers: { authorization: `Bearer ${token}`, origin: "capacitor://evil.example" },
    });
    expect(read.status).toBe(403);
    const preflight = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/sessions`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.test", "access-control-request-method": "GET" },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });
});
