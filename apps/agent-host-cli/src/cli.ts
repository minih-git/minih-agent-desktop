#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { parseArgs, resolveConfig } from "./config.js";
import { loadOrCreateHostId } from "./credentials.js";
import { writeGatewayLink } from "./gateway-link.js";
import { gatewayPairingTokenLine, pairingTokenLine } from "./pairing-line.js";

/**
 * `agent-host-cli [--data-dir <dir>] [--port <n>] [--pair] [--host-core <bin>] [--sidecar <entry>]`
 *
 * stdout carries exactly the lines a bootstrap script parses:
 *   AGENT_HOST_CLI_READY {"hostId":..,"port":..,"version":..}
 *   AGENT_HOST_CLI_PAIRING_TOKEN {"token":..,"expiresAt":..}             (--pair)
 *   AGENT_HOST_CLI_PAIRING_TOKEN {"token":..,"expiresAt":..,"ticket":..}  (remote-pair)
 * Everything else is structured stderr.
 *
 * Only `remote-pair` carries the ticket that names the Host the pairing call
 * must target (`mpt1:<hostId>:<pairingToken>`): a gateway-origin code is
 * redeemed through the Gateway, the browser client pairs against
 * `/v1/hosts/{hostId}/pair`, and a Host-scoped cookie path never exposes
 * `GET /v1/hosts`, so the Host id has to travel with the token. The `--pair`
 * token is ssh-origin and redeemable only on the loopback `RACP-WS` binding,
 * so a ticket built from it could never pair through the Gateway. Two helpers
 * build the lines so the two shapes cannot drift.
 */
async function main(): Promise<void> {
  if (process.argv[2] === "provider-import") {
    const { runProviderImport } = await import("./provider-import.js");
    process.exitCode = await runProviderImport(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "enroll") {
    process.exitCode = await runEnroll(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "remote-pair") {
    process.exitCode = await runRemotePair(process.argv.slice(3));
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    process.stdout.write(
      [
        "agent-host-cli — headless PI Agent Host (RACP-WS on loopback, optional Host link)",
        "  provider-import          import selected providers from SSH stdin",
        "  enroll                   enroll this Host with a remote gateway (writes gateway-link.json)",
        "  remote-pair              mint a gateway-origin pairing code on the running instance",
        "",
        "  --data-dir <dir>          host data directory (default ~/.minih-agent-desktop)",
        "  --port <n>                loopback port (default 0 = pick free)",
        "  --host <addr>             bind address; loopback only",
        "  --pair                    print a single-use pairing token at start",
        "  --gateway                 keep the outbound Host link open (needs `enroll` first)",
        "  --pairing-lifetime-ms <n> pairing token lifetime (default 600000)",
        "  --host-core <path>        minih-agent-desktop-host-core binary",
        "  --sidecar <path>          agent sidecar entry",
        "  --browse-root <dir>       folder-picker root (default home)",
        "  --log-level <level>       info | warn | error",
        "",
      ].join("\n"),
    );
    return;
  }
  const config = resolveConfig(args);
  const { startAgentHostCli } = await import("./app.js");
  const app = await startAgentHostCli(config);
  process.stdout.write(`AGENT_HOST_CLI_READY ${JSON.stringify({ hostId: app.hostId, host: app.address.host, port: app.address.port, version: (await import("@minih-agent/shared")).APP_VERSION })}\n`);
  if (config.pair) {
    const pairing = await app.issuePairingToken(config.pairingLifetimeMs);
    process.stdout.write(pairingTokenLine(pairing));
  }
  const stop = (signal: string) => {
    app.log("info", "signal received", { signal });
    void app.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    app.log("error", "unhandled rejection", { error: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
  });
  process.on("uncaughtException", (error) => {
    app.log("error", "uncaught exception", { error: error.stack ?? error.message });
  });
}

/**
 * `agent-host-cli enroll --gateway <wss-url> --gateway-ca <pem> --code <code> [--label]`:
 * generate the key pair locally, exchange the one-time code for a certificate,
 * and store the credentials with mode 0600. The private key never leaves the Host.
 */
export async function runEnroll(argv: string[]): Promise<number> {
  // `@minih-agent/racp` pulls in pkijs for the CSR; load it only when enrolling
  // so a plain `agent-host-cli` start stays lean.
  const { enrollHostLink } = await import("@minih-agent/racp");
  const args = parseArgs(argv);
  const gatewayUrl = typeof args.gateway === "string" ? args.gateway : "";
  const gatewayCaPath = typeof args["gateway-ca"] === "string" ? args["gateway-ca"] : "";
  const code = typeof args.code === "string" ? args.code : "";
  if (!gatewayUrl || !gatewayCaPath || !code) {
    process.stderr.write("agent-host-cli enroll needs --gateway <wss-url> --gateway-ca <pem> --code <code>\n");
    return 2;
  }
  const config = resolveConfig(args);
  const hostId = await loadOrCreateHostId(config.dataDir);
  const gatewayCaPem = await readFile(gatewayCaPath, "utf8");
  const label = typeof args.label === "string" ? args.label : undefined;
  const credentials = await enrollHostLink({ gatewayUrl, gatewayCaPem, enrollmentCode: code, hostId, ...(label ? { label } : {}) });
  const path = await writeGatewayLink(config.dataDir, credentials);
  process.stdout.write(
    `AGENT_HOST_CLI_ENROLLED ${JSON.stringify({ hostId, gatewayUrl, expiresAt: credentials.expiresAt, path })}\n`,
  );
  return 0;
}

/** `agent-host-cli remote-pair [--lifetime-ms]`: mint a pairing code on the running instance. */
export async function runRemotePair(argv: string[]): Promise<number> {
  const { sendPairingRequest } = await import("./admin-socket.js");
  const args = parseArgs(argv);
  const config = resolveConfig(args);
  const lifetimeMs = Number(args["lifetime-ms"] ?? 10 * 60 * 1000);
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) {
    process.stderr.write("agent-host-cli remote-pair needs a positive --lifetime-ms\n");
    return 2;
  }
  const response = await sendPairingRequest(config.dataDir, lifetimeMs);
  if (!response.ok) {
    process.stderr.write(`agent-host-cli: pairing code unavailable (${response.code})\n`);
    return 1;
  }
  // The running instance owns the identity file this reads; the ticket carries
  // the Host id that the pairing request path needs.
  const hostId = await loadOrCreateHostId(config.dataDir);
  process.stdout.write(gatewayPairingTokenLine(hostId, response.pairing));
  return 0;
}

main().catch((error) => {
  const code = (error as { errorCode?: string })?.errorCode ?? "INTERNAL";
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", channel: "agent-host-cli", message: "agent-host-cli failed to start", data: { code, error: error instanceof Error ? error.message : String(error) } })}\n`);
  process.stdout.write(`AGENT_HOST_CLI_FAILED ${JSON.stringify({ code })}\n`);
  process.exit(1);
});
