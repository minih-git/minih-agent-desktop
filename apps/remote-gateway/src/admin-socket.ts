/**
 * Owner-only admin channel. Mutating CLI subcommands (`enroll-code`,
 * `hosts revoke`, `devices revoke`) must reach the running `serve` process so
 * the in-memory token cache, live links, and logical connections change
 * immediately — a revocation has to take effect within five seconds
 * (security gate 26), which a cold edit of `devices.json` cannot guarantee.
 *
 * The socket sits at `<data-dir>/admin.sock`, mode 0600, and only answers the
 * documented operations.
 */
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join, relative } from "node:path";

export const ADMIN_MAX_BYTES = 8 * 1024;
const RESPONSE_MAX_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export type AdminOperation = "enroll-code.issue" | "hosts.revoke" | "devices.revoke" | "account-sessions.revoke";

export type AdminRequest =
  | { op: "enroll-code.issue"; payload: { label?: string } }
  | { op: "hosts.revoke"; payload: { hostId: string } }
  | { op: "devices.revoke"; payload: { deviceId: string } }
  | { op: "account-sessions.revoke"; payload: { sessionId: string } };

export type AdminResponse =
  | { ok: true; enrollment?: { code: string; expiresAt: string }; revoked?: boolean; closedConnections?: number; cascaded?: number }
  | { ok: false; code: "INVALID_REQUEST" | "NOT_FOUND" | "ADMIN_UNAVAILABLE" | "ADMIN_BUSY" };

/** The CLI's "serve is not running" signal. */
export class GatewayNotRunning extends Error {
  readonly code = "GATEWAY_NOT_RUNNING";

  constructor() {
    super("gateway is not running");
    this.name = "GatewayNotRunning";
  }
}

/**
 * Unix socket paths are bounded (104 bytes on macOS, 108 on Linux), so a deep
 * data directory falls back to a path relative to the working directory —
 * both ends of the socket resolve it from the same place.
 */
export function adminSocketPath(dataDir: string): string {
  const absolute = join(dataDir, "admin.sock");
  const local = relative(process.cwd(), absolute);
  return local && Buffer.byteLength(local) < Buffer.byteLength(absolute) ? local : absolute;
}

/**
 * The platform limit for a unix socket path (macOS 104, Linux 108) is easy to
 * exceed from a deep data directory; fail with the reason instead of EINVAL.
 */
export function assertSocketPathFits(path: string): void {
  const limit = process.platform === "darwin" ? 103 : 107;
  if (Buffer.byteLength(path) > limit) {
    throw new Error(`the admin socket path is longer than ${limit} bytes: ${path}; use a shorter --data-dir`);
  }
}

function isAdminRequest(value: unknown): value is AdminRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const request = value as { op?: unknown; payload?: unknown };
  if (typeof request.payload !== "object" || request.payload === null) return false;
  const payload = request.payload as Record<string, unknown>;
  if (request.op === "enroll-code.issue") return payload["label"] === undefined || typeof payload["label"] === "string";
  if (request.op === "hosts.revoke") return typeof payload["hostId"] === "string" && payload["hostId"].length > 0;
  if (request.op === "devices.revoke") return typeof payload["deviceId"] === "string" && payload["deviceId"].length > 0;
  if (request.op === "account-sessions.revoke") return typeof payload["sessionId"] === "string" && payload["sessionId"].length > 0;
  return false;
}

function readCapped(socket: Socket, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    socket.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        socket.destroy();
        reject(new Error("the admin request is too large"));
        return;
      }
      chunks.push(chunk);
    });
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

export type AdminSocket = { path: string; close(): Promise<void> };

export async function startGatewayAdminSocket(options: {
  dataDir: string;
  handle: (request: AdminRequest) => Promise<AdminResponse>;
}): Promise<AdminSocket> {
  const path = adminSocketPath(options.dataDir);
  assertSocketPathFits(path);
  // Remove a stale socket from a crashed run, but never a live one.
  try {
    const info = await lstat(path);
    if (info.isSocket()) {
      const live = await probe(path);
      if (live) throw new Error(`another gateway is already serving ${path}`);
      await unlink(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const sockets = new Set<Socket>();
  // `allowHalfOpen`: the CLI ends its half after writing the request, and the
  // reply must still be able to travel back on the same connection.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (sockets.size >= 4) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const timer = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    void readCapped(socket, ADMIN_MAX_BYTES)
      .then(async (raw): Promise<AdminResponse> => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return { ok: false, code: "INVALID_REQUEST" };
        }
        if (!isAdminRequest(parsed)) return { ok: false, code: "INVALID_REQUEST" };
        return options.handle(parsed);
      })
      .catch((): AdminResponse => ({ ok: false, code: "ADMIN_UNAVAILABLE" }))
      .then((response) => {
        clearTimeout(timer);
        if (socket.destroyed) return;
        socket.end(`${JSON.stringify(response)}\n`);
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(path, 0o600);
  return {
    path,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    },
  };
}

function probe(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * CLI side: send one request to the running gateway. A missing or unresponsive
 * socket reports "gateway is not running" instead of creating state.
 */
export async function sendAdminRequest(dataDir: string, request: AdminRequest): Promise<AdminResponse> {
  const path = adminSocketPath(dataDir);
  try {
    const info = await lstat(path);
    if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new GatewayNotRunning();
  } catch (error) {
    if (error instanceof GatewayNotRunning) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new GatewayNotRunning();
    throw error;
  }
  return new Promise<AdminResponse>((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new GatewayNotRunning());
    }, REQUEST_TIMEOUT_MS);
    socket.on("error", () => {
      clearTimeout(timer);
      reject(new GatewayNotRunning());
    });
    const response = readCapped(socket, RESPONSE_MAX_BYTES);
    socket.once("connect", () => socket.end(JSON.stringify(request)));
    void response.then(
      (raw) => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(raw) as AdminResponse;
          if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) throw new Error("malformed admin response");
          resolve(parsed);
        } catch (error) {
          reject(error instanceof Error ? error : new Error("malformed admin response"));
        }
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new GatewayNotRunning());
      },
    );
  });
}

/** Ownership check on the socket path itself (`lstat` never follows a link). */
export async function socketIsPrivate(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isSocket() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
