import Type from "typebox";
import { describe, expect, it } from "vitest";
import * as Value from "typebox/value";

import {
  RACP_ACCOUNT_ROUTES,
  RACP_HOSTLINK_CLOSE_CODES,
  RACP_HOSTLINK_VERSION,
  RACP_HOST_CAPABILITIES,
  RACP_HTTP_QUERY_PARAMS,
  RACP_HTTP_ROUTE_LIST,
  RACP_HOSTLINK_HTTP_SCHEMAS,
  RACP_NOTIFY_KINDS,
  RACP_PUSH_PLATFORMS,
  RacpHostNotifyFrameSchema,
  RacpHostNotifySchema,
  RacpPushPayloadSchema,
  RacpPushRegistrationRequestSchema,
  pushKeysForKind,
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
  type RacpDeviceGrant,
  type RacpDeviceGrantFrame,
  type RacpDeviceRequestFrame,
  type RacpDeviceRevoke,
  type RacpDeviceRevokeFrame,
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

/** The account-mode device frames (protocol §11.5, D666). */
const deviceGrant: RacpDeviceGrant = {
  grantId: "grant_1",
  requestId: "req_1",
  accountId: "7",
  signerHostId: "host_abc",
  deviceId: "dev_1",
  deviceLabel: "phone",
  tokenHash: "a".repeat(64),
  roles: ["viewer", "controller", "approver"],
  origin: "gateway",
  issuedAt: "2026-10-18T00:00:00.000Z",
  deliverUntil: "2026-10-19T00:00:00.000Z",
};

const deviceRevoke: RacpDeviceRevoke = {
  revokeId: "revoke_1",
  accountId: "7",
  signerHostId: "host_abc",
  deviceId: "dev_1",
  revokedAt: "2026-10-18T00:00:00.000Z",
};

function deviceRequestFrame(): RacpDeviceRequestFrame {
  return {
    link: RACP_HOSTLINK_VERSION,
    type: "device.request",
    request: {
      requestId: "req_1",
      accountId: "7",
      deviceLabel: "phone",
      client: "ios",
      requestedAt: "2026-10-18T00:00:00.000Z",
      expiresAt: "2026-10-18T00:10:00.000Z",
    },
  };
}

function deviceGrantFrame(): RacpDeviceGrantFrame {
  return {
    link: RACP_HOSTLINK_VERSION,
    type: "device.grant",
    grant: { ...deviceGrant },
    signature: "c2lnbmF0dXJl",
    signerCertificate: "-----BEGIN CERTIFICATE-----",
  };
}

function deviceRevokeFrame(): RacpDeviceRevokeFrame {
  return {
    link: RACP_HOSTLINK_VERSION,
    type: "device.revoke",
    revoke: { ...deviceRevoke },
    signature: "c2lnbmF0dXJl",
    signerCertificate: "-----BEGIN CERTIFICATE-----",
  };
}

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
      { link: RACP_HOSTLINK_VERSION, type: "host.capabilities", capabilities: ["device.confirm"] },
      deviceRequestFrame(),
      deviceGrantFrame(),
      deviceRevokeFrame(),
    ];
    for (const frame of frames) {
      const parsed = parseHostLinkFrame(JSON.stringify(frame));
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe(frame.type);
    }
    expect(parseHostLinkFrame("not json")).toBeNull();
    expect(parseHostLinkFrame(JSON.stringify({ hello: 1 }))).toBeNull();
  });

  /**
   * The account-mode device frames (protocol §11.5, D666 / package D). They join
   * the same union, so a peer that predates them still parses every frame it
   * knows and simply ignores an unknown `type`.
   */
  it("validates the capability and device frames", () => {
    const capabilities = {
      link: RACP_HOSTLINK_VERSION,
      type: "host.capabilities",
      capabilities: [RACP_HOST_CAPABILITIES.deviceConfirm, RACP_HOST_CAPABILITIES.deviceAcceptSiblingGrant, "device.future"],
    };
    expect(Value.Check(RacpHostLinkFrameSchema, capabilities)).toBe(true);
    // An unknown capability string is allowed (forward compatible); a malformed
    // list is not.
    expect(Value.Check(RacpHostLinkFrameSchema, { ...capabilities, capabilities: "device.confirm" })).toBe(false);
    expect(Value.Check(RacpHostLinkFrameSchema, { ...capabilities, capabilities: [""] })).toBe(false);

    expect(Value.Check(RacpHostLinkFrameSchema, deviceRequestFrame())).toBe(true);
    expect(Value.Check(RacpHostLinkFrameSchema, { ...deviceRequestFrame(), request: { ...deviceRequestFrame().request, client: "desktop" } })).toBe(false);
    expect(Value.Check(RacpHostLinkFrameSchema, { ...deviceRequestFrame(), request: { ...deviceRequestFrame().request, deviceLabel: "x".repeat(129) } })).toBe(false);

    expect(Value.Check(RacpHostLinkFrameSchema, deviceGrantFrame())).toBe(true);
    // The Host-to-Gateway leg carries the raw token; a relayed grant need not.
    expect(Value.Check(RacpHostLinkFrameSchema, { ...deviceGrantFrame(), deviceToken: "pdt1.fixture" })).toBe(true);
    const grant = deviceGrantFrame().grant;
    expect(Value.Check(RacpHostLinkFrameSchema, { ...deviceGrantFrame(), grant: { ...grant, tokenHash: "abc" } })).toBe(false);
    expect(Value.Check(RacpHostLinkFrameSchema, { ...deviceGrantFrame(), grant: { ...grant, roles: [] } })).toBe(false);
    expect(Value.Check(RacpHostLinkFrameSchema, { ...deviceGrantFrame(), grant: { ...grant, origin: "ssh" } })).toBe(false);

    expect(Value.Check(RacpHostLinkFrameSchema, deviceRevokeFrame())).toBe(true);
    expect(Value.Check(RacpHostLinkFrameSchema, { ...deviceRevokeFrame(), signature: "" })).toBe(false);
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
        "PushPayload",
        "PushRegistrationRequest",
        "PushRegistrationResponse",
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

describe("redacted push contracts (spec §11.6)", () => {
  const notify = {
    notifyId: "ntf_1",
    kind: "approval.requested" as const,
    sessionId: "s1",
    approvalId: "ap_1",
    occurredAt: "2026-10-18T00:00:00.000Z",
  };

  it("keeps the frame to ids and one of the four kinds", () => {
    expect(Value.Check(RacpHostNotifyFrameSchema, { link: RACP_HOSTLINK_VERSION, type: "host.notify", notify })).toBe(true);
    // No field for content: a Host cannot slip a prompt, a tool, or a title in.
    expect(Value.Check(RacpHostNotifyFrameSchema, { link: RACP_HOSTLINK_VERSION, type: "host.notify", notify: { ...notify, prompt: "secret" } })).toBe(false);
    expect(Value.Check(RacpHostNotifyFrameSchema, { link: RACP_HOSTLINK_VERSION, type: "host.notify", notify: { ...notify, kind: "turn.started" } })).toBe(false);
  });

  it("refuses an id that is not an id, so a push cannot become a text channel", () => {
    // Without a character set, "a push carries ids only" would be a promise
    // about the Host's behaviour rather than a property of the frame: a Host
    // could put a sentence in `sessionId` and the Gateway would deliver it to a
    // lock screen. Real ids are UUIDs, `<prefix>_<uuid>`, or decimal ids.
    for (const field of ["notifyId", "sessionId", "approvalId"] as const) {
      expect(Value.Check(RacpHostNotifySchema, { ...notify, [field]: "the user asked about the secret plans" })).toBe(false);
      expect(Value.Check(RacpHostNotifySchema, { ...notify, [field]: "会话一" })).toBe(false);
      expect(Value.Check(RacpHostNotifySchema, { ...notify, [field]: "" })).toBe(false);
      expect(Value.Check(RacpHostNotifySchema, { ...notify, [field]: "a".repeat(129) })).toBe(false);
    }
    // The shapes the Host actually mints all pass.
    for (const id of [
      "4f1f7b8c-1d2e-4b6a-9c1d-2e3f4a5b6c7d",
      "ntf_4f1f7b8c-1d2e-4b6a-9c1d-2e3f4a5b6c7d",
      "turn_ldx2k3ja9f",
      "s1",
      "42",
      "dev_a.b:c",
    ]) {
      expect(Value.Check(RacpHostNotifySchema, { ...notify, sessionId: id })).toBe(true);
    }
  });

  it("applies the same id rule to the payload the Gateway builds", () => {
    const payload = {
      kind: "approval.requested" as const,
      titleKey: "push.notify.approval.requested.title",
      bodyKey: "push.notify.approval.requested.body",
      hostId: "host_a",
      sessionId: "s1",
      approvalId: "ap_1",
      notifyId: "ntf_1",
    };
    expect(Value.Check(RacpPushPayloadSchema, payload)).toBe(true);
    expect(Value.Check(RacpPushPayloadSchema, { ...payload, sessionId: "look at this prompt" })).toBe(false);
    expect(Value.Check(RacpPushPayloadSchema, { ...payload, titleKey: "Some inline text" })).toBe(false);
    expect(Value.Check(RacpPushPayloadSchema, { ...payload, prompt: "secret" })).toBe(false);
  });

  it("ties the runtime kind lists to the schemas that spell them out", () => {
    // The schemas list their literals rather than mapping over the arrays
    // (TypeBox loses the literal through a mapped union), so this is the test
    // that keeps the two in step.
    for (const kind of RACP_NOTIFY_KINDS) {
      expect(
        Value.Check(RacpHostNotifySchema, { notifyId: "n", kind, sessionId: "s", occurredAt: "t" }),
        `notify kind ${kind}`,
      ).toBe(true);
      expect(
        Value.Check(RacpPushPayloadSchema, {
          kind,
          titleKey: "t",
          bodyKey: "b",
          hostId: "h",
          sessionId: "s",
          notifyId: "n",
        }),
        `payload kind ${kind}`,
      ).toBe(true);
    }
    const platform = RacpPushRegistrationRequestSchema.properties.platform;
    for (const value of RACP_PUSH_PLATFORMS) {
      expect(Value.Check(Type.Object({ platform }), { platform: value }), `platform ${value}`).toBe(true);
    }
  });

  it("carries a localization key pair and ids, and nothing else", () => {
    const payload = { kind: "turn.failed" as const, ...pushKeysForKind("turn.failed"), hostId: "h1", sessionId: "s1", notifyId: "n1" };
    expect(Value.Check(RacpPushPayloadSchema, payload)).toBe(true);
    expect(pushKeysForKind("turn.failed")).toEqual({
      titleKey: "push.notify.turn.failed.title",
      bodyKey: "push.notify.turn.failed.body",
    });
    // A field a client would have to redact is a contract violation, not a
    // judgment call: `additionalProperties: false` refuses it here.
    expect(Value.Check(RacpPushPayloadSchema, { ...payload, title: "Build finished" })).toBe(false);
    expect(Value.Check(RacpPushPayloadSchema, { ...payload, prompt: "rm -rf /" })).toBe(false);
  });

  it("bounds the provider token so the route cannot be used as storage", () => {
    const base = { platform: "ios", token: "a".repeat(64) };
    expect(Value.Check(RacpPushRegistrationRequestSchema, base)).toBe(true);
    expect(Value.Check(RacpPushRegistrationRequestSchema, { ...base, token: "" })).toBe(false);
    expect(Value.Check(RacpPushRegistrationRequestSchema, { ...base, token: "a".repeat(4097) })).toBe(false);
    expect(Value.Check(RacpPushRegistrationRequestSchema, { ...base, platform: "web" })).toBe(false);
  });
});
