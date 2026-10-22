/**
 * Host reachability probe (PR-4).
 *
 * The device cookie is scoped to `Path=/hosts/{hostId}`, so the Gateway's
 * `GET /v1/hosts` is deliberately unreachable from the H5 client and host
 * status is read from a Host-scoped route instead. `GET
 * /hosts/{hostId}/v1/sessions` is the cheapest authenticated read: 2xx means
 * online, 503 means the Host link is down, 401 means the device credential is
 * gone (revoked) and the user must pair again — except `401 HOST_UNAUTHORIZED`,
 * which means this Host has not adopted the device yet and a retry may fix it.
 */
import type { RacpSession } from "@minih-agent/shared";
import { credentialHeaders, type HostCredential } from "./credential-port.js";
export type HostStatus =
  | { kind: "online" }
  | { kind: "offline" }
  | { kind: "revoked" }
  /**
   * The Gateway knows this device, but this Host has not adopted it yet: it was
   * offline when the grant was issued, or it confirms every device with its own
   * user. Retrying, or confirming on that computer, is the next step.
   */
  | { kind: "unaccepted" }
  | { kind: "error"; code: string; message: string };

export type ProbeHostInput = {
  gatewayOrigin: string;
  hostId: string;
  credential: HostCredential;
  fetchImpl?: typeof fetch;
};

export function hostSessionsPath(hostId: string): string {
  return `/hosts/${encodeURIComponent(hostId)}/v1/sessions`;
}

/**
 * The status a failed host-scoped read already reports, so a screen that made a
 * real request does not have to probe again to ask the same question.
 *
 * The codes are the ones the Gateway sends for the three states the probe
 * distinguishes: `AGENT_UNAVAILABLE` is the Host link being down (HTTP 503),
 * `HOST_UNAUTHORIZED` is this Host not having adopted the device yet (401), and
 * `UNAUTHORIZED` is a credential that is gone (401). Anything else stays an
 * error with its own reason, exactly as `probeHostStatus` reports it.
 */
export function hostStatusFromFailure(failure: { code: string; message: string }): HostStatus {
  if (failure.code === "HOST_UNAUTHORIZED") return { kind: "unaccepted" };
  if (failure.code === "UNAUTHORIZED") return { kind: "revoked" };
  if (failure.code === "AGENT_UNAVAILABLE") return { kind: "offline" };
  return { kind: "error", code: failure.code, message: failure.message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorDetail(payload: unknown): { code?: string; message?: string } {
  if (!isRecord(payload)) return {};
  const error = payload.error;
  if (!isRecord(error)) return {};
  const data = error.data;
  return {
    ...(isRecord(data) && typeof data.code === "string" ? { code: data.code } : {}),
    ...(isRecord(data) && typeof data.message === "string"
      ? { message: data.message }
      : typeof error.message === "string"
        ? { message: error.message }
        : {}),
  };
}

function extractSessions(payload: unknown): RacpSession[] | null {
  if (!isRecord(payload)) return null;
  const result = payload.result;
  if (!isRecord(result) || !Array.isArray(result.sessions)) return null;
  return (result.sessions as RacpSession[]).filter(
    (session) => isRecord(session) && typeof session.id === "string" && (session as { archived?: unknown }).archived !== true,
  );
}

export async function probeHostWithSessions(
  input: ProbeHostInput,
): Promise<{ status: HostStatus; sessions: RacpSession[] | null }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${input.gatewayOrigin}${hostSessionsPath(input.hostId)}`, {
      method: "GET",
      headers: { accept: "application/json", ...credentialHeaders(input.credential) },
      credentials: input.credential.kind === "cookie" ? "include" : "same-origin",
    });
  } catch (error) {
    return {
      status: {
        kind: "error",
        code: "REMOTE_CONNECTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
      sessions: null,
    };
  }
  if (response.status === 401 || response.status === 403) {
    const payload: unknown = await response.json().catch(() => null);
    const detail = errorDetail(payload);
    // The Gateway accepted this device and the Host behind it did not. That is
    // a different failure from a dead credential: the token is fine, this
    // computer simply has not adopted it yet (§11.5, account mode), so the
    // client says "not synced yet" and offers a retry instead of dropping the
    // device.
    if (detail.code === "HOST_UNAUTHORIZED") return { status: { kind: "unaccepted" }, sessions: null };
    if (response.status === 401) return { status: { kind: "revoked" }, sessions: null };
    return {
      status: {
        kind: "error",
        code: detail.code ?? `HTTP_${response.status}`,
        message: detail.message ?? `HTTP ${response.status}`,
      },
      sessions: null,
    };
  }
  if (response.status === 503) return { status: { kind: "offline" }, sessions: null };
  if (response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    return { status: { kind: "online" }, sessions: extractSessions(payload) };
  }
  const payload: unknown = await response.json().catch(() => null);
  const detail = errorDetail(payload);
  return {
    status: {
      kind: "error",
      code: detail.code ?? `HTTP_${response.status}`,
      message: detail.message ?? `HTTP ${response.status}`,
    },
    sessions: null,
  };
}

export async function probeHostStatus(input: ProbeHostInput): Promise<HostStatus> {
  return (await probeHostWithSessions(input)).status;
}
