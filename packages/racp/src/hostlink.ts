import type { Principal } from "@minih-agent/agent-host";
import * as Value from "typebox/value";

import {
  RACP_HOST_CAPABILITIES,
  RACP_HOSTLINK_CLOSE_CODES,
  RACP_HOSTLINK_VERSION,
  RacpDeviceGrantFrameSchema,
  RacpDeviceRequestFrameSchema,
  RacpDeviceRevokeFrameSchema,
  RacpHostCapabilitiesFrameSchema,
  RacpHostJoinedFrameSchema,
  RacpHostRevokedFrameSchema,
  RacpHostNotifyFrameSchema,
  type RacpHostJoined,
  type RacpDeviceGrantFrame,
  type RacpDeviceRequestFrame,
  type RacpDeviceRevokeFrame,
  type RacpHostLinkCloseCode,
  type RacpHostLinkFrame,
  type RacpHostNotify,
  type RacpHostRouteContext,
} from "@minih-agent/shared";

import type { DeviceTokenAuthenticator } from "./auth.js";
import type { DeviceRevocationQueue } from "./device-revocations.js";
import type { HostDeviceDirectory } from "./host-devices.js";
import type { RacpServer, ServerConnectionTransport } from "./server.js";

/**
 * Host link relay profile (protocol spec §11.4, D665 / ADR 0331). One
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
  /** Hand one frame to the socket; false when the socket is not open. */
  send(frame: string): boolean;
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
  /**
   * The account-mode device directory (§11.5). When present this Host announces
   * its capabilities on every link and answers `device.request`; when absent it
   * advertises nothing and the Gateway reports it as unable to confirm.
   */
  devices?: HostDeviceDirectory | null;
  /**
   * Where a revocation waits while the link is down (§11.5). Queued frames are
   * re-offered on every new link, so a revocation made offline still reaches
   * the account's other Hosts. Absent: a revocation is only sent on a live link.
   */
  revocations?: DeviceRevocationQueue | null;
  /**
   * Reports the four notification-worthy events of §11.6 to the Gateway, so it
   * can push a redacted notification. When present this Host advertises
   * `push.notify` on every link and may send `host.notify` for each event; when
   * absent it advertises nothing and no push names it.
   *
   * A `LinkNotifier` owns the current sender: `attach` on link-up, `detach` on
   * link-down, so a notification is never written to a socket that is gone and
   * nothing is queued. A notification describes something the user could still
   * act on, and a stale one is worse than none.
   */
  notifier?: HostNotifier | null;
  /**
   * A "a new computer joined the account" notice (ADR amendment 3). The Host
   * shows it and audits it; it is never an authorization.
   */
  onHostJoined?: (notice: RacpHostJoined) => void;
};

/** The Host side of `host.notify` (§11.6): ids and a kind, nothing else. */
export type HostNotifier = {
  /** Hand this link its sender; called once per link, before any frame. */
  attach: (send: (notify: RacpHostNotify) => void) => void;
  /** The link that owned the current sender is gone. */
  detach: () => void;
};

/**
 * The result of revoking one device on this Host. `revoked` says the local
 * record is revoked; `announced` says the signed frame went out on a live link
 * in this call. They differ when the link is down — the frame is queued, not
 * lost — so a caller never reports an announcement that did not happen.
 */
export type DeviceRevocationOutcome = { revoked: boolean; announced: boolean };

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
    socket.onClose(() => {
      // The link that owned this Host's notification sender is gone: detach
      // before anything else, so a racing notification cannot be written to a
      // closed socket.
      this.options.notifier?.detach();
      this.closeAll(RACP_HOSTLINK_CLOSE_CODES.hostClosed, "the Host link was lost");
    });
    socket.onError((error) => {
      this.options.log("error", "host link socket error", { error: String(error) });
    });
    // Announce capabilities on every link, so a Gateway that restarted (or a
    // reconnected link) knows what this Host supports before it sends a device
    // frame. A Host with no device directory and no notifier sends nothing and
    // is reported to the client as unable to confirm (§11.5).
    const capabilities = [
      ...(this.options.devices ? this.options.devices.capabilities() : []),
      // §11.6: only a Host that will actually report events advertises this.
      ...(this.options.notifier ? [RACP_HOST_CAPABILITIES.pushNotify] : []),
    ];
    if (capabilities.length > 0 || this.options.devices) {
      this.send({
        link: RACP_HOSTLINK_VERSION,
        type: "host.capabilities",
        capabilities,
      });
    }
    // §11.6: the notifier is handed a sender for this link, and it never
    // outlives it — a notification about an event the client already handled
    // would be noise, so nothing is queued.
    if (this.options.notifier) {
      this.options.notifier.attach((notify) => {
        this.send({ link: RACP_HOSTLINK_VERSION, type: "host.notify", notify });
      });
    }
    // A revocation made while the link was down goes out now, before anything
    // else this link carries. Re-delivery is idempotent (§11.5).
    if (this.options.revocations) {
      void this.options
        .revocations.pending()
        .then((frames) => {
          for (const frame of frames) this.send(frame);
          if (frames.length > 0) this.options.log("info", "host link re-offered queued revocations", { count: frames.length });
        })
        .catch((error: unknown) => this.options.log("warn", "could not read queued revocations", { error: String(error) }));
    }
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
        // Attachment relay is deferred (ADR 0331): RacpServer declares
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
      case "device.request": {
        // A malformed frame is dropped, never dereferenced: this Host may not
        // even have a device directory, and a peer must not be able to crash
        // the frame loop with one (protocol §11.4 rule 6).
        if (!Value.Check(RacpDeviceRequestFrameSchema, parsed)) {
          this.options.log("warn", "host link dropped a malformed device.request frame");
          return;
        }
        const devices = this.options.devices;
        if (!devices) {
          // The Gateway sends this only to a Host that advertised `device.confirm`.
          this.options.log("warn", "device request ignored: this Host has no device directory", {
            requestId: (parsed as RacpDeviceRequestFrame).request.requestId,
          });
          return;
        }
        // The local user decides asynchronously; the frame loop must not block.
        void devices
          .handleRequest((parsed as RacpDeviceRequestFrame).request, (frame) => this.send(frame))
          .catch((error: unknown) => this.options.log("error", "device request failed", { error: String(error) }));
        return;
      }
      case "device.grant": {
        if (!Value.Check(RacpDeviceGrantFrameSchema, parsed)) {
          this.options.log("warn", "host link dropped a malformed device.grant frame");
          return;
        }
        const devices = this.options.devices;
        if (!devices) return;
        void devices
          .handleGrant(parsed as RacpDeviceGrantFrame)
          .catch((error: unknown) => this.options.log("error", "device grant failed", { error: String(error) }));
        return;
      }
      case "device.revoke": {
        if (!Value.Check(RacpDeviceRevokeFrameSchema, parsed)) {
          this.options.log("warn", "host link dropped a malformed device.revoke frame");
          return;
        }
        const devices = this.options.devices;
        if (!devices) return;
        void devices
          .handleRevoke(parsed as RacpDeviceRevokeFrame)
          .catch((error: unknown) => this.options.log("error", "device revocation failed", { error: String(error) }));
        return;
      }
      case "host.capabilities":
        // Only a Host sends this; receiving one here is the same protocol
        // violation as the other Gateway-only frames.
        this.closeAll(RACP_HOSTLINK_CLOSE_CODES.protocolError, "unexpected host.capabilities frame");
        return;
      case "host.notify":
        // A notification is Host to Gateway only. A Gateway that sends one is
        // misconfigured; refuse the frame but keep the link, because dropping a
        // notification is harmless while dropping the link is not.
        this.options.log("warn", "host link ignored an unexpected host.notify frame");
        return;
      case "host.joined":
        // "A new computer joined the account" (ADR amendment 3). It is
        // information for the user, never an authorization, so a Host that
        // predates it must not lose its link over one — but this Host reads it
        // and shows the notice through `onHostJoined`.
        if (!Value.Check(RacpHostJoinedFrameSchema, parsed)) {
          this.options.log("warn", "host link dropped a malformed host.joined frame");
          return;
        }
        try {
          this.options.onHostJoined?.(parsed.notice);
        } catch (error) {
          this.options.log("warn", "host joined notice handler failed", { error: String(error) });
        }
        return;
      case "host.revoked": {
        // "This computer was revoked on the Gateway": its desktop devices lose
        // their standing here too (ADR amendment 3, decision 4). The frame only
        // removes authority, so it needs no signature.
        if (!Value.Check(RacpHostRevokedFrameSchema, parsed)) {
          this.options.log("warn", "host link dropped a malformed host.revoked frame");
          return;
        }
        const devices = this.options.devices;
        if (!devices) return;
        void devices
          .handleHostRevoked(parsed.revocation.hostId, parsed.revocation.revokedAt)
          .catch((error: unknown) => this.options.log("error", "host revocation cascade failed", { error: String(error) }));
        return;
      }
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

  /** Security §3.3: own `hostId`, unexpired, fresh `clientConnectionId` (rule from ADR 0331). */
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

  /** Hand one frame to the Gateway socket; false when it is not open. */
  send(frame: RacpHostLinkFrame): boolean {
    return this.socket.send(hostLinkFrame(frame));
  }

  /**
   * Revoke one device locally and tell the Gateway, so the account's other Hosts
   * drop it too (ADR decision 6, "any Host of the account can revoke the
   * device"). The local revocation always happens, so a Host never waits for the
   * Gateway to honour its own user's decision; the frame is queued first and
   * re-offered on the next link, so a revocation made while offline still
   * arrives (§11.5).
   */
  async revokeDevice(deviceId: string): Promise<DeviceRevocationOutcome> {
    return revokeDeviceThroughLink({
      devices: this.options.devices ?? null,
      revocations: this.options.revocations ?? null,
      send: (frame) => this.send(frame),
      log: this.options.log,
      deviceId,
    });
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
  private readonly capabilityHandlers: Array<(capabilities: string[]) => void> = [];
  private readonly deviceGrantHandlers: Array<(frame: RacpDeviceGrantFrame) => void> = [];
  private readonly deviceRevokeHandlers: Array<(frame: RacpDeviceRevokeFrame) => void> = [];
  private readonly hostNotifyHandlers: Array<(notify: RacpHostNotify) => void> = [];
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
      // Capability and device handlers belong to the link that just ended; the
      // Gateway re-registers them when the Host reconnects.
      this.capabilityHandlers.length = 0;
      this.deviceGrantHandlers.length = 0;
      this.deviceRevokeHandlers.length = 0;
      this.hostNotifyHandlers.length = 0;
    });
    socket.onError((error) => this.log("error", "gateway mux socket error", { error: String(error) }));
  }

  /** Send one Gateway-to-Host frame; false when the link is already gone. */
  send(frame: RacpHostLinkFrame): boolean {
    if (!this.socketOpen) return false;
    this.socket.send(hostLinkFrame(frame));
    return true;
  }

  /** Receive the capability list a Host announces when its link comes up. */
  onCapabilities(handler: (capabilities: string[]) => void): void {
    this.capabilityHandlers.push(handler);
  }

  /** Receive a signed device grant a Host approved. */
  onDeviceGrant(handler: (frame: RacpDeviceGrantFrame) => void): void {
    this.deviceGrantHandlers.push(handler);
  }

  /** Receive a signed device revocation from a Host. */
  onDeviceRevoke(handler: (frame: RacpDeviceRevokeFrame) => void): void {
    this.deviceRevokeHandlers.push(handler);
  }

  /** Receive one redacted notification event a Host reported (§11.6). */
  onHostNotify(handler: (notify: RacpHostNotify) => void): void {
    this.hostNotifyHandlers.push(handler);
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
      return;
    }
    // ---- Account-mode device directory (D666, package D) ------------------
    // A malformed or unknown frame is dropped without closing the link: an
    // older Host must survive a newer Gateway, and vice versa (§11.4).
    if (parsed.type === "host.capabilities") {
      if (!Value.Check(RacpHostCapabilitiesFrameSchema, parsed)) {
        this.log("warn", "gateway mux dropped malformed host.capabilities frame");
        return;
      }
      for (const handler of [...this.capabilityHandlers]) handler(parsed.capabilities);
      return;
    }
    if (parsed.type === "device.grant") {
      if (!Value.Check(RacpDeviceGrantFrameSchema, parsed)) {
        this.log("warn", "gateway mux dropped malformed device.grant frame");
        return;
      }
      for (const handler of [...this.deviceGrantHandlers]) handler(parsed);
      return;
    }
    if (parsed.type === "device.revoke") {
      if (!Value.Check(RacpDeviceRevokeFrameSchema, parsed)) {
        this.log("warn", "gateway mux dropped malformed device.revoke frame");
        return;
      }
      for (const handler of [...this.deviceRevokeHandlers]) handler(parsed);
      return;
    }
    // ---- Redacted push (§11.6, R5 PR-6) -----------------------------------
    // Dropped without closing the link when it is malformed, and ignored
    // entirely when nothing listens, which is exactly what an older Gateway
    // does with a newer Host's frame (§11.4 rule 6).
    if (parsed.type === "host.notify") {
      if (!Value.Check(RacpHostNotifyFrameSchema, parsed)) {
        this.log("warn", "gateway mux dropped malformed host.notify frame");
        return;
      }
      for (const handler of [...this.hostNotifyHandlers]) handler(parsed.notify);
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

/**
 * Sign one revocation, keep it, and offer it to the link (§11.5). The order
 * matters: the frame is queued before it is sent, so a link that dies in flight
 * cannot lose a revocation, and `announced` reports only what really left the
 * process.
 */
export async function revokeDeviceThroughLink(input: {
  devices: HostDeviceDirectory | null;
  revocations: DeviceRevocationQueue | null;
  send: (frame: RacpDeviceRevokeFrame) => boolean;
  log: HostLinkLog;
  deviceId: string;
}): Promise<DeviceRevocationOutcome> {
  if (!input.devices) return { revoked: false, announced: false };
  const frame = await input.devices.revoke(input.deviceId);
  if (!frame) return { revoked: false, announced: false };
  if (input.revocations) {
    try {
      const dropped = await input.revocations.enqueue(frame);
      if (dropped > 0) input.log("warn", "device revocation queue overflowed", { dropped });
    } catch (error) {
      // Losing the queue must not lose the send that follows it.
      input.log("warn", "could not queue a device revocation", { error: String(error) });
    }
  }
  let announced = false;
  try {
    announced = input.send(frame);
  } catch (error) {
    input.log("warn", "could not send a device revocation", { error: String(error) });
  }
  if (!announced) input.log("info", "device revocation queued for the next link", { deviceId: input.deviceId });
  return { revoked: true, announced };
}
