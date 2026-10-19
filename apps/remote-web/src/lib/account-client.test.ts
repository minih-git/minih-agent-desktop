import { describe, expect, it } from "vitest";

import {
  ACCOUNT_ROUTES,
  accountDeviceStatusPath,
  accountLogin,
  accountLogout,
  fetchAccountDeviceStatus,
  listAccountHosts,
  probeAccountMode,
  requestAccountDevice,
} from "./account-client.js";

/**
 * The account-mode HTTP layer (protocol §11.5, rollout R7 package F).
 *
 * Everything here is about the two credential profiles and the two error
 * shapes: a browser never reads the device token from a body, a native client
 * never gets a cookie, and the Gateway's own error envelope decides what the
 * user is told.
 */

type Scripted = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

function scriptedFetch(responses: Scripted[]) {
  const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null,
    });
    const next = responses.shift();
    if (!next) throw new Error("the test scripted no further response");
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** The RACP-HTTP error envelope the Gateway sends. */
function errorBody(code: string, message: string, retriable = false): unknown {
  return { error: { code: -32000, message, data: { code, message, retriable, traceId: "t1" } } };
}

const ORIGIN = "https://gateway.example.com";

describe("probeAccountMode", () => {
  it("reads an account-mode Gateway from the credential-free probe", async () => {
    const { fetchImpl, calls } = scriptedFetch([{ status: 401, body: errorBody("UNAUTHORIZED", "needs a session") }]);
    expect(await probeAccountMode({ gatewayOrigin: ORIGIN, fetchImpl })).toBe("supported");
    expect(calls[0]!.url).toBe(`${ORIGIN}${ACCOUNT_ROUTES.hosts}`);
    expect(calls[0]!.init.method).toBe("GET");
    // No credential is sent: no Authorization header, and the browser is told
    // not to attach its session cookie either.
    expect(calls[0]!.init.headers).toEqual({ accept: "application/json" });
    expect(calls[0]!.init.credentials).toBe("omit");
  });

  it("stays supported while a live account cookie sits in the browser", async () => {
    // A session survives an abandoned device request for its whole lifetime, and
    // `AccountFlow.dispose()` deliberately does not revoke it. A probe that asks
    // the browser for the cookie is then authenticated: the Gateway answers
    // `200`, which is not one of the probe's answers, and the AccessKey entry
    // disappears until the session expires. The probe must send no credential,
    // so the same browser still reads the route's `401`.
    const calls: Array<RequestInit | undefined> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init);
      const cookieSent = init?.credentials === "include";
      return new Response(
        cookieSent ? JSON.stringify({ result: { hosts: [] } }) : JSON.stringify(errorBody("UNAUTHORIZED", "needs a session")),
        { status: cookieSent ? 200 : 401, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    expect(await probeAccountMode({ gatewayOrigin: ORIGIN, fetchImpl })).toBe("supported");
    expect(calls[0]?.credentials).not.toBe("include");
  });

  it("treats the Gateway's unknown-path answer as 'no account mode'", async () => {
    const missing = scriptedFetch([{ status: 404, body: errorBody("NOT_FOUND", "no gateway route") }]);
    expect(await probeAccountMode({ gatewayOrigin: ORIGIN, fetchImpl: missing.fetchImpl })).toBe("unsupported");
    // A refused Origin means nothing account-scoped would work from here either.
    const refused = scriptedFetch([{ status: 403, body: errorBody("FORBIDDEN", "the request Origin is not allowed") }]);
    expect(await probeAccountMode({ gatewayOrigin: ORIGIN, fetchImpl: refused.fetchImpl })).toBe("unsupported");
  });

  it("stays undecided when the Gateway cannot be reached or answers something else", async () => {
    const down = scriptedFetch([new Error("connect ECONNREFUSED")]);
    expect(await probeAccountMode({ gatewayOrigin: ORIGIN, fetchImpl: down.fetchImpl })).toBe("unknown");
    const odd = scriptedFetch([{ status: 500, body: errorBody("INTERNAL", "boom") }]);
    expect(await probeAccountMode({ gatewayOrigin: ORIGIN, fetchImpl: odd.fetchImpl })).toBe("unknown");
  });
});

describe("accountLogin", () => {
  it("signs a browser in with a CSRF credential and never a token", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { status: 200, body: { result: { accountId: "11", keyName: "account-a", expiresAt: "2026-10-18T12:00:00.000Z", csrfToken: "csrf-1" } } },
    ]);
    const result = await accountLogin({ gatewayOrigin: ORIGIN, fetchImpl, accessKey: "sk-gl-sentinel", client: "web" });

    expect(result).toEqual({
      ok: true,
      value: {
        accountId: "11",
        expiresAt: "2026-10-18T12:00:00.000Z",
        credential: { kind: "cookie", csrfToken: "csrf-1" },
      },
    });
    // The key rides the Authorization header once and nowhere else.
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-gl-sentinel");
    expect(calls[0]!.url).toBe(`${ORIGIN}${ACCOUNT_ROUTES.login}`);
    expect(calls[0]!.body).toEqual({ client: "web" });
  });

  it("signs a native client in with the body token", async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 200, body: { result: { accountId: "11", expiresAt: "2026-10-18T12:00:00.000Z", token: "rat1.session" } } },
    ]);
    const result = await accountLogin({ gatewayOrigin: ORIGIN, fetchImpl, accessKey: "sk", client: "ios", label: "phone" });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value.credential : null).toEqual({ kind: "header", token: "rat1.session" });
  });

  it("names the failure the Gateway reported", async () => {
    const denied = scriptedFetch([{ status: 401, body: errorBody("UNAUTHORIZED", "the AccessKey is not an active account key") }]);
    const refused = await accountLogin({ gatewayOrigin: ORIGIN, fetchImpl: denied.fetchImpl, accessKey: "sk", client: "ios" });
    expect(refused).toEqual({
      ok: false,
      failure: { code: "UNAUTHORIZED", message: "the AccessKey is not an active account key", retriable: false },
    });

    const unavailable = scriptedFetch([
      { status: 503, body: errorBody("ACCESS_KEY_UNAVAILABLE", "the Router could not be reached", true) },
    ]);
    const unreachable = await accountLogin({
      gatewayOrigin: ORIGIN,
      fetchImpl: unavailable.fetchImpl,
      accessKey: "sk",
      client: "ios",
    });
    expect(unreachable.ok ? null : unreachable.failure.code).toBe("ACCESS_KEY_UNAVAILABLE");
    expect(unreachable.ok ? null : unreachable.failure.retriable).toBe(true);
  });

  it("carries the Gateway's retry hint through a rate limit", async () => {
    const limited = scriptedFetch([
      { status: 429, body: errorBody("RATE_LIMITED", "retry in 7000 ms", true), headers: { "retry-after": "7" } },
    ]);
    const result = await accountLogin({ gatewayOrigin: ORIGIN, fetchImpl: limited.fetchImpl, accessKey: "sk", client: "ios" });
    expect(result.ok ? null : result.failure).toEqual({
      code: "RATE_LIMITED",
      message: "retry in 7000 ms",
      retriable: true,
      retryAfterMs: 7_000,
    });
  });

  it("refuses a session it cannot use at all", async () => {
    const empty = scriptedFetch([{ status: 200, body: { result: { accountId: "11", expiresAt: "2026-10-18T12:00:00.000Z" } } }]);
    const browser = await accountLogin({ gatewayOrigin: ORIGIN, fetchImpl: empty.fetchImpl, accessKey: "sk", client: "web" });
    expect(browser.ok ? null : browser.failure.code).toBe("INTERNAL");

    const offline = scriptedFetch([new Error("offline")]);
    const unreachable = await accountLogin({ gatewayOrigin: ORIGIN, fetchImpl: offline.fetchImpl, accessKey: "sk", client: "web" });
    expect(unreachable.ok ? null : unreachable.failure.code).toBe("INTERNAL");
  });
});

describe("account calls", () => {
  const cookieCredential = { kind: "cookie", csrfToken: "csrf-1" } as const;

  it("lists the account's Hosts and drops entries it cannot read", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        status: 200,
        body: {
          result: {
            accountId: "11",
            hosts: [{ hostId: "host1", label: "desk", online: true }, { label: "nameless" }, { hostId: "host2", online: false }],
          },
        },
      },
    ]);
    const result = await listAccountHosts({ gatewayOrigin: ORIGIN, fetchImpl, credential: cookieCredential });
    expect(result.ok ? result.value : null).toEqual({
      accountId: "11",
      hosts: [
        { hostId: "host1", label: "desk", online: true },
        { hostId: "host2", label: "host2", online: false },
      ],
    });
    // The cookie profile proves itself with the CSRF header, never a token.
    expect(calls[0]!.init.headers).toEqual({ accept: "application/json", "x-csrf-token": "csrf-1" });
    expect(calls[0]!.init.credentials).toBe("include");
  });

  it("asks for a device and reads the roster it answers with", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        status: 200,
        body: {
          result: {
            requestId: "dreq_1",
            expiresAt: "2026-10-18T00:05:00.000Z",
            hosts: [
              { hostId: "host1", label: "desk", online: true, canConfirm: true, willAcceptGrant: true },
              { hostId: "host2", label: "laptop", online: false, canConfirm: false, willAcceptGrant: false },
            ],
          },
        },
      },
    ]);
    const result = await requestAccountDevice({
      gatewayOrigin: ORIGIN,
      fetchImpl,
      credential: cookieCredential,
      deviceLabel: "iPad",
      client: "web",
    });
    expect(result.ok ? result.value.hosts.map((host) => [host.hostId, host.canConfirm, host.willAcceptGrant]) : null).toEqual([
      ["host1", true, true],
      ["host2", false, false],
    ]);
    expect(calls[0]!.body).toEqual({ deviceLabel: "iPad", client: "web" });
    expect(calls[0]!.url).toBe(`${ORIGIN}${ACCOUNT_ROUTES.devices}`);
  });

  it("reads a granted status with the browser's per-Host CSRF values", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        status: 200,
        body: {
          result: {
            requestId: "dreq_1",
            status: "granted",
            expiresAt: "2026-10-18T00:05:00.000Z",
            hosts: [{ hostId: "host1", label: "desk", online: true, canConfirm: true, willAcceptGrant: true }],
            deviceId: "dev_1",
            tokenDelivered: true,
            csrfTokens: { host1: "csrf-device", bad: 7 },
            roles: ["viewer", "controller", "approver"],
            signerHostId: "host1",
          },
        },
      },
    ]);
    const result = await fetchAccountDeviceStatus({
      gatewayOrigin: ORIGIN,
      fetchImpl,
      credential: cookieCredential,
      requestId: "dreq_1",
    });
    expect(result.ok ? result.value : null).toEqual({
      requestId: "dreq_1",
      status: "granted",
      expiresAt: "2026-10-18T00:05:00.000Z",
      hosts: [{ hostId: "host1", label: "desk", online: true, canConfirm: true, willAcceptGrant: true }],
      deviceId: "dev_1",
      tokenDelivered: true,
      csrfTokens: { host1: "csrf-device" },
      roles: ["viewer", "controller", "approver"],
      signerHostId: "host1",
    });
    // The request id is a path segment, and a browser sends no bearer token.
    expect(calls[0]!.url).toBe(`${ORIGIN}${accountDeviceStatusPath("dreq_1")}`);
    expect(calls[0]!.init.headers).toEqual({ accept: "application/json", "x-csrf-token": "csrf-1" });
  });

  it("reads a native grant as a body token, and a pending status as pending", async () => {
    const native = scriptedFetch([
      {
        status: 200,
        body: {
          result: {
            requestId: "dreq_1",
            status: "granted",
            expiresAt: "2026-10-18T00:05:00.000Z",
            hosts: [],
            deviceId: "dev_1",
            token: "pdt1.device",
            tokenDelivered: true,
          },
        },
      },
    ]);
    const granted = await fetchAccountDeviceStatus({
      gatewayOrigin: ORIGIN,
      fetchImpl: native.fetchImpl,
      credential: { kind: "header", token: "rat1.session" },
      requestId: "dreq_1",
    });
    expect(granted.ok ? granted.value.token : null).toBe("pdt1.device");
    expect(native.calls[0]!.init.headers).toEqual({ accept: "application/json", authorization: "Bearer rat1.session" });
    expect(native.calls[0]!.init.credentials).toBe("same-origin");

    const pending = scriptedFetch([
      { status: 200, body: { result: { requestId: "dreq_1", status: "pending", expiresAt: "2026-10-18T00:05:00.000Z", hosts: [] } } },
    ]);
    const waiting = await fetchAccountDeviceStatus({
      gatewayOrigin: ORIGIN,
      fetchImpl: pending.fetchImpl,
      credential: { kind: "header", token: "rat1.session" },
      requestId: "dreq_1",
    });
    expect(waiting.ok ? waiting.value.status : null).toBe("pending");
  });

  it("reports a request the Gateway no longer knows as NOT_FOUND", async () => {
    const { fetchImpl } = scriptedFetch([{ status: 404, body: errorBody("NOT_FOUND", "no such device request") }]);
    const result = await fetchAccountDeviceStatus({
      gatewayOrigin: ORIGIN,
      fetchImpl,
      credential: cookieCredential,
      requestId: "dreq_gone",
    });
    expect(result.ok ? null : result.failure.code).toBe("NOT_FOUND");
  });

  it("ends the account session and reports the revocation", async () => {
    const { fetchImpl, calls } = scriptedFetch([{ status: 200, body: { result: { accountId: "11", revoked: true } } }]);
    const result = await accountLogout({ gatewayOrigin: ORIGIN, fetchImpl, credential: cookieCredential });
    expect(result.ok ? result.value : null).toEqual({ revoked: true });
    expect(calls[0]!.url).toBe(`${ORIGIN}${ACCOUNT_ROUTES.logout}`);
    expect(calls[0]!.init.method).toBe("POST");
  });
});
