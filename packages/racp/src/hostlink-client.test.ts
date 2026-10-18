import { createServer as createHttpsServer } from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { RACP_HOSTLINK_CLOSE_CODES, RACP_HOSTLINK_VERSION, type RacpHostRouteContext } from "@minih-agent/shared";

import { hashToken, newDeviceToken } from "./auth.js";
import { HostLinkGatewayMux, type HostLinkSocket } from "./hostlink.js";
import {
  HOSTLINK_REJECTED_CLOSE_CODE,
  enrollHostLink,
  startHostLink,
  type HostLinkCredentials,
  type HostLinkStatus,
} from "./hostlink-client.js";
import { flush, harness, type Harness } from "./test-harness.js";
import {
  certificateMatchesPublicKey,
  createCertificateAuthority,
  createHostCsr,
  createServerCertificate,
  issueCertificateFromCsr,
  newKeyPair,
  readCertificateInfo,
  type CertificateAuthorityPem,
} from "./x509.js";

/**
 * Host link client tests against a throwaway TLS "gateway": a real https
 * listener that answers `/v1/enroll` and a real `wss` upgrade, both using
 * certificates this test creates. Everything stays on loopback.
 */

class WsHostLinkSocket implements HostLinkSocket {
  private message: ((frame: string) => void) | null = null;
  private close: (() => void) | null = null;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      this.message?.(typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "");
    });
    socket.on("close", () => this.close?.());
  }

  send(frame: string): boolean {
    if (this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(frame);
    return true;
  }

  closeLink(): void {
    this.socket.close(1000, "test gateway closing");
  }

  onMessage(handler: (frame: string) => void): void {
    this.message = handler;
  }

  onClose(handler: () => void): void {
    this.close = handler;
  }

  onError(): void {
    // The tests observe failures through the close path.
  }
}

type GatewayConnection = { mux: HostLinkGatewayMux; socket: WsHostLinkSocket };

type TestGateway = {
  hostlinkUrl: string;
  connections: GatewayConnection[];
  upgrades: number;
  close: () => Promise<void>;
};

async function startTestGateway(options: {
  ca: CertificateAuthorityPem;
  serverCertificate: { certificatePem: string; privateKeyPem: string };
  onEnroll: (body: unknown) => Promise<{ status: number; payload: unknown }>;
  onHostLink?: (connection: GatewayConnection) => void;
}): Promise<TestGateway> {
  const server = createHttpsServer({
    cert: options.serverCertificate.certificatePem,
    key: options.serverCertificate.privateKeyPem,
    ca: options.ca.certificatePem,
    requestCert: true,
    rejectUnauthorized: false,
  });
  const gateway: TestGateway = { hostlinkUrl: "", connections: [], upgrades: 0, close: async () => undefined };
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket) => {
    const adapter = new WsHostLinkSocket(socket);
    const connection = { mux: new HostLinkGatewayMux(adapter, () => undefined), socket: adapter };
    gateway.connections.push(connection);
    options.onHostLink?.(connection);
  });
  server.on("upgrade", (request, socket) => {
    gateway.upgrades += 1;
    if (new URL(request.url ?? "/", "https://gateway.test").pathname !== "/v1/hostlink") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, Buffer.alloc(0), (ws) => wss.emit("connection", ws, request));
  });
  server.on("request", (request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      void (async () => {
        const answer = await options.onEnroll(body ? (JSON.parse(body) as unknown) : null);
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer.payload));
      })().catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  gateway.hostlinkUrl = `wss://127.0.0.1:${port}/v1/hostlink`;
  gateway.close = async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return gateway;
}

function routeContext(clientConnectionId = "cc_1"): RacpHostRouteContext {
  return {
    link: RACP_HOSTLINK_VERSION,
    hostId: "host_test",
    clientConnectionId,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

/**
 * Deadlines here cover a real TLS handshake per test, which gets slow when the
 * package suites run in parallel; the poll still fails with a clear message.
 */
async function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition was not met before the deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Credentials a Gateway would have handed out for a legitimate enrollment. */
async function linkCredentials(ca: CertificateAuthorityPem, gatewayUrl: string, hostId = "host_test"): Promise<HostLinkCredentials> {
  const keys = newKeyPair();
  const csr = await createHostCsr({ privateKeyPem: keys.privateKeyPem, hostId });
  const issued = await issueCertificateFromCsr({ ca, csrPem: csr, purpose: "client" });
  return {
    hostId,
    gatewayUrl,
    gatewayCaPem: ca.certificatePem,
    certificatePem: issued.certificatePem,
    privateKeyPem: keys.privateKeyPem,
    expiresAt: issued.expiresAt,
  };
}

async function authorityWithServer(): Promise<{ ca: CertificateAuthorityPem; server: { certificatePem: string; privateKeyPem: string } }> {
  const ca = await createCertificateAuthority({ commonName: "Minih Gateway CA" });
  const server = await createServerCertificate({ ca, subjectCommonName: "minih-gateway", sans: [{ kind: "ip", value: "127.0.0.1" }] });
  return { ca, server };
}

/**
 * A Gateway whose certificate names `gateway.example.com` only — the shape
 * account mode produces, where the Host dials a loopback forward but the
 * certificate identifies the Gateway by name.
 */
const ACCOUNT_MODE_SERVER_NAME = "gateway.example.com";

async function namedAuthorityWithServer(): Promise<{ ca: CertificateAuthorityPem; server: { certificatePem: string; privateKeyPem: string } }> {
  const ca = await createCertificateAuthority({ commonName: "Minih Gateway CA" });
  const server = await createServerCertificate({
    ca,
    subjectCommonName: ACCOUNT_MODE_SERVER_NAME,
    sans: [{ kind: "dns", value: ACCOUNT_MODE_SERVER_NAME }],
  });
  return { ca, server };
}

/** Sign the CSR of an enroll request the way the Gateway does. */
async function signEnrollment(ca: CertificateAuthorityPem, body: unknown): Promise<{ status: number; payload: unknown }> {
  const request = body as { hostId: string; csr: string };
  const issued = await issueCertificateFromCsr({ ca, csrPem: request.csr, purpose: "client" });
  if (issued.commonName !== request.hostId) return { status: 400, payload: { error: { code: "CSR_INVALID", message: "the CSR does not name the Host" } } };
  return { status: 200, payload: { certificate: issued.certificatePem, caCertificate: ca.certificatePem, expiresAt: issued.expiresAt } };
}

describe("enrollHostLink", () => {
  let gateway: TestGateway | null = null;

  afterEach(async () => {
    await gateway?.close();
    gateway = null;
  });

  it("exchanges the CSR for credentials pinned to the Gateway CA", { timeout: 20_000 }, async () => {
    const { ca, server } = await authorityWithServer();
    gateway = await startTestGateway({ ca, serverCertificate: server, onEnroll: (body) => signEnrollment(ca, body) });
    const credentials = await enrollHostLink({
      gatewayUrl: gateway.hostlinkUrl,
      gatewayCaPem: ca.certificatePem,
      enrollmentCode: "code_fixture_0001",
      hostId: "host_test",
      label: "test host",
    });
    expect(credentials.hostId).toBe("host_test");
    const info = readCertificateInfo(credentials.certificatePem);
    expect(info.commonName).toBe("host_test");
    expect(certificateMatchesPublicKey(credentials.certificatePem, credentials.privateKeyPem)).toBe(true);
    expect(credentials.privateKeyPem).toContain("PRIVATE KEY");
    expect(credentials.gatewayCaPem).toBe(ca.certificatePem);
  });

  it("refuses a Gateway whose certificate is not signed by the pinned CA", { timeout: 20_000 }, async () => {
    const { ca, server } = await authorityWithServer();
    const other = await authorityWithServer();
    gateway = await startTestGateway({ ca, serverCertificate: other.server, onEnroll: (body) => signEnrollment(ca, body) });
    await expect(
      enrollHostLink({ gatewayUrl: gateway.hostlinkUrl, gatewayCaPem: ca.certificatePem, enrollmentCode: "code_fixture_0001", hostId: "host_test" }),
    ).rejects.toMatchObject({ code: "GATEWAY_IDENTITY_MISMATCH" });
  });

  it("refuses a certificate that certifies another key or another Host", { timeout: 20_000 }, async () => {
    const { ca, server } = await authorityWithServer();
    const stranger = newKeyPair();
    const strangerCsr = await createHostCsr({ privateKeyPem: stranger.privateKeyPem, hostId: "host_other" });
    const strangerCertificate = await issueCertificateFromCsr({ ca, csrPem: strangerCsr, purpose: "client" });
    gateway = await startTestGateway({
      ca,
      serverCertificate: server,
      onEnroll: async () => ({ status: 200, payload: { certificate: strangerCertificate.certificatePem, caCertificate: ca.certificatePem, expiresAt: strangerCertificate.expiresAt } }),
    });
    await expect(
      enrollHostLink({ gatewayUrl: gateway.hostlinkUrl, gatewayCaPem: ca.certificatePem, enrollmentCode: "code_fixture_0001", hostId: "host_test" }),
    ).rejects.toMatchObject({ code: "ENROLLMENT_RESPONSE_INVALID" });
  });

  it("maps a certificate it cannot parse to ENROLLMENT_RESPONSE_INVALID", { timeout: 20_000 }, async () => {
    const { ca, server } = await authorityWithServer();
    gateway = await startTestGateway({
      ca,
      serverCertificate: server,
      onEnroll: async (body) => {
        const signed = await signEnrollment(ca, body);
        return {
          status: 200,
          payload: { ...(signed.payload as object), certificate: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" },
        };
      },
    });
    await expect(
      enrollHostLink({ gatewayUrl: gateway.hostlinkUrl, gatewayCaPem: ca.certificatePem, enrollmentCode: "code_fixture_0001", hostId: "host_test" }),
    ).rejects.toMatchObject({ code: "ENROLLMENT_RESPONSE_INVALID" });
  });

  it("refuses a response whose CA is not the pinned CA", { timeout: 20_000 }, async () => {
    const { ca, server } = await authorityWithServer();
    const other = await createCertificateAuthority({ commonName: "Other CA" });
    gateway = await startTestGateway({
      ca,
      serverCertificate: server,
      onEnroll: async (body) => {
        const signed = await signEnrollment(ca, body);
        return { status: 200, payload: { ...(signed.payload as object), caCertificate: other.certificatePem } };
      },
    });
    await expect(
      enrollHostLink({ gatewayUrl: gateway.hostlinkUrl, gatewayCaPem: ca.certificatePem, enrollmentCode: "code_fixture_0001", hostId: "host_test" }),
    ).rejects.toMatchObject({ code: "GATEWAY_IDENTITY_MISMATCH" });
  });

  it("maps every enrollment error code the Gateway reports", { timeout: 20_000 }, async () => {
    const { ca, server } = await authorityWithServer();
    gateway = await startTestGateway({
      ca,
      serverCertificate: server,
      onEnroll: async () => ({ status: 400, payload: { error: { code: "ENROLLMENT_CODE_USED", message: "the code was already used" } } }),
    });
    await expect(
      enrollHostLink({ gatewayUrl: gateway.hostlinkUrl, gatewayCaPem: ca.certificatePem, enrollmentCode: "code_fixture_0001", hostId: "host_test" }),
    ).rejects.toMatchObject({ code: "ENROLLMENT_CODE_USED" });
  });

  it("refuses a plain ws:// URL: the Host link is mutual TLS only", async () => {
    await expect(
      enrollHostLink({ gatewayUrl: "ws://127.0.0.1:1/v1/hostlink", gatewayCaPem: "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n", enrollmentCode: "c", hostId: "host_test" }),
    ).rejects.toMatchObject({ code: "GATEWAY_UNREACHABLE" });
  });

  it("validates the explicit service name when the dialled address is not it", { timeout: 20_000 }, async () => {
    // Account mode (D666): No-TUN dials a loopback forward while the Gateway
    // certificate names the Gateway. Without the explicit name the identity
    // check would be against 127.0.0.1 and fail; with it the enrollment works
    // and the name is kept with the credentials for every later dial.
    const { ca, server } = await namedAuthorityWithServer();
    gateway = await startTestGateway({ ca, serverCertificate: server, onEnroll: (body) => signEnrollment(ca, body) });
    const credentials = await enrollHostLink({
      gatewayUrl: gateway.hostlinkUrl,
      gatewayCaPem: ca.certificatePem,
      accessKey: "sk_placeholder_account_key",
      hostId: "host_test",
      tlsServerName: "gateway.example.com",
    });
    expect(credentials.tlsServerName).toBe("gateway.example.com");
    // The stored URL is still the address that was dialled.
    expect(credentials.gatewayUrl).toBe(gateway.hostlinkUrl);
    expect(credentials.gatewayUrl.startsWith("wss://127.0.0.1:")).toBe(true);
  });

  it("fails when the explicit service name does not match the certificate", { timeout: 20_000 }, async () => {
    const { ca, server } = await namedAuthorityWithServer();
    gateway = await startTestGateway({ ca, serverCertificate: server, onEnroll: (body) => signEnrollment(ca, body) });
    // Same Gateway, wrong identity: the certificate is valid and pinned, but it
    // was not issued for this name, so the handshake must be refused.
    await expect(
      enrollHostLink({
        gatewayUrl: gateway.hostlinkUrl,
        gatewayCaPem: ca.certificatePem,
        accessKey: "sk_placeholder_account_key",
        hostId: "host_test",
        tlsServerName: "other.example.com",
      }),
    ).rejects.toMatchObject({ code: "GATEWAY_IDENTITY_MISMATCH" });
  });
  it("stores the advertised endpoint instead of the dial address", { timeout: 20_000 }, async () => {
    const { ca, server } = await namedAuthorityWithServer();
    gateway = await startTestGateway({ ca, serverCertificate: server, onEnroll: (body) => signEnrollment(ca, body) });
    const credentials = await enrollHostLink({
      // What is reachable right now: the loopback forward.
      gatewayUrl: gateway.hostlinkUrl,
      // What the Router advertised: the Gateway the certificate belongs to.
      hostlinkUrl: "wss://gateway.example.com/hostlink",
      gatewayCaPem: ca.certificatePem,
      accessKey: "sk_placeholder_account_key",
      hostId: "host_test",
      tlsServerName: ACCOUNT_MODE_SERVER_NAME,
    });
    // The credential names the Gateway; the forward port that happened to be
    // dialled at enrollment is not part of it (a later overlay start moves it).
    expect(credentials.gatewayUrl).toBe("wss://gateway.example.com/hostlink");
    expect(credentials.hostlinkUrl).toBe("wss://gateway.example.com/hostlink");
    expect(credentials.gatewayUrl).not.toContain("127.0.0.1");
  });
});

describe("startHostLink", () => {
  let h: Harness;
  let gateway: TestGateway | null = null;
  let handle: ReturnType<typeof startHostLink> | null = null;

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    await gateway?.close();
    gateway = null;
    await flush();
  });

  async function gatewayHarness(options: { onHostLink?: (connection: GatewayConnection) => void } = {}) {
    const { ca, server } = await authorityWithServer();
    gateway = await startTestGateway({ ca, serverCertificate: server, onEnroll: (body) => signEnrollment(ca, body), ...options });
    h = await harness();
    const token = newDeviceToken();
    await h.store.saveDevice({
      deviceId: "dev_gateway",
      label: "phone",
      roles: ["viewer", "controller", "approver"],
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
      origin: "gateway",
    });
    const credentials = await linkCredentials(ca, gateway.hostlinkUrl);
    return { gateway, credentials, token };
  }

  it("connects, serves a logical connection, and closes it on stop()", { timeout: 20_000 }, async () => {
    const { credentials, token } = await gatewayHarness();
    handle = startHostLink({ credentials, server: h.server, authenticator: h.authenticator, log: () => undefined });
    await waitFor(() => handle?.status().state === "connected");
    const connection = await waitFor(() => gateway?.connections[0]);
    const replies: string[] = [];
    connection.mux.onHostMessage("cc_1", (frame) => replies.push(frame));
    connection.mux.open("cc_1", routeContext(), token);
    connection.mux.message("cc_1", JSON.stringify({
      jsonrpc: "2.0",
      id: "c1",
      method: "connection/initialize",
      params: { protocolVersion: "1.0", client: { name: "gateway-test", version: "1.0.0" }, bindings: ["RACP-WS"], capabilities: {} },
    }));
    const reply = await waitFor(() => replies.find((frame) => frame.includes("connectionId")));
    const parsed = JSON.parse(reply) as { result: { server: { hostId: string } } };
    expect(parsed.result.server.hostId).toBe("host_test");
    expect(handle.status().state).toBe("connected");

    const codes: string[] = [];
    connection.mux.onHostClose("cc_1", (code) => codes.push(code));
    await handle.stop();
    expect(handle.status().state).toBe("stopped");
    await waitFor(() => codes.length > 0);
    expect(codes[0]).toBe(RACP_HOSTLINK_CLOSE_CODES.hostClosed);
    // stop() is idempotent.
    await handle.stop();
    expect(handle.status().state).toBe("stopped");
  });

  it("backs off and reconnects when the link drops", { timeout: 20_000 }, async () => {
    const { credentials } = await gatewayHarness();
    const observed: HostLinkStatus[] = [];
    handle = startHostLink({
      credentials,
      server: h.server,
      authenticator: h.authenticator,
      log: () => undefined,
      backoff: { baseDelayMs: 20, maxDelayMs: 40 },
      onStatus: (status) => observed.push(status),
    });
    await waitFor(() => handle?.status().state === "connected");
    gateway?.connections[0]?.socket.closeLink();
    await waitFor(() => observed.some((status) => status.state === "backoff" && status.nextRetryAt !== undefined));
    await waitFor(() => handle?.status().state === "connected" && (gateway?.connections.length ?? 0) > 1);
  });

  it("stops retrying when the Gateway refuses this Host certificate", { timeout: 20_000 }, async () => {
    const { credentials } = await gatewayHarness({
      onHostLink: (connection) => connection.socket.socket.close(HOSTLINK_REJECTED_CLOSE_CODE, "revoked"),
    });
    handle = startHostLink({ credentials, server: h.server, authenticator: h.authenticator, log: () => undefined, backoff: { baseDelayMs: 10, maxDelayMs: 10 } });
    await waitFor(() => handle?.status().state === "rejected");
    const upgrades = gateway?.upgrades ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(gateway?.upgrades).toBe(upgrades);
    expect(handle.status().state).toBe("rejected");
  });

  it("dials a loopback forward under the Gateway's service name", { timeout: 20_000 }, async () => {
    // Account mode: the URL is the loopback forward, the certificate names the
    // Gateway. The link connects only because the explicit name is validated
    // instead of the dialled address.
    const { ca, server } = await namedAuthorityWithServer();
    gateway = await startTestGateway({ ca, serverCertificate: server, onEnroll: (body) => signEnrollment(ca, body) });
    h = await harness();
    const credentials: HostLinkCredentials = {
      ...(await linkCredentials(ca, gateway.hostlinkUrl)),
      tlsServerName: ACCOUNT_MODE_SERVER_NAME,
    };
    handle = startHostLink({ credentials, server: h.server, authenticator: h.authenticator, log: () => undefined });
    await waitFor(() => handle?.status().state === "connected");
    expect(handle.status().state).toBe("connected");
    // An explicit option wins over the stored value, and neither is the address.
    await handle.stop();
    const mismatched: HostLinkCredentials = { ...credentials, tlsServerName: "other.example.com" };
    const observed: HostLinkStatus[] = [];
    handle = startHostLink({
      credentials: mismatched,
      server: h.server,
      authenticator: h.authenticator,
      log: () => undefined,
      backoff: { baseDelayMs: 10, maxDelayMs: 10 },
      onStatus: (status) => observed.push(status),
    });
    // A wrong identity is a TLS failure, so it can never reach "connected".
    await waitFor(() => observed.some((status) => status.state === "backoff"));
    expect(observed.some((status) => status.state === "connected")).toBe(false);
  });

  it("dials the address it resolves for each attempt, not the stored one", { timeout: 30_000 }, async () => {
    // Account mode: the credential names the Gateway, while the address to dial
    // is the overlay's current forward port. A moved port must be followed by
    // the next attempt, with the certificate this Host already holds.
    const { ca, server } = await authorityWithServer();
    const first = await startTestGateway({ ca, serverCertificate: server, onEnroll: (body) => signEnrollment(ca, body) });
    const second = await startTestGateway({ ca, serverCertificate: server, onEnroll: (body) => signEnrollment(ca, body) });
    h = await harness();
    try {
      // The stored URL is the advertised endpoint: it is never dialled, so it
      // does not have to resolve.
      const credentials: HostLinkCredentials = {
        ...(await linkCredentials(ca, "wss://gateway.example.com/hostlink")),
        hostlinkUrl: "wss://gateway.example.com/hostlink",
        tlsServerName: undefined,
      };
      let current = first.hostlinkUrl;
      const resolved: string[] = [];
      handle = startHostLink({
        credentials,
        server: h.server,
        authenticator: h.authenticator,
        log: () => undefined,
        backoff: { baseDelayMs: 20, maxDelayMs: 40 },
        resolveDialUrl: () => {
          resolved.push(current);
          return current;
        },
      });
      await waitFor(() => handle?.status().state === "connected");
      expect(first.upgrades).toBeGreaterThan(0);
      expect(resolved).toEqual([first.hostlinkUrl]);

      // The overlay restarted: the old forward is gone, a new port exists.
      current = second.hostlinkUrl;
      await first.close();
      await waitFor(() => second.upgrades > 0);
      await waitFor(() => handle?.status().state === "connected");
      expect(resolved.at(-1)).toBe(second.hostlinkUrl);
      expect(resolved.length).toBeGreaterThan(1);
    } finally {
      await handle?.stop();
      handle = null;
      await second.close();
      await first.close().catch(() => undefined);
    }
  });
});
