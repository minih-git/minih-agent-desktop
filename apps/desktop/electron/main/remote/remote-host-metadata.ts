import type { RemoteHostAccountMetadata, RemoteHostSshMetadata, RemoteHostTransport } from "@minih-agent/shared";
import { isRacpHostId } from "@minih-agent/shared";
import type { RemoteHostRecord } from "./remote-host-registry.js";
import { assertSshArgument } from "./ssh-transport.js";

function safeSshField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { return assertSshArgument(value, "ssh field"); } catch { return null; }
}
function safeSshPort(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : null;
}

/** Registry metadata is untrusted, and must never become unchecked SSH argv. */
export function sshMetadataOf(record: RemoteHostRecord): RemoteHostSshMetadata | null {
  if (record.metadata?.transport !== "ssh") return null;
  const ssh = record.metadata.ssh;
  if (typeof ssh !== "object" || ssh === null) return null;
  const candidate = ssh as Partial<RemoteHostSshMetadata>;
  const host = safeSshField(candidate.host);
  if (host === null) return null;
  const user = candidate.user === undefined ? null : safeSshField(candidate.user);
  if (user === null && candidate.user !== undefined) return null;
  const identityFile = candidate.identityFile === undefined ? null : safeSshField(candidate.identityFile);
  if (identityFile === null && candidate.identityFile !== undefined) return null;
  const port = candidate.port === undefined ? null : safeSshPort(candidate.port);
  if (port === null && candidate.port !== undefined) return null;
  const remotePort = safeSshPort(candidate.remotePort);
  if (remotePort === null) return null;
  const hostId = candidate.hostId;
  if (hostId !== undefined && (typeof hostId !== "string" || !hostId.trim() || hostId.length > 256 || /[\u0000-\u001f]/.test(hostId))) return null;
  return {
    host, remotePort,
    ...(hostId !== undefined ? { hostId } : {}),
    ...(port !== null ? { port } : {}),
    ...(user !== null ? { user } : {}),
    ...(identityFile !== null ? { identityFile } : {}),
    ...(candidate.auth === "password" ? { auth: "password" as const } : {}),
    version: typeof candidate.version === "string" ? candidate.version : "",
  };
}

export function sshHostRecord(input: {
  hostKey: string; label: string; url: string; deviceToken: string;
  ssh: RemoteHostSshMetadata; sshSecret?: string;
}): RemoteHostRecord {
  return {
    hostKey: input.hostKey, label: input.label, url: input.url, deviceToken: input.deviceToken,
    ...(input.sshSecret ? { sshSecret: input.sshSecret } : {}),
    metadata: { transport: "ssh", ssh: input.ssh },
  };
}
/**
 * The account descriptor of a sibling computer, or `null`.
 *
 * Registry metadata is untrusted, so every field is checked: the `hostId` must
 * be one the Gateway could have issued (`RACP_HOST_ID_PATTERN`), and the origin
 * must be an `https://` URL with no credentials in it and no path. A record
 * that fails any check reads as a `direct` host, which is what it was before
 * the transport existed — never as a half-valid account host.
 */
export function accountMetadataOf(record: RemoteHostRecord): RemoteHostAccountMetadata | null {
  if (record.metadata?.transport !== "account") return null;
  const account = record.metadata.account;
  if (typeof account !== "object" || account === null) return null;
  const candidate = account as Partial<RemoteHostAccountMetadata>;
  const hostId = typeof candidate.hostId === "string" ? candidate.hostId.trim() : "";
  if (!isRacpHostId(hostId)) return null;
  const publicOrigin = accountOrigin(candidate.publicOrigin);
  if (!publicOrigin) return null;
  const hostlinkUrl = candidate.hostlinkUrl === undefined ? "" : accountOrigin(candidate.hostlinkUrl);
  if (candidate.hostlinkUrl !== undefined && !hostlinkUrl) return null;
  const label = typeof candidate.label === "string" && candidate.label.trim() ? candidate.label.trim().slice(0, 128) : "";
  return {
    hostId,
    publicOrigin,
    ...(hostlinkUrl ? { hostlinkUrl } : {}),
    ...(label ? { label } : {}),
  };
}

/**
 * A usable `https://` origin: absolute, no credentials, no query, no fragment.
 * The `wss://` Host-link URL is accepted too, because that is what the Gateway
 * advertises; it is normalized to its `https:` origin for the client API.
 */
function accountOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  if (protocol !== "https:" && protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  return `${protocol}//${url.host}`;
}

export function accountHostRecord(input: {
  hostKey: string; label: string; url: string; deviceToken: string;
  account: RemoteHostAccountMetadata;
}): RemoteHostRecord {
  return {
    hostKey: input.hostKey, label: input.label, url: input.url, deviceToken: input.deviceToken,
    metadata: { transport: "account", account: input.account },
  };
}

export function transportOf(record: RemoteHostRecord): RemoteHostTransport {
  if (accountMetadataOf(record)) return "account";
  return sshMetadataOf(record) ? "ssh" : "direct";
}
