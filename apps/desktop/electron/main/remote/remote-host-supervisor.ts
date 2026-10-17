import { shellQuote, type AgentHostCliReadyLine } from "./agent-host-cli-bootstrap-script.js";
import { REMOTE_DEPLOY_LOCK_SCRIPT } from "./remote-deploy-lock.js";
import { REMOTE_AGENT_HOST_CLI_BASE } from "./remote-install-root.js";
import type { SshTransport } from "./ssh-transport.js";

export type RemoteHostSupervisorOptions = {
  /**
   * Release the running Host must report. It is the release this desktop
   * expects — not the version recorded when the host was paired — so a Host
   * left behind by an upgrade is refused here and handed to realignment
   * (ADR 0327).
   */
  version: string;
  expectedHostId?: string;
  readyTimeoutSec?: number;
};

function failure(message: string, errorCode = "HOST_BOOTSTRAP_FAILED"): Error {
  return Object.assign(new Error(message), {
    errorCode, retriable: !["HOST_AUTH_FAILED", "HOST_VERSION_MISMATCH"].includes(errorCode),
  });
}

/** Daily startup only: no installation, pairing, credentials reset or restart. */
export function buildRemoteHostSupervisorScript(readyTimeoutSec = 30): string {
  if (!Number.isInteger(readyTimeoutSec) || readyTimeoutSec < 1 || readyTimeoutSec > 120) {
    throw new Error("Invalid Host ready timeout");
  }
  return `#!/bin/sh
set -eu
umask 077
die() { printf '%s\\n' "AGENT_HOST_CLI_SUPERVISOR_FAILED $1" >&2; exit 1; }
[ -n "\${HOME:-}" ] || die no-home
base="${REMOTE_AGENT_HOST_CLI_BASE}"
entry="$base/current/agent-host-cli.js"
work="$base/.bootstrap"
[ ! -L "$work" ] || die unsafe-work-directory
mkdir -p "$work"
chmod 700 "$work" || die work-permissions
${REMOTE_DEPLOY_LOCK_SCRIPT}
trap release_deploy_lock EXIT
trap 'exit 1' HUP INT TERM
[ -f "$entry" ] || die host-not-installed
log="$work/agent-host-cli.log"
err="$work/agent-host-cli.err"
pidfile="$work/agent-host-cli.pid"
for file in "$log" "$err" "$pidfile"; do
  [ ! -L "$file" ] || die unsafe-state-file
  [ ! -e "$file" ] || [ -f "$file" ] || die unsafe-state-file
done
# Match the installed entry point, not a generic node or agent-host-cli process.
physical_entry="$(cd "$base/current" && pwd -P)/agent-host-cli.js"
is_host() {
  kill -0 "$host_pid" 2>/dev/null || return 1
  command_line=$(ps -p "$host_pid" -o command= 2>/dev/null) || die host-process-unreadable
  case " $command_line " in
    *" $entry "*|*" $physical_entry "*) return 0 ;;
    *) die host-pid-mismatch ;;
  esac
}
host_pid=""
if [ -f "$pidfile" ]; then
  host_pid=$(cat "$pidfile")
  case "$host_pid" in ''|*[!0-9]*|0) die invalid-host-pid ;; esac
fi
if [ -z "$host_pid" ] || ! is_host; then
  node="$base/current/bin/node"
  if [ ! -x "$node" ]; then
    node=$(command -v node) || die missing-node
  fi
  major=$("$node" -p 'process.versions.node.split(".")[0]') || die invalid-node
  [ "$major" -ge 22 ] 2>/dev/null || die node-too-old
  # Only discard old ready/token lines after the previous Host is down.
  : > "$log"
  : > "$err"
  nohup "$node" "$entry" --port 0 >"$log" 2>"$err" </dev/null 9>&- &
  host_pid=$!
  printf '%s\\n' "$host_pid" > "$pidfile"
fi
waited=0
while [ "$waited" -lt ${shellQuote(String(readyTimeoutSec))} ]; do
  kill -0 "$host_pid" 2>/dev/null || die host-exited
  grep -q '^AGENT_HOST_CLI_FAILED ' "$log" 2>/dev/null && die host-start-failed
  ready=$(grep -m1 '^AGENT_HOST_CLI_READY ' "$log" 2>/dev/null || true)
  if [ -n "$ready" ]; then
    is_host || die host-exited
    # Never echo a historic single-use pairing token.
    printf '%s\\n' "$ready"
    exit 0
  fi
  sleep 1
  waited=$((waited + 1))
done
die ready-timeout
`;
}

/** Treat SSH stdout as an untrusted boundary; never include it in diagnostics. */
export function parseRemoteHostReady(stdout: string, options: RemoteHostSupervisorOptions): AgentHostCliReadyLine {
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length !== 1 || !lines[0]?.startsWith("AGENT_HOST_CLI_READY ")) {
    throw failure("Remote Host did not report a single ready line");
  }
  let value: unknown;
  try { value = JSON.parse(lines[0].slice("AGENT_HOST_CLI_READY ".length)); }
  catch { throw failure("Remote Host reported malformed readiness"); }
  if (!value || typeof value !== "object") throw failure("Remote Host reported malformed readiness");
  const { hostId, host, port, version } = value as Record<string, unknown>;
  if (typeof hostId !== "string" || !hostId.trim() ||
      (host !== "127.0.0.1" && host !== "::1") ||
      typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof version !== "string" || !version.trim()) {
    throw failure("Remote Host reported invalid readiness");
  }
  // Identity is a trust boundary and takes precedence: a different Host must
  // never be mistaken for an older release that can be automatically replaced.
  if (options.expectedHostId !== undefined && hostId !== options.expectedHostId) {
    throw failure("Remote Host identity changed", "HOST_AUTH_FAILED");
  }
  if (version.replace(/^v/, "") !== options.version.replace(/^v/, "")) {
    throw failure("the running remote Host does not match the release this Desktop expects", "HOST_VERSION_MISMATCH");
  }
  return { hostId, host, port, version };
}

export async function ensureRemoteHostReady(
  transport: SshTransport,
  options: RemoteHostSupervisorOptions,
): Promise<AgentHostCliReadyLine> {
  const timeout = options.readyTimeoutSec ?? 30;
  const result = await transport.execWithInput("sh -s", buildRemoteHostSupervisorScript(timeout), {
    timeoutMs: (120 + timeout + 15) * 1000,
    maxOutputBytes: 16 * 1024,
  });
  if (result.code !== 0) throw failure("Remote Host startup check failed");
  return parseRemoteHostReady(result.stdout, options);
}
