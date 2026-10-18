/**
 * Composition of one running Gateway: store, CA, enrollment, Host link
 * listener, logical-connection pool, client HTTP API, and the admin socket.
 * `serve` and the tests both enter through `startGateway`.
 */
import { readFile } from "node:fs/promises";

import { APP_VERSION } from "@minih-agent/shared";

import { AccountSessionService } from "./account.js";
import { startGatewayAdminSocket, type AdminResponse, type AdminSocket } from "./admin-socket.js";
import { loadOrCreateGatewayAuthority, type GatewayAuthority } from "./ca.js";
import { createClientIpResolver, peerAddress } from "./client-ip.js";
import { ClientHttpServer } from "./client-http.js";
import { isLoopbackBind, type GatewayServeConfig } from "./config.js";
import { DeviceRequestService } from "./device-requests.js";
import { EnrollmentService } from "./enrollment.js";
import { HostLinkServer } from "./hostlink-server.js";
import { PairingService } from "./pairing.js";
import { RateLimiter, type RateLimitPolicy } from "./rate-limit.js";
import { CommandRouter, GatewayRpcError, LogicalConnection, LogicalConnectionPool, type GatewayLog } from "./router.js";
import { RouterAccountVerifier } from "./router-verifier.js";
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
  /** Account directory (D666); `null` when `--router-url` is not configured. */
  account: AccountSessionService | null;
  /** Account-mode device relay (D666); always present, used by the account routes. */
  deviceRequests: DeviceRequestService;
  /** Router AccessKey verifier (D666); `null` when account mode is off. */
  verifier: RouterAccountVerifier | null;
  close: () => Promise<void>;
};

export type StartGatewayOptions = {
  log?: GatewayLogger;
  now?: () => number;
  deviceLimit?: RateLimitPolicy;
  ipLimit?: RateLimitPolicy;
  credentialLimit?: RateLimitPolicy;
  heartbeatMs?: number;
  /** Injectable for tests; only used to build the Router verifier. */
  fetchImpl?: typeof fetch;
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
  // Account mode is selected by configuration alone: without `--router-url`
  // there is no verifier, no account session service, and no account route
  // (protocol §11.5). The verifier is built once so its URL rules fail at
  // startup rather than on the first login.
  const verifier = config.router
    ? new RouterAccountVerifier({
        baseUrl: config.router.baseUrl,
        clientIpHeader: config.router.clientIpHeader,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      })
    : null;
  const rateLimiter = new RateLimiter({
    ...(options.deviceLimit ? { device: options.deviceLimit } : {}),
    ...(options.ipLimit ? { ip: options.ipLimit } : {}),
    ...(options.credentialLimit ? { credential: options.credentialLimit } : {}),
    ...(now ? { now } : {}),
  });
  const enrollment = new EnrollmentService(
    store,
    loadAuthority,
    now,
    verifier ? { verifier: () => verifier, rateLimiter } : null,
  );
  const hostLinks = new HostLinkServer({
    store,
    authority: loadAuthority,
    enrollment,
    log,
    ...(now ? { now } : {}),
    ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
  });
  // The device relay is wired before the listener starts, so a Host that
  // connects immediately still receives the grants pending for its account
  // (§11.5 "Deferred grants").
  const deviceRequests = new DeviceRequestService({ store, hostLinks, authority: loadAuthority, log, ...(now ? { now } : {}) });
  hostLinks.onCapabilities((hostId) => {
    void deviceRequests.deliverPending(hostId).catch((error: unknown) => {
      log("warn", "gateway could not deliver pending device frames", { hostId, error: String(error) });
    });
  });
  hostLinks.onDeviceGrant((frame, hostId) => {
    void deviceRequests.handleGrant(frame, hostId).catch((error: unknown) => {
      log("warn", "gateway failed to relay a device grant", { hostId, error: String(error) });
    });
  });
  hostLinks.onDeviceRevoke((frame, hostId) => {
    void deviceRequests.handleRevoke(frame, hostId).catch((error: unknown) => {
      log("warn", "gateway failed to relay a device revocation", { hostId, error: String(error) });
    });
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
  const account = verifier
    ? new AccountSessionService({ store, verifier: () => verifier, rateLimiter, ...(now ? { now } : {}) })
    : null;
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
    ...(account ? { account } : {}),
    ...(account ? { deviceRequests } : {}),
    // Without `--trusted-proxy`/`--client-ip-header` the resolved address is the
    // TCP peer, exactly as before (ADR decision 10).
    resolveClientIp: config.clientIp ? createClientIpResolver(config.clientIp) : peerAddress,
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
        case "account-sessions.revoke": {
          // An account session authorizes no relayed Host operation, so revoking
          // one closes nothing; it only stops the account host list.
          const session = store.findAccountSession(request.payload.sessionId);
          const revoked = await store.revokeAccountSession(request.payload.sessionId, new Date(now ? now() : Date.now()).toISOString());
          if (!revoked) return { ok: false, code: "NOT_FOUND" };
          await store.appendAudit({
            op: "account-sessions.revoke",
            ip: "admin",
            result: "ok",
            ...(session?.accountId ? { accountId: session.accountId } : {}),
          });
          log("info", "gateway revoked an account session", { sessionId: request.payload.sessionId });
          return { ok: true, revoked: true };
        }
      }
    },
  });

  if (account && !config.clientIp && isLoopbackBind(config.client.host)) {
    // The README's deployment puts the client API on loopback behind a
    // TLS-terminating proxy. Without the trusted-proxy pair every caller then
    // resolves to the proxy address, so one caller can empty the shared
    // credential bucket and a key whose `allowed_peer_cidrs` is set can never
    // verify. A Gateway serving TLS directly on a non-loopback address
    // legitimately needs no proxy, so this is a warning, not a refusal.
    log("warn", "account mode is on without a trusted proxy", {
      clientListen: `${config.client.host}:${config.client.port}`,
      effect: "every caller resolves to the proxy address; per-IP credential limits and the key's allowed_peer_cidrs cannot tell callers apart",
      fix: "add --trusted-proxy <proxy cidr> and --client-ip-header <the header the proxy sets>",
    });
  }

  log("info", "remote gateway ready", {
    hostlink: `${hostlink.host}:${hostlink.port}`,
    client: `${clientAddress.host}:${clientAddress.port}`,
    origins: config.allowedOrigins.length,
    accountMode: Boolean(account),
    trustedProxy: Boolean(config.clientIp),
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
    account,
    deviceRequests,
    verifier,
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
