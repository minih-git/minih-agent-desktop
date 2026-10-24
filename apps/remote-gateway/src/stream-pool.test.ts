/**
 * The per-device stream bound is a resource limit, not a verdict.
 *
 * A phone that is suspended cannot send its abort, so the Gateway keeps counting
 * a socket the network has already abandoned. The bug this pins: the fifth
 * subscription was refused with `RATE_LIMITED`, the client retried with backoff,
 * and the user watched "reconnecting" until the zombie slots timed out. The
 * newest stream now wins.
 */
import { expect, it } from "vitest";

import { HostLinkGatewayMux, type HostLinkSocket } from "@minih-agent/racp";
import { RACP_HOSTLINK_VERSION, RACP_PROTOCOL_VERSION } from "@minih-agent/shared";

import { LogicalConnectionPool, MAX_STREAM_CONNECTIONS_PER_DEVICE, type ConnectionIdentity, type GatewayLog } from "./router.js";

/**
 * A Host link that answers `connection/initialize`.
 *
 * Every stream the pool opens initializes its own logical connection, so without
 * this answer each `stream()` call would wait forever instead of returning the
 * connection the test wants to inspect.
 */
class AutoReplyingSocket implements HostLinkSocket {
  private message: ((frame: string) => void) | null = null;
  private closed: (() => void) | null = null;

  send(frame: string): boolean {
    const parsed = JSON.parse(frame) as { type?: string; clientConnectionId?: string; message?: string };
    // A Host answers a client's JSON-RPC request inside a `host.message` frame,
    // which is the only shape the mux routes back to a logical connection.
    if (parsed.type === "client.message" && parsed.message) {
      const inner = JSON.parse(parsed.message) as { id?: number; method?: string };
      if (inner.method === "connection/initialize" && inner.id !== undefined) {
        const answer = JSON.stringify({ jsonrpc: "2.0", id: inner.id, result: { protocolVersion: RACP_PROTOCOL_VERSION } });
        queueMicrotask(() => {
          this.message?.(
            JSON.stringify({
              link: RACP_HOSTLINK_VERSION,
              type: "host.message",
              clientConnectionId: parsed.clientConnectionId,
              message: answer,
            }),
          );
        });
      }
    }
    return true;
  }

  close(): void {
    this.closed?.();
  }

  onMessage(handler: (frame: string) => void): void {
    this.message = handler;
  }

  onClose(handler: () => void): void {
    this.closed = handler;
  }

  onError(): void {
    // No error path is exercised here.
  }
}

type Logged = { level: string; message: string; fields: Record<string, unknown> };

function harness(): {
  pool: LogicalConnectionPool;
  logs: Logged[];
  identity: (deviceId: string, hostId?: string) => ConnectionIdentity;
} {
  const logs: Logged[] = [];
  const log: GatewayLog = (level, message, fields) => {
    logs.push({ level, message, fields: (fields ?? {}) as Record<string, unknown> });
  };
  const pool = new LogicalConnectionPool({
    links: {
      // One fake mux per connection: the id is unique, so nothing is shared
      // between two logical connections on the same Host.
      muxFor: () => new HostLinkGatewayMux(new AutoReplyingSocket(), () => undefined),
    },
    log,
  });
  return {
    pool,
    logs,
    identity: (deviceId: string, hostId = "host_1") => ({ hostId, deviceId, credential: "pdt1.fixture" }),
  };
}

/** The per-device stream bound the Gateway enforces. */
const LIMIT = MAX_STREAM_CONNECTIONS_PER_DEVICE;

function sessions(count: number, prefix = "s"): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);
}

it("evicts the oldest stream instead of refusing the newest one", async () => {
  const { pool, logs, identity } = harness();
  const device = identity("dev_a");
  const opened = [];
  for (const sessionId of sessions(LIMIT)) opened.push(await pool.stream(device, `session:${sessionId}`));
  const finished: string[] = [];
  // Registered the way `serveEventStream` registers its own close handler, so a
  // fired callback here is exactly the unsubscribe-and-end that frees the slot.
  for (const [index, connection] of opened.entries()) connection.onClose(() => finished.push(`s${index + 1}`));

  // The one past the bound is what a suspended phone opens after coming back; it
  // must be accepted, not answered with RATE_LIMITED.
  const newest = await pool.stream(device, "session:s13");

  expect(newest.isClosed).toBe(false);
  expect(opened[0]?.isClosed).toBe(true);
  expect(finished).toEqual(["s1"]);
  expect(opened.slice(1).every((connection) => !connection.isClosed)).toBe(true);
  // The bound still holds the live connections to twelve.
  expect(pool.size).toBe(LIMIT);
  expect(logs).toContainEqual(
    expect.objectContaining({
      level: "info",
      message: "gateway stream superseded",
      fields: expect.objectContaining({ reason: "oldest stream", streamKey: "session:s13" }),
    }),
  );
});

it("closes the earlier stream of the same session on a re-subscribe", async () => {
  const { pool, logs, identity } = harness();
  const device = identity("dev_b");
  const first = await pool.stream(device, "session:s1");
  const other = await pool.stream(device, "session:s2");
  const finished: string[] = [];
  first.onClose(() => finished.push("first"));

  // The same device never needs two streams of one session: this is the same
  // client reopening, not a second reader.
  const second = await pool.stream(device, "session:s1");

  expect(first.isClosed).toBe(true);
  expect(second.isClosed).toBe(false);
  expect(other.isClosed).toBe(false);
  expect(finished).toEqual(["first"]);
  expect(logs).toContainEqual(
    expect.objectContaining({ message: "gateway stream superseded", fields: expect.objectContaining({ reason: "same subscription" }) }),
  );
});

it("leaves another device's streams alone", async () => {
  const { pool, identity } = harness();
  const mine = identity("dev_c");
  const theirs = identity("dev_d");
  const theirStreams = [];
  for (const sessionId of sessions(3, "t")) theirStreams.push(await pool.stream(theirs, `session:${sessionId}`));

  const opened = [];
  for (const sessionId of sessions(LIMIT)) opened.push(await pool.stream(mine, `session:${sessionId}`));
  await pool.stream(mine, "session:s13");

  expect(opened[0]?.isClosed).toBe(true);
  expect(theirStreams.every((connection) => !connection.isClosed)).toBe(true);
  expect(pool.size).toBe(LIMIT + 3);
});