import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join, relative } from "node:path";
import {
  PROVIDER_SYNC_MAX_BYTES, parseProviderImportPayload, parseProviderImportSummary,
  type ProviderImportPayload, type ProviderImportSummary,
} from "@minih-agent/shared";
import {
  IMPORT_DEADLINE_MS, ImportFailure, importFailureCode, importProviders, readCapped,
  type HostCaller, type ImportFailureCode,
} from "./provider-import.js";

export const ADMIN_MAX_BYTES = PROVIDER_SYNC_MAX_BYTES + 128;
const RESPONSE_MAX_BYTES = 64 * 1024;
const FAILURE_CODES: readonly ImportFailureCode[] = ["INVALID_REQUEST", "PAYLOAD_TOO_LARGE", "ADMIN_UNAVAILABLE", "ADMIN_BUSY", "TIMEOUT", "IMPORT_FAILED"];
/**
 * Two operations share the admin channel: `providers.import` (the SSH bootstrap
 * import) and `pairing.issue` (a gateway-origin pairing code minted by a
 * running instance, PR-2). Both are owner-only and bounded.
 */
export type AdminResponse =
  | { ok: true; summary: ProviderImportSummary }
  | { ok: true; pairing: { token: string; expiresAt: string } }
  | { ok: false; code: ImportFailureCode };

/** Whether a response carries a provider import summary. */
export function isImportResponse(response: AdminResponse): response is { ok: true; summary: ProviderImportSummary } | { ok: false; code: ImportFailureCode } {
  return "summary" in response || !response.ok;
}

export type AdminRequest =
  | { op: "providers.import"; payload: ProviderImportPayload }
  | { op: "pairing.issue"; payload: { lifetimeMs?: number } };
export type AdminSocket = { path: string; close(): Promise<void> };
type Log = (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;

export function adminSocketPath(dataDir: string): string {
  const path = join(dataDir, "agent-host-cli", "admin.sock");
  // Relative paths also allow deeply nested isolated test data on macOS.
  const local = relative(process.cwd(), path);
  return Buffer.byteLength(local) < Buffer.byteLength(path) ? local : path;
}
export async function prepareAdminDirectory(dataDir: string): Promise<void> {
  if (process.platform === "win32" || !process.getuid) throw new ImportFailure("ADMIN_UNAVAILABLE");
  for (const dir of [dataDir, join(dataDir, "agent-host-cli")]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new ImportFailure("ADMIN_UNAVAILABLE");
  }
}
async function privateSocket(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new ImportFailure("ADMIN_UNAVAILABLE");
}
function probe(path: string): Promise<"live" | "stale"> {
  return new Promise((resolveProbe, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); reject(new ImportFailure("ADMIN_UNAVAILABLE")); }, 1000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolveProbe("live"); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolveProbe("stale");
      else reject(new ImportFailure("ADMIN_UNAVAILABLE"));
    });
  });
}
async function unlinkOwned(path: string, identity: { ino: number; dev: number }): Promise<void> {
  try {
    const now = await lstat(path);
    if (now.ino === identity.ino && now.dev === identity.dev) await unlink(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
/** Serializes socket ownership, including stale socket recovery, before host-core starts. */
async function claim(dataDir: string): Promise<() => Promise<void>> {
  const path = join(dataDir, "agent-host-cli", "admin.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const identity = await file.stat();
      try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
      return () => unlinkOwned(path, identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let identity;
      try {
        identity = await file.stat();
        if (!identity.isFile() || identity.uid !== process.getuid?.() || (identity.mode & 0o077) !== 0 || identity.size > 32) throw new ImportFailure("ADMIN_UNAVAILABLE");
        const pid = Number(await file.readFile("utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new ImportFailure("ADMIN_BUSY");
        try { process.kill(pid, 0); throw new ImportFailure("ADMIN_BUSY"); }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw new ImportFailure("ADMIN_BUSY"); }
      } finally { await file.close(); }
      await unlinkOwned(path, identity);
    }
  }
  throw new ImportFailure("ADMIN_BUSY");
}

/** Accept exactly the documented request shapes; anything else is invalid. */
function parseAdminRequest(raw: string): AdminRequest {
  const request: unknown = JSON.parse(raw);
  if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).some((key) => !["op", "payload"].includes(key))) {
    throw new ImportFailure("INVALID_REQUEST");
  }
  const { op, payload } = request as { op?: unknown; payload?: unknown };
  if (op === "providers.import") return { op, payload: parseProviderImportPayload(payload) };
  if (op === "pairing.issue") {
    if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) throw new ImportFailure("INVALID_REQUEST");
    const lifetimeMs = (payload as { lifetimeMs?: unknown } | undefined)?.lifetimeMs;
    if (lifetimeMs !== undefined && typeof lifetimeMs !== "number") throw new ImportFailure("INVALID_REQUEST");
    return { op, payload: lifetimeMs === undefined ? {} : { lifetimeMs } };
  }
  throw new ImportFailure("INVALID_REQUEST");
}

/** One owner-only Unix channel, one allowed operation, one active import. */
export async function startAdminSocket(options: {
  dataDir: string;
  getHost: () => HostCaller | null;
  /** Mint a gateway-origin pairing code for `pairing.issue`. */
  issuePairingToken?: (lifetimeMs: number) => Promise<{ token: string; expiresAt: string }>;
  log?: Log;
  timeoutMs?: number;
}): Promise<AdminSocket> {
  await prepareAdminDirectory(options.dataDir);
  const release = await claim(options.dataDir);
  const path = adminSocketPath(options.dataDir);
  const sockets = new Set<Socket>();
  const controllers = new Set<AbortController>();
  let active: Promise<AdminResponse> | undefined;
  let stopping = false;
  let ready = false;
  const timeoutMs = options.timeoutMs ?? IMPORT_DEADLINE_MS;
  // One in-flight provider import at a time; a pairing request is short and
  // never waits for it.
  const log = options.log ?? (() => undefined);
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (!ready || stopping || sockets.size >= 4) { socket.destroy(); return; }
    sockets.add(socket);
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => { controller.abort(); socket.destroy(); }, timeoutMs);
    socket.once("close", () => {
      clearTimeout(timer);
      controller.abort();
      controllers.delete(controller);
      sockets.delete(socket);
    });
    socket.on("error", () => undefined); // errors are represented by the bounded response/closed channel
    void readCapped(socket, ADMIN_MAX_BYTES, timeoutMs).then(async (raw): Promise<AdminResponse> => {
      if (controller.signal.aborted || stopping) throw new ImportFailure("TIMEOUT");
      let request: AdminRequest;
      try {
        request = parseAdminRequest(raw);
      } catch { throw new ImportFailure("INVALID_REQUEST"); }
      if (request.op === "pairing.issue") {
        if (!options.issuePairingToken) throw new ImportFailure("ADMIN_UNAVAILABLE");
        const lifetimeMs = request.payload.lifetimeMs ?? 10 * 60 * 1000;
        if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) throw new ImportFailure("INVALID_REQUEST");
        const pairing = await options.issuePairingToken(lifetimeMs);
        log("info", "pairing code issued");
        return { ok: true, pairing };
      }
      const payload = request.payload;
      if (active) throw new ImportFailure("ADMIN_BUSY");
      const host = options.getHost();
      if (!host) throw new ImportFailure("ADMIN_UNAVAILABLE");
      const guarded: HostCaller = {
        call: (method, params) => {
          if (controller.signal.aborted || stopping || options.getHost() !== host) throw new ImportFailure("ADMIN_UNAVAILABLE");
          return host.call(method, params, Math.min(timeoutMs, 10_000));
        },
      };
      active = importProviders(guarded, options.dataDir, payload, controller.signal)
        .then((summary): AdminResponse => ({ ok: true, summary }))
        .catch((error: unknown): AdminResponse => ({ ok: false, code: importFailureCode(error) }));
      try { return await active; } finally { active = undefined; }
    }).catch((error: unknown): AdminResponse => ({ ok: false, code: importFailureCode(error) }))
      .then((response) => {
        if (socket.destroyed) return;
        if (!response.ok) log("warn", "admin request failed", { code: response.code });
        else if ("summary" in response) log("info", "providers imported", { imported: response.summary.imported.length, skipped: response.summary.skipped.length });
        socket.end(`${JSON.stringify(response)}\n`);
        socket.destroySoon();
      });
  });
  try {
    try {
      await privateSocket(path);
      const identity = await lstat(path);
      if (await probe(path) === "live") throw new ImportFailure("ADMIN_BUSY");
      await unlinkOwned(path, identity);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (Buffer.byteLength(path) > (process.platform === "darwin" ? 103 : 107)) throw new ImportFailure("ADMIN_UNAVAILABLE");
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(path, () => { server.off("error", reject); resolveListen(); });
    });
    await chmod(path, 0o600);
    ready = true;
  } catch (error) {
    if (server.listening) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await release();
    throw new ImportFailure(error instanceof ImportFailure ? error.code : "ADMIN_UNAVAILABLE");
  }
  server.on("error", () => log("warn", "admin socket failed"));
  let closing: Promise<void> | undefined;
  return {
    path,
    close() {
      closing ??= (async () => {
        stopping = true;
        for (const controller of controllers) controller.abort();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        // Keep admission locked until any in-flight host RPC has settled.
        await active;
        await release();
      })();
      return closing;
    },
  };
}

/** CLI client: reject unsafe paths before writing even one secret-bearing byte. */
export async function sendAdminRequest(
  dataDir: string,
  input: ProviderImportPayload,
): Promise<{ ok: true; summary: ProviderImportSummary } | { ok: false; code: ImportFailureCode }> {
  const payload = parseProviderImportPayload(input);
  try {
    // Client checks only; it never creates a directory or starts a host.
    for (const dir of [dataDir, join(dataDir, "agent-host-cli")]) {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new ImportFailure("ADMIN_UNAVAILABLE");
    }
    const path = adminSocketPath(dataDir);
    await privateSocket(path);
    const socket = createConnection(path);
    socket.on("error", () => undefined); // the reader returns a sanitized failure
    const response = readCapped(socket, RESPONSE_MAX_BYTES, IMPORT_DEADLINE_MS + 5000);
    socket.once("connect", () => socket.end(JSON.stringify({ op: "providers.import", payload })));
    try {
      const raw: unknown = JSON.parse(await response);
      if (!raw || typeof raw !== "object" || !("ok" in raw)) throw new ImportFailure("ADMIN_UNAVAILABLE");
      if (raw.ok === true && "summary" in raw && Object.keys(raw).length === 2) return { ok: true, summary: parseProviderImportSummary(raw.summary) };
      if (raw.ok === false && "code" in raw && Object.keys(raw).length === 2 && FAILURE_CODES.some((code) => code === raw.code)) return { ok: false, code: raw.code as ImportFailureCode };
      throw new ImportFailure("ADMIN_UNAVAILABLE");
    } finally { socket.destroy(); }
  } catch (error) {
    throw new ImportFailure(error instanceof ImportFailure ? error.code : "ADMIN_UNAVAILABLE");
  }
}

/**
 * CLI client for `agent-host-cli remote-pair`: mint a gateway-origin pairing
 * code through the running instance. A gateway-origin code is redeemable only
 * over the Host link (security §3.7), so it can never be spent through SSH.
 */
export async function sendPairingRequest(
  dataDir: string,
  lifetimeMs: number,
): Promise<{ ok: true; pairing: { token: string; expiresAt: string } } | { ok: false; code: ImportFailureCode }> {
  const request: AdminRequest = { op: "pairing.issue", payload: { lifetimeMs } };
  try {
    for (const dir of [dataDir, join(dataDir, "agent-host-cli")]) {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new ImportFailure("ADMIN_UNAVAILABLE");
    }
    const path = adminSocketPath(dataDir);
    await privateSocket(path);
    const socket = createConnection(path);
    socket.on("error", () => undefined);
    const response = readCapped(socket, RESPONSE_MAX_BYTES, IMPORT_DEADLINE_MS + 5000);
    socket.once("connect", () => socket.end(JSON.stringify(request)));
    try {
      const raw: unknown = JSON.parse(await response);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ImportFailure("ADMIN_UNAVAILABLE");
      const parsed = raw as { ok?: unknown; pairing?: { token?: unknown; expiresAt?: unknown }; code?: unknown };
      if (parsed.ok === true && parsed.pairing && typeof parsed.pairing.token === "string" && typeof parsed.pairing.expiresAt === "string") {
        return { ok: true, pairing: { token: parsed.pairing.token, expiresAt: parsed.pairing.expiresAt } };
      }
      if (parsed.ok === false && FAILURE_CODES.some((code) => code === parsed.code)) return { ok: false, code: parsed.code as ImportFailureCode };
      throw new ImportFailure("ADMIN_UNAVAILABLE");
    } finally { socket.destroy(); }
  } catch (error) {
    throw new ImportFailure(error instanceof ImportFailure ? error.code : "ADMIN_UNAVAILABLE");
  }
}
