import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HostDeviceDirectory,
  MemoryCredentialStore,
  signHostArtifact,
  startHostLink,
  type DeviceRevocationQueue,
  type HostLinkCredentials,
} from "@minih-agent/racp";
import { harness } from "@minih-agent/racp/test-harness";
import { RACP_HOSTLINK_VERSION, RACP_PROTOCOL_VERSION, hostProofSigningPayload } from "@minih-agent/shared";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  accountDesktopProof,
  accountDeviceRequest,
  accountDeviceStatus,
  accountLogin,
  enrollTestHostByKey,
  routerSessionAnswer,
  startRouterStub,
  startTestGateway,
  waitForAsync,
  type TestGateway,
  type TestHost,
  type TestRouterStub,
} from "./test-support.js";

/**
 * A computer of the account reaching a sibling computer through the Gateway
 * (ADR `remote-control-router-account-binding` amendment 3, decisions 2–4 and
 * 8; rollout R8 packages C and D). This is the integration leg of
 * `E2E-REMOTE-ACCOUNT-desktop-auto-joins-sibling-desktop`, minus the renderer:
 *
 * 1. computer A proves with its own Host certificate that it is a machine of
 *    the account, and a sibling admits the device without a human answer;
 * 2. the granted device token then opens `RACP-WS` on a **sibling** Host;
 * 3. that connection lists the sibling's sessions, runs a turn on it, and
 *    answers a server-initiated request the sibling sends back.
 *
 * The Router is a stub and the network is loopback; everything else — the
 * Gateway, the mTLS Host links, both Hosts' device directories, the relay, and
 * the RACP servers — is the production code.
 */

const KEY_A = "sk-gl-desktop-sibling-a";
const ACCOUNT_A = 11;

type Stack = {
  stub: TestRouterStub;
  gateway: TestGateway;
  /** The computer that asks to reach its sibling. */
  desktop: Enrolled;
  /** The computer being reached. */
  sibling: Enrolled;
  token: string;
  dataDir: string;
};

type Enrolled = TestHost & { certificatePem: string; devices: HostDeviceDirectory | null };

describe("a same-account computer reaches its sibling over the Gateway", () => {
  let stack: Stack | null = null;

  async function startStack(): Promise<Stack> {
    const stub = await startRouterStub();
    stub.setAnswer(KEY_A, routerSessionAnswer({ access_key_id: ACCOUNT_A, key_name: "account-a" }));
    const gateway = await startTestGateway({ router: { baseUrl: stub.baseUrl, clientIpHeader: "x-real-ip" } });
    const dataDir = await mkdtemp(join(tmpdir(), "minih-desktop-sibling-"));

    const directory = ({ credentials, store }: { credentials: HostLinkCredentials; store: MemoryCredentialStore }) =>
      new HostDeviceDirectory({
        hostId: credentials.hostId,
        signer: { certificatePem: credentials.certificatePem, privateKeyPem: credentials.privateKeyPem },
        gatewayCaPem: gateway.caPem,
        store,
        log: () => undefined,
        // A sibling never asks in this test: a verified proof is what admits the
        // device, which is the whole point of the automatic path.
        confirmer: { confirm: async () => "denied" },
      });

    const desktop = await enrollTestHostByKey(gateway, {
      hostId: "host_desktop_a",
      accessKey: KEY_A,
      label: "Mac A",
      devices: directory,
    });
    const sibling = await enrollTestHostByKey(gateway, {
      hostId: "host_sibling_b",
      accessKey: KEY_A,
      label: "Mac B",
      history: { items: [{ id: "m1", role: "assistant", content: "hello from B", createdAt: "2026-10-21T00:00:00.000Z", status: "complete" }] },
      // Package D: this Host offers the read-only file panel to a desktop-class
      // device of the account and withholds it from a phone.
      operations: { workspaceRead: (principal) => principal.deviceClass === "desktop" },
      devices: directory,
    });

    // Account login for the desktop: the same account session every account
    // route takes, minted from the Router key by the Gateway.
    const login = await accountLogin(gateway, { accessKey: KEY_A, client: "ios", label: "Mac A" });
    const token = (login.payload["result"] as { token: string }).token;

    // 1. Mint the nonce, sign it with THIS computer's Host certificate, present
    //    it as a desktop request. A sibling verifies it itself.
    const minted = await accountDesktopProof(gateway, {
      token,
      body: { deviceLabel: "Mac A", applicantHostId: "host_desktop_a" },
    });
    expect(minted.status).toBe(200);
    const challenge = minted.payload["result"] as {
      requestId: string;
      nonce: string;
      applicantHostId: string;
      accountId: string;
      expiresAt: string;
      hosts: Array<{ hostId: string; supportsDesktopAuto: boolean }>;
    };
    // Both computers can admit a desktop-class device, which is what makes the
    // automatic path possible at all.
    expect(challenge.hosts.every((host) => host.supportsDesktopAuto)).toBe(true);

    const proof = {
      requestId: challenge.requestId,
      hostProof: {
        applicantHostId: "host_desktop_a",
        nonce: challenge.nonce,
        signature: signHostArtifact(
          hostProofSigningPayload({
            requestId: challenge.requestId,
            nonce: challenge.nonce,
            applicantHostId: "host_desktop_a",
            accountId: String(ACCOUNT_A),
            expiresAt: challenge.expiresAt,
          }),
          desktop.credentials.privateKeyPem,
        ),
        certificate: desktop.certificatePem,
      },
    };
    const presented = await accountDeviceRequest(gateway, {
      token,
      body: { deviceLabel: "Mac A", client: "desktop", ...proof },
    });
    expect(presented.status).toBe(200);

    // No human answered anywhere: the token exists because a Host verified the
    // proof, not because someone clicked approve.
    const granted = await waitForAsync(async () => {
      const answer = await accountDeviceStatus(gateway, { token, requestId: challenge.requestId });
      const result = answer.payload["result"] as { status: string; token?: string; signerHostId?: string };
      return result.status === "granted" && result.token ? result : undefined;
    }, "the desktop device grant", 10_000);
    expect(granted.token?.startsWith("pdt1.")).toBe(true);

    return { stub, gateway, desktop, sibling, token: granted.token as string, dataDir };
  }

  afterEach(async () => {
    for (const host of [stack?.desktop, stack?.sibling]) await host?.stop().catch(() => undefined);
    await stack?.gateway.close();
    await stack?.stub.stop();
    if (stack) await rm(stack.dataDir, { recursive: true, force: true });
    stack = null;
  });

  /** Open the `RACP-WS` route to one Host with a device token. */
  function openRelay(target: TestGateway, hostId: string, token: string) {
    const url = `ws://${target.gateway.client.host}:${target.gateway.client.port}/v1/hosts/${encodeURIComponent(hostId)}/ws`;
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    const frames: Array<Record<string, unknown>> = [];
    socket.on("message", (data: Buffer) => {
      try {
        frames.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
      } catch {
        // A frame this test does not read.
      }
    });
    return {
      socket,
      frames,
      send: (message: unknown) => socket.send(JSON.stringify(message)),
      opened: () =>
        new Promise<void>((resolve, reject) => {
          if (socket.readyState === socket.OPEN) return resolve();
          socket.once("open", () => resolve());
          socket.once("error", reject);
          socket.once("unexpected-response", (_request, response) =>
            reject(new Error(`upgrade refused: ${response.statusCode}`)),
          );
        }),
      waitForFrame: (predicate: (frame: Record<string, unknown>) => boolean, label: string) =>
        waitForAsync(async () => frames.find(predicate), `the relay to receive ${label}`, 10_000),
      close: () => {
        if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close();
      },
    };
  }

  const INITIALIZE = {
    protocolVersion: RACP_PROTOCOL_VERSION,
    client: { name: "desktop-sibling-test", version: "1.0.0" },
    bindings: ["RACP-WS"],
    capabilities: {
      eventReplay: true,
      approvals: true,
      inputRequests: true,
      turnQueue: true,
      hostEvents: true,
      history: true,
    },
  };

  it("lists a sibling's sessions and runs a turn there, with the proof-issued token", async () => {
    stack = await startStack();
    const { gateway, token } = stack;

    // The device the sibling admitted is a desktop-class one: owner, and tied to
    // the certificate that signed the proof.
    const adopted = await waitForAsync(
      async () =>
        (await stack!.sibling.harness.store.listDevices()).find(
          (device) => device.deviceClass === "desktop" && device.applicantHostId === "host_desktop_a",
        ),
      "the sibling to hold the desktop-class device",
      10_000,
    );
    expect(adopted.roles).toEqual(["owner"]);

    // 2. The token opens the route on the SIBLING, not on the computer that
    //    asked: that is the whole point of the account directory.
    const relay = openRelay(gateway, "host_sibling_b", token);
    try {
      await relay.opened();
      relay.send({ jsonrpc: "2.0", id: "c1", method: "connection/initialize", params: INITIALIZE });
      const initialized = await relay.waitForFrame((frame) => frame["id"] === "c1", "the initialize result");
      // The racp harness names its server `host_test` for every Host, so this
      // asserts the answer arrived; the session list below is what proves which
      // Host answered.
      expect((initialized["result"] as { server: { hostId: string } }).server.hostId).toBeTruthy();

      // 3. The sibling's own sessions.
      relay.send({ jsonrpc: "2.0", id: "c2", method: "session/list", params: {} });
      const listed = await relay.waitForFrame((frame) => frame["id"] === "c2", "the session list");
      expect((listed["result"] as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id)).toContain("s1");

      // 4. A turn that actually runs on the sibling, and whose streamed answer
      //    comes back over the same connection.
      relay.send({ jsonrpc: "2.0", id: "c3", method: "session/attach", params: { sessionId: "s1" } });
      await relay.waitForFrame((frame) => frame["id"] === "c3", "the attach result");
      relay.send({
        jsonrpc: "2.0",
        id: "c4",
        method: "events/subscribe",
        params: { scope: "session", sessionId: "s1" },
      });
      await relay.waitForFrame((frame) => frame["id"] === "c4", "the subscribe result");
      relay.send({
        jsonrpc: "2.0",
        id: "c5",
        method: "turn/start",
        params: { sessionId: "s1", input: { text: "what is on this machine?" }, context: { requestId: "r1" } },
      });
      const started = await relay.waitForFrame((frame) => frame["id"] === "c5", "the turn start result");
      const turnId = (started["result"] as { turn: { id: string } }).turn.id;

      stack.sibling.harness.host.ingest({
        sessionId: "s1",
        turnId,
        ts: Date.parse("2026-10-21T00:00:01.000Z"),
        event: {
          type: "message_end",
          message: {
            id: "m2",
            role: "assistant",
            content: "B says hi",
            createdAt: "2026-10-21T00:00:01.000Z",
            status: "complete",
          },
        },
      });
      const delivered = await relay.waitForFrame(
        (frame) =>
          frame["method"] === "session/event" &&
          typeof (frame["params"] as { sequence?: number }).sequence === "number",
        "a durable event from the sibling",
      );
      expect((delivered["params"] as { sessionId?: string }).sessionId).toBe("s1");

      // The Gateway never answered on the client's behalf, and never renumbered:
      // the reply carries the id this client chose.
      expect(started["id"]).toBe("c5");
    } finally {
      relay.close();
    }
  });

  it("refuses the sibling route with a phone-grade token for a device the sibling never adopted", async () => {
    stack = await startStack();
    const { gateway } = stack;

    // A second account device that no Host admitted: it is a valid session, but
    // no sibling holds it, so the route must refuse rather than relay.
    const login = await accountLogin(gateway, { accessKey: KEY_A, client: "ios", label: "phone" });
    const phoneToken = (login.payload["result"] as { token: string }).token;
    const relay = openRelay(gateway, "host_sibling_b", phoneToken);
    await expect(relay.opened()).rejects.toThrow(/upgrade refused/);
    relay.close();
  });

  it("renames and reads the sibling's workspace with the desktop-class token", async () => {
    stack = await startStack();
    const { gateway, token } = stack;
    const relay = openRelay(gateway, "host_sibling_b", token);
    try {
      await relay.opened();
      relay.send({ jsonrpc: "2.0", id: "d1", method: "connection/initialize", params: INITIALIZE });
      const initialized = await relay.waitForFrame((frame) => frame["id"] === "d1", "the initialize result");
      // Package D: the capability is answered for THIS connection, and this one
      // is a desktop-class device of the account.
      expect(
        (initialized["result"] as { capabilities: { workspaceRead?: boolean } }).capabilities.workspaceRead,
      ).toBe(true);

      // A session control that restructures the sibling's own state.
      relay.send({
        jsonrpc: "2.0",
        id: "d2",
        method: "session/rename",
        params: { sessionId: "s1", title: "renamed from A" },
      });
      const renamed = await relay.waitForFrame((frame) => frame["id"] === "d2", "the rename result");
      expect(renamed["error"]).toBeUndefined();

      // The read-only file panel over the same relayed connection.
      relay.send({ jsonrpc: "2.0", id: "d3", method: "workspace/list", params: { sessionId: "s1", path: "" } });
      const listed = await relay.waitForFrame((frame) => frame["id"] === "d3", "the workspace listing");
      expect((listed["result"] as { entries: Array<{ name: string }> }).entries[0]?.name).toBe("README.md");

      relay.send({
        jsonrpc: "2.0",
        id: "d4",
        method: "workspace/read",
        params: { sessionId: "s1", path: "README.md" },
      });
      const read = await relay.waitForFrame((frame) => frame["id"] === "d4", "the file read");
      expect(read["result"]).toMatchObject({ kind: "text", content: "hello" });

      // An escape attempt over the real link is refused by the shared reader.
      relay.send({
        jsonrpc: "2.0",
        id: "d5",
        method: "workspace/read",
        params: { sessionId: "s1", path: "../../etc/passwd" },
      });
      const refused = await relay.waitForFrame((frame) => frame["id"] === "d5", "the refusal");
      expect((refused["error"] as { data?: { code?: string } })?.data?.code).toBe("REMOTE_PATH_FORBIDDEN");
    } finally {
      relay.close();
    }
  });
});
