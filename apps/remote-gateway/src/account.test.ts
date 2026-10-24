import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHostCsr, readCertificateAccountBinding } from "@minih-agent/racp";
import { afterEach, describe, expect, it } from "vitest";

import { sendAdminRequest } from "./admin-socket.js";
import type { GatewayLog } from "./router.js";
import { GatewayStore } from "./store.js";
import {
  ROUTER_REFUSAL,
  accountHosts,
  accountLogin,
  enrollTestHost,
  enrollTestHostByKey,
  hostCsrFor,
  postEnrollment,
  routerSessionAnswer,
  startRouterStub,
  startTestGateway,
  type TestGateway,
  type TestHost,
  type TestRouterStub,
} from "./test-support.js";

/**
 * The Gateway account directory (protocol §11.5, security §3.8, D666). These
 * tests are the integration leg of
 * `E2E-REMOTE-ACCOUNT-cross-account-isolation` steps 1–4 and 6 against a stubbed
 * Router: no real Router, AccessKey, or domain is used.
 *
 * Step 5 of that scenario (a grant signed by another account's Host) belongs to
 * package D, which defines the frames; the Host-side half is asserted here only
 * as "the Gateway never hands a foreign Host to a client".
 */

const KEY_A = "sk-gl-sentinel-account-a";
const KEY_B = "sk-gl-sentinel-account-b";
const ROTATED_KEY_A = "sk-gl-sentinel-account-a-rotated";
const ACCOUNT_A = 11;
const ACCOUNT_B = 22;

function cookieValue(setCookie: string[], name: string): string | null {
  for (const cookie of setCookie) {
    const match = new RegExp(`^${name}=([^;]+)`).exec(cookie);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

/** Every byte the Gateway wrote under `--data-dir`, plus the captured log lines. */
async function dataDirContents(gateway: TestGateway): Promise<string> {
  const walk = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const parts: string[] = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) parts.push(await walk(path));
      // `admin.sock` is a socket, not a file the Gateway wrote text into.
      else if (entry.isFile()) parts.push(await readFile(path, "utf8"));
    }
    return parts;
  };
  return (await walk(gateway.dataDir)).join("\n");
}

type Stack = {
  stub: TestRouterStub;
  gateway: TestGateway;
  hostA: TestHost;
  hostB: TestHost;
  logs: string[];
};

type BareStack = { stub: TestRouterStub; gateway: TestGateway; logs: string[] };

describe("account mode", () => {
  let stack: Stack | null = null;
  let bare: BareStack | null = null;

  /** Account mode on, with no Host enrolled yet. */
  async function startBareStack(
    overrides: Parameters<typeof startTestGateway>[0] = {},
    startOptions: Parameters<typeof startTestGateway>[1] = {},
  ): Promise<BareStack> {
    const logs: string[] = [];
    const log: GatewayLog = (level, message, data) => {
      logs.push(JSON.stringify({ level, message, ...(data ? { data } : {}) }));
    };
    const stub = await startRouterStub();
    stub.setAnswer(KEY_A, routerSessionAnswer({ access_key_id: ACCOUNT_A, key_name: "account-a" }));
    stub.setAnswer(KEY_B, routerSessionAnswer({ access_key_id: ACCOUNT_B, key_name: "account-b" }));
    const gateway = await startTestGateway(
      { router: { baseUrl: stub.baseUrl, clientIpHeader: "x-real-ip" }, ...overrides },
      { log, ...startOptions },
    );
    return { stub, gateway, logs };
  }

  async function startStack(
    overrides: Parameters<typeof startTestGateway>[0] = {},
    startOptions: Parameters<typeof startTestGateway>[1] = {},
  ): Promise<Stack> {
    const started = await startBareStack(overrides, startOptions);
    const { gateway } = started;
    // E2E step 1: one enrolled Host per account, each recorded under its key.
    const hostA = await enrollTestHostByKey(gateway, { hostId: "host_a1", accessKey: KEY_A, label: "desk A" });
    const hostB = await enrollTestHostByKey(gateway, { hostId: "host_b1", accessKey: KEY_B, label: "desk B" });
    return { ...started, hostA, hostB };
  }

  afterEach(async () => {
    await stack?.hostA.stop();
    await stack?.hostB.stop();
    await stack?.gateway.close();
    await stack?.stub.stop();
    stack = null;
    await bare?.gateway.close();
    await bare?.stub.stop();
    bare = null;
  });

  it("enrolls a Host under the verified account and binds it in the certificate", async () => {
    stack = await startStack();
    const { gateway, stub } = stack;
    expect(gateway.gateway.store.findHost("host_a1")?.accountId).toBe(String(ACCOUNT_A));
    expect(gateway.gateway.store.findHost("host_b1")?.accountId).toBe(String(ACCOUNT_B));
    expect(readCertificateAccountBinding(stack.hostA.certificatePem)).toBe(String(ACCOUNT_A));
    expect(readCertificateAccountBinding(stack.hostB.certificatePem)).toBe(String(ACCOUNT_B));
    expect(stack.hostA.handle.status().state).toBe("connected");
    expect(stack.hostB.handle.status().state).toBe("connected");
    // The enrollment forwards the Host link's TCP peer: that port is reached
    // directly over the overlay, so there is no proxy header to trust there.
    expect(stub.calls.map((call) => call.headers["x-real-ip"])).toEqual(["127.0.0.1", "127.0.0.1"]);
  });

  it("logs a client in with a key and lists only that account's Hosts", async () => {
    stack = await startStack();
    const { gateway } = stack;
    const login = await accountLogin(gateway, { accessKey: KEY_A, client: "ios", label: "phone" });
    expect(login.status).toBe(200);
    const result = login.payload["result"] as { accountId: string; keyName?: string; token?: string };
    expect(result.accountId).toBe(String(ACCOUNT_A));
    expect(result.keyName).toBe("account-a");
    expect(result.token?.startsWith("rat1.")).toBe(true);

    const listing = await accountHosts(gateway, { authorization: `Bearer ${result.token ?? ""}` });
    expect(listing.status).toBe(200);
    const body = listing.payload["result"] as { accountId: string; hosts: Array<{ hostId: string; online: boolean }> };
    expect(body.accountId).toBe(String(ACCOUNT_A));
    expect(body.hosts.map((host) => host.hostId)).toEqual(["host_a1"]);
    expect(body.hosts[0]?.online).toBe(true);
    // Gate 29: the other account's Host is not listed, and not even hinted at.
    expect(JSON.stringify(listing.payload)).not.toContain("host_b1");

    // A client of account B sees its own Host and not account A's.
    const other = await accountLogin(gateway, { accessKey: KEY_B, client: "android" });
    const otherListing = await accountHosts(gateway, {
      authorization: `Bearer ${(other.payload["result"] as { token: string }).token}`,
    });
    expect((otherListing.payload["result"] as { hosts: Array<{ hostId: string }> }).hosts.map((host) => host.hostId)).toEqual([
      "host_b1",
    ]);
  });

  it("refuses a foreign Host on every account-scoped path, without revealing existence", async () => {
    stack = await startStack();
    const { gateway } = stack;
    const token = (await accountLogin(gateway, { accessKey: KEY_A, client: "ios" })).payload["result"] as { token: string };

    // A Host-scoped route keeps accepting device tokens only, so an account
    // session is refused before any logical connection is opened — and a Host
    // that does not exist answers exactly the same way.
    const foreign = await fetch(`${gateway.clientBaseUrl}/hosts/host_b1/v1/sessions`, {
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(foreign.status).toBe(401);
    const missing = await fetch(`${gateway.clientBaseUrl}/hosts/host_nope/v1/sessions`, {
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(missing.status).toBe(401);
    // The two answers are indistinguishable apart from their trace id, so a
    // caller cannot tell an existing foreign Host from a nonexistent one.
    const shape = async (response: Response) => {
      const body = (await response.json()) as { error: { message: string; data: { code: string; retriable: boolean } } };
      return { message: body.error.message, code: body.error.data.code, retriable: body.error.data.retriable };
    };
    expect(await shape(foreign)).toEqual(await shape(missing));

    // The refusal is a pre-routing one: the audit record carries no Host, which
    // is what a routed operation would have produced.
    const day = new Date().toISOString().slice(0, 10);
    const denied = (await gateway.gateway.store.audit.read(day)).filter((record) => record.result === "denied");
    expect(denied.length).toBeGreaterThan(0);
    expect(denied.every((record) => record.op === "request")).toBe(true);

    // A device token cannot stand in for an account session either.
    const asAccount = await accountHosts(gateway, { authorization: "Bearer pdt1.fixture" });
    expect(asAccount.status).toBe(401);
  });

  it("never joins or replaces a Host of another account", async () => {
    stack = await startStack();
    const { gateway, hostA } = stack;
    const fingerprint = gateway.gateway.store.findHost("host_a1")?.certificateFingerprint256;
    const keys = await hostCsrFor("host_a1");

    // E2E step 4: key B names A1's hostId.
    const attack = await postEnrollment(gateway, {
      body: { hostId: "host_a1", csr: keys.csr },
      accessKey: KEY_B,
    });
    expect(attack.status).toBe(403);
    expect(attack.payload).toMatchObject({ error: { code: "HOST_ACCOUNT_MISMATCH" } });
    expect(gateway.gateway.store.findHost("host_a1")?.accountId).toBe(String(ACCOUNT_A));
    expect(gateway.gateway.store.findHost("host_a1")?.certificateFingerprint256).toBe(fingerprint);
    expect(hostA.handle.status().state).toBe("connected");

    // An operator-issued enrollment code cannot strip the binding either.
    const { code } = await gateway.gateway.enrollment.issueCode({ label: "operator" });
    const byCode = await postEnrollment(gateway, { body: { enrollmentCode: code, hostId: "host_a1", csr: keys.csr } });
    expect(byCode.status).toBe(403);
    expect(byCode.payload).toMatchObject({ error: { code: "HOST_ACCOUNT_MISMATCH" } });
    expect(gateway.gateway.store.findHost("host_a1")?.accountId).toBe(String(ACCOUNT_A));
  });

  it("never persists the AccessKey in the data directory, the audit log, or a log line", async () => {
    stack = await startStack();
    const { gateway, logs } = stack;
    const sessionA = (await accountLogin(gateway, { accessKey: KEY_A, client: "ios" })).payload["result"] as { token: string };
    await accountLogin(gateway, { accessKey: KEY_B, client: "web", origin: "https://app.test" });
    await gateway.gateway.store.flush();

    const files = await dataDirContents(gateway);
    expect(files).not.toContain(KEY_A);
    expect(files).not.toContain(KEY_B);
    // The account id is durable state; the key and the session credential are
    // not (gate 30). Only the session's hash reaches `account-sessions.json`.
    expect(files).toContain('"accountId": "11"');
    expect(files).toContain('"accountId": "22"');
    expect(files).not.toContain(sessionA.token);
    expect(files).toContain('"tokenHash"');
    expect(logs.join("\n")).not.toContain(KEY_A);
    expect(logs.join("\n")).not.toContain(KEY_B);
    expect(logs.join("\n")).not.toContain(sessionA.token);

    const day = new Date().toISOString().slice(0, 10);
    const audit = JSON.stringify(await gateway.gateway.store.audit.read(day));
    expect(audit).not.toContain(KEY_A);
    expect(audit).toContain('"accountId":"11"');
    expect(audit).toContain("account.login");
  });

  it("treats an unreachable Router as a retriable error, never as a pass", async () => {
    stack = await startStack();
    const { gateway, stub } = stack;
    await stub.stop();

    const login = await accountLogin(gateway, { accessKey: KEY_A, client: "ios" });
    expect(login.status).toBe(503);
    expect(login.payload).toMatchObject({ error: { data: { code: "AGENT_UNAVAILABLE", retriable: true } } });
    expect(gateway.gateway.store.listAccountSessions(String(ACCOUNT_A))).toHaveLength(0);

    const keys = await hostCsrFor("host_c1");
    const enroll = await postEnrollment(gateway, { body: { hostId: "host_c1", csr: keys.csr }, accessKey: KEY_A });
    expect(enroll.status).toBe(503);
    expect(enroll.payload).toMatchObject({ error: { code: "ACCESS_KEY_UNAVAILABLE", retriable: true } });
    expect(gateway.gateway.store.findHost("host_c1")).toBeNull();
  });

  it("blocks new logins and enrollments for a disabled key but revokes nothing", async () => {
    stack = await startStack();
    const { gateway, stub, hostA } = stack;
    const session = (await accountLogin(gateway, { accessKey: KEY_A, client: "ios" })).payload["result"] as { token: string };

    // The Router stops authenticating the key, exactly as it does for a
    // disabled or deleted one (only active keys are indexed).
    stub.setAnswer(KEY_A, ROUTER_REFUSAL);
    expect((await accountLogin(gateway, { accessKey: KEY_A, client: "ios" })).status).toBe(401);

    const keys = await hostCsrFor("host_c1");
    const enroll = await postEnrollment(gateway, { body: { hostId: "host_c1", csr: keys.csr }, accessKey: KEY_A });
    expect(enroll.status).toBe(401);
    expect(enroll.payload).toMatchObject({ error: { code: "ACCESS_KEY_INVALID" } });
    expect(gateway.gateway.store.findHost("host_c1")).toBeNull();

    // ADR decision 8: key state revokes nothing by itself.
    expect(gateway.gateway.store.findHost("host_a1")?.accountId).toBe(String(ACCOUNT_A));
    expect(gateway.gateway.store.findHost("host_a1")?.revokedAt).toBeUndefined();
    expect(hostA.handle.status().state).toBe("connected");
    const stillValid = await accountHosts(gateway, { authorization: `Bearer ${session.token}` });
    expect(stillValid.status).toBe(200);
  });

  it("keeps the account across key rotation", async () => {
    stack = await startStack();
    const { gateway, stub, hostA } = stack;
    const fingerprint = gateway.gateway.store.findHost("host_a1")?.certificateFingerprint256;
    stub.setAnswer(ROTATED_KEY_A, routerSessionAnswer({ access_key_id: ACCOUNT_A, key_name: "account-a-rotated" }));

    const login = await accountLogin(gateway, { accessKey: ROTATED_KEY_A, client: "ios" });
    expect((login.payload["result"] as { accountId: string }).accountId).toBe(String(ACCOUNT_A));

    const rotated = await enrollTestHostByKey(gateway, { hostId: "host_a2", accessKey: ROTATED_KEY_A });
    expect(gateway.gateway.store.findHost("host_a2")?.accountId).toBe(String(ACCOUNT_A));
    // An already enrolled Host keeps its record, its certificate, and its link.
    expect(gateway.gateway.store.findHost("host_a1")?.certificateFingerprint256).toBe(fingerprint);
    expect(hostA.handle.status().state).toBe("connected");
    await rotated.stop();
  });

  it("serves the browser profile behind cookies, CSRF, and the Origin allowlist", async () => {
    stack = await startStack();
    const { gateway } = stack;
    // A browser login must prove an allowlisted Origin before the key is used.
    expect((await accountLogin(gateway, { accessKey: KEY_A, client: "web" })).status).toBe(403);

    const login = await accountLogin(gateway, { accessKey: KEY_A, client: "web", origin: "https://app.test" });
    expect(login.status).toBe(200);
    const result = login.payload["result"] as { csrfToken?: string; token?: string; accountId: string };
    // A browser must never read the session credential from the body.
    expect(result.token).toBeUndefined();
    expect(result.csrfToken).toBe(cookieValue(login.setCookie, "racp_account_csrf"));
    const sessionCookie = cookieValue(login.setCookie, "racp_account");
    expect(sessionCookie?.startsWith("rat1.")).toBe(true);
    const cookie = `racp_account=${encodeURIComponent(sessionCookie ?? "")}`;
    expect(login.setCookie.find((value) => value.startsWith("racp_account="))).toMatch(
      /; Path=\/; Max-Age=43200; Secure; SameSite=Strict; HttpOnly$/,
    );

    // A same-origin GET needs no Origin; every other cookie request does.
    expect((await accountHosts(gateway, { cookie, "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await accountHosts(gateway, { cookie })).status).toBe(403);
    expect((await accountHosts(gateway, { cookie, origin: "https://evil.test" })).status).toBe(403);
  });

  it("ends the caller's own account session, and clears a browser's cookies with it", async () => {
    stack = await startStack();
    const { gateway } = stack;

    // Header profile: the session credential is dead server-side afterwards,
    // so a copy of it somewhere else is worthless.
    const login = await accountLogin(gateway, { accessKey: KEY_A, client: "ios" });
    const token = (login.payload["result"] as { token: string }).token;
    const logout = await fetch(`${gateway.clientBaseUrl}/v1/account/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout.status).toBe(200);
    expect((await logout.json()) as Record<string, unknown>).toMatchObject({
      result: { accountId: String(ACCOUNT_A), revoked: true },
    });
    expect((await accountHosts(gateway, { authorization: `Bearer ${token}` })).status).toBe(401);
    // Logging out twice is refused like any other dead session.
    const again = await fetch(`${gateway.clientBaseUrl}/v1/account/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.status).toBe(401);
    const audit = await gateway.gateway.store.audit.read(new Date().toISOString().slice(0, 10));
    expect(audit.some((record) => record.op === "account.logout" && record.accountId === String(ACCOUNT_A))).toBe(true);

    // Browser profile: clearing the `HttpOnly` cookie is the part JavaScript
    // cannot do itself, so the route has to.
    const browserLogin = await accountLogin(gateway, { accessKey: KEY_A, client: "web", origin: "https://app.test" });
    const sessionCookie = cookieValue(browserLogin.setCookie, "racp_account");
    const csrf = cookieValue(browserLogin.setCookie, "racp_account_csrf");
    const cleared = await fetch(`${gateway.clientBaseUrl}/v1/account/logout`, {
      method: "POST",
      headers: {
        origin: "https://app.test",
        cookie: `racp_account=${encodeURIComponent(sessionCookie ?? "")}; racp_account_csrf=${csrf ?? ""}`,
        "x-csrf-token": csrf ?? "",
      },
    });
    expect(cleared.status).toBe(200);
    const setCookie = cleared.headers.getSetCookie();
    expect(
      setCookie.some((value) => value.startsWith("racp_account=;") && value.includes("Max-Age=0") && value.includes("HttpOnly")),
    ).toBe(true);
    expect(setCookie.some((value) => value.startsWith("racp_account_csrf=;") && value.includes("Max-Age=0"))).toBe(true);
    const cookie = `racp_account=${encodeURIComponent(sessionCookie ?? "")}`;
    expect((await accountHosts(gateway, { cookie, "sec-fetch-site": "same-origin" })).status).toBe(401);
  });

  it("never hands a self-hosted Host to an account by key alone", async () => {
    stack = await startStack();
    const { gateway } = stack;
    // A Host registered through the enrollment code belongs to no account.
    const selfHosted = await enrollTestHost(gateway, { hostId: "host_self" });
    try {
      expect(gateway.gateway.store.findHost("host_self")?.accountId).toBeUndefined();

      // Another account's key is refused: knowing a `hostId` must not let a key
      // take the record over, move it into that account, and invalidate the
      // certificate the Host is currently linked with (gate 29).
      const foreign = await hostCsrFor("host_self");
      const takeover = await postEnrollment(gateway, { body: { hostId: "host_self", csr: foreign.csr }, accessKey: KEY_B });
      expect(takeover.status).toBe(403);
      expect(takeover.payload).toMatchObject({ error: { code: "HOST_ACCOUNT_MISMATCH" } });
      expect(gateway.gateway.store.findHost("host_self")?.accountId).toBeUndefined();
      expect(selfHosted.handle.status().state).toBe("connected");

      // The Host's own key may migrate it into its account.
      const own = await createHostCsr({ privateKeyPem: selfHosted.credentials.privateKeyPem, hostId: "host_self" });
      const migrated = await postEnrollment(gateway, { body: { hostId: "host_self", csr: own }, accessKey: KEY_A });
      expect(migrated.status).toBe(200);
      expect(gateway.gateway.store.findHost("host_self")?.accountId).toBe(String(ACCOUNT_A));
      expect(readCertificateAccountBinding((migrated.payload as { certificate: string }).certificate)).toBe(String(ACCOUNT_A));
    } finally {
      await selfHosted.stop();
    }
  });

  it("refuses a malformed login, a missing key, and an unknown session", async () => {
    stack = await startStack();
    const { gateway } = stack;
    const post = (body: string, authorization?: string) =>
      fetch(`${gateway.clientBaseUrl}/v1/account/login`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        body,
      });
    expect((await post(JSON.stringify({ client: "ios" }))).status).toBe(401);
    // A computer asks for the header profile: `desktop` is a valid client, and
    // the session credential arrives in the body so it can be stored, never as a
    // cookie a browser would read (rollout R8 package E).
    const desktop = await accountLogin(gateway, { accessKey: KEY_A, client: "desktop", label: "mac" });
    expect(desktop.status).toBe(200);
    expect(typeof (desktop.payload.result as { token?: unknown } | undefined)?.token).toBe("string");
    expect((await post("not json", `Bearer ${KEY_A}`)).status).toBe(400);
    expect((await accountHosts(gateway, { authorization: "Bearer rat1.unknown" })).status).toBe(401);
    expect((await accountHosts(gateway, {})).status).toBe(401);
  });

  it("refuses a revoked or expired account session", async () => {
    stack = await startStack();
    const { gateway } = stack;
    const token = (await accountLogin(gateway, { accessKey: KEY_A, client: "ios" })).payload["result"] as { token: string };
    const session = gateway.gateway.store.listAccountSessions(String(ACCOUNT_A))[0];
    expect(session).toBeDefined();
    await gateway.gateway.store.revokeAccountSession(session?.sessionId ?? "", new Date().toISOString());
    expect((await accountHosts(gateway, { authorization: `Bearer ${token.token}` })).status).toBe(401);
  });

  it("revokes a live account session through the owner-only admin socket", async () => {
    stack = await startStack();
    const { gateway } = stack;
    const token = (await accountLogin(gateway, { accessKey: KEY_A, client: "ios" })).payload["result"] as { token: string };
    // The operator's view lists every live session, with no token hash.
    const listed = gateway.gateway.store.listAccountSessions();
    expect(listed.map((session) => session.accountId)).toEqual([String(ACCOUNT_A)]);
    const sessionId = listed[0]?.sessionId ?? "";

    const revoked = await sendAdminRequest(gateway.dataDir, { op: "account-sessions.revoke", payload: { sessionId } });
    expect(revoked.ok).toBe(true);
    expect((await accountHosts(gateway, { authorization: `Bearer ${token.token}` })).status).toBe(401);

    // Revoking an unknown session reports NOT_FOUND instead of succeeding.
    const unknown = await sendAdminRequest(gateway.dataDir, { op: "account-sessions.revoke", payload: { sessionId: "acc_nope" } });
    expect(unknown).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("expires a session at the end of its bounded lifetime", async () => {
    let clock = Date.parse("2026-10-18T00:00:00.000Z");
    stack = await startStack({}, { now: () => clock });
    const { gateway } = stack;
    const token = (await accountLogin(gateway, { accessKey: KEY_A, client: "ios" })).payload["result"] as {
      token: string;
      expiresAt: string;
    };
    expect(Date.parse(token.expiresAt) - clock).toBe(12 * 60 * 60 * 1000);
    expect((await accountHosts(gateway, { authorization: `Bearer ${token.token}` })).status).toBe(200);
    clock += 12 * 60 * 60 * 1000 + 1;
    expect((await accountHosts(gateway, { authorization: `Bearer ${token.token}` })).status).toBe(401);
  });

  it("rate-limits credential attempts per client IP, sharing one budget", async () => {
    bare = await startBareStack({}, { credentialLimit: { capacity: 2, refillPerSecond: 0.001 } });
    const { gateway } = bare;
    expect((await accountLogin(gateway, { accessKey: KEY_A, client: "ios" })).status).toBe(200);
    expect((await accountLogin(gateway, { accessKey: KEY_A, client: "ios" })).status).toBe(200);
    const limited = await accountLogin(gateway, { accessKey: KEY_A, client: "ios" });
    expect(limited.status).toBe(429);
    expect(limited.payload).toMatchObject({ error: { data: { code: "RATE_LIMITED", retriable: true } } });

    // Enrollment by key shares the same bucket, so guessing is bounded once.
    const keys = await hostCsrFor("host_c1");
    const enroll = await postEnrollment(gateway, { body: { hostId: "host_c1", csr: keys.csr }, accessKey: KEY_A });
    expect(enroll.status).toBe(429);
    expect(enroll.payload).toMatchObject({ error: { code: "RATE_LIMITED", retriable: true } });
  });

  it("reports a Router lockout as retriable instead of an invalid key", async () => {
    bare = await startBareStack();
    const { gateway, stub } = bare;
    // The Router locks a caller out after too many failed authentications; the
    // key is not the problem, and the retry hint must survive (gate 31).
    stub.setAnswer(KEY_A, {
      status: 429,
      body: { code: "AUTH_LOCKED", message: "auth.locked", data: { retry_after_seconds: 30 } },
      headers: { "retry-after": "30" },
    });

    const login = await accountLogin(gateway, { accessKey: KEY_A, client: "ios" });
    expect(login.status).toBe(429);
    expect(login.payload).toMatchObject({ error: { data: { code: "RATE_LIMITED", retriable: true } } });
    expect(JSON.stringify(login.payload)).toContain("30000");
    expect(login.retryAfter).toBe("30");
    expect(gateway.gateway.store.listAccountSessions()).toHaveLength(0);

    const keys = await hostCsrFor("host_c1");
    const enroll = await postEnrollment(gateway, { body: { hostId: "host_c1", csr: keys.csr }, accessKey: KEY_A });
    expect(enroll.status).toBe(429);
    expect(enroll.payload).toMatchObject({ error: { code: "RATE_LIMITED", retriable: true } });
    expect(enroll.retryAfter).toBe("30");
    expect(gateway.gateway.store.findHost("host_c1")).toBeNull();
  });

  it("bounds an account-mode label where the Gateway stores it", async () => {
    bare = await startBareStack();
    const { gateway } = bare;
    const tooLong = await postEnrollment(gateway, {
      body: { hostId: "host_c1", csr: (await hostCsrFor("host_c1")).csr, label: "x".repeat(129) },
      accessKey: KEY_A,
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.payload).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
    // The message names the field, so a Host operator can act on it.
    expect(JSON.stringify(tooLong.payload)).toContain("label");
    expect(gateway.gateway.store.findHost("host_c1")).toBeNull();

    const atLimit = await postEnrollment(gateway, {
      body: { hostId: "host_c1", csr: (await hostCsrFor("host_c1")).csr, label: "y".repeat(128) },
      accessKey: KEY_A,
    });
    expect(atLimit.status).toBe(200);
    expect(gateway.gateway.store.findHost("host_c1")?.label).toBe("y".repeat(128));
  });

  it("warns when account mode runs without a trusted proxy behind a loopback client API", async () => {
    bare = await startBareStack();
    // Without the trusted-proxy pair every caller resolves to the proxy, so one
    // caller can empty the shared credential bucket and a key with
    // `allowed_peer_cidrs` can never verify.
    const warnings = bare.logs.filter((line) => line.includes("account mode is on without a trusted proxy"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("--trusted-proxy");
    expect(warnings[0]).toContain("--client-ip-header");
  });

  it("stays quiet about the trusted proxy once the pair is configured", async () => {
    bare = await startBareStack({ clientIp: { trustedProxies: ["127.0.0.1/32"], headerName: "x-forwarded-for" } });
    expect(bare.logs.join("\n")).not.toContain("without a trusted proxy");
  });

  it("resolves the caller address through a trusted proxy and forwards it to the Router", async () => {
    stack = await startStack({
      clientIp: { trustedProxies: ["127.0.0.1/32"], headerName: "x-forwarded-for" },
    });
    const { gateway, stub } = stack;
    const login = (forwardedFor?: string) =>
      fetch(`${gateway.clientBaseUrl}/v1/account/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${KEY_A}`,
          ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
        },
        body: JSON.stringify({ client: "ios" }),
      });

    await login("203.0.113.9");
    expect(stub.calls.at(-1)?.headers["x-real-ip"]).toBe("203.0.113.9");
    // Multi-hop: the rightmost entry that is not a trusted proxy is the caller.
    await login("203.0.113.9, 127.0.0.1");
    expect(stub.calls.at(-1)?.headers["x-real-ip"]).toBe("203.0.113.9");
    // Without a header the peer is used, and the Router sees a real address.
    await login();
    expect(stub.calls.at(-1)?.headers["x-real-ip"]).toBe("127.0.0.1");
  });

  it("ignores a client-IP header when no trusted proxy is configured", async () => {
    stack = await startStack();
    const { gateway, stub } = stack;
    await fetch(`${gateway.clientBaseUrl}/v1/account/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${KEY_A}`,
        "x-forwarded-for": "203.0.113.9",
      },
      body: JSON.stringify({ client: "ios" }),
    });
    // Gate 31: an untrusted peer cannot claim an address.
    expect(stub.calls.at(-1)?.headers["x-real-ip"]).not.toBe("203.0.113.9");
  });

  it("requires exactly one enrollment credential", async () => {
    stack = await startStack();
    const { gateway } = stack;
    const keys = await hostCsrFor("host_c1");
    const { code } = await gateway.gateway.enrollment.issueCode({ label: "operator" });

    const both = await postEnrollment(gateway, {
      body: { enrollmentCode: code, hostId: "host_c1", csr: keys.csr },
      accessKey: KEY_A,
    });
    expect(both.status).toBe(400);
    expect(both.payload).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });

    const neither = await postEnrollment(gateway, { body: { hostId: "host_c1", csr: keys.csr } });
    expect(neither.status).toBe(400);
    expect(neither.payload).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });

    const notBearer = await postEnrollment(gateway, {
      body: { hostId: "host_c1", csr: keys.csr },
      authorization: "Basic Zml4dHVyZQ==",
    });
    expect(notBearer.status).toBe(400);
    expect(notBearer.payload).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  });
});

describe("the guarded Host write", () => {
  it("refuses a write whose guard no longer accepts the stored record", async () => {
    const dataDir = await mkdtemp(join(process.env["PI_SCRATCH_DIR"] ?? tmpdir(), "gateway-store-"));
    const store = await GatewayStore.open(dataDir, () => Date.parse("2026-10-18T00:00:00.000Z"));
    try {
      const record = {
        hostId: "host_x",
        label: "first",
        certificatePem: "-----BEGIN CERTIFICATE-----",
        certificateFingerprint256: "0".repeat(64),
        registeredAt: "2026-10-18T00:00:00.000Z",
      };
      expect(await store.saveHostIfUnchanged(record, () => true)).toBe(true);
      expect(store.findHost("host_x")?.label).toBe("first");

      // A revocation that lands while an enrollment is in flight must survive:
      // the enrollment's write is refused instead of clearing `revokedAt`
      // (gate 26).
      await store.revokeHost("host_x", "2026-10-18T00:00:01.000Z");
      const refused = await store.saveHostIfUnchanged({ ...record, label: "second" }, (current) => !current?.revokedAt);
      expect(refused).toBe(false);
      expect(store.findHost("host_x")?.label).toBe("first");
      expect(store.findHost("host_x")?.revokedAt).toBe("2026-10-18T00:00:01.000Z");

      // The same guard accepts a write over the state it was decided on.
      expect(await store.saveHostIfUnchanged({ ...record, label: "third" }, (current) => current?.label === "first")).toBe(true);
      expect(store.findHost("host_x")?.label).toBe("third");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("a Gateway without account mode", () => {
  it("answers no account route and keeps the self-hosted enrollment working", async () => {
    const gateway = await startTestGateway();
    try {
      const response = await fetch(`${gateway.clientBaseUrl}/v1/account/hosts`);
      expect(response.status).toBe(404);
      const keys = await hostCsrFor("host_self");
      const anonymous = await postEnrollment(gateway, { body: { hostId: "host_self", csr: keys.csr } });
      expect(anonymous.status).toBe(400);
      expect(anonymous.payload).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });

      const { code } = await gateway.gateway.enrollment.issueCode({ label: "self-hosted" });
      const enrolled = await postEnrollment(gateway, { body: { enrollmentCode: code, hostId: "host_self", csr: keys.csr } });
      expect(enrolled.status).toBe(200);
      expect(gateway.gateway.store.findHost("host_self")?.accountId).toBeUndefined();
      // A self-hosted certificate carries no account binding.
      expect(readCertificateAccountBinding((enrolled.payload as { certificate: string }).certificate)).toBeNull();
    } finally {
      await gateway.close();
    }
  });

  it("never mentions the trusted proxy when account mode is off", async () => {
    const logs: string[] = [];
    const gateway = await startTestGateway({}, { log: (_level, message) => logs.push(message) });
    try {
      expect(logs.join("\n")).not.toContain("trusted proxy");
    } finally {
      await gateway.close();
    }
  });
});
