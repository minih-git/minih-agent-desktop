/**
 * Raw TCP and TLS connections owned by the host (permission `net.tcp`).
 *
 * A plugin asks for an endpoint and then writes and receives bytes; it never
 * gets the socket, the TLS session, or the event loop behind it. That is what
 * makes the guarantees here enforceable at all:
 *
 * - The caller matches the endpoint against `manifest.net.tcp` before it gets
 *   here; this module only owns the shape and the bounds of what it dials.
 * - TLS verification is not negotiable: the socket always verifies the peer
 *   against the platform trust store, and SNI is the endpoint host, so a
 *   connection cannot be downgraded or pointed at a different name. A test may
 *   inject a trust anchor, but there is no plugin-facing path to that option.
 * - Every connection is bounded: a per-plugin count that includes connects in
 *   flight, a write buffer ceiling, a bounded connect timeout, and no idle
 *   timeout once the connection is up (a plugin's protocol owns its own
 *   liveness, and a host that closed slow sockets would break mail and
 *   database clients that legitimately wait).
 * - Every connection dies with its plugin. `releasePlugin` runs on disable,
 *   unload, crash and quit, and settles any `connect` still in flight so the
 *   caller never awaits a promise nobody will answer.
 * - Closing keeps the descriptor: after `close` the connection is `closing`
 *   and still owned (and still counted) until the peer finishes or the grace
 *   timer drops it, so unload can still destroy it and a plugin cannot hold
 *   four half-closed sockets plus four fresh ones. The handle itself is
 *   `NOT_FOUND` from the moment `close` is asked for.
 * - Traffic is accounted as daily totals per peer (`plugin_tcp_usage`), handed
 *   to `onUsage` on close and in periodic batches. A failed write is retried,
 *   never dropped, and `flush` / `dispose` are the caller's shutdown path.
 *
 * The user's HTTP proxy is not consulted, exactly as the install review says:
 * a raw socket is not an HTTP request, so proxying it would be a lie.
 */
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { PluginSocketError } from "./plugin-websocket";

/** Concurrent connections, in-flight connects included. */
export const MAX_CONNECTIONS_PER_PLUGIN = 4;
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** A caller may ask for longer, and gets this instead. */
export const MAX_CONNECT_TIMEOUT_MS = 60_000;
/** Unflushed bytes allowed per connection before `send` refuses. */
export const MAX_WRITE_BUFFER_BYTES = 1024 * 1024;
export const USAGE_FLUSH_INTERVAL_MS = 60_000;
/**
 * One `onUsage` call is one write transaction on the host side, and the store
 * takes one plugin + one day at a time in at most this many rows. Anything
 * larger is split, and each call commits on its own.
 */
export const MAX_USAGE_RECORDS_PER_CALL = 256;
/** A half-closed connection whose peer never finishes is dropped after this. */
const CLOSE_GRACE_MS = 5_000;

/** One endpoint the caller already matched against `manifest.net.tcp`. */
export type PluginTcpEndpoint = {
  host: string;
  port: number;
  tls: boolean;
};

/** One lifecycle change, routed to the plugin that owns the connection. */
export type PluginTcpEvent =
  | { type: "open"; connectionId: string }
  | { type: "data"; connectionId: string; data: Uint8Array }
  | { type: "close"; connectionId: string; hadError: boolean }
  | { type: "error"; connectionId: string; code: string; message: string };

/** One daily counter row, the upsert target of `plugin_tcp_usage`. */
export type PluginTcpUsage = {
  /** Local calendar day (`YYYY-MM-DD`), which is what a usage view groups by. */
  day: string;
  pluginId: string;
  host: string;
  port: number;
  bytesIn: number;
  bytesOut: number;
};

export type PluginTcpConnectionInfo = {
  connectionId: string;
  host: string;
  port: number;
  tls: boolean;
  /** `closing` is still owned: the descriptor survives until the socket ends. */
  state: "connecting" | "open" | "closing" | "closed";
};

export type PluginTcpDependencies = {
  /** One event per plugin; the runtime forwards it to that plugin's process. */
  onEvent: (pluginId: string, event: PluginTcpEvent) => void;
  /**
   * One write transaction: every row in a call shares a plugin and a day, and
   * a call carries at most `MAX_USAGE_RECORDS_PER_CALL` rows. A rejection
   * re-queues that call only — a later one is not retried twice.
   */
  onUsage?: (usage: PluginTcpUsage[]) => Promise<void> | void;
  /** Observes a failed batch; the totals are kept, not dropped. */
  onUsageError?: (error: unknown) => void;
  /**
   * Test seam only: trust anchors for the sockets this registry dials. The
   * host sets it; no plugin call can reach it, so trust cannot be widened.
   */
  tlsCa?: string | Buffer | Array<string | Buffer>;
  /** Injected clock, so a test can cross a local day boundary. */
  now?: () => number;
  maxPerPlugin?: number;
  connectTimeoutMs?: number;
  maxWriteBufferBytes?: number;
  usageFlushIntervalMs?: number;
};

type Entry = {
  pluginId: string;
  connectionId: string;
  endpoint: PluginTcpEndpoint;
  socket: Socket | null;
  state: "connecting" | "open" | "closing" | "closed";
  /** Set while a `connect` awaits this connection; cleared once it is answered. */
  settle: ((error: PluginSocketError | null) => void) | null;
  opened: Promise<void>;
  finalized: boolean;
  timer: NodeJS.Timeout | null;
  graceTimer: NodeJS.Timeout | null;
};

export class PluginTcpRegistry {
  private readonly connections = new Map<string, Entry>();
  private readonly usage = new Map<string, PluginTcpUsage>();
  private readonly deps: PluginTcpDependencies;
  private readonly maxPerPlugin: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxWriteBufferBytes: number;
  private readonly now: () => number;
  private flushTimer: NodeJS.Timeout | null = null;
  /** Serialises batches so a retry cannot overtake the batch before it. */
  private flushChain: Promise<void> = Promise.resolve();
  private nextId = 1;

  constructor(deps: PluginTcpDependencies) {
    this.deps = deps;
    this.maxPerPlugin = deps.maxPerPlugin ?? MAX_CONNECTIONS_PER_PLUGIN;
    this.defaultTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.maxWriteBufferBytes = deps.maxWriteBufferBytes ?? MAX_WRITE_BUFFER_BYTES;
    this.now = deps.now ?? Date.now;
    if (deps.onUsage) {
      this.flushTimer = setInterval(
        () => this.flushInBackground(),
        deps.usageFlushIntervalMs ?? USAGE_FLUSH_INTERVAL_MS,
      );
      // A pending batch must not keep the app alive on its own.
      this.flushTimer.unref?.();
    }
  }

  /**
   * Dial one endpoint and resolve once it is usable. The endpoint is assumed to
   * have passed the caller's allowlist check already; the shape, the ceiling
   * and the deadline here are this method's own.
   */
  async connect(request: {
    pluginId: string;
    endpoint: PluginTcpEndpoint;
    timeoutMs?: number;
  }): Promise<{ connectionId: string }> {
    const { pluginId } = request;
    if (typeof pluginId !== "string" || !pluginId.trim()) {
      throw new PluginSocketError("INVALID_ARGUMENT", "pluginId is required");
    }
    const endpoint = parseEndpoint(request.endpoint);
    const timeoutMs = parseTimeout(request.timeoutMs, this.defaultTimeoutMs);
    if (this.countFor(pluginId) >= this.maxPerPlugin) {
      throw new PluginSocketError(
        "LIMIT_EXCEEDED",
        `a plugin may hold at most ${this.maxPerPlugin} connections`,
      );
    }

    const entry: Entry = {
      pluginId,
      connectionId: `tcp-${this.nextId++}`,
      endpoint,
      socket: null,
      state: "connecting",
      settle: null,
      opened: Promise.resolve(),
      finalized: false,
      timer: null,
      graceTimer: null,
    };
    entry.opened = new Promise<void>((resolve, reject) => {
      entry.settle = (error) => (error ? reject(error) : resolve());
    });
    // Registered before dialing, so a connect in flight spends the budget.
    this.connections.set(entryKey(pluginId, entry.connectionId), entry);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.abort(
        entry,
        new PluginSocketError(
          "TIMEOUT",
          `connection to ${endpoint.host}:${endpoint.port} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    entry.timer.unref?.();

    try {
      this.dial(entry);
      await entry.opened;
      return { connectionId: entry.connectionId };
    } catch (error) {
      throw error instanceof PluginSocketError
        ? error
        : new PluginSocketError("CONNECT_FAILED", describe(error));
    } finally {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.settle = null;
    }
  }

  /** Queue bytes. Refuses rather than growing the write buffer without bound. */
  send(request: { pluginId: string; connectionId: string; data: Uint8Array | string }): void {
    const entry = this.require(request.pluginId, request.connectionId);
    const socket = entry.socket;
    if (entry.state !== "open" || !socket || socket.destroyed) {
      throw new PluginSocketError(
        "NOT_FOUND",
        `no open connection for this plugin: ${request.connectionId}`,
      );
    }
    const bytes = toBytes(request.data);
    const buffered = socket.writableLength;
    if (buffered + bytes.byteLength > this.maxWriteBufferBytes) {
      throw new PluginSocketError(
        "LIMIT_EXCEEDED",
        `write buffer would exceed ${this.maxWriteBufferBytes} bytes; wait for the connection to drain`,
      );
    }
    socket.write(bytes);
    this.count(entry, 0, bytes.byteLength);
  }

  /**
   * Half-close one connection. The socket stays owned — and counted — until it
   * really ends, so unload can still destroy it and half-closed descriptors do
   * not buy extra connections. The handle itself is spent from this call on: a
   * second close, or a send that follows it, is NOT_FOUND.
   */
  close(request: { pluginId: string; connectionId: string }): void {
    const entry = this.require(request.pluginId, request.connectionId);
    if (entry.state === "connecting") {
      // Nothing is open to half-close: this is the release path, which also
      // answers the connect still waiting on it.
      this.release(entry, "the connection was closed before it opened");
      return;
    }
    const socket = entry.socket;
    entry.state = "closing";
    if (!socket) {
      this.finalize(entry, false);
      return;
    }
    socket.end();
    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = null;
      // Not an idle timeout on a live socket: this only drops a peer that
      // never finishes a close we already started.
      socket.destroy();
    }, CLOSE_GRACE_MS);
    entry.graceTimer.unref?.();
    this.flushInBackground();
  }

  /** Drop every connection of one plugin. Safe for an unknown plugin. */
  releasePlugin(pluginId: string): void {
    for (const entry of [...this.connections.values()]) {
      if (entry.pluginId !== pluginId) continue;
      this.release(entry, "the plugin was released before the connection opened");
    }
    this.flushInBackground();
  }

  /** Connections this plugin currently holds, in creation order. */
  list(pluginId: string): PluginTcpConnectionInfo[] {
    return [...this.connections.values()]
      .filter((entry) => entry.pluginId === pluginId)
      .map((entry) => ({
        connectionId: entry.connectionId,
        host: entry.endpoint.host,
        port: entry.endpoint.port,
        tls: entry.endpoint.tls,
        state: entry.state,
      }));
  }

  /**
   * Hand the accumulated daily totals to `onUsage`. Resolves once the store has
   * them; a rejection means the batch is back in the queue for the next call.
   */
  flush(): Promise<void> {
    const run = this.flushChain.then(
      () => this.drainUsage(),
      () => this.drainUsage(),
    );
    // The chain continues after a failed batch, so the retry is not blocked.
    this.flushChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Terminal teardown: stop the batch timer, drop every connection (settling
   * connects still in flight), then write what is left. Rejects only when that
   * last write fails, and the totals stay queued for another `flush`.
   */
  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    for (const entry of [...this.connections.values()]) {
      this.release(entry, "the connection was released before it opened");
    }
    await this.flush();
  }

  private dial(entry: Entry): void {
    const { host, port, tls } = entry.endpoint;
    let socket: Socket;
    try {
      socket = tls
        ? tlsConnect({
            host,
            port,
            // SNI is the endpoint host and verification is always on: there is
            // no option here that a plugin call could set.
            servername: host,
            rejectUnauthorized: true,
            ...(this.deps.tlsCa === undefined ? {} : { ca: this.deps.tlsCa }),
          })
        : netConnect({ host, port });
    } catch (error) {
      this.detach(entry);
      this.decide(entry, new PluginSocketError("CONNECT_FAILED", describe(error)));
      this.finalize(entry, true);
      return;
    }
    entry.socket = socket;
    socket.setNoDelay(true);
    // A TLS socket answers `connect` before the handshake; only `secureConnect`
    // means the peer is verified and usable.
    socket.once(tls ? "secureConnect" : "connect", () => {
      // Only a connection that is still being established may open: anything
      // else has already been answered by close, release or a failure.
      if (entry.finalized || entry.state !== "connecting") return;
      entry.state = "open";
      this.decide(entry, null);
      this.deps.onEvent(entry.pluginId, { type: "open", connectionId: entry.connectionId });
    });
    socket.on("data", (chunk: Buffer) => this.receive(entry, chunk));
    socket.on("error", (error: Error) => this.failed(entry, error));
    socket.on("close", (hadError: boolean) => this.finalize(entry, hadError));
  }

  private receive(entry: Entry, chunk: Buffer): void {
    if (entry.finalized || entry.state !== "open") return;
    // A copy: the socket's buffer belongs to Node and is reused for the next
    // read, so the plugin must not be handed a view into it.
    const data = new Uint8Array(chunk);
    this.count(entry, data.byteLength, 0);
    this.deps.onEvent(entry.pluginId, {
      type: "data",
      connectionId: entry.connectionId,
      data,
    });
  }

  private failed(entry: Entry, error: Error): void {
    if (entry.finalized) return;
    const reported = (error as { code?: unknown }).code;
    const code = typeof reported === "string" ? reported : "SOCKET_ERROR";
    // A connect that is still waiting learns the real reason, not just "closed",
    // and stops spending the plugin's budget the moment it is answered.
    if (entry.settle) {
      this.detach(entry);
      this.decide(entry, new PluginSocketError("CONNECT_FAILED", error.message));
    }
    this.deps.onEvent(entry.pluginId, {
      type: "error",
      connectionId: entry.connectionId,
      code,
      message: error.message,
    });
    // A socket-level error is always fatal for this connection.
    entry.socket?.destroy();
  }

  /** Answer the pending `connect` once; later answers are ignored. */
  private decide(entry: Entry, error: PluginSocketError | null): void {
    const settle = entry.settle;
    entry.settle = null;
    settle?.(error);
  }

  /** Fail a connection that is still being established and let it go. */
  private abort(entry: Entry, error: PluginSocketError): void {
    this.detach(entry);
    this.decide(entry, error);
    entry.socket?.destroy();
  }

  /** Release one connection: settle a waiting `connect`, then destroy. */
  private release(entry: Entry, connectingMessage: string): void {
    this.detach(entry);
    this.decide(entry, new PluginSocketError("CONNECT_FAILED", connectingMessage));
    entry.state = "closed";
    if (!entry.socket) {
      this.finalize(entry, false);
      return;
    }
    // Destroy, not close: unload and revocation are not a negotiation.
    entry.socket.destroy();
  }

  /**
   * One connection's end: the entry leaves the registry once, the owner is
   * told once, and the totals are written. Arrives from the socket's own
   * `close`, which every path (end, destroy, error) reaches.
   */
  private finalize(entry: Entry, hadError: boolean): void {
    if (entry.finalized) return;
    entry.finalized = true;
    entry.state = "closed";
    this.detach(entry);
    this.decide(
      entry,
      new PluginSocketError(
        "CONNECT_FAILED",
        `the connection to ${entry.endpoint.host}:${entry.endpoint.port} closed before it opened`,
      ),
    );
    this.deps.onEvent(entry.pluginId, {
      type: "close",
      connectionId: entry.connectionId,
      hadError,
    });
    this.flushInBackground();
  }

  /** Idempotent: the entry stops counting once the socket is really gone. */
  private detach(entry: Entry): void {
    this.connections.delete(entryKey(entry.pluginId, entry.connectionId));
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
  }

  /**
   * The handle an owner may still use. A connection that is closing is already
   * spent; it stays in the registry only so the host can still destroy it.
   */
  private require(pluginId: string, connectionId: string): Entry {
    const entry = this.connections.get(entryKey(pluginId, connectionId));
    if (!entry || entry.state === "closing") {
      throw new PluginSocketError(
        "NOT_FOUND",
        `no open connection for this plugin: ${connectionId}`,
      );
    }
    return entry;
  }

  private countFor(pluginId: string): number {
    let count = 0;
    for (const entry of this.connections.values()) {
      if (entry.pluginId === pluginId) count += 1;
    }
    return count;
  }

  /** Accumulate one connection's traffic into its daily counter row. */
  private count(entry: Entry, bytesIn: number, bytesOut: number): void {
    const { host, port } = entry.endpoint;
    const record: PluginTcpUsage = {
      day: localDay(this.now()),
      pluginId: entry.pluginId,
      host,
      port,
      bytesIn,
      bytesOut,
    };
    const existing = this.usage.get(usageKey(record));
    if (existing) {
      existing.bytesIn += bytesIn;
      existing.bytesOut += bytesOut;
      return;
    }
    this.usage.set(usageKey(record), record);
  }

  /**
   * Write what is queued, one store call at a time. A call is one plugin and
   * one day (at most `MAX_USAGE_RECORDS_PER_CALL` rows), because that is what
   * the store commits in a single transaction; a call that fails is put back on
   * its own, and the calls that already committed are not sent again.
   */
  private async drainUsage(): Promise<void> {
    const onUsage = this.deps.onUsage;
    if (!onUsage || this.usage.size === 0) return;
    let failure: unknown = null;
    for (const records of this.takeUsageCalls()) {
      try {
        await onUsage(records);
      } catch (error) {
        // Only this group goes back: retrying a group that committed would
        // count the same bytes twice.
        this.mergeUsage(records);
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }

  /** Snapshot the queue as store calls: grouped by plugin + day, then chunked. */
  private takeUsageCalls(): PluginTcpUsage[][] {
    const groups = new Map<string, PluginTcpUsage[]>();
    for (const record of this.usage.values()) {
      const groupKey = `${record.pluginId}\u0000${record.day}`;
      const group = groups.get(groupKey);
      if (group) group.push(record);
      else groups.set(groupKey, [record]);
    }
    const calls: PluginTcpUsage[][] = [];
    for (const group of groups.values()) {
      for (let index = 0; index < group.length; index += MAX_USAGE_RECORDS_PER_CALL) {
        // Copies: traffic that arrives while the call is in flight must not
        // mutate a batch that is already being written.
        const records = group
          .slice(index, index + MAX_USAGE_RECORDS_PER_CALL)
          .map((record) => ({ ...record }));
        for (const record of records) this.usage.delete(usageKey(record));
        calls.push(records);
      }
    }
    return calls;
  }

  private mergeUsage(batch: readonly PluginTcpUsage[]): void {
    for (const record of batch) {
      const key = usageKey(record);
      const existing = this.usage.get(key);
      if (!existing) {
        this.usage.set(key, { ...record });
        continue;
      }
      existing.bytesIn += record.bytesIn;
      existing.bytesOut += record.bytesOut;
    }
  }

  /** A batch nobody is awaiting: report the failure, keep the totals. */
  private flushInBackground(): void {
    void this.flush().catch((error) => this.deps.onUsageError?.(error));
  }
}

/** `host` and `port` are the caller's allowlist's business; the shape is ours. */
function parseEndpoint(raw: unknown): PluginTcpEndpoint {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PluginSocketError("INVALID_ARGUMENT", "endpoint is required");
  }
  const { host, port, tls } = raw as Partial<PluginTcpEndpoint>;
  if (typeof host !== "string" || !host.trim()) {
    throw new PluginSocketError("INVALID_ARGUMENT", "endpoint.host is required");
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PluginSocketError("INVALID_ARGUMENT", "endpoint.port must be an integer from 1 to 65535");
  }
  if (typeof tls !== "boolean") {
    throw new PluginSocketError("INVALID_ARGUMENT", "endpoint.tls must be true or false");
  }
  return { host: host.trim().toLowerCase(), port, tls };
}

function parseTimeout(raw: unknown, fallback: number): number {
  if (raw === undefined) return Math.min(fallback, MAX_CONNECT_TIMEOUT_MS);
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new PluginSocketError("INVALID_ARGUMENT", "timeoutMs must be a positive number");
  }
  // A caller may ask for longer and waits at most the ceiling.
  return Math.min(raw, MAX_CONNECT_TIMEOUT_MS);
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (typeof data === "string") return new Uint8Array(Buffer.from(data, "utf8"));
  throw new PluginSocketError("INVALID_ARGUMENT", "data must be a string or a Uint8Array");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The day bucket of `plugin_tcp_usage`: the local calendar day, not UTC. */
function localDay(now: number): string {
  const date = new Date(now);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function entryKey(pluginId: string, connectionId: string): string {
  return `${pluginId}\u0000${connectionId}`;
}

/** One `plugin_tcp_usage` row: plugin, peer and day are the primary key. */
function usageKey(record: {
  pluginId: string;
  host: string;
  port: number;
  day: string;
}): string {
  return `${record.pluginId}\u0000${record.host}\u0000${record.port}\u0000${record.day}`;
}