/**
 * Account mode on the desktop: discover the account's other computers and make
 * them real remote hosts (rollout R8 package E).
 *
 * Packages C and D built the pieces but nothing joined them: the Gateway can
 * list an account's computers and issue this desktop a device token that every
 * sibling accepts, yet this desktop's host list only ever contained paired SSH
 * hosts. P5 needs the opposite — the account's computers appear on their own,
 * with a live connection, so their projects and sessions are reachable without
 * per-machine setup.
 *
 * Two rules shape this module:
 *
 * - **Discovery is the Gateway's answer, never a guess.** `GET /v1/account/hosts`
 *   is account-scoped and takes no host id; the roster it returns is the only
 *   source of which computers exist.
 * - **This machine is not a remote host.** A row for itself would let the user
 *   drive this computer through the remote path, duplicating its local sessions
 *   and offering a connection to itself. It is filtered out by `hostId`, the
 *   Gateway's identity for a computer.
 *
 * Nothing secret leaves this module: the access key stays in the caller, the
 * device token goes straight into the encrypted registry, and the renderer only
 * ever sees a `RemoteHostSummary`.
 */
import { accountHostKey } from "./gateway-link/account-desktop-client.js";

/** One computer of the account, as the Gateway describes it. */
export type AccountComputer = { hostId: string; label: string; online: boolean };

/**
 * The computers this desktop may dial: everyone but itself.
 *
 * The Gateway's `online` is advisory — the transport decides for real — but a
 * computer it reports offline has no Host link to relay through, so dialling it
 * would only produce a failure the page has to explain anyway.
 */
export function reachableComputers(
  hosts: readonly AccountComputer[],
  selfHostId: string,
): AccountComputer[] {
  return hosts.filter((host) => host.hostId !== selfHostId && host.hostId.length > 0);
}

/**
 * The RACP-WS route one account computer answers on.
 *
 * `https` becomes `wss` and nothing else does: the Gateway terminates TLS, and a
 * plaintext origin here would mean the device token travelled in the clear.
 */
export function accountComputerUrl(publicOrigin: string, hostId: string): string {
  const origin = publicOrigin
    .replace(/\/+$/, "")
    .replace(/^https:/, "wss:")
    .replace(/^http:/, "ws:");
  return `${origin}/v1/hosts/${encodeURIComponent(hostId)}/ws`;
}

/** The routing key one account computer is stored under. */
export function accountComputerHostKey(hostId: string): string {
  return accountHostKey(hostId);
}

/**
 * Validate the roster a Gateway returned before any of it is dialled.
 *
 * The response crosses a network boundary, so a malformed row is dropped rather
 * than trusted: a `hostId` that could smuggle a path separator into the route,
 * or a label that is not a string, never reaches the registry.
 */
export function validateAccountHosts(value: unknown): AccountComputer[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const hosts = (value as { hosts?: unknown }).hosts;
  if (!Array.isArray(hosts)) return [];
  const valid: AccountComputer[] = [];
  for (const row of hosts.slice(0, 64)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const entry = row as Record<string, unknown>;
    const hostId = entry.hostId;
    if (typeof hostId !== "string" || !/^host_[A-Za-z0-9._-]{1,128}$/.test(hostId)) continue;
    const label = typeof entry.label === "string" && entry.label.trim()
      ? entry.label.trim().slice(0, 128)
      : hostId;
    valid.push({ hostId, label, online: entry.online === true });
  }
  return valid;
}
