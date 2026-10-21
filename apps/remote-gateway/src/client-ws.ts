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
 * Ownership and cleanup (AGENTS.md §9): this module owns the WebSocket and its
 * logical connection. The logical connection is taken from the shared pool, so
 * revoking the device closes it (`closeForDevice`); losing the Host link closes
 * it from the Host side; the client closing closes it from this side. A slow
 * client is closed with `CLIENT_TOO_SLOW` rather than buffered without bound,
 * which keeps the resumable-cursor rule of §11.4 rule 3.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { RACP_DEVICE_TOKEN_PREFIX } from "@minih-agent/shared";
import { WebSocketServer, type WebSocket } from "ws";

import { peerAddress } from "./client-ip.js";
import { bearerToken, hasUrlCredential } from "./client-request-rules.js";
import { hashToken } from "./pairing.js";
import type { RateLimiter } from "./rate-limit.js";
import type { GatewayLog, LogicalConnection, LogicalConnectionPool } from "./router.js";
import type { GatewayStore } from "./store.js";

const WS_ROUTE = /^\/v1\/hosts\/([^/]+)\/ws\/?$/;
/** Bound on what one slow client may leave buffered before it is closed. */
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const WS_TRY_AGAIN_LATER = 1013;
const WS_POLICY_VIOLATION = 1008;

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
};

export type ClientWsServer = {
  /** Handle one HTTP upgrade. Returns false when the path is not this route. */
  handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  /** Close every relayed client (gateway shutdown). */
  closeAll: () => void;
  /** Live client sockets, for tests and diagnostics. */
  size: () => number;
};

export function createClientWsServer(options: ClientWsOptions): ClientWsServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const live = new Set<{ socket: WebSocket; connection: LogicalConnection }>();
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const resolveIp = (request: IncomingMessage) => (options.resolveClientIp ?? peerAddress)(request);

  function refuse(socket: Duplex, status: number, code: string, hostId?: string, deviceId?: string): void {
    options.log("info", "gateway ws upgrade refused", { status, code, ...(hostId ? { hostId } : {}) });
    void options.store
      .appendAudit({ op: "hosts.ws", ip: "", result: "denied", ...(hostId ? { hostId } : {}), ...(deviceId ? { deviceId } : {}) })
      .catch(() => undefined);
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    socket.write(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not Found"}\r\nconnection: close\r\n\r\n`);
    socket.destroy();
  }

  function originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    const value = Array.isArray(origin) ? origin[0] : origin;
    if (!value) return true;
    return options.allowedOrigins.some((allowed) => allowed.replace(/\/$/, "").toLowerCase() === value.replace(/\/$/, "").toLowerCase());
  }

  function accept(request: IncomingMessage, socket: Duplex, head: Buffer, hostId: string, deviceId: string, token: string, accountId?: string): void {
    wss.handleUpgrade(request, socket, head, (ws) => {
      let connection: LogicalConnection;
      void (async () => {
        try {
          connection = await options.pool.relay({
            hostId,
            deviceId,
            credential: token,
            ...(accountId ? { accountDevice: true } : {}),
          });
        } catch (error) {
          // The Host link went away between the check and the upgrade.
          ws.close(WS_TRY_AGAIN_LATER, "the Host is unavailable");
          return;
        }
        const entry = { socket: ws, connection };
        live.add(entry);
        options.log("info", "gateway ws relay established", { hostId, deviceId, clientConnectionId: connection.id });
        connection.attachRelay({
          onFrame: (frame) => {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(frame);
            // A client that cannot keep up is closed instead of buffered
            // without bound; the Host then ends the logical connection with a
            // resumable cursor (rule 3).
            if (ws.bufferedAmount > maxBufferedBytes) {
              options.log("warn", "gateway ws client too slow", { hostId, deviceId, clientConnectionId: connection.id });
              connection.close("CLIENT_TOO_SLOW");
            }
          },
          onClose: (cause) => {
            live.delete(entry);
            if (ws.readyState === ws.OPEN) ws.close(WS_POLICY_VIOLATION, cause.slice(0, 120));
          },
        });
        ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
          if (isBinary) {
            // Attachment relay is deferred (ADR 0331); the Host refuses the
            // frame too, so the Gateway closes rather than dropping bytes.
            options.log("warn", "gateway ws refused a binary frame", { hostId, deviceId });
            connection.close("PROTOCOL_ERROR");
            return;
          }
          const frame = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8");
          connection.sendRaw(frame);
        });
        ws.on("close", () => {
          live.delete(entry);
          connection.close("client closed");
        });
        ws.on("error", (error) => {
          options.log("warn", "gateway ws socket error", { hostId, deviceId, error: String(error) });
          live.delete(entry);
          connection.close("client error");
        });
      })();
    });
  }

  return {
    handleUpgrade(request, socket, head) {
      const rawUrl = request.url ?? "/";
      const match = WS_ROUTE.exec(new URL(rawUrl, "http://gateway.local").pathname);
      if (!match) return false;
      const hostId = decodeURIComponent(match[1] ?? "");
      const ip = resolveIp(request);
      const token = bearerToken(request.headers.authorization);
      const device = token && token.startsWith(RACP_DEVICE_TOKEN_PREFIX) ? options.store.findDeviceByTokenHash(hashToken(token)) : undefined;

      if (hasUrlCredential(rawUrl)) {
        refuse(socket, 401, "URL_CREDENTIAL", hostId, device?.deviceId);
        return true;
      }
      if (!originAllowed(request)) {
        refuse(socket, 403, "ORIGIN_NOT_ALLOWED", hostId, device?.deviceId);
        return true;
      }
      if (!token) {
        refuse(socket, 401, "NO_CREDENTIAL", hostId);
        return true;
      }
      if (!token.startsWith(RACP_DEVICE_TOKEN_PREFIX) || !device || device.revokedAt) {
        refuse(socket, 401, "UNKNOWN_DEVICE", hostId, device?.deviceId);
        return true;
      }
      const reachesHost = device.accountId
        ? (() => {
            const host = options.store.findHost(hostId);
            return Boolean(host && !host.revokedAt && host.accountId === device.accountId);
          })()
        : device.hostId === hostId;
      if (!reachesHost) {
        refuse(socket, 403, "WRONG_HOST", hostId, device.deviceId);
        return true;
      }
      const decision = options.rateLimiter.check(device.deviceId, ip);
      if (!decision.allowed) {
        refuse(socket, 403, "RATE_LIMITED", hostId, device.deviceId);
        return true;
      }
      void options.store
        .appendAudit({ op: "hosts.ws", ip, result: "ok", hostId, deviceId: device.deviceId })
        .catch(() => undefined);
      accept(request, socket, head, hostId, device.deviceId, token, device.accountId);
      return true;
    },
    closeAll() {
      for (const entry of [...live]) {
        live.delete(entry);
        entry.connection.close("gateway stopping");
        if (entry.socket.readyState === entry.socket.OPEN) entry.socket.close(WS_TRY_AGAIN_LATER, "gateway stopping");
      }
    },
    size: () => live.size,
  };
}
