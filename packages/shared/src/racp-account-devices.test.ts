import { describe, expect, it } from "vitest";
import * as Value from "typebox/value";

import {
  RACP_ACCOUNT_DEVICE_ROUTES,
  RacpDeviceRequestHttpRequestSchema,
  RacpDeviceRequestHttpResponseSchema,
  RacpDeviceStatusHttpResponseSchema,
  canonicalJson,
  deviceGrantSigningPayload,
  deviceRevokeSigningPayload,
  hostAdvertisesCapability,
} from "./racp-account-devices.js";
import { RACP_HOST_CAPABILITIES, type RacpDeviceGrant, type RacpDeviceRevoke } from "./racp-hostlink.js";

/**
 * The device directory contract (protocol §11.5, D666 / package D). What matters
 * here is that the signed bytes are stable across peers that add fields, and
 * that every signed field really is covered.
 */

const grant: RacpDeviceGrant = {
  grantId: "grant_1",
  requestId: "req_1",
  accountId: "7",
  signerHostId: "host_a",
  deviceId: "dev_1",
  deviceLabel: "phone",
  tokenHash: "a".repeat(64),
  roles: ["viewer", "controller", "approver"],
  origin: "gateway",
  issuedAt: "2026-10-18T00:00:00.000Z",
  deliverUntil: "2026-10-19T00:00:00.000Z",
};

const revoke: RacpDeviceRevoke = {
  revokeId: "revoke_1",
  accountId: "7",
  signerHostId: "host_a",
  deviceId: "dev_1",
  revokedAt: "2026-10-18T00:00:00.000Z",
};

describe("canonical JSON", () => {
  it("is stable across key order and nested objects", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: "x" } })).toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
    expect(canonicalJson({ a: { c: "x", d: [2, 1] }, b: 1 })).toBe(canonicalJson({ b: 1, a: { d: [2, 1], c: "x" } }));
    // Arrays keep their order: it is data, not a set.
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("drops undefined and refuses values JSON cannot carry", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalJson({ a: () => undefined })).toThrow(/cannot carry/);
  });
});

describe("device grant signing payload", () => {
  it("covers every signed field", () => {
    const base = deviceGrantSigningPayload(grant);
    const mutations: Array<[string, Partial<RacpDeviceGrant>]> = [
      ["grantId", { grantId: "grant_2" }],
      ["requestId", { requestId: "req_2" }],
      ["accountId", { accountId: "8" }],
      ["signerHostId", { signerHostId: "host_b" }],
      ["deviceId", { deviceId: "dev_2" }],
      ["deviceLabel", { deviceLabel: "other" }],
      ["tokenHash", { tokenHash: "b".repeat(64) }],
      ["roles", { roles: ["viewer"] }],
      ["issuedAt", { issuedAt: "2026-10-18T00:00:01.000Z" }],
      ["deliverUntil", { deliverUntil: "2026-10-20T00:00:00.000Z" }],
    ];
    for (const [field, patch] of mutations) {
      expect(deviceGrantSigningPayload({ ...grant, ...patch }), field).not.toBe(base);
    }
    // Re-ordering the roles array is a different payload too: the array is data.
    expect(deviceGrantSigningPayload({ ...grant, roles: ["approver", "viewer", "controller"] })).not.toBe(base);
  });

  it("ignores fields a newer peer may add, so an old signature stays valid", () => {
    const extended = { ...grant, futureField: "ignored", nested: { a: 1 } } as RacpDeviceGrant;
    expect(deviceGrantSigningPayload(extended)).toBe(deviceGrantSigningPayload(grant));
    // `origin` is fixed by the contract, but it is still signed.
    expect(deviceGrantSigningPayload({ ...grant, origin: "gateway" })).toBe(deviceGrantSigningPayload(grant));
  });

  it("is independent of the object's own key order", () => {
    const reordered: RacpDeviceGrant = {
      deliverUntil: grant.deliverUntil,
      issuedAt: grant.issuedAt,
      origin: grant.origin,
      roles: [...grant.roles],
      tokenHash: grant.tokenHash,
      deviceLabel: grant.deviceLabel,
      deviceId: grant.deviceId,
      signerHostId: grant.signerHostId,
      accountId: grant.accountId,
      requestId: grant.requestId,
      grantId: grant.grantId,
    };
    expect(deviceGrantSigningPayload(reordered)).toBe(deviceGrantSigningPayload(grant));
  });
});

describe("device revoke signing payload", () => {
  it("covers every signed field", () => {
    const base = deviceRevokeSigningPayload(revoke);
    for (const [field, patch] of [
      ["revokeId", { revokeId: "revoke_2" }],
      ["accountId", { accountId: "8" }],
      ["signerHostId", { signerHostId: "host_b" }],
      ["deviceId", { deviceId: "dev_2" }],
      ["revokedAt", { revokedAt: "2026-10-18T00:00:02.000Z" }],
    ] as Array<[string, Partial<RacpDeviceRevoke>]>) {
      expect(deviceRevokeSigningPayload({ ...revoke, ...patch }), field).not.toBe(base);
    }
  });
});

describe("host capabilities", () => {
  it("reads a capability list without knowing future entries", () => {
    expect(hostAdvertisesCapability([RACP_HOST_CAPABILITIES.deviceConfirm], RACP_HOST_CAPABILITIES.deviceConfirm)).toBe(true);
    expect(hostAdvertisesCapability([], RACP_HOST_CAPABILITIES.deviceConfirm)).toBe(false);
    expect(
      hostAdvertisesCapability(
        [RACP_HOST_CAPABILITIES.deviceConfirm, "device.future"],
        RACP_HOST_CAPABILITIES.deviceAcceptSiblingGrant,
      ),
    ).toBe(false);
  });
});

describe("account device routes", () => {
  it("keeps the device routes in the account namespace", () => {
    expect(RACP_ACCOUNT_DEVICE_ROUTES.request).toBe("POST /v1/account/devices");
    expect(RACP_ACCOUNT_DEVICE_ROUTES.status).toBe("GET /v1/account/devices/{requestId}");
  });

  it("validates the request body", () => {
    expect(Value.Check(RacpDeviceRequestHttpRequestSchema, { deviceLabel: "phone", client: "ios" })).toBe(true);
    expect(Value.Check(RacpDeviceRequestHttpRequestSchema, { deviceLabel: "", client: "ios" })).toBe(false);
    expect(Value.Check(RacpDeviceRequestHttpRequestSchema, { deviceLabel: "x".repeat(129), client: "ios" })).toBe(false);
    // A desktop request is well-formed on its own; the Gateway refuses one
    // without a proof, because the class alone is never an admission.
    expect(Value.Check(RacpDeviceRequestHttpRequestSchema, { deviceLabel: "mac", client: "desktop" })).toBe(true);
    expect(
      Value.Check(RacpDeviceRequestHttpRequestSchema, {
        deviceLabel: "mac",
        client: "desktop",
        requestId: "dreq_1",
        hostProof: { applicantHostId: "host_a", nonce: "dn_1", signature: "sig" },
      }),
    ).toBe(true);
    // A proof missing any of its three parts is malformed, whatever the class.
    expect(
      Value.Check(RacpDeviceRequestHttpRequestSchema, {
        deviceLabel: "mac",
        client: "desktop",
        hostProof: { applicantHostId: "host_a", nonce: "dn_1" },
      }),
    ).toBe(false);
  });

  it("validates the host report and the status answer", () => {
    const host = { hostId: "host_a", label: "desk", online: true, canConfirm: true, willAcceptGrant: false, supportsDesktopAuto: true };
    expect(Value.Check(RacpDeviceRequestHttpResponseSchema, { requestId: "req_1", expiresAt: "2026-10-18T00:10:00.000Z", hosts: [host] })).toBe(true);
    expect(Value.Check(RacpDeviceStatusHttpResponseSchema, { requestId: "req_1", status: "pending", expiresAt: "x", hosts: [host] })).toBe(true);
    expect(
      Value.Check(RacpDeviceStatusHttpResponseSchema, {
        requestId: "req_1",
        status: "granted",
        expiresAt: "x",
        hosts: [host],
        deviceId: "dev_1",
        token: "pdt1.fixture",
        roles: ["viewer"],
        signerHostId: "host_a",
      }),
    ).toBe(true);
    expect(Value.Check(RacpDeviceStatusHttpResponseSchema, { requestId: "req_1", status: "waiting", expiresAt: "x", hosts: [] })).toBe(false);
    // A host report must state every capability: the client distinguishes
    // "can be asked" from "will accept the token" from "can admit a desktop".
    expect(Value.Check(RacpDeviceStatusHttpResponseSchema, { requestId: "r", status: "pending", expiresAt: "x", hosts: [{ hostId: "h", label: "l", online: true }] })).toBe(false);
    expect(
      Value.Check(RacpDeviceStatusHttpResponseSchema, {
        requestId: "r",
        status: "pending",
        expiresAt: "x",
        hosts: [{ hostId: "h", label: "l", online: true, canConfirm: true, willAcceptGrant: true }],
      }),
    ).toBe(false);
  });
});
