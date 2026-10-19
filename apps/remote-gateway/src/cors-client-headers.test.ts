/**
 * Cross-origin headers for the native app (RACP-HTTP + SSE, protocol §11.2).
 *
 * The iOS/Android app loads from `capacitor://localhost` (or
 * `https://localhost`), so every RACP command and every event stream is a
 * cross-origin request: the browser sends a preflight first and refuses the real
 * request when any header the client adds is missing from
 * `access-control-allow-headers`. The web build is same-origin and never
 * preflights, and the Node smoke tests are not browsers, so this contract is
 * only exercised here.
 *
 * The header names come from one shared list, so a header the client starts
 * sending cannot silently drift away from what the Gateway allows.
 */
import { createHttpSseClient } from "@minih-agent/racp/browser";
import { RACP_HTTP_CORS_ALLOW_HEADERS, RACP_HTTP_CORS_EXPOSE_HEADERS } from "@minih-agent/shared";
import { afterEach, describe, expect, it } from "vitest";

import { enrollTestHost, startTestGateway, type TestGateway, type TestHost } from "./test-support.js";

const NATIVE_ORIGIN = "capacitor://localhost";

let gateway: TestGateway | null = null;
let host: TestHost | null = null;

afterEach(async () => {
  await host?.stop();
  host = null;
  await gateway?.close();
  gateway = null;
});

async function boot(): Promise<{ gateway: TestGateway; host: TestHost }> {
  gateway = await startTestGateway({ allowedOrigins: [NATIVE_ORIGIN] });
  host = await enrollTestHost(gateway);
  return { gateway, host };
}

/**
 * Request headers a browser clears on preflight, lowercased.
 *
 * The CORS-safelisted ones (`accept`, `accept-language`, `content-language`,
 * `range`) never need to be allowed. `content-type` stays in the list on purpose:
 * only `text/plain`, `multipart/form-data` and
 * `application/x-www-form-urlencoded` are safelisted values, and RACP commands
 * send `application/json`.
 */
const SAFELISTED = new Set(["accept", "accept-language", "content-language", "range"]);

/**
 * Every non-safelisted request header the RACP HTTP client actually sends.
 *
 * Captured from the client itself rather than restated by hand: the point of the
 * test is that the two sides cannot drift.
 */
async function clientRequestHeaders(baseUrl: string, hostId: string): Promise<string[]> {
  const captured = new Set<string>();
  const record = (init?: RequestInit) => {
    for (const [name] of new Headers(init?.headers)) captured.add(name.toLowerCase());
  };
  // Auth mode `cookie` adds `x-csrf-token`; `header` adds `authorization`. Both
  // have to clear the preflight, so the bare header profile is captured first
  // and the CSRF header is taken from the shared list below.
  const client = createHttpSseClient({
    baseUrl,
    auth: { kind: "header", token: () => "pdt1_placeholder_token" },
    client: { name: "minih-agent-ios", version: "0.0.0-test" },
    eventsPath: `/hosts/${hostId}/v1/events`,
    onEvent: () => undefined,
    reconnect: { enabled: false },
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      record(init);
      const url = String(input);
      if (url.endsWith("/v1/events")) {
        // One event-free stream that ends immediately: the client stops after it
        // because reconnect is disabled.
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ result: { sessions: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
  await client.request("session/list", {});
  await client.stream();
  client.close();
  // The CSRF header only appears in the cookie profile; it is part of the same
  // contract, so it is asserted through the shared list instead.
  const cookieClient = createHttpSseClient({
    baseUrl,
    auth: { kind: "cookie", csrfToken: () => "csrf_placeholder" },
    client: { name: "minih-agent-ios", version: "0.0.0-test" },
    eventsPath: `/hosts/${hostId}/v1/events`,
    onEvent: () => undefined,
    reconnect: { enabled: false },
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      record(init);
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  await cookieClient.request("session/list", {});
  cookieClient.close();
  return [...captured].filter((name) => !SAFELISTED.has(name)).sort();
}

function allowedHeaders(response: Response): string[] {
  return (response.headers.get("access-control-allow-headers") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

describe("native app preflight (D666 follow-up)", () => {
  it("allows every header the RACP HTTP client sends", async () => {
    const { gateway, host } = await boot();
    const sent = await clientRequestHeaders(gateway.clientBaseUrl, host.hostId);
    // The capture is real: the client sends the header the native app choked on.
    expect(sent).toContain("x-minih-racp-client");
    expect(sent).toContain("authorization");
    expect(sent).toContain("x-csrf-token");

    const response = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/sessions`, {
      method: "OPTIONS",
      headers: {
        origin: NATIVE_ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": sent.join(","),
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(NATIVE_ORIGIN);
    const allowed = allowedHeaders(response);
    for (const header of sent) {
      expect(allowed, `the preflight must allow ${header}`).toContain(header);
    }
    // The shared list is what the Gateway answers with, so a header added to the
    // client without the list fails here instead of on a phone.
    expect(allowed).toEqual([...RACP_HTTP_CORS_ALLOW_HEADERS].sort());
  });

  it("exposes the trace id to an allowed origin on success and on failure", async () => {
    const { gateway, host } = await boot();
    const ok = await fetch(`${gateway.clientBaseUrl}/healthz`, { headers: { origin: NATIVE_ORIGIN } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-trace-id")).toBeTruthy();
    expect((ok.headers.get("access-control-expose-headers") ?? "").toLowerCase()).toContain("x-trace-id");

    // An error response carries the same exposure: the client reads trace ids off
    // failures more often than off successes.
    const failure = await fetch(`${gateway.clientBaseUrl}/hosts/${host.hostId}/v1/sessions`, {
      headers: { origin: NATIVE_ORIGIN },
    });
    expect(failure.ok).toBe(false);
    expect(failure.headers.get("x-trace-id")).toBeTruthy();
    expect((failure.headers.get("access-control-expose-headers") ?? "").toLowerCase()).toContain("x-trace-id");
    expect([...RACP_HTTP_CORS_EXPOSE_HEADERS]).toContain("x-trace-id");
  });

  it("keeps the exposure off an origin outside the allowlist", async () => {
    const { gateway } = await boot();
    const response = await fetch(`${gateway.clientBaseUrl}/healthz`, { headers: { origin: "https://evil.test" } });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-expose-headers")).toBeNull();
  });
});
