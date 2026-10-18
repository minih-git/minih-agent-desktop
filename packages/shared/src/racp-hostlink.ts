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
} as const;
export type RacpHostLinkSchemaName = keyof typeof RACP_HOSTLINK_HTTP_SCHEMAS;

/** Version constant re-exported so Gateway code does not import two modules. */
export const RACP_HOSTLINK_PROTOCOL_VERSION = RACP_PROTOCOL_VERSION;
export const RacpHostLinkCursorSchema = RacpCursorSchema;
export const RacpHostLinkEventKindSchema = RacpEventKindSchema;
