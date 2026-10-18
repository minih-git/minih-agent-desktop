/**
 * Composition of one running Gateway: store, CA, enrollment, Host link
 * listener, logical-connection pool, client HTTP API, and the admin socket.
 * `serve` and the tests both enter through `startGateway`.
 */
import { readFile } from "node:fs/promises";

import { APP_VERSION } from "@minih-agent/shared";

import { startGatewayAdminSocket, type AdminResponse, type AdminSocket } from "./admin-socket.js";
import { loadOrCreateGatewayAuthority, type GatewayAuthority } from "./ca.js";
import { ClientHttpServer } from "./client-http.js";
import type { GatewayServeConfig } from "./config.js";
import { EnrollmentService } from "./enrollment.js";
import { HostLinkServer } from "./hostlink-server.js";
import { PairingService } from "./pairing.js";
import { RateLimiter, type RateLimitPolicy } from "./rate-limit.js";
import { CommandRouter, GatewayRpcError, LogicalConnection, LogicalConnectionPool, type GatewayLog } from "./router.js";
import { GatewayStore } from "./store.js";

export type GatewayLogger = GatewayLog;

export const createJsonLogger = (stream: NodeJS.WritableStream = process.stderr): GatewayLogger => (level, message, data) => {
  stream.write(`${JSON.stringify({ ts: new Date().toISOString(), level, channel: "remote-gateway", message, ...(data ? { data } : {}) })}\n`);
};

export type GatewayServer = {
  version: string;
  hostlink: { host: string; port: number };
  client: { host: string; port: number };
  /** Path of the CA certificate a Host pins with `--gateway-ca`. */
  caCertificatePath: string;
  store: GatewayStore;
  pool: LogicalConnectionPool;
  hostLinks: HostLinkServer;
  enrollment: EnrollmentService;
  authority: GatewayAuthority;
  close: () => Promise<void>;
};

export type StartGatewayOptions = {
  log?: GatewayLogger;
  now?: () => number;
  deviceLimit?: RateLimitPolicy;
  ipLimit?: RateLimitPolicy;
  heartbeatMs?: number;
};

/** Load the client API TLS material once, so a bad path fails before binding. */
async function loadClientTls(config: GatewayServeConfig): Promise<{ certificatePem: string; privateKeyPem: string } | undefined> {
  if (!config.clientTls) return undefined;
  const [certificatePem, privateKeyPem] = await Promise.all([
    readFile(config.clientTls.certificatePath, "utf8"),
    readFile(config.clientTls.keyPath, "utf8"),
  ]);
  return { certificatePem, privateKeyPem };
}

export async function startGateway(config: GatewayServeConfig, options: StartGatewayOptions = {}): Promise<GatewayServer> {
  const log = options.log ?? createJsonLogger();
  const now = options.now;
  const store = await GatewayStore.open(config.dataDir, now);
  let authority: GatewayAuthority | null = null;
  const loadAuthority = async (): Promise<GatewayAuthority> => {
    authority ??= await loadOrCreateGatewayAuthority(store, {
      hostlinkHost: config.hostlink.host,
      ...(config.publicName ? { publicName: config.publicName } : {}),
    });
    return authority;
  };
  const resolved = await loadAuthority();
  const enrollment = new EnrollmentService(store, loadAuthority, now);
  const hostLinks = new HostLinkServer({
    store,
    authority: loadAuthority,
    enrollment,
    log,
    ...(now ? { now } : {}),
    ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
  });
  const hostlink = await hostLinks.start(config.hostlink);
  const pool = new LogicalConnectionPool({ links: hostLinks, log, ...(now ? { now } : {}) });
  const commands = new CommandRouter(pool, log);
  const pairing = new PairingService({
    store,
    log,
    connect: (identity) => {
      const mux = hostLinks.muxFor(identity.hostId);
      if (!mux) throw new GatewayRpcError("AGENT_UNAVAILABLE", "the Host is offline", true);
      return new LogicalConnection({ identity, mux, log, ...(now ? { now } : {}) });
    },
  });
  const rateLimiter = new RateLimiter({
    ...(options.deviceLimit ? { device: options.deviceLimit } : {}),
    ...(options.ipLimit ? { ip: options.ipLimit } : {}),
    ...(now ? { now } : {}),
  });
  const client = new ClientHttpServer({
    store,
    pool,
    router: commands,
    pairing,
    rateLimiter,
    allowedOrigins: config.allowedOrigins,
    log,
    version: APP_VERSION,
    isHostOnline: (hostId) => hostLinks.isOnline(hostId),
  });
  const clientTls = await loadClientTls(config);
  const clientAddress = await client.start(config.client, config.clientTls, clientTls);

  const admin: AdminSocket = await startGatewayAdminSocket({
    dataDir: config.dataDir,
    handle: async (request): Promise<AdminResponse> => {
      switch (request.op) {
        case "enroll-code.issue": {
          const code = await enrollment.issueCode(request.payload.label ? { label: request.payload.label } : {});
          return { ok: true, enrollment: code };
        }
        case "hosts.revoke": {
          const revoked = await store.revokeHost(request.payload.hostId, new Date(now ? now() : Date.now()).toISOString());
          if (!revoked) return { ok: false, code: "NOT_FOUND" };
          const disconnected = hostLinks.disconnect(request.payload.hostId);
          await store.appendAudit({ op: "hosts.revoke", hostId: request.payload.hostId, ip: "admin", result: "ok" });
          log("info", "gateway revoked a Host", { hostId: request.payload.hostId, disconnected });
          return { ok: true, revoked: true };
        }
        case "devices.revoke": {
          const revoked = await store.revokeDevice(request.payload.deviceId, new Date(now ? now() : Date.now()).toISOString());
          if (!revoked) return { ok: false, code: "NOT_FOUND" };
          const closedConnections = pool.closeForDevice(request.payload.deviceId);
          await store.appendAudit({ op: "devices.revoke", deviceId: request.payload.deviceId, ip: "admin", result: "ok" });
          log("info", "gateway revoked a device", { deviceId: request.payload.deviceId, closedConnections });
          return { ok: true, revoked: true, closedConnections };
        }
      }
    },
  });

  log("info", "remote gateway ready", {
    hostlink: `${hostlink.host}:${hostlink.port}`,
    client: `${clientAddress.host}:${clientAddress.port}`,
    origins: config.allowedOrigins.length,
  });

  let closing: Promise<void> | null = null;
  return {
    version: APP_VERSION,
    hostlink,
    client: clientAddress,
    caCertificatePath: store.caCertificatePath,
    store,
    pool,
    hostLinks,
    enrollment,
    authority: resolved,
    close: () => {
      closing ??= (async () => {
        await admin.close();
        pool.closeAll();
        await client.stop();
        await hostLinks.stop();
        // Audit records are written asynchronously; do not drop the tail.
        await store.flush();
        log("info", "remote gateway stopped");
      })();
      return closing;
    },
  };
}
