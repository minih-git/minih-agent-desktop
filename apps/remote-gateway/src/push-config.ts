/**
 * Operator configuration for redacted push (protocol §11.6, R5 PR-6, ADR 0331
 * decision 7).
 *
 * Push is off unless the operator configured a provider, and the credentials are
 * files rather than command-line values for the same reason the Router AccessKey
 * is: argv is readable by every user on the machine and lands in shell history.
 * Both files are checked to be regular files, owned by the caller, and not
 * readable by anyone else (mode 0600), exactly like `--access-key-file`.
 *
 * Nothing here logs, echoes, or returns a private key or a token. The one place
 * a credential is used is the provider client, and it never puts one in a log
 * line, an audit record, or an error message.
 */
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** One provider family, resolved from the operator's flags. */
export type ApnsPushConfig = {
  /** PEM of the `.p8` ES256 signing key. */
  privateKeyPem: string;
  /** Apple `kid` of that key. */
  keyId: string;
  /** Apple team id (`iss` of the provider JWT). */
  teamId: string;
  /** Bundle id the notifications belong to. */
  topic: string;
  /** `api.push.apple.com` unless an operator names a test deployment. */
  endpoint: string;
};

export type FcmPushConfig = {
  /** `client_email` of the service account. */
  clientEmail: string;
  /** RSA private key PEM from the service account JSON. */
  privateKeyPem: string;
  /** Project id; FCM v1 addresses messages under it. */
  projectId: string;
  /** OAuth2 token endpoint; `https://oauth2.googleapis.com/token` by default. */
  tokenUri: string;
  /** `https://fcm.googleapis.com` by default; the `/v1/projects/...` path is added. */
  endpoint: string;
};

export type PushConfig = {
  /** Absent: iOS notifications go nowhere and an iOS registration is refused. */
  apns?: ApnsPushConfig;
  /** Absent: Android notifications go nowhere and an Android registration is refused. */
  fcm?: FcmPushConfig;
};

/**
 * The push flags exactly as the operator gave them. `parseArgv` keeps them
 * strings; the credential files are read once at startup by
 * `resolvePushConfig`, so a bad path fails before the listeners bind.
 */
export type PushServeOptions = {
  apnsKeyFile?: string;
  apnsKeyId?: string;
  apnsTeamId?: string;
  apnsTopic?: string;
  apnsEndpoint?: string;
  fcmServiceAccountFile?: string;
  fcmEndpoint?: string;
  fcmTokenUri?: string;
};

export const DEFAULT_APNS_ENDPOINT = "https://api.push.apple.com";
export const DEFAULT_FCM_ENDPOINT = "https://fcm.googleapis.com";
export const DEFAULT_FCM_TOKEN_URI = "https://oauth2.googleapis.com/token";

export class PushConfigError extends Error {
  readonly code = "INVALID_CONFIGURATION";

  constructor(message: string) {
    super(message);
    this.name = "PushConfigError";
  }
}

/**
 * Read one credential file: a regular file, owned by the caller, mode 0600. A
 * group- or world-readable key is refused rather than silently accepted, because
 * an operator who chmods it once will never look again.
 */
async function readSecretFile(path: string, flag: string): Promise<string> {
  const absolute = resolve(path);
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(absolute);
  } catch {
    throw new PushConfigError(`${flag} ${absolute} cannot be read`);
  }
  if (!stat.isFile()) throw new PushConfigError(`${flag} ${absolute} is not a regular file`);
  if ((stat.mode & 0o077) !== 0) {
    throw new PushConfigError(`${flag} ${absolute} is readable by other users; chmod 600 it first`);
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new PushConfigError(`${flag} ${absolute} is not owned by this user`);
  }
  const text = await readFile(absolute, "utf8");
  if (!text.trim()) throw new PushConfigError(`${flag} ${absolute} is empty`);
  return text;
}

/**
 * One configured endpoint: an absolute `https:` URL. Provider tokens and access
 * tokens travel to it, so a `http:` value — or a relative one — is refused at
 * startup rather than silently sending a credential in the clear.
 */
function endpointUrl(value: string | undefined, flag: string, fallback: string): string {
  const raw = value?.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PushConfigError(`${flag} ${raw} is not an absolute URL`);
  }
  if (parsed.protocol !== "https:") throw new PushConfigError(`${flag} ${raw} must use https`);
  return raw.replace(/\/+$/, "");
}

/**
 * Resolve the push configuration.
 *
 * Returns `null` when nothing push-related is configured: push is off, the
 * route answers `enabled: false`, and the Gateway behaves exactly as before.
 * A partially configured provider is a configuration error at startup, so an
 * operator cannot believe push is on while half of it is missing.
 */
export async function resolvePushConfig(options: PushServeOptions | undefined): Promise<PushConfig | null> {
  if (!options) return null;
  const given = [options.apnsKeyFile, options.apnsKeyId, options.apnsTeamId, options.apnsTopic].filter(Boolean);
  const fcmFile = options.fcmServiceAccountFile ?? "";
  if (given.length === 0 && !fcmFile) {
    if (options.apnsEndpoint || options.fcmEndpoint || options.fcmTokenUri) {
      throw new PushConfigError("--apns-endpoint, --fcm-endpoint, and --fcm-token-uri need provider credentials too");
    }
    return null;
  }
  if (given.length > 0 && given.length !== 4) {
    throw new PushConfigError(
      "APNs needs --apns-key-file, --apns-key-id, --apns-team-id, and --apns-topic together",
    );
  }

  let apns: ApnsPushConfig | undefined;
  if (given.length === 4) {
    const privateKeyPem = await readSecretFile(options.apnsKeyFile!, "--apns-key-file");
    if (!privateKeyPem.includes("PRIVATE KEY")) {
      throw new PushConfigError("--apns-key-file does not hold a PKCS#8 private key");
    }
    apns = {
      privateKeyPem,
      keyId: options.apnsKeyId!,
      teamId: options.apnsTeamId!,
      topic: options.apnsTopic!,
      endpoint: endpointUrl(options.apnsEndpoint, "--apns-endpoint", DEFAULT_APNS_ENDPOINT),
    };
  }

  let fcm: FcmPushConfig | undefined;
  if (fcmFile) {
    const raw = await readSecretFile(fcmFile, "--fcm-service-account-file");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new PushConfigError("--fcm-service-account-file is not JSON");
    }
    const account = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
    const clientEmail = typeof account["client_email"] === "string" ? account["client_email"] : "";
    const privateKeyPem = typeof account["private_key"] === "string" ? account["private_key"] : "";
    const projectId = typeof account["project_id"] === "string" ? account["project_id"] : "";
    if (!clientEmail || !privateKeyPem || !projectId) {
      throw new PushConfigError("--fcm-service-account-file must carry client_email, private_key, and project_id");
    }
    if (!privateKeyPem.includes("PRIVATE KEY")) {
      throw new PushConfigError("--fcm-service-account-file holds no PEM private key");
    }
    fcm = {
      clientEmail,
      privateKeyPem,
      projectId,
      tokenUri: endpointUrl(options.fcmTokenUri, "--fcm-token-uri", DEFAULT_FCM_TOKEN_URI),
      endpoint: endpointUrl(options.fcmEndpoint, "--fcm-endpoint", DEFAULT_FCM_ENDPOINT),
    };
  }

  return { ...(apns ? { apns } : {}), ...(fcm ? { fcm } : {}) };
}
