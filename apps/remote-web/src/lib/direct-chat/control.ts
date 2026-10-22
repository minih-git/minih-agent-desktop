/**
 * The model gateway's control plane, called from the phone (ADR
 * mobile-direct-gateway-chat §2).
 *
 * Two reads, both non-streaming: `GET /api/auth/session` proves an AccessKey and
 * names the account, and `GET /api/models` is the key-scoped, paginated catalog.
 *
 * Transport rules, all of them load-bearing:
 *
 * - Every request goes through `CapacitorHttp.request` directly, with redirects
 *   disabled. Native HTTP is not subject to CSP, so this service is what keeps
 *   the key on the configured origin: a URL is only ever built from the baked
 *   origin, and a response that came from anywhere else is refused. The global
 *   fetch/XHR patch stays off — turning it on would rewrite unrelated traffic.
 * - The key travels in an `Authorization` header and nowhere else: not in a URL,
 *   not in an error message, not in the returned shapes. A gateway message that
 *   echoes it is redacted before it can reach a screen or a log.
 * - Failures keep their kind, because the screen offers a different next step for
 *   each: a rejected key is replaced, a quota or rate limit is waited out, a key
 *   restricted to particular networks is a configuration problem, and a
 *   transport failure is retried.
 */
import {
  clampMinihRouterPage,
  parseMinihRouterKeySession,
  parseMinihRouterModelPage,
  type MinihRouterKeySession,
  type MinihRouterModelPage,
} from "@minih-agent/shared";

/** Paths this service is allowed to call. Anything else is a programming error. */
export const CONTROL_PATHS = {
  session: "/api/auth/session",
  models: "/api/models",
} as const;

/** How a control-plane read failed, as the screen needs to present it. */
export type DirectChatFailureKind =
  /** The gateway does not know this key, or it is disabled/expired. */
  | "unauthorized"
  /** Out of quota, or rate limited: waiting can help, replacing the key cannot. */
  | "quota"
  /** The key is restricted to particular networks this connection is not on. */
  | "network-range"
  /** The request never produced an answer: offline, DNS, TLS, timeout. */
  | "transport"
  /** The gateway answered, but not with anything this client can use. */
  | "gateway";

export type DirectChatFailure = {
  kind: DirectChatFailureKind;
  /** Readable reason for the screen; never contains the key. */
  message: string;
  status?: number;
  /** The gateway's own retry hint, when it sent one. */
  retryAfterMs?: number;
};

export type ControlResult<T> = { ok: true; value: T } | { ok: false; failure: DirectChatFailure };

/** The one transport call this service makes; `CapacitorHttp.request` by shape. */
export type ControlTransport = (options: {
  url: string;
  method: "GET";
  headers: Record<string, string>;
  /** Redirects are always off: the key must not travel to another origin. */
  disableRedirects: true;
  connectTimeout: number;
  readTimeout: number;
}) => Promise<{ status: number; data: unknown; headers?: Record<string, string> }>;

export const CONTROL_TIMEOUT_MS = 15_000;

/** Enough to name the failure without echoing a key of unknown length. */
const MAX_REASON = 300;

function redact(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

/** The gateway's envelope is `{ code, message, data }`; `code: 0` is success. */
function envelope(data: unknown): { code: unknown; message: string; data: unknown } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { code: null, message: "", data: null };
  }
  const row = data as Record<string, unknown>;
  return {
    code: row.code,
    message: typeof row.message === "string" ? row.message : "",
    data: row.data,
  };
}

function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined;
  const raw = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

/**
 * Whether a refusal is about the caller's network rather than the key itself.
 *
 * A key with `allowed_peer_cidrs` is refused from any other network, and the
 * remedy is completely different from replacing the key: the user has to reach
 * the gateway from the allowed network, or the operator has to widen the rule.
 */
function looksLikeNetworkRange(message: string): boolean {
  return /allowed_peer_cidrs|peer_cidr|not in allowed|source ip|client ip|\bcidr\b|network range/i.test(
    message,
  );
}

export function failureFromStatus(
  status: number,
  message: string,
  headers?: Record<string, string>,
): DirectChatFailure {
  const reason = message.trim().slice(0, MAX_REASON);
  const detail = reason ? `: ${reason}` : "";
  if (status === 429 || status === 402) {
    const hint = retryAfterMs(headers);
    return {
      kind: "quota",
      message: `the model gateway refused this request (${status})${detail}`,
      status,
      ...(hint !== undefined ? { retryAfterMs: hint } : {}),
    };
  }
  if (status === 401 || status === 403) {
    if (looksLikeNetworkRange(reason)) {
      return {
        kind: "network-range",
        message: `this key is restricted to particular networks (${status})${detail}`,
        status,
      };
    }
    return {
      kind: "unauthorized",
      message: `the model gateway rejected this key (${status})${detail}`,
      status,
    };
  }
  return { kind: "gateway", message: `the model gateway failed (${status})${detail}`, status };
}

export type ControlClientOptions = {
  /** The baked model gateway origin, or null in a build without one. */
  origin: string | null;
  transport: ControlTransport;
  timeoutMs?: number;
};

export type ControlClient = {
  /** Prove a key and name its account. Never stores the key. */
  verifyKey(key: string): Promise<ControlResult<MinihRouterKeySession>>;
  /** One page of the key-scoped catalog. */
  fetchModels(
    key: string,
    input: { page: number; pageSize: number; query?: string },
  ): Promise<ControlResult<MinihRouterModelPage>>;
};

export function createControlClient(options: ControlClientOptions): ControlClient {
  const timeoutMs = options.timeoutMs ?? CONTROL_TIMEOUT_MS;

  /**
   * One GET on the configured origin.
   *
   * The URL is built from the origin and a fixed path, and the origin is checked
   * again afterwards: a service that can be talked into another origin would
   * hand the key to it.
   */
  async function get(key: string, path: string): Promise<ControlResult<unknown>> {
    const origin = options.origin;
    if (!origin) {
      return {
        ok: false,
        failure: { kind: "gateway", message: "this build has no model gateway configured" },
      };
    }
    const secret = key.trim();
    if (!secret) {
      return { ok: false, failure: { kind: "unauthorized", message: "no AccessKey is configured" } };
    }
    const url = `${origin}${path}`;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, failure: { kind: "gateway", message: "the model gateway origin is unusable" } };
    }
    if (parsed.origin !== origin) {
      return {
        ok: false,
        failure: { kind: "gateway", message: "a control-plane request left the configured origin" },
      };
    }

    let response: Awaited<ReturnType<ControlTransport>>;
    try {
      response = await options.transport({
        url,
        method: "GET",
        headers: {
          authorization: `Bearer ${secret}`,
          accept: "application/json",
        },
        disableRedirects: true,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        ok: false,
        failure: {
          kind: "transport",
          message: `the model gateway could not be reached: ${redact(message.slice(0, MAX_REASON), secret)}`,
        },
      };
    }

    // A 3xx means the platform followed or reported a redirect: either way the
    // answer did not come from the path we asked for.
    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        failure: {
          kind: "gateway",
          message: `the model gateway answered with a redirect (${response.status}), which is refused`,
          status: response.status,
        },
      };
    }

    const body = envelope(response.data);
    if (response.status < 200 || response.status >= 300 || body.code !== 0) {
      const reason = redact(body.message, secret);
      const failure =
        body.code === 0 && (response.status < 200 || response.status >= 300)
          ? failureFromStatus(response.status, reason, response.headers)
          : failureFromStatus(response.status >= 400 ? response.status : 500, reason, response.headers);
      return { ok: false, failure };
    }
    return { ok: true, value: body.data };
  }

  return {
    async verifyKey(key) {
      const result = await get(key, CONTROL_PATHS.session);
      if (!result.ok) return result;
      const session = parseMinihRouterKeySession(result.value);
      if (!session) {
        // The gateway answered 200 without naming an AccessKey: an administrator
        // principal, or a document this client must not treat as a connection.
        return {
          ok: false,
          failure: {
            kind: "unauthorized",
            message: "the model gateway did not confirm this key as an account",
          },
        };
      }
      return { ok: true, value: session };
    },

    async fetchModels(key, input) {
      const { page, pageSize } = clampMinihRouterPage(input.page, input.pageSize);
      const params = new URLSearchParams({
        group_status: "enabled",
        page: String(page),
        page_size: String(pageSize),
      });
      const query = input.query?.trim().slice(0, 200);
      if (query) params.set("q", query);
      const result = await get(key, `${CONTROL_PATHS.models}?${params}`);
      if (!result.ok) return result;
      return { ok: true, value: parseMinihRouterModelPage(result.value) };
    },
  };
}
