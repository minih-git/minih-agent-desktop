import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sendAdminRequest } from "./admin-socket.js";
import { command, enrollTestHost, pairDevice, startTestGateway, waitFor, type TestGateway } from "./test-support.js";

/**
 * Host link identity and revocation (security §3.2, §3.7, gates 22, 25, 26):
 * a Host that does not pin the Gateway CA cannot enroll, a revoked Host loses
 * its link and cannot re-enroll, and the audit log never carries a credential.
 */
describe("host link identity", () => {
  let gateway: TestGateway;

  afterEach(async () => {
    await gateway?.close();
  });

  it("refuses enrollment when the Host does not pin the Gateway CA", async () => {
    gateway = await startTestGateway();
    const other = await startTestGateway();
    try {
      const foreignCa = await readFile(other.gateway.caCertificatePath, "utf8");
      await expect(
        enrollTestHost(gateway, { gatewayCaPem: foreignCa, enrollmentCode: (await gateway.gateway.enrollment.issueCode({})).code }),
      ).rejects.toMatchObject({ code: "GATEWAY_IDENTITY_MISMATCH" });
      // The refused attempt did not create a Host record.
      expect(gateway.gateway.store.listHosts()).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it("drops the link and refuses re-enrollment after `hosts revoke`", async () => {
    gateway = await startTestGateway();
    const host = await enrollTestHost(gateway);
    expect(gateway.gateway.hostLinks.isOnline(host.hostId)).toBe(true);

    const revoked = await sendAdminRequest(gateway.dataDir, { op: "hosts.revoke", payload: { hostId: host.hostId } });
    expect(revoked).toMatchObject({ ok: true, revoked: true });
    await waitFor(() => !gateway.gateway.hostLinks.isOnline(host.hostId));
    // The Host link client stops instead of retrying a refused certificate.
    await waitFor(() => host.handle.status().state === "rejected");
    await host.stop();

    const again = await gateway.gateway.enrollment.issueCode({});
    await expect(
      enrollTestHost(gateway, { hostId: host.hostId, enrollmentCode: again.code }),
    ).rejects.toMatchObject({ code: "HOST_REVOKED" });
  });

  it("replaces the previous link of the same Host only after the new one authenticates", async () => {
    gateway = await startTestGateway();
    const first = await enrollTestHost(gateway);
    const firstMux = gateway.gateway.hostLinks.muxFor(first.hostId);
    expect(firstMux).not.toBeNull();

    // A second link with valid credentials replaces the first.
    const second = await enrollTestHost(gateway, { hostId: first.hostId });
    await waitFor(() => gateway.gateway.hostLinks.isOnline(first.hostId));
    expect(gateway.gateway.hostLinks.muxFor(first.hostId)).not.toBe(firstMux);
    await first.stop();
    await second.stop();
  });

  it("keeps the audit log free of tokens, codes, and credentials", async () => {
    gateway = await startTestGateway();
    const enrollment = await gateway.gateway.enrollment.issueCode({ label: "audited" });
    const host = await enrollTestHost(gateway, { enrollmentCode: enrollment.code });
    const paired = await pairDevice(gateway, host, { client: "ios" });
    const token = paired.token ?? "";
    await command(gateway, { hostId: host.hostId, token, method: "session/list", params: {} });
    // A denied request is audited too, without the presented credential.
    await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/sessions`, { headers: { authorization: "Bearer pdt1.fixture_denied_token" } });
    await sendAdminRequest(gateway.dataDir, { op: "devices.revoke", payload: { deviceId: paired.deviceId } });
    await host.stop();
    await gateway.gateway.close();

    const day = new Date().toISOString().slice(0, 10);
    const text = await readFile(join(gateway.dataDir, "audit", `${day}.jsonl`), "utf8");
    const records = text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.length).toBeGreaterThan(3);
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(
        ["deviceId", "hostId", "ip", "op", "result", "ts"].filter((key) => key in record).sort(),
      );
      expect(record["op"]).toEqual(expect.any(String));
      expect(record["ip"]).toEqual(expect.any(String));
      expect(["ok", "denied", "error"]).toContain(record["result"] as string);
    }
    for (const secret of [enrollment.code, token, "pdt1.fixture_denied_token", host.credentials.privateKeyPem.slice(0, 40)]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("BEGIN");
  });
});
