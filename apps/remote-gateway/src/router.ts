/**
 * The Gateway's logical-connection router (protocol §11.4 rule 2, §11.2).
 *
 * A device's commands share one logical connection per (device, host) so the
 * Host sees a stable connection identity; every event stream gets its own
 * connection, bounded to four per device so a browser cannot exhaust the
 * Host's `maxConnectedClients`. Each connection performs its own
 * `connection/initialize`, declares the Gateway's client capabilities, and
 * answers any server-initiated request with `CAPABILITY_UNAVAILABLE` without
 * making a decision for the user.
 */
import { randomUUID } from "node:crypto";

import {
  encodeFrame,
  errorObjectFrom,
  parseFrame,
  type HostLinkGatewayMux,
  type JsonRpcMessage,
} from "@minih-agent/racp";
import {
  RACP_HOSTLINK_VERSION,
  RACP_OPERATIONS,
  RACP_PROTOCOL_VERSION,
  RACP_EVENT_NOTIFICATION,
  RACP_SUBSCRIPTION_CLOSED_NOTIFICATION,
  RACP_INITIALIZED_NOTIFICATION,
  httpStatusForRacpError,
  type RacpHostRouteContext,
  type RacpInitializeResult,
  type RacpOperation,
  type RacpRemoteError,
} from "@minih-agent/shared";

export type GatewayLog = (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;

/** The current Host link of one Host, or nothing while it is offline. */
export interface HostLinkSource {
  muxFor(hostId: string): HostLinkGatewayMux | null;
}

export type ConnectionIdentity = {
  hostId: string;
  deviceId: string;
  /** Raw device (or pairing) credential; only ever sent inside `client.open`. */
  credential: string;
};

const MAX_STREAM_CONNECTIONS_PER_DEVICE = 4;
const ROUTE_CONTEXT_LIFETIME_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** `turn/start` admission deadline (protocol §12). */
const TURN_START_TIMEOUT_MS = 5_000;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: GatewayRpcError) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** A failure the Gateway itself produced, carrying a RACP code and HTTP status. */
export class GatewayRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retriable = false,
  ) {
    super(message);
    this.name = "GatewayRpcError";
  }

  get status(): number {
    return httpStatusForRacpError(this.code);
  }

  toRemoteError(traceId: string): RacpRemoteError {
    return { code: this.code, message: this.message, retriable: this.retriable, traceId };
  }
}

export class LogicalConnection {
  readonly id = `cc_${randomUUID()}`;
  private readonly pending = new Map<string, Pending>();
  private counter = 0;
  private closed = false;
  private notificationHandler: ((method: string, params: unknown) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  constructor(
    private readonly options: {
      identity: ConnectionIdentity;
      mux: HostLinkGatewayMux;
      log: GatewayLog;
      now?: () => number;
    },
  ) {
    const { mux, identity } = options;
    mux.onHostMessage(this.id, (frame) => this.handleFrame(frame));
    // The Host's close code carries its verdict: `UNAUTHORIZED` means the Host
    // rejected the credential (S8/S9), which must not read as "offline".
    mux.onHostClose(this.id, (code) => this.teardown(code));
    mux.open(this.id, this.routeContext(), identity.credential);
  }

  private routeContext(): RacpHostRouteContext {
    const now = (this.options.now ?? (() => Date.now()))();
    return {
      link: RACP_HOSTLINK_VERSION,
      hostId: this.options.identity.hostId,
      clientConnectionId: this.id,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ROUTE_CONTEXT_LIFETIME_MS).toISOString(),
    };
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Negotiate the logical connection. The Gateway declares exactly the
   * capabilities it can serve: it never approves anything on the user's
   * behalf, so approvals and input requests stay Host-side and reach the user
   * through the Host's own UI or a dedicated client.
   */
  async initialize(): Promise<RacpInitializeResult> {
    const result = await this.request<RacpInitializeResult>("connection/initialize", {
      protocolVersion: RACP_PROTOCOL_VERSION,
      client: { name: "minih-remote-gateway", version: "1.0.0" },
      // The Host link carries `RACP-WS` framing; the HTTP mapping is the
      // Gateway's client-facing binding (§11.2), not the Host's.
      bindings: ["RACP-WS"],
      capabilities: {
        eventReplay: true,
        snapshot: false,
        approvals: false,
        inputRequests: false,
        attachments: false,
        turnQueue: true,
        hostEvents: true,
        history: true,
        toolRelay: false,
        terminal: false,
      },
    });
    this.send({ jsonrpc: "2.0", method: RACP_INITIALIZED_NOTIFICATION, params: {} });
    return result;
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new GatewayRpcError("AGENT_UNAVAILABLE", "the Host link is closed", true));
    this.counter += 1;
    const id = `gw_${this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayRpcError("AGENT_UNAVAILABLE", `${method} did not answer in time`, true));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.options.mux.message(this.id, encodeFrame({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new GatewayRpcError("AGENT_UNAVAILABLE", error instanceof Error ? error.message : "the Host link is closed", true));
      }
    });
  }

  /** Ask the Host to release the logical connection. */
  close(reason: string): void {
    if (this.closed) return;
    try {
      this.options.mux.close(this.id, reason);
    } catch {
      // The link is already gone; teardown below still runs.
    }
    this.teardown(reason);
  }

  private send(message: JsonRpcMessage): void {
    if (this.closed) return;
    try {
      this.options.mux.message(this.id, encodeFrame(message));
    } catch (error) {
      this.options.log("warn", "gateway could not send on a logical connection", {
        clientConnectionId: this.id,
        error: String(error),
      });
    }
  }

  private handleFrame(raw: string): void {
    if (this.closed) return;
    const message = parseFrame(raw);
    if (!message) {
      this.options.log("warn", "gateway dropped a malformed Host frame", { clientConnectionId: this.id });
      return;
    }
    if ("method" in message) {
      const hasId = "id" in message && message.id !== undefined && message.id !== null;
      if (!hasId) {
        const method = message.method;
        if (method === RACP_EVENT_NOTIFICATION) this.notificationHandler?.(method, message.params);
        else if (method === RACP_SUBSCRIPTION_CLOSED_NOTIFICATION) this.notificationHandler?.(method, message.params);
        else this.options.log("warn", "gateway ignored an unknown Host notification", { clientConnectionId: this.id, method });
        return;
      }
      // A server-initiated request (approval/request, input/request, tool/execute):
      // the Gateway declares those capabilities as unsupported, so it answers
      // with an explicit error and never decides on the user's behalf.
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: errorObjectFrom(new GatewayRpcError("CAPABILITY_UNAVAILABLE", `${message.method} is not relayed by this Gateway`), this.id),
      });
      return;
    }
    const waiter = this.pending.get(String(message.id));
    if (!waiter) return;
    this.pending.delete(String(message.id));
    clearTimeout(waiter.timer);
    if (message.error) {
      const remote = message.error.data;
      waiter.reject(remote ? new GatewayRpcError(remote.code, remote.message, remote.retriable) : new GatewayRpcError("INTERNAL", message.error.message));
    } else {
      waiter.resolve(message.result);
    }
  }

  private teardown(cause: string): void {
    if (this.closed) return;
    this.closed = true;
    const error = teardownError(cause);
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.closeHandler?.();
    this.options.log("info", "gateway logical connection closed", { clientConnectionId: this.id, cause });
  }
}

/** Map the Host's logical-connection close code onto the RACP error vocabulary. */
function teardownError(cause: string): GatewayRpcError {
  if (cause === "UNAUTHORIZED") return new GatewayRpcError("UNAUTHORIZED", "the Host rejected this credential");
  if (cause === "CLIENT_TOO_SLOW") return new GatewayRpcError("CLIENT_TOO_SLOW", "the Host dropped a slow client", true);
  if (cause === "ROUTE_CONTEXT_REJECTED") return new GatewayRpcError("FORBIDDEN", "the Host rejected the route context");
  return new GatewayRpcError("AGENT_UNAVAILABLE", `the logical connection closed: ${cause}`, true);
}

export type LogicalConnectionPoolOptions = {
  links: HostLinkSource;
  log: GatewayLog;
  now?: () => number;
};

/**
 * Owns every logical connection the Gateway holds. Command connections are
 * reused per (device, host); stream connections are single-use and bounded per
 * device.
 */
export class LogicalConnectionPool {
  private readonly commands = new Map<string, LogicalConnection>();
  private readonly streams = new Map<string, Set<LogicalConnection>>();

  constructor(private readonly options: LogicalConnectionPoolOptions) {}

  private async connect(identity: ConnectionIdentity): Promise<LogicalConnection> {
    const mux = this.options.links.muxFor(identity.hostId);
    if (!mux) {
      // S3: no queueing. An offline Host fails the command immediately.
      throw new GatewayRpcError("AGENT_UNAVAILABLE", "the Host is offline", true);
    }
    let connection: LogicalConnection;
    try {
      connection = new LogicalConnection({ identity, mux, log: this.options.log, ...(this.options.now ? { now: this.options.now } : {}) });
    } catch (error) {
      // The link dropped between the lookup and `client.open`.
      throw new GatewayRpcError("AGENT_UNAVAILABLE", error instanceof Error ? error.message : "the Host is offline", true);
    }
    try {
      await connection.initialize();
    } catch (error) {
      connection.close("initialize failed");
      throw error;
    }
    return connection;
  }

  /** The shared command connection of one (device, host). */
  async command(identity: ConnectionIdentity): Promise<LogicalConnection> {
    const key = `${identity.deviceId}\u0000${identity.hostId}`;
    const existing = this.commands.get(key);
    if (existing && !existing.isClosed) return existing;
    if (existing) this.commands.delete(key);
    const connection = await this.connect(identity);
    connection.onClose(() => {
      if (this.commands.get(key) === connection) this.commands.delete(key);
    });
    this.commands.set(key, connection);
    return connection;
  }

  /** A dedicated connection for one event stream, bounded per device. */
  async stream(identity: ConnectionIdentity): Promise<LogicalConnection> {
    const open = this.streams.get(identity.deviceId) ?? new Set<LogicalConnection>();
    for (const connection of [...open]) if (connection.isClosed) open.delete(connection);
    if (open.size >= MAX_STREAM_CONNECTIONS_PER_DEVICE) {
      throw new GatewayRpcError("RATE_LIMITED", `a device may hold at most ${MAX_STREAM_CONNECTIONS_PER_DEVICE} event streams`, true);
    }
    const connection = await this.connect(identity);
    open.add(connection);
    this.streams.set(identity.deviceId, open);
    connection.onClose(() => open.delete(connection));
    return connection;
  }

  /** Close every logical connection of a revoked device (S9: within 5 seconds). */
  closeForDevice(deviceId: string): number {
    let closed = 0;
    for (const [key, connection] of [...this.commands]) {
      if (!key.startsWith(`${deviceId}\u0000`)) continue;
      connection.close("device revoked");
      this.commands.delete(key);
      closed += 1;
    }
    for (const connection of [...(this.streams.get(deviceId) ?? [])]) {
      connection.close("device revoked");
      closed += 1;
    }
    this.streams.delete(deviceId);
    return closed;
  }

  closeAll(): void {
    for (const connection of [...this.commands.values()]) connection.close("gateway stopping");
    this.commands.clear();
    for (const connections of this.streams.values()) for (const connection of connections) connection.close("gateway stopping");
    this.streams.clear();
  }

  /** Observability for tests and the admin CLI. */
  get size(): number {
    let streams = 0;
    for (const connections of this.streams.values()) streams += connections.size;
    return this.commands.size + streams;
  }
}

export type CommandInput = {
  identity: ConnectionIdentity;
  method: string;
  params: Record<string, unknown>;
  idempotencyKey?: string;
};

export type CommandOutcome = { status: number; payload: unknown };

/**
 * Validate one command against the catalog and route it onto the device's
 * logical connection. Idempotency keys only exist where the operation schema
 * defines one (`params.idempotencyKey` on `turn/start`).
 */
export class CommandRouter {
  constructor(
    private readonly pool: LogicalConnectionPool,
    private readonly log: GatewayLog,
  ) {}

  async run(input: CommandInput): Promise<CommandOutcome> {
    const { method, params } = input;
    if (!Object.hasOwn(RACP_OPERATIONS, method)) {
      throw new GatewayRpcError("METHOD_NOT_FOUND", `unknown operation ${method}`);
    }
    const operation = method as RacpOperation;
    if (operation === "connection/initialize" || operation === "connection/pair") {
      throw new GatewayRpcError("METHOD_NOT_FOUND", `${operation} is not a client command`);
    }
    const idempotencyKey = this.idempotencyKeyFor(operation, params, input.idempotencyKey);
    const forwarded = idempotencyKey ? { ...params, idempotencyKey } : params;
    const connection = await this.pool.command(input.identity);
    const timeoutMs = operation === "turn/start" ? TURN_START_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
    const result = await connection.request(operation, forwarded, timeoutMs);
    this.log("info", "gateway command completed", { method: operation, hostId: input.identity.hostId });
    return { status: 200, payload: { result } };
  }

  private idempotencyKeyFor(operation: RacpOperation, params: Record<string, unknown>, key: string | undefined): string | undefined {
    const inParams = params["idempotencyKey"];
    if (operation !== "turn/start") {
      if (key !== undefined || inParams !== undefined) {
        throw new GatewayRpcError("INVALID_ARGUMENT", `${operation} does not support an idempotency key`);
      }
      return undefined;
    }
    if (inParams !== undefined && key !== undefined && inParams !== key) {
      throw new GatewayRpcError("INVALID_ARGUMENT", "the idempotency key is given twice with different values");
    }
    const resolved = key ?? inParams;
    if (resolved === undefined) return undefined;
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw new GatewayRpcError("INVALID_ARGUMENT", "the idempotency key must be a non-empty string");
    }
    return resolved;
  }
}
