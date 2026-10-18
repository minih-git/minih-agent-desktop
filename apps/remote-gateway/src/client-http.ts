/**
 * The Gateway client API: `RACP-HTTP` commands, SSE streams, and pairing
 * (protocol §11.2 / §11.4, security §3.1, §3.7, §5.2, gates 24–25).
 *
 * Two authentication profiles are supported. Native clients send
 * `Authorization: Bearer <device token>`; browsers send the `HttpOnly` device
 * cookie plus, on every mutation, an `x-csrf-token` header whose value is an
 * HMAC of the device id. A credential in a URL is always refused. The Gateway
 * only checks the cached token hash for a fast reject: the Host re-authenticates
 * every relayed logical connection (S8).
 */
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";

import {
  RACP_DEVICE_TOKEN_PREFIX,
  RACP_HTTP_QUERY_PARAMS,
  RACP_HTTP_ROUTE_LIST,
  RACP_METHOD_HTTP_ROUTES,
  RACP_PAIRING_TOKEN_PREFIX,
  type RacpGatewayHostSummary,
  type RacpHttpQueryParamType,
  type RacpHttpRouteName,
} from "@minih-agent/shared";

import type { ClientTlsOptions, ListenAddress } from "./config.js";
import { CSRF_COOKIE, DEVICE_COOKIE, csrfTokenFor, hashToken, type PairingService } from "./pairing.js";
import type { GatewayLog } from "./router.js";
import { GatewayRpcError, type CommandRouter, type ConnectionIdentity, type LogicalConnectionPool } from "./router.js";
import type { AuditResult } from "./audit.js";
import type { RateLimiter } from "./rate-limit.js";
import type { GatewayStore } from "./store.js";
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

type ResolvedAuth = { deviceId: string; hostId: string; token: string; via: "header" | "cookie" };

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

function clientIp(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
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
      vary: "origin",
    };
  }

  private assertOrigin(request: IncomingMessage, requireOrigin: boolean): string | null {
    const origin = request.headers.origin;
    if (!origin) {
      if (requireOrigin) throw new GatewayRpcError("FORBIDDEN", "a cookie-authenticated request must carry an Origin");
      return null;
    }
    if (!this.options.allowedOrigins.includes(origin)) {
      throw new GatewayRpcError("FORBIDDEN", "the request Origin is not allowed");
    }
    return origin;
  }

  /** A credential never travels in the URL (security §3.1, gate 24). */
  private assertNoUrlCredential(rawUrl: string): void {
    const url = new URL(rawUrl, "http://gateway.local");
    if (url.search === "") {
      if (url.pathname.includes(RACP_DEVICE_TOKEN_PREFIX) || url.pathname.includes(RACP_PAIRING_TOKEN_PREFIX)) {
        throw new GatewayRpcError("UNAUTHORIZED", "a credential must never appear in a URL");
      }
      return;
    }
    for (const key of url.searchParams.keys()) {
      if (CREDENTIAL_QUERY.test(key) || [...url.searchParams.values()].some((value) => value.startsWith(RACP_DEVICE_TOKEN_PREFIX) || value.startsWith(RACP_PAIRING_TOKEN_PREFIX))) {
        throw new GatewayRpcError("UNAUTHORIZED", "a credential must never appear in a URL");
      }
    }
  }

  private authenticate(request: IncomingMessage, origin: string | null): ResolvedAuth {
    const headerToken = bearer(request.headers.authorization);
    const cookieToken = request.headers.cookie ? parseCookies(request.headers.cookie)[DEVICE_COOKIE] : undefined;
    const token = headerToken ?? cookieToken;
    if (!token) throw new GatewayRpcError("UNAUTHORIZED", "this request needs a device credential");
    if (!token.startsWith(RACP_DEVICE_TOKEN_PREFIX)) throw new GatewayRpcError("UNAUTHORIZED", "the credential is not a device token");
    const device = this.options.store.findDeviceByTokenHash(hashToken(token));
    if (!device || device.revokedAt) throw new GatewayRpcError("UNAUTHORIZED", "the device credential is unknown or revoked");
    if (headerToken === null) {
      // The cookie profile: Origin is mandatory and every mutation carries CSRF.
      if (!origin) throw new GatewayRpcError("FORBIDDEN", "a cookie-authenticated request must carry an Origin");
    }
    return { deviceId: device.deviceId, hostId: device.hostId, token, via: headerToken ? "header" : "cookie" };
  }

  /** CSRF double submit: the header must equal HMAC(gateway-secret, deviceId). */
  private assertCsrf(request: IncomingMessage, auth: ResolvedAuth): void {
    if (auth.via !== "cookie") return;
    const method = (request.method ?? "GET").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    const header = request.headers["x-csrf-token"];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || value !== csrfTokenFor(this.options.store.secret, auth.deviceId)) {
      throw new GatewayRpcError("FORBIDDEN", "the CSRF token is missing or wrong");
    }
  }

  private assertRateLimit(auth: ResolvedAuth | null, ip: string): void {
    const decision = this.options.rateLimiter.check(auth?.deviceId ?? null, ip);
    if (decision.allowed) return;
    throw new GatewayRpcError("RATE_LIMITED", `retry in ${decision.retryAfterMs} ms`, true);
  }

  private async audit(op: string, ip: string, result: AuditResult, extra: { hostId?: string; deviceId?: string }): Promise<void> {
    await this.options.store.appendAudit({ op, ip, result, ...extra });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const traceId = randomUUID();
    response.setHeader("x-trace-id", traceId);
    const rawUrl = request.url ?? "/";
    const url = new URL(rawUrl, "http://gateway.local");
    const ip = clientIp(request);
    const cors = this.corsHeaders(request);

    try {
      this.assertNoUrlCredential(rawUrl);
      if (request.method === "OPTIONS") {
        this.assertOrigin(request, false);
        response.writeHead(204, {
          ...cors,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, x-csrf-token, last-event-id",
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

      if (url.pathname === "/v1/hosts") {
        await this.handleHostList(request, response, ip, cors, traceId);
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

      const origin = this.assertOrigin(request, false);
      const auth = this.authenticate(request, origin);
      this.assertCsrf(request, auth);
      if (auth.hostId !== hostId) throw new GatewayRpcError("FORBIDDEN", "this device is paired with another Host");
      const identity: ConnectionIdentity = { hostId, deviceId: auth.deviceId, credential: auth.token };

      if (route.stream) {
        const subscription: StreamSubscription =
          route.stream === "session"
            ? { scope: "session", sessionId: pathParams["sessionId"] ?? "" }
            : { scope: "host" };
        if (subscription.scope === "session" && !subscription.sessionId) {
          throw new GatewayRpcError("INVALID_ARGUMENT", "the event stream names no session");
        }
        this.assertRateLimit(auth, ip);
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
      this.assertRateLimit(auth, ip);
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
      const status = rpc.code === "INTERNAL" ? 500 : rpc.status;
      sendJson(response, status, errorPayload(rpc, traceId), cors);
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
      const origin = this.assertOrigin(request, false);
      const auth = this.authenticate(request, origin);
      this.assertRateLimit(auth, ip);
      const host = this.options.store.findHost(auth.hostId);
      if (!host || host.revokedAt) throw new GatewayRpcError("UNAUTHORIZED", "this device's Host is gone");
      const summary: RacpGatewayHostSummary = {
        hostId: host.hostId,
        label: host.label,
        online: this.options.isHostOnline(host.hostId),
        ...(host.lastSeenAt ? { lastSeenAt: host.lastSeenAt } : {}),
      };
      await this.audit("host/list", ip, "ok", { hostId: host.hostId, deviceId: auth.deviceId });
      sendJson(response, 200, { result: { hosts: [summary] } }, cors);
    } catch (error) {
      const rpc = error instanceof GatewayRpcError ? error : new GatewayRpcError("INTERNAL", "the Gateway failed to list hosts");
      sendJson(response, rpc.code === "INTERNAL" ? 500 : rpc.status, errorPayload(rpc, traceId), cors);
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
      const origin = this.assertOrigin(request, client === "web");
      if (origin === null && client === "web") throw new GatewayRpcError("FORBIDDEN", "a browser pairing needs an allowed Origin");
      this.assertRateLimit(null, ip);
      const outcome = await this.options.pairing.pair({ hostId, pairingToken: token, body, ip });
      // One Set-Cookie header per cookie: browsers reject a folded value.
      if (outcome.cookies.length > 0) response.setHeader("set-cookie", outcome.cookies);
      sendJson(response, outcome.status, outcome.payload, cors);
    } catch (error) {
      const rpc = error instanceof GatewayRpcError ? error : new GatewayRpcError("INTERNAL", "the Gateway failed to pair the device");
      if (!(error instanceof GatewayRpcError)) this.options.log("error", "gateway pairing failed", { traceId, error: String(error) });
      sendJson(response, rpc.code === "INTERNAL" ? 500 : rpc.status, errorPayload(rpc, traceId), cors);
    }
  }
}

export const CLIENT_COOKIE = { device: DEVICE_COOKIE, csrf: CSRF_COOKIE };

/** The host-scoped route table, for the conformance test and `--help` output. */
export function gatewayHostRoutes(): ReadonlyArray<Pick<HostRoute, "routeName" | "httpMethod" | "operation">> {
  return HOST_ROUTES.map(({ routeName, httpMethod, operation }) => ({ routeName, httpMethod, operation }));
}
