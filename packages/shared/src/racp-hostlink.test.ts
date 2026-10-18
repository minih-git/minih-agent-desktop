import Type from "typebox";
import { describe, expect, it } from "vitest";
import * as Value from "typebox/value";

import {
  RACP_ACCOUNT_ROUTES,
  RACP_HOSTLINK_CLOSE_CODES,
  RACP_HOSTLINK_VERSION,
  RACP_HTTP_QUERY_PARAMS,
  RACP_HTTP_ROUTE_LIST,
  RACP_HOSTLINK_HTTP_SCHEMAS,
  RacpAccountHostListResponseSchema,
  RacpAccountHostSummarySchema,
  RacpAccountLoginRequestSchema,
  RacpAccountLoginResponseSchema,
  RacpHostLinkFrameSchema,
  RacpHostRouteContextSchema,
  RacpPairHttpRequestSchema,
  RacpPairHttpResponseSchema,
  RacpGatewayHostSummarySchema,
  RacpEnrollErrorCodeSchema,
  RacpEnrollRequestSchema,
  RacpEnrollResponseSchema,
  formatSseEvent,
  httpStatusForRacpError,
  hostLinkRouteContextIsValid,
  parseHostLinkFrame,
  parseSseLastEventId,
  type RacpHostRouteContext,
} from "./racp-hostlink.js";
import type { RacpEventEnvelope } from "./racp.js";

/**
 * The operation parameters `session/history` accepts, mirroring `HistoryParams`
 * in `packages/racp/src/operations.ts` (this package must not depend on racp).
 */
const HistoryParamsShape = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  beforeItemId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

const routeContext: RacpHostRouteContext = {
  link: RACP_HOSTLINK_VERSION,
  hostId: "host_abc",
  clientConnectionId: "cc_1",
  issuedAt: "2026-10-17T00:00:00.000Z",
  expiresAt: "2026-10-17T00:05:00.000Z",
};

describe("host link frames", () => {
  it("accepts a client.open frame with a credential and route context", () => {
    const frame = {
      link: RACP_HOSTLINK_VERSION,
      type: "client.open",
      clientConnectionId: "cc_1",
      routeContext,
      credential: "pdt1_test_fixture_token",
    };
    expect(Value.Check(RacpHostLinkFrameSchema, frame)).toBe(true);
  });

  it("rejects client.open without a credential (spec §11.4, D665)", () => {
    const frame = { link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_1", routeContext };
    expect(Value.Check(RacpHostLinkFrameSchema, frame)).toBe(false);
  });

  it("rejects a frame naming another link protocol", () => {
    const frame = { link: "other-link.v9", type: "client.message", clientConnectionId: "cc_1", message: {} };
    expect(Value.Check(RacpHostLinkFrameSchema, frame)).toBe(false);
  });

  it("rejects a route context for another link version", () => {
    expect(hostLinkRouteContextIsValid(routeContext)).toBe(true);
    expect(hostLinkRouteContextIsValid({ ...routeContext, link: "other-link.v9" as never })).toBe(false);
  });

  it("round-trips every frame type through parseHostLinkFrame", () => {
    const frames = [
      { link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_1", routeContext, credential: "ppt1_x" },
      { link: RACP_HOSTLINK_VERSION, type: "client.message", clientConnectionId: "cc_1", message: { jsonrpc: "2.0", id: 1, method: "connection/initialize" } },
      { link: RACP_HOSTLINK_VERSION, type: "client.close", clientConnectionId: "cc_1", reason: "user left" },
      { link: RACP_HOSTLINK_VERSION, type: "host.message", clientConnectionId: "cc_1", message: { jsonrpc: "2.0", id: 1, result: {} } },
      { link: RACP_HOSTLINK_VERSION, type: "host.close", clientConnectionId: "cc_1", code: RACP_HOSTLINK_CLOSE_CODES.clientTooSlow },
      { link: RACP_HOSTLINK_VERSION, type: "attachment.chunk", uploadId: "up_1", offset: 0, last: false },
      { link: RACP_HOSTLINK_VERSION, type: "link.ping" },
    ];
    for (const frame of frames) {
      const parsed = parseHostLinkFrame(JSON.stringify(frame));
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe(frame.type);
    }
    expect(parseHostLinkFrame("not json")).toBeNull();
    expect(parseHostLinkFrame(JSON.stringify({ hello: 1 }))).toBeNull();
  });

  it("keeps CLIENT_TOO_SLOW as the slow-client close code (rule 3)", () => {
    expect(RACP_HOSTLINK_CLOSE_CODES.clientTooSlow).toBe("CLIENT_TOO_SLOW");
  });
});

describe("enrollment contracts", () => {
  it("accepts a CSR exchange round trip", () => {
    const request = { enrollmentCode: "enc_abc", hostId: "host_abc", csr: "-----BEGIN CERTIFICATE REQUEST-----" };
    const response = { certificate: "-----BEGIN CERTIFICATE-----", caCertificate: "-----BEGIN CERTIFICATE-----", expiresAt: "2027-10-17T00:00:00.000Z" };
    expect(Value.Check(RacpEnrollRequestSchema, request)).toBe(true);
    expect(Value.Check(RacpEnrollResponseSchema, response)).toBe(true);
  });

  it("rejects an enrollment request without a CSR", () => {
    expect(Value.Check(RacpEnrollRequestSchema, { enrollmentCode: "enc_abc", hostId: "host_abc" })).toBe(false);
  });

  it("accepts an account-mode request that carries no enrollment code (D666)", () => {
    // The credential is the Authorization header, so the field is absent and
    // the Gateway enforces "exactly one credential" structurally.
    const accountMode = { hostId: "host_abc", csr: "-----BEGIN CERTIFICATE REQUEST-----" };
    expect(Value.Check(RacpEnrollRequestSchema, accountMode)).toBe(true);
    expect(Value.Check(RacpEnrollRequestSchema, { ...accountMode, enrollmentCode: "enc_abc" })).toBe(true);
    expect(Value.Check(RacpEnrollRequestSchema, { ...accountMode, hostId: "" })).toBe(false);
    // The label stays unbounded here: the self-hosted flow ignores it and uses
    // the operator's `enroll-code --label`, so a request that always worked must
    // keep working. The Gateway bounds it in the path that persists it.
    expect(Value.Check(RacpEnrollRequestSchema, { ...accountMode, label: "x".repeat(4_096) })).toBe(true);
  });

  it("names every account-mode enrollment failure the Gateway can return", () => {
    for (const code of ["ACCESS_KEY_INVALID", "ACCESS_KEY_UNAVAILABLE", "HOST_ACCOUNT_MISMATCH", "RATE_LIMITED"]) {
      expect(Value.Check(RacpEnrollErrorCodeSchema, code)).toBe(true);
    }
  });
});

describe("account mode contracts (spec §11.5)", () => {
  it("keeps the account routes in their own namespace", () => {
    // `GET /v1/hosts` and `/hosts/{hostId}/...` stay device-token routes, so an
    // account session can never reach a relayed Host operation.
    expect(RACP_ACCOUNT_ROUTES.login).toBe("POST /v1/account/login");
    expect(RACP_ACCOUNT_ROUTES.hosts).toBe("GET /v1/account/hosts");
    expect(RACP_HTTP_ROUTE_LIST.hosts).toBe("GET /v1/hosts");
  });

  it("accepts a native and a browser login round trip", () => {
    expect(Value.Check(RacpAccountLoginRequestSchema, { client: "ios", label: "phone" })).toBe(true);
    expect(Value.Check(RacpAccountLoginRequestSchema, { client: "web" })).toBe(true);
    expect(Value.Check(RacpAccountLoginRequestSchema, { client: "desktop" })).toBe(false);
    expect(
      Value.Check(RacpAccountLoginResponseSchema, {
        accountId: "7",
        keyName: "laptop",
        expiresAt: "2026-10-18T12:00:00.000Z",
        token: "rat1.fixture",
      }),
    ).toBe(true);
    expect(
      Value.Check(RacpAccountLoginResponseSchema, {
        accountId: "7",
        expiresAt: "2026-10-18T12:00:00.000Z",
        csrfToken: "csrf",
      }),
    ).toBe(true);
  });

  it("lists only the shape of one account's Hosts", () => {
    const listing = { accountId: "7", hosts: [{ hostId: "host_a", label: "laptop", online: true }] };
    expect(Value.Check(RacpAccountHostListResponseSchema, listing)).toBe(true);
    expect(Value.Check(RacpAccountHostListResponseSchema, { ...listing, hosts: [{ hostId: "host_a", label: "x" }] })).toBe(false);
    expect(Value.Check(RacpAccountHostSummarySchema, { hostId: "host_a", label: "x", online: false })).toBe(true);
  });
});

describe("RACP-HTTP contracts (spec §11.2)", () => {
  it("includes the Gateway-only pair endpoint beside GET /v1/hosts", () => {
    expect(RACP_HTTP_ROUTE_LIST.hosts).toBe("GET /v1/hosts");
    expect(RACP_HTTP_ROUTE_LIST.pairDevice).toBe("POST /v1/hosts/{hostId}/pair");
  });

  it("declares GET query parameters only where the operation schema has them", () => {
    // The one GET route with non-path parameters: `HistoryParams` carries
    // `beforeItemId` (string) and `limit` (integer, minimum 1).
    expect(RACP_HTTP_QUERY_PARAMS.sessionHistory).toEqual({ beforeItemId: "string", limit: "integer" });
    expect(Value.Check(HistoryParamsShape, { sessionId: "s1", beforeItemId: "item_02", limit: 20 })).toBe(true);
    for (const [key, type] of Object.entries(RACP_HTTP_QUERY_PARAMS.sessionHistory)) {
      const value = type === "integer" ? 20 : "item_02";
      const wrong = type === "integer" ? "20" : 20;
      expect(Value.Check(HistoryParamsShape, { sessionId: "s1", [key]: value })).toBe(true);
      expect(Value.Check(HistoryParamsShape, { sessionId: "s1", [key]: wrong })).toBe(false);
    }
    // Every other route has no query parameters to forward.
    const withQuery = Object.entries(RACP_HTTP_QUERY_PARAMS).filter(([, params]) => Object.keys(params).length > 0);
    expect(withQuery.map(([route]) => route)).toEqual(["sessionHistory"]);
  });

  it("lists a query-parameter entry for every route and only for GET routes", () => {
    expect(Object.keys(RACP_HTTP_QUERY_PARAMS).sort()).toEqual(Object.keys(RACP_HTTP_ROUTE_LIST).sort());
    for (const [routeName, spec] of Object.entries(RACP_HTTP_ROUTE_LIST)) {
      const [method] = spec.split(" ");
      const declared = Object.keys(RACP_HTTP_QUERY_PARAMS[routeName as keyof typeof RACP_HTTP_QUERY_PARAMS]);
      // Only a GET can carry parameters outside its path.
      if (method === "POST") expect({ routeName, declared }).toEqual({ routeName, declared: [] });
    }
  });

  it("accepts a pairing request with the three client kinds", () => {
    for (const client of ["web", "ios", "android"]) {
      expect(Value.Check(RacpPairHttpRequestSchema, { deviceLabel: "phone", client })).toBe(true);
    }
    expect(Value.Check(RacpPairHttpRequestSchema, { deviceLabel: "phone", client: "watch" })).toBe(false);
  });

  it("delivers the token in the body only for native clients", () => {
    expect(Value.Check(RacpPairHttpResponseSchema, { deviceId: "dev_1", hostId: "host_1", roles: ["viewer"] })).toBe(true);
    expect(Value.Check(RacpPairHttpResponseSchema, { deviceId: "dev_1", hostId: "host_1", roles: ["viewer"], token: "pdt1_x" })).toBe(true);
    expect(Value.Check(RacpPairHttpResponseSchema, { deviceId: "dev_1", hostId: "host_1", roles: [] })).toBe(false);
  });

  it("summarizes hosts with the online flag", () => {
    expect(Value.Check(RacpGatewayHostSummarySchema, { hostId: "host_1", label: "lab", online: true })).toBe(true);
  });

  it("maps error codes to HTTP statuses without changing their meaning", () => {
    expect(httpStatusForRacpError("UNAUTHORIZED")).toBe(401);
    expect(httpStatusForRacpError("FORBIDDEN")).toBe(403);
    expect(httpStatusForRacpError("AGENT_BUSY")).toBe(409);
    expect(httpStatusForRacpError("RATE_LIMITED")).toBe(429);
    expect(httpStatusForRacpError("UNKNOWN_CODE")).toBe(500);
  });
});

describe("SSE event format (spec §11.2)", () => {
  const envelope: RacpEventEnvelope = {
    eventId: "evt_1",
    scope: "session",
    sessionId: "ses_1",
    epoch: "ep_7f",
    sequence: 314,
    revision: 22,
    kind: "turn.started",
    occurredAt: "2026-10-17T00:00:01.000Z",
    payload: {},
  };

  it("serializes id/event/data in the fixed format", () => {
    const text = formatSseEvent(envelope);
    expect(text).toBe(`id: ep_7f:314\nevent: racp.event\ndata: ${JSON.stringify(envelope)}\n\n`);
  });

  it("uses afterSequence as the ephemeral cursor", () => {
    const ephemeral = { ...envelope, sequence: undefined, afterSequence: 313, kind: "item.delta" } as unknown as RacpEventEnvelope;
    expect(formatSseEvent(ephemeral).split("\n")[0]).toBe("id: ep_7f:313");
  });

  it("round-trips Last-Event-ID", () => {
    expect(parseSseLastEventId("ep_7f:314")).toEqual({ epoch: "ep_7f", sequence: 314 });
    expect(parseSseLastEventId("ep_7f:notanumber")).toBeNull();
    expect(parseSseLastEventId(":314")).toBeNull();
  });
});

describe("generated fixture bundle", () => {
  it("keeps every named hostlink/http schema in RACP_HOSTLINK_HTTP_SCHEMAS", () => {
    expect(Object.keys(RACP_HOSTLINK_HTTP_SCHEMAS).sort()).toEqual(
      [
        "AccountHostListResponse",
        "AccountLoginRequest",
        "AccountLoginResponse",
        "EnrollRequest",
        "EnrollResponse",
        "GatewayHostSummary",
        "HostLinkFrame",
        "HostRouteContext",
        "PairHttpRequest",
        "PairHttpResponse",
      ].sort(),
    );
    for (const schema of Object.values(RACP_HOSTLINK_HTTP_SCHEMAS)) {
      expect(typeof schema).toBe("object");
    }
  });
});

describe("route context validation", () => {
  it("rejects an expired context schema-wise only through the structural helper", () => {
    // Expiry is a Host-side wall-clock check (security §3.3); the schema keeps
    // the shape, the helper keeps the link identity.
    expect(Value.Check(RacpHostRouteContextSchema, routeContext)).toBe(true);
    expect(hostLinkRouteContextIsValid(routeContext)).toBe(true);
  });
});
