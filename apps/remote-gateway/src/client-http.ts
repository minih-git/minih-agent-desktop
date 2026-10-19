/**
 * The Gateway client API: `RACP-HTTP` commands, SSE streams, pairing, and the
 * account directory (protocol §11.2 / §11.4 / §11.5, security §3.1, §3.7, §3.8,
 * §5.2, gates 24–25, 29–31).
 *
 * Two authentication profiles are supported. Native clients send
 * `Authorization: Bearer <device token>`; browsers send the `HttpOnly` device
 * cookie plus, on every mutation, an `x-csrf-token` header whose value is an
 * HMAC of the device id. A cookie request must also prove its Origin; only a
 * same-origin GET/HEAD — where a browser legitimately omits `Origin` and sends
 * `Sec-Fetch-Site: same-origin` — is exempt, so the H5 client can read and
 * stream without weakening the mutation rule. A credential in a URL is always
 * refused. The Gateway only checks the cached token hash for a fast reject:
 * the Host re-authenticates every relayed logical connection (S8).
 *
 * Account mode (D666) adds `POST /v1/account/login` and `GET /v1/account/hosts`
 * in their own namespace. An account session credential authenticates the
 * account directory only: `GET /v1/hosts` and every `/hosts/{hostId}/...` route
 * keep accepting device tokens exclusively, so an AccessKey never authorizes a
 * relayed Host operation.
 */
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";

import {
  RACP_ACCOUNT_SESSION_TOKEN_PREFIX,
  RACP_DEVICE_TOKEN_PREFIX,
  RACP_HTTP_CORS_ALLOW_HEADERS,
  RACP_HTTP_CORS_EXPOSE_HEADERS,
  RACP_HTTP_QUERY_PARAMS,
  RACP_HTTP_ROUTE_LIST,
  RACP_METHOD_HTTP_ROUTES,
  RACP_PAIRING_TOKEN_PREFIX,
  RacpPushRegistrationRequestSchema,
  type RacpGatewayHostSummary,
  type RacpHttpQueryParamType,
  type RacpHttpRouteName,
  type RacpPushRegistrationResponse,
} from "@minih-agent/shared";
import * as Value from "typebox/value";

import { ACCOUNT_COOKIE, type AccountSessionService } from "./account.js";
import type { DeviceRequestService } from "./device-requests.js";
import { peerAddress } from "./client-ip.js";
import type { ClientTlsOptions, ListenAddress } from "./config.js";
import { CSRF_COOKIE, DEVICE_COOKIE, csrfTokenFor, hashToken, type PairingService } from "./pairing.js";
import type { PushService } from "./push.js";
import type { GatewayLog } from "./router.js";
import { GatewayRpcError, type CommandRouter, type ConnectionIdentity, type LogicalConnectionPool } from "./router.js";
import type { AuditResult } from "./audit.js";
import type { RateLimiter } from "./rate-limit.js";
import type { GatewayAccountSessionRecord, GatewayStore } from "./store.js";
import { serveEventStream, type StreamSubscription } from "./sse.js";

const MAX_BODY_BYTES = 1024 * 1024;
const CREDENTIAL_QUERY = /(token|credential|secret|password|api[-_]?key|authorization)/i;
const JSON_RPC_APPLICATION_ERROR = -32000;
/** Query-string values that are a signed decimal integer, not `20.5` or `1e3`. */
const INTEGER_QUERY = /^-?\d+$/;

type HostRoute = {
  routeName: RacpHttpRouteName;
  httpMethod: "GET" | "POST";
  operation: string;
  pattern: RegExp;
  /** Positional capture names, in pattern order, starting with `hostId`. */
  params: string[];
  stream?: StreamSubscription["scope"];
};

/** Escape a REST template, then turn `{name}` into a capture group. */
function compileRoute(template: string): { pattern: RegExp; params: string[] } {
  const params: string[] = [];
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\\\{(\w+)\\\}/g, (_match, name: string) => {
    params.push(name);
    return "([^/]+)";
  });
  return { pattern: new RegExp(`^/hosts/([^/]+)${body}/?$`), params: ["hostId", ...params] };
}

/** Every host-scoped route of the shared table, compiled once. */
const HOST_ROUTES: HostRoute[] = (() => {
  const byRouteName = new Map<RacpHttpRouteName, string>();
  for (const [operation, routeName] of Object.entries(RACP_METHOD_HTTP_ROUTES)) {
    if (routeName) byRouteName.set(routeName, operation);
  }
  const routes: HostRoute[] = [];
  for (const [routeName, spec] of Object.entries(RACP_HTTP_ROUTE_LIST) as Array<[RacpHttpRouteName, string]>) {
    if (routeName === "hosts" || routeName === "pairDevice" || routeName === "capabilities") continue;
    // Event streams are not commands: they never travel through `request()`.
    const operation = routeName === "sessionEvents" || routeName === "hostEvents" ? "events/subscribe" : byRouteName.get(routeName);
    if (!operation) continue;
    const [httpMethod, template] = spec.split(" ") as ["GET" | "POST", string];
    const { pattern, params } = compileRoute(template);
    routes.push({
      routeName,
      httpMethod,
      operation,
      pattern,
      params,
      ...(routeName === "sessionEvents" ? { stream: "session" as const } : {}),
      ...(routeName === "hostEvents" ? { stream: "host" as const } : {}),
    });
  }
  return routes;
})();

const PAIR_ROUTE = /^\/v1\/hosts\/([^/]+)\/pair\/?$/;
/** Account directory routes (protocol §11.5); never host-scoped. */
const ACCOUNT_LOGIN_ROUTE = /^\/v1\/account\/login\/?$/;
const ACCOUNT_HOSTS_ROUTE = /^\/v1\/account\/hosts\/?$/;
const ACCOUNT_LOGOUT_ROUTE = /^\/v1\/account\/logout\/?$/;
const ACCOUNT_DEVICES_ROUTE = /^\/v1\/account\/devices\/?$/;
const ACCOUNT_DEVICE_STATUS_ROUTE = /^\/v1\/account\/devices\/([^/]+)\/?$/;
/**
 * Push registration (protocol §11.6, R5 PR-6). Device-token authenticated and
 * never host-scoped: a §11.4 device registers for its own Host, an account-mode
 * device for every Host of its account, and the Gateway decides which from the
 * credential rather than from anything the client says.
 */
const PUSH_REGISTRATION_ROUTE = /^\/v1\/push\/registration\/?$/;

type ResolvedAuth = {
  deviceId: string;
  hostId: string;
  /**
   * The account of an account-mode device (§11.5, D666). Such a device reaches
   * every Host of its account; a §11.4 device has none and stays bound to the
   * one Host it paired with.
   */
  accountId?: string;
  token: string;
  via: "header" | "cookie";
};

function sendJson(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

function errorPayload(error: GatewayRpcError, traceId: string): unknown {
  return {
    error: {
      code: JSON_RPC_APPLICATION_ERROR,
      message: error.message,
      data: error.toRemoteError(traceId),
    },
  };
}

/**
 * The one error response shape for the whole client API. `Retry-After` is set
 * only when the failure carries a hint, so a `RATE_LIMITED` answer — the
 * Gateway's own per-IP limit or the Router's `AUTH_LOCKED` lockout — tells the
 * caller how long to wait (RFC 9110, whole seconds).
 */
function sendError(response: ServerResponse, error: GatewayRpcError, traceId: string, cors: Record<string, string>): void {
  const retryAfter = error.retryAfterMs === undefined ? null : String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)));
  sendJson(response, error.code === "INTERNAL" ? 500 : error.status, errorPayload(error, traceId), {
    ...cors,
    ...(retryAfter ? { "retry-after": retryAfter } : {}),
  });
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && value) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new GatewayRpcError("PAYLOAD_TOO_LARGE", "the request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The request body parsed as JSON; an empty body is `null`. */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const raw = await readBody(request);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new GatewayRpcError("INVALID_ARGUMENT", "the request body is not JSON");
  }
}

/** Coerce one query value to the type the route declares, or reject it. */
function coerceQueryValue(key: string, type: RacpHttpQueryParamType, value: string): unknown {
  if (type === "integer") {
    if (!INTEGER_QUERY.test(value)) throw new GatewayRpcError("INVALID_ARGUMENT", `${key} must be an integer`);
    return Number(value);
  }
  if (type === "boolean") {
    if (value !== "true" && value !== "false") throw new GatewayRpcError("INVALID_ARGUMENT", `${key} must be true or false`);
    return value === "true";
  }
  return value;
}

/**
 * The non-path parameters of a GET route travel in the query string (spec
 * §11.2). Only the keys `RACP_HTTP_QUERY_PARAMS` declares for this route are
 * accepted, each exactly once: an unknown, repeated, or mistyped key is a
 * caller error, never a parameter the Gateway silently drops. The same rules
 * refuse a credential or an event cursor in a URL, whatever the method.
 */
function parseQueryParams(url: URL, route: HostRoute): Record<string, unknown> {
  const declared = RACP_HTTP_QUERY_PARAMS[route.routeName];
  const params: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (CREDENTIAL_QUERY.test(key)) {
      throw new GatewayRpcError("INVALID_ARGUMENT", `${route.operation} must never carry ${key} in the URL`);
    }
    const type = declared[key];
    if (type === undefined) {
      throw new GatewayRpcError("INVALID_ARGUMENT", `${route.operation} does not accept ${key} as a query parameter`);
    }
    if (params[key] !== undefined) {
      throw new GatewayRpcError("INVALID_ARGUMENT", `${route.operation} received ${key} more than once`);
    }
    params[key] = coerceQueryValue(key, type, value);
  }
  return params;
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * How much Origin evidence a request must carry (security §3.1, gate 24).
 *
 * `required` — browser pairing: an allowlisted Origin is mandatory.
 * `optional` — native clients and CORS preflights: Origin may be absent, but
 *   a present Origin must still be allowlisted.
 * `cookie` — the cookie credential profile: a browser omits Origin on a
 *   same-origin GET/HEAD (including `fetch`-based SSE), so exactly that shape
 *   is accepted without one; every other cookie request is refused.
 */
type OriginMode = "required" | "optional" | "cookie";

/**
 * A same-origin read: browsers send `Sec-Fetch-Site: same-origin` and drop
 * `Origin` on GET/HEAD, which is the shape a top-level H5 page produces for
 * every command and every event stream. Anything else — another fetch site, a
 * missing header, a mutation — keeps the mandatory-Origin rule.
 */
function isSameOriginRead(request: IncomingMessage): boolean {
  const method = (request.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const header = request.headers["sec-fetch-site"];
  const value = Array.isArray(header) ? header[0] : header;
  return value === "same-origin";
}

export type ClientHttpServerOptions = {
  store: GatewayStore;
  pool: LogicalConnectionPool;
  router: CommandRouter;
  pairing: PairingService;
  rateLimiter: RateLimiter;
  allowedOrigins: readonly string[];
  log: GatewayLog;
  version: string;
  /** Whether a Host currently holds a live link (host summaries and offline rejects). */
  isHostOnline: (hostId: string) => boolean;
  /**
   * The account directory (D666). Absent means account mode is off, and both
   * `/v1/account/*` routes answer `NOT_FOUND` like any other unknown path.
   */
  account?: AccountSessionService;
  /**
   * The account-mode device relay (D666). Absent means `/v1/account/devices`
   * answers `NOT_FOUND` like any other unknown path, and a `device.grant` a
   * Host sends is simply not handled.
   */
  deviceRequests?: DeviceRequestService;
  /**
   * The redacted push service (§11.6, R5 PR-6). Absent means push is off: both
   * `/v1/push/registration` routes answer `NOT_FOUND` like any other unknown
   * path, and no `host.notify` is relayed anywhere.
   */
  push?: PushService;
  /** Resolved client address (ADR decision 10); defaults to the TCP peer. */
  resolveClientIp?: (request: IncomingMessage) => string;
  now?: () => number;
};

export class ClientHttpServer {
  private server: HttpServer | null = null;

  constructor(private readonly options: ClientHttpServerOptions) {}

  async start(listen: ListenAddress, tls?: ClientTlsOptions, certificate?: { certificatePem: string; privateKeyPem: string }): Promise<{ host: string; port: number }> {
    const handler = (request: IncomingMessage, response: ServerResponse): void => {
      void this.handle(request, response).catch((error: unknown) => {
        this.options.log("error", "gateway client request failed", { error: String(error) });
        if (!response.headersSent) sendJson(response, 500, errorPayload(new GatewayRpcError("INTERNAL", "the Gateway failed to handle the request"), randomUUID()));
        else response.end();
      });
    };
    if (tls && !certificate) throw new Error("the client API TLS certificate was not loaded");
    const server = certificate ? createHttpsServer({ cert: certificate.certificatePem, key: certificate.privateKeyPem }, handler) : createHttpServer(handler);
    server.keepAliveTimeout = 65_000;
    server.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listen.port, listen.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address() as AddressInfo;
    return { host: listen.host, port: address.port };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private corsHeaders(request: IncomingMessage): Record<string, string> {
    const origin = request.headers.origin;
    // Never echo an origin outside the allowlist, and never use "*".
    if (!origin || !this.options.allowedOrigins.includes(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      // The client reads trace ids off failures; without this a cross-origin
      // caller sees null and loses the id the payload does not carry.
      "access-control-expose-headers": RACP_HTTP_CORS_EXPOSE_HEADERS.join(", "),
      vary: "origin",
    };
  }

  /**
   * The one Origin rule (security §3.1, gate 24). `authenticate()` calls it in
   * `cookie` mode too, so the pre-auth check and the credential check cannot
   * drift apart.
   */
  private assertOrigin(request: IncomingMessage, mode: OriginMode): string | null {
    const origin = request.headers.origin;
    if (origin) {
      if (!this.options.allowedOrigins.includes(origin)) {
        throw new GatewayRpcError("FORBIDDEN", "the request Origin is not allowed");
      }
      return origin;
    }
    if (mode === "required") throw new GatewayRpcError("FORBIDDEN", "a browser pairing request must carry an Origin");
    if (mode === "cookie" && !isSameOriginRead(request)) {
      throw new GatewayRpcError("FORBIDDEN", "a cookie-authenticated request must carry an Origin");
    }
    return null;
  }

  /** A credential never travels in the URL (security §3.1, gate 24). */
  private assertNoUrlCredential(rawUrl: string): void {
    const url = new URL(rawUrl, "http://gateway.local");
    const carriesCredential = (value: string): boolean =>
      value.includes(RACP_DEVICE_TOKEN_PREFIX) ||
      value.includes(RACP_PAIRING_TOKEN_PREFIX) ||
      value.includes(RACP_ACCOUNT_SESSION_TOKEN_PREFIX);
    if (url.search === "") {
      if (carriesCredential(url.pathname)) {
        throw new GatewayRpcError("UNAUTHORIZED", "a credential must never appear in a URL");
      }
      return;
    }
    for (const key of url.searchParams.keys()) {
      if (CREDENTIAL_QUERY.test(key) || [...url.searchParams.values()].some(carriesCredential)) {
        throw new GatewayRpcError("UNAUTHORIZED", "a credential must never appear in a URL");
      }
    }
  }

  private authenticate(request: IncomingMessage): ResolvedAuth {
    const headerToken = bearer(request.headers.authorization);
    const cookieToken = request.headers.cookie ? parseCookies(request.headers.cookie)[DEVICE_COOKIE] : undefined;
    const token = headerToken ?? cookieToken;
    if (!token) throw new GatewayRpcError("UNAUTHORIZED", "this request needs a device credential");
    if (!token.startsWith(RACP_DEVICE_TOKEN_PREFIX)) throw new GatewayRpcError("UNAUTHORIZED", "the credential is not a device token");
    const device = this.options.store.findDeviceByTokenHash(hashToken(token));
    if (!device || device.revokedAt) throw new GatewayRpcError("UNAUTHORIZED", "the device credential is unknown or revoked");
    // The cookie profile runs the same Origin rule as the pre-auth check; only
    // the header profile (a native client that never carries ambient cookies)
    // is exempt from it.
    if (headerToken === null) this.assertOrigin(request, "cookie");
    return {
      deviceId: device.deviceId,
      hostId: device.hostId,
      ...(device.accountId ? { accountId: device.accountId } : {}),
      token,
      via: headerToken ? "header" : "cookie",
    };
  }

  /** The account directory, or the `NOT_FOUND` a Gateway without it returns. */
  private accountService(): AccountSessionService {
    const account = this.options.account;
    if (!account) throw new GatewayRpcError("NOT_FOUND", "account mode is not configured on this Gateway");
    return account;
  }

  /** The account device relay, or the `NOT_FOUND` a Gateway without it returns. */
  private deviceService(): DeviceRequestService {
    const devices = this.options.deviceRequests;
    if (!devices) throw new GatewayRpcError("NOT_FOUND", "account mode is not configured on this Gateway");
    return devices;
  }

  /**
   * Whether this credential may act on `hostId`. A §11.4 device is bound to the
   * one Host it paired with; an account-mode device (§11.5) reaches every Host
   * of its own account. A foreign, unknown, and revoked Host are one refusal,
   * so the answer never discloses whether a Host exists.
   */
  private assertDeviceReachesHost(auth: ResolvedAuth, hostId: string): void {
    if (auth.accountId) {
      const host = this.options.store.findHost(hostId);
      if (!host || host.revokedAt || host.accountId !== auth.accountId) {
        throw new GatewayRpcError("FORBIDDEN", "this device is paired with another Host");
      }
      return;
    }
    if (auth.hostId !== hostId) throw new GatewayRpcError("FORBIDDEN", "this device is paired with another Host");
  }

  /**
   * The account session credential of a `/v1/account/*` request, resolved the
   * same two ways as a device credential. It never authorizes a host-scoped
   * route, which is why every refusal here is the same `UNAUTHORIZED`: a caller
   * cannot tell a foreign account's session from an unknown one (gate 29).
   */
  private authenticateAccount(request: IncomingMessage): { session: GatewayAccountSessionRecord; via: "header" | "cookie" } {
    const account = this.accountService();
    const headerToken = bearer(request.headers.authorization);
    const cookieToken = request.headers.cookie ? parseCookies(request.headers.cookie)[ACCOUNT_COOKIE] : undefined;
    const token = headerToken ?? cookieToken;
    if (!token) throw new GatewayRpcError("UNAUTHORIZED", "this request needs an account session credential");
    const session = account.authenticate(token);
    if (headerToken === null) this.assertOrigin(request, "cookie");
    return { session, via: headerToken ? "header" : "cookie" };
  }

  /** CSRF double submit: the header must equal HMAC(gateway-secret, credentialId). */
  private assertCsrf(request: IncomingMessage, via: "header" | "cookie", credentialId: string): void {
    if (via !== "cookie") return;
    const method = (request.method ?? "GET").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    const header = request.headers["x-csrf-token"];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || value !== csrfTokenFor(this.options.store.secret, credentialId)) {
      throw new GatewayRpcError("FORBIDDEN", "the CSRF token is missing or wrong");
    }
  }

  /** `principalId` is a device id or an account session id; `null` is unauthenticated. */
  private assertRateLimit(principalId: string | null, ip: string): void {
    const decision = this.options.rateLimiter.check(principalId, ip);
    if (decision.allowed) return;
    throw new GatewayRpcError("RATE_LIMITED", `retry in ${decision.retryAfterMs} ms`, true, decision.retryAfterMs);
  }

  /**
   * The tighter per-IP bucket that guards the device fan-out: one request asks
   * every Host of the account to interrupt its user, so it does not share the
   * budget of ordinary account reads (security §9).
   */
  private assertAccountDeviceRateLimit(ip: string): void {
    const decision = this.options.rateLimiter.checkAccountDevice(ip);
    if (decision.allowed) return;
    throw new GatewayRpcError("RATE_LIMITED", `retry in ${decision.retryAfterMs} ms`, true, decision.retryAfterMs);
  }

  /**
   * Account responses carry a session credential, a device token, or both, so
   * none of them may be stored by a cache on the way (gate 30).
   */
  private accountHeaders(cors: Record<string, string>): Record<string, string> {
    return { ...cors, "cache-control": "no-store" };
  }

  private resolveIp(request: IncomingMessage): string {
    return (this.options.resolveClientIp ?? peerAddress)(request);
  }

  private async audit(op: string, ip: string, result: AuditResult, extra: { hostId?: string; deviceId?: string; accountId?: string }): Promise<void> {
    await this.options.store.appendAudit({ op, ip, result, ...extra });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const traceId = randomUUID();
    response.setHeader("x-trace-id", traceId);
    const rawUrl = request.url ?? "/";
    const url = new URL(rawUrl, "http://gateway.local");
    const ip = this.resolveIp(request);
    const cors = this.corsHeaders(request);

    try {
      this.assertNoUrlCredential(rawUrl);
      if (request.method === "OPTIONS") {
        this.assertOrigin(request, "optional");
        response.writeHead(204, {
          ...cors,
          "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
          // One list, shared with the client that sends them: a header the
          // native app adds must never fail here first.
          "access-control-allow-headers": RACP_HTTP_CORS_ALLOW_HEADERS.join(", "),
          "access-control-max-age": "600",
        });
        response.end();
        return;
      }
      if (url.pathname === "/healthz") {
        if (request.method !== "GET") throw new GatewayRpcError("METHOD_NOT_FOUND", "healthz is a GET endpoint");
        sendJson(response, 200, { ok: true, version: this.options.version }, cors);
        return;
      }

      const pairMatch = PAIR_ROUTE.exec(url.pathname);
      if (pairMatch) {
        await this.handlePair(request, response, pairMatch[1] ?? "", ip, cors, traceId);
        return;
      }

      if (ACCOUNT_LOGIN_ROUTE.test(url.pathname)) {
        await this.handleAccountLogin(request, response, ip, cors, traceId);
        return;
      }

      if (ACCOUNT_HOSTS_ROUTE.test(url.pathname)) {
        await this.handleAccountHosts(request, response, ip, cors, traceId);
        return;
      }

      if (ACCOUNT_LOGOUT_ROUTE.test(url.pathname)) {
        await this.handleAccountLogout(request, response, ip, cors, traceId);
        return;
      }

      if (ACCOUNT_DEVICES_ROUTE.test(url.pathname)) {
        await this.handleAccountDeviceRequest(request, response, ip, cors, traceId);
        return;
      }

      const deviceStatus = ACCOUNT_DEVICE_STATUS_ROUTE.exec(url.pathname);
      if (deviceStatus) {
        await this.handleAccountDeviceStatus(request, response, decodeURIComponent(deviceStatus[1] ?? ""), ip, cors, traceId);
        return;
      }

      if (url.pathname === "/v1/hosts") {
        await this.handleHostList(request, response, ip, cors, traceId);
        return;
      }

      if (PUSH_REGISTRATION_ROUTE.test(url.pathname)) {
        await this.handlePushRegistration(request, response, ip, cors, traceId);
        return;
      }

      const candidates = HOST_ROUTES.filter((candidate) => candidate.pattern.test(url.pathname));
      if (candidates.length === 0) throw new GatewayRpcError("NOT_FOUND", `no gateway route for ${url.pathname}`);
      const route = candidates.find((candidate) => candidate.httpMethod === request.method);
      if (!route) {
        const allowed = candidates.map((candidate) => candidate.httpMethod).join(" or ");
        throw new GatewayRpcError("METHOD_NOT_FOUND", `${url.pathname} is ${allowed}`);
      }
      const match = route.pattern.exec(url.pathname);
      const values = (match?.slice(1) ?? []).map((value) => decodeURIComponent(value));
      const pathParams = Object.fromEntries(route.params.map((name, index) => [name, values[index] ?? ""]));
      const hostId = pathParams["hostId"] ?? "";
      if (!hostId) throw new GatewayRpcError("INVALID_ARGUMENT", "the request names no Host");
      // The query string is the only carrier of a GET route's non-path
      // parameters, so it is validated before anything is authenticated.
      const queryParams = parseQueryParams(url, route);

      this.assertOrigin(request, "optional");
      const auth = this.authenticate(request);
      this.assertCsrf(request, auth.via, auth.deviceId);
      this.assertDeviceReachesHost(auth, hostId);
      const identity: ConnectionIdentity = {
        hostId,
        deviceId: auth.deviceId,
        credential: auth.token,
        // An account-mode device is the only one a Host can legitimately have
        // not adopted yet (§11.5), and the answer to its refusal differs.
        ...(auth.accountId ? { accountDevice: true } : {}),
      };

      if (route.stream) {
        const subscription: StreamSubscription =
          route.stream === "session"
            ? { scope: "session", sessionId: pathParams["sessionId"] ?? "" }
            : { scope: "host" };
        if (subscription.scope === "session" && !subscription.sessionId) {
          throw new GatewayRpcError("INVALID_ARGUMENT", "the event stream names no session");
        }
        this.assertRateLimit(auth.deviceId, ip);
        await this.audit(route.operation, ip, "ok", { hostId, deviceId: auth.deviceId });
        const lastEventId = request.headers["last-event-id"];
        await serveEventStream({
          request,
          response,
          pool: this.options.pool,
          identity,
          subscription,
          lastEventId: Array.isArray(lastEventId) ? (lastEventId[0] ?? null) : (lastEventId ?? null),
          log: this.options.log,
          corsHeaders: cors,
        });
        return;
      }

      const body = await readBody(request);
      let parsed: unknown = null;
      try {
        parsed = body ? (JSON.parse(body) as unknown) : null;
      } catch {
        throw new GatewayRpcError("INVALID_ARGUMENT", "the request body is not JSON");
      }
      // A GET route carries no body: the mapping itself names the operation.
      if (parsed === null && route.httpMethod !== "GET") {
        throw new GatewayRpcError("INVALID_ARGUMENT", "the request body must be a command object");
      }
      if (parsed !== null && !isRecord(parsed)) {
        throw new GatewayRpcError("INVALID_ARGUMENT", "the request body must be a command object");
      }
      const command = isRecord(parsed) ? parsed : {};
      if (command["method"] !== undefined && command["method"] !== route.operation) {
        throw new GatewayRpcError("INVALID_ARGUMENT", `this route carries ${route.operation}`);
      }
      const params = isRecord(command["params"]) ? command["params"] : {};
      // Query parameters follow the body and path parameters override both:
      // the path is the authoritative location of its own ids.
      const forwarded: Record<string, unknown> = { ...params, ...queryParams };
      for (const [name, value] of Object.entries(pathParams)) {
        if (name === "hostId") continue;
        if (forwarded[name] !== undefined && forwarded[name] !== value) {
          throw new GatewayRpcError("INVALID_ARGUMENT", `${name} disagrees with the request path`);
        }
        forwarded[name] = value;
      }
      this.assertRateLimit(auth.deviceId, ip);
      const idempotencyKey = command["idempotencyKey"];
      const outcome = await this.options.router.run({
        identity,
        method: route.operation,
        params: forwarded,
        ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
      });
      await this.audit(route.operation, ip, "ok", { hostId, deviceId: auth.deviceId });
      sendJson(response, outcome.status, outcome.payload, cors);
    } catch (error) {
      const rpc = error instanceof GatewayRpcError ? error : new GatewayRpcError("INTERNAL", "the Gateway failed to handle the request");
      if (!(error instanceof GatewayRpcError)) this.options.log("error", "gateway request failed", { traceId, error: String(error) });
      await this.audit("request", ip, rpc.code === "INTERNAL" ? "error" : "denied", {});
      if (response.headersSent) {
        response.end();
        return;
      }
      sendError(response, rpc, traceId, cors);
    }
  }

  /**
   * `PUT` / `DELETE /v1/push/registration` (protocol §11.6, R5 PR-6).
   *
   * A device token is the credential, so this route is not host-scoped: the
   * Gateway derives the audience from the credential — one Host for a §11.4
   * device, the account's live Hosts for an account-mode device — instead of
   * trusting the body. With no provider configured the answer is `enabled:
   * false` and nothing is stored, which is what "push is off" means to a client.
   */
  private async handlePushRegistration(
    request: IncomingMessage,
    response: ServerResponse,
    ip: string,
    cors: Record<string, string>,
    traceId: string,
  ): Promise<void> {
    try {
      const method = (request.method ?? "GET").toUpperCase();
      if (method !== "PUT" && method !== "DELETE") {
        throw new GatewayRpcError("METHOD_NOT_FOUND", "/v1/push/registration is PUT or DELETE");
      }
      this.assertOrigin(request, "optional");
      const auth = this.authenticate(request);
      this.assertCsrf(request, auth.via, auth.deviceId);
      this.assertRateLimit(auth.deviceId, ip);
      const push = this.options.push;
      if (!push) throw new GatewayRpcError("NOT_FOUND", "no gateway route for /v1/push/registration");

      if (method === "DELETE") {
        const removed = await this.options.store.removePushRegistration(auth.deviceId);
        await this.audit("push.registration.remove", ip, "ok", {
          deviceId: auth.deviceId,
          ...(auth.accountId ? { accountId: auth.accountId } : { hostId: auth.hostId }),
        });
        sendJson(response, 200, { result: { removed } }, this.accountHeaders(cors));
        return;
      }

      const body = await readBody(request);
      let parsed: unknown = null;
      try {
        parsed = body ? (JSON.parse(body) as unknown) : null;
      } catch {
        throw new GatewayRpcError("INVALID_ARGUMENT", "the request body is not JSON");
      }
      if (!Value.Check(RacpPushRegistrationRequestSchema, parsed)) {
        throw new GatewayRpcError("INVALID_ARGUMENT", "the push registration is malformed");
      }
      const registration = parsed;
      // Push off: answer the truth and store nothing, so a client can stop
      // asking instead of believing a registration exists.
      if (!push.enabled) {
        await this.audit("push.registration", ip, "denied", { deviceId: auth.deviceId });
        const answer: RacpPushRegistrationResponse = { enabled: false, platform: registration.platform, hostIds: [] };
        sendJson(response, 200, { result: answer }, this.accountHeaders(cors));
        return;
      }
      const platforms = push.platforms();
      if (registration.platform === "ios" ? !platforms.ios : !platforms.android) {
        // The Gateway is configured for the other family. Registering anyway
        // would store a token nothing can ever deliver to.
        await this.audit("push.registration", ip, "denied", { deviceId: auth.deviceId });
        throw new GatewayRpcError(
          "CAPABILITY_UNAVAILABLE",
          `this Gateway is not configured for ${registration.platform} push`,
        );
      }
      const audience = push.registrationAudience({
        deviceId: auth.deviceId,
        hostId: auth.hostId,
        ...(auth.accountId ? { accountId: auth.accountId } : {}),
      });
      const now = new Date(this.options.now ? this.options.now() : Date.now()).toISOString();
      const existing = this.options.store.findPushRegistration(auth.deviceId);
      const saved = await this.options.store.savePushRegistration({
        deviceId: auth.deviceId,
        ...(audience.accountId ? { accountId: audience.accountId } : {}),
        hostId: audience.hostId,
        hostIds: audience.hostIds,
        platform: registration.platform,
        token: registration.token,
        ...(registration.appId ? { appId: registration.appId } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      if (!saved) {
        // The device was revoked while this request's body was being read. Its
        // registrations went with it, and writing this one back would resume
        // pushes to a device the user has already taken away.
        await this.audit("push.registration", ip, "denied", { deviceId: auth.deviceId });
        throw new GatewayRpcError("UNAUTHORIZED", "the device credential is unknown or revoked");
      }
      await this.audit("push.registration", ip, "ok", {
        deviceId: auth.deviceId,
        ...(auth.accountId ? { accountId: auth.accountId } : { hostId: auth.hostId }),
      });
      const answer: RacpPushRegistrationResponse = {
        enabled: true,
        platform: registration.platform,
        hostIds: audience.hostIds,
      };
      sendJson(response, 200, { result: answer }, this.accountHeaders(cors));
    } catch (error) {
      const rpc = error instanceof GatewayRpcError ? error : new GatewayRpcError("INTERNAL", "the Gateway failed to handle the push registration");
      if (!(error instanceof GatewayRpcError)) this.options.log("error", "gateway push registration failed", { traceId, error: String(error) });
      sendError(response, rpc, traceId, cors);
    }
  }

  private async handleHostList(
    request: IncomingMessage,
    response: ServerResponse,
    ip: string,
    cors: Record<string, string>,
    traceId: string,
  ): Promise<void> {
    try {
      if (request.method !== "GET") throw new GatewayRpcError("METHOD_NOT_FOUND", "host/list is a GET endpoint");
      this.assertOrigin(request, "optional");
      const auth = this.authenticate(request);
      this.assertRateLimit(auth.deviceId, ip);
      const summarise = (hostId: string): RacpGatewayHostSummary | null => {
        const host = this.options.store.findHost(hostId);
        if (!host || host.revokedAt) return null;
        return {
          hostId: host.hostId,
          label: host.label,
          online: this.options.isHostOnline(host.hostId),
          ...(host.lastSeenAt ? { lastSeenAt: host.lastSeenAt } : {}),
        };
      };
      // An account-mode device works on every Host of its account, so its host
      // list is the account's (§11.5); a §11.4 device still sees its one Host.
      const hosts = auth.accountId
        ? this.options.store
            .listHostsForAccount(auth.accountId)
            .map((entry) => summarise(entry.hostId))
            .filter((summary): summary is RacpGatewayHostSummary => summary !== null)
        : [summarise(auth.hostId)].filter((summary): summary is RacpGatewayHostSummary => summary !== null);
      if (hosts.length === 0) throw new GatewayRpcError("UNAUTHORIZED", "this device's Host is gone");
      await this.audit("host/list", ip, "ok", {
        deviceId: auth.deviceId,
        ...(auth.accountId ? { accountId: auth.accountId } : { hostId: auth.hostId }),
      });
      sendJson(response, 200, { result: { hosts } }, cors);
    } catch (error) {
      const rpc = error instanceof GatewayRpcError ? error : new GatewayRpcError("INTERNAL", "the Gateway failed to list hosts");
      sendError(response, rpc, traceId, cors);
    }
  }

  /**
   * `POST /v1/account/login` (protocol §11.5). The Router AccessKey travels in
   * the `Authorization` header only, is verified against the Router over
   * loopback, and is never stored, logged, or echoed; the response carries the
   * account session credential as a cookie pair for a browser and in the body
   * for a native client.
   */
  private async handleAccountLogin(
    request: IncomingMessage,
    response: ServerResponse,
    ip: string,
    cors: Record<string, string>,
    traceId: string,
  ): Promise<void> {
    try {
      if (request.method !== "POST") throw new GatewayRpcError("METHOD_NOT_FOUND", "account login is a POST endpoint");
      const accessKey = bearer(request.headers.authorization);
      if (!accessKey) {
        throw new GatewayRpcError("UNAUTHORIZED", "account login needs the Router AccessKey in the Authorization header");
      }
      const raw = await readBody(request);
      let body: unknown = null;
      try {
        body = raw ? (JSON.parse(raw) as unknown) : null;
      } catch {
        throw new GatewayRpcError("INVALID_ARGUMENT", "the login body is not JSON");
      }
      // A browser login follows the pairing route's browser rules: the cookie
      // profile needs an allowlisted Origin before the key is even verified.
      const client = isRecord(body) ? body["client"] : undefined;
      this.assertOrigin(request, client === "web" ? "required" : "optional");
      const outcome = await this.accountService().login({ accessKey, body, ip });
      // One Set-Cookie header per cookie: browsers reject a folded value.
      if (outcome.cookies.length > 0) response.setHeader("set-cookie", outcome.cookies);
      sendJson(response, outcome.status, outcome.payload, this.accountHeaders(cors));
    } catch (error) {
      const rpc = error instanceof GatewayRpcError ? error : new GatewayRpcError("INTERNAL", "the Gateway failed to start an account session");
      if (!(error instanceof GatewayRpcError)) {
        this.options.log("error", "gateway account login failed", { traceId, error: String(error) });
      }
      sendError(response, rpc, traceId, cors);
    }
  }

  /**
   * `GET /v1/account/hosts` (protocol §11.5): the Hosts of the caller's own
   * account and only those. The route is account-scoped and takes no host id, so
   * a foreign Host cannot be named here at all (gate 29); naming one on a
   * host-scoped route instead fails the device-token check with the same
   * `UNAUTHORIZED` a nonexistent Host produces.
   */
  private async handleAccountHosts(
    request: IncomingMessage,
    response: ServerResponse,
    ip: string,
    cors: Record<string, string>,
    traceId: string,
  ): Promise<void> {
    try {
      if (request.method !== "GET") throw new GatewayRpcError("METHOD_NOT_FOUND", "the account host list is a GET endpoint");
      this.assertOrigin(request, "optional");
      const { session, via } = this.authenticateAccount(request);
      this.assertCsrf(request, via, session.sessionId);
      this.assertRateLimit(`account:${session.sessionId}`, ip);
      const outcome = await this.accountService().listHosts({ session, ip, isHostOnline: this.options.isHostOnline });
      sendJson(response, outcome.status, outcome.payload, this.accountHeaders(cors));
    } catch (error) {
      const rpc = error instanceof GatewayRpcError ? error : new GatewayRpcError("INTERNAL", "the Gateway failed to list account hosts");
      sendError(response, rpc, traceId, cors);
    }
  }

  /**
   * `POST /v1/account/logout` (protocol §11.5): end the caller's own account
   * session. JavaScript cannot delete an `HttpOnly` cookie, so this route is
   * the only way for a browser to drop the account credential its login left
   * behind once the device token has been issued. The device token is a
   * separate credential and is not touched.
   */
  private async handleAccountLogout(
    request: IncomingMessage,
    response: ServerResponse,
    ip: string,
    cors: Record<string, string>,
    traceId: string,
  ): Promise<void> {
    try {
      if (request.method !== "POST") throw new GatewayRpcError("METHOD_NOT_FOUND", "account logout is a POST endpoint");
      this.assertOrigin(request, "optional");
      const { session, via } = this.authenticateAccount(request);
      this.assertCsrf(request, via, session.sessionId);
      this.assertRateLimit(`account:${session.sessionId}`, ip);
      const outcome = await this.accountService().logout({ session, ip });
      // One Set-Cookie header per cookie: browsers reject a folded value.
      if (outcome.cookies.length > 0) response.setHeader("set-cookie", outcome.cookies);
      sendJson(response, outcome.status, outcome.payload, this.accountHeaders(cors));
    } catch (error) {
      const rpc = error instanceof GatewayRpcError ? error : new GatewayRpcError("INTERNAL", "the Gateway failed to end the account session");
      sendError(response, rpc, traceId, cors);
    }
  }

  /**
   * `POST /v1/account/devices` (protocol §11.5): ask the account's Hosts to
   * approve a new device. The route takes the account session credential, never
   * a device token, and answers the account's roster, so the client learns at
   * once which Hosts cannot confirm instead of waiting for an answer that
   * cannot come (security gate 33).
   */
  private async handleAccountDeviceRequest(
    request: IncomingMessage,
    response: ServerResponse,
    ip: string,
    cors: Record<string, string>,
    traceId: string,
  ): Promise<void> {
    try {
      if (request.method !== "POST") throw new GatewayRpcError("METHOD_NOT_FOUND", "a device request is a POST endpoint");
      this.assertOrigin(request, "optional");
      const { session, via } = this.authenticateAccount(request);
      this.assertCsrf(request, via, session.sessionId);
      this.assertAccountDeviceRateLimit(ip);
      const outcome = await this.deviceService().request({ session, body: await readJsonBody(request), ip });
      sendJson(response, outcome.status, outcome.payload, this.accountHeaders(cors));
    } catch (error) {
      const rpc = error instanceof GatewayRpcError ? error : new GatewayRpcError("INTERNAL", "the Gateway failed to start the device request");
      sendError(response, rpc, traceId, cors);
    }
  }

  /**
   * `GET /v1/account/devices/{requestId}` (protocol §11.5): the outcome of one
   * device request, and the device token once a Host approved. A request of
   * another account answers the same `NOT_FOUND` as an unknown one, so this
   * route discloses nothing across accounts (gate 29).
   */
  private async handleAccountDeviceStatus(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    ip: string,
    cors: Record<string, string>,
    traceId: string,
  ): Promise<void> {
    try {
      if (request.method !== "GET") throw new GatewayRpcError("METHOD_NOT_FOUND", "a device status is a GET endpoint");
      this.assertOrigin(request, "optional");
      const { session, via } = this.authenticateAccount(request);
      this.assertCsrf(request, via, session.sessionId);
      this.assertRateLimit(`account:${session.sessionId}`, ip);
      if (!requestId) throw new GatewayRpcError("INVALID_ARGUMENT", "the request names no device request");
      const outcome = await this.deviceService().status({ session, requestId, ip });
      // A browser session receives the device token as per-Host `HttpOnly`
      // cookies here, exactly as the pairing route hands one over.
      if (outcome.cookies.length > 0) response.setHeader("set-cookie", outcome.cookies);
      sendJson(response, outcome.status, outcome.payload, this.accountHeaders(cors));
    } catch (error) {
      const rpc = error instanceof GatewayRpcError ? error : new GatewayRpcError("INTERNAL", "the Gateway failed to read the device request");
      sendError(response, rpc, traceId, cors);
    }
  }

  private async handlePair(
    request: IncomingMessage,
    response: ServerResponse,
    hostId: string,
    ip: string,
    cors: Record<string, string>,
    traceId: string,
  ): Promise<void> {
    try {
      if (request.method !== "POST") throw new GatewayRpcError("METHOD_NOT_FOUND", "pairing is a POST endpoint");
      const token = bearer(request.headers.authorization);
      if (!token || !token.startsWith(RACP_PAIRING_TOKEN_PREFIX)) {
        throw new GatewayRpcError("UNAUTHORIZED", "pairing needs the Host's pairing token in the Authorization header");
      }
      const host = this.options.store.findHost(hostId);
      if (!host || host.revokedAt) throw new GatewayRpcError("NOT_FOUND", `Host ${hostId} is not registered`);
      const raw = await readBody(request);
      let body: unknown = null;
      try {
        body = raw ? (JSON.parse(raw) as unknown) : null;
      } catch {
        throw new GatewayRpcError("INVALID_ARGUMENT", "the pairing body is not JSON");
      }
      const client = isRecord(body) ? body["client"] : undefined;
      this.assertOrigin(request, client === "web" ? "required" : "optional");
      this.assertRateLimit(null, ip);
      const outcome = await this.options.pairing.pair({ hostId, pairingToken: token, body, ip });
      // One Set-Cookie header per cookie: browsers reject a folded value.
      if (outcome.cookies.length > 0) response.setHeader("set-cookie", outcome.cookies);
      sendJson(response, outcome.status, outcome.payload, cors);
    } catch (error) {
      const rpc = error instanceof GatewayRpcError ? error : new GatewayRpcError("INTERNAL", "the Gateway failed to pair the device");
      if (!(error instanceof GatewayRpcError)) this.options.log("error", "gateway pairing failed", { traceId, error: String(error) });
      sendError(response, rpc, traceId, cors);
    }
  }
}

export const CLIENT_COOKIE = { device: DEVICE_COOKIE, csrf: CSRF_COOKIE };

/** The host-scoped route table, for the conformance test and `--help` output. */
export function gatewayHostRoutes(): ReadonlyArray<Pick<HostRoute, "routeName" | "httpMethod" | "operation">> {
  return HOST_ROUTES.map(({ routeName, httpMethod, operation }) => ({ routeName, httpMethod, operation }));
}
