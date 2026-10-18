import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HostLinkGatewayMux, encodeFrame, errorObjectFrom, type HostLinkSocket } from "@minih-agent/racp";
import { OWNER_TOKEN } from "@minih-agent/racp/test-harness";
import { RACP_HOSTLINK_VERSION, type RacpHostLinkFrame } from "@minih-agent/shared";

import { GatewayRpcError, LogicalConnection } from "./router.js";
import {
  command,
  enrollTestHost,
  pairDevice,
  startTestGateway,
  transcriptFixture,
  waitFor,
  type TestGateway,
  type TestHost,
} from "./test-support.js";

/**
 * A Host link socket the test drives by hand: it records what the mux sends
 * and lets the test deliver Host frames into the same handlers the Gateway
 * registered, so the real `HostLinkGatewayMux` is exercised end to end.
 */
class FakeHostLinkSocket implements HostLinkSocket {
  private readonly sent: RacpHostLinkFrame[] = [];
  private message: ((frame: string) => void) | null = null;
  private close: (() => void) | null = null;

  sentFrames(): RacpHostLinkFrame[] {
    return this.sent;
  }

  /** Deliver one Host-to-Gateway frame. */
  receive(frame: RacpHostLinkFrame): void {
    this.message?.(JSON.stringify(frame));
  }

  /** Drop the link the way a closed Gateway socket does. */
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
    // Failures are observed through `closeFromGateway` in these tests.
  }
}



/**
 * RACP-HTTP must mean the same thing as RACP-WS (rollout §3.6, protocol §11.2).
 * The same deterministic commands run against one `RacpServer` twice: directly
 * over the loopback binding, and through the Gateway over HTTP. Results, error
 * codes, and the resulting session state must match.
 */
describe("RACP-HTTP conformance with RACP-WS", () => {
  let gateway: TestGateway;
  let host: TestHost;
  let token: string;

  beforeEach(async () => {
    gateway = await startTestGateway();
    // A twelve-item transcript makes `limit` observable: a page smaller than
    // the transcript proves the parameters reached the Host.
    host = await enrollTestHost(gateway, { history: { items: transcriptFixture(12) } });
    const paired = await pairDevice(gateway, host, { client: "ios" });
    token = paired.token ?? "";
    expect(token.startsWith("pdt1.")).toBe(true);
  });

  afterEach(async () => {
    await host?.stop();
    await gateway?.close();
  });

  /** Compare the two bindings command by command on the same Host. */
  it("returns the same results and error codes for the deterministic command set", async () => {
    const direct = await host.harness.connect(OWNER_TOKEN);
    // Ids and timestamps differ per run; compare shape, status, and error code.
    const scrub = (value: unknown): unknown =>
      JSON.parse(
        JSON.stringify(value ?? null)
          .replace(/(turn|rt)_[A-Za-z0-9_-]+/g, "turn_<id>")
          .replace(/"(\d{4}-\d{2}-\d{2}T[^"]+)"/g, '"<ts>"')
          // Sequence counters and revisions depend on what the other binding
          // already did; their presence is compared, not their value.
          .replace(/"(sequence|afterSequence|revision|queuePosition|epoch)":\s*("?[^",}]+"?)/g, '"$1": "<n>"'),
      ) as unknown;

    type Recording = {
      list: unknown;
      firstTurn: unknown;
      replay: unknown;
      replayedSameTurn: boolean;
      approvalCode: string | null;
      stop: unknown;
      stopCode: string | null;
    };

    const viaWebSocket = async (): Promise<Recording> => {
      const list = await direct.client.request("session/list");
      const params = { sessionId: "s1", idempotencyKey: "turn-key-conformance", input: { text: "deterministic" }, context: { requestId: "req_ws" } };
      const started = await direct.client.request<{ turn: { id: string; status: string } }>("turn/start", params);
      // Settle the turn so the next admission is not rejected as busy.
      host.harness.host.endTurn("s1", started.turn.id, "completed");
      const replay = await direct.client.request<{ turn: { id: string } }>("turn/start", params);
      const approvalCode = await direct.client.request("approval/respond", { approvalId: "approval_missing", decision: "allow-once", revision: 1 }).then(
        () => null,
        (error: { code?: string }) => error.code ?? null,
      );
      const stop = await direct.client.request("turn/stop", { turnId: started.turn.id }).catch((error: { code?: string }) => ({ error: error.code ?? "INTERNAL" }));
      return {
        list: scrub(list),
        firstTurn: scrub(started),
        replay: scrub(replay),
        replayedSameTurn: replay.turn.id === started.turn.id,
        approvalCode,
        stop: scrub(stop),
        stopCode: (stop as { error?: string }).error ?? null,
      };
    };

    const viaGateway = async (): Promise<Recording> => {
      const list = await command(gateway, { hostId: host.hostId, token, method: "session/list", params: {} });
      const params = { sessionId: "s1", input: { text: "deterministic" }, context: { requestId: "req_http" } };
      const started = await command(gateway, { hostId: host.hostId, token, method: "turn/start", params, idempotencyKey: "turn-key-conformance" });
      expect(started.status).toBe(200);
      const turn = started.payload.result as { turn: { id: string } };
      host.harness.host.endTurn("s1", turn.turn.id, "completed");
      const replay = await command(gateway, { hostId: host.hostId, token, method: "turn/start", params, idempotencyKey: "turn-key-conformance" });
      const approval = await command(gateway, { hostId: host.hostId, token, method: "approval/respond", params: { approvalId: "approval_missing", decision: "allow-once", revision: 1 } });
      const stop = await command(gateway, { hostId: host.hostId, token, method: "turn/stop", params: { turnId: turn.turn.id } });
      return {
        list: scrub(list.payload.result),
        firstTurn: scrub(started.payload.result),
        replay: scrub(replay.payload.result),
        replayedSameTurn: (replay.payload.result as { turn: { id: string } }).turn.id === turn.turn.id,
        approvalCode: approval.payload.error?.data?.code ?? null,
        stop: scrub(stop.payload.result ?? stop.payload.error),
        stopCode: stop.status === 200 ? null : (stop.payload.error?.data?.code ?? "INTERNAL"),
      };
    };

    const ws = await viaWebSocket();
    const http = await viaGateway();
    expect(http).toEqual(ws);
    expect(http.replayedSameTurn).toBe(true);
    // Each binding created exactly one turn for its own idempotency key.
    expect(host.harness.runtime.prompts).toHaveLength(2);
    direct.client.close();
  });

  it("resumes an event stream from Last-Event-ID without repeating or losing events", async () => {
    // First stream: read one session event, then drop the connection.
    const first = new AbortController();
    const stream = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/events`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: first.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("x-accel-buffering")).toBe("no");
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readEvent = async (): Promise<{ id: string; data: string }> => {
      for (;;) {
        const frameEnd = buffer.indexOf("\n\n");
        if (frameEnd >= 0) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          const id = /^id: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (id && data) return { id, data };
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("the stream ended before an event arrived");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };

    // session/create publishes a host-scope event that the stream relays.
    const created = await command(gateway, { hostId: host.hostId, token, method: "session/create", params: { title: "streamed" } });
    expect(created.status).toBe(200);
    const firstEvent = await readEvent();
    expect(firstEvent.id).toMatch(/^[^:]+:\d+$/);
    first.abort();

    // Second stream: resume from the first event's cursor and read the next one.
    const second = new AbortController();
    const resumed = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/events`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream", "last-event-id": firstEvent.id },
      signal: second.signal,
    });
    expect(resumed.status).toBe(200);
    const resumedReader = resumed.body!.getReader();
    let resumedBuffer = "";
    const readResumed = async (): Promise<{ id: string; data: string }> => {
      for (;;) {
        const frameEnd = resumedBuffer.indexOf("\n\n");
        if (frameEnd >= 0) {
          const frame = resumedBuffer.slice(0, frameEnd);
          resumedBuffer = resumedBuffer.slice(frameEnd + 2);
          const id = /^id: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (id && data) return { id, data };
          continue;
        }
        const chunk = await resumedReader.read();
        if (chunk.done) throw new Error("the resumed stream ended before an event arrived");
        resumedBuffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    await command(gateway, { hostId: host.hostId, token, method: "session/create", params: { title: "streamed again" } });
    const secondEvent = await readResumed();
    // The resumed stream starts after the cursor: no duplicate delivery.
    expect(secondEvent.id).not.toBe(firstEvent.id);
    expect(secondEvent.data).not.toBe(firstEvent.data);
    second.abort();
  });

  it("returns the same session/history page for limit and beforeItemId", async () => {
    const direct = await host.harness.connect(OWNER_TOKEN);
    // The newest page: a limit below the transcript size must truncate it.
    const wsPage = await direct.client.request<{ items: Array<{ id: string }>; hasMore: boolean }>("session/history", {
      sessionId: "s1",
      limit: 5,
    });
    const httpPage = await command(gateway, {
      hostId: host.hostId,
      token,
      method: "session/history",
      params: { sessionId: "s1", limit: 5 },
    });
    expect(httpPage.status).toBe(200);
    const gatewayPage = httpPage.payload.result as { items: Array<{ id: string }>; hasMore: boolean };
    expect(gatewayPage).toEqual(wsPage);
    // The query string actually reached the Host: five of twelve items.
    expect(wsPage.items).toHaveLength(5);
    expect(wsPage.items.at(-1)?.id).toBe("item_12");
    expect(wsPage.hasMore).toBe(true);

    // Paging backwards from a cursor returns the page that ends before it.
    const before = wsPage.items[0]!.id;
    const wsOlder = await direct.client.request<{ items: Array<{ id: string }>; hasMore: boolean }>("session/history", {
      sessionId: "s1",
      beforeItemId: before,
      limit: 4,
    });
    const httpOlder = await command(gateway, {
      hostId: host.hostId,
      token,
      method: "session/history",
      params: { sessionId: "s1", beforeItemId: before, limit: 4 },
    });
    expect(httpOlder.status).toBe(200);
    expect(httpOlder.payload.result).toEqual(wsOlder);
    // `beforeItemId` is exclusive: the page stops just before that item.
    expect(wsOlder.items.map((item) => item.id)).toEqual(["item_04", "item_05", "item_06", "item_07"]);
    direct.client.close();
  });

  it("answers a server-initiated request with CAPABILITY_UNAVAILABLE instead of deciding", async () => {
    // A fake link carries the real mux: the test pushes Host frames into the
    // same channel the Gateway reads, so no mux method is stubbed out.
    const socket = new FakeHostLinkSocket();
    const mux = new HostLinkGatewayMux(socket, () => undefined);
    const connection = new LogicalConnection({
      identity: { hostId: "host_test", deviceId: "dev_x", credential: "pdt1.fixture" },
      mux,
      log: () => undefined,
    });
    const sent = socket.sentFrames();
    expect(sent[0]?.type).toBe("client.open");
    const pending = connection.request("session/list").catch((error: unknown) => error);
    socket.receive({
      link: RACP_HOSTLINK_VERSION,
      type: "host.message",
      clientConnectionId: connection.id,
      message: encodeFrame({
        jsonrpc: "2.0",
        id: "srv_1",
        method: "approval/request",
        params: { approvalId: "approval_1", sessionId: "s1" },
      }),
    });
    // The Gateway replies on the same logical connection with a JSON-RPC error.
    const reply = socket
      .sentFrames()
      .filter((frame) => frame.type === "client.message")
      .map((frame) => JSON.parse(String(frame.message)) as { id: string; error?: { data?: { code?: string } } })
      .find((message) => message.id === "srv_1");
    expect(reply?.error?.data?.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(reply?.error?.data?.code).not.toBe("FORBIDDEN");
    // The unanswered command still fails cleanly once the link goes away.
    socket.closeFromGateway();
    const result = await pending;
    expect(result).toBeInstanceOf(GatewayRpcError);
    expect((result as GatewayRpcError).code).toBe("AGENT_UNAVAILABLE");
  });
});
