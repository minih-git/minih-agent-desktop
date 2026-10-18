import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RACP_HOSTLINK_VERSION, type RacpHostLinkFrame, type RacpHostRouteContext } from "@minih-agent/shared";

import { hashToken, newDeviceToken } from "./auth.js";
import { createHostLinkHost, type HostLinkSocket } from "./hostlink.js";
import { flush, harness, OWNER_TOKEN, type Harness } from "./test-harness.js";

/**
 * Revocation support (security §3.7, gate 26): `closeConnectionsForSubject`
 * must drop a subject's loopback `RACP-WS` connection and its Host link
 * logical connections alike, and release each through the normal teardown.
 */
class FakeGatewaySocket implements HostLinkSocket {
  readonly sent: RacpHostLinkFrame[] = [];
  private messageHandler: ((frame: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  send(frame: string): boolean {
    this.sent.push(JSON.parse(frame) as RacpHostLinkFrame);
    return true;
  }

  close(): void {
    this.closeHandler?.();
  }

  onMessage(handler: (frame: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  onError(): void {
    // Not used by this test.
  }
}

function routeContext(clientConnectionId: string): RacpHostRouteContext {
  return {
    link: RACP_HOSTLINK_VERSION,
    hostId: "host_test",
    clientConnectionId,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("closeConnectionsForSubject", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await flush();
  });

  it("closes a loopback RACP-WS connection of that subject only", async () => {
    const owner = await h.connect(OWNER_TOKEN);
    const viewerToken = newDeviceToken();
    // A second subject must survive the revocation of the first.
    await h.store.saveDevice({
      deviceId: "dev_second",
      label: "second",
      roles: ["viewer"],
      tokenHash: hashToken(viewerToken),
      createdAt: new Date().toISOString(),
    });
    const viewer = await h.connect(viewerToken);
    expect(h.server.connectionCount()).toBe(2);

    expect(h.server.closeConnectionsForSubject("dev_owner", "device revoked")).toBe(1);
    await flush();
    expect(h.server.connectionCount()).toBe(1);
    expect(viewer.client.state).toBe("connected");
    expect(owner.client.state).not.toBe("connected");
  });

  it("closes a Host link logical connection of that subject", async () => {
    const token = newDeviceToken();
    await h.store.saveDevice({
      deviceId: "dev_gateway",
      label: "phone",
      roles: ["viewer", "controller", "approver"],
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
      origin: "gateway",
    });
    const socket = new FakeGatewaySocket();
    createHostLinkHost({ server: h.server, authenticator: h.authenticator, hostId: "host_test", log: () => undefined, socket });
    socket.messageHandler?.(JSON.stringify({
      link: RACP_HOSTLINK_VERSION,
      type: "client.open",
      clientConnectionId: "cc_1",
      routeContext: routeContext("cc_1"),
      credential: token,
    }));
    await flush();
    expect(h.server.connectionCount()).toBe(1);

    expect(h.server.closeConnectionsForSubject("dev_gateway", "device revoked")).toBe(1);
    await flush();
    const closes = socket.sent.filter((frame) => frame.type === "host.close");
    expect(closes).toHaveLength(1);
    // A server-initiated close travels as the transport's numeric code (1000),
    // exactly like `RacpServer.close()`; the logical connection itself ends as
    // HOST_CLOSED on the Host side.
    expect(closes[0]).toMatchObject({ type: "host.close", code: "1000" });
    expect(h.server.connectionCount()).toBe(0);
  });

  it("returns zero and leaves unrelated subjects alone", async () => {
    const owner = await h.connect(OWNER_TOKEN);
    expect(h.server.closeConnectionsForSubject("dev_unknown", "device revoked")).toBe(0);
    expect(h.server.connectionCount()).toBe(1);
    expect(owner.client.state).toBe("connected");
  });
});
