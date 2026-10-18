/**
 * Gateway pairing call (ADR 0331 §3.4, protocol §11.4).
 *
 * `POST /v1/hosts/{hostId}/pair` with the single-use pairing token in the
 * `Authorization` header. A browser sends `client: "web"` and receives the
 * device token as an `HttpOnly` cookie plus a CSRF token in the body; a native
 * build sends `client: "ios" | "android"` and receives the device token itself
 * in the body, for the Keychain or the Keystore. The token is never written to
 * a URL, a log, or `localStorage`.
 */

/** The profiles the Gateway knows (`RacpPairHttpRequest.client`). */
export type PairClient = "web" | "ios" | "android";

export type PairDeviceInput = {
  gatewayOrigin: string;
  hostId: string;
  pairingToken: string;
  deviceLabel: string;
  client: PairClient;
  fetchImpl?: typeof fetch;
};

type PairedDeviceBase = {
  deviceId: string;
  hostId: string;
  roles: string[];
};

/** The cookie profile's result: the Gateway set a cookie, the body has the CSRF token. */
export type PairedBrowserDevice = PairedDeviceBase & { profile: "cookie"; csrfToken: string };

/** The native profile's result: the device token itself, for secure storage. */
export type PairedNativeDevice = PairedDeviceBase & { profile: "native"; token: string };

/**
 * A discriminated union, so a native result can never carry (or leak) a CSRF
 * token and a browser result can never carry the device token.
 */
export type PairedDevice = PairedBrowserDevice | PairedNativeDevice;

export type PairFailure = {
  code: string;
  message: string;
};

export type PairDeviceResult = { ok: true; device: PairedDevice } | { ok: false; failure: PairFailure };

export function pairingPath(hostId: string): string {
  return `/v1/hosts/${encodeURIComponent(hostId)}/pair`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The Gateway answers failures as `{ error: { code, message, data } }`. */
function failureFromPayload(status: number, payload: unknown): PairFailure {
  if (isRecord(payload)) {
    const error = payload.error;
    if (isRecord(error)) {
      const data = error.data;
      const code = isRecord(data) && typeof data.code === "string" ? data.code : undefined;
      const message = isRecord(data) && typeof data.message === "string" ? data.message : undefined;
      return {
        code: code ?? (typeof error.code === "string" ? error.code : `HTTP_${status}`),
        message: message ?? (typeof error.message === "string" ? error.message : `HTTP ${status}`),
      };
    }
  }
  return { code: `HTTP_${status}`, message: `HTTP ${status}` };
}

function pairedBase(input: PairDeviceInput, payload: Record<string, unknown>): PairedDeviceBase | PairFailure {
  const deviceId = payload.deviceId;
  const hostId = payload.hostId;
  const roles = payload.roles;
  if (typeof deviceId !== "string" || !deviceId) {
    return { code: "PAIRING_FAILED", message: "the pairing response named no device" };
  }
  if (typeof hostId === "string" && hostId && hostId !== input.hostId) {
    return { code: "PAIRING_FAILED", message: "the Gateway paired a different Host than requested" };
  }
  return {
    deviceId,
    hostId: input.hostId,
    roles: Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [],
  };
}

function isFailure(value: PairedDeviceBase | PairFailure): value is PairFailure {
  return "code" in value;
}

export async function pairDevice(input: PairDeviceInput): Promise<PairDeviceResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const native = input.client !== "web";
  let response: Response;
  try {
    response = await fetchImpl(`${input.gatewayOrigin}${pairingPath(input.hostId)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The pairing token travels only in the header; never in the URL.
        authorization: `Bearer ${input.pairingToken}`,
      },
      // The Gateway sets the device cookie on this response for the browser
      // profile; a native client must never receive or keep an ambient cookie.
      credentials: native ? "omit" : "include",
      body: JSON.stringify({ deviceLabel: input.deviceLabel, client: input.client }),
    });
  } catch (error) {
    return {
      ok: false,
      failure: {
        code: "REMOTE_CONNECTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, failure: failureFromPayload(response.status, payload) };
  if (!isRecord(payload)) {
    return { ok: false, failure: { code: "PAIRING_FAILED", message: "the pairing response was not JSON" } };
  }
  const base = pairedBase(input, payload);
  if (isFailure(base)) return { ok: false, failure: base };

  if (native) {
    const token = payload.token;
    if (typeof token !== "string" || !token) {
      // A native client must never fall back to a cookie it was not given.
      return {
        ok: false,
        failure: {
          code: "PAIRING_FAILED",
          message: "the pairing response carried no device token for the native profile",
        },
      };
    }
    return { ok: true, device: { ...base, profile: "native", token } };
  }

  const csrfToken = payload.csrfToken;
  if (typeof csrfToken !== "string" || !csrfToken) {
    // The native profiles get the token in the body instead; the browser
    // profile must never fall back to reading a token it was not given.
    return {
      ok: false,
      failure: {
        code: "PAIRING_FAILED",
        message: "the pairing response carried no CSRF token for the browser profile",
      },
    };
  }
  return { ok: true, device: { ...base, profile: "cookie", csrfToken } };
}
