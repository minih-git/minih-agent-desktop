/**
 * The Gateway's `RACP-WS` client route: `GET /v1/hosts/{hostId}/ws`
 * (protocol §11.2 Gateway mapping, §11.4 rule 7; ADR
 * `remote-control-router-account-binding` amendment 3, rollout R8 package B).
 *
 * A client that already speaks `RACP-WS` — the desktop acting as a Remote
 * Client of a sibling computer — upgrades here and gets one logical connection
 * on the Host link, mapped 1:1. Frames are relayed verbatim in both directions,
 * including a server-initiated request (`approval/request`, `input/request`,
 * `tool/execute`) that the client must answer itself; the Gateway never
 * renumbers, coalesces, re-keys, or answers on the client's behalf (§11.4
 * rule 3).
 *
 * Authorization is the device token, exactly as on the `RACP-HTTP` routes: the
 * same Bearer header profile, the same cached token-hash fast reject, the same
 * per-device rate limit, and the same audit record. A credential in the URL is
 * refused, and an `Origin` that is present must be one of the configured
 * origins (a native client sends none, and carries no ambient cookie).
 *
 * Every refusal is an HTTP status on the socket, never an exception: this
 * handler runs inside the listener's synchronous `upgrade` event, where a
 * thrown error would be an `uncaughtException` and would end the Gateway
 * process for any caller that sends a malformed path — with no credential at
 * all. A path this route cannot decode, or a Host id that is not one, is
 * therefore a `400 INVALID_ARGUMENT`.
 *
 * Ownership and cleanup (AGENTS.md §9): this module owns the WebSocket and its
 * logical connection. The logical connection is taken from the shared pool, so
 * revoking the device closes it (`closeForDevice`); losing the Host link closes
 * it from the Host side; the client closing closes it from this side. A slow
 * client is closed with `CLIENT_TOO_SLOW` rather than buffered without bound,
 * which keeps the resumable-cursor rule of §11.4 rule 3.
 *
 * One Gateway-side rule applies to what travels over the socket: a heartbeat
 * (protocol §11.1, 30 seconds) drops a client that stops answering pings. A
 * laptop that sleeps leaves a half-open socket the Gateway would otherwise
 * never notice, holding a Host-side logical connection and one of the device's
 * four relayed-connection slots forever.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { RACP_DEVICE_TOKEN_PREFIX, RACP_HOSTLINK_CLOSE_CODES, isRacpHostId } from "@minih-agent/shared";
import { WebSocketServer, type WebSocket } from "ws";

import { peerAddress } from "./client-ip.js";
import { bearerToken, hasUrlCredential } from "./client-request-rules.js";
import { hashToken } from "./pairing.js";
import type { RateLimiter } from "./rate-limit.js";
import { GatewayRpcError, type GatewayLog, type LogicalConnection, type LogicalConnectionPool } from "./router.js";
import type { GatewayStore } from "./store.js";

const WS_ROUTE = /^\/v1\/hosts\/([^/]+)\/ws\/?$/;
/** Bound on what one slow client may leave buffered before it is closed. */
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** RFC 6455 close codes: a normal end, a policy refusal, a retryable failure. */
const WS_NORMAL_CLOSURE = 1000;
const WS_POLICY_VIOLATION = 1008;
const WS_INTERNAL_ERROR = 1011;
const WS_TRY_AGAIN_LATER = 1013;
/** Causes this module and the pool produce; the Host link never sends them. */
const DEVICE_REVOKED = "device revoked";
const GATEWAY_STOPPING = "gateway stopping";
/**
 * A client that stopped answering pings. Nothing can be told to a half-open
 * socket, so the close frame is best-effort; what matters is that the Host-side
 * logical connection is released and the device's slot is freed.
 */
const CLIENT_UNRESPONSIVE = "client unresponsive";
/** Protocol §11.1 heartbeat target. */
const DEFAULT_HEARTBEAT_MS = 30_000;
/** Why a relay is refused: the device's own limit, or a Host that is not there. */
const CONNECTION_LIMIT_REASON = "this device already holds its maximum relayed connections";
const HOST_UNAVAILABLE_REASON = "the Host is unavailable";
/** Reason text of a WebSocket close is capped at 123 bytes by the frame. */
const MAX_CLOSE_REASON = 120;

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
};

export type ClientWsOptions = {
  store: GatewayStore;
  pool: LogicalConnectionPool;
  rateLimiter: RateLimiter;
  allowedOrigins: readonly string[];
  log: GatewayLog;
  /** Resolved client address (ADR decision 10); defaults to the TCP peer. */
  resolveClientIp?: (request: IncomingMessage) => string;
  /** Per-client outbound buffer bound in bytes before the socket is closed. */
  maxBufferedBytes?: number;
  /** Protocol §11.1 heartbeat interval; injectable so a test need not wait 30s. */
  heartbeatMs?: number;
};

export type ClientWsServer = {
  /** Handle one HTTP upgrade. Returns false when the path is not this route. */
  handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  /** Close every relayed client (gateway shutdown). */
  closeAll: () => void;
  /** Live client sockets, for tests and diagnostics. */
  size: () => number;
};

/**
 * What one refusal answers with. `ip` is required: the audit rule records the
 * client address on every refusal, including the ones that never reach a
 * credential check.
 */
type Refusal = {
  status: number;
  code: string;
  ip: string;
  hostId?: string;
  deviceId?: string;
  /** Whole seconds until the caller may retry, sent on a `429` (RFC 9110). */
  retryAfterSeconds?: number;
};

/**
 * The Host id of the request path, decoded and checked. Never throws: a
 * malformed percent-escape (`decodeURIComponent` raises `URIError`) and a value
 * that is not a Host id are both the caller's error, answered with a status
 * instead of an exception that would end the process.
 */
function decodeHostId(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return isRacpHostId(decoded) ? decoded : null;
}

/**
 * The WebSocket close code that mirrors a logical-connection close. A Host
 * that ends the connection normally is a normal close; a credential or route
 * the Host refuses, and a protocol violation, are policy refusals; a slow
 * client or a Gateway shutdown is worth retrying later. Anything else is an
 * unexpected condition, not a normal end.
 */
function closeCodeFor(cause: string): number {
  switch (cause) {
    case RACP_HOSTLINK_CLOSE_CODES.hostClosed:
    case RACP_HOSTLINK_CLOSE_CODES.clientClosed:
      return WS_NORMAL_CLOSURE;
    case RACP_HOSTLINK_CLOSE_CODES.clientTooSlow:
    case GATEWAY_STOPPING:
      return WS_TRY_AGAIN_LATER;
    case RACP_HOSTLINK_CLOSE_CODES.unauthorized:
    case RACP_HOSTLINK_CLOSE_CODES.routeContextRejected:
    case RACP_HOSTLINK_CLOSE_CODES.protocolError:
    case RACP_HOSTLINK_CLOSE_CODES.duplicateConnection:
    case DEVICE_REVOKED:
      return WS_POLICY_VIOLATION;
    case CLIENT_UNRESPONSIVE:
      return WS_INTERNAL_ERROR;
    default:
      return WS_INTERNAL_ERROR;
  }
}

/** One relayed client: the socket, its logical connection, and its heartbeat. */
type LiveRelay = {
  socket: WebSocket;
  connection: LogicalConnection;
  stopHeartbeat: () => void;
};

export function createClientWsServer(options: ClientWsOptions): ClientWsServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const live = new Set<LiveRelay>();
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const resolveIp = (request: IncomingMessage) => (options.resolveClientIp ?? peerAddress)(request);

  function refuse(socket: Duplex, refusal: Refusal): void {
    const { status, code, ip, hostId, deviceId, retryAfterSeconds } = refusal;
    options.log("info", "gateway ws upgrade refused", { status, code, ...(hostId ? { hostId } : {}) });
    void options.store
      .appendAudit({ op: "hosts.ws", ip, result: "denied", ...(hostId ? { hostId } : {}), ...(deviceId ? { deviceId } : {}) })
      .catch(() => undefined);
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const head = [`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}`, "connection: close"];
    if (retryAfterSeconds !== undefined) head.push(`retry-after: ${retryAfterSeconds}`);
    socket.write(`${head.join("\r\n")}\r\n\r\n`);
    socket.destroy();
  }

  function originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    const value = Array.isArray(origin) ? origin[0] : origin;
    if (!value) return true;
    return options.allowedOrigins.some((allowed) => allowed.replace(/\/$/, "").toLowerCase() === value.replace(/\/$/, "").toLowerCase());
  }

  function accept(request: IncomingMessage, socket: Duplex, head: Buffer, hostId: string, deviceId: string, token: string, ip: string, accountId?: string): void {
    wss.handleUpgrade(request, socket, head, (ws) => {
      let connection: LogicalConnection | null = null;
      let entry: LiveRelay | null = null;
      // The message listener is registered synchronously with the socket, so a
      // frame the client sends while `pool.relay()` is in flight is buffered
      // (bounded) and flushed in order instead of being dropped: the relay
      // must not depend on the order of microtasks.
      const buffered: string[] = [];
      let bufferedBytes = 0;

      /** Refuse on the socket itself, before a logical connection exists. */
      const refuseOnSocket = (reason: string): void => {
        if (ws.readyState === ws.OPEN) ws.close(WS_POLICY_VIOLATION, reason.slice(0, MAX_CLOSE_REASON));
        else ws.terminate();
      };

      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (isBinary) {
          // Attachment relay is deferred (ADR 0331); the Host refuses the
          // frame too, so the Gateway closes rather than dropping bytes.
          options.log("warn", "gateway ws refused a binary frame", { hostId, deviceId });
          if (connection) connection.close(RACP_HOSTLINK_CLOSE_CODES.protocolError);
          else refuseOnSocket("binary frames are not relayed");
          return;
        }
        const frame = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8");
        if (connection) {
          connection.sendRaw(frame);
          return;
        }
        bufferedBytes += Buffer.byteLength(frame);
        if (bufferedBytes > maxBufferedBytes) {
          options.log("warn", "gateway ws client overflowed before the relay opened", { hostId, deviceId });
          refuseOnSocket("the client sent too much before the relay opened");
          return;
        }
        buffered.push(frame);
      });
      ws.on("close", () => {
        if (entry) live.delete(entry);
        entry?.stopHeartbeat();
        connection?.close(RACP_HOSTLINK_CLOSE_CODES.clientClosed);
      });
      ws.on("error", (error) => {
        options.log("warn", "gateway ws socket error", { hostId, deviceId, error: String(error) });
        if (entry) live.delete(entry);
        entry?.stopHeartbeat();
        connection?.close("client error");
      });

      void (async () => {
        let opened: LogicalConnection;
        try {
          opened = await options.pool.relay({
            hostId,
            deviceId,
            credential: token,
            ...(accountId ? { accountDevice: true } : {}),
          });
        } catch (error) {
          // The relay failed for a reason the client must be able to tell
          // apart: its own connection count, or a Host that is not there.
          const limited = error instanceof GatewayRpcError && error.code === "RATE_LIMITED";
          const reason = limited ? CONNECTION_LIMIT_REASON : HOST_UNAVAILABLE_REASON;
          options.log(limited ? "warn" : "info", "gateway ws relay refused", {
            hostId,
            deviceId,
            reason,
            ...(error instanceof Error ? { error: error.message } : {}),
          });
          if (ws.readyState === ws.OPEN) ws.close(WS_TRY_AGAIN_LATER, reason.slice(0, MAX_CLOSE_REASON));
          return;
        }
        // The client may have gone while the relay was being opened; the
        // logical connection is this module's to release, not the Host's.
        if (ws.readyState !== ws.OPEN) {
          opened.close(RACP_HOSTLINK_CLOSE_CODES.clientClosed);
          return;
        }
        connection = opened;
        // Heartbeat (protocol §11.1): a client that stops answering pings has
        // gone away without closing the socket — a sleeping laptop, a network
        // switch, a NAT that dropped the flow — and the Gateway would otherwise
        // hold its logical connection and its slot forever.
        let alive = true;
        const heartbeat = setInterval(() => {
          if (ws.readyState !== ws.OPEN) return;
          if (!alive) {
            options.log("warn", "gateway ws client stopped answering pings", { hostId, deviceId, clientConnectionId: opened.id });
            opened.close(CLIENT_UNRESPONSIVE);
            ws.terminate();
            return;
          }
          alive = false;
          ws.ping();
        }, heartbeatMs);
        heartbeat.unref?.();
        ws.on("pong", () => {
          alive = true;
        });
        entry = { socket: ws, connection: opened, stopHeartbeat: () => clearInterval(heartbeat) };
        live.add(entry);
        options.log("info", "gateway ws relay established", { hostId, deviceId, clientConnectionId: opened.id });
        opened.attachRelay({
          onFrame: (frame) => {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(frame);
            // A client that cannot keep up is closed instead of buffered
            // without bound; the Host then ends the logical connection with a
            // resumable cursor (rule 3).
            if (ws.bufferedAmount > maxBufferedBytes) {
              options.log("warn", "gateway ws client too slow", { hostId, deviceId, clientConnectionId: opened.id });
              opened.close(RACP_HOSTLINK_CLOSE_CODES.clientTooSlow);
            }
          },
          onClose: (cause) => {
            if (entry) live.delete(entry);
            if (ws.readyState === ws.OPEN) ws.close(closeCodeFor(cause), cause.slice(0, MAX_CLOSE_REASON));
          },
        });
        for (const frame of buffered.splice(0)) opened.sendRaw(frame);
        bufferedBytes = 0;
      })();
    });
  }

  return {
    handleUpgrade(request, socket, head) {
      const rawUrl = request.url ?? "/";
      const ip = resolveIp(request);
      let pathname: string;
      try {
        pathname = new URL(rawUrl, "http://gateway.local").pathname;
      } catch {
        // Not a request target this Gateway can parse: the path cannot be the
        // route's, and the listener closes the socket.
        return false;
      }
      const match = WS_ROUTE.exec(pathname);
      if (!match) return false;
      const hostId = decodeHostId(match[1] ?? "");
      if (!hostId) {
        refuse(socket, { status: 400, code: "INVALID_ARGUMENT", ip });
        return true;
      }
      const token = bearerToken(request.headers.authorization);
      const device = token && token.startsWith(RACP_DEVICE_TOKEN_PREFIX) ? options.store.findDeviceByTokenHash(hashToken(token)) : undefined;

      if (hasUrlCredential(rawUrl)) {
        refuse(socket, { status: 401, code: "URL_CREDENTIAL", ip, hostId, ...(device ? { deviceId: device.deviceId } : {}) });
        return true;
      }
      if (!originAllowed(request)) {
        refuse(socket, { status: 403, code: "ORIGIN_NOT_ALLOWED", ip, hostId, ...(device ? { deviceId: device.deviceId } : {}) });
        return true;
      }
      if (!token) {
        refuse(socket, { status: 401, code: "NO_CREDENTIAL", ip, hostId });
        return true;
      }
      if (!token.startsWith(RACP_DEVICE_TOKEN_PREFIX) || !device || device.revokedAt) {
        refuse(socket, { status: 401, code: "UNKNOWN_DEVICE", ip, hostId, ...(device ? { deviceId: device.deviceId } : {}) });
        return true;
      }
      const host = options.store.findHost(hostId);
      // A revoked Host is refused in both branches: a §11.4 device must not
      // reach a Host the user has taken away any more than an account one.
      const reachesHost = device.accountId
        ? Boolean(host && !host.revokedAt && host.accountId === device.accountId)
        : device.hostId === hostId && Boolean(host && !host.revokedAt);
      if (!reachesHost) {
        refuse(socket, { status: 403, code: "WRONG_HOST", ip, hostId, deviceId: device.deviceId });
        return true;
      }
      const decision = options.rateLimiter.check(device.deviceId, ip);
      if (!decision.allowed) {
        // Same answer as the `RACP-HTTP` routes: `429` with the hint the
        // limiter produced, so a client backs off for the right time.
        refuse(socket, {
          status: 429,
          code: "RATE_LIMITED",
          ip,
          hostId,
          deviceId: device.deviceId,
          retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1000)),
        });
        return true;
      }
      void options.store
        .appendAudit({ op: "hosts.ws", ip, result: "ok", hostId, deviceId: device.deviceId })
        .catch(() => undefined);
      accept(request, socket, head, hostId, device.deviceId, token, ip, device.accountId);
      return true;
    },
    closeAll() {
      for (const entry of [...live]) {
        live.delete(entry);
        entry.stopHeartbeat();
        entry.connection.close(GATEWAY_STOPPING);
        if (entry.socket.readyState === entry.socket.OPEN) entry.socket.close(WS_TRY_AGAIN_LATER, GATEWAY_STOPPING);
      }
    },
    size: () => live.size,
  };
}
