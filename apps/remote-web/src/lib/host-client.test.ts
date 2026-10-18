import type { RacpEventEnvelope } from "@minih-agent/shared";
import { describe, expect, it } from "vitest";

import { createHostClient, hostBaseUrl, hostEventsPath, sessionEventsPath } from "./host-client.js";

type Call = { url: string; init: RequestInit | undefined };

function recordingFetch(response: (call: Call) => Response): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return Promise.resolve(response(call));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function envelope(sequence: number): RacpEventEnvelope {
  return {
    eventId: `e${sequence}`,
    scope: "session",
    sessionId: "s1",
    epoch: "ep",
    sequence,
    revision: sequence,
    kind: "turn.started",
    occurredAt: "2026-09-18T10:00:00.000Z",
    payload: {},
  };
}

function client(response: (call: Call) => Response) {
  const events: RacpEventEnvelope[] = [];
  const { fetchImpl, calls } = recordingFetch(response);
  return {
    events,
    calls,
    hostClient: createHostClient({
      gatewayOrigin: "https://gw.example.com",
      hostId: "host1",
      credential: { kind: "cookie", csrfToken: "csrf-1" },
      onEvent: (event) => events.push(event),
      fetchImpl,
    }),
  };
}

describe("host paths", () => {
  it("scopes every call to the host and trims a trailing slash", () => {
    expect(hostBaseUrl("https://gw.example.com/", "host1")).toBe("https://gw.example.com/hosts/host1");
    expect(sessionEventsPath("s/1")).toBe("/v1/sessions/s%2F1/events");
    expect(hostEventsPath()).toBe("/v1/events");
  });
});

describe("createHostClient", () => {
  it("sends a mutation as a JSON-RPC command with the CSRF header and the idempotency key", async () => {
    const { hostClient, calls } = client(() => jsonResponse({ result: { accepted: true, turn: { id: "t1" } } }));
    const result = await hostClient.request<{ turn: { id: string } }>(
      "turn/start",
      { sessionId: "s1", input: { text: "hi" } },
      "idem_1",
    );

    expect(result.turn.id).toBe("t1");
    expect(calls[0]!.url).toBe("https://gw.example.com/hosts/host1/v1/sessions/s1/turns");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("include");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["x-csrf-token"]).toBe("csrf-1");
    expect(headers["x-minih-racp-client"]).toContain("minih-remote-web/");
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({
      jsonrpc: "2.0",
      method: "turn/start",
      params: { sessionId: "s1", input: { text: "hi" } },
      idempotencyKey: "idem_1",
    });
  });

  it("reads a list as a GET without a query string", async () => {
    const { hostClient, calls } = client(() => jsonResponse({ result: { sessions: [] } }));
    await hostClient.request("session/list", {});
    expect(calls[0]!.url).toBe("https://gw.example.com/hosts/host1/v1/sessions");
    expect(calls[0]!.init?.method).toBe("GET");
  });

  it("refuses a method with no HTTP mapping instead of inventing a path", async () => {
    const { hostClient, calls } = client(() => jsonResponse({ result: {} }));
    await expect(hostClient.request("connection/initialize", {})).rejects.toThrow(/no HTTP command mapping/);
    expect(calls).toHaveLength(0);
  });

  it("streams events and resumes with Last-Event-ID", async () => {
    let frame = `id: ep:7\nevent: racp.event\ndata: ${JSON.stringify(envelope(7))}\n\n`;
    const { hostClient, calls, events } = client(() => sseResponse([frame]));
    await hostClient.stream(sessionEventsPath("s1"));
    expect(calls[0]!.url).toBe("https://gw.example.com/hosts/host1/v1/sessions/s1/events");
    expect((calls[0]!.init?.headers as Record<string, string>).accept).toBe("text/event-stream");
    expect(events.map((event) => event.eventId)).toEqual(["e7"]);
    expect(hostClient.lastCursor(sessionEventsPath("s1"))).toEqual({ epoch: "ep", sequence: 7 });

    frame = "";
    await hostClient.stream(sessionEventsPath("s1"));
    expect((calls[1]!.init?.headers as Record<string, string>)["last-event-id"]).toBe("ep:7");
  });

  it("closes every stream it opened", async () => {
    const { hostClient, calls } = client(() => sseResponse([]));
    await hostClient.stream(sessionEventsPath("s1"));
    hostClient.close();
    expect(calls).toHaveLength(1);
  });
});
