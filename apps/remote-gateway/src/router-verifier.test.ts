import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ROUTER_REFUSAL, routerSessionAnswer, startRouterStub, type TestRouterStub } from "./test-support.js";
import { RouterAccountVerifier, resolveRouterUrl } from "./router-verifier.js";

/**
 * Router AccessKey verification (ADR decisions 4 and 5, protocol §11.5, gates
 * 30 and 31). The Router is always a local stub: no real Router, AccessKey, or
 * domain is used, and the stub mimics the documented `{ code, message, data }`
 * envelope of `internal/platform/response`.
 */
describe("router verifier", () => {
  const SENTINEL_KEY = "sk-gl-sentinel-account-key-0001";
  let stub: TestRouterStub | null = null;
  let hanging: ReturnType<typeof createServer> | null = null;
  let stalled: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    await stub?.stop();
    stub = null;
    if (hanging) {
      hanging.closeAllConnections?.();
      await new Promise<void>((resolve) => hanging?.close(() => resolve()));
      hanging = null;
    }
    if (stalled) {
      stalled.closeAllConnections?.();
      await new Promise<void>((resolve) => stalled?.close(() => resolve()));
      stalled = null;
    }
  });

  function verifier(stubBaseUrl: string, timeoutMs = 2_000): RouterAccountVerifier {
    return new RouterAccountVerifier({ baseUrl: stubBaseUrl, clientIpHeader: "x-real-ip", timeoutMs });
  }

  it("resolves an active AccessKey to its account id and key name", async () => {
    stub = await startRouterStub();
    stub.setAnswer(SENTINEL_KEY, routerSessionAnswer({ access_key_id: 7, key_name: "laptop", status: "active" }));
    const verdict = await verifier(stub.baseUrl).verify(SENTINEL_KEY, "203.0.113.9");
    expect(verdict).toEqual({ ok: true, accountId: "7", keyName: "laptop" });
  });

  it("sends the key in the Authorization header and the caller address in the configured header", async () => {
    stub = await startRouterStub();
    stub.setAnswer(SENTINEL_KEY, routerSessionAnswer({ access_key_id: 7 }));
    await verifier(stub.baseUrl).verify(SENTINEL_KEY, "203.0.113.9");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.path).toBe("/api/auth/session");
    expect(stub.calls[0]?.headers["authorization"]).toBe(`Bearer ${SENTINEL_KEY}`);
    // Gate 31: the Router evaluates `allowed_peer_cidrs` against the real caller.
    expect(stub.calls[0]?.headers["x-real-ip"]).toBe("203.0.113.9");
  });

  it("never returns, echoes, or embeds the key in a verdict", async () => {
    stub = await startRouterStub();
    stub.setAnswer(SENTINEL_KEY, routerSessionAnswer({ access_key_id: 7 }));
    const accepted = await verifier(stub.baseUrl).verify(SENTINEL_KEY, "203.0.113.9");
    const refused = await verifier(stub.baseUrl).verify(`${SENTINEL_KEY}-wrong`, "203.0.113.9");
    expect(JSON.stringify(accepted)).not.toContain(SENTINEL_KEY);
    expect(JSON.stringify(refused)).not.toContain(SENTINEL_KEY);
  });

  it("refuses an answer that is not an active AccessKey", async () => {
    stub = await startRouterStub();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["an unknown key", {}],
      ["an unauthenticated answer", { authenticated: false }],
      ["an admin principal", { principal_type: "admin" }],
      ["a missing account id", { access_key_id: undefined }],
      ["a zero account id", { access_key_id: 0 }],
      ["a non-numeric account id", { access_key_id: "7" }],
    ];
    for (const [label, data] of cases) {
      stub.setAnswer(SENTINEL_KEY, { status: 200, body: { code: 0, message: "common.success", data } });
      expect(await verifier(stub.baseUrl).verify(SENTINEL_KEY, "203.0.113.9"), label).toEqual({ ok: false, reason: "refused" });
    }
  });

  it("treats the Router's own error envelope as a refusal", async () => {
    stub = await startRouterStub();
    // The stub answers this key with the default `{ code: "UNAUTHORIZED" }`.
    expect(await verifier(stub.baseUrl).verify(SENTINEL_KEY, "203.0.113.9")).toEqual({ ok: false, reason: "refused" });
  });

  /**
   * `ErrAuthLocked` is what the Router answers after too many failed
   * authentications from one address: 429, `Retry-After`, and
   * `{ code: "AUTH_LOCKED", data: { retry_after_seconds } }`
   * (`internal/control/auth.go`, `internal/platform/errors/errors.go`).
   * Reading it as an invalid key would send the user to replace a working
   * AccessKey and would drop the retry hint.
   */
  it("reports the Router's lockout as retriable with the Router's own hint", async () => {
    stub = await startRouterStub();
    stub.setAnswer(SENTINEL_KEY, {
      status: 429,
      body: { code: "AUTH_LOCKED", message: "auth.locked", data: { retry_after_seconds: 30 } },
      headers: { "retry-after": "30" },
    });
    expect(await verifier(stub.baseUrl).verify(SENTINEL_KEY, "203.0.113.9")).toEqual({
      ok: false,
      reason: "rate_limited",
      retryAfterMs: 30_000,
    });

    // The header is the fallback when the body carries no hint.
    stub.setAnswer(SENTINEL_KEY, {
      status: 429,
      body: { code: "AUTH_LOCKED", message: "auth.locked" },
      headers: { "retry-after": "12" },
    });
    expect(await verifier(stub.baseUrl).verify(SENTINEL_KEY, "203.0.113.9")).toEqual({
      ok: false,
      reason: "rate_limited",
      retryAfterMs: 12_000,
    });

    // With neither hint it is still a retriable lockout, never a bad key.
    stub.setAnswer(SENTINEL_KEY, { status: 429, body: { code: "AUTH_LOCKED", message: "auth.locked" } });
    expect(await verifier(stub.baseUrl).verify(SENTINEL_KEY, "203.0.113.9")).toEqual({ ok: false, reason: "rate_limited" });

    // A lockout code on a 200 answer stays a lockout: a proxy may rewrite the
    // status, and the code is the Router's own signal.
    stub.setAnswer(SENTINEL_KEY, {
      status: 200,
      body: { code: "AUTH_LOCKED", message: "auth.locked", data: { retry_after_seconds: 5 } },
    });
    expect(await verifier(stub.baseUrl).verify(SENTINEL_KEY, "203.0.113.9")).toEqual({
      ok: false,
      reason: "rate_limited",
      retryAfterMs: 5_000,
    });
  });

  it("reports an unreadable or unhealthy Router as retriable, never as a pass", async () => {
    stub = await startRouterStub();
    stub.setAnswer(SENTINEL_KEY, { status: 503, body: { code: "INTERNAL", message: "unavailable" } });
    expect(await verifier(stub.baseUrl).verify(SENTINEL_KEY, "203.0.113.9")).toEqual({ ok: false, reason: "unavailable" });

    stub.setAnswer(SENTINEL_KEY, { status: 200, body: "not an envelope" });
    expect(await verifier(stub.baseUrl).verify(SENTINEL_KEY, "203.0.113.9")).toEqual({ ok: false, reason: "unavailable" });

    // A Router that accepts the connection but never answers must not hang the
    // enrollment; the bounded timeout turns it into the same retriable error.
    hanging = createServer(() => undefined);
    await new Promise<void>((resolve) => hanging?.listen(0, "127.0.0.1", () => resolve()));
    const port = (hanging.address() as AddressInfo).port;
    expect(await verifier(`http://127.0.0.1:${port}`, 50).verify(SENTINEL_KEY, "203.0.113.9")).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("bounds a Router that answers headers and then stalls its body", async () => {
    // The deadline has to cover the body read too: otherwise a control plane
    // that sends headers and then stops would hold a login or an enrollment
    // open for as long as the transport allows.
    stalled = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"code":0,"data":');
    });
    await new Promise<void>((resolve) => stalled?.listen(0, "127.0.0.1", () => resolve()));
    const port = (stalled.address() as AddressInfo).port;
    const started = Date.now();
    expect(await verifier(`http://127.0.0.1:${port}`, 50).verify(SENTINEL_KEY, "203.0.113.9")).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reports a closed port as retriable", async () => {
    stub = await startRouterStub();
    const baseUrl = stub.baseUrl;
    await stub.stop();
    stub = null;
    expect(await verifier(baseUrl).verify(SENTINEL_KEY, "203.0.113.9")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("keeps the Router's refusal shape out of the verdict", () => {
    // The stub's own default answer is the Router's envelope; nothing about it
    // leaks into what the Gateway reports.
    expect(JSON.stringify(ROUTER_REFUSAL)).toContain("UNAUTHORIZED");
  });
});

describe("--router-url validation", () => {
  it("accepts a loopback URL and normalizes it", () => {
    expect(resolveRouterUrl("http://127.0.0.1:3001")).toBe("http://127.0.0.1:3001");
    expect(resolveRouterUrl("http://127.0.0.1:3001/")).toBe("http://127.0.0.1:3001");
    expect(resolveRouterUrl("http://localhost:3001/router/")).toBe("http://localhost:3001/router");
    expect(resolveRouterUrl("https://[::1]:3001")).toBe("https://[::1]:3001");
  });

  it("refuses a URL that would send the AccessKey off this machine", () => {
    expect(() => resolveRouterUrl("http://router.example.com:3001")).toThrow(/not loopback/);
    expect(() => resolveRouterUrl("http://10.0.0.5:3001")).toThrow(/not loopback/);
    expect(() => resolveRouterUrl("http://user:secret@127.0.0.1:3001")).toThrow(/credentials/);
    expect(() => resolveRouterUrl("http://127.0.0.1:3001/?key=1")).toThrow(/query string/);
    expect(() => resolveRouterUrl("http://127.0.0.1:3001/#frag")).toThrow(/query string/);
    expect(() => resolveRouterUrl("ftp://127.0.0.1:3001")).toThrow(/http or https/);
    expect(() => resolveRouterUrl("not a url")).toThrow(/not a URL/);
  });
});
