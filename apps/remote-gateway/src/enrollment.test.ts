import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHostCsr, newKeyPair } from "@minih-agent/racp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadOrCreateGatewayAuthority, type GatewayAuthority } from "./ca.js";
import { EnrollmentService } from "./enrollment.js";
import { GatewayStore } from "./store.js";

/**
 * Enrollment (ADR 0330 §3.6): a one-time code, a verified CSR, and a Host
 * record. Every code is single use, expires, and a revoked Host cannot
 * re-enroll — the security gate 26 requirement.
 */
describe("enrollment", () => {
  let dataDir: string;
  let store: GatewayStore;
  let authority: GatewayAuthority;
  let clock: number;
  let service: EnrollmentService;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(process.env["PI_SCRATCH_DIR"] ?? tmpdir(), "gateway-enroll-"));
    clock = Date.parse("2026-10-18T00:00:00.000Z");
    store = await GatewayStore.open(dataDir, () => clock);
    authority = await loadOrCreateGatewayAuthority(store, { hostlinkHost: "127.0.0.1" });
    service = new EnrollmentService(store, async () => authority, () => clock);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function enrollRequest(hostId: string): Promise<{ enrollmentCode: string; hostId: string; csr: string }> {
    const keys = newKeyPair();
    const csr = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId });
    const { code } = await service.issueCode({ label: "laptop" });
    return { enrollmentCode: code, hostId, csr };
  }

  it("registers a Host and answers with a certificate for its own key", async () => {
    const result = await service.handleEnroll(await enrollRequest("host_a"), "127.0.0.1");
    expect(result.status).toBe(200);
    const payload = result.payload as { certificate: string; caCertificate: string; expiresAt: string };
    expect(payload.certificate).toContain("BEGIN CERTIFICATE");
    expect(payload.caCertificate).toBe(authority.ca.certificatePem);
    expect(Date.parse(payload.expiresAt)).toBeGreaterThan(clock + 300 * 24 * 60 * 60 * 1000);
    const record = store.findHost("host_a");
    expect(record?.label).toBe("laptop");
    expect(record?.certificatePem).toBe(payload.certificate);
    expect(record?.certificateFingerprint256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps a code single use", async () => {
    const request = await enrollRequest("host_a");
    expect((await service.handleEnroll(request, "127.0.0.1")).status).toBe(200);
    const replay = await service.handleEnroll(request, "127.0.0.1");
    expect(replay.status).toBe(400);
    expect(replay.payload).toMatchObject({ error: { code: "ENROLLMENT_CODE_USED" } });
  });

  it("refuses an unknown code and an expired code", async () => {
    const request = await enrollRequest("host_a");
    const unknown = await service.handleEnroll({ ...request, enrollmentCode: "ren1.not-a-real-code" }, "127.0.0.1");
    expect(unknown.payload).toMatchObject({ error: { code: "ENROLLMENT_CODE_INVALID" } });

    clock += 16 * 60 * 1000;
    const expired = await service.handleEnroll(request, "127.0.0.1");
    expect(expired.payload).toMatchObject({ error: { code: "ENROLLMENT_CODE_EXPIRED" } });
  });

  it("refuses a CSR whose CN is not the enrolling Host", async () => {
    const request = await enrollRequest("host_a");
    const otherKeys = newKeyPair();
    const foreignCsr = await createHostCsr({ privateKeyPem: otherKeys.privateKeyPem, hostId: "host_b" });
    const result = await service.handleEnroll({ ...request, csr: foreignCsr }, "127.0.0.1");
    expect(result.payload).toMatchObject({ error: { code: "CSR_INVALID" } });
    expect(store.findHost("host_a")).toBeNull();
  });

  it("refuses a malformed request", async () => {
    const result = await service.handleEnroll({ hostId: "host_a" }, "127.0.0.1");
    expect(result.status).toBe(400);
    expect(result.payload).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  });

  it("refuses re-enrollment of a revoked Host", async () => {
    const first = await enrollRequest("host_a");
    await service.handleEnroll(first, "127.0.0.1");
    await store.revokeHost("host_a", new Date(clock).toISOString());
    const second = await enrollRequest("host_a");
    const result = await service.handleEnroll(second, "127.0.0.1");
    expect(result.status).toBe(403);
    expect(result.payload).toMatchObject({ error: { code: "HOST_REVOKED" } });
  });

  it("records an audited outcome without the code or the CSR", async () => {
    const request = await enrollRequest("host_a");
    await service.handleEnroll(request, "10.0.0.9");
    const day = new Date(clock).toISOString().slice(0, 10);
    const records = await store.audit.read(day);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ op: "hosts.enroll", hostId: "host_a", result: "ok", ip: "10.0.0.9" });
    const text = JSON.stringify(records);
    expect(text).not.toContain(request.enrollmentCode);
    expect(text).not.toContain("BEGIN CERTIFICATE REQUEST");
  });
});
