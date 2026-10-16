#!/usr/bin/env node
import { parseArgs, resolveConfig } from "./config.js";

/**
 * `agent-host-cli [--data-dir <dir>] [--port <n>] [--pair] [--host-core <bin>] [--sidecar <entry>]`
 *
 * stdout carries exactly the lines a bootstrap script parses:
 *   AGENT_HOST_CLI_READY {"hostId":..,"port":..,"version":..}
 *   AGENT_HOST_CLI_PAIRING_TOKEN {"token":..,"expiresAt":..}   (with --pair)
 * Everything else is structured stderr.
 */
async function main(): Promise<void> {
  if (process.argv[2] === "provider-import") {
    const { runProviderImport } = await import("./provider-import.js");
    process.exitCode = await runProviderImport(process.argv.slice(3));
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    process.stdout.write(
      [
        "agent-host-cli — headless PI Agent Host (RACP-WS on loopback)",
        "  provider-import          import selected providers from SSH stdin",
        "",
        "  --data-dir <dir>          host data directory (default ~/.minih-agent-desktop)",
        "  --port <n>                loopback port (default 0 = pick free)",
        "  --host <addr>             bind address; loopback only",
        "  --pair                    print a single-use pairing token at start",
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
    process.stdout.write(`AGENT_HOST_CLI_PAIRING_TOKEN ${JSON.stringify(pairing)}\n`);
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

main().catch((error) => {
  const code = (error as { errorCode?: string })?.errorCode ?? "INTERNAL";
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", channel: "agent-host-cli", message: "agent-host-cli failed to start", data: { code, error: error instanceof Error ? error.message : String(error) } })}\n`);
  process.stdout.write(`AGENT_HOST_CLI_FAILED ${JSON.stringify({ code })}\n`);
  process.exit(1);
});
