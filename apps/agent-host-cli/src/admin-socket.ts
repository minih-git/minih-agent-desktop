import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join, relative } from "node:path";
import {
  PROVIDER_SYNC_MAX_BYTES, parseProviderImportPayload, parseProviderImportSummary,
  type ProviderImportPayload, type ProviderImportSummary,
} from "@minih-agent/shared";
import type { PendingDeviceRequest } from "./device-confirmer.js";
import {
  IMPORT_DEADLINE_MS, ImportFailure, importFailureCode, importProviders, readCapped,
  type HostCaller, type ImportFailureCode,
} from "./provider-import.js";

export const ADMIN_MAX_BYTES = PROVIDER_SYNC_MAX_BYTES + 128;
const RESPONSE_MAX_BYTES = 64 * 1024;
const FAILURE_CODES: readonly ImportFailureCode[] = ["INVALID_REQUEST", "PAYLOAD_TOO_LARGE", "ADMIN_UNAVAILABLE", "ADMIN_BUSY", "TIMEOUT", "IMPORT_FAILED"];
/**
 * Five operations share the owner-only, bounded admin channel:
 * `providers.import` (the SSH bootstrap import), `pairing.issue` (a
 * gateway-origin pairing code minted by a running instance, PR-2), and the
 * account-mode device confirmations of §11.5 (`devices.pending`,
 * `devices.decide`, `devices.revoke`). The device operations carry no
 * credential and no token: they list questions and answer yes or no.
 */
export type AdminDeviceDecision = "approve" | "deny";

export type AdminResponse =
  | { ok: true; summary: ProviderImportSummary }
  | { ok: true; pairing: { token: string; expiresAt: string } }
  | { ok: true; devices: PendingDeviceRequest[] }
  | { ok: true; decided: { requestId: string; decision: AdminDeviceDecision } }
  | { ok: true; revoked: { deviceId: string; announced: boolean } }
  | { ok: false; code: ImportFailureCode };

/** Whether a response carries a provider import summary. */
export function isImportResponse(response: AdminResponse): response is { ok: true; summary: ProviderImportSummary } | { ok: false; code: ImportFailureCode } {
  return "summary" in response || !response.ok;
}

export type AdminRequest =
  | { op: "providers.import"; payload: ProviderImportPayload }
  | { op: "pairing.issue"; payload: { lifetimeMs?: number } }
  | { op: "devices.pending"; payload: Record<string, never> }
  | { op: "devices.decide"; payload: { requestId: string; decision: AdminDeviceDecision } }
  | { op: "devices.revoke"; payload: { deviceId: string } };
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
  if (op === "devices.pending") {
    // A listing carries nothing; an empty object is accepted so a caller can
    // always send the same two-key envelope.
    const empty = payload === undefined || (typeof payload === "object" && payload !== null && !Array.isArray(payload) && Object.keys(payload).length === 0);
    if (!empty) throw new ImportFailure("INVALID_REQUEST");
    return { op, payload: {} };
  }
  if (op === "devices.decide") {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new ImportFailure("INVALID_REQUEST");
    const { requestId, decision } = payload as { requestId?: unknown; decision?: unknown };
    if (typeof requestId !== "string" || requestId.length === 0) throw new ImportFailure("INVALID_REQUEST");
    if (decision !== "approve" && decision !== "deny") throw new ImportFailure("INVALID_REQUEST");
    return { op, payload: { requestId, decision } };
  }
  if (op === "devices.revoke") {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new ImportFailure("INVALID_REQUEST");
    const { deviceId } = payload as { deviceId?: unknown };
    if (typeof deviceId !== "string" || deviceId.length === 0) throw new ImportFailure("INVALID_REQUEST");
    return { op, payload: { deviceId } };
  }
  if (op === "pairing.issue") {
    if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) throw new ImportFailure("INVALID_REQUEST");
    const lifetimeMs = (payload as { lifetimeMs?: unknown } | undefined)?.lifetimeMs;
    if (lifetimeMs !== undefined && typeof lifetimeMs !== "number") throw new ImportFailure("INVALID_REQUEST");
    return { op, payload: lifetimeMs === undefined ? {} : { lifetimeMs } };
  }
  throw new ImportFailure("INVALID_REQUEST");
}

/**
 * The account-mode device surface the socket exposes (§11.5). Absent when this
 * Host has no device directory — `--gateway` off, no account binding in the
 * certificate, Windows, or `--confirm-devices` off — and then every
 * `devices.*` operation answers `ADMIN_UNAVAILABLE`.
 */
export type AdminDevicePort = {
  pending(): PendingDeviceRequest[];
  decide(requestId: string, decision: AdminDeviceDecision): boolean;
  /**
   * Revoke one device. `revoked` says the local record is revoked; `announced`
   * says the signed frame went out on a live link in this call. A frame that
   * could not go out is queued for the next link, and the caller is told so
   * instead of being told it was announced.
   */
  revoke(deviceId: string): Promise<{ revoked: boolean; announced: boolean }>;
};

/** One owner-only Unix channel, one allowed operation, one active import. */
export async function startAdminSocket(options: {
  dataDir: string;
  getHost: () => HostCaller | null;
  /** Mint a gateway-origin pairing code for `pairing.issue`. */
  issuePairingToken?: (lifetimeMs: number) => Promise<{ token: string; expiresAt: string }>;
  /** The device confirmation surface, when this Host has one. */
  devices?: AdminDevicePort;
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
      if (request.op === "devices.pending") {
        const devices = options.devices;
        if (!devices) throw new ImportFailure("ADMIN_UNAVAILABLE");
        // A listing is a read: it never waits for an import and holds no slot.
        return { ok: true, devices: devices.pending() };
      }
      if (request.op === "devices.decide") {
        const devices = options.devices;
        if (!devices) throw new ImportFailure("ADMIN_UNAVAILABLE");
        const { requestId, decision } = request.payload;
        if (!devices.decide(requestId, decision)) throw new ImportFailure("INVALID_REQUEST");
        log("info", "device request answered", { requestId, decision });
        return { ok: true, decided: { requestId, decision } };
      }
      if (request.op === "devices.revoke") {
        const devices = options.devices;
        if (!devices) throw new ImportFailure("ADMIN_UNAVAILABLE");
        const { deviceId } = request.payload;
        const outcome = await devices.revoke(deviceId);
        if (!outcome.revoked) throw new ImportFailure("INVALID_REQUEST");
        log("info", "device revoked through the admin socket", { deviceId, announced: outcome.announced });
        return { ok: true, revoked: { deviceId, announced: outcome.announced } };
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

/** One short admin round trip for the device operations (§11.5). */
async function sendDeviceRequest(dataDir: string, request: AdminRequest): Promise<AdminResponse> {
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
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("ok" in raw)) throw new ImportFailure("ADMIN_UNAVAILABLE");
      return raw as AdminResponse;
    } finally {
      socket.destroy();
    }
  } catch (error) {
    throw new ImportFailure(error instanceof ImportFailure ? error.code : "ADMIN_UNAVAILABLE");
  }
}

/** `agent-host-cli devices pending`: the requests waiting for this Host's user. */
export async function sendDevicesPending(
  dataDir: string,
): Promise<{ ok: true; devices: PendingDeviceRequest[] } | { ok: false; code: ImportFailureCode }> {
  const response = await sendDeviceRequest(dataDir, { op: "devices.pending", payload: {} });
  if (response.ok && "devices" in response) return { ok: true, devices: response.devices };
  return { ok: false, code: response.ok ? "ADMIN_UNAVAILABLE" : response.code };
}

/** `agent-host-cli devices approve|deny <requestId>`. */
export async function sendDeviceDecision(
  dataDir: string,
  requestId: string,
  decision: AdminDeviceDecision,
): Promise<{ ok: true; decided: { requestId: string; decision: AdminDeviceDecision } } | { ok: false; code: ImportFailureCode }> {
  const response = await sendDeviceRequest(dataDir, { op: "devices.decide", payload: { requestId, decision } });
  if (response.ok && "decided" in response) return { ok: true, decided: response.decided };
  return { ok: false, code: response.ok ? "ADMIN_UNAVAILABLE" : response.code };
}

/** `agent-host-cli devices revoke <deviceId>`: revoke here and on the account's Hosts. */
export async function sendDeviceRevoke(
  dataDir: string,
  deviceId: string,
): Promise<{ ok: true; revoked: { deviceId: string; announced: boolean } } | { ok: false; code: ImportFailureCode }> {
  const response = await sendDeviceRequest(dataDir, { op: "devices.revoke", payload: { deviceId } });
  if (response.ok && "revoked" in response) return { ok: true, revoked: response.revoked };
  return { ok: false, code: response.ok ? "ADMIN_UNAVAILABLE" : response.code };
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
