import { afterEach, describe, expect, it } from "vitest";
import { enrollTestHost, startTestGateway, type TestGateway, type TestHost } from "./test-support.js";

describe("ticket installation replacement over HTTP and Host link", () => {
  let gateway: TestGateway | undefined;
  const hosts: TestHost[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.stop();
    await gateway?.close();
  });

  it("replaces only the re-paired installation on the selected Host", async () => {
    gateway = await startTestGateway();
    const firstHost = await enrollTestHost(gateway, { hostId: "host_one" });
    const secondHost = await enrollTestHost(gateway, { hostId: "host_two" });
    hosts.push(firstHost, secondHost);
    const pair = async (host: TestHost, installationId: string) => {
      const code = await host.harness.authenticator.issuePairingToken(60_000, "gateway");
      const response = await fetch(`${gateway!.clientBaseUrl}/v1/hosts/${host.hostId}/pair`, {
        method: "POST",
        headers: { authorization: `Bearer ${code.token}`, "content-type": "application/json" },
        body: JSON.stringify({ deviceLabel: "iOS app", client: "ios", installationId }),
      });
      expect(response.status).toBe(200);
      return await response.json() as { deviceId: string; token: string };
    };
    const installationId = "11111111-1111-4111-8111-111111111111";
    const first = await pair(firstHost, installationId);
    const sibling = await pair(secondHost, installationId);
    const other = await pair(firstHost, "22222222-2222-4222-8222-222222222222");
    const replacement = await pair(firstHost, installationId);
    const probe = (host: TestHost, token: string) => fetch(`${gateway!.clientBaseUrl}/hosts/${host.hostId}/v1/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((response) => response.status);
    expect(await probe(firstHost, first.token)).toBe(401);
    expect(await probe(firstHost, replacement.token)).toBe(200);
    expect(await probe(firstHost, other.token)).toBe(200);
    expect(await probe(secondHost, sibling.token)).toBe(200);
    expect(gateway.gateway.store.findDevice(first.deviceId)?.revokedAt).toBeTruthy();
    expect((await firstHost.harness.store.listDevices()).filter((device) => device.origin === "gateway" && !device.revokedAt)).toHaveLength(2);
  });
});
