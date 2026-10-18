import type { Principal } from "@minih-agent/agent-host";

import {
  RACP_HOSTLINK_CLOSE_CODES,
  RACP_HOSTLINK_VERSION,
  type RacpHostLinkCloseCode,
  type RacpHostLinkFrame,
  type RacpHostRouteContext,
} from "@minih-agent/shared";

import type { DeviceTokenAuthenticator } from "./auth.js";
import type { RacpServer, ServerConnectionTransport } from "./server.js";

/**
 * Host link relay profile (protocol spec §11.4, D664 / ADR 0330). One
 * authenticated outbound WebSocket carries many logical client connections;
 * each logical connection is an ordinary `ServerConnectionTransport` the
 * `RacpServer.accept()` can serve, with its own initialization state,
 * subscriptions, and server-request id space (rule 2).
 *
 * The credential of `client.open` is re-authenticated by the Host's own
 * `DeviceTokenAuthenticator` under the connection origin `"gateway"`
 * (security §3.3, §3.7); the Gateway's cached token hash is only a pre-routing
 * fast reject. The route context is not separately signed in the self-hosted
 * scenario: its integrity is guaranteed by the authenticated Host link, and
 * the Host still checks its own `hostId`, the expiry, and `clientConnectionId`
 * reuse on the same link.
 */

export type HostLinkLog = (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;

/** The link-side transport the Gateway connection provides. */
export interface HostLinkSocket {
  send(frame: string): void;
  close(): void;
  onMessage(handler: (frame: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
}

export type HostLinkHostOptions = {
  server: RacpServer;
  authenticator: DeviceTokenAuthenticator;
  /** This Host's stable id; a route context naming another Host is rejected. */
  hostId: string;
  log: HostLinkLog;
  /** Wall clock, injectable for tests. */
  now?: () => number;
  /** Tolerance for Gateway clock skew on `issuedAt`; defaults to 60 seconds. */
  maxClockSkewMs?: number;
  /** Bounded per-logical-connection event queue in frames (rule 3). */
  maxQueuedFrames?: number;
  /** Extra frames the Host pushes while the client is slow are dropped as ephemeral. */
  onSlowClient?: (clientConnectionId: string) => void;
};

export type HostLinkLogicalConnection = {
  clientConnectionId: string;
  transport: ServerConnectionTransport;
  close(code: RacpHostLinkCloseCode, detail?: string): void;
  /** Set once torn down; tests and callers inspect the terminal close code. */
  readonly terminalCloseCode: RacpHostLinkCloseCode | null;
  readonly terminalCloseDetail: string | undefined;
};

const DEFAULT_MAX_QUEUED_FRAMES = 1000;

function hostLinkFrame(frame: RacpHostLinkFrame): string {
  return JSON.stringify(frame);
}

/**
 * The Host side of the Host link. Feed it the one authenticated socket the
 * `agent-host-cli` holds open toward the Gateway; it demultiplexes frames by
 * `clientConnectionId`, re-authenticates each `client.open` credential, and
 * serves every logical connection through `RacpServer.accept()`.
 */
const DEFAULT_MAX_CLOCK_SKEW_MS = 60_000;
const DEFAULT_MAX_PENDING_FRAMES = 64;

export class HostLinkHost {
  private readonly logical = new Map<string, LogicalConnection>();
  /** Opens whose credential is still being authenticated (fixes the race where
   * a client.message arrives right after client.open). */
  private readonly pending = new Map<string, PendingOpen>();

  constructor(
    private readonly options: HostLinkHostOptions,
    private readonly socket: HostLinkSocket,
  ) {
    socket.onMessage((frame) => this.handleFrame(frame));
    socket.onClose(() => this.closeAll(RACP_HOSTLINK_CLOSE_CODES.hostClosed, "the Host link was lost"));
    socket.onError((error) => {
      this.options.log("error", "host link socket error", { error: String(error) });
    });
  }

  /** Every open logical connection; the Gateway never sees this state. */
  connections(): readonly HostLinkLogicalConnection[] {
    return [...this.logical.values()];
  }

  private handleFrame(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw) as unknown;
    } catch {
      this.options.log("warn", "host link dropped malformed frame");
      return;
    }
    if (
      typeof frame !== "object" ||
      frame === null ||
      (frame as { link?: unknown }).link !== RACP_HOSTLINK_VERSION
    ) {
      this.closeAll(RACP_HOSTLINK_CLOSE_CODES.protocolError, "frame is not a racp-hostlink.v1 frame");
      return;
    }
    const parsed = frame as RacpHostLinkFrame;
    switch (parsed.type) {
      case "client.open":
        this.handleOpen(parsed);
        return;
      case "client.message": {
        // The Gateway does not wait for an open confirmation (the protocol has
        // none), so a message may arrive while the credential is still being
        // authenticated; buffer it instead of answering with a protocol error.
        const pending = this.pending.get(parsed.clientConnectionId);
        if (pending) {
          pending.buffer(parsed.message);
          return;
        }
        const connection = this.logical.get(parsed.clientConnectionId);
        if (!connection) {
          this.sendHostClose(parsed.clientConnectionId, RACP_HOSTLINK_CLOSE_CODES.protocolError, "no such logical connection");
          return;
        }
        connection.handleMessage(parsed.message);
        return;
      }
      case "client.close": {
        // Cancel a still-pending open, or tear the open connection down.
        const pending = this.pending.get(parsed.clientConnectionId);
        if (pending) {
          this.pending.delete(parsed.clientConnectionId);
          this.sendHostClose(parsed.clientConnectionId, RACP_HOSTLINK_CLOSE_CODES.clientClosed, "the client closed the connection before it opened");
          return;
        }
        const connection = this.logical.get(parsed.clientConnectionId);
        if (connection) connection.teardown(RACP_HOSTLINK_CLOSE_CODES.clientClosed);
        return;
      }
      case "host.message":
      case "host.close":
        // Only the Gateway's client-facing half sends these; receiving one on
        // the Host side is a protocol violation.
        this.closeAll(RACP_HOSTLINK_CLOSE_CODES.protocolError, `unexpected ${parsed.type} frame`);
        return;
      case "attachment.chunk":
        // Attachment relay is deferred (ADR 0330): RacpServer declares
        // `attachments: false`, so the Host refuses the frame and closes the
        // link rather than silently dropping bytes.
        this.options.log("warn", "attachment relay is deferred; closing the link", { uploadId: "redacted" });
        this.closeAll(RACP_HOSTLINK_CLOSE_CODES.protocolError, "attachment relay is deferred");
        return;
      case "link.ping":
        this.socket.send(hostLinkFrame({ link: RACP_HOSTLINK_VERSION, type: "link.pong" }));
        return;
      case "link.pong":
        return;
    }
  }

  private handleOpen(frame: Extract<RacpHostLinkFrame, { type: "client.open" }>): void {
    const { clientConnectionId, routeContext, credential } = frame;
    // A duplicate id fails whether the first open is still authenticating or
    // already serving; two concurrent opens of the same id must not both pass.
    if (this.logical.has(clientConnectionId) || this.pending.has(clientConnectionId)) {
      this.options.log("warn", "host link rejected duplicate clientConnectionId", { clientConnectionId });
      this.sendHostClose(clientConnectionId, RACP_HOSTLINK_CLOSE_CODES.duplicateConnection, "clientConnectionId is already in use on this link");
      return;
    }
    const contextError = this.validateRouteContext(routeContext);
    if (contextError) {
      this.sendHostClose(clientConnectionId, RACP_HOSTLINK_CLOSE_CODES.routeContextRejected, contextError);
      return;
    }
    // Register the pending entry synchronously so frames that arrive while the
    // credential is being checked are buffered, not dropped or rejected.
    const pending = new PendingOpen(this, clientConnectionId);
    this.pending.set(clientConnectionId, pending);
    void (async () => {
      // S8: the Host is the final authentication authority. The credential is
      // re-checked here on every open; the Gateway's cache is only a pre-filter.
      const auth = await this.options.authenticator.authenticate({
        authorization: `Bearer ${credential}`,
        urlHasToken: false,
        connectionId: clientConnectionId,
        origin: "gateway",
      });
      if (this.pending.get(clientConnectionId) !== pending) {
        // The client closed (or the id was replaced) while authenticating.
        return;
      }
      if (!auth) {
        this.options.log("warn", "host link rejected credential", { clientConnectionId });
        this.pending.delete(clientConnectionId);
        this.sendHostClose(clientConnectionId, RACP_HOSTLINK_CLOSE_CODES.unauthorized, "the credential was not accepted by this Host");
        return;
      }
      const connection = new LogicalConnection(this, clientConnectionId, auth.principal);
      this.logical.set(clientConnectionId, connection);
      const accepted = this.options.server.accept(auth, connection.transport, "gateway");
      if (!accepted) {
        this.pending.delete(clientConnectionId);
        connection.teardown(RACP_HOSTLINK_CLOSE_CODES.hostClosed, "the Host refused the logical connection");
        return;
      }
      this.pending.delete(clientConnectionId);
      this.options.log("info", "host link logical connection opened", { clientConnectionId });
      // accept() has registered the frame handler; replay the buffered
      // messages in arrival order (usually the initialize request).
      pending.replayInto(connection);
    })().catch((error: unknown) => {
      this.options.log("error", "host link open failed", { clientConnectionId, error: String(error) });
      this.pending.delete(clientConnectionId);
      this.sendHostClose(clientConnectionId, RACP_HOSTLINK_CLOSE_CODES.protocolError, "the logical connection failed to open");
    });
  }

  /** Security §3.3: own `hostId`, unexpired, fresh `clientConnectionId` (rule from ADR 0330). */
  private validateRouteContext(context: RacpHostRouteContext): string | null {
    if (context.link !== RACP_HOSTLINK_VERSION) return "route context names another link protocol";
    if (context.hostId !== this.options.hostId) return "route context names another Host";
    const now = (this.options.now ?? (() => Date.now()))();
    if (Date.parse(context.expiresAt) <= now) return "route context has expired";
    // Tolerate bounded Gateway clock skew; an expiry check stays strict.
    const maxSkew = this.options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
    if (Date.parse(context.issuedAt) > now + maxSkew) return "route context is issued in the future";
    return null;
  }

  /** The link logger, shared with the logical connections of this host. */
  get log(): HostLinkLog {
    return this.options.log;
  }

  /** This Host's stable id (route-context validation and tests). */
  get id(): string {
    return this.options.hostId;
  }

  sendHostClose(clientConnectionId: string, code: RacpHostLinkCloseCode, detail: string): void {
    this.socket.send(hostLinkFrame({ link: RACP_HOSTLINK_VERSION, type: "host.close", clientConnectionId, code }));
    this.options.log("warn", "host link closed logical connection", { clientConnectionId, code, detail });
  }

  /** Rule 5: losing the link closes every logical connection with a resumable cursor. */
  private closeAll(code: RacpHostLinkCloseCode, detail: string): void {
    for (const connection of [...this.logical.values()]) {
      connection.teardown(code);
    }
    for (const clientConnectionId of [...this.pending.keys()]) {
      this.pending.delete(clientConnectionId);
    }
    this.options.log("warn", "host link closed every logical connection", { code, detail, count: this.logical.size });
  }

  send(frame: RacpHostLinkFrame): void {
    this.socket.send(hostLinkFrame(frame));
  }

  remove(clientConnectionId: string): void {
    this.logical.delete(clientConnectionId);
  }

  /**
   * Drop a still-pending open: the entry is removed from the pending table
   * and its buffered frames are discarded, so the asynchronous authentication
   * result finds nothing to open. Late `client.message` frames for the id
   * then take the ordinary "no such logical connection" path.
   */
  cancelPending(clientConnectionId: string): void {
    this.pending.delete(clientConnectionId);
  }
}

/**
 * An open whose credential is still being authenticated. Frames that arrive
 * in this window (the Gateway sends `connection/initialize` right after
 * `client.open`) are buffered with a bound and replayed in order once the
 * logical connection exists.
 */
class PendingOpen {
  private readonly frames: unknown[] = [];
  /** Set once the open is cancelled or overflowed; late frames are ignored. */
  private cancelled = false;

  constructor(
    private readonly host: HostLinkHost,
    readonly clientConnectionId: string,
  ) {}

  buffer(message: unknown): void {
    if (this.cancelled) return;
    if (this.frames.length >= DEFAULT_MAX_PENDING_FRAMES) {
      // Cancel the pending entry and tell the Gateway once; a second
      // host.close would be ignored by the Gateway and would misreport the
      // connection as repeatedly failing.
      this.cancelled = true;
      this.frames.length = 0;
      this.host.cancelPending(this.clientConnectionId);
      this.host.sendHostClose(this.clientConnectionId, RACP_HOSTLINK_CLOSE_CODES.clientTooSlow, "too many frames while the connection was opening");
      return;
    }
    this.frames.push(message);
  }

  /** Replay buffered frames into the freshly accepted connection, in order. */
  replayInto(connection: LogicalConnection): void {
    for (const message of this.frames.splice(0)) {
      connection.handleMessage(message);
    }
  }
}

/**
 * One logical client connection. Frames flow through a bounded queue so a
 * slow client loses ephemeral output and is closed with `CLIENT_TOO_SLOW`
 * (rule 3) instead of stalling the link.
 */
class LogicalConnection implements HostLinkLogicalConnection {
  readonly transport: ServerConnectionTransport;
  private readonly queue: string[] = [];
  private closed = false;
  private closeCode: RacpHostLinkCloseCode | null = null;
  private closeDetail: string | undefined;
  /** The frame handler `RacpServer.accept()` registers on the transport. */
  private serverMessageHandler: ((frame: string, byteLength: number) => void) | null = null;
  /** The close handler `RacpServer.accept()` registers; releases the connection slot. */
  private serverCloseHandler: (() => void) | null = null;
  private serverCloseCalled = false;

  constructor(
    private readonly host: HostLinkHost,
    readonly clientConnectionId: string,
    private readonly principal: Principal,
  ) {
    const maxQueuedFrames = DEFAULT_MAX_QUEUED_FRAMES;
    this.transport = {
      send: (frame) => {
        if (this.closed) return;
        // Rule 3: never drop a durable event silently. The bound counts frames
        // the peer has not taken yet; overflowing it closes the logical
        // connection with a resumable cursor instead.
        this.queue.push(frame);
        if (this.queue.length > maxQueuedFrames) {
          this.teardown(RACP_HOSTLINK_CLOSE_CODES.clientTooSlow, "the event queue exceeded its bound");
          return;
        }
        this.flush();
      },
      close: (code, reason) => {
        this.host.send({ link: RACP_HOSTLINK_VERSION, type: "host.close", clientConnectionId: this.clientConnectionId, code: String(code) });
        this.teardown(RACP_HOSTLINK_CLOSE_CODES.hostClosed, reason);
      },
      // `RacpServer.accept()` registers both handlers; the Host link routes
      // frames and teardown into them so the server's own accounting (frame
      // size bound, subscriptions, release) stays the single implementation.
      onMessage: (handler) => {
        this.serverMessageHandler = handler;
      },
      onClose: (handler) => {
        this.serverCloseHandler = handler;
      },
    };
  }

  /** Entry point for `client.message` frames routed by the HostLinkHost. */
  handleMessage(message: unknown): void {
    if (this.closed || !this.serverMessageHandler) return;
    const frame = typeof message === "string" ? message : JSON.stringify(message);
    this.serverMessageHandler(frame, Buffer.byteLength(frame, "utf8"));
  }

  private flushing = false;
  private flushScheduled = false;
  /**
   * Drains the queue onto the link on a microtask. Every send schedules one,
   * so a responsive consumer receives frames immediately while a stalled one
   * accumulates toward the `CLIENT_TOO_SLOW` bound.
   */
  private flush(): void {
    if (this.flushScheduled || this.flushing || this.closed) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (this.flushing || this.closed) return;
      this.flushing = true;
      try {
        while (this.queue.length > 0) {
          const frame = this.queue.shift();
          if (frame === undefined) break;
          this.host.send({ link: RACP_HOSTLINK_VERSION, type: "host.message", clientConnectionId: this.clientConnectionId, message: frame });
        }
      } finally {
        this.flushing = false;
      }
    });
  }

  close(code: RacpHostLinkCloseCode, detail?: string): void {
    this.host.send({ link: RACP_HOSTLINK_VERSION, type: "host.close", clientConnectionId: this.clientConnectionId, code });
    this.teardown(code, detail);
  }

  teardown(code: RacpHostLinkCloseCode, detail?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeDetail = detail;
    this.queue.length = 0;
    this.host.remove(this.clientConnectionId);
    // Release the RacpServer slot exactly once, so relayed logical
    // connections share the same accounting as loopback RACP-WS connections.
    if (this.serverCloseHandler && !this.serverCloseCalled) {
      this.serverCloseCalled = true;
      this.serverCloseHandler();
    }
    this.host.log("info", "host link logical connection closed", {
      clientConnectionId: this.clientConnectionId,
      code,
      detail,
    });
  }

  get terminalCloseCode(): RacpHostLinkCloseCode | null {
    return this.closeCode;
  }

  get terminalCloseDetail(): string | undefined {
    return this.closeDetail;
  }
}

/**
 * Gateway-side mux helper: wraps one Host-facing socket so the Gateway can
 * open logical connections toward the Host and route client frames into them.
 * PR-2 uses this to implement `client-http.ts` and `pairing.ts`.
 */
export class HostLinkGatewayMux {
  private readonly messageHandlers = new Map<string, ((frame: string) => void)[]>();
  private readonly closeHandlers = new Map<string, ((code: string) => void)[]>();
  private socketOpen = true;

  constructor(
    private readonly socket: HostLinkSocket,
    private readonly log: HostLinkLog,
  ) {
    socket.onMessage((frame) => this.handleFrame(frame));
    socket.onClose(() => {
      this.socketOpen = false;
      // The link is gone: every logical connection closes with the link-level
      // close code, and every handler map is dropped so nothing lingers.
      for (const [clientConnectionId, handlers] of [...this.closeHandlers]) {
        for (const handler of handlers) handler(RACP_HOSTLINK_CLOSE_CODES.hostClosed);
      }
      this.messageHandlers.clear();
      this.closeHandlers.clear();
    });
    socket.onError((error) => this.log("error", "gateway mux socket error", { error: String(error) }));
  }

  open(clientConnectionId: string, routeContext: RacpHostRouteContext, credential: string): void {
    if (!this.socketOpen) throw new Error("the Host link socket is closed");
    this.socket.send(hostLinkFrame({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId, routeContext, credential }));
  }

  message(clientConnectionId: string, message: unknown): void {
    if (!this.socketOpen) throw new Error("the Host link socket is closed");
    this.socket.send(hostLinkFrame({ link: RACP_HOSTLINK_VERSION, type: "client.message", clientConnectionId, message }));
  }

  close(clientConnectionId: string, reason: string): void {
    if (!this.socketOpen) throw new Error("the Host link socket is closed");
    this.socket.send(hostLinkFrame({ link: RACP_HOSTLINK_VERSION, type: "client.close", clientConnectionId, reason }));
    this.release(clientConnectionId);
  }

  ping(): void {
    if (!this.socketOpen) throw new Error("the Host link socket is closed");
    this.socket.send(hostLinkFrame({ link: RACP_HOSTLINK_VERSION, type: "link.ping" }));
  }

  /** Receive `host.message` frames for one logical connection. */
  onHostMessage(clientConnectionId: string, handler: (frame: string) => void): void {
    const handlers = this.messageHandlers.get(clientConnectionId) ?? [];
    handlers.push(handler);
    this.messageHandlers.set(clientConnectionId, handlers);
  }

  /** Receive the close of one logical connection with its close code. */
  onHostClose(clientConnectionId: string, handler: (code: string) => void): void {
    const handlers = this.closeHandlers.get(clientConnectionId) ?? [];
    handlers.push(handler);
    this.closeHandlers.set(clientConnectionId, handlers);
  }

  /** Test and caller visibility: whether any handler is still registered for the id. */
  hasHandlersFor(clientConnectionId: string): boolean {
    return this.messageHandlers.has(clientConnectionId) || this.closeHandlers.has(clientConnectionId);
  }

  private release(clientConnectionId: string): void {
    this.messageHandlers.delete(clientConnectionId);
    this.closeHandlers.delete(clientConnectionId);
  }

  private handleFrame(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw) as unknown;
    } catch {
      this.log("warn", "gateway mux dropped malformed frame");
      return;
    }
    if (
      typeof frame !== "object" ||
      frame === null ||
      (frame as { link?: unknown }).link !== RACP_HOSTLINK_VERSION
    ) {
      return;
    }
    const parsed = frame as RacpHostLinkFrame;
    if (parsed.type === "host.message") {
      const body = typeof parsed.message === "string" ? parsed.message : JSON.stringify(parsed.message);
      for (const handler of this.messageHandlers.get(parsed.clientConnectionId) ?? []) {
        handler(body);
      }
      return;
    }
    if (parsed.type === "host.close") {
      for (const handler of this.closeHandlers.get(parsed.clientConnectionId) ?? []) {
        handler(parsed.code);
      }
      this.release(parsed.clientConnectionId);
    }
  }
}

export type HostLinkHostFactoryOptions = HostLinkHostOptions;

/** Factory for a `HostLinkHost` bound to one Gateway socket. */
export function createHostLinkHost(
  options: HostLinkHostOptions & { socket: HostLinkSocket },
): HostLinkHost {
  const { socket, ...rest } = options;
  return new HostLinkHost(rest, socket);
}
