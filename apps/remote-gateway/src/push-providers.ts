/**
 * Push providers using only Node's own modules (protocol §11.6, R5 PR-6).
 *
 * APNs is HTTP/2 with an ES256 provider JWT; FCM is the HTTP v1 API with an
 * OAuth2 access token minted from the service account's RSA key. Neither
 * provider SDK is worth a dependency here: both are one signed request against
 * one documented endpoint, and keeping them dependency-free is what lets the
 * whole path be exercised against a local TLS stub instead of Apple's or
 * Google's live services.
 *
 * Three rules run through this file:
 *
 * - **A provider can never wedge the Gateway.** Every provider call has a hard
 *   deadline, enforced on the stream (APNs) or with an `AbortSignal` (FCM), so a
 *   provider that accepts a connection and then says nothing costs one timeout
 *   rather than a leaked session and a stalled notification.
 * - **A provider secret never leaves these classes.** No log line, no error
 *   message, and no thrown object from this file carries a private key, an
 *   access token, a provider token, or a JWT.
 * - **Only the provider can say a token is dead.** `410 Unregistered` and FCM
 *   `UNREGISTERED` mean "delete this registration"; a wrong topic or a bare 404
 *   is a configuration problem and must not clear anybody's registrations.
 */
import { createSign, sign as cryptoSign } from "node:crypto";
import { connect as http2Connect, constants as http2Constants, type ClientHttp2Session } from "node:http2";

import { androidResourceKey, type RacpPushPayload } from "@minih-agent/shared";

import type { ApnsPushConfig, FcmPushConfig } from "./push-config.js";

/** What one delivery attempt produced. */
export type PushDeliveryResult =
  /** The provider accepted the notification. */
  | { ok: true }
  /**
   * The provider says this token is dead (APNs `410`/`Unregistered`, FCM
   * `UNREGISTERED`): this one registration is deleted, not retried. Nothing
   * else is.
   */
  | { ok: false; reason: "unregistered"; status: number }
  /** A transient failure: the token stays, the notification is dropped. */
  | { ok: false; reason: "transient"; status: number }
  /** Misconfiguration or a refused credential: logged, never per event. */
  | { ok: false; reason: "configuration"; status: number };

export type PushProviderOptions = {
  /** Injectable clock for the token caches. */
  now?: () => number;
  /** Local TLS stub for tests: an extra CA the provider endpoint is checked against. */
  ca?: string;
  /** Milliseconds before a request is abandoned; defaults to 10 s. */
  timeoutMs?: number;
};

const PROVIDER_TIMEOUT_MS = 10_000;
/** Refresh the provider JWT well inside APNs' one-hour rejection window. */
const APNS_JWT_LIFETIME_MS = 50 * 60 * 1000;
/** Refresh the OAuth2 access token a minute before it expires. */
const FCM_TOKEN_SAFETY_MS = 60 * 1000;
/**
 * How long an idle APNs session is kept. Apple asks clients to reuse a
 * connection; a Gateway that pushes a few times an hour should not hold one
 * open forever either.
 */
const APNS_SESSION_IDLE_MS = 5 * 60 * 1000;

/** base64url without padding, the JOSE encoding. */
function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** One ES256 JWT for APNs; the signature is JOSE (r‖s), not DER. */
export function apnsProviderJwt(config: Pick<ApnsPushConfig, "keyId" | "teamId" | "privateKeyPem">, issuedAt: number): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(issuedAt / 1000) }));
  const signature = cryptoSign("sha256", Buffer.from(`${header}.${claims}`), {
    key: config.privateKeyPem,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${claims}.${base64url(signature)}`;
}

/**
 * One RS256 JWT that exchanges for an OAuth2 access token, as Google's service
 * account flow specifies.
 */
export function fcmAssertionJwt(config: Pick<FcmPushConfig, "clientEmail" | "privateKeyPem" | "tokenUri">, issuedAt: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: config.tokenUri,
      iat: Math.floor(issuedAt / 1000),
      exp: Math.floor(issuedAt / 1000) + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64url(signer.sign(config.privateKeyPem))}`;
}

/** The provider's error body, parsed defensively: a non-JSON answer is `{}`. */
function errorText(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The APNs client.
 *
 * Apple requires a client to reuse its HTTP/2 connection, so one session is
 * opened on the first push and shared; a session that errors or receives
 * `GOAWAY` is discarded and rebuilt on the next attempt, and the idle timer
 * closes it so a quiet Gateway holds no connection. A session-level timeout is
 * armed per request so a provider that accepts the connection and then goes
 * silent ends the attempt instead of stalling the caller.
 */
/**
 * The whole APNs request body, as a pure function.
 *
 * Extracted so the one property that matters is checkable without a socket: the
 * visible text is two *keys* (ADR 0331 decision 7), the ids ride beside them, and
 * nothing else is added. `thread-id` groups several events about one session on
 * the lock screen (§17.6.2) and is derived from the `sessionId` already in the
 * payload, so grouping costs no field in the contract.
 */
export function apnsBody(payload: RacpPushPayload): Record<string, unknown> {
  return {
    aps: {
      alert: { "title-loc-key": payload.titleKey, "loc-key": payload.bodyKey },
      sound: "default",
      "mutable-content": 1,
      "thread-id": payload.sessionId,
    },
    ...payload,
  };
}

export class ApnsClient {
  private cachedJwt: { value: string; issuedAt: number } | null = null;
  private session: ClientHttp2Session | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Requests using the current session; the session is only dropped when idle. */
  private inFlight = 0;

  constructor(
    private readonly config: ApnsPushConfig,
    private readonly options: PushProviderOptions = {},
  ) {}

  private now(): number {
    return (this.options.now ?? (() => Date.now()))();
  }

  private timeoutMs(): number {
    return this.options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  }

  /** The provider JWT, refreshed inside the window APNs accepts. */
  jwt(): string {
    const now = this.now();
    if (this.cachedJwt && now - this.cachedJwt.issuedAt < APNS_JWT_LIFETIME_MS) return this.cachedJwt.value;
    const value = apnsProviderJwt(this.config, now);
    this.cachedJwt = { value, issuedAt: now };
    return value;
  }

  /** Deliver one notification to one APNs device token. */
  async send(deviceToken: string, payload: RacpPushPayload): Promise<PushDeliveryResult> {
    // The alert text is a *resource key*, resolved by iOS from the app's own
    // strings files: the Gateway never sends a sentence, let alone content
    // (ADR 0331 decision 7). The ids ride beside it so a tap opens the right
    // screen.
    const body = JSON.stringify(apnsBody(payload));
    try {
      const session = this.connectedSession();
      this.inFlight += 1;
      return await new Promise<PushDeliveryResult>((resolve) => {
        // One resolution per attempt, whatever fires first.
        let settled = false;
        const finish = (result: PushDeliveryResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve(result);
        };
        let stream: ReturnType<ClientHttp2Session["request"]> | null = null;
        const deadline = setTimeout(() => {
          // This one request is abandoned. The session is destroyed only when
          // nothing else is using it: another device in the same batch shares
          // this connection, and cancelling its notification because a sibling
          // provider call hung would turn one wedged push into several.
          finish({ ok: false, reason: "transient", status: 0 });
          if (stream) {
            try {
              stream.close(http2Constants.NGHTTP2_CANCEL);
            } catch {
              // Already closed.
            }
          }
          if (this.inFlight <= 1) this.discardSession();
        }, this.timeoutMs());
        // `timeout` on a stream is a no-op when the session is quiet, so only
        // the explicit deadline below is relied on.
        if (typeof deadline.unref === "function") deadline.unref();

        let status = 0;
        let text = "";
        try {
          stream = session.request({
            [http2Constants.HTTP2_HEADER_METHOD]: "POST",
            [http2Constants.HTTP2_HEADER_PATH]: `/3/device/${encodeURIComponent(deviceToken)}`,
            [http2Constants.HTTP2_HEADER_AUTHORIZATION]: `bearer ${this.jwt()}`,
            "apns-topic": this.config.topic,
            "apns-push-type": "alert",
            "apns-priority": "10",
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
          });
        } catch {
          // A session that died between pushes: drop it and report a transient
          // failure rather than throwing into the notification loop.
          finish({ ok: false, reason: "transient", status: 0 });
          this.discardSession();
          return;
        }
        stream.setEncoding("utf8");
        stream.on("response", (headers) => {
          status = Number(headers[http2Constants.HTTP2_HEADER_STATUS] ?? 0);
        });
        stream.on("data", (chunk: string) => {
          text += chunk;
        });
        stream.on("error", () => finish({ ok: false, reason: "transient", status: status || 0 }));
        stream.on("end", () => finish(classifyApns(status, text)));
        stream.end(body);
      });
    } catch {
      return { ok: false, reason: "transient", status: 0 };
    } finally {
      this.inFlight -= 1;
      this.markIdle();
    }
  }

  /** Close the pooled session; called when the Gateway stops. */
  close(): void {
    this.discardSession();
  }

  /** The live session, reconnecting when it is absent or already destroyed. */
  private connectedSession(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const endpoint = this.config.endpoint.replace(/\/+$/, "");
    const session = http2Connect(endpoint, {
      ...(this.options.ca ? { ca: this.options.ca } : {}),
    });
    // A session error must not crash the Gateway: the attempt resolves through
    // its own stream and the session is dropped for the next one.
    session.on("error", () => this.discardSession());
    session.on("goaway", () => this.discardSession());
    session.on("close", () => {
      if (this.session === session) this.session = null;
    });
    session.setTimeout(this.timeoutMs(), () => this.discardSession());
    this.session = session;
    return session;
  }

  private markIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    // No session (all requests finished and it was dropped): nothing to close.
    if (!this.session) return;
    this.idleTimer = setTimeout(() => this.discardSession(), APNS_SESSION_IDLE_MS);
    if (typeof this.idleTimer.unref === "function") this.idleTimer.unref();
  }

  private discardSession(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const session = this.session;
    this.session = null;
    if (!session) return;
    session.removeAllListeners("error");
    session.on("error", () => undefined);
    try {
      session.destroy();
    } catch {
      // Already gone.
    }
  }
}

/** APNs' own answer codes, mapped once (Apple's `reason` strings and statuses). */
export function classifyApns(status: number, body: string): PushDeliveryResult {
  if (status === 200) return { ok: true };
  const raw = errorText(body)["reason"];
  const reason = typeof raw === "string" ? raw : "";
  // 410 / `Unregistered` is the only answer that means the registration is dead.
  // `DeviceTokenNotForTopic` and `BadDeviceToken` are *not*: Apple answers the
  // first for a wrong `--apns-topic` or a build of another bundle id, and the
  // second for a token sent to the wrong environment (a production token on the
  // sandbox endpoint, or the reverse) — both for every token the operator has,
  // so treating either as a dead token would wipe the platform's registrations
  // on the first notification after one configuration mistake.
  if (status === 410 || reason === "Unregistered") {
    return { ok: false, reason: "unregistered", status };
  }
  if (
    status === 403 ||
    status === 401 ||
    reason === "InvalidProviderToken" ||
    reason === "MissingProviderToken" ||
    reason === "DeviceTokenNotForTopic" ||
    reason === "BadDeviceToken" ||
    reason === "TopicDisallowed" ||
    reason === "BadTopic"
  ) {
    return { ok: false, reason: "configuration", status };
  }
  return { ok: false, reason: "transient", status };
}

/**
 * The FCM client. The access token is minted from the service account and cached
 * until a minute before it expires, so a burst of notifications costs one token
 * exchange rather than one per push. The exchange is single-flight: concurrent
 * pushes share the request in progress instead of each minting its own.
 */
export class FcmClient {
  private cachedToken: { value: string; expiresAt: number } | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(
    private readonly config: FcmPushConfig,
    private readonly options: PushProviderOptions = {},
  ) {}

  private now(): number {
    return (this.options.now ?? (() => Date.now()))();
  }

  private timeoutMs(): number {
    return this.options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  }

  /** One OAuth2 access token, cached across notifications. */
  async accessToken(): Promise<string> {
    const now = this.now();
    if (this.cachedToken && this.cachedToken.expiresAt - FCM_TOKEN_SAFETY_MS > now) return this.cachedToken.value;
    // Single-flight: two notifications arriving together exchange once.
    this.pendingToken ??= this.exchange().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  /** Forget a cached access token the messaging endpoint refused. */
  invalidateAccessToken(): void {
    this.cachedToken = null;
  }

  private async exchange(): Promise<string> {
    const now = this.now();
    const assertion = fcmAssertionJwt(this.config, now);
    const response = await fetch(this.config.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(this.timeoutMs()),
    });
    if (!response.ok) {
      // The body is not surfaced: a token endpoint's error body can echo the
      // assertion, and an assertion is a credential.
      throw new FcmCredentialError(response.status);
    }
    const parsed = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    const value = typeof parsed.access_token === "string" ? parsed.access_token : "";
    if (!value) throw new FcmCredentialError(response.status);
    const lifetime = typeof parsed.expires_in === "number" ? parsed.expires_in * 1000 : 3_600_000;
    this.cachedToken = { value, expiresAt: now + lifetime };
    return value;
  }

  /** Deliver one notification to one FCM registration token. */
  async send(deviceToken: string, payload: RacpPushPayload): Promise<PushDeliveryResult> {
    let accessToken: string;
    try {
      accessToken = await this.accessToken();
    } catch (error) {
      return {
        ok: false,
        reason: "configuration",
        status: error instanceof FcmCredentialError ? error.status : 0,
      };
    }
    const endpoint = this.config.endpoint.replace(/\/+$/, "");
    const url = `${endpoint}/v1/projects/${encodeURIComponent(this.config.projectId)}/messages:send`;
    // Same rule as APNs: the visible text is a resource key the app resolves.
    // HTTP v1's `notification` carries only `title`/`body`/`image`, so the
    // localization keys belong to `android.notification`; anywhere else FCM
    // answers 400 INVALID_ARGUMENT for every device, which is what the E2E's
    // strict stub now refuses. The name is the Android resource form
    // (`push_notify_<kind>_title`), because a dotted key would not resolve.
    const data: Record<string, string> = {
      kind: payload.kind,
      titleKey: payload.titleKey,
      bodyKey: payload.bodyKey,
      hostId: payload.hostId,
      sessionId: payload.sessionId,
      notifyId: payload.notifyId,
      ...(payload.approvalId ? { approvalId: payload.approvalId } : {}),
    };
    const message = {
      message: {
        token: deviceToken,
        data,
        android: {
          priority: "high",
          notification: {
            title_loc_key: androidResourceKey(payload.titleKey),
            body_loc_key: androidResourceKey(payload.bodyKey),
            // The Android equivalent of `thread-id`: one group per session.
            tag: payload.sessionId,
          },
        },
      },
    };
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.timeoutMs()),
      });
      const text = await response.text();
      const result = classifyFcm(response.status, text);
      // A refused access token is worth one fresh exchange; keeping it would
      // make every later push fail the same way.
      if (!result.ok && result.reason === "configuration" && (response.status === 401 || response.status === 403)) {
        this.invalidateAccessToken();
      }
      return result;
    } catch {
      return { ok: false, reason: "transient", status: 0 };
    }
  }
}

/** FCM's answer codes, mapped once. */
export function classifyFcm(status: number, body: string): PushDeliveryResult {
  if (status === 200) return { ok: true };
  const parsed = errorText(body);
  const error = typeof parsed["error"] === "object" && parsed["error"] !== null ? (parsed["error"] as Record<string, unknown>) : {};
  const statuses = typeof error["status"] === "string" ? error["status"] : "";
  const details = Array.isArray(error["details"]) ? error["details"] : [];
  const codes = details
    .map((entry) => (typeof entry === "object" && entry !== null ? String((entry as Record<string, unknown>)["errorCode"] ?? "") : ""))
    .filter(Boolean);
  // Only `UNREGISTERED` means this token is gone. A bare 404 (or `NOT_FOUND`)
  // is what a wrong project id, a wrong endpoint path, or a proxy produces for
  // *every* token, so it is a configuration problem, not a dead device.
  if (codes.includes("UNREGISTERED")) {
    return { ok: false, reason: "unregistered", status };
  }
  if (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    statuses === "NOT_FOUND" ||
    statuses === "PERMISSION_DENIED" ||
    codes.includes("THIRD_PARTY_AUTH_ERROR")
  ) {
    return { ok: false, reason: "configuration", status };
  }
  return { ok: false, reason: "transient", status };
}

/** The token endpoint refused the assertion; carries only its status. */
export class FcmCredentialError extends Error {
  constructor(readonly status: number) {
    super(`the FCM token endpoint refused the service account assertion (${status})`);
    this.name = "FcmCredentialError";
  }
}
