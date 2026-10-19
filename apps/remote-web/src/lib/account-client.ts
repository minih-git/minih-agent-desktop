/**
 * Account mode over the Gateway's client API (protocol §11.5, D666 / rollout R7
 * package F).
 *
 * The client half of "confirm once, use everywhere": a browser or phone signs
 * in with a Router AccessKey, asks the account's Hosts to approve a device, and
 * ends with ONE device token that works on every Host of that account. The
 * AccessKey is used exactly once, inside `accountLogin`, and is never stored,
 * logged, or put in a URL; the account session it produces lives in memory for
 * the length of the flow and is dropped (and revoked, §11.5 logout) as soon as
 * the device token exists.
 *
 * The credential profile follows the build, not the caller: a browser signs in
 * with `client: "web"` and gets an `HttpOnly` account cookie plus a CSRF token,
 * a native shell signs in with its platform and gets the session credential in
 * the response body. Either way the device token is delivered the same way the
 * pairing route delivers one — cookies for the browser, body for native — so
 * nothing here ever has to keep a token in JavaScript.
 */
import { credentialHeaders, type HostCredential } from "./credential-port.js";
import { failureFrom, type OperationFailure } from "./errors.js";

export const ACCOUNT_ROUTES = {
  login: "/v1/account/login",
  logout: "/v1/account/logout",
  hosts: "/v1/account/hosts",
  devices: "/v1/account/devices",
} as const;

export function accountDeviceStatusPath(requestId: string): string {
  return `/v1/account/devices/${encodeURIComponent(requestId)}`;
}

/** Which client profile a build signs in with. */
export type AccountClientKind = "web" | "ios" | "android";

/**
 * One Host of the caller's own account, as the device flow reports it. A Host
 * that cannot confirm is named up front (`canConfirm: false`) instead of being
 * left to time out (security gate 33); `willAcceptGrant` says whether it would
 * adopt the resulting token.
 */
export type AccountDeviceHost = {
  hostId: string;
  label: string;
  online: boolean;
  canConfirm: boolean;
  willAcceptGrant: boolean;
};

export type AccountHostSummary = { hostId: string; label: string; online: boolean };

/** How a device request ended, as the status route reports it. */
export type AccountDeviceStatus = {
  requestId: string;
  status: "pending" | "granted" | "expired";
  expiresAt: string;
  hosts: AccountDeviceHost[];
  deviceId?: string;
  /** Native profiles only: the device token, for the platform secure store. */
  token?: string;
  /** Whether this response carried the token; false once it has been taken. */
  tokenDelivered?: boolean;
  /** Browser profiles only: the CSRF value to send with each Host's mutations. */
  csrfTokens?: Record<string, string>;
  roles?: string[];
  signerHostId?: string;
};

export type AccountCall<T> = { ok: true; value: T } | { ok: false; failure: OperationFailure };

export type AccountClientOptions = {
  gatewayOrigin: string;
  fetchImpl?: typeof fetch;
};

/** Whether this Gateway serves account mode at all. */
export type AccountMode = "supported" | "unsupported" | "unknown";

type RequestInput = AccountClientOptions & {
  /** Absent for the probe and for the login, which is the first credential. */
  credential?: HostCredential | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The RACP-HTTP error envelope: `{error: {code, message, data: {...}}}`. */
function failureFromResponse(response: Response, payload: unknown): OperationFailure {
  const error = isRecord(payload) ? payload.error : undefined;
  const data = isRecord(error) ? error.data : undefined;
  const code = isRecord(data) && typeof data.code === "string" ? data.code : `HTTP_${response.status}`;
  const message =
    isRecord(data) && typeof data.message === "string"
      ? data.message
      : isRecord(error) && typeof error.message === "string"
        ? error.message
        : `HTTP ${response.status}`;
  const retriable = isRecord(data) && typeof data.retriable === "boolean" ? data.retriable : false;
  // A `RATE_LIMITED` answer carries the Gateway's own retry hint, and the
  // Router's lockout carries its delay the same way; both are seconds.
  const retryAfter = Number(response.headers.get("retry-after") ?? "");
  return {
    code,
    message,
    retriable,
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: Math.ceil(retryAfter * 1000) } : {}),
  };
}

/** One account call: cookie credentials ride ambient cookies, header ones a header. */
async function accountRequest(
  input: RequestInput & { path: string; method: "GET" | "POST"; body?: unknown },
): Promise<{ response: Response; payload: unknown } | { failure: OperationFailure }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const credential = input.credential ?? null;
  const headers: Record<string, string> = { accept: "application/json", ...(credential ? credentialHeaders(credential) : {}) };
  if (input.body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetchImpl(`${input.gatewayOrigin}${input.path}`, {
      method: input.method,
      headers,
      // The account cookie is `HttpOnly` and scoped to the Gateway origin, so
      // the browser profile has to ask for it explicitly.
      credentials: credential?.kind === "header" ? "same-origin" : "include",
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
  } catch (error) {
    return { failure: failureFrom(error) };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) return { failure: failureFromResponse(response, payload) };
  return { response, payload };
}

/**
 * Does this Gateway serve account mode?
 *
 * `GET /v1/account/hosts` without a credential is the cheapest honest probe:
 * an account-mode Gateway answers `401 UNAUTHORIZED` (the route exists and
 * wants a session), and a Gateway without account mode answers the `NOT_FOUND`
 * every unknown path produces. A `403` means this origin is not allowlisted, so
 * nothing account-scoped would work from here and the AccessKey entry stays
 * hidden. A transport failure is `unknown`: the caller keeps the existing
 * pairing flow rather than showing an entry that cannot work.
 *
 * "Without a credential" is enforced, not assumed: `credentials: "omit"` and no
 * `Authorization` header. Asking the browser for its cookies would make the
 * probe authenticated whenever a session is still alive — a session outlives an
 * abandoned device request for twelve hours — and the authenticated answer
 * (`200`) is none of the probe's answers, which hid the AccessKey entry for the
 * rest of the session.
 */
export async function probeAccountMode(options: AccountClientOptions): Promise<AccountMode> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${options.gatewayOrigin}${ACCOUNT_ROUTES.hosts}`, {
      method: "GET",
      headers: { accept: "application/json" },
      // No cookie, no session: the route's own `401` is the signal this probe
      // reads, and it is only honest when nothing authenticates the request.
      credentials: "omit",
    });
    if (response.status === 401) return "supported";
    if (response.status === 403 || response.status === 404) return "unsupported";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * `POST /v1/account/login`. The AccessKey travels in the `Authorization`
 * header, is verified by the Gateway against the Router, and is gone from this
 * process the moment the call returns.
 */
export async function accountLogin(
  options: AccountClientOptions & { accessKey: string; client: AccountClientKind; label?: string },
): Promise<AccountCall<{ accountId: string; expiresAt: string; credential: HostCredential }>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${options.gatewayOrigin}${ACCOUNT_ROUTES.login}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${options.accessKey}` },
      credentials: "include",
      body: JSON.stringify({ client: options.client, ...(options.label ? { label: options.label } : {}) }),
    });
  } catch (error) {
    return { ok: false, failure: failureFrom(error) };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) return { ok: false, failure: failureFromResponse(response, payload) };
  const result = isRecord(payload) && isRecord(payload.result) ? payload.result : null;
  const accountId = result && typeof result.accountId === "string" ? result.accountId : null;
  const expiresAt = result && typeof result.expiresAt === "string" ? result.expiresAt : null;
  if (!accountId || !expiresAt) {
    return { ok: false, failure: { code: "INTERNAL", message: "the login response carried no account", retriable: false } };
  }
  // A browser never reads the session credential from the body; a native client
  // only ever gets it there. The profile is decided by which one arrived.
  const csrfToken = result && typeof result.csrfToken === "string" ? result.csrfToken : null;
  const token = result && typeof result.token === "string" ? result.token : null;
  const credential: HostCredential | null =
    options.client === "web"
      ? csrfToken
        ? { kind: "cookie", csrfToken }
        : null
      : token
        ? { kind: "header", token }
        : null;
  if (!credential) {
    return {
      ok: false,
      failure: { code: "INTERNAL", message: "the login response carried no usable session credential", retriable: false },
    };
  }
  return { ok: true, value: { accountId, expiresAt, credential } };
}

/** `GET /v1/account/hosts`: the Hosts of the caller's own account, and no others. */
export async function listAccountHosts(
  options: AccountClientOptions & { credential: HostCredential },
): Promise<AccountCall<{ accountId: string; hosts: AccountHostSummary[] }>> {
  const call = await accountRequest({ ...options, path: ACCOUNT_ROUTES.hosts, method: "GET" });
  if ("failure" in call) return { ok: false, failure: call.failure };
  const result = isRecord(call.payload) && isRecord(call.payload.result) ? call.payload.result : null;
  const rawHosts = result && Array.isArray(result.hosts) ? result.hosts : [];
  const hosts: AccountHostSummary[] = [];
  for (const entry of rawHosts) {
    if (!isRecord(entry) || typeof entry.hostId !== "string") continue;
    hosts.push({
      hostId: entry.hostId,
      label: typeof entry.label === "string" && entry.label ? entry.label : entry.hostId,
      online: entry.online === true,
    });
  }
  return {
    ok: true,
    value: { accountId: result && typeof result.accountId === "string" ? result.accountId : "", hosts },
  };
}

/** `POST /v1/account/devices`: ask the account's Hosts to approve a new device. */
export async function requestAccountDevice(
  options: AccountClientOptions & { credential: HostCredential; deviceLabel: string; client: AccountClientKind },
): Promise<AccountCall<{ requestId: string; expiresAt: string; hosts: AccountDeviceHost[] }>> {
  const call = await accountRequest({
    ...options,
    path: ACCOUNT_ROUTES.devices,
    method: "POST",
    body: { deviceLabel: options.deviceLabel, client: options.client },
  });
  if ("failure" in call) return { ok: false, failure: call.failure };
  const result = isRecord(call.payload) && isRecord(call.payload.result) ? call.payload.result : null;
  const requestId = result && typeof result.requestId === "string" ? result.requestId : "";
  const expiresAt = result && typeof result.expiresAt === "string" ? result.expiresAt : "";
  if (!requestId || !expiresAt) {
    return { ok: false, failure: { code: "INTERNAL", message: "the device request carried no id", retriable: false } };
  }
  return { ok: true, value: { requestId, expiresAt, hosts: deviceHostsFrom(result?.hosts) } };
}

/** `GET /v1/account/devices/{requestId}`: the outcome, and the token once granted. */
export async function fetchAccountDeviceStatus(
  options: AccountClientOptions & { credential: HostCredential; requestId: string },
): Promise<AccountCall<AccountDeviceStatus>> {
  const call = await accountRequest({ ...options, path: accountDeviceStatusPath(options.requestId), method: "GET" });
  if ("failure" in call) return { ok: false, failure: call.failure };
  const result = isRecord(call.payload) && isRecord(call.payload.result) ? call.payload.result : null;
  if (!result || typeof result.status !== "string") {
    return { ok: false, failure: { code: "INTERNAL", message: "the device status carried no outcome", retriable: false } };
  }
  const csrfTokens: Record<string, string> = {};
  if (isRecord(result.csrfTokens)) {
    for (const [hostId, value] of Object.entries(result.csrfTokens)) {
      if (typeof value === "string" && value) csrfTokens[hostId] = value;
    }
  }
  return {
    ok: true,
    value: {
      requestId: typeof result.requestId === "string" ? result.requestId : options.requestId,
      status: result.status === "granted" || result.status === "expired" ? result.status : "pending",
      expiresAt: typeof result.expiresAt === "string" ? result.expiresAt : "",
      hosts: deviceHostsFrom(result.hosts),
      ...(typeof result.deviceId === "string" ? { deviceId: result.deviceId } : {}),
      ...(typeof result.token === "string" ? { token: result.token } : {}),
      ...(typeof result.tokenDelivered === "boolean" ? { tokenDelivered: result.tokenDelivered } : {}),
      ...(Object.keys(csrfTokens).length > 0 ? { csrfTokens } : {}),
      ...(Array.isArray(result.roles) ? { roles: result.roles.filter((role): role is string => typeof role === "string") } : {}),
      ...(typeof result.signerHostId === "string" ? { signerHostId: result.signerHostId } : {}),
    },
  };
}

/**
 * `POST /v1/account/logout`: end this client's own account session. A browser
 * cannot clear the `HttpOnly` account cookie itself, so this is the only way to
 * drop the session once the device token exists. The device token is a separate
 * credential and is untouched.
 */
export async function accountLogout(
  options: AccountClientOptions & { credential: HostCredential },
): Promise<AccountCall<{ revoked: boolean }>> {
  const call = await accountRequest({ ...options, path: ACCOUNT_ROUTES.logout, method: "POST" });
  if ("failure" in call) return { ok: false, failure: call.failure };
  const result = isRecord(call.payload) && isRecord(call.payload.result) ? call.payload.result : null;
  return { ok: true, value: { revoked: result?.revoked === true } };
}

function deviceHostsFrom(value: unknown): AccountDeviceHost[] {
  if (!Array.isArray(value)) return [];
  const hosts: AccountDeviceHost[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.hostId !== "string") continue;
    hosts.push({
      hostId: entry.hostId,
      label: typeof entry.label === "string" && entry.label ? entry.label : entry.hostId,
      online: entry.online === true,
      canConfirm: entry.canConfirm === true,
      willAcceptGrant: entry.willAcceptGrant === true,
    });
  }
  return hosts;
}
