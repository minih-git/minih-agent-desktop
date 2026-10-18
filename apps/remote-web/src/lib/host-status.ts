/**
 * Host reachability probe (PR-4).
 *
 * The device cookie is scoped to `Path=/hosts/{hostId}`, so the Gateway's
 * `GET /v1/hosts` is deliberately unreachable from the H5 client and host
 * status is read from a Host-scoped route instead. `GET
 * /hosts/{hostId}/v1/sessions` is the cheapest authenticated read: 2xx means
 * online, 503 means the Host link is down, 401 means the device credential is
 * gone (revoked) and the user must pair again.
 */
import { credentialHeaders, type HostCredential } from "./credential-port.js";

export type HostStatus =
  | { kind: "online" }
  | { kind: "offline" }
  | { kind: "revoked" }
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

export async function probeHostStatus(input: ProbeHostInput): Promise<HostStatus> {
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
      kind: "error",
      code: "REMOTE_CONNECTION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (response.status === 401) return { kind: "revoked" };
  if (response.status === 503) return { kind: "offline" };
  if (response.ok) return { kind: "online" };
  const payload: unknown = await response.json().catch(() => null);
  const detail = errorDetail(payload);
  return {
    kind: "error",
    code: detail.code ?? `HTTP_${response.status}`,
    message: detail.message ?? `HTTP ${response.status}`,
  };
}
