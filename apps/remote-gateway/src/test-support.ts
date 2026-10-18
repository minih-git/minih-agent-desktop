/**
 * Test support for the Gateway: boots a real Gateway on loopback with random
 * ports in a temporary data directory, enrols a real Host link client against
 * it, and pairs a device. Every port, directory, and key is per-test; nothing
 * leaves the machine.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enrollHostLink, startHostLink, type HostLinkCredentials, type HostLinkHandle } from "@minih-agent/racp";
import { harness, type Harness, type HarnessHistory } from "@minih-agent/racp/test-harness";
import {
  RACP_HTTP_QUERY_PARAMS,
  RACP_HTTP_ROUTE_LIST,
  RACP_HTTP_ROUTE_PARAMS,
  RACP_METHOD_HTTP_ROUTES,
  type RacpItemSummary,
} from "@minih-agent/shared";

import type { GatewayServeConfig } from "./config.js";
import type { GatewayLog } from "./router.js";
import { startGateway, type GatewayServer } from "./serve.js";

export type TestGateway = {
  gateway: GatewayServer;
  config: GatewayServeConfig;
  dataDir: string;
  /** `https://127.0.0.1:<port>` — the client API base URL. */
  clientBaseUrl: string;
  caPem: string;
  close: () => Promise<void>;
};

const silent: GatewayLog = () => undefined;

export async function startTestGateway(overrides: Partial<GatewayServeConfig> = {}): Promise<TestGateway> {
  // A short prefix keeps the unix admin socket inside the platform path limit.
  const dataDir = await mkdtemp(join(tmpdir(), "minih-gw-"));
  const config: GatewayServeConfig = {
    dataDir,
    hostlink: { host: "127.0.0.1", port: 0 },
    hostlinkAllowCidrs: [],
    client: { host: "127.0.0.1", port: 0 },
    allowedOrigins: ["https://app.test"],
    ...overrides,
  };
  const gateway = await startGateway(config, { log: silent, heartbeatMs: 60_000 });
  const caPem = await readFile(gateway.caCertificatePath, "utf8");
  return {
    gateway,
    config,
    dataDir,
    caPem,
    clientBaseUrl: `http://${gateway.client.host}:${gateway.client.port}`,
    close: async () => {
      await gateway.close();
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}

export type TestHost = {
  harness: Harness;
  credentials: HostLinkCredentials;
  handle: HostLinkHandle;
  hostId: string;
  stop: () => Promise<void>;
};

/**
 * A real Host: the racp test harness serves RACP, `startHostLink` opens the
 * outbound mTLS link, and enrollment uses the Gateway's real HTTP endpoint.
 */
export async function enrollTestHost(
  gateway: TestGateway,
  options: {
    hostId?: string;
    label?: string;
    gatewayCaPem?: string;
    enrollmentCode?: string;
    /** Transcript fixture the harness serves for `s1` (session/history paging). */
    history?: HarnessHistory;
  } = {},
): Promise<TestHost> {
  const hostId = options.hostId ?? "host_test";
  const code = options.enrollmentCode ?? (await gateway.gateway.enrollment.issueCode({ label: options.label ?? "test host" })).code;
  const credentials = await enrollHostLink({
    gatewayUrl: `wss://127.0.0.1:${gateway.gateway.hostlink.port}/v1/hostlink`,
    gatewayCaPem: options.gatewayCaPem ?? gateway.caPem,
    enrollmentCode: code,
    hostId,
    ...(options.label ? { label: options.label } : {}),
  });
  const h = await harness(options.history ? { history: options.history } : {});
  const handle = startHostLink({
    credentials,
    // The harness server identity must equal the enrolled host id.
    server: h.server,
    authenticator: h.authenticator,
    log: () => undefined,
    backoff: { baseDelayMs: 50, maxDelayMs: 100 },
  });
  await waitFor(() => handle.status().state === "connected", 10_000);
  return {
    harness: h,
    credentials,
    handle,
    hostId,
    stop: async () => {
      await handle.stop();
    },
  };
}

export async function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition was not met before the deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Issue a gateway-origin pairing token on the Host and pair a device through the Gateway. */
export async function pairDevice(
  gateway: TestGateway,
  host: TestHost,
  options: { client: "web" | "ios" | "android"; label?: string; origin?: string } = { client: "ios" },
): Promise<{ deviceId: string; token?: string; csrfToken?: string; setCookie: string[]; status: number }> {
  const pairing = await host.harness.authenticator.issuePairingToken(10 * 60 * 1000, "gateway");
  const response = await fetch(`${gateway.clientBaseUrl}/v1/hosts/${host.hostId}/pair`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pairing.token}`,
      ...(options.origin ? { origin: options.origin } : {}),
    },
    body: JSON.stringify({ deviceLabel: options.label ?? "test device", client: options.client }),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const payload = (await response.json()) as { deviceId?: string; token?: string; csrfToken?: string };
  return {
    status: response.status,
    deviceId: payload.deviceId ?? "",
    ...(payload.token ? { token: payload.token } : {}),
    ...(payload.csrfToken ? { csrfToken: payload.csrfToken } : {}),
    setCookie,
  };
}

/** Derive the HTTP method and path from the shared route table, like the client. */
function httpRouteFor(
  method: string,
  params: Record<string, unknown>,
): { routeName: keyof typeof RACP_HTTP_ROUTE_LIST; httpMethod: "GET" | "POST"; path: string } {
  const routeName = RACP_METHOD_HTTP_ROUTES[method];
  if (!routeName) throw new Error(`${method} has no HTTP route`);
  const [httpMethod, template] = RACP_HTTP_ROUTE_LIST[routeName].split(" ") as ["GET" | "POST", string];
  const path = RACP_HTTP_ROUTE_PARAMS[routeName].reduce((current, name) => {
    const value = params[name];
    if (typeof value !== "string" || value.length === 0) throw new Error(`${method} needs a ${name}`);
    return current.replace(`{${name}}`, encodeURIComponent(value));
  }, template);
  return { routeName, httpMethod, path };
}

/** Serialize the declared query parameters of a GET call, like the client does. */
function queryFor(routeName: keyof typeof RACP_HTTP_ROUTE_LIST, params: Record<string, unknown>): string {
  const declared = RACP_HTTP_QUERY_PARAMS[routeName];
  const query = new URLSearchParams();
  for (const [key, type] of Object.entries(declared)) {
    const value = params[key];
    if (value === undefined) continue;
    if (type === "integer" ? typeof value !== "number" : typeof value !== type) {
      throw new Error(`the ${key} of ${routeName} is not a ${type}`);
    }
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** A deterministic transcript fixture: `count` completed messages under `s1`. */
export function transcriptFixture(count: number): RacpItemSummary[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `item_${String(index + 1).padStart(2, "0")}`,
    turnId: "turn_1",
    itemType: "message" as const,
    status: "completed" as const,
    sequence: index + 1,
    createdAt: `2026-09-18T00:00:${String(index).padStart(2, "0")}.000Z`,
    content: { text: `message ${index + 1}` },
  }));
}

/** One command through the Gateway's RACP-HTTP API, with header auth. */
export async function command(
  gateway: TestGateway,
  input: {
    hostId: string;
    token: string;
    method: string;
    params: Record<string, unknown>;
    idempotencyKey?: string;
    path?: string;
    /** Raw query string, for tests that deliberately send an invalid one. */
    query?: string;
  },
): Promise<{ status: number; payload: { result?: unknown; error?: { data?: { code?: string } } } }> {
  const route = httpRouteFor(input.method, input.params);
  const path = input.path ?? route.path;
  const query = input.query ?? queryFor(route.routeName, input.params);
  const response = await fetch(`${gateway.clientBaseUrl}/hosts/${input.hostId}${path}${query}`, {
    method: route.httpMethod,
    headers: { "content-type": "application/json", authorization: `Bearer ${input.token}` },
    ...(route.httpMethod === "POST"
      ? {
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "t1",
            method: input.method,
            params: input.params,
            ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          }),
        }
      : {}),
  });
  return { status: response.status, payload: (await response.json()) as { result?: unknown; error?: { data?: { code?: string } } } };
}
