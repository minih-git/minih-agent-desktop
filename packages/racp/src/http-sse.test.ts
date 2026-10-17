import { describe, expect, it } from "vitest";
import {
  RACP_HTTP_ROUTE_LIST,
  RACP_METHOD_HTTP_ROUTES,
  formatRacpCursor,
  parseSseLastEventId,
} from "@minih-agent/shared";

import { createHttpSseClient, type HttpSseClientOptions } from "./http-sse.js";

const durableEnvelope = {
  eventId: "evt_1",
  scope: "session",
  sessionId: "ses_1",
  epoch: "ep_7f",
  sequence: 314,
  revision: 22,
  kind: "turn.started",
  occurredAt: "2026-10-17T00:00:01.000Z",
  payload: {},
};
const ephemeralEnvelope = {
  ...durableEnvelope,
  eventId: "evt_2",
  sequence: undefined,
  afterSequence: 314,
  kind: "item.delta",
};
const chunk = (envelope: object) => `id: ep_7f:${(envelope as { sequence?: number; afterSequence?: number }).sequence ?? (envelope as { afterSequence?: number }).afterSequence}\nevent: racp.event\ndata: ${JSON.stringify(envelope)}\n\n`;

const baseOptions = {
  baseUrl: "https://gateway.test",
  auth: { kind: "header", token: () => "pdt1_fixture_token" } as const,
  client: { name: "test", version: "0.15.0" },
  eventsPath: "/v1/sessions/ses_1/events",
  onEvent: () => undefined,
};

describe("http route derivation (fix 4)", () => {
  it("asserts the method and path of every route in the shared table", async () => {
    for (const [name, spec] of Object.entries(RACP_HTTP_ROUTE_LIST)) {
      const [httpMethod, template] = spec.split(" ") as ["GET" | "POST", string];
      // Fill path parameters with fixture values.
      const path = template
        .replace("{hostId}", "host_1")
        .replace("{sessionId}", "ses_1")
        .replace("{turnId}", "turn_1")
        .replace("{approvalId}", "appr_1")
        .replace("{inputId}", "in_1");
      const requests: Request[] = [];
      const client = createHttpSseClient({
        ...baseOptions,
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          requests.push(new Request(input, init));
          return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
        }) as unknown as typeof fetch,
      });
      const method = Object.entries(RACP_METHOD_HTTP_ROUTES).find(([, route]) => route === name)?.[0];
      if (!method) continue;
      await client.request(method, { hostId: "host_1", sessionId: "ses_1", turnId: "turn_1", approvalId: "appr_1", inputId: "in_1" });
      expect(requests, `route ${name}`).toHaveLength(1);
      expect(requests[0]!.method, `route ${name} method`).toBe(httpMethod);
      expect(requests[0]!.url, `route ${name} path`).toBe(`https://gateway.test${path}`);
    }
  });

  it("reads session/list as GET /v1/sessions (was wrongly POST)", async () => {
    const requests: Request[] = [];
    const client = createHttpSseClient({
      ...baseOptions,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ result: { sessions: [] } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.request("session/list", {});
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe("https://gateway.test/v1/sessions");
  });

  it("throws INVALID_PARAMS for an unmapped method and for missing path parameters", async () => {
    const client = createHttpSseClient({
      ...baseOptions,
      fetchImpl: (async () => new Response(JSON.stringify({ result: {} }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(client.request("terminal/open", { sessionId: "ses_1" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(client.request("session/get", {})).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(client.request("turn/stop", { sessionId: "ses_1" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });
});

describe("event stream (fix 5: Last-Event-ID in the header)", () => {
  it("carries the durable cursor in the Last-Event-ID header and never in the URL", async () => {
    const requests: Request[] = [];
    const events: unknown[] = [];
    const encoder = new TextEncoder();
    const client = createHttpSseClient({
      ...baseOptions,
      sleep: async () => undefined,
      onEvent: (envelope) => events.push(envelope),
      // Bound the loop deterministically: close during the third sleep.
      sleep: async () => {
        if (requests.length >= 3) client.close();
      },
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        // Every stream delivers one durable + one ephemeral event and then
        // ends (the worker-safe way to model a drop). The loop is bounded by
        // close() from the injected sleep above.
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(encoder.encode(chunk(durableEnvelope) + chunk(ephemeralEnvelope)));
              streamController.close();
            },
          }),
        );
      }) as unknown as typeof fetch,
    });
    await client.stream();
    expect(events.length).toBeGreaterThanOrEqual(4);
    // Only durable events advance the cursor: the ephemeral event does not.
    expect(client.lastCursor).toEqual({ epoch: "ep_7f", sequence: 314 });
    expect(requests.length).toBeGreaterThanOrEqual(2);
    // First request: no cursor yet, and no cursor in the URL ever.
    expect(requests[0]!.url).not.toContain("lastEventId");
    expect(requests[0]!.url).not.toContain("last-event-id");
    expect(requests[0]!.headers.get("last-event-id")).toBeNull();
    // Second request (the reconnect) carries the previous durable cursor in
    // the header and keeps the URL free of query parameters.
    expect(requests[1]!.headers.get("last-event-id")).toBe("ep_7f:314");
    expect(requests[1]!.url).toBe(`${baseOptions.baseUrl}${baseOptions.eventsPath}`);
  });

  it("keeps the token in the Authorization header and out of every URL", async () => {
    const requests: Request[] = [];
    const client = createHttpSseClient({
      ...baseOptions,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.request("session/list", {});
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer pdt1_fixture_token");
    expect(requests[0]!.url).not.toContain("pdt1");
  });

  it("close() stops reconnecting", async () => {
    const requests: Request[] = [];
    let sleepCalls = 0;
    const client = createHttpSseClient({
      ...baseOptions,
      sleep: async () => {
        sleepCalls += 1;
        client.close();
      },
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response("{}", { status: 500 });
      }) as unknown as typeof fetch,
    });
    await client.stream();
    expect(requests).toHaveLength(1);
    expect(sleepCalls).toBeLessThanOrEqual(1);
  });

  it("serializes the cursor in the Last-Event-ID form", () => {
    expect(parseSseLastEventId(formatRacpCursor({ epoch: "ep_7f", sequence: 314 }))).toEqual({ epoch: "ep_7f", sequence: 314 });
  });
});

describe("command profile", () => {
  it("uses the cookie profile with credentials include and a CSRF header", async () => {
    const requests: Request[] = [];
    const client = createHttpSseClient({
      ...baseOptions,
      auth: { kind: "cookie", csrfToken: () => "csrf-fixture" },
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response(JSON.stringify({ result: {} }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.request("session/list", {});
    expect(requests[0]!.headers.get("x-csrf-token")).toBe("csrf-fixture");
    expect(requests[0]!.headers.get("authorization")).toBeNull();
    expect(requests[0]!.credentials).toBe("include");
  });

  it("maps RACP error payloads onto RacpError without changing the code", async () => {
    const client = createHttpSseClient({
      ...baseOptions,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { code: -32000, message: "no", data: { code: "FORBIDDEN", message: "no session", retriable: false, traceId: "t1" } } }), { status: 403 })) as unknown as typeof fetch,
    });
    await expect(client.request("session/list", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps reconnecting past maxAttempts while streams deliver events (fix B a)", async () => {
    let fetchCount = 0;
    const encoder = new TextEncoder();
    let closed = false;
    const client = createHttpSseClient({
      ...baseOptions,
      reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 4000, maxAttempts: 3 },
      sleep: async () => {
        // With the counter reset on delivered events, the loop keeps going:
        // end it deterministically after the 10th backoff.
        if (fetchCount >= 10 && !closed) {
          closed = true;
          client.close();
        }
      },
      fetchImpl: (async () => {
        fetchCount += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(encoder.encode(chunk(durableEnvelope)));
              streamController.close();
            },
          }),
        );
      }) as unknown as typeof fetch,
    });
    await client.stream();
    expect(fetchCount).toBeGreaterThan(4);
  });

  it("stops after maxAttempts when no stream ever delivers an event (fix B b)", async () => {
    let fetchCount = 0;
    const delays: number[] = [];
    const client = createHttpSseClient({
      ...baseOptions,
      reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 4000, maxAttempts: 3 },
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      fetchImpl: (async () => {
        fetchCount += 1;
        // Every stream ends without delivering a single event: pure failure.
        return new Response(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }));
      }) as unknown as typeof fetch,
    });
    await client.stream();
    expect(fetchCount).toBe(4);
    expect(delays).toEqual([500, 1000, 2000]);
  });

  it("does not resend mutating requests across a stream drop and reconnect", async () => {
    const requests: Request[] = [];
    const encoder = new TextEncoder();
    const client = createHttpSseClient({
      ...baseOptions,
      sleep: async () => undefined,
      // Bound the loop deterministically: close during the third sleep.
      sleep: async () => {
        if (requests.filter((request) => request.method === "GET").length >= 3) client.close();
      },
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "POST") {
          // turn/start succeeds once; it is never replayed.
          return new Response(JSON.stringify({ result: { turnId: "turn_1" } }), { status: 200 });
        }
        // Event stream: one durable event, then the server ends the stream.
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(encoder.encode(chunk(durableEnvelope)));
              streamController.close();
            },
          }),
        );
      }) as unknown as typeof fetch,
    });
    await client.request("turn/start", { sessionId: "ses_1", input: { text: "go" } }, "idem-1");
    await client.stream();
    const posts = requests.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://gateway.test/v1/sessions/ses_1/turns");
    const gets = requests.filter((request) => request.method === "GET");
    expect(gets.length).toBeGreaterThanOrEqual(2);
    for (const get of gets) {
      expect(get.url).toBe(`${baseOptions.baseUrl}${baseOptions.eventsPath}`);
    }
  });

  it("reports a reconnection with the configured backoff through the injected sleep (fix 6)", async () => {
    const delays: number[] = [];
    let attempt = 0;
    const client = createHttpSseClient({
      ...baseOptions,
      reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 4000, maxAttempts: 3 },
      sleep: (ms) => {
        delays.push(ms);
        if (delays.length >= 3) client.close();
        return Promise.resolve();
      },
      fetchImpl: (async () => {
        attempt += 1;
        // Every stream drops mid-flight so the client takes the catch path,
        // where the backoff and maxAttempts accounting lives.
        throw new Error(`stream drop ${attempt}`);
      }) as unknown as typeof fetch,
    });
    await client.stream();
    expect(delays).toEqual([500, 1000, 2000]);
    expect(attempt).toBe(delays.length);
  });
});
