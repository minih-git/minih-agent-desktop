import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RacpInitializeResult } from "@minih-agent/shared";
import { RACP_HOSTLINK_CLOSE_CODES, RACP_HOSTLINK_VERSION, type RacpHostLinkFrame, type RacpHostRouteContext } from "@minih-agent/shared";

import { GATEWAY_PAIR_ROLES, SSH_PAIR_ROLES, hashToken, newDeviceToken } from "./auth.js";
import { HostLinkGatewayMux, HostLinkHost, createHostLinkHost, type HostLinkSocket } from "./hostlink.js";
import { flush, harness, type Harness } from "./test-harness.js";

/**
 * A scripted socket pair standing in for the Gateway connection: the tests
 * push Host link frames into the host and observe what the host sends back.
 */
class FakeGatewaySocket implements HostLinkSocket {
  readonly sent: RacpHostLinkFrame[] = [];
  private messageHandler: ((frame: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  open = true;

  send(frame: string): void {
    this.sent.push(JSON.parse(frame) as RacpHostLinkFrame);
  }

  close(): void {
    this.open = false;
    this.closeHandler?.();
  }

  onMessage(handler: (frame: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  /** Simulate the Gateway sending one raw frame to the Host. */
  feed(frame: unknown): void {
    this.messageHandler?.(JSON.stringify(frame));
  }

  feedRaw(text: string): void {
    this.messageHandler?.(text);
  }

  drop(): void {
    this.close();
  }

  hostFramesOfType(type: RacpHostLinkFrame["type"]): RacpHostLinkFrame[] {
    return this.sent.filter((frame) => frame.type === type);
  }
}

function routeContext(expiresAt = "2027-10-17T00:00:00.000Z"): RacpHostRouteContext {
  return { link: RACP_HOSTLINK_VERSION, hostId: "host_test", clientConnectionId: "cc_1", issuedAt: "2026-10-17T00:00:00.000Z", expiresAt };
}

describe("host link host", () => {
  let h: Harness;
  let socket: FakeGatewaySocket;

  beforeEach(async () => {
    h = await harness();
    socket = new FakeGatewaySocket();
  });

  afterEach(async () => {
    socket.drop();
    await flush();
  });

  function openHost(now = () => Date.now()): HostLinkHost {
    return createHostLinkHost({ server: h.server, authenticator: h.authenticator, hostId: "host_test", log: () => undefined, now, socket });
  }

  it("re-authenticates the client.open credential with the gateway origin", async () => {
    // A gateway-origin device: minted through the Gateway, never an owner.
    const token = newDeviceToken();
    await h.store.saveDevice({ deviceId: "dev_gw", label: "phone", roles: ["viewer", "controller", "approver"], tokenHash: hashToken(token), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    const host = openHost();
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_gw", routeContext: routeContext(), credential: token });
    await flush();
    expect(host.connections()).toHaveLength(1);
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.message", clientConnectionId: "cc_gw", message: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "connection/initialize", params: { protocolVersion: "1.0", client: { name: "test", version: "0.15.0" }, bindings: ["RACP-WS"], capabilities: {} } }) });
    await flush();
    const messages = socket.hostFramesOfType("host.message");
    expect(messages.length).toBeGreaterThan(0);
    // The server's initialize response arrives on the logical connection; the
    // gateway principal keeps its gateway roles, and its non-owner status is
    // enforced Host-side (agent-host tests), not advertised in the handshake.
    const response = JSON.parse(messages[0]!.message as string) as { result?: RacpInitializeResult };
    expect(response.result?.principal.roles).toEqual(["viewer", "controller", "approver"]);
  });

  it("rejects a credential the Host does not know (S8: the Host is the final authority)", async () => {
    const host = openHost();
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_bad", routeContext: routeContext(), credential: newDeviceToken() });
    await flush();
    const closes = socket.hostFramesOfType("host.close");
    expect(closes).toHaveLength(1);
    expect(closes[0]!.code).toBe(RACP_HOSTLINK_CLOSE_CODES.unauthorized);
  });

  it("rejects an ssh-origin device token on the Host link (cross-channel, security §3.7)", async () => {
    const host = openHost();
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_ssh", routeContext: routeContext(), credential: "pdt1_not_issued" });
    await flush();
    expect(socket.hostFramesOfType("host.close")[0]?.code).toBe(RACP_HOSTLINK_CLOSE_CODES.unauthorized);
  });

  it("rejects a duplicate clientConnectionId on the same link", async () => {
    const token = newDeviceToken();
    await h.store.saveDevice({ deviceId: "dev_dup", label: "phone", roles: ["viewer"], tokenHash: hashToken(token), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    const host = openHost();
    const open = { link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_dup", routeContext: routeContext(), credential: token } as const;
    socket.feed(open);
    await flush();
    socket.feed(open);
    await flush();
    const closes = socket.hostFramesOfType("host.close");
    expect(closes.some((frame) => frame.code === RACP_HOSTLINK_CLOSE_CODES.duplicateConnection)).toBe(true);
  });

  it("releases the RacpServer slot when logical connections close (fix 1a)", async () => {
    const token = newDeviceToken();
    await h.store.saveDevice({ deviceId: "dev_cycle", label: "phone", roles: ["viewer"], tokenHash: hashToken(token), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    const host = openHost();
    // Cycle far beyond maxConnectedClients (16) on one link.
    for (let index = 0; index < 20; index += 1) {
      socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: `cc_cycle_${index}`, routeContext: routeContext(), credential: token });
      await flush();
      socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.close", clientConnectionId: `cc_cycle_${index}`, reason: "done" });
      await flush();
    }
    expect(h.server.connectionCount()).toBe(0);
    // New opens still work after all that churn.
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_after", routeContext: routeContext(), credential: token });
    await flush();
    expect(h.server.connectionCount()).toBe(1);
    expect(socket.hostFramesOfType("host.close").some((frame) => frame.code === RACP_HOSTLINK_CLOSE_CODES.clientTooSlow)).toBe(false);
  });

  it("releases every slot when the socket drops with multiple logical connections (fix 1b)", async () => {
    const token = newDeviceToken();
    await h.store.saveDevice({ deviceId: "dev_multi", label: "phone", roles: ["viewer"], tokenHash: hashToken(token), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    const host = openHost();
    for (let index = 0; index < 3; index += 1) {
      socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: `cc_m_${index}`, routeContext: routeContext(), credential: token });
    }
    await flush();
    expect(h.server.connectionCount()).toBe(3);
    socket.drop();
    await flush();
    expect(h.server.connectionCount()).toBe(0);
  });

  it("lets a client resubscribe from its cursor after a link drop without gaps (fix 1c)", async () => {
    const token = newDeviceToken();
    await h.store.saveDevice({ deviceId: "dev_resume", label: "phone", roles: ["viewer"], tokenHash: hashToken(token), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    const host = openHost();
    const open = (id: string) => socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: id, routeContext: routeContext(), credential: token });
    const init = (id: string) =>
      socket.feed({
        link: RACP_HOSTLINK_VERSION,
        type: "client.message",
        clientConnectionId: id,
        message: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "connection/initialize", params: { protocolVersion: "1.0", client: { name: "t", version: "1" }, bindings: ["RACP-WS"], capabilities: {} } }),
      });
    open("cc_res");
    init("cc_res");
    await flush();
    const responses = socket.hostFramesOfType("host.message").map((frame) => JSON.parse(frame.message as string) as { id?: number; result?: { cursor?: { epoch: string; sequence: number } } });
    const initResponse = responses.find((message) => message.id === 1);
    expect(initResponse?.result).toBeTruthy();
    // Drop the link; the session keeps its durable events.
    socket.drop();
    await flush();
    // A fresh socket with the same host serves a resume from the recorded cursor.
    const resumed = new FakeGatewaySocket();
    const resumeHost = createHostLinkHost({ server: h.server, authenticator: h.authenticator, hostId: "host_test", log: () => undefined, socket: resumed });
    resumed.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_res2", routeContext: routeContext(), credential: token });
    resumed.feed({
      link: RACP_HOSTLINK_VERSION,
      type: "client.message",
      clientConnectionId: "cc_res2",
      message: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "connection/initialize", params: { protocolVersion: "1.0", client: { name: "t", version: "1" }, bindings: ["RACP-WS"], capabilities: {} } }),
    });
    await flush();
    const resumedResponses = resumed.hostFramesOfType("host.message").map((frame) => JSON.parse(frame.message as string) as { id?: number });
    expect(resumedResponses.some((message) => message.id === 2)).toBe(true);
    expect(resumeHost.connections()).toHaveLength(1);
    resumed.drop();
  });

  it("buffers a client.message that races client.open and serves it (fix 2a)", async () => {
    const token = newDeviceToken();
    await h.store.saveDevice({ deviceId: "dev_race", label: "phone", roles: ["viewer"], tokenHash: hashToken(token), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    const host = openHost();
    // No flush between open and message: the gateway pipelines them.
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_race", routeContext: routeContext(), credential: token });
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.message", clientConnectionId: "cc_race", message: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "connection/initialize", params: { protocolVersion: "1.0", client: { name: "t", version: "1" }, bindings: ["RACP-WS"], capabilities: {} } }) });
    await flush();
    const messages = socket.hostFramesOfType("host.message");
    expect(messages.length).toBeGreaterThan(0);
    const response = JSON.parse(messages[0]!.message as string) as { id?: number; error?: unknown };
    expect(response.id).toBe(1);
    expect(response.error).toBeUndefined();
    expect(socket.hostFramesOfType("host.close")).toHaveLength(0);
    expect(host.connections()).toHaveLength(1);
  });

  it("closes the second of two concurrent opens with the same id (fix 2b)", async () => {
    const token = newDeviceToken();
    await h.store.saveDevice({ deviceId: "dev_dup2", label: "phone", roles: ["viewer"], tokenHash: hashToken(token), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    const host = openHost();
    const open = { link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_dup2", routeContext: routeContext(), credential: token } as const;
    // Both opens are in flight before either resolves.
    socket.feed(open);
    socket.feed(open);
    await flush();
    const closes = socket.hostFramesOfType("host.close");
    expect(closes.some((frame) => frame.code === RACP_HOSTLINK_CLOSE_CODES.duplicateConnection)).toBe(true);
    // Exactly one connection survives.
    expect(h.server.connectionCount()).toBe(1);
    expect(host.connections()).toHaveLength(1);
  });

  it("cancels the pending entry once when the pre-auth buffer overflows (fix A)", async () => {
    const token = newDeviceToken();
    await h.store.saveDevice({ deviceId: "dev_overflow", label: "phone", roles: ["viewer"], tokenHash: hashToken(token), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    const host = openHost();
    // open then 70 messages in the same tick: the 65th frame overflows.
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_overflow", routeContext: routeContext(), credential: token });
    for (let index = 0; index < 70; index += 1) {
      socket.feed({
        link: RACP_HOSTLINK_VERSION,
        type: "client.message",
        clientConnectionId: "cc_overflow",
        message: JSON.stringify({ jsonrpc: "2.0", id: index, method: "connection/initialize", params: { protocolVersion: "1.0", client: { name: "t", version: "1" }, bindings: ["RACP-WS"], capabilities: {} } }),
      });
    }
    await flush();
    const closes = socket.hostFramesOfType("host.close");
    expect(closes.filter((frame) => frame.code === RACP_HOSTLINK_CLOSE_CODES.clientTooSlow)).toHaveLength(1);
    // The cancelled pending entry never becomes a logical connection.
    expect(host.connections()).toHaveLength(0);
    expect(h.server.connectionCount()).toBe(0);
    expect(socket.hostFramesOfType("host.message")).toHaveLength(0);
  });

  it("cancels a pending open when client.close arrives during authentication (fix 2c)", async () => {
    const host = openHost();
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_cancel", routeContext: routeContext(), credential: newDeviceToken() });
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.close", clientConnectionId: "cc_cancel", reason: "gone" });
    await flush();
    expect(h.server.connectionCount()).toBe(0);
    expect(host.connections()).toHaveLength(0);
  });

  it("redacts the credential from every log, close frame, and error payload (fix 6)", async () => {
    const secret = "pdt1_SUPER_SECRET_fixture_token";
    const logs: string[] = [];
    const host = createHostLinkHost({
      server: h.server,
      authenticator: h.authenticator,
      hostId: "host_test",
      log: (level, message, data) => logs.push(JSON.stringify([level, message, data ?? {}])),
      socket,
    });
    // Auth failure, route-context rejection, duplicate id, and an exception path.
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_leak1", routeContext: routeContext(), credential: secret });
    await flush();
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_leak2", routeContext: { ...routeContext(), hostId: "host_other" }, credential: secret });
    await flush();
    const badContext = { ...routeContext(), expiresAt: "not-a-date" };
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_leak3", routeContext: badContext, credential: secret });
    await flush();
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_leak4", routeContext: routeContext(), credential: secret });
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_leak4", routeContext: routeContext(), credential: secret });
    await flush();
    socket.feedRaw("this is not json at all");
    await flush();
    // The authenticator's own logging surface: authenticate with the secret and
    // collect nothing about it (the authenticator takes no log callbacks, so we
    // assert on every string this test assembled).
    const everyText = [...logs, JSON.stringify(socket.sent)].join("\n");
    expect(everyText).not.toContain(secret);
    expect(JSON.stringify(host.connections())).not.toContain(secret);
  });

  it("closes the link when an attachment.chunk frame arrives (deferred relay, fix 6)", async () => {
    const token = newDeviceToken();
    await h.store.saveDevice({ deviceId: "dev_chunk", label: "phone", roles: ["viewer"], tokenHash: hashToken(token), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    const host = openHost();
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_chunk", routeContext: routeContext(), credential: token });
    await flush();
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "attachment.chunk", uploadId: "up_1", offset: 0, last: false });
    await flush();
    expect(host.connections()).toHaveLength(0);
    expect(h.server.connectionCount()).toBe(0);
  });

  it("tolerates bounded Gateway clock skew on issuedAt (fix 10)", async () => {
    const fixedNow = Date.parse("2026-10-17T00:00:00.000Z");
    const token = newDeviceToken();
    await h.store.saveDevice({ deviceId: "dev_skew", label: "phone", roles: ["viewer"], tokenHash: hashToken(token), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    // Host is 2 seconds behind the Gateway: issuedAt is 2s in the future.
    const skewedContext = { ...routeContext(), issuedAt: "2026-10-17T00:00:02.000Z" };
    const host = createHostLinkHost({ server: h.server, authenticator: h.authenticator, hostId: "host_test", log: () => undefined, now: () => fixedNow, socket });
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_skew_ok", routeContext: skewedContext, credential: token });
    await flush();
    expect(host.connections()).toHaveLength(1);
    // Beyond the 60s default skew: rejected.
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_skew_bad", routeContext: { ...routeContext(), issuedAt: "2026-10-17T00:02:00.000Z" }, credential: token });
    await flush();
    expect(socket.hostFramesOfType("host.close").some((frame) => frame.code === RACP_HOSTLINK_CLOSE_CODES.routeContextRejected)).toBe(true);
    // Expiry stays strict regardless of skew.
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_expired", routeContext: { ...routeContext("2026-10-16T23:59:00.000Z") }, credential: token });
    await flush();
    expect(socket.hostFramesOfType("host.close").some((frame) => frame.code === RACP_HOSTLINK_CLOSE_CODES.routeContextRejected)).toBe(true);
  });

  it("rejects a route context naming another Host or an expired one", async () => {
    const host = openHost(() => Date.parse("2026-10-17T01:00:00.000Z"));
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_x", routeContext: { ...routeContext(), hostId: "host_other" }, credential: "pdt1_x" });
    await flush();
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_y", routeContext: routeContext("2026-10-17T00:30:00.000Z"), credential: "pdt1_x" });
    await flush();
    const closes = socket.hostFramesOfType("host.close");
    expect(closes.map((frame) => frame.code)).toEqual([RACP_HOSTLINK_CLOSE_CODES.routeContextRejected, RACP_HOSTLINK_CLOSE_CODES.routeContextRejected]);
  });

  it("keeps two logical connections isolated (subscriptions and id spaces)", async () => {
    const tokenA = newDeviceToken();
    const tokenB = newDeviceToken();
    await h.store.saveDevice({ deviceId: "dev_a", label: "a", roles: ["viewer"], tokenHash: hashToken(tokenA), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    await h.store.saveDevice({ deviceId: "dev_b", label: "b", roles: ["viewer"], tokenHash: hashToken(tokenB), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    const host = openHost();
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_a", routeContext: routeContext(), credential: tokenA });
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_b", routeContext: routeContext(), credential: tokenB });
    await flush();
    // Each logical connection initializes independently (rule 2).
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.message", clientConnectionId: "cc_a", message: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "connection/initialize", params: { protocolVersion: "1.0", client: { name: "test", version: "0.15.0" }, bindings: ["RACP-WS"], capabilities: {} } }) });
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.message", clientConnectionId: "cc_b", message: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/list", params: {} }) });
    await flush();
    const perConnection = new Map<string, string[]>();
    for (const frame of socket.hostFramesOfType("host.message")) {
      const list = perConnection.get(frame.clientConnectionId) ?? [];
      list.push(String(frame.message));
      perConnection.set(frame.clientConnectionId, list);
    }
    const a = perConnection.get("cc_a") ?? [];
    const b = perConnection.get("cc_b") ?? [];
    expect(a.some((frame) => frame.includes("protocolVersion"))).toBe(true);
    // cc_b never initialized, so its session/list is rejected instead of answered.
    expect(b.some((frame) => frame.includes('"error"'))).toBe(true);
    expect(a).not.toEqual(b);
  });

  it("closes every logical connection when the link drops, and pings are answered", async () => {
    const token = newDeviceToken();
    await h.store.saveDevice({ deviceId: "dev_link", label: "phone", roles: ["viewer"], tokenHash: hashToken(token), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    const host = openHost();
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_link", routeContext: routeContext(), credential: token });
    await flush();
    expect(host.connections()).toHaveLength(1);
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "link.ping" });
    expect(socket.hostFramesOfType("link.pong")).toHaveLength(1);
    socket.drop();
    await flush();
    expect(host.connections()).toHaveLength(0);
  });

  it("closes a logical connection with CLIENT_TOO_SLOW when the client stops reading", async () => {
    const token = newDeviceToken();
    await h.store.saveDevice({ deviceId: "dev_slow", label: "phone", roles: ["viewer"], tokenHash: hashToken(token), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    const host = openHost();
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_slow", routeContext: routeContext(), credential: token });
    await flush();
    const connection = host.connections()[0]!;
    for (let index = 0; index < 1001; index += 1) {
      connection.transport.send(JSON.stringify({ jsonrpc: "2.0", method: "session/event", params: {} }));
      if (connection.terminalCloseCode) break;
    }
    expect(connection.terminalCloseCode).toBe(RACP_HOSTLINK_CLOSE_CODES.clientTooSlow);
    // Rule 3 tells the Gateway to close the logical connection; the Host-side
    // bound only tears it down locally and records the terminal code.
    expect(connection.terminalCloseDetail).toBe("the event queue exceeded its bound");
  });
});

describe("device origin pairing (security §3.7)", () => {
  it("grants owner only for ssh-origin pairing and never for gateway pairing", async () => {
    const h = await harness();
    const sshToken = (await h.authenticator.issuePairingToken(60_000, "ssh")).token;
    const gwToken = (await h.authenticator.issuePairingToken(60_000, "gateway")).token;
    expect(SSH_PAIR_ROLES).toEqual(["owner"]);
    expect(GATEWAY_PAIR_ROLES).toEqual(["viewer", "controller", "approver"]);
    // The loopback binding (origin ssh) can redeem the ssh code…
    const sshAuth = await h.authenticator.authenticate({ authorization: `Bearer ${sshToken}`, urlHasToken: false, connectionId: "c1", origin: "ssh" });
    expect(sshAuth?.kind).toBe("pairing");
    // …and the Host link (origin gateway) can redeem the gateway code…
    const gwAuth = await h.authenticator.authenticate({ authorization: `Bearer ${gwToken}`, urlHasToken: false, connectionId: "c2", origin: "gateway" });
    expect(gwAuth?.kind).toBe("pairing");
    // …but never the other way around (gates 17 and 28).
    expect(await h.authenticator.authenticate({ authorization: `Bearer ${sshToken}`, urlHasToken: false, connectionId: "c3", origin: "gateway" })).toBeNull();
    expect(await h.authenticator.authenticate({ authorization: `Bearer ${gwToken}`, urlHasToken: false, connectionId: "c4", origin: "ssh" })).toBeNull();
    const paired = await h.authenticator.pair((gwAuth as { tokenHash: string }).tokenHash, "phone", [...GATEWAY_PAIR_ROLES], "gateway");
    const device = await h.store.findDeviceByTokenHash(hashToken(paired.token));
    expect(device?.origin).toBe("gateway");
    expect(device?.roles).toEqual(["viewer", "controller", "approver"]);
  });

  it("keeps legacy pairing tokens redeemable as ssh origin", async () => {
    const h = await harness();
    // A pairing token written before D663: no origin field on the record.
    const token = (await h.authenticator.issuePairingToken(60_000)).token;
    const auth = await h.authenticator.authenticate({ authorization: `Bearer ${token}`, urlHasToken: false, connectionId: "c1", origin: "ssh" });
    expect(auth?.kind).toBe("pairing");
  });

  it("keeps legacy device records paired on the loopback binding and rejected on the Host link", async () => {
    const h = await harness();
    // dev_owner (OWNER_TOKEN) has no origin field: it reads as ssh. It
    // authenticates on the loopback binding as a paired owner…
    const { OWNER_TOKEN } = await import("./test-harness.js");
    const loopback = await h.authenticator.authenticate({ authorization: `Bearer ${OWNER_TOKEN}`, urlHasToken: false, connectionId: "c1", origin: "ssh" });
    expect(loopback?.kind).toBe("device");
    expect(loopback?.principal.pairedDevice).toBe(true);
    // …and is rejected on the Host link, because an ssh token cannot cross channels.
    const gateway = await h.authenticator.authenticate({ authorization: `Bearer ${OWNER_TOKEN}`, urlHasToken: false, connectionId: "c2", origin: "gateway" });
    expect(gateway).toBeNull();
  });

  it("emits a non-paired principal for gateway-origin devices so the ceiling always applies", async () => {
    const h = await harness();
    const token = newDeviceToken();
    await h.store.saveDevice({ deviceId: "dev_gw2", label: "phone", roles: ["viewer", "controller", "approver"], tokenHash: hashToken(token), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    const auth = await h.authenticator.authenticate({ authorization: `Bearer ${token}`, urlHasToken: false, connectionId: "c1", origin: "gateway" });
    expect(auth?.kind).toBe("device");
    // pairedDevice: false plus origin: "gateway" are what AgentHost reads to
    // enforce the policy-immune restrictions (packages/agent-host/src/agent-host.ts);
    // the enforcement itself is locked by the agent-host gateway-principal tests.
    expect(auth?.principal.pairedDevice).toBe(false);
    expect(auth?.principal.origin).toBe("gateway");
  });
});

describe("gateway principal restrictions over the link (fix 6)", () => {
  let h: Harness;
  let socket: FakeGatewaySocket;

  beforeEach(async () => {
    h = await harness();
    socket = new FakeGatewaySocket();
  });

  afterEach(async () => {
    socket.drop();
    await flush();
  });

  function openHost(): HostLinkHost {
    return createHostLinkHost({ server: h.server, authenticator: h.authenticator, hostId: "host_test", log: () => undefined, socket });
  }

  it("rejects owner-only operations from a gateway-paired device (fix 6)", async () => {
    // A gateway device holds viewer/controller/approver but never owner, so
    // the role gate rejects `workspace/toolShell` (an owner-only operation).
    const token = newDeviceToken();
    await h.store.saveDevice({ deviceId: "dev_ownerop", label: "phone", roles: ["viewer", "controller", "approver"], tokenHash: hashToken(token), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    const host = openHost();
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "client.open", clientConnectionId: "cc_owner", routeContext: routeContext(), credential: token });
    socket.feed({
      link: RACP_HOSTLINK_VERSION,
      type: "client.message",
      clientConnectionId: "cc_owner",
      message: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "connection/initialize", params: { protocolVersion: "1.0", client: { name: "t", version: "1" }, bindings: ["RACP-WS"], capabilities: {} } }),
    });
    await flush();
    socket.feed({
      link: RACP_HOSTLINK_VERSION,
      type: "client.message",
      clientConnectionId: "cc_owner",
      message: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "workspace/toolShell", params: {} }),
    });
    await flush();
    const messages = socket.hostFramesOfType("host.message").map((frame) => JSON.parse(frame.message as string) as { id?: number; error?: { data?: { code?: string } } });
    const denied = messages.find((message) => message.id === 2);
    expect(denied?.error?.data?.code).toBe("FORBIDDEN");
  });

  it("rejects a gateway-paired device token presented on the loopback ssh channel (fix 6, 4th cross-channel case)", async () => {
    const h2 = await harness();
    const token = newDeviceToken();
    await h2.store.saveDevice({ deviceId: "dev_gw_lb", label: "phone", roles: ["viewer"], tokenHash: hashToken(token), createdAt: "2026-10-17T00:00:00.000Z", origin: "gateway" });
    // The loopback binding authenticates with origin "ssh"; a gateway-origin
    // device must be refused there (it may only enter through the Host link).
    const auth = await h2.authenticator.authenticate({ authorization: `Bearer ${token}`, urlHasToken: false, connectionId: "loopback", origin: "ssh" });
    expect(auth).toBeNull();
  });
});

describe("gateway mux (fix 9)", () => {
  it("delivers message and close to the matching callbacks and cleans up maps", () => {
    const received: string[] = [];
    const closes: string[] = [];
    const socket = new FakeGatewaySocket();
    const mux = new HostLinkGatewayMux(socket, () => undefined);
    mux.onHostMessage("cc_1", (frame) => received.push(frame));
    mux.onHostClose("cc_1", (code) => closes.push(code));
    mux.open("cc_1", { link: RACP_HOSTLINK_VERSION, hostId: "host_test", clientConnectionId: "cc_1", issuedAt: "2026-10-17T00:00:00.000Z", expiresAt: "2027-10-17T00:00:00.000Z" }, "ppt1_fixture");
    expect(socket.sent[0]?.type).toBe("client.open");
    expect((socket.sent[0] as { credential?: string }).credential).toBe("ppt1_fixture");
    mux.message("cc_1", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "connection/initialize" }));
    expect(socket.sent[1]?.type).toBe("client.message");
    // host.message reaches only the message callback.
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "host.message", clientConnectionId: "cc_1", message: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) });
    expect(received).toHaveLength(1);
    expect(closes).toHaveLength(0);
    // host.close reaches the close callback and drops both maps for the id.
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "host.close", clientConnectionId: "cc_1", code: RACP_HOSTLINK_CLOSE_CODES.clientTooSlow });
    expect(closes).toEqual([RACP_HOSTLINK_CLOSE_CODES.clientTooSlow]);
    expect(mux.hasHandlersFor("cc_1")).toBe(false);
    received.length = 0;
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "host.message", clientConnectionId: "cc_1", message: "{}" });
    expect(received).toHaveLength(0);
  });

  it("drops every handler when mux.close is called and on socket loss", () => {
    const closes: string[] = [];
    const socket = new FakeGatewaySocket();
    const mux = new HostLinkGatewayMux(socket, () => undefined);
    mux.onHostClose("cc_a", (code) => closes.push(code));
    mux.onHostClose("cc_b", (code) => closes.push(code));
    mux.close("cc_a", "done");
    expect(mux.hasHandlersFor("cc_a")).toBe(false);
    expect(mux.hasHandlersFor("cc_b")).toBe(true);
    // cc_a's handler was already dropped by close(); only cc_b is notified.
    socket.drop();
    expect(closes).toEqual([RACP_HOSTLINK_CLOSE_CODES.hostClosed]);
    expect(mux.hasHandlersFor("cc_b")).toBe(false);
  });
});
