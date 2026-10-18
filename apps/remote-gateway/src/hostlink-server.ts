/**
 * The Host link listener (protocol §11.4, security §3.2). One TLS server on a
 * private or overlay address that serves two things:
 *
 * - `POST /v1/enroll`: server-TLS only, the Host proves itself with a one-time
 *   code plus a CSR;
 * - the `/v1/hostlink` WebSocket upgrade: mutual TLS with a certificate the
 *   Gateway itself issued, whose CN is the `hostId` and whose fingerprint
 *   matches the registered one.
 *
 * A new link for the same `hostId` replaces the old one only after these
 * identity checks pass, so a rejected peer can never displace a healthy link.
 */
import type { IncomingMessage, Server as HttpsServer, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { PeerCertificate, TLSSocket } from "node:tls";

import { HostLinkGatewayMux, type HostLinkSocket } from "@minih-agent/racp";
import { WebSocketServer, type WebSocket } from "ws";

import type { GatewayAuthority } from "./ca.js";
import type { ListenAddress } from "./config.js";
import type { EnrollmentService } from "./enrollment.js";
import type { GatewayLog, HostLinkSource } from "./router.js";
import type { GatewayStore } from "./store.js";

/** Close code the Host treats as "this certificate is refused; do not retry". */
export const HOST_LINK_REJECTED_CLOSE_CODE = 4403;

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_ENROLL_BODY_BYTES = 64 * 1024;

export type HostLinkServerOptions = {
  store: GatewayStore;
  authority: () => Promise<GatewayAuthority>;
  enrollment: EnrollmentService;
  log: GatewayLog;
  now?: () => number;
  heartbeatMs?: number;
};

type LiveLink = { hostId: string; mux: HostLinkGatewayMux; socket: WebSocket; heartbeat: ReturnType<typeof setInterval> };

/** Node types a subject entry as `string | string[]`; the CN is one string. */
function commonName(subject: PeerCertificate["subject"] | undefined): string | null {
  const value = subject?.["CN"];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

export class HostLinkServer implements HostLinkSource {
  private server: HttpsServer | null = null;
  private wss: WebSocketServer | null = null;
  private readonly links = new Map<string, LiveLink>();

  constructor(private readonly options: HostLinkServerOptions) {}

  async start(listen: ListenAddress): Promise<{ host: string; port: number }> {
    const authority = await this.options.authority();
    const server = createHttpsServer({
      cert: authority.server.certificatePem,
      key: authority.server.privateKeyPem,
      ca: authority.ca.certificatePem,
      requestCert: true,
      // Verification is explicit below so a rejected peer gets a clear refusal
      // instead of a generic handshake failure.
      rejectUnauthorized: false,
    });
    const wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (socket, request) => this.accept(socket, request));
    server.on("request", (request, response) => {
      void this.handleHttp(request, response).catch((error: unknown) => {
        this.options.log("error", "host link listener failed", { error: String(error) });
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "INTERNAL", message: "the Gateway failed to answer" } }));
        } else response.end();
      });
    });
    server.on("upgrade", (request, socket) => {
      const path = new URL(request.url ?? "/", "https://gateway.local").pathname;
      if (path !== "/v1/hostlink") {
        socket.destroy();
        return;
      }
      if (!this.peerCertificate(request)) {
        this.auditRejection(request);
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, Buffer.alloc(0), (ws) => wss.emit("connection", ws, request));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listen.port, listen.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.wss = wss;
    const address = server.address() as AddressInfo;
    return { host: listen.host, port: address.port };
  }

  muxFor(hostId: string): HostLinkGatewayMux | null {
    return this.links.get(hostId)?.mux ?? null;
  }

  isOnline(hostId: string): boolean {
    const link = this.links.get(hostId);
    return Boolean(link && link.socket.readyState === link.socket.OPEN);
  }

  /** `hosts revoke`: drop the live link; the certificate is refused from then on. */
  disconnect(hostId: string): boolean {
    const link = this.links.get(hostId);
    if (!link) return false;
    this.closeLink(link, HOST_LINK_REJECTED_CLOSE_CODE, "the Host was revoked");
    return true;
  }

  async stop(): Promise<void> {
    for (const link of [...this.links.values()]) this.closeLink(link, 1001, "gateway stopping");
    const wss = this.wss;
    this.wss = null;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private peerCertificate(request: IncomingMessage): { hostId: string } | null {
    const tls = request.socket as TLSSocket;
    const peer = tls.getPeerCertificate(true);
    if (!peer || Object.keys(peer).length === 0) return null;
    // `authorized` is true only when the chain verifies against `ca`.
    if (!tls.authorized) return null;
    const hostId = commonName(peer.subject);
    if (!hostId) return null;
    const record = this.options.store.findHost(hostId);
    if (!record || record.revokedAt) return null;
    const fingerprint = String(peer.fingerprint256 ?? "").replace(/:/g, "").toLowerCase();
    if (fingerprint !== record.certificateFingerprint256) return null;
    return { hostId };
  }

  /** Record a refused upgrade without ever echoing the presented certificate. */
  private auditRejection(request: IncomingMessage): void {
    const peer = (request.socket as TLSSocket).getPeerCertificate(true);
    const hostId = commonName(peer?.subject) ?? "unknown";
    void this.options.store
      .appendAudit({ op: "hosts.link", hostId, ip: request.socket.remoteAddress ?? "unknown", result: "denied" })
      .catch((error: unknown) => this.options.log("warn", "gateway audit append failed", { error: String(error) }));
    this.options.log("warn", "host link upgrade refused", { hostId });
  }

  private nowIso(): string {
    return new Date((this.options.now ?? (() => Date.now()))()).toISOString();
  }

  private touch(hostId: string): void {
    void this.options.store
      .touchHost(hostId, this.nowIso())
      .catch((error: unknown) => this.options.log("warn", "gateway could not record host activity", { hostId, error: String(error) }));
  }

  private accept(socket: WebSocket, request: IncomingMessage): void {
    const peer = this.peerCertificate(request);
    if (!peer) {
      socket.close(HOST_LINK_REJECTED_CLOSE_CODE, "the Host certificate is not authorized");
      return;
    }
    const previous = this.links.get(peer.hostId);
    const adapter: HostLinkSocket = {
      send: (frame: string) => {
        if (socket.readyState === socket.OPEN) socket.send(frame);
      },
      close: () => socket.close(1000, "host link closed"),
      onMessage: (handler: (frame: string) => void) => {
        socket.on("message", (data, isBinary) => {
          if (isBinary) return;
          handler(typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "");
        });
      },
      onClose: (handler: () => void) => socket.on("close", () => handler()),
      onError: (handler: (error: Error) => void) => socket.on("error", (error: Error) => handler(error)),
    };
    const mux = new HostLinkGatewayMux(adapter, this.options.log);
    const heartbeat = setInterval(() => {
      try {
        mux.ping();
      } catch (error) {
        this.options.log("warn", "gateway heartbeat failed", { hostId: peer.hostId, error: String(error) });
      }
    }, this.options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    const link: LiveLink = { hostId: peer.hostId, mux, socket, heartbeat };
    this.links.set(peer.hostId, link);
    // Identity is verified: only now may the new link replace the old one.
    if (previous) this.closeLink(previous, 1000, "replaced by a new Host link");
    socket.on("close", () => {
      clearInterval(heartbeat);
      if (this.links.get(peer.hostId) === link) this.links.delete(peer.hostId);
      this.touch(peer.hostId);
      this.options.log("info", "host link closed", { hostId: peer.hostId });
    });
    this.touch(peer.hostId);
    void this.options.store
      .appendAudit({ op: "hosts.link", hostId: peer.hostId, ip: request.socket.remoteAddress ?? "unknown", result: "ok" })
      .catch((error: unknown) => this.options.log("warn", "gateway audit append failed", { error: String(error) }));
    this.options.log("info", "host link accepted", { hostId: peer.hostId });
  }

  private closeLink(link: LiveLink, code: number, reason: string): void {
    clearInterval(link.heartbeat);
    if (this.links.get(link.hostId) === link) this.links.delete(link.hostId);
    try {
      link.socket.close(code, reason);
    } catch {
      link.socket.terminate();
    }
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "https://gateway.local");
    if (url.pathname !== "/v1/enroll" || request.method !== "POST") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "INVALID_ARGUMENT", message: "no such endpoint" } }));
      return;
    }
    const body = await this.readEnrollmentBody(request);
    if (body === null) {
      response.writeHead(413, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "INVALID_ARGUMENT", message: "the enrollment request is too large" } }));
      return;
    }
    let parsed: unknown = null;
    try {
      parsed = body.length > 0 ? (JSON.parse(body) as unknown) : null;
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "INVALID_ARGUMENT", message: "the enrollment body is not JSON" } }));
      return;
    }
    // The client address here is the Host link's TCP peer: this port is reached
    // directly over the overlay, never through the client proxy, so there is no
    // forwarded header to resolve. An account-mode AccessKey travels in the
    // Authorization header and is handed straight to the verifier (gate 30).
    const outcome = await this.options.enrollment.handleEnroll(
      parsed,
      request.socket.remoteAddress ?? "unknown",
      request.headers.authorization,
    );
    // A 429 carries its retry hint as `Retry-After`, so a Host can wait exactly
    // as long as the Gateway or the Router asked it to (RFC 9110).
    const retryAfter = outcome.retryAfterMs === undefined ? null : String(Math.max(1, Math.ceil(outcome.retryAfterMs / 1000)));
    response.writeHead(outcome.status, {
      "content-type": "application/json",
      ...(retryAfter ? { "retry-after": retryAfter } : {}),
    });
    response.end(JSON.stringify(outcome.payload));
  }

  private async readEnrollmentBody(request: IncomingMessage): Promise<string | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.byteLength;
      if (size > MAX_ENROLL_BODY_BYTES) return null;
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
