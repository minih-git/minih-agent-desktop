/**
 * Account mode: this desktop asks its own account for a device token, and then
 * reaches its siblings through the Gateway (ADR
 * `remote-control-router-account-binding` amendment 3, decisions 2 and 8;
 * rollout R8 packages C and D).
 *
 * The shape of the exchange is the Gateway's, not this module's:
 *
 * 1. `POST /v1/account/desktop-proof` with the account session credential mints
 *    the `requestId`, the single-use `nonce`, and the roster of sibling
 *    computers, so the client knows which of them could admit it at all.
 * 2. This desktop signs `hostProofSigningPayload(...)` with the private key of
 *    the Host certificate the Gateway issued to **this** machine — the same key
 *    that signs device grants — and presents it on `POST /v1/account/devices`
 *    as a `desktop` request.
 * 3. `GET /v1/account/devices/{requestId}` reports `granted` once a sibling
 *    verified that proof itself and admitted the device.
 *
 * The resulting `pdt1.` token is a normal account device token: it is what
 * `GET /v1/hosts/{hostId}/ws` accepts. Nothing here is an authorization — every
 * sibling re-verifies the proof with its own pinned CA — so this module never
 * claims an admission on the Gateway's word.
 *
 * Secrets: the account session credential and the device token stay in this
 * process. Neither is logged, returned to the renderer, or written anywhere but
 * the encrypted credential store. The Host private key never leaves the store
 * either; it is read to sign one payload.
 */
import { randomUUID } from "node:crypto";

import {
  RACP_ACCOUNT_DEVICE_ROUTES,
  RACP_ACCOUNT_HOSTS_PATH,
  RACP_ACCOUNT_LOGIN_PATH,
  hostProofSigningPayload,
  type RacpAccountDeviceHost,
  type RacpAccountLoginResponse,
  type RacpDeviceHostProof,
  type RacpDesktopProofHttpResponse,
} from "@minih-agent/shared";

import { signHostArtifact } from "@minih-agent/racp";

/** The account login credential profile a desktop uses (header profile). */
export const DESKTOP_CLIENT_KIND = "desktop" as const;

/** How long one automatic admission may take before this desktop gives up. */
export const DESKTOP_DEVICE_REQUEST_TIMEOUT_MS = 20_000;
/** How often the status route is polled while waiting for a sibling's answer. */
const STATUS_POLL_INTERVAL_MS = 250;

export type AccountDesktopClientOptions = {
  /** The Gateway's HTTPS origin, e.g. `https://gateway.example.com`. */
  publicOrigin: string;
  /** Label this computer is listed under, and the device label it requests. */
  deviceLabel: string;
  /** This desktop's own Host certificate and key: the account binding and signer. */
  signer: { certificatePem: string; privateKeyPem: string };
  /** This desktop's `hostId`, which the proof must name. */
  hostId: string;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  /** Test seam: the clock used for the request deadline. */
  now?: () => number;
  /** Test seam: the wait between status polls. */
  pollIntervalMs?: number;
  /** Test seam: fetch, so a test never opens a socket. */
  fetch?: typeof fetch;
};

export type AccountDeviceOutcome =
  | { state: "granted"; token: string; deviceId?: string; signerHostId?: string }
  | { state: "denied"; reason: string }
  | { state: "unavailable"; reason: string };

/**
 * Log in with the account's AccessKey and return the session credential.
 *
 * The key is presented only in the `Authorization` header, and the answer is
 * projected to the fields this module needs: the caller stores the credential,
 * never the key.
 */
export async function loginAccount(options: {
  publicOrigin: string;
  accessKey: string;
  label?: string;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  fetch?: typeof fetch;
}): Promise<{ token: string; accountId: string; expiresAt: string } | { error: string }> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${trimOrigin(options.publicOrigin)}${RACP_ACCOUNT_LOGIN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.accessKey}` },
      body: JSON.stringify({ client: DESKTOP_CLIENT_KIND, ...(options.label ? { label: options.label } : {}) }),
    });
  } catch (error) {
    options.log("warn", "account login could not reach the Gateway", { error: String(error) });
    return { error: "ACCOUNT_GATEWAY_UNREACHABLE" };
  }
  const payload = (await readJson(response)) as { result?: RacpAccountLoginResponse; error?: { data?: { code?: string } } };
  const result = payload?.result;
  // A desktop always uses the header profile, so the credential must arrive in
  // the body: a cookie-only answer is the browser path and cannot be stored.
  if (!response.ok || !result?.token) {
    const code = payload?.error?.data?.code ?? `HTTP_${response.status}`;
    options.log("warn", "account login was refused", { code });
    return { error: code };
  }
  return { token: result.token, accountId: result.accountId, expiresAt: result.expiresAt };
}

/**
 * Ask this desktop's own account for a device token, proving with this
 * machine's Host certificate. A sibling admits the device after verifying the
 * proof itself; this call reports what happened, never what was hoped for.
 */
export async function requestAccountDevice(
  options: AccountDesktopClientOptions,
  sessionToken: string,
): Promise<AccountDeviceOutcome> {
  const doFetch = options.fetch ?? fetch;
  const origin = trimOrigin(options.publicOrigin);
  const now = options.now ?? (() => Date.now());
  const pollIntervalMs = options.pollIntervalMs ?? STATUS_POLL_INTERVAL_MS;

  // 1. Mint the nonce the proof is made over. The Gateway owns it because only
  //    it can bind one nonce to one request and one deadline.
  const minted = await postJson(doFetch, `${origin}${RACP_ACCOUNT_DEVICE_ROUTES.desktopProofPath}`, sessionToken, {
    deviceLabel: options.deviceLabel,
    applicantHostId: options.hostId,
  });
  if (!minted.ok) {
    options.log("warn", "the Gateway refused to mint a desktop proof", { code: minted.code });
    return { state: "denied", reason: minted.code };
  }
  const challenge = minted.result as RacpDesktopProofHttpResponse;
  const admittable = challenge.hosts.filter((host) => host.online && host.supportsDesktopAuto);
  if (admittable.length === 0) {
    // Nothing could admit this computer: say so instead of waiting for a frame
    // that will never come (the silent-drop trap of ADR decision 6).
    return { state: "unavailable", reason: needsUpdateReason(challenge.hosts) };
  }

  // 2. Sign the exact payload the Gateway minted and present it as a desktop
  //    request. The certificate travels with the proof: a target Host has no
  //    other way to obtain it.
  const signature = signHostArtifact(
    hostProofSigningPayload({
      requestId: challenge.requestId,
      nonce: challenge.nonce,
      applicantHostId: challenge.applicantHostId,
      accountId: challenge.accountId,
      expiresAt: challenge.expiresAt,
    }),
    options.signer.privateKeyPem,
  );
  const hostProof: RacpDeviceHostProof = {
    applicantHostId: challenge.applicantHostId,
    nonce: challenge.nonce,
    signature,
    certificate: options.signer.certificatePem,
  };
  const presented = await postJson(doFetch, `${origin}${RACP_ACCOUNT_DEVICE_ROUTES.requestPath}`, sessionToken, {
    deviceLabel: options.deviceLabel,
    client: DESKTOP_CLIENT_KIND,
    requestId: challenge.requestId,
    hostProof,
  });
  if (!presented.ok) {
    options.log("warn", "the Gateway refused a desktop device request", { code: presented.code });
    return { state: "denied", reason: presented.code };
  }

  // 3. Wait for a sibling to answer. The request's own deadline bounds the
  //    wait, so this can never outlive what the Gateway will honour.
  const deadline = Math.min(Date.parse(challenge.expiresAt), now() + DESKTOP_DEVICE_REQUEST_TIMEOUT_MS);
  for (;;) {
    const status = await getJson(
      doFetch,
      `${origin}${RACP_ACCOUNT_DEVICE_ROUTES.statusPath.replace("{requestId}", encodeURIComponent(challenge.requestId))}`,
      sessionToken,
    );
    if (status.ok) {
      const result = status.result as { status?: string; token?: string; deviceId?: string; signerHostId?: string };
      if (result.status === "granted") {
        if (typeof result.token === "string" && result.token) {
          options.log("info", "this desktop was admitted to its own account", {
            deviceId: result.deviceId ?? "",
            signerHostId: result.signerHostId ?? "",
          });
          return {
            state: "granted",
            token: result.token,
            ...(result.deviceId ? { deviceId: result.deviceId } : {}),
            ...(result.signerHostId ? { signerHostId: result.signerHostId } : {}),
          };
        }
        return { state: "denied", reason: "GRANT_WITHOUT_TOKEN" };
      }
    } else if (status.code !== "NOT_FOUND") {
      // A refusal other than "not there yet" ends the wait: retrying a rejected
      // request would only burn the rate limit.
      return { state: "denied", reason: status.code };
    }
    if (now() >= deadline) {
      options.log("warn", "the desktop device request expired unanswered", { requestId: challenge.requestId });
      return { state: "denied", reason: "REQUEST_EXPIRED" };
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * The account's computers, as the Gateway lists them (`GET /v1/account/hosts`).
 *
 * Validated before use: the roster decides which machines this desktop dials, so
 * a malformed row is dropped rather than trusted. Returns `null` when the
 * Gateway could not answer, which the caller reports as "not joined yet" instead
 * of an empty account.
 */
export async function listAccountHosts(options: {
  publicOrigin: string;
  sessionToken: string;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  fetch?: typeof fetch;
  /** The roster validator, so a malformed row never reaches the registry. */
  validate: (value: unknown) => { hostId: string; label: string; online: boolean }[];
}): Promise<{ hostId: string; label: string; online: boolean }[] | null> {
  const doFetch = options.fetch ?? fetch;
  const answer = await getJson(
    doFetch,
    `${trimOrigin(options.publicOrigin)}${RACP_ACCOUNT_HOSTS_PATH}`,
    options.sessionToken,
  );
  if (!answer.ok) {
    options.log("warn", "the Gateway refused the account host list", { code: answer.code });
    return null;
  }
  return options.validate(answer.result);
}

/**
 * Which answer a roster with no admittable computer deserves. A computer that
 * does not advertise `device.desktop-auto` predates this feature, so the honest
 * report is "needs an update" rather than a timeout.
 */
function needsUpdateReason(hosts: readonly RacpAccountDeviceHost[]): string {
  if (hosts.length === 0) return "NO_COMPUTERS";
  if (hosts.every((host) => !host.online)) return "ALL_COMPUTERS_OFFLINE";
  return "NEEDS_UPDATE";
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

type JsonOutcome = { ok: true; result: unknown } | { ok: false; code: string };

async function postJson(doFetch: typeof fetch, url: string, token: string, body: unknown): Promise<JsonOutcome> {
  return sendJson(doFetch, url, token, { method: "POST", body });
}

async function getJson(doFetch: typeof fetch, url: string, token: string): Promise<JsonOutcome> {
  return sendJson(doFetch, url, token, { method: "GET" });
}

async function sendJson(
  doFetch: typeof fetch,
  url: string,
  token: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<JsonOutcome> {
  let response: Response;
  try {
    response = await doFetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    return { ok: false, code: "ACCOUNT_GATEWAY_UNREACHABLE" };
  }
  const payload = (await readJson(response)) as { result?: unknown; error?: { data?: { code?: string } } };
  if (!response.ok) return { ok: false, code: payload?.error?.data?.code ?? `HTTP_${response.status}` };
  return { ok: true, result: payload?.result };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The `hostKey` one account computer is stored under. It is derived from the
 * Gateway identity and the sibling's `hostId`, so the same computer keeps one
 * row across restarts and cannot collide with a `direct` or `ssh` host.
 */
export function accountHostKey(hostId: string): string {
  return `account-${hostId}`;
}

/** A fresh request id for logs; never sent anywhere as a credential. */
export function newAccountRequestLabel(): string {
  return randomUUID();
}
