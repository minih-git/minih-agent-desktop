import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileDeviceRevocationQueue, HostDeviceDirectory, HostLinkGatewayMux, encodeFrame, type DeviceRevocationQueue, type HostLinkSocket } from "@minih-agent/racp";
import { RACP_HOSTLINK_VERSION, RACP_PROTOCOL_VERSION, type RacpHostLinkFrame } from "@minih-agent/shared";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { sendAdminRequest } from "./admin-socket.js";
import { LogicalConnection, type GatewayLog } from "./router.js";

/**
 * A Host link socket the test drives by hand: it records what the mux sends and
 * lets the test deliver Host frames into the same handlers the Gateway
 * registered, so the real `HostLinkGatewayMux` is exercised end to end.
 */
class FakeHostLinkSocket implements HostLinkSocket {
  private readonly sent: RacpHostLinkFrame[] = [];
  private message: ((frame: string) => void) | null = null;
  private close: (() => void) | null = null;

  sentFrames(): RacpHostLinkFrame[] {
    return this.sent;
  }

  receive(frame: RacpHostLinkFrame): void {
    this.message?.(JSON.stringify(frame));
  }

  closeFromGateway(): void {
    this.close?.();
  }

  send(frame: string): boolean {
    this.sent.push(JSON.parse(frame) as RacpHostLinkFrame);
    return true;
  }

  closeLink(): void {
    this.closeFromGateway();
  }

  onMessage(handler: (frame: string) => void): void {
    this.message = handler;
  }

  onClose(handler: () => void): void {
    this.close = handler;
  }

  onError(): void {
    // No error path is exercised here.
  }
}

import {
  accountDeviceRequest,
  accountDeviceStatus,
  accountLogin,
  enrollTestHost,
  enrollTestHostByKey,
  pairDevice,
  routerSessionAnswer,
  startRouterStub,
  startTestGateway,
  transcriptFixture,
  waitFor,
  waitForAsync,
  type TestGateway,
  type TestHost,
  type TestRouterStub,
} from "./test-support.js";

/**
 * The `RACP-WS` client route (`GET /v1/hosts/{hostId}/ws`, protocol §11.4
 * rule 7, rollout R8 package B). A client that speaks the protocol itself gets
 * one logical connection on the Host link and both directions are relayed
 * verbatim — including a server-initiated request the client must answer.
 *
 * The tests use the real Gateway, the real Host link (mTLS), a real
 * `agent-host-cli`-equivalent RACP server (the racp harness), and a stubbed
 * Router; only the network between them is loopback.
 */

type Relay = {
  socket: WebSocket;
  frames: Array<Record<string, unknown>>;
  send: (message: unknown) => void;
  waitForFrame: (predicate: (frame: Record<string, unknown>) => boolean, label: string) => Promise<Record<string, unknown>>;
  closed: Promise<{ code: number; reason: string }>;
  close: () => void;
};

const INITIALIZE = {
  protocolVersion: RACP_PROTOCOL_VERSION,
  client: { name: "gateway-ws-test", version: "1.0.0" },
  bindings: ["RACP-WS"],
  capabilities: { eventReplay: true, approvals: true, inputRequests: true, turnQueue: true, hostEvents: true, history: true },
};

describe("gateway client WebSocket route", () => {
  let gateway: TestGateway | null = null;
  let stub: TestRouterStub | null = null;
  const hosts: Array<{ stop: () => Promise<void> }> = [];
  const relays: Relay[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const relay of relays.splice(0)) relay.close();
    for (const host of hosts.splice(0)) await host.stop().catch(() => undefined);
    await gateway?.close();
    await stub?.stop();
    gateway = null;
    stub = null;
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  /** Open a relay and resolve once the upgrade succeeded (or reject on refusal). */
  function openRelay(target: TestGateway, hostId: string, options: { token?: string | null; url?: string; origin?: string } = {}): Relay {
    const url = options.url ?? `ws://${target.gateway.client.host}:${target.gateway.client.port}/v1/hosts/${encodeURIComponent(hostId)}/ws`;
    const headers: Record<string, string> = {};
    const token = options.token === undefined ? "" : options.token;
    if (token) headers.authorization = `Bearer ${token}`;
    if (options.origin) headers.origin = options.origin;
    const socket = new WebSocket(url, { headers });
    const frames: Array<Record<string, unknown>> = [];
    let closedInfo: { code: number; reason: string } | null = null;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => {
        closedInfo = { code, reason: reason.toString() };
        resolve(closedInfo);
      });
    });
    socket.on("message", (data: Buffer) => {
      try {
        frames.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
      } catch {
        // A frame the test does not need to read.
      }
    });
    const relay: Relay = {
      socket,
      frames,
      send: (message) => socket.send(JSON.stringify(message)),
      waitForFrame: (predicate, label) =>
        waitForAsync(async () => frames.find(predicate), `the relay to receive ${label}`, 10_000),
      closed,
      close: () => {
        if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close();
      },
    };
    relays.push(relay);
    return relay;
  }

  async function relayOpened(relay: Relay): Promise<void> {
    if (relay.socket.readyState === relay.socket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      relay.socket.once("open", () => resolve());
      relay.socket.once("error", (error) => reject(error));
      relay.socket.once("unexpected-response", (_request, response) => reject(new Error(`upgrade refused: ${response.statusCode}`)));
    });
  }

  /**
   * One raw HTTP upgrade, so a test can send a request target the `ws` client
   * would never build and read the status and headers the Gateway answered
   * with. A `101` is resolved too, so a caller can tell acceptance from a
   * refusal without keeping a socket open.
   */
  function rawUpgrade(
    target: TestGateway,
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        host: target.gateway.client.host,
        port: target.gateway.client.port,
        path,
        method: "GET",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": randomBytes(16).toString("base64"),
          "sec-websocket-version": "13",
          ...headers,
        },
      });
      request.on("upgrade", (_response, socket) => {
        socket.destroy();
        resolve({ status: 101, headers: {} });
      });
      request.on("response", (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, headers: response.headers });
      });
      request.on("error", reject);
      request.end();
    });
  }

  /** A self-hosted stack: one Host and one device paired to it. */
  async function selfHostedStack(): Promise<{ gateway: TestGateway; host: TestHost; token: string; deviceId: string }> {
    const target = await startTestGateway();
    gateway = target;
    const host = await enrollTestHost(target, { history: { items: transcriptFixture(4) } });
    hosts.push(host);
    const paired = await pairDevice(target, host, { client: "ios", label: "phone" });
    expect(paired.status).toBe(200);
    return { gateway: target, host, token: paired.token ?? "", deviceId: paired.deviceId };
  }

  /** Account mode: two accounts, a device of account A, and a Host of each. */
  async function accountStack(): Promise<{ gateway: TestGateway; hostA: TestHost; hostB: TestHost; token: string }> {
    const KEY_A = "sk-ws-account-a";
    const KEY_B = "sk-ws-account-b";
    stub = await startRouterStub();
    stub.setAnswer(KEY_A, routerSessionAnswer({ access_key_id: 11, key_name: "account-a" }));
    stub.setAnswer(KEY_B, routerSessionAnswer({ access_key_id: 22, key_name: "account-b" }));
    const target = await startTestGateway({ router: { baseUrl: stub.baseUrl, clientIpHeader: "x-real-ip" } });
    gateway = target;
    const directory = await mkdtemp(join(tmpdir(), "minih-gw-ws-"));
    directories.push(directory);
    const queue: DeviceRevocationQueue = new FileDeviceRevocationQueue(join(directory, "revocations.json"));
    const enroll = (hostId: string, accessKey: string, confirm: "approved" | "denied") =>
      enrollTestHostByKey(target, {
        hostId,
        accessKey,
        label: hostId,
        revocations: () => queue,
        devices: ({ credentials, store }) =>
          new HostDeviceDirectory({
            hostId: credentials.hostId,
            signer: { certificatePem: credentials.certificatePem, privateKeyPem: credentials.privateKeyPem },
            gatewayCaPem: target.caPem,
            store,
            log: () => undefined,
            confirmer: { confirm: async () => confirm },
          }),
      });
    const hostA = await enroll("host_ws_a1", KEY_A, "approved");
    const hostB = await enroll("host_ws_b1", KEY_B, "denied");
    hosts.push(hostA, hostB);
    const login = await accountLogin(target, { accessKey: KEY_A, client: "ios", label: "ws probe" });
    const token = (login.payload["result"] as { token: string }).token;
    const requested = await accountDeviceRequest(target, { token, body: { deviceLabel: "ws probe", client: "ios" } });
    const requestId = (requested.payload["result"] as { requestId: string }).requestId;
    const granted = await waitForAsync(async () => {
      const answer = await accountDeviceStatus(target, { token, requestId });
      const result = answer.payload["result"] as { status: string; token?: string } | undefined;
      return result?.status === "granted" && result.token ? result : undefined;
    }, "the account device grant", 10_000);
    return { gateway: target, hostA, hostB, token: granted.token as string };
  }

  it("relays a client that speaks RACP-WS to the Host and back", async () => {
    const stack = await selfHostedStack();
    const relay = openRelay(stack.gateway, stack.host.hostId, { token: stack.token });
    await relayOpened(relay);

    relay.send({ jsonrpc: "2.0", id: "c1", method: "connection/initialize", params: INITIALIZE });
    const initialized = await relay.waitForFrame((frame) => frame["id"] === "c1", "the initialize result");
    expect((initialized["result"] as { server: { hostId: string } }).server.hostId).toBe(stack.host.hostId);

    relay.send({ jsonrpc: "2.0", id: "c2", method: "session/list", params: {} });
    const listed = await relay.waitForFrame((frame) => frame["id"] === "c2", "the session list");
    expect((listed["result"] as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id)).toContain("s1");

    // The relay is the Host's own answer: the Gateway never rewrote the id.
    expect(listed["id"]).toBe("c2");
  });

  it("relays a server-initiated request to the client and its answer back, verbatim", () => {
    // A fake link carries the real mux, so no mux method is stubbed: the Host
    // side pushes the same frames a Host would, and the relay is asserted on
    // the exact bytes. The Gateway's own routing (non-relay mode) answers a
    // server request with CAPABILITY_UNAVAILABLE — conformance.test.ts covers
    // that — so this proves the relay does not.
    const socket = new FakeHostLinkSocket();
    const mux = new HostLinkGatewayMux(socket, () => undefined);
    const connection = new LogicalConnection({
      identity: { hostId: "host_ws_unit", deviceId: "dev_ws_unit", credential: "pdt1.fixture" },
      mux,
      log: () => undefined,
    });
    const received: string[] = [];
    const closes: string[] = [];
    connection.attachRelay({ onFrame: (frame) => received.push(frame), onClose: (cause) => closes.push(cause) });
    expect(socket.sentFrames()[0]?.type).toBe("client.open");

    const request = encodeFrame({ jsonrpc: "2.0", id: "srv_1", method: "approval/request", params: { approvalId: "a1", sessionId: "s1" } });
    socket.receive({ link: RACP_HOSTLINK_VERSION, type: "host.message", clientConnectionId: connection.id, message: request });
    expect(received).toEqual([request]);
    // Nothing was answered on the client's behalf.
    expect(socket.sentFrames().filter((frame) => frame.type === "client.message")).toHaveLength(0);

    const answer = encodeFrame({ jsonrpc: "2.0", id: "srv_1", result: { decision: "allow-once" } });
    connection.sendRaw(answer);
    const relayed = socket.sentFrames().filter((frame) => frame.type === "client.message");
    expect(relayed).toHaveLength(1);
    expect(relayed[0]?.message).toBe(answer);

    socket.closeFromGateway();
    expect(closes).toEqual(["HOST_CLOSED"]);
  });

  it("refuses a missing, unknown, or URL credential", async () => {
    const stack = await selfHostedStack();
    const missing = openRelay(stack.gateway, stack.host.hostId, { token: null });
    await expect(relayOpened(missing)).rejects.toThrow(/upgrade refused: 401/);

    const unknown = openRelay(stack.gateway, stack.host.hostId, { token: "pdt1.not-a-real-token" });
    await expect(relayOpened(unknown)).rejects.toThrow(/upgrade refused: 401/);

    const inUrl = openRelay(stack.gateway, stack.host.hostId, {
      url: `ws://${stack.gateway.gateway.client.host}:${stack.gateway.gateway.client.port}/v1/hosts/${encodeURIComponent(stack.host.hostId)}/ws?token=${encodeURIComponent(stack.token)}`,
    });
    await expect(relayOpened(inUrl)).rejects.toThrow(/upgrade refused: 401/);
  });

  it("refuses an origin outside the allowlist", async () => {
    const stack = await selfHostedStack();
    const foreign = openRelay(stack.gateway, stack.host.hostId, { token: stack.token, origin: "https://evil.test" });
    await expect(relayOpened(foreign)).rejects.toThrow(/upgrade refused: 403/);
  });

  it("refuses a device paired with another Host, and another account's Host", async () => {
    const stack = await selfHostedStack();
    const other = await enrollTestHost(stack.gateway, { hostId: "host_ws_other" });
    hosts.push(other);
    const wrongHost = openRelay(stack.gateway, other.hostId, { token: stack.token });
    await expect(relayOpened(wrongHost)).rejects.toThrow(/upgrade refused: 403/);

    const accounts = await accountStack();
    const foreignHost = openRelay(accounts.gateway, accounts.hostB.hostId, { token: accounts.token });
    await expect(relayOpened(foreignHost)).rejects.toThrow(/upgrade refused: 403/);

    // The same account's own Host is accepted, so the refusal above is the
    // account boundary and not a broken credential.
    const ownHost = openRelay(accounts.gateway, accounts.hostA.hostId, { token: accounts.token });
    await relayOpened(ownHost);
  });

  it("closes the relayed socket when the device is revoked", async () => {
    const stack = await selfHostedStack();
    const relay = openRelay(stack.gateway, stack.host.hostId, { token: stack.token });
    await relayOpened(relay);
    relay.send({ jsonrpc: "2.0", id: "c1", method: "connection/initialize", params: INITIALIZE });
    await relay.waitForFrame((frame) => frame["id"] === "c1", "the initialize result");

    const revoked = await sendAdminRequest(stack.gateway.dataDir, { op: "devices.revoke", payload: { deviceId: stack.deviceId } });
    expect(revoked.ok).toBe(true);
    const closed = await relay.closed;
    // A revoked credential is a policy refusal, not a normal end.
    expect(closed.code).toBe(1008);
    expect(closed.reason).toBe("device revoked");
  });

  it("resumes a subscription from its cursor after the socket drops", async () => {
    const stack = await selfHostedStack();
    const first = openRelay(stack.gateway, stack.host.hostId, { token: stack.token });
    await relayOpened(first);
    first.send({ jsonrpc: "2.0", id: "c1", method: "connection/initialize", params: INITIALIZE });
    await first.waitForFrame((frame) => frame["id"] === "c1", "the initialize result");
    first.send({ jsonrpc: "2.0", id: "c2", method: "session/attach", params: { sessionId: "s1" } });
    await first.waitForFrame((frame) => frame["id"] === "c2", "the attach result");
    first.send({ jsonrpc: "2.0", id: "c3", method: "events/subscribe", params: { scope: "session", sessionId: "s1" } });
    const subscribed = await first.waitForFrame((frame) => frame["id"] === "c3", "the subscribe result");
    expect((subscribed["result"] as { subscriptionId: string }).subscriptionId).toBeTruthy();
    first.send({ jsonrpc: "2.0", id: "c4", method: "turn/start", params: { sessionId: "s1", input: { text: "one" }, context: { requestId: "r1" } } });
    const started = await first.waitForFrame((frame) => frame["id"] === "c4", "the turn start result");
    const turnId = (started["result"] as { turn: { id: string } }).turn.id;
    // A durable event has to come from the Host's own stream: `agent_start`
    // alone is not sequenced, so the test ends a message.
    stack.host.harness.host.ingest({
      sessionId: "s1",
      turnId,
      ts: Date.parse("2026-10-21T00:00:01.000Z"),
      event: { type: "message_end", message: { id: "m1", role: "assistant", content: "hi", createdAt: "2026-10-21T00:00:01.000Z", status: "complete" } },
    });
    const delivered = await first.waitForFrame(
      (frame) => frame["method"] === "session/event" && typeof (frame["params"] as { sequence?: number }).sequence === "number",
      "a durable event",
    );
    const cursor = { epoch: (delivered["params"] as { epoch: string }).epoch, sequence: (delivered["params"] as { sequence: number }).sequence };
    first.close();
    await first.closed;

    // Events produced while the client is away are not lost: the next relay
    // replays from the cursor the client kept.
    stack.host.harness.host.ingest({
      sessionId: "s1",
      turnId,
      ts: Date.parse("2026-10-21T00:00:03.000Z"),
      event: { type: "message_end", message: { id: "m2", role: "assistant", content: "again", createdAt: "2026-10-21T00:00:03.000Z", status: "complete" } },
    });

    const second = openRelay(stack.gateway, stack.host.hostId, { token: stack.token });
    await relayOpened(second);
    second.send({ jsonrpc: "2.0", id: "d1", method: "connection/initialize", params: INITIALIZE });
    await second.waitForFrame((frame) => frame["id"] === "d1", "the initialize result");
    second.send({ jsonrpc: "2.0", id: "d2", method: "events/subscribe", params: { scope: "session", sessionId: "s1", after: cursor } });
    const replayed = await second.waitForFrame(
      (frame) => frame["method"] === "session/event" && typeof (frame["params"] as { sequence?: number }).sequence === "number" && (frame["params"] as { sequence: number }).sequence > cursor.sequence,
      "the replayed event",
    );
    const replayedCursor = replayed["params"] as { sequence: number; kind: string };
    expect(replayedCursor.sequence).toBeGreaterThan(cursor.sequence);
    expect(second.frames.some((frame) => frame["method"] === "session/event" && (frame["params"] as { sequence?: number }).sequence === cursor.sequence)).toBe(false);
  });

  it("closes the relayed socket normally when the Host link ends", async () => {
    const stack = await selfHostedStack();
    const relay = openRelay(stack.gateway, stack.host.hostId, { token: stack.token });
    await relayOpened(relay);
    relay.send({ jsonrpc: "2.0", id: "c1", method: "connection/initialize", params: INITIALIZE });
    await relay.waitForFrame((frame) => frame["id"] === "c1", "the initialize result");

    // The Host going away is not a policy refusal of the client: a client that
    // sees 1008 here would report a protocol violation to its user.
    await stack.host.stop();
    const closed = await relay.closed;
    expect(closed.code).toBe(1000);
    expect(closed.reason).toBe("HOST_CLOSED");
  });

  it("answers a malformed path with 400 and keeps relaying afterwards", async () => {
    const stack = await selfHostedStack();
    // None of these carries a credential: a path the Gateway cannot decode must
    // not be able to end the process.
    const paths = [
      // A malformed percent-escape: `decodeURIComponent` raises `URIError`.
      "/v1/hosts/%E0%A4%A/ws",
      // Decodes, but is not a Host id.
      "/v1/hosts/not-a-host-id/ws",
      // Decodes to a character a Host id cannot carry.
      "/v1/hosts/host_%3Cscript%3E/ws",
      // Longer than the bound on a Host id.
      `/v1/hosts/${"host_".padEnd(4096, "a")}/ws`,
    ];
    for (const path of paths) {
      const answer = await rawUpgrade(stack.gateway, path);
      expect(answer.status, path).toBe(400);
    }

    // The process is still serving and the audit trail recorded every refusal
    // with the client address.
    const relay = openRelay(stack.gateway, stack.host.hostId, { token: stack.token });
    await relayOpened(relay);
    relay.send({ jsonrpc: "2.0", id: "c1", method: "connection/initialize", params: INITIALIZE });
    const initialized = await relay.waitForFrame((frame) => frame["id"] === "c1", "the initialize result");
    expect((initialized["result"] as { server: { hostId: string } }).server.hostId).toBe(stack.host.hostId);

    const audit = await stack.gateway.gateway.store.audit.read(new Date().toISOString().slice(0, 10));
    const denied = audit.filter((record) => record.op === "hosts.ws" && record.result === "denied");
    expect(denied.length).toBeGreaterThanOrEqual(paths.length);
    expect(denied.every((record) => record.ip.length > 0)).toBe(true);
  });

  it("answers 429 with Retry-After when the device is over its limit", async () => {
    const target = await startTestGateway({}, { deviceLimit: { capacity: 1, refillPerSecond: 0.5 } });
    gateway = target;
    const host = await enrollTestHost(target);
    hosts.push(host);
    const paired = await pairDevice(target, host, { client: "ios", label: "phone" });
    expect(paired.status).toBe(200);
    const token = paired.token ?? "";
    const path = `/v1/hosts/${host.hostId}/ws`;

    const first = await rawUpgrade(target, path, { authorization: `Bearer ${token}` });
    expect(first.status).toBe(101);
    const limited = await rawUpgrade(target, path, { authorization: `Bearer ${token}` });
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });
});
