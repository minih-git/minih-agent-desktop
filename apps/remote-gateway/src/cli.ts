#!/usr/bin/env node
/**
 * `remote-gateway` CLI.
 *
 *   remote-gateway serve --data-dir <dir> --hostlink-listen <ip:port> ...
 *   remote-gateway enroll-code --label <name>
 *   remote-gateway hosts list | hosts revoke <hostId>
 *   remote-gateway devices list | devices revoke <deviceId>
 *   remote-gateway account-sessions list | account-sessions revoke <sessionId>
 *
 * `serve` prints one `GATEWAY_READY` line on stdout with the bound addresses
 * and the CA certificate path; everything else prints a single JSON line per
 * command so a wrapper can parse it. Mutating subcommands reach the running
 * `serve` through the admin socket and fail with "gateway is not running"
 * instead of editing files behind its back.
 */
import { pathToFileURL } from "node:url";

import { GatewayNotRunning, sendAdminRequest } from "./admin-socket.js";
import { GatewayConfigError, parseArgv, resolveServeConfig } from "./config.js";
import { createJsonLogger, startGateway } from "./serve.js";
import { GatewayStore } from "./store.js";

const USAGE = [
  "remote-gateway — self-hosted RACP Gateway (Host link + RACP-HTTP/SSE)",
  "",
  "  serve                     run the Gateway",
  "    --data-dir <dir>            state directory (default ~/.minih-remote-gateway)",
  "    --hostlink-listen <ip:port> Host link listener; private or overlay address only",
  "    --hostlink-allow-cidr <cidr> extra CIDR a Host link may bind (repeatable)",
  "    --client-listen <ip:port>   client API listener (default 127.0.0.1:8788)",
  "    --client-tls-cert <pem>     client API certificate (required off loopback)",
  "    --client-tls-key <pem>      client API private key",
  "    --allowed-origin <origin>   browser origin allowed for cookie requests (repeatable)",
  "    --public-name <dns>         extra DNS SAN on the Host link certificate",
  "    --trusted-proxy <cidr>      reverse proxy whose client-IP header is honored (repeatable)",
  "    --client-ip-header <name>   header a trusted proxy reports the caller address in",
  "    --router-url <url>          loopback Minih-Router base URL; turns account mode on",
  "    --router-client-ip-header <name>",
  "                                header equal to the Router's CLIENT_IP_HEADER",
  "",
  "  enroll-code [--label <name>]  print a one-time enrollment code (15 minutes)",
  "  hosts list                    list registered Hosts",
  "  hosts revoke <hostId>         revoke a Host and drop its link",
  "  devices list                  list paired devices",
  "  devices revoke <deviceId>     revoke a device and close its connections",
  "  account-sessions list         list live account sessions (account mode)",
  "  account-sessions revoke <sessionId>",
  "                                revoke an account session",
  "",
].join("\n");

function dataDirOf(args: ReturnType<typeof parseArgv>): string {
  const value = args["data-dir"];
  return typeof value === "string" ? value : String(process.env.MINIH_GATEWAY_DATA_DIR ?? `${process.env.HOME ?? "."}/.minih-remote-gateway`);
}

function positional(args: ReturnType<typeof parseArgv>): string | undefined {
  const rest = args["_"];
  return Array.isArray(rest) ? rest[0] : undefined;
}

async function serve(argv: readonly string[]): Promise<number> {
  const args = parseArgv(argv, ["hostlink-allow-cidr", "allowed-origin", "trusted-proxy"]);
  const config = resolveServeConfig(args);
  const gateway = await startGateway(config, { log: createJsonLogger() });
  process.stdout.write(
    `GATEWAY_READY ${JSON.stringify({
      version: gateway.version,
      hostlink: { host: gateway.hostlink.host, port: gateway.hostlink.port },
      client: { host: gateway.client.host, port: gateway.client.port },
      caCertificatePath: gateway.caCertificatePath,
      dataDir: config.dataDir,
    })}\n`,
  );
  const stop = (signal: string) => {
    createJsonLogger()("info", "signal received", { signal });
    void gateway.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    createJsonLogger()("error", "unhandled rejection", { error: reason instanceof Error ? reason.message : String(reason) });
  });
  // Keep the process alive until a signal closes the Gateway.
  await new Promise<void>(() => undefined);
  return 0;
}

async function enrollCode(argv: readonly string[]): Promise<number> {
  const args = parseArgv(argv);
  const response = await sendAdminRequest(dataDirOf(args), {
    op: "enroll-code.issue",
    payload: typeof args["label"] === "string" ? { label: args["label"] } : {},
  });
  if (!response.ok || !response.enrollment) {
    process.stderr.write(`remote-gateway: ${response.ok ? "the gateway returned no enrollment code" : response.code}\n`);
    return 1;
  }
  process.stdout.write(`ENROLLMENT_CODE ${JSON.stringify(response.enrollment)}\n`);
  return 0;
}

async function listHosts(argv: readonly string[]): Promise<number> {
  const args = parseArgv(argv);
  const store = await GatewayStore.open(dataDirOf(args));
  // The certificate itself stays on disk; the list carries identity metadata.
  const hosts = store.listHosts().map((host) => ({
    hostId: host.hostId,
    label: host.label,
    fingerprint: host.certificateFingerprint256,
    registeredAt: host.registeredAt,
    lastSeenAt: host.lastSeenAt,
    revokedAt: host.revokedAt,
    ...(host.accountId ? { accountId: host.accountId } : {}),
  }));
  process.stdout.write(`GATEWAY_HOSTS ${JSON.stringify({ hosts })}\n`);
  return 0;
}

async function revokeHost(argv: readonly string[]): Promise<number> {
  const args = parseArgv(argv);
  const hostId = (typeof args["host-id"] === "string" ? args["host-id"] : positional(args)) ?? "";
  if (!hostId) {
    process.stderr.write("remote-gateway: hosts revoke needs a host id\n");
    return 1;
  }
  const response = await sendAdminRequest(dataDirOf(args), { op: "hosts.revoke", payload: { hostId } });
  if (!response.ok) {
    process.stderr.write(`remote-gateway: ${response.code}\n`);
    return 1;
  }
  process.stdout.write(`GATEWAY_REVOKED ${JSON.stringify({ hostId, revoked: true })}\n`);
  return 0;
}

async function listDevices(argv: readonly string[]): Promise<number> {
  const args = parseArgv(argv);
  const store = await GatewayStore.open(dataDirOf(args));
  process.stdout.write(`GATEWAY_DEVICES ${JSON.stringify({ devices: store.listDevices() })}\n`);
  return 0;
}

async function revokeDevice(argv: readonly string[]): Promise<number> {
  const args = parseArgv(argv);
  const deviceId = (typeof args["device-id"] === "string" ? args["device-id"] : positional(args)) ?? "";
  if (!deviceId) {
    process.stderr.write("remote-gateway: devices revoke needs a device id\n");
    return 1;
  }
  const response = await sendAdminRequest(dataDirOf(args), { op: "devices.revoke", payload: { deviceId } });
  if (!response.ok) {
    process.stderr.write(`remote-gateway: ${response.code}\n`);
    return 1;
  }
  process.stdout.write(`GATEWAY_REVOKED ${JSON.stringify({ deviceId, revoked: true, closedConnections: response.closedConnections ?? 0 })}\n`);
  return 0;
}

/** Account sessions are listed without their token hash: a hash is not a credential, but nothing needs it. */
async function listAccountSessions(argv: readonly string[]): Promise<number> {
  const args = parseArgv(argv);
  const store = await GatewayStore.open(dataDirOf(args));
  const sessions = store.listAccountSessions().map((session) => ({
    sessionId: session.sessionId,
    accountId: session.accountId,
    label: session.label,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
  }));
  process.stdout.write(`GATEWAY_ACCOUNT_SESSIONS ${JSON.stringify({ sessions })}\n`);
  return 0;
}

async function revokeAccountSession(argv: readonly string[]): Promise<number> {
  const args = parseArgv(argv);
  const sessionId = (typeof args["session-id"] === "string" ? args["session-id"] : positional(args)) ?? "";
  if (!sessionId) {
    process.stderr.write("remote-gateway: account-sessions revoke needs a session id\n");
    return 1;
  }
  const response = await sendAdminRequest(dataDirOf(args), { op: "account-sessions.revoke", payload: { sessionId } });
  if (!response.ok) {
    process.stderr.write(`remote-gateway: ${response.code}\n`);
    return 1;
  }
  process.stdout.write(`GATEWAY_REVOKED ${JSON.stringify({ sessionId, revoked: true })}\n`);
  return 0;
}

export async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === "serve") return serve(rest);
  if (command === "enroll-code") return enrollCode(rest);
  if (command === "hosts") {
    const [action] = rest;
    if (action === "list") return listHosts(rest.slice(1));
    if (action === "revoke") return revokeHost(rest.slice(1));
    process.stderr.write("remote-gateway: hosts expects list or revoke\n");
    return 1;
  }
  if (command === "devices") {
    const [action] = rest;
    if (action === "list") return listDevices(rest.slice(1));
    if (action === "revoke") return revokeDevice(rest.slice(1));
    process.stderr.write("remote-gateway: devices expects list or revoke\n");
    return 1;
  }
  if (command === "account-sessions") {
    const [action] = rest;
    if (action === "list") return listAccountSessions(rest.slice(1));
    if (action === "revoke") return revokeAccountSession(rest.slice(1));
    process.stderr.write("remote-gateway: account-sessions expects list or revoke\n");
    return 1;
  }
  process.stderr.write(`remote-gateway: unknown command ${command}\n${USAGE}`);
  return 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const notRunning = error instanceof GatewayNotRunning;
      const message = notRunning
        ? "gateway is not running"
        : error instanceof GatewayConfigError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      process.stderr.write(`remote-gateway: ${message}\n`);
      process.stdout.write(`GATEWAY_FAILED ${JSON.stringify({ code: notRunning ? "GATEWAY_NOT_RUNNING" : (error as { code?: string })?.code ?? "INTERNAL" })}\n`);
      process.exitCode = 1;
    },
  );
}
