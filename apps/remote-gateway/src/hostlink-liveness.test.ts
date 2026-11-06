/**
 * Host link liveness (protocol §11.4 rule 5).
 *
 * A Host link can die without either end noticing: the overlay tunnel is gone,
 * yet both sockets still report a healthy connection, so the Gateway keeps
 * believing the computer is online and sends client requests into it. The
 * heartbeat is the only evidence, and these tests cover both sides of it — a
 * link that answers is kept, a link that stopped answering is dropped with the
 * same cleanup a real disconnect gets.
 *
 * The suites use a short beat so nothing waits the production 45 seconds, and a
 * raw WebSocket stands in for the Host so a test can decide whether the peer
 * answers at all (an older Desktop answers `link.pong` and speaks nothing else).
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { enrollHostLink, type HostLinkCredentials } from "@minih-agent/racp";

import { enrollTestHost, startTestGateway, waitFor, type TestGateway } from "./test-support.js";

const HOSTLINK_PATH = "/v1/hostlink";
const HOSTLINK_PROTOCOL = "racp-hostlink.v1";

/** A Host link peer that speaks the protocol by hand, with no link core. */
type RawHostLink = {
  hostId: string;
  credentials: HostLinkCredentials;
  socket: WebSocket;
  /** Beats this peer received; proves the Gateway really pinged. */
  pings: () => number;
};

/**
 * Open one mutual-TLS Host link and decide whether to answer beats. Answering
 * is what an older Desktop does — it predates every account-mode frame but
 * answers `link.ping` exactly as it always has.
 */
async function rawHostLink(gateway: TestGateway, options: { answerPings: boolean }): Promise<RawHostLink> {
  const hostId = "host_liveness";
  const code = await gateway.gateway.enrollment.issueCode({ label: "liveness" });
  const credentials = await enrollHostLink({
    gatewayUrl: `wss://127.0.0.1:${gateway.gateway.hostlink.port}${HOSTLINK_PATH}`,
    gatewayCaPem: gateway.caPem,
    enrollmentCode: code.code,
    hostId,
  });
  const socket = new WebSocket(`wss://127.0.0.1:${gateway.gateway.hostlink.port}${HOSTLINK_PATH}`, {
    ca: [gateway.caPem],
    cert: credentials.certificatePem,
    key: credentials.privateKeyPem,
  });
  let pings = 0;
  socket.on("message", (data: unknown) => {
    let frame: { type?: unknown };
    try {
      frame = JSON.parse(String(data)) as { type?: unknown };
    } catch {
      return;
    }
    if (frame.type !== "link.ping") return;
    pings += 1;
    if (!options.answerPings) return;
    socket.send(JSON.stringify({ link: HOSTLINK_PROTOCOL, type: "link.pong" }));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error: Error) => reject(error));
  });
  await waitFor(() => gateway.gateway.hostLinks.isOnline(hostId));
  return { hostId, credentials, socket, pings: () => pings };
}

describe("host link liveness", () => {
  let gateway: TestGateway;
  const open: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of open.splice(0)) socket.terminate();
    await gateway?.close();
  });

  it("drops a Host link that stopped answering heartbeats", async () => {
    gateway = await startTestGateway({}, { heartbeatMs: 40, heartbeatTimeoutMs: 120 });
    const host = await rawHostLink(gateway, { answerPings: false });
    open.push(host.socket);
    // The Gateway pinged, so the silence is a real absence of answers rather
    // than a link it never tested.
    await waitFor(() => host.pings() > 0);
    await waitFor(() => !gateway.gateway.hostLinks.isOnline(host.hostId));
    // The peer sees the link go away, which is what makes it reconnect.
    await waitFor(() => host.socket.readyState !== WebSocket.OPEN);
  });

  it("keeps a Host link that answers every beat, even with nothing else to say", async () => {
    // An older Desktop on a new Gateway: it sends no capability frame and no
    // other traffic, but it answers `link.ping`, so it must never be dropped.
    gateway = await startTestGateway({}, { heartbeatMs: 40, heartbeatTimeoutMs: 120 });
    const host = await rawHostLink(gateway, { answerPings: true });
    open.push(host.socket);
    // Four beats is more than the whole timeout window: a Gateway that ignored
    // the answers would have dropped this link by now.
    await waitFor(() => host.pings() >= 4);
    expect(gateway.gateway.hostLinks.isOnline(host.hostId)).toBe(true);
  });

  it("keeps a link whose Host answers with the current client", async () => {
    // The real client against the real Gateway: the beat is short enough that a
    // missed pong would drop it inside this test.
    gateway = await startTestGateway({}, { heartbeatMs: 40, heartbeatTimeoutMs: 120 });
    const host = await enrollTestHost(gateway);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(gateway.gateway.hostLinks.isOnline(host.hostId)).toBe(true);
    await host.stop();
  });
});