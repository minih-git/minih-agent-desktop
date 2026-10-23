import { randomUUID } from "node:crypto";

import { AgentHost, RacpError, type Principal } from "@minih-agent/agent-host";
import {
  RACP_DEFAULT_LIMITS,
  RACP_DEFAULT_POLICY,
  RACP_EVENT_NOTIFICATION,
  RACP_INITIALIZED_NOTIFICATION,
  RACP_OPERATIONS,
  RACP_PROTOCOL_VERSION,
  RACP_SUBSCRIPTION_CLOSED_NOTIFICATION,
  RacpInitializeParamsSchema,
  isRacpTraceId,
  protocolVersionsCompatible,
  rolesAllowOperation,
  type RacpEventEnvelope,
  type RacpInitializeResult,
  type RacpLimits,
  type RacpOperation,
  type RacpPolicy,
  type RacpServerCapabilities,
} from "@minih-agent/shared";
import * as Value from "typebox/value";

import type { ConnectionAuth, DeviceTokenAuthenticator } from "./auth.js";
import type { RacpHostOperations } from "./host-operations.js";
import {
  encodeFrame,
  errorObjectFrom,
  isNotification,
  isRequest,
  isResponse,
  parseFrame,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./jsonrpc.js";
import { createOperations, type OperationContext, type OperationHandler } from "./operations.js";

/** One accepted transport connection, as the server drives it. */
export interface ServerConnectionTransport {
  send(frame: string): void;
  close(code: number, reason: string): void;
  onMessage(handler: (frame: string, byteLength: number) => void): void;
  onClose(handler: () => void): void;
}

export type RacpServerOptions = {
  agentHost: AgentHost;
  operations: RacpHostOperations;
  authenticator: DeviceTokenAuthenticator;
  /** Stable Host identity (D448). */
  hostId: string;
  serverName?: string;
  serverVersion: string;
  limits?: Partial<RacpLimits>;
  policy?: Partial<RacpPolicy>;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  /** Deadline for `connection/initialize` after the socket opened (spec §12). */
  initializeTimeoutMs?: number;
  /**
   * Emit opt-in per-request execution latency records (P0 measurement). Off by
   * default; a record carries the method, trace id, connection id, and duration
   * only — never params or result content.
   */
  latencyTrace?: boolean;
};

type Subscription = { id: string; sessionId?: string };

type ServerRequestWaiter = {
  resolve: (value: unknown) => void;
  reject: (error: RacpError) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Per-connection state; the server keeps one per accepted socket. */
export class RacpConnection {
  readonly id = `conn_${randomUUID()}`;
  principal: Principal;
  /**
   * Channel the credential arrived on (security §3.7): `"ssh"` on the
   * loopback binding, `"gateway"` on a Host link logical connection. Decides
   * the roles `connection/pair` grants and, with the authenticator, rejects
   * cross-channel tokens.
   */
  readonly origin: "ssh" | "gateway";
  initialized = false;
  readonly subscriptions = new Map<string, Subscription>();
  readonly terminals = new Set<string>();
  private readonly pendingServerRequests = new Map<string, ServerRequestWaiter>();
  private serverRequestCounter = 0;
  private closed = false;

  constructor(
    readonly auth: ConnectionAuth,
    readonly transport: ServerConnectionTransport,
    private readonly server: RacpServer,
    origin: "ssh" | "gateway" = "ssh",
  ) {
    this.principal = { ...auth.principal, connectionId: this.id };
    this.origin = origin;
  }

  send(message: JsonRpcMessage): void {
    if (this.closed) return;
    try {
      this.transport.send(encodeFrame(message));
    } catch (error) {
      this.server.log("warn", "racp send failed", { connectionId: this.id, error: String(error) });
    }
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** A server-initiated request (spec §4.3); resolves with the client's result. */
  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    this.serverRequestCounter += 1;
    const id = `srv_${this.serverRequestCounter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingServerRequests.delete(id);
        reject(new RacpError("TOOL_FAILED", `client did not answer ${method} in time`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingServerRequests.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  handleResponse(id: JsonRpcId, result: unknown, error: JsonRpcErrorObject | undefined): void {
    const waiter = this.pendingServerRequests.get(String(id));
    if (!waiter) return;
    this.pendingServerRequests.delete(String(id));
    clearTimeout(waiter.timer);
    if (error) waiter.reject(new RacpError(error.data?.code ?? "TOOL_FAILED", error.message));
    else waiter.resolve(result);
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pendingServerRequests.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new RacpError("AGENT_UNAVAILABLE", "connection closed"));
    }
    this.pendingServerRequests.clear();
    try {
      this.transport.close(code, reason);
    } catch {
      // Already gone.
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * The operations the read-only file panel is made of (protocol §6.2).
 *
 * They are gated by the per-connection `workspaceRead` capability on top of
 * their `viewer` role, so a Host can offer the panel to a same-account desktop
 * and withhold it from a phone without inventing a second operation catalog.
 */
const WORKSPACE_READ_OPERATIONS: ReadonlySet<RacpOperation> = new Set([
  "workspace/list",
  "workspace/read",
  "workspace/diff",
]);

/**
 * The capabilities `connection/initialize` reports for one server.
 *
 * Everything here is a property of the Host's wiring; `workspaceRead` is the
 * one field a Host may answer per connection (see `capabilitiesFor`).
 */
function buildCapabilities(operations: RacpHostOperations): RacpServerCapabilities {
  return {
    eventReplay: true,
    snapshot: true,
    approvals: true,
    inputRequests: true,
    attachments: Boolean(operations.inlineAttachments),
    serverRequests: true,
    turnQueue: true,
    hostEvents: true,
    history: true,
    remoteHostProfile: true,
    toolRelay: false,
    terminal: Boolean(operations.terminal),
    workspaceTools: Boolean(operations.workspaceTools),
    workspaceFiles: Boolean(operations.workspaceFiles),
    // Additive and optional (D6): only a Host that can resolve a session's
    // recorded attachments advertises the read, which is what a phone checks
    // before it asks for an image instead of showing a broken preview.
    ...(operations.sessionMedia ? { sessionMediaRead: true } : {}),
    notifications: false,
    bindings: ["RACP-WS"],
  };
}

/**
 * The `RACP-WS` server core: connection admission, initialization, request
 * dispatch with role checks from the operation catalog, event fan-out from
 * the Agent Host hub, and connection teardown that releases every
 * subscription and terminal the connection held. Transport framing is
 * injected so the same core runs over `ws` in `agent-host-cli` and over an
 * in-memory pair in tests.
 */
export class RacpServer {
  readonly limits: RacpLimits;
  readonly policy: RacpPolicy;
  readonly capabilities: RacpServerCapabilities;
  private readonly connections = new Map<string, RacpConnection>();
  private readonly handlers: Map<RacpOperation, OperationHandler>;
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly options: RacpServerOptions) {
    this.limits = { ...RACP_DEFAULT_LIMITS, ...options.limits };
    this.policy = { ...RACP_DEFAULT_POLICY, ...options.policy };
    this.now = options.now ?? (() => Date.now());
    this.capabilities = buildCapabilities(options.operations);
    this.handlers = createOperations();
  }

  /**
   * The capabilities this one connection was told about.
   *
   * `workspaceRead` is the only field that varies by principal: the Host
   * decides it from the device class (protocol §6.2), so a phone and a
   * same-account desktop on the same server see different answers. Everything
   * else is a property of the server's wiring.
   */
  capabilitiesFor(principal: Principal): RacpServerCapabilities {
    const read = this.options.operations.workspaceRead;
    if (!read) return this.capabilities;
    return { ...this.capabilities, workspaceRead: read(principal) };
  }

  get log(): RacpServerOptions["log"] {
    return this.options.log;
  }

  connectionCount(): number {
    return this.connections.size;
  }

  /**
   * Admit one authenticated transport. Returns the connection, or `null`
   * when the Host is at its client limit (the transport is closed with
   * `RATE_LIMITED`).
   */
  accept(
    auth: ConnectionAuth,
    transport: ServerConnectionTransport,
    origin: "ssh" | "gateway" = "ssh",
  ): RacpConnection | null {
    if (this.closed) {
      transport.close(1001, "server closing");
      return null;
    }
    if (this.connections.size >= this.limits.maxConnectedClients) {
      this.options.log("warn", "racp connection refused: client limit", { limit: this.limits.maxConnectedClients });
      transport.close(1013, "RATE_LIMITED");
      return null;
    }
    const connection = new RacpConnection(auth, transport, this, origin);
    this.connections.set(connection.id, connection);
    const initializeTimer = setTimeout(() => {
      if (!connection.initialized) {
        this.options.log("warn", "racp connection closed: initialize deadline", { connectionId: connection.id });
        connection.close(1002, "PROTOCOL_MISMATCH");
      }
    }, this.options.initializeTimeoutMs ?? 10_000);
    initializeTimer.unref?.();
    transport.onMessage((frame, byteLength) => {
      if (byteLength > this.limits.maxFrameBytes) {
        connection.send({
          jsonrpc: "2.0",
          id: 0,
          error: errorObjectFrom(new RacpError("PAYLOAD_TOO_LARGE", "frame exceeds maxFrameBytes"), this.traceId()),
        });
        return;
      }
      void this.handleFrame(connection, frame);
    });
    transport.onClose(() => {
      clearTimeout(initializeTimer);
      this.release(connection);
    });
    this.options.log("info", "racp connection accepted", {
      connectionId: connection.id,
      subject: auth.principal.subject,
      kind: auth.kind,
    });
    return connection;
  }

  /**
   * Revocation (security §3.7, gate 26): close every connection whose
   * principal is `subject` and return how many were closed. Loopback
   * `RACP-WS` connections and Host link logical connections are both ordinary
   * entries here, so one implementation covers either channel and each is
   * released through the normal teardown path.
   */
  closeConnectionsForSubject(subject: string, reason: string): number {
    let closed = 0;
    for (const connection of [...this.connections.values()]) {
      if (connection.principal.subject !== subject) continue;
      connection.close(1000, reason);
      this.release(connection);
      closed += 1;
    }
    if (closed > 0) this.options.log("info", "racp connections closed for subject", { subject, reason, closed });
    return closed;
  }

  /** Stop accepting and close every connection; running turns are untouched. */
  close(): void {
    this.closed = true;
    for (const connection of [...this.connections.values()]) {
      connection.close(1001, "server closing");
      this.release(connection);
    }
  }

  private traceId(): string {
    return `trace_${randomUUID()}`;
  }

  private release(connection: RacpConnection): void {
    if (!this.connections.delete(connection.id)) return;
    for (const subscription of connection.subscriptions.values()) {
      this.options.agentHost.unsubscribe(subscription.id, subscription.sessionId);
    }
    connection.subscriptions.clear();
    for (const terminalId of connection.terminals) {
      this.options.operations.terminal?.detach(terminalId);
    }
    connection.terminals.clear();
    void this.options.operations.workspaceTools?.disconnect(connection.id).catch(() => {
      this.options.log("warn", "workspace tool disconnect cleanup failed", { connectionId: connection.id });
    });
    connection.close(1000, "closed");
    this.options.log("info", "racp connection released", { connectionId: connection.id });
  }

  private async handleFrame(connection: RacpConnection, frame: string): Promise<void> {
    const message = parseFrame(frame);
    if (!message) {
      connection.send({
        jsonrpc: "2.0",
        id: 0,
        error: errorObjectFrom(new RacpError("INVALID_ARGUMENT", "frame is not a JSON-RPC 2.0 message"), this.traceId()),
      });
      return;
    }
    if (isResponse(message)) {
      connection.handleResponse(message.id, message.result, message.error);
      return;
    }
    if (!isRequest(message)) {
      if (isNotification(message) && message.method === RACP_INITIALIZED_NOTIFICATION) connection.initialized = true;
      return;
    }
    // A client-supplied trace id is untrusted input that ends up in log lines,
    // audit records, and error payloads. A value that is not a bounded,
    // log-safe id is replaced with a locally generated one: never sanitized,
    // never echoed.
    const traceId = isRacpTraceId((message as { traceId?: unknown }).traceId)
      ? (message as { traceId: string }).traceId
      : this.traceId();
    const startedAt = Date.now();
    try {
      const result = await this.dispatch(connection, message.method, message.params, traceId);
      connection.send({ jsonrpc: "2.0", id: message.id, result });
      this.logLatency(connection, message.method, traceId, Date.now() - startedAt);
    } catch (error) {
      if (!(error instanceof RacpError)) {
        this.options.log("error", "racp operation failed", { method: message.method, traceId, error: String(error) });
      }
      connection.send({ jsonrpc: "2.0", id: message.id, error: errorObjectFrom(error, traceId) });
      this.logLatency(connection, message.method, traceId, Date.now() - startedAt);
    }
  }

  /** One opt-in timing record at the Host: receive → dispatch complete → send. */
  private logLatency(connection: RacpConnection, method: string, traceId: string, durationMs: number): void {
    if (this.options.latencyTrace !== true) return;
    this.options.log("info", "remote latency", {
      stage: "host.execute",
      method,
      traceId,
      connectionId: connection.id,
      origin: connection.origin,
      durationMs,
    });
  }

  private async dispatch(connection: RacpConnection, method: string, params: unknown, traceId: string): Promise<unknown> {
    if (method === "connection/initialize") {
      if (connection.initialized) throw new RacpError("CONFLICT", "the connection is already initialized");
      return this.initialize(connection, params);
    }
    if (!connection.initialized) {
      throw new RacpError("PROTOCOL_MISMATCH", "connection/initialize must complete first");
    }
    if (!(method in RACP_OPERATIONS)) throw new RacpError("METHOD_NOT_FOUND", `unknown operation ${method}`);
    const operation = method as RacpOperation;
    const handler = this.handlers.get(operation);
    if (!handler) throw new RacpError("METHOD_NOT_FOUND", `unknown operation ${method}`);
    if (!rolesAllowOperation(connection.principal.roles, operation)) {
      throw new RacpError("FORBIDDEN", `principal lacks the role for ${operation}`);
    }
    // The workspace panel is offered per device class where a Host says so
    // (protocol §6.2): the role check above already ran, and this is the extra
    // answer a desktop Host gives for a phone. `undefined` means the Host asked
    // no such question, so the operation catalog alone decides — the behaviour
    // of every Host before this gate existed.
    const capabilities = this.capabilitiesFor(connection.principal);
    if (WORKSPACE_READ_OPERATIONS.has(operation) && capabilities.workspaceRead === false) {
      throw new RacpError("FORBIDDEN", `${operation} is not available to this device`);
    }
    const context: OperationContext = {
      connection,
      principal: connection.principal,
      agentHost: this.options.agentHost,
      operations: this.options.operations,
      authenticator: this.options.authenticator,
      limits: this.limits,
      capabilities,
      traceId,
      now: this.now,
      deliverEvent: (envelope) => this.deliverEvent(connection, envelope),
      closeSubscription: (subscriptionId, error, lastSafeCursor) => {
        connection.subscriptions.delete(subscriptionId);
        connection.notify(RACP_SUBSCRIPTION_CLOSED_NOTIFICATION, {
          subscriptionId,
          error: error.toRemoteError(this.traceId()),
          lastSafeCursor,
        });
      },
      log: this.options.log,
    };
    return handler(context, (params ?? {}) as Record<string, unknown>);
  }

  private deliverEvent(connection: RacpConnection, envelope: RacpEventEnvelope): void {
    connection.notify(RACP_EVENT_NOTIFICATION, envelope);
  }

  private initialize(connection: RacpConnection, params: unknown): RacpInitializeResult {
    if (!Value.Check(RacpInitializeParamsSchema, params)) {
      throw new RacpError("INVALID_ARGUMENT", "invalid connection/initialize params");
    }
    if (!protocolVersionsCompatible(RACP_PROTOCOL_VERSION, params.protocolVersion)) {
      throw new RacpError("PROTOCOL_MISMATCH", `protocol ${params.protocolVersion} is not compatible with ${RACP_PROTOCOL_VERSION}`);
    }
    if (!params.bindings.includes("RACP-WS")) {
      throw new RacpError("PROTOCOL_MISMATCH", "client does not offer the RACP-WS binding");
    }
    // A pairing connection may only pair; everything else needs the device's roles.
    connection.initialized = true;
    return {
      protocolVersion: RACP_PROTOCOL_VERSION,
      server: { name: this.options.serverName ?? "agent-host-cli", version: this.options.serverVersion, hostId: this.options.hostId },
      connectionId: connection.id,
      principal: { subject: connection.principal.subject, roles: [...connection.principal.roles] },
      capabilities: this.capabilitiesFor(connection.principal),
      limits: this.limits,
      policy: this.policy,
    };
  }
}
