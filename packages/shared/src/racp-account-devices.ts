/**
 * Account-mode device directory contracts (protocol §11.5, D666 / rollout R7
 * package D).
 *
 * The frame shapes live in `racp-hostlink.ts` next to the Host link union; this
 * module holds the two things that are not frames: the exact bytes a Host signs
 * for a grant or a revocation, and the Gateway's client-facing device routes.
 */
import { Type, type Static } from "typebox";

import type { RacpDeviceGrant, RacpDeviceRevoke } from "./racp-hostlink.js";

/**
 * A stable JSON encoding: object keys sorted, `undefined` dropped, no
 * whitespace, numbers and strings encoded by `JSON.stringify`.
 *
 * Both sides of the link must hash identical bytes for identical values, and the
 * signing payloads below project every field explicitly rather than
 * canonicalizing a received object, so a peer that adds a field later cannot
 * invalidate an existing signature and no field can be swapped silently.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON cannot carry a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new Error("canonical JSON cannot carry this value");
}

/** The signed payload of one device grant. */
export function deviceGrantSigningPayload(grant: RacpDeviceGrant): string {
  return canonicalJson({
    grantId: grant.grantId,
    requestId: grant.requestId,
    accountId: grant.accountId,
    signerHostId: grant.signerHostId,
    deviceId: grant.deviceId,
    deviceLabel: grant.deviceLabel,
    tokenHash: grant.tokenHash,
    roles: [...grant.roles],
    origin: grant.origin,
    issuedAt: grant.issuedAt,
    deliverUntil: grant.deliverUntil,
  });
}

/** The signed payload of one device revocation. */
export function deviceRevokeSigningPayload(revoke: RacpDeviceRevoke): string {
  return canonicalJson({
    revokeId: revoke.revokeId,
    accountId: revoke.accountId,
    signerHostId: revoke.signerHostId,
    deviceId: revoke.deviceId,
    revokedAt: revoke.revokedAt,
  });
}

/**
 * The account device routes. Like the account login routes they take the account
 * session credential, never a device token, and they live in their own namespace
 * so no host-scoped route changes meaning.
 */
export const RACP_ACCOUNT_DEVICE_ROUTES = {
  request: "POST /v1/account/devices",
  status: "GET /v1/account/devices/{requestId}",
} as const;

/** `POST /v1/account/devices`: ask the account's Hosts to approve a new device. */
export const RacpDeviceRequestHttpRequestSchema = Type.Object({
  deviceLabel: Type.String({ minLength: 1, maxLength: 128 }),
  client: Type.Union([Type.Literal("web"), Type.Literal("ios"), Type.Literal("android")]),
});
export type RacpDeviceRequestHttpRequest = Static<typeof RacpDeviceRequestHttpRequestSchema>;

/**
 * One Host of the caller's own account, as the device flow reports it. A Host
 * that cannot confirm is named immediately with `canConfirm: false` rather than
 * left to time out (security gate 33); `willAcceptGrant` says whether it would
 * adopt the resulting token.
 */
export const RacpAccountDeviceHostSchema = Type.Object({
  hostId: Type.String({ minLength: 1 }),
  label: Type.String(),
  online: Type.Boolean(),
  /** Online and advertising `device.confirm`. */
  canConfirm: Type.Boolean(),
  /** Online and advertising `device.accept-sibling-grant` (false in strict mode). */
  willAcceptGrant: Type.Boolean(),
});
export type RacpAccountDeviceHost = Static<typeof RacpAccountDeviceHostSchema>;

export const RacpDeviceRequestHttpResponseSchema = Type.Object({
  requestId: Type.String({ minLength: 1 }),
  expiresAt: Type.String(),
  hosts: Type.Array(RacpAccountDeviceHostSchema),
});
export type RacpDeviceRequestHttpResponse = Static<typeof RacpDeviceRequestHttpResponseSchema>;

/**
 * `GET /v1/account/devices/{requestId}`. `pending` until a Host approves or the
 * request expires; `granted` carries the device token exactly as the approving
 * Host minted it, which the client stores and presents to every Host of the
 * account. A denial has no status of its own: a Host that declines says nothing
 * on the link, so the request stays `pending` until `expiresAt` and the client's
 * own deadline ends the wait. `hosts[].canConfirm` is what tells the client up
 * front which Hosts could have answered at all (security gate 33).
 *
 * The request belongs to the account session that created it: another session
 * of the same account gets the same `NOT_FOUND` an unknown id produces, because
 * the request id travels to every Host and through the Gateway's logs. The token
 * is handed over once — the first read that returns `granted` consumes it, with
 * a short pickup window so a retried HTTP request still succeeds — and
 * `tokenDelivered` then says whether this response carried it. A client that
 * lost the token starts a new request instead of polling for it again.
 */
export const RacpDeviceStatusHttpResponseSchema = Type.Object({
  requestId: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("granted"), Type.Literal("expired")]),
  expiresAt: Type.String(),
  hosts: Type.Array(RacpAccountDeviceHostSchema),
  deviceId: Type.Optional(Type.String({ minLength: 1 })),
  /** The device token, delivered once a Host approves; never stored by the Gateway. */
  token: Type.Optional(Type.String({ minLength: 1 })),
  /** Whether this response carried the token; false once it has been taken. */
  tokenDelivered: Type.Optional(Type.Boolean()),
  /**
   * Browser profile only: the CSRF value for each Host of the account, keyed by
   * `hostId`. The device token itself travels as an `HttpOnly` cookie scoped to
   * `Path=/hosts/{hostId}` — one per Host of the account — so a browser never
   * reads the token, and it needs this value to send the `x-csrf-token` header
   * on every mutation to that Host. A native client receives `token` instead.
   */
  csrfTokens: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 }))),
  roles: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  /** The Host whose user approved, for the client's "new device" notice. */
  signerHostId: Type.Optional(Type.String({ minLength: 1 })),
});
export type RacpDeviceStatusHttpResponse = Static<typeof RacpDeviceStatusHttpResponseSchema>;

/** Named schemas that join the generated JSON Schema fixture bundle. */
export const RACP_ACCOUNT_DEVICE_SCHEMAS = {
  DeviceRequestHttpRequest: RacpDeviceRequestHttpRequestSchema,
  DeviceRequestHttpResponse: RacpDeviceRequestHttpResponseSchema,
  DeviceStatusHttpResponse: RacpDeviceStatusHttpResponseSchema,
} as const;

/**
 * Whether a Host's advertised capability list contains `capability`. Unknown
 * strings are ignored by the reader, so a newer Host may advertise more than an
 * older Gateway understands.
 */
export function hostAdvertisesCapability(capabilities: readonly string[], capability: string): boolean {
  return capabilities.includes(capability);
}
