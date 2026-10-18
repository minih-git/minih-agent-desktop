/**
 * Router AccessKey verification (ADR decisions 4 and 5, protocol §11.5,
 * security §3.8, gates 30 and 31).
 *
 * Account mode turns a Minih-Router AccessKey into the account identity. The
 * Gateway never holds a copy of the key: it presents it once to the Router's
 * `GET /api/auth/session` over loopback and keeps only the answered
 * `access_key_id`.
 *
 * Two rules make the answer trustworthy:
 *
 * - the Router is reached over loopback only, so a misconfiguration cannot send
 *   a user's key to a remote host;
 * - the caller's real address travels in the header the Router's
 *   `CLIENT_IP_HEADER` names, from a peer the Router lists in its
 *   `TRUSTED_PROXIES`, so the key's `allowed_peer_cidrs` is evaluated against
 *   the actual caller rather than against the Gateway.
 *
 * Only an active key authenticates (the Router indexes no other kind), so a
 * disabled or deleted key is a refusal here too. Anything that is not a clean
 * `authenticated: true` + `principal_type: "access_key"` + `access_key_id`
 * answer is a refusal; an unreachable or unreadable Router is a retriable
 * error, never a pass.
 *
 * A locked-out caller is its own verdict. The Router answers `429` with
 * `Retry-After` and `{ code: "AUTH_LOCKED", data: { retry_after_seconds } }`
 * after too many failed authentications from one address
 * (`internal/control/auth_limiter.go`), and reporting that as an invalid key
 * would tell the user to replace a working key and throw away the retry hint.
 */
import { isLoopbackBind } from "./config.js";

/** Bounded Router call; a hung control plane must not hold an enrollment open. */
export const DEFAULT_ROUTER_TIMEOUT_MS = 5_000;

export type RouterKeyVerdict =
  | { ok: true; accountId: string; keyName?: string; expiresAtMs?: number }
  /** `refused`: the Router answered and the key is not an active AccessKey. */
  | { ok: false; reason: "refused" }
  /** `unavailable`: the Router could not be reached or could not be read. */
  | { ok: false; reason: "unavailable" }
  /** `rate_limited`: the Router locked this caller out; retrying can succeed. */
  | { ok: false; reason: "rate_limited"; retryAfterMs?: number };

export type RouterVerifierOptions = {
  /** Loopback base URL of the Router control plane, e.g. `http://127.0.0.1:3001`. */
  baseUrl: string;
  /** Header name equal to the Router's `CLIENT_IP_HEADER`. */
  clientIpHeader: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate `--router-url`: http(s) on a loopback host, no credentials, no query
 * and no fragment. A path prefix is kept because the Router may be mounted
 * under one; a trailing slash is dropped so `/api/auth/session` appends cleanly.
 */
export function resolveRouterUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--router-url ${value} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--router-url must be an http or https URL");
  }
  // `URL.hostname` keeps the brackets of an IPv6 literal; the bind-address rule
  // does not.
  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (!isLoopbackBind(hostname)) {
    throw new Error(`--router-url ${hostname} is not loopback; the AccessKey must not leave this machine`);
  }
  if (url.username || url.password) throw new Error("--router-url must not carry credentials");
  if (url.search || url.hash) throw new Error("--router-url must not carry a query string or fragment");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export class RouterAccountVerifier {
  readonly baseUrl: string;
  readonly clientIpHeader: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RouterVerifierOptions) {
    this.baseUrl = resolveRouterUrl(options.baseUrl);
    this.clientIpHeader = options.clientIpHeader;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ROUTER_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Verify one AccessKey for one caller address. The key appears only in the
   * `Authorization` header of this request and is never logged, echoed, or
   * stored by the Gateway (gate 30).
   */
  async verify(accessKey: string, clientIp: string): Promise<RouterKeyVerdict> {
    // One deadline covers the request *and* its body: a Router that answers
    // headers and then stalls must not hold a login or an enrollment open.
    const signal = AbortSignal.timeout(this.timeoutMs);
    let status: number;
    let envelope: unknown;
    let retryAfterSeconds: number | undefined;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/auth/session`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessKey}`,
          [this.clientIpHeader]: clientIp,
          accept: "application/json",
        },
        redirect: "error",
        cache: "no-store",
        signal,
      });
      status = response.status;
      // The Router sends whole seconds; an HTTP-date would mean a proxy answered.
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter && /^\d+$/.test(retryAfter.trim())) retryAfterSeconds = Number(retryAfter.trim());
      // A control plane that does not answer the documented envelope is not a
      // usable verifier, whether the body was truncated, stalled, or the route
      // is wrong.
      envelope = await response.json();
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (status >= 500 || !isRecord(envelope)) return { ok: false, reason: "unavailable" };

    const data = isRecord(envelope["data"]) ? envelope["data"] : undefined;
    // `ErrAuthLocked` is 429 with `{ code: "AUTH_LOCKED", data:
    // { retry_after_seconds } }`; a lockout is retriable, never an invalid key.
    if (status === 429 || envelope["code"] === "AUTH_LOCKED") {
      const seconds = typeof data?.["retry_after_seconds"] === "number" ? data["retry_after_seconds"] : retryAfterSeconds;
      return {
        ok: false,
        reason: "rate_limited",
        ...(typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? { retryAfterMs: Math.ceil(seconds * 1000) } : {}),
      };
    }
    // `{ code: 0, message, data }` on success; `code` is a string on failure.
    if (envelope["code"] !== 0) return { ok: false, reason: "refused" };
    if (!data) return { ok: false, reason: "refused" };
    if (data["authenticated"] !== true || data["principal_type"] !== "access_key") {
      // An admin key authenticates but is not an account identity.
      return { ok: false, reason: "refused" };
    }
    const accountId = data["access_key_id"];
    if (typeof accountId !== "number" || !Number.isSafeInteger(accountId) || accountId <= 0) {
      return { ok: false, reason: "refused" };
    }
    const keyName = data["key_name"];
    const expiresAtMs = data["expires_at_ms"];
    return {
      ok: true,
      accountId: String(accountId),
      ...(typeof keyName === "string" && keyName ? { keyName } : {}),
      ...(typeof expiresAtMs === "number" ? { expiresAtMs } : {}),
    };
  }
}
