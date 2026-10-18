/**
 * Gateway pairing call (ADR 0331 §3.4, protocol §11.4).
 *
 * `POST /v1/hosts/{hostId}/pair` with the single-use pairing token in the
 * `Authorization` header. A browser sends `client: "web"` and receives the
 * device token as an `HttpOnly` cookie plus a CSRF token in the body; the
 * token is never written to a URL, a log, or `localStorage`.
 */

export type PairDeviceInput = {
  gatewayOrigin: string;
  hostId: string;
  pairingToken: string;
  deviceLabel: string;
  fetchImpl?: typeof fetch;
};

export type PairedDevice = {
  deviceId: string;
  hostId: string;
  roles: string[];
  csrfToken: string;
};

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

export async function pairDevice(input: PairDeviceInput): Promise<PairDeviceResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${input.gatewayOrigin}${pairingPath(input.hostId)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The pairing token travels only in the header; never in the URL.
        authorization: `Bearer ${input.pairingToken}`,
      },
      // The Gateway sets the device cookie on this response.
      credentials: "include",
      body: JSON.stringify({ deviceLabel: input.deviceLabel, client: "web" }),
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
  const deviceId = payload.deviceId;
  const hostId = payload.hostId;
  const csrfToken = payload.csrfToken;
  const roles = payload.roles;
  if (typeof deviceId !== "string" || !deviceId) {
    return { ok: false, failure: { code: "PAIRING_FAILED", message: "the pairing response named no device" } };
  }
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
  if (typeof hostId === "string" && hostId && hostId !== input.hostId) {
    return {
      ok: false,
      failure: { code: "PAIRING_FAILED", message: "the Gateway paired a different Host than requested" },
    };
  }
  return {
    ok: true,
    device: {
      deviceId,
      hostId: input.hostId,
      roles: Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [],
      csrfToken,
    },
  };
}
