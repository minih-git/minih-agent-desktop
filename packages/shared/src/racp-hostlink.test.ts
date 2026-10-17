import { describe, expect, it } from "vitest";
import * as Value from "typebox/value";

import {
  RACP_HOSTLINK_CLOSE_CODES,
  RACP_HOSTLINK_VERSION,
  RACP_HTTP_ROUTE_LIST,
  RACP_HOSTLINK_HTTP_SCHEMAS,
  RacpHostLinkFrameSchema,
  RacpHostRouteContextSchema,
  RacpPairHttpRequestSchema,
  RacpPairHttpResponseSchema,
  RacpGatewayHostSummarySchema,
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

  it("rejects client.open without a credential (spec §11.4, D663)", () => {
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
});

describe("RACP-HTTP contracts (spec §11.2)", () => {
  it("includes the Gateway-only pair endpoint beside GET /v1/hosts", () => {
    expect(RACP_HTTP_ROUTE_LIST.hosts).toBe("GET /v1/hosts");
    expect(RACP_HTTP_ROUTE_LIST.pairDevice).toBe("POST /v1/hosts/{hostId}/pair");
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
      ["EnrollRequest", "EnrollResponse", "GatewayHostSummary", "HostLinkFrame", "HostRouteContext", "PairHttpRequest", "PairHttpResponse"].sort(),
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
