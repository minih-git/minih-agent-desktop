import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createSecureServer as createSecureHttp2Server } from "node:http2";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { PushConfigError, resolvePushConfig } from "./push-config.js";
import { ApnsClient, FcmClient, apnsProviderJwt, classifyApns, classifyFcm, fcmAssertionJwt, apnsBody } from "./push-providers.js";

/**
 * The push providers and their operator configuration (protocol §11.6, R5
 * PR-6).
 *
 * Nothing here talks to Apple or Google: the JWT shapes are asserted directly,
 * and the classification functions are pure so every provider answer the
 * Gateway must act on (delivered, dead token, misconfigured, retry later) is one
 * case each. The provider secrets below are generated in the test process.
 */
const es256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const es256Pem = es256.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaPem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const NOW = Date.parse("2026-10-18T00:00:00.000Z");

function segment(jwt: string, index: number): Record<string, unknown> {
  const part = jwt.split(".")[index] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("APNs provider JWT", () => {
  it("signs ES256 over kid + team id, with the JOSE signature encoding", () => {
    const jwt = apnsProviderJwt({ keyId: "KEY123", teamId: "TEAM123", privateKeyPem: es256Pem }, NOW);
    expect(jwt.split(".")).toHaveLength(3);
    expect(segment(jwt, 0)).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(segment(jwt, 1)).toEqual({ iss: "TEAM123", iat: Math.floor(NOW / 1000) });
    // JOSE wants r‖s (64 bytes for P-256), not DER: a DER signature here is the
    // classic 403 InvalidProviderToken that looks like a bad key.
    expect(Buffer.from(jwt.split(".")[2]!, "base64url")).toHaveLength(64);
  });

  it("refreshes inside Apple's one-hour window and reuses the token before that", () => {
    let now = NOW;
    const client = new ApnsClient(
      { privateKeyPem: es256Pem, keyId: "K", teamId: "T", topic: "app.test", endpoint: "https://apns.test" },
      { now: () => now },
    );
    const first = client.jwt();
    now += 49 * 60 * 1000;
    expect(client.jwt()).toBe(first);
    now += 2 * 60 * 1000;
    const refreshed = client.jwt();
    expect(refreshed).not.toBe(first);
    expect(segment(refreshed, 1)).toEqual({ iss: "T", iat: Math.floor(now / 1000) });
  });
});

describe("FCM service-account JWT", () => {
  it("asks for exactly the messaging scope, addressed to the token endpoint", () => {
    const jwt = fcmAssertionJwt(
      { clientEmail: "robot@gw.test", privateKeyPem: rsaPem, tokenUri: "https://oauth.test/token" },
      NOW,
    );
    expect(segment(jwt, 0)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(segment(jwt, 1)).toMatchObject({
      iss: "robot@gw.test",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth.test/token",
      exp: Math.floor(NOW / 1000) + 3600,
    });
  });

  it("caches the access token until a minute before it expires", async () => {
    let now = NOW;
    const tokenBodies: string[] = [];
    const client = new FcmClient(
      { clientEmail: "robot@gw.test", privateKeyPem: rsaPem, projectId: "proj", tokenUri: "https://oauth.test/token", endpoint: "https://fcm.test" },
      { now: () => now },
    );
    // The fetch is global in this module; a stub keeps the test offline.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      tokenBodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ access_token: `at_${tokenBodies.length}`, expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    try {
      expect(await client.accessToken()).toBe("at_1");
      now += 30 * 60 * 1000;
      expect(await client.accessToken()).toBe("at_1");
      now += 31 * 60 * 1000;
      expect(await client.accessToken()).toBe("at_2");
      expect(tokenBodies[0]).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports a refused assertion as a configuration failure, never as a dead token", async () => {
    const client = new FcmClient(
      { clientEmail: "robot@gw.test", privateKeyPem: rsaPem, projectId: "proj", tokenUri: "https://oauth.test/token", endpoint: "https://fcm.test" },
      { now: () => NOW },
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{\"error\":\"invalid_grant\"}", { status: 400 })) as typeof fetch;
    try {
      expect(await client.send("token", payload())).toEqual({ ok: false, reason: "configuration", status: 400 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function payload() {
  return {
    kind: "turn.completed" as const,
    titleKey: "push.notify.turn.completed.title",
    bodyKey: "push.notify.turn.completed.body",
    hostId: "host_1",
    sessionId: "s1",
    notifyId: "ntf_1",
  };
}

describe("provider answers", () => {
  it("reads APNs 410 and its named reasons as a dead token", () => {
    expect(classifyApns(200, "")).toEqual({ ok: true });
    expect(classifyApns(410, JSON.stringify({ reason: "Unregistered" }))).toEqual({ ok: false, reason: "unregistered", status: 410 });
  });

  it("does not read a wrong topic as a dead token: that is one operator mistake, not every device", () => {
    // `DeviceTokenNotForTopic` is what a wrong `--apns-topic` or a build of
    // another bundle id produces for *every* token this Gateway holds. Calling
    // it "unregistered" would delete the whole platform's registrations on the
    // first notification after a configuration change.
    expect(classifyApns(400, JSON.stringify({ reason: "DeviceTokenNotForTopic" })).reason).toBe("configuration");
    expect(classifyApns(400, JSON.stringify({ reason: "TopicDisallowed" })).reason).toBe("configuration");
    // `BadDeviceToken` is also what every token gets on the wrong environment
    // (production tokens on the sandbox endpoint), so it deletes nothing either.
    expect(classifyApns(400, JSON.stringify({ reason: "BadDeviceToken" })).reason).toBe("configuration");
  });

  it("separates a refused provider credential from a retryable failure", () => {
    expect(classifyApns(403, JSON.stringify({ reason: "InvalidProviderToken" })).reason).toBe("configuration");
    expect(classifyApns(429, "{}").reason).toBe("transient");
    expect(classifyApns(500, "not json").reason).toBe("transient");
  });

  it("reads FCM UNREGISTERED as a dead token, and a bare 404 as a configuration problem", () => {
    expect(classifyFcm(200, "{}")).toEqual({ ok: true });
    expect(
      classifyFcm(404, JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } })),
    ).toEqual({ ok: false, reason: "unregistered", status: 404 });
    // A wrong project id, a wrong endpoint path, or a proxy answers 404 for every
    // token: deleting registrations here would empty the platform in one call.
    expect(classifyFcm(404, JSON.stringify({ error: { status: "NOT_FOUND" } })).reason).toBe("configuration");
    expect(classifyFcm(404, "not json").reason).toBe("configuration");
    expect(classifyFcm(403, JSON.stringify({ error: { status: "PERMISSION_DENIED", details: [{ errorCode: "THIRD_PARTY_AUTH_ERROR" }] } })).reason).toBe(
      "configuration",
    );
    expect(classifyFcm(503, "{}").reason).toBe("transient");
  });
});

describe("operator configuration", () => {
  async function secretFile(content: string, mode = 0o600): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "push-cfg-"));
    const path = join(dir, "secret");
    await writeFile(path, content, { mode });
    return path;
  }

  it("turns push off when nothing is configured", async () => {
    expect(await resolvePushConfig(undefined)).toBeNull();
    expect(await resolvePushConfig({})).toBeNull();
  });

  it("refuses a half-configured provider instead of pretending push is on", async () => {
    await expect(resolvePushConfig({ apnsKeyFile: "/tmp/k.p8" })).rejects.toBeInstanceOf(PushConfigError);
    await expect(resolvePushConfig({ apnsEndpoint: "https://apns.test" })).rejects.toBeInstanceOf(PushConfigError);
  });

  it("refuses a provider endpoint that is not an absolute https URL", async () => {
    const keyPath = await secretFile(es256Pem);
    const apns = { apnsKeyFile: keyPath, apnsKeyId: "K", apnsTeamId: "T", apnsTopic: "app.test" };
    // A provider token or an access token travels to this URL, so `http:` (or a
    // relative value) must fail at startup rather than leak in the clear.
    await expect(resolvePushConfig({ ...apns, apnsEndpoint: "http://apns.test" })).rejects.toThrow(/must use https/);
    await expect(resolvePushConfig({ ...apns, apnsEndpoint: "apns.test" })).rejects.toThrow(/not an absolute URL/);
    const account = await secretFile(JSON.stringify({ client_email: "r@gw.test", private_key: rsaPem, project_id: "p" }));
    await expect(resolvePushConfig({ fcmServiceAccountFile: account, fcmTokenUri: "http://oauth.test" })).rejects.toThrow(
      /must use https/,
    );
    expect((await resolvePushConfig({ ...apns, apnsEndpoint: "https://apns.test/" }))?.apns?.endpoint).toBe("https://apns.test");
  });

  it("refuses a credential file other users can read", async () => {
    const path = await secretFile(es256Pem, 0o644);
    await expect(
      resolvePushConfig({ apnsKeyFile: path, apnsKeyId: "K", apnsTeamId: "T", apnsTopic: "app.test" }),
    ).rejects.toThrow(/chmod 600/);
  });

  it("reads an APNs key and a service account without echoing either", async () => {
    const keyPath = await secretFile(es256Pem);
    const account = await secretFile(
      JSON.stringify({ client_email: "robot@gw.test", private_key: rsaPem, project_id: "proj" }),
    );
    const parsed = await resolvePushConfig({
      apnsKeyFile: keyPath,
      apnsKeyId: "K",
      apnsTeamId: "T",
      apnsTopic: "app.test",
      fcmServiceAccountFile: account,
    });
    expect(parsed?.apns).toMatchObject({ keyId: "K", teamId: "T", topic: "app.test", endpoint: "https://api.push.apple.com" });
    expect(parsed?.fcm).toMatchObject({ clientEmail: "robot@gw.test", projectId: "proj", endpoint: "https://fcm.googleapis.com" });
    // The configuration object is what a logger would print: the private keys
    // are in it because the client needs them, and nothing else is.
    expect(JSON.stringify({ ...parsed, apns: { ...parsed!.apns, privateKeyPem: "redacted" }, fcm: { ...parsed!.fcm, privateKeyPem: "redacted" } })).not.toContain(
      "PRIVATE KEY",
    );
  });

  it("refuses a service account without the three fields it needs", async () => {
    const account = await secretFile(JSON.stringify({ client_email: "robot@gw.test" }));
    await expect(resolvePushConfig({ fcmServiceAccountFile: account })).rejects.toThrow(/client_email, private_key, and project_id/);
  });
});

/**
 * The transport itself, against a local TLS server.
 *
 * These cases exist because the interesting provider behaviour is the *absence*
 * of an answer: a provider that accepts the connection and then says nothing
 * must not hold the Gateway. A self-signed certificate is generated here, the
 * client is pointed at it, and no request leaves the machine.
 */
describe("provider transport", () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of open.splice(0)) await close();
  });

  async function tlsFixture(): Promise<{ cert: string; key: string }> {
    const dir = await mkdtemp(join(tmpdir(), "push-tls-"));
    const certPath = join(dir, "stub.crt");
    const keyPath = join(dir, "stub.key");
    await promisify(execFile)("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", keyPath, "-out", certPath,
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]);
    return { cert: await readFile(certPath, "utf8"), key: await readFile(keyPath, "utf8") };
  }

  it("gives up on an APNs provider that accepts the connection and never answers", async () => {
    const material = await tlsFixture();
    // A server that reads the request and deliberately answers nothing.
    const server = createSecureHttp2Server(material, () => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    open.push(async () => {
      server.close();
      await new Promise((resolve) => server.once("close", resolve));
    });

    const client = new ApnsClient(
      { privateKeyPem: es256Pem, keyId: "K", teamId: "T", topic: "app.test", endpoint: `https://127.0.0.1:${port}` },
      { ca: material.cert, timeoutMs: 200 },
    );
    const started = Date.now();
    const result = await client.send("device-token", payload());
    expect(result).toEqual({ ok: false, reason: "transient", status: 0 });
    // The deadline, not the provider, ended the attempt.
    expect(Date.now() - started).toBeLessThan(3_000);
    client.close();
  });

  it("gives up on an FCM endpoint that never answers, on both requests", async () => {
    const material = await tlsFixture();
    const server = createHttpsServer(material, () => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    open.push(async () => {
      server.closeAllConnections();
      server.close();
      await new Promise((resolve) => server.once("close", resolve));
    });

    const client = new FcmClient(
      {
        clientEmail: "robot@gw.test",
        privateKeyPem: rsaPem,
        projectId: "proj",
        tokenUri: `https://127.0.0.1:${port}/token`,
        endpoint: `https://127.0.0.1:${port}`,
      },
      { timeoutMs: 200 },
    );
    const started = Date.now();
    const result = await client.send("token", payload());
    expect(result.reason).toBe("configuration");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("mints one access token for concurrent pushes instead of one each", async () => {
    let exchanges = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/token")) {
        exchanges += 1;
        // A slow exchange: two pushes arrive while it is in flight.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify({ access_token: "at_1", expires_in: 3600 }), { status: 200 });
      }
      expect(init?.headers).toMatchObject({ authorization: "Bearer at_1" });
      return new Response(JSON.stringify({ name: "projects/proj/messages/1" }), { status: 200 });
    }) as typeof fetch;
    try {
      const client = new FcmClient({
        clientEmail: "robot@gw.test",
        privateKeyPem: rsaPem,
        projectId: "proj",
        tokenUri: "https://oauth.test/token",
        endpoint: "https://fcm.test",
      });
      const results = await Promise.all([client.send("a", payload()), client.send("b", payload()), client.send("c", payload())]);
      expect(results.every((result) => result.ok)).toBe(true);
      // Single-flight: one exchange for three pushes.
      expect(exchanges).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("drops a cached access token the messaging endpoint refused", async () => {
    const bodies: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/token")) {
        bodies.push("token");
        return new Response(JSON.stringify({ access_token: `at_${bodies.length}`, expires_in: 3600 }), { status: 200 });
      }
      // The first send is refused, the second must be attempted with a new token.
      return new Response(JSON.stringify({ error: { status: "UNAUTHENTICATED" } }), { status: 401 });
    }) as typeof fetch;
    try {
      const client = new FcmClient({
        clientEmail: "robot@gw.test",
        privateKeyPem: rsaPem,
        projectId: "proj",
        tokenUri: "https://oauth.test/token",
        endpoint: "https://fcm.test",
      });
      expect((await client.send("a", payload())).reason).toBe("configuration");
      expect(await client.accessToken()).toBe("at_2");
      expect(bodies).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends the FCM message in the HTTP v1 shape, with the keys where FCM accepts them", async () => {
    let sent: unknown = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/token")) {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
      }
      sent = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ name: "projects/proj/messages/1" }), { status: 200 });
    }) as typeof fetch;
    try {
      const client = new FcmClient({
        clientEmail: "robot@gw.test",
        privateKeyPem: rsaPem,
        projectId: "proj",
        tokenUri: "https://oauth.test/token",
        endpoint: "https://fcm.test",
      });
      expect((await client.send("device", payload())).ok).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const message = (sent as { message: Record<string, unknown> }).message;
    // `notification` only takes title/body/image; the location keys belong to
    // `android.notification`, and Android resource names have no dots.
    expect(message["notification"]).toBeUndefined();
    expect(message["android"]).toEqual({
      priority: "high",
      notification: {
        title_loc_key: "push_notify_turn_completed_title",
        body_loc_key: "push_notify_turn_completed_body",
        // One group per session, derived from the id the payload already carries
        // (§17.6.2), so grouping adds no field to the contract.
        tag: payload().sessionId,
      },
    });
    expect(Object.keys(message).sort()).toEqual(["android", "data", "token"]);
  });
});

describe("APNs session sharing", () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of open.splice(0)) await close();
  });

  it("does not cancel a healthy request when a sibling on the same session times out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "push-tls-shared-"));
    const certPath = join(dir, "stub.crt");
    const keyPath = join(dir, "stub.key");
    await promisify(execFile)("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", keyPath, "-out", certPath, "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]);
    const cert = await readFile(certPath, "utf8");
    const key = await readFile(keyPath, "utf8");

    // One device's push is answered after a delay; the other's is never answered.
    // A TLS HTTP/2 server (`createServer` would be cleartext h2, which a
    // `https://` client refuses with a TLS record error).
    const server = createSecureHttp2Server({ cert, key }, (request, response) => {
      const path = String(request.headers[":path"] ?? "");
      request.resume();
      if (path.includes("slow-device")) {
        setTimeout(() => {
          response.writeHead(200);
          response.end();
        }, 150);
      }
      // "wedged-device" is answered with nothing at all.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    open.push(async () => {
      server.close();
      await new Promise((resolve) => server.once("close", resolve));
    });

    const client = new ApnsClient(
      { privateKeyPem: es256Pem, keyId: "K", teamId: "T", topic: "app.test", endpoint: `https://127.0.0.1:${port}` },
      { ca: cert, timeoutMs: 400 },
    );
    // Both requests share one HTTP/2 session, as Apple expects.
    const [wedged, healthy] = await Promise.all([
      client.send("wedged-device", payload()),
      client.send("slow-device", payload()),
    ]);
    expect(wedged).toEqual({ ok: false, reason: "transient", status: 0 });
    // The sibling is not collateral damage: one hung push must not silence a
    // device that would have been reachable.
    expect(healthy).toEqual({ ok: true });
    client.close();
  });

  it("closes a session that no longer has requests in flight", async () => {
    const dir = await mkdtemp(join(tmpdir(), "push-tls-idle-"));
    const certPath = join(dir, "stub.crt");
    const keyPath = join(dir, "stub.key");
    await promisify(execFile)("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", keyPath, "-out", certPath, "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]);
    const cert = await readFile(certPath, "utf8");
    const key = await readFile(keyPath, "utf8");
    const server = createSecureHttp2Server({ cert, key }, (request, response) => {
      request.resume();
      // Never answered: the deadline is the only way out.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    open.push(async () => {
      server.close();
      await new Promise((resolve) => server.once("close", resolve));
    });

    const client = new ApnsClient(
      { privateKeyPem: es256Pem, keyId: "K", teamId: "T", topic: "app.test", endpoint: `https://127.0.0.1:${port}` },
      { ca: cert, timeoutMs: 150 },
    );
    expect(await client.send("one", payload())).toEqual({ ok: false, reason: "transient", status: 0 });
    // A second push opens a fresh session rather than reusing a dead one.
    expect(await client.send("two", payload())).toEqual({ ok: false, reason: "transient", status: 0 });
    client.close();
  });
});

describe("the APNs body", () => {
  const payload = {
    kind: "approval.requested" as const,
    titleKey: "push.notify.approval.requested.title",
    bodyKey: "push.notify.approval.requested.body",
    hostId: "host_a",
    sessionId: "session_1",
    approvalId: "ap_1",
    notifyId: "ntf_1",
  };

  it("carries keys and ids, groups by session, and adds nothing of its own", () => {
    const body = apnsBody(payload);
    expect(body).toEqual({
      aps: {
        alert: { "title-loc-key": payload.titleKey, "loc-key": payload.bodyKey },
        sound: "default",
        "mutable-content": 1,
        "thread-id": "session_1",
      },
      ...payload,
    });
    // The contract in one assertion: no prompt, no tool, no title, no sentence.
    expect(Object.keys(body).sort()).toEqual(["approvalId", "aps", "bodyKey", "hostId", "kind", "notifyId", "sessionId", "titleKey"]);
  });

  it("groups two events about one session together, and two sessions apart", () => {
    const first = apnsBody(payload);
    const second = apnsBody({ ...payload, notifyId: "ntf_2", kind: "turn.completed" });
    const other = apnsBody({ ...payload, sessionId: "session_2" });
    const threadOf = (body: Record<string, unknown>) => (body["aps"] as { "thread-id": string })["thread-id"];
    expect(threadOf(first)).toBe(threadOf(second));
    expect(threadOf(first)).not.toBe(threadOf(other));
  });
});
