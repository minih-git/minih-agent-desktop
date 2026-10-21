import { Type, type Static } from "typebox";

import {
  RACP_PROTOCOL_VERSION,
  RacpCursorSchema,
  RacpEventKindSchema,
  type RacpCursor,
  type RacpEventEnvelope,
} from "./racp.js";

/**
 * Host link relay profile (protocol spec §11.4, D665 / ADR 0331). The Host
 * link multiplexes logical client connections onto one authenticated outbound
 * WebSocket; every frame names the logical connection it belongs to and the
 * Gateway must never rewrite `message` payloads.
 */
export const RACP_HOSTLINK_VERSION = "racp-hostlink.v1" as const;

/** Close codes the Host link layer uses for logical connections. */
export const RACP_HOSTLINK_CLOSE_CODES = {
  /** The logical connection exceeded its bounded event queue (§11.4 rule 3). */
  clientTooSlow: "CLIENT_TOO_SLOW",
  /** The client closed the logical connection. */
  clientClosed: "CLIENT_CLOSED",
  /** The Host closed the logical connection. */
  hostClosed: "HOST_CLOSED",
  /** A `clientConnectionId` was reused on the same link (security §3.3). */
  duplicateConnection: "DUPLICATE_CONNECTION",
  /** The route context failed validation (wrong Host, expired, replayed). */
  routeContextRejected: "ROUTE_CONTEXT_REJECTED",
  /** The link's own authentication failed (device or pairing credential). */
  unauthorized: "UNAUTHORIZED",
  /** The Gateway sent a frame the Host cannot interpret. */
  protocolError: "PROTOCOL_ERROR",
} as const;
export type RacpHostLinkCloseCode = (typeof RACP_HOSTLINK_CLOSE_CODES)[keyof typeof RACP_HOSTLINK_CLOSE_CODES];

/**
 * `client.open` carries the route context and the client's raw bearer
 * credential (security §3.3): the Host re-authenticates every relayed logical
 * connection with its own `DeviceTokenAuthenticator` under the connection
 * origin `"gateway"`. The credential appears in this frame only and never in
 * logs or audit records.
 */
export const RacpHostRouteContextSchema = Type.Object({
  link: Type.Literal(RACP_HOSTLINK_VERSION),
  hostId: Type.String({ minLength: 1 }),
  clientConnectionId: Type.String({ minLength: 1 }),
  issuedAt: Type.String(),
  expiresAt: Type.String(),
  /** Present on pairing connections only: the token has not been exchanged yet. */
  pairing: Type.Optional(Type.Boolean()),
});
export type RacpHostRouteContext = Static<typeof RacpHostRouteContextSchema>;

/**
 * Host capabilities on the Host link (protocol §11.4, §11.5; D666). A Host
 * sends one `host.capabilities` frame as soon as the link is up, and the
 * Gateway sends the new device frames only to a Host that advertises the
 * matching entry. This is a safety requirement, not an optimization: a Host
 * that predates these frames ignores an unknown `type` silently
 * (`HostLinkHost.handleFrame`), so a `device.request` sent to it would leave
 * the client waiting forever.
 *
 * Unknown strings are ignored by the reader, so a newer Host may advertise more
 * than an older Gateway understands.
 */
export const RACP_HOST_CAPABILITIES = {
  /** This Host has a confirmer wired up: it can be asked to approve a device. */
  deviceConfirm: "device.confirm",
  /** This Host adopts a signed grant from a sibling Host of its own account. */
  deviceAcceptSiblingGrant: "device.accept-sibling-grant",
  /**
   * This Host reports the four notification-worthy events of §11.6, so the
   * Gateway may deliver push for them. A Host that does not announce this is
   * never expected to send `host.notify`, and the Gateway sends no push on its
   * behalf (ADR 0331 decision 7).
   */
  pushNotify: "push.notify",
} as const;
export type RacpHostCapability = (typeof RACP_HOST_CAPABILITIES)[keyof typeof RACP_HOST_CAPABILITIES];

export const RacpHostCapabilitiesFrameSchema = Type.Object({
  link: Type.Literal(RACP_HOSTLINK_VERSION),
  type: Type.Literal("host.capabilities"),
  capabilities: Type.Array(Type.String({ minLength: 1 })),
});
export type RacpHostCapabilitiesFrame = Static<typeof RacpHostCapabilitiesFrameSchema>;

/**
 * A device request the Gateway fans out to the account's confirmable Hosts
 * (§11.5). `accountId` travels so a Host can refuse a request that is not for
 * its own account even if the Gateway misroutes it.
 */
export const RacpDeviceRequestSchema = Type.Object({
  requestId: Type.String({ minLength: 1 }),
  accountId: Type.String({ minLength: 1 }),
  deviceLabel: Type.String({ minLength: 1, maxLength: 128 }),
  client: Type.Union([Type.Literal("web"), Type.Literal("ios"), Type.Literal("android")]),
  requestedAt: Type.String(),
  expiresAt: Type.String(),
});
export type RacpDeviceRequest = Static<typeof RacpDeviceRequestSchema>;

export const RacpDeviceRequestFrameSchema = Type.Object({
  link: Type.Literal(RACP_HOSTLINK_VERSION),
  type: Type.Literal("device.request"),
  request: RacpDeviceRequestSchema,
});
export type RacpDeviceRequestFrame = Static<typeof RacpDeviceRequestFrameSchema>;

/**
 * The signed device grant (§11.5). The approving Host mints a gateway-origin
 * device token, keeps only its hash, and signs this payload with the private key
 * of its own Host certificate; a sibling Host of the same account verifies the
 * signature against the Gateway CA, adopts the device by `tokenHash`, and can
 * then authenticate the token the client holds. The raw token never appears
 * here: it travels only in the `deviceToken` field of the Host-to-Gateway leg.
 */
export const RacpDeviceGrantSchema = Type.Object({
  grantId: Type.String({ minLength: 1 }),
  /** The request this grant answers; a grant for an unknown request is refused. */
  requestId: Type.String({ minLength: 1 }),
  accountId: Type.String({ minLength: 1 }),
  /** The Host whose user approved; its certificate signs this payload. */
  signerHostId: Type.String({ minLength: 1 }),
  deviceId: Type.String({ minLength: 1 }),
  deviceLabel: Type.String({ minLength: 1, maxLength: 128 }),
  /** SHA-256 of the device token, lowercase hex. */
  tokenHash: Type.String({ minLength: 64, maxLength: 64 }),
  roles: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  origin: Type.Literal("gateway"),
  issuedAt: Type.String(),
  /** How long the Gateway may still deliver this grant to an offline Host. */
  deliverUntil: Type.String(),
});
export type RacpDeviceGrant = Static<typeof RacpDeviceGrantSchema>;

export const RacpDeviceGrantFrameSchema = Type.Object({
  link: Type.Literal(RACP_HOSTLINK_VERSION),
  type: Type.Literal("device.grant"),
  grant: RacpDeviceGrantSchema,
  /** base64url ECDSA P-256 / SHA-256 over `canonicalDeviceGrantPayload(grant)`. */
  signature: Type.String({ minLength: 1 }),
  /** PEM of the signer's Host certificate, so a sibling can chain it to its CA. */
  signerCertificate: Type.String({ minLength: 1 }),
  /**
   * Host to Gateway only: the raw device token, for the client that asked. The
   * Gateway MUST strip it before relaying the grant to any other Host and MUST
   * never log, audit, or store it.
   */
  deviceToken: Type.Optional(Type.String({ minLength: 1 })),
});
export type RacpDeviceGrantFrame = Static<typeof RacpDeviceGrantFrameSchema>;

/**
 * Device revocation, signed by the Host whose user revoked (§11.5). The Gateway
 * relays it to the account's other Hosts so one Host's revocation reaches them
 * all; a Host that has not adopted the device simply ignores it.
 */
export const RacpDeviceRevokeSchema = Type.Object({
  revokeId: Type.String({ minLength: 1 }),
  accountId: Type.String({ minLength: 1 }),
  signerHostId: Type.String({ minLength: 1 }),
  deviceId: Type.String({ minLength: 1 }),
  revokedAt: Type.String(),
});
export type RacpDeviceRevoke = Static<typeof RacpDeviceRevokeSchema>;

export const RacpDeviceRevokeFrameSchema = Type.Object({
  link: Type.Literal(RACP_HOSTLINK_VERSION),
  type: Type.Literal("device.revoke"),
  revoke: RacpDeviceRevokeSchema,
  signature: Type.String({ minLength: 1 }),
  signerCertificate: Type.String({ minLength: 1 }),
});
export type RacpDeviceRevokeFrame = Static<typeof RacpDeviceRevokeFrameSchema>;
/**
 * The character set an id in a notification may use (protocol §11.6).
 *
 * A length limit alone would not make "a push carries ids only" true: a Host
 * could put a sentence in `sessionId` and the Gateway would deliver it. Every id
 * this protocol puts in a notification is a UUID, a `<prefix>_<uuid>`, or a
 * decimal id, so the allowed set is exactly what those need.
 */
export const RACP_NOTIFY_ID_PATTERN = "^[A-Za-z0-9._:-]{1,128}$";
/** An id a notification may carry: bounded, and never free text. */
const notifyId = () => Type.String({ minLength: 1, maxLength: 128, pattern: RACP_NOTIFY_ID_PATTERN });
/**
 * The four events a notification may report (ADR 0331 decision 7, protocol
 * §11.6). The list is closed on purpose: a push says that one of these
 * happened, never what it contained.
 */
export const RACP_NOTIFY_KINDS = ["approval.requested", "input.requested", "turn.completed", "turn.failed"] as const;
export type RacpNotifyKind = (typeof RACP_NOTIFY_KINDS)[number];

/**
 * One notification-worthy event a Host reports on its link (protocol §11.6).
 *
 * This frame carries ids and a fixed kind, and nothing else: no prompt, no tool
 * name, no transcript, no session title. Every id is additionally restricted to
 * `RACP_NOTIFY_ID_PATTERN`, so "ids only" is a property of the frame rather than
 * a promise about how a Host behaves (ADR 0331 decision 7).
 */
export const RacpHostNotifySchema = Type.Object(
  {
    /** The Host's own id for the event; one push per notifyId. */
    notifyId: notifyId(),
    kind: Type.Union([
      Type.Literal("approval.requested"),
      Type.Literal("input.requested"),
      Type.Literal("turn.completed"),
      Type.Literal("turn.failed"),
    ]),
    sessionId: notifyId(),
    /** Present for the two request kinds; the answer the user is asked for. */
    approvalId: Type.Optional(notifyId()),
    /**
     * How many decisions this session still holds for the user, at the moment the
     * Host reported the event (§17.6.2). The Gateway copies it into the push as the
     * app badge, because only the Host knows what is still open — a number the
     * Gateway invented would be wrong within minutes.
     */
    attentionCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
    /** RFC 3339, minted by the Host; never shown to anyone. */
    occurredAt: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
export type RacpHostNotify = Static<typeof RacpHostNotifySchema>;

export const RacpHostNotifyFrameSchema = Type.Object({
  link: Type.Literal(RACP_HOSTLINK_VERSION),
  type: Type.Literal("host.notify"),
  notify: RacpHostNotifySchema,
});
export type RacpHostNotifyFrame = Static<typeof RacpHostNotifyFrameSchema>;

export const RacpHostLinkFrameSchema = Type.Union([
  Type.Object({
    link: Type.Literal(RACP_HOSTLINK_VERSION),
    type: Type.Literal("client.open"),
    clientConnectionId: Type.String({ minLength: 1 }),
    routeContext: RacpHostRouteContextSchema,
    credential: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    link: Type.Literal(RACP_HOSTLINK_VERSION),
    type: Type.Literal("client.message"),
    clientConnectionId: Type.String({ minLength: 1 }),
    message: Type.Unknown(),
  }),
  Type.Object({
    link: Type.Literal(RACP_HOSTLINK_VERSION),
    type: Type.Literal("client.close"),
    clientConnectionId: Type.String({ minLength: 1 }),
    reason: Type.String(),
  }),
  Type.Object({
    link: Type.Literal(RACP_HOSTLINK_VERSION),
    type: Type.Literal("host.message"),
    clientConnectionId: Type.String({ minLength: 1 }),
    message: Type.Unknown(),
  }),
  Type.Object({
    link: Type.Literal(RACP_HOSTLINK_VERSION),
    type: Type.Literal("host.close"),
    clientConnectionId: Type.String({ minLength: 1 }),
    code: Type.String(),
  }),
  Type.Object({
    link: Type.Literal(RACP_HOSTLINK_VERSION),
    type: Type.Literal("attachment.chunk"),
    uploadId: Type.String({ minLength: 1 }),
    offset: Type.Integer({ minimum: 0 }),
    last: Type.Boolean(),
  }),
  Type.Object({
    link: Type.Literal(RACP_HOSTLINK_VERSION),
    type: Type.Union([Type.Literal("link.ping"), Type.Literal("link.pong")]),
  }),
  // ---- Account-mode device directory (D666, package D) --------------------
  // Sent only to a Host that advertises the matching `RACP_HOST_CAPABILITIES`
  // entry, because an older Host drops an unknown `type` silently.
  RacpHostCapabilitiesFrameSchema,
  RacpDeviceRequestFrameSchema,
  RacpDeviceGrantFrameSchema,
  RacpDeviceRevokeFrameSchema,
  // ---- Redacted push (§11.6, R5 PR-6) ------------------------------------
  // Host to Gateway only, and only from a Host that advertises `push.notify`.
  RacpHostNotifyFrameSchema,
]);
export type RacpHostLinkFrame = Static<typeof RacpHostLinkFrameSchema>;
export type RacpHostLinkFrameType = RacpHostLinkFrame["type"];

/** Structural rule JSON Schema cannot express: route context must name the same link. */
export function hostLinkRouteContextIsValid(context: RacpHostRouteContext): boolean {
  return context.link === RACP_HOSTLINK_VERSION;
}

/** Parse one text frame as a Host link frame; returns null for garbage. */
export function parseHostLinkFrame(text: string): RacpHostLinkFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  return isHostLinkFrame(value) ? value : null;
}

/** Structural (non-schema) check: a frame must name the Host link protocol version. */
export function isHostLinkFrame(value: unknown): value is RacpHostLinkFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { link?: unknown }).link === RACP_HOSTLINK_VERSION &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

// ---------------------------------------------------------------------------
// Enrollment (Host to Gateway, one-time code exchange; ADR 0331)
// ---------------------------------------------------------------------------

/**
 * Enrollment request (protocol §11.4, §11.5). Exactly one credential is
 * accepted, and the Gateway enforces that rule structurally because JSON Schema
 * cannot: either the one-time `enrollmentCode` of the self-hosted flow, or a
 * Router AccessKey presented as `Authorization: Bearer <AccessKey>` with the
 * field absent (account mode, D666). `hostId` and `csr` are required either way.
 */
export const RacpEnrollRequestSchema = Type.Object({
  /** Self-hosted flow only: the one-time code printed by the Gateway. */
  enrollmentCode: Type.Optional(Type.String({ minLength: 1 })),
  hostId: Type.String({ minLength: 1 }),
  /** PEM-encoded PKCS#10 CSR generated locally by the Host. */
  csr: Type.String({ minLength: 1 }),
  /**
   * Host-chosen label. The self-hosted flow ignores it and uses the operator's
   * `enroll-code --label`, so it carries no bound here; the Gateway bounds it in
   * the account-mode path, which is the only path that persists it.
   */
  label: Type.Optional(Type.String()),
});
export type RacpEnrollRequest = Static<typeof RacpEnrollRequestSchema>;

export const RacpEnrollResponseSchema = Type.Object({
  /** PEM-encoded client certificate with `hostId` as CN, one-year validity. */
  certificate: Type.String({ minLength: 1 }),
  /** PEM chain the Host should trust alongside its pinned Gateway CA. */
  caCertificate: Type.String({ minLength: 1 }),
  expiresAt: Type.String(),
});
export type RacpEnrollResponse = Static<typeof RacpEnrollResponseSchema>;

export const RacpEnrollErrorCodeSchema = Type.Union([
  Type.Literal("ENROLLMENT_CODE_INVALID"),
  Type.Literal("ENROLLMENT_CODE_EXPIRED"),
  Type.Literal("ENROLLMENT_CODE_USED"),
  Type.Literal("CSR_INVALID"),
  Type.Literal("HOST_REVOKED"),
  /** Account mode: the presented AccessKey did not verify (D666, gate 30). */
  Type.Literal("ACCESS_KEY_INVALID"),
  /** Account mode: the Router could not be reached; retriable (D666). */
  Type.Literal("ACCESS_KEY_UNAVAILABLE"),
  /** Account mode: the `hostId` is enrolled under another account (gate 29). */
  Type.Literal("HOST_ACCOUNT_MISMATCH"),
  /** The caller exceeded the credential-attempt rate limit (security §9). */
  Type.Literal("RATE_LIMITED"),
]);
export type RacpEnrollErrorCode = Static<typeof RacpEnrollErrorCodeSchema>;

// ---------------------------------------------------------------------------
// Client HTTP contract (RACP-HTTP, protocol spec §11.2; binds with R4, D665)
// ---------------------------------------------------------------------------

/**
 * RACP-HTTP route table (spec §11.2) including the Gateway-only pair endpoint
 * of ADR 0331. Operation families map onto REST paths; turn verbs and the
 * pairing call use the `:verb` pseudo-method form.
 */
export const RACP_HTTP_ROUTE_LIST = {
  capabilities: "GET /v1/capabilities",
  hosts: "GET /v1/hosts",
  pairDevice: "POST /v1/hosts/{hostId}/pair",
  projects: "GET /v1/projects",
  /** The model catalog a controller may start a session on (R7, protocol §16.1). */
  models: "GET /v1/models",
  /**
   * Register one directory as a project (rollout A2). The path travels in the
   * body, not the URL: it is user data, and a body keeps it out of request logs
   * and browser history.
   */
  registerProject: "POST /v1/projects",
  /**
   * Walk directories for the remote folder picker (rollout A2). `path` is the
   * only query parameter; omitting it means the Host's browse root.
   */
  browseProjects: "GET /v1/projects:browse",
  sessions: "GET /v1/sessions",
  createSession: "POST /v1/sessions",
  getSession: "GET /v1/sessions/{sessionId}",
  attachSession: "POST /v1/sessions/{sessionId}:attach",
  sessionHistory: "GET /v1/sessions/{sessionId}/history",
  startTurn: "POST /v1/sessions/{sessionId}/turns",
  getTurn: "GET /v1/turns/{turnId}",
  stopTurn: "POST /v1/turns/{turnId}:stop",
  interruptTurn: "POST /v1/turns/{turnId}:interrupt",
  cancelTurn: "POST /v1/turns/{turnId}:cancel",
  prioritizeTurn: "POST /v1/turns/{turnId}:prioritize",
  sessionEvents: "GET /v1/sessions/{sessionId}/events",
  hostEvents: "GET /v1/events",
  respondApproval: "POST /v1/approvals/{approvalId}:respond",
  respondInput: "POST /v1/inputs/{inputId}:respond",
} as const;
export type RacpHttpRouteName = keyof typeof RACP_HTTP_ROUTE_LIST;

/**
 * RACP method to route-name mapping, kept beside the route table so the HTTP
 * client derives method and path from one source (spec §11.2). Operations
 * without an HTTP mapping must not silently fall through to a made-up path.
 * `events/subscribe` is deliberately absent: an event stream is only ever
 * opened through the SSE `stream()`, never as a JSON command.
 */
export const RACP_METHOD_HTTP_ROUTES: Partial<Record<string, RacpHttpRouteName>> = {
  "host/list": "hosts",
  "project/list": "projects",
  "model/list": "models",
  "project/register": "registerProject",
  "project/browse": "browseProjects",
  "session/list": "sessions",
  "session/create": "createSession",
  "session/get": "getSession",
  "session/attach": "attachSession",
  "session/history": "sessionHistory",
  "turn/start": "startTurn",
  "turn/get": "getTurn",
  "turn/stop": "stopTurn",
  "turn/interrupt": "interruptTurn",
  "turn/cancel": "cancelTurn",
  "turn/prioritize": "prioritizeTurn",
  "approval/respond": "respondApproval",
  "input/respond": "respondInput",
};

/** The path parameter each route requires, in order. */
export const RACP_HTTP_ROUTE_PARAMS: Record<RacpHttpRouteName, readonly string[]> = {
  capabilities: [],
  hosts: [],
  pairDevice: ["hostId"],
  projects: [],
  models: [],
  registerProject: [],
  browseProjects: [],
  sessions: [],
  createSession: [],
  getSession: ["sessionId"],
  attachSession: ["sessionId"],
  sessionHistory: ["sessionId"],
  startTurn: ["sessionId"],
  getTurn: ["turnId"],
  stopTurn: ["turnId"],
  interruptTurn: ["turnId"],
  cancelTurn: ["turnId"],
  prioritizeTurn: ["turnId"],
  sessionEvents: ["sessionId"],
  hostEvents: [],
  respondApproval: ["approvalId"],
  respondInput: ["inputId"],
};

/**
 * How a query-string value is represented for a GET route (spec §11.2).
 * `integer` is a signed decimal literal, `boolean` is exactly `true`/`false`.
 */
export type RacpHttpQueryParamType = "string" | "integer" | "boolean";

/**
 * The non-path parameters a GET route carries in its query string. The types
 * mirror the operation schemas in `packages/racp/src/operations.ts`; every
 * route is listed so a key that is missing here is a caller error rather than
 * a silently dropped parameter (spec §11.2).
 */
export const RACP_HTTP_QUERY_PARAMS: Record<RacpHttpRouteName, Readonly<Record<string, RacpHttpQueryParamType>>> = {
  capabilities: {},
  hosts: {},
  pairDevice: {},
  projects: {},
  // `model/list` takes no parameter: the catalog is small and static per Host.
  models: {},
  // The registration path travels in the POST body, so no query parameter.
  registerProject: {},
  // `browse(path?)`: the directory to list, absolute and inside the root.
  browseProjects: { path: "string" },
  sessions: {},
  createSession: {},
  getSession: {},
  attachSession: {},
  // `HistoryParams`: beforeItemId is a string cursor, limit a positive integer.
  sessionHistory: { beforeItemId: "string", limit: "integer" },
  startTurn: {},
  getTurn: {},
  stopTurn: {},
  interruptTurn: {},
  cancelTurn: {},
  prioritizeTurn: {},
  // Event streams carry their cursor in `Last-Event-ID`, never in the URL.
  sessionEvents: {},
  hostEvents: {},
  respondApproval: {},
  respondInput: {},
};

/** Header names the RACP HTTP binding uses, lowercase. */
export const RACP_HTTP_HEADERS = {
  /** Bearer token, header profile. */
  authorization: "authorization",
  /** JSON command bodies. */
  contentType: "content-type",
  /** Which client is speaking; every command and stream carries it. */
  client: "x-minih-racp-client",
  /** Cookie profile: double-submit token on mutations. */
  csrf: "x-csrf-token",
  /** Stream resume cursor (protocol §11.2). */
  cursor: "last-event-id",
  /** Per-request trace id the client reads off failures. */
  trace: "x-trace-id",
} as const;

/**
 * Request headers a browser must clear on preflight for a cross-origin RACP
 * request, in one place.
 *
 * The client decides what it sends and the Gateway decides what it allows; a
 * header added on one side alone fails only on a phone, because the web build is
 * same-origin and the Node smoke tests are not browsers. Both sides read this
 * list, so the two cannot drift.
 */
export const RACP_HTTP_CORS_ALLOW_HEADERS = [
  RACP_HTTP_HEADERS.authorization,
  RACP_HTTP_HEADERS.contentType,
  RACP_HTTP_HEADERS.client,
  RACP_HTTP_HEADERS.csrf,
  RACP_HTTP_HEADERS.cursor,
] as const;

/** Response headers a cross-origin client may read (failures carry the trace id). */
export const RACP_HTTP_CORS_EXPOSE_HEADERS = [RACP_HTTP_HEADERS.trace] as const;

/** SSE event format on the stream endpoints (spec §11.2). */
export const RACP_HTTP_SSE_EVENT = "racp.event" as const;

/** Serialize one durable or ephemeral envelope as an SSE event. */
export function formatSseEvent(envelope: RacpEventEnvelope): string {
  const data = JSON.stringify(envelope);
  return `id: ${formatSseCursor(envelope)}\nevent: ${RACP_HTTP_SSE_EVENT}\ndata: ${data}\n\n`;
}

function formatSseCursor(envelope: RacpEventEnvelope): string {
  const sequence = envelope.sequence ?? envelope.afterSequence ?? 0;
  return `${envelope.epoch}:${sequence}`;
}

/** Parse an SSE `id:` line back into a cursor (spec §11.2, `Last-Event-ID`). */
export function parseSseLastEventId(value: string): RacpCursor | null {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const epoch = value.slice(0, separator);
  const sequenceText = value.slice(separator + 1);
  if (!/^\d+$/.test(sequenceText)) return null;
  return { epoch, sequence: Number(sequenceText) };
}

/**
 * HTTP status mapping for RACP error codes (spec §11.2, §13). Every shipped
 * binding must preserve error meaning; the semantic payload stays identical.
 */
export const RACP_HTTP_STATUS_BY_CODE = {
  UNAUTHORIZED: 401,
  // The Host refused the credential the Gateway accepted: still "not
  // authorized", but a different cause with a different next step.
  HOST_UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_FOUND: 405,
  PROTOCOL_MISMATCH: 400,
  INVALID_ARGUMENT: 400,
  AGENT_UNAVAILABLE: 503,
  AGENT_BUSY: 409,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  CURSOR_EXPIRED: 410,
  CLIENT_TOO_SLOW: 429,
  APPROVAL_EXPIRED: 410,
  APPROVAL_STALE: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  PAIRING_FAILED: 400,
  PAIRING_TOKEN_EXPIRED: 400,
  CAPABILITY_UNAVAILABLE: 501,
  REMOTE_PATH_NOT_FOUND: 404,
  REMOTE_PATH_FORBIDDEN: 403,
  INTERNAL: 500,
} as const satisfies Record<string, number>;
export type RacpErrorCodeForHttp = keyof typeof RACP_HTTP_STATUS_BY_CODE;

export function httpStatusForRacpError(code: string): number {
  return RACP_HTTP_STATUS_BY_CODE[code as RacpErrorCodeForHttp] ?? 500;
}

/**
 * Gateway pairing request/response (ADR 0331). The pairing token itself
 * travels only in the `Authorization` header; the response delivers the
 * device token as an `HttpOnly` cookie (browser) or in the body (native),
 * never in a URL.
 */
export const RacpPairHttpRequestSchema = Type.Object({
  deviceLabel: Type.String({ minLength: 1, maxLength: 128 }),
  client: Type.Union([Type.Literal("web"), Type.Literal("ios"), Type.Literal("android")]),
});
export type RacpPairHttpRequest = Static<typeof RacpPairHttpRequestSchema>;

export const RacpPairHttpResponseSchema = Type.Object({
  deviceId: Type.String({ minLength: 1 }),
  hostId: Type.String({ minLength: 1 }),
  roles: Type.Array(Type.String(), { minItems: 1 }),
  /**
   * The computer's own name, as its owner registered it. Additive and optional:
   * a Gateway that predates it simply omits it, and the client then shows the
   * host id rather than inventing a name.
   */
  hostLabel: Type.Optional(Type.String({ maxLength: 128 })),
  /**
   * Present for native clients only: the token to store in the Keychain /
   * Keystore. Browsers receive it as an `HttpOnly; Secure; SameSite=Strict`
   * cookie and must never read it from the body.
   */
  token: Type.Optional(Type.String({ minLength: 1 })),
  csrfToken: Type.Optional(Type.String({ minLength: 1 })),
});
export type RacpPairHttpResponse = Static<typeof RacpPairHttpResponseSchema>;

export const RacpGatewayHostSummarySchema = Type.Object({
  hostId: Type.String({ minLength: 1 }),
  label: Type.String(),
  online: Type.Boolean(),
  /** Cursor resume anchor of the Host link itself, when connected. */
  lastSeenAt: Type.Optional(Type.String()),
});
export type RacpGatewayHostSummary = Static<typeof RacpGatewayHostSummarySchema>;

// ---------------------------------------------------------------------------
// Account mode (Gateway account directory; protocol §11.5, D666)
// ---------------------------------------------------------------------------

/**
 * Gateway account routes (protocol §11.2 Gateway mapping, §11.5). They live in
 * their own namespace so `GET /v1/hosts` and every `/hosts/{hostId}/...` route
 * keep accepting device tokens only: an account session authorizes the account
 * directory, never a relayed Host operation.
 */
export const RACP_ACCOUNT_ROUTES = {
  login: "POST /v1/account/login",
  hosts: "GET /v1/account/hosts",
} as const;

/**
 * Account login. The Router AccessKey travels only in the `Authorization`
 * header; the body says which credential profile the client wants, exactly like
 * the pairing route. The Gateway never stores the key and never echoes it.
 */
export const RacpAccountLoginRequestSchema = Type.Object({
  client: Type.Union([Type.Literal("web"), Type.Literal("ios"), Type.Literal("android")]),
  label: Type.Optional(Type.String({ maxLength: 128 })),
});
export type RacpAccountLoginRequest = Static<typeof RacpAccountLoginRequestSchema>;

/**
 * Account login response. The account id is the Router `access_key_id`, which is
 * the account identity (ADR decision 4); the session credential is the
 * `rat1.`-prefixed bearer value. A browser receives it as an `HttpOnly` cookie
 * plus a CSRF cookie and must never read it from the body.
 */
export const RacpAccountLoginResponseSchema = Type.Object({
  accountId: Type.String({ minLength: 1 }),
  /** Router `key_name`, shown in the client so a user can tell keys apart. */
  keyName: Type.Optional(Type.String()),
  /** ISO-8601 end of the session credential's bounded lifetime. */
  expiresAt: Type.String(),
  token: Type.Optional(Type.String({ minLength: 1 })),
  csrfToken: Type.Optional(Type.String({ minLength: 1 })),
});
export type RacpAccountLoginResponse = Static<typeof RacpAccountLoginResponseSchema>;

/**
 * One Host of the caller's own account. It is deliberately the same shape as
 * `RacpGatewayHostSummary`, so a client renders the account list and the device
 * list identically; only the authorization path differs.
 */
export const RacpAccountHostSummarySchema = RacpGatewayHostSummarySchema;
export type RacpAccountHostSummary = RacpGatewayHostSummary;

export const RacpAccountHostListResponseSchema = Type.Object({
  accountId: Type.String({ minLength: 1 }),
  hosts: Type.Array(RacpAccountHostSummarySchema),
});
export type RacpAccountHostListResponse = Static<typeof RacpAccountHostListResponseSchema>;

// ---------------------------------------------------------------------------
// Redacted push (protocol §11.6, R5 PR-6, ADR 0331 decision 7)
// ---------------------------------------------------------------------------

/** The two provider families a client can register a push token with. */
export const RACP_PUSH_PLATFORMS = ["ios", "android"] as const;
export type RacpPushPlatform = (typeof RACP_PUSH_PLATFORMS)[number];

/**
 * `PUT /v1/push/registration`: "deliver push for my device to this provider
 * token". The token is a provider secret: it is stored, never echoed back, and
 * never logged.
 *
 * The payload shape of the *notification* is not chosen by the client — it is
 * fixed by §11.6 and carries a localization key plus ids only.
 */
export const RacpPushRegistrationRequestSchema = Type.Object({
  platform: Type.Union([Type.Literal("ios"), Type.Literal("android")]),
  /**
   * The provider token (APNs device token, FCM registration token). Bounded so
   * a client cannot use this route as storage.
   */
  token: Type.String({ minLength: 1, maxLength: 4096 }),
  /** Optional app/bundle id, so one deployment can serve more than one build. */
  appId: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
});
export type RacpPushRegistrationRequest = Static<typeof RacpPushRegistrationRequestSchema>;

/**
 * The registration answer. `hostIds` is what this registration now covers: one
 * Host for a §11.4 device, every Host of the account for an account-mode device
 * (§11.5). `enabled` is false when the operator configured no provider, in
 * which case the Gateway stores nothing (push is off, and the client can stop
 * asking).
 */
export const RacpPushRegistrationResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  platform: Type.Union([Type.Literal("ios"), Type.Literal("android")]),
  hostIds: Type.Array(Type.String({ minLength: 1 })),
});
export type RacpPushRegistrationResponse = Static<typeof RacpPushRegistrationResponseSchema>;

/**
 * The notification payload, in full. This is the whole contract of a push: a
 * fixed `kind`, the client-side localization key for its title and body, and
 * the ids needed to open the right screen. There is no field for a prompt, a
 * tool, a path, a transcript, or a session title, and the Gateway never copies
 * one in — `additionalProperties: false` plus `RACP_NOTIFY_ID_PATTERN` keep that
 * checkable rather than aspirational.
 */
export const RacpPushPayloadSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("approval.requested"),
      Type.Literal("input.requested"),
      Type.Literal("turn.completed"),
      Type.Literal("turn.failed"),
    ]),
    /** Always `push.notify.<kind>.title` / `.body` in the client's catalog. */
    titleKey: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._-]+$" }),
    bodyKey: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._-]+$" }),
    hostId: notifyId(),
    sessionId: notifyId(),
    approvalId: Type.Optional(notifyId()),
    /** Copied from the Host's `host.notify`; becomes `aps.badge`. */
    attentionCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
    notifyId: notifyId(),
  },
  { additionalProperties: false },
);
export type RacpPushPayload = Static<typeof RacpPushPayloadSchema>;

/** The localization keys a payload may name, one pair per kind (§11.6). */
export function pushKeysForKind(kind: RacpNotifyKind): { titleKey: string; bodyKey: string } {
  return { titleKey: `push.notify.${kind}.title`, bodyKey: `push.notify.${kind}.body` };
}

/**
 * The Android resource name of a localization key (§11.6).
 *
 * Android resource names are `[a-z0-9_]`, so the dotted key the payload carries
 * becomes `push_notify_<kind>_<field>` in `strings.xml`. The mapping lives here
 * because the generator that writes that file and the app that resolves a name at
 * runtime must agree on it. The Gateway no longer sends the resource form itself:
 * Android notifications are built by the app from a data-only message (§17.6.6).
 */
export function androidResourceKey(key: string): string {
  return key.replace(/[.-]/g, "_");
}

/** Named schemas that join the generated JSON Schema fixture bundle. */
export const RACP_HOSTLINK_HTTP_SCHEMAS = {
  HostRouteContext: RacpHostRouteContextSchema,
  HostLinkFrame: RacpHostLinkFrameSchema,
  EnrollRequest: RacpEnrollRequestSchema,
  EnrollResponse: RacpEnrollResponseSchema,
  PairHttpRequest: RacpPairHttpRequestSchema,
  PairHttpResponse: RacpPairHttpResponseSchema,
  GatewayHostSummary: RacpGatewayHostSummarySchema,
  AccountLoginRequest: RacpAccountLoginRequestSchema,
  AccountLoginResponse: RacpAccountLoginResponseSchema,
  AccountHostListResponse: RacpAccountHostListResponseSchema,
  PushRegistrationRequest: RacpPushRegistrationRequestSchema,
  PushRegistrationResponse: RacpPushRegistrationResponseSchema,
  PushPayload: RacpPushPayloadSchema,
} as const;
export type RacpHostLinkSchemaName = keyof typeof RACP_HOSTLINK_HTTP_SCHEMAS;

/** Version constant re-exported so Gateway code does not import two modules. */
export const RACP_HOSTLINK_PROTOCOL_VERSION = RACP_PROTOCOL_VERSION;
export const RacpHostLinkCursorSchema = RacpCursorSchema;
export const RacpHostLinkEventKindSchema = RacpEventKindSchema;
