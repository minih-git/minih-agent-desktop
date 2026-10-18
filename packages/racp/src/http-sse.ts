/**
 * `RACP-HTTP` + SSE client (protocol spec §11.2, D665 / ADR 0330). Commands go
 * out as `fetch` requests whose method and path derive from the shared
 * `RACP_HTTP_ROUTE_LIST` (GET for reads, POST for mutations); events stream
 * through `fetch`-based SSE so the browser can set headers (the header
 * profile) or rely on cookies plus a CSRF header (the cookie profile,
 * `credentials: "include"`).
 *
 * Reconnect reuses the `RacpClientOptions.reconnect` backoff shape and sends
 * `Last-Event-ID`; a dropped stream never re-sends commands, because every
 * command is an independent HTTP request that either completed or failed
 * before the stream dropped (§11.2: "Commands return JSON and never require
 * the caller to keep a request open for turn execution").
 */
import {
  RACP_HTTP_QUERY_PARAMS,
  RACP_HTTP_ROUTE_LIST,
  RACP_HTTP_ROUTE_PARAMS,
  RACP_METHOD_HTTP_ROUTES,
  formatRacpCursor,
  parseSseLastEventId,
  type RacpCursor,
  type RacpEventEnvelope,
  type RacpRemoteError,
} from "@minih-agent/shared";
import { RacpError } from "@minih-agent/agent-host";

import { errorFromObject, isNotification, isRequest, isResponse, parseFrame, type JsonRpcMessage } from "./jsonrpc.js";

export type HttpSseAuthMode =
  | { kind: "header"; token: () => string }
  /** Cookie profile: the browser sends the session cookie; every mutation carries the CSRF header. */
  | { kind: "cookie"; csrfToken: () => string };

export type HttpSseClientOptions = {
  /** Base URL of the Gateway, e.g. `https://gw.example.com`. */
  baseUrl: string;
  auth: HttpSseAuthMode;
  client: { name: string; version: string };
  /** Per-session event stream; the host stream uses `/v1/events`. */
  eventsPath: string;
  onEvent: (envelope: RacpEventEnvelope) => void;
  /** Called when the stream drops; the client reconnects with `Last-Event-ID`. */
  log?: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
  /** Backoff shape, mirroring `RacpClientOptions.reconnect`. */
  reconnect?: { enabled: boolean; baseDelayMs?: number; maxDelayMs?: number; maxAttempts?: number };
  sleep?: (ms: number) => Promise<void>;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Abort signal owned by the caller (page unload, view disposal). */
  signal?: AbortSignal;
};

export type HttpSseClient = {
  /** Send one RACP command; resolves with the JSON result or throws the mapped `RacpError`. */
  request(method: string, params: Record<string, unknown>, idempotencyKey?: string): Promise<unknown>;
  /** (Re)open the SSE stream from the given cursor. */
  stream(): Promise<void>;
  /** Stop streaming and abort in-flight reconnects. */
  close(): void;
  get lastCursor(): RacpCursor | null;
};

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 15_000;

export function createHttpSseClient(options: HttpSseClientOptions): HttpSseClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastCursor: RacpCursor | null = null;
  let generation = 0;
  let closed = false;
  let reconnectAttempt = 0;
  let controller: AbortController | null = null;

  function headers(extra?: Record<string, string>): Record<string, string> {
    const base: Record<string, string> = {
      "content-type": "application/json",
      "x-minih-racp-client": `${options.client.name}/${options.client.version}`,
      ...extra,
    };
    if (options.auth.kind === "header") base.authorization = `Bearer ${options.auth.token()}`;
    else base["x-csrf-token"] = options.auth.csrfToken();
    return base;
  }

  async function request(method: string, params: Record<string, unknown>, idempotencyKey?: string): Promise<unknown> {
    const routeName = RACP_METHOD_HTTP_ROUTES[method];
    if (!routeName) {
      throw new RacpError("INVALID_ARGUMENT", `the RACP method ${method} has no HTTP command mapping`);
    }
    const spec = RACP_HTTP_ROUTE_LIST[routeName];
    const [httpMethod, template] = spec.split(" ") as ["GET" | "POST", string];
    const path = fillPathParams(routeName, template, method, params);
    const query = httpMethod === "GET" ? buildQuery(routeName, method, params) : "";
    const body =
      httpMethod === "POST"
        ? JSON.stringify({ jsonrpc: "2.0", id: `${method}:${Date.now()}`, method, params, ...(idempotencyKey ? { idempotencyKey } : {}) })
        : undefined;
    const response = await fetchImpl(`${options.baseUrl}${path}${query}`, {
      method: httpMethod,
      headers: headers(),
      credentials: options.auth.kind === "cookie" ? "include" : "same-origin",
      ...(body !== undefined ? { body } : {}),
      signal: options.signal,
    });
    const payload = (await response.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
    if (!response.ok || !payload || payload.error) {
      const error = payload?.error as
        | { code?: string; message?: string; data?: { code: string; message: string; retriable: boolean; traceId: string; details?: unknown } }
        | undefined;
      // RACP errors ride the JSON-RPC error envelope (spec §14a): the shared
      // RemoteError lives under `error.data`; a bare HTTP failure maps to INTERNAL.
      const remote = error?.data ?? {
        code: "INTERNAL",
        message: `HTTP ${response.status}`,
        retriable: response.status >= 500 || response.status === 429,
        traceId: response.headers.get("x-trace-id") ?? "",
      };
      throw errorFromObject({
        code: 0,
        message: remote.message ?? `HTTP ${response.status}`,
        data: remote,
      });
    }
    return payload.result;
  }

  async function stream(): Promise<void> {
    generation += 1;
    const myGeneration = generation;
    closed = false;
    const backoff = options.reconnect ?? { enabled: true };
    while (!closed && generation === myGeneration) {
      controller = new AbortController();
      // Spec §11.2: the cursor travels in the Last-Event-ID header as
      // "<epoch>:<sequence>", never in the URL.
      const cursorHeader: Record<string, string> = lastCursor ? { "last-event-id": formatRacpCursor(lastCursor) } : {};
      try {
        const response = await fetchImpl(`${options.baseUrl}${options.eventsPath}`, {
          method: "GET",
          headers: headers({ accept: "text/event-stream", ...cursorHeader }),
          credentials: options.auth.kind === "cookie" ? "include" : "same-origin",
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`event stream returned HTTP ${response.status}`);
        }
        let delivered = false;
        await consumeSse(response.body, (envelope) => {
          delivered = true;
          if (envelope.sequence !== undefined) lastCursor = { epoch: envelope.epoch, sequence: envelope.sequence };
          options.onEvent(envelope);
        });
        // A stream that delivered at least one event was healthy: reset the
        // reconnect counter and the backoff, so a server that closes streams
        // after real events is not punished like a failing endpoint.
        if (delivered) reconnectAttempt = 0;
        // A stream that ends normally is still a drop: route it through the
        // same backoff accounting so maxAttempts bounds the reconnect loop
        // instead of spinning on a stream that closes immediately.
        throw new Error("the event stream ended");
      } catch (error: unknown) {
        if (closed || generation !== myGeneration) return;
        options.log?.("warn", "racp-http event stream dropped", { error: String(error) });
        if (backoff.enabled === false) return;
        reconnectAttempt += 1;
        if (backoff.maxAttempts !== undefined && reconnectAttempt > backoff.maxAttempts) {
          options.log?.("warn", "racp-http reconnect attempts exhausted", { attempts: reconnectAttempt });
          return;
        }
        const delay = Math.min((backoff.baseDelayMs ?? DEFAULT_BASE_DELAY_MS) * 2 ** (reconnectAttempt - 1), backoff.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
        await sleep(delay);
      } finally {
        controller?.abort();
        controller = null;
      }
    }
  }

  function close(): void {
    closed = true;
    generation += 1;
    controller?.abort();
    controller = null;
  }

  return {
    request,
    stream,
    close,
    get lastCursor() {
      return lastCursor;
    },
  };
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEnvelope: (envelope: RacpEventEnvelope) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastId = "";
  let eventName = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("id:")) lastId = line.slice(3).trim();
        else if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (!data) continue;
          const envelope = JSON.parse(data) as RacpEventEnvelope;
          if (lastId && envelope.sequence === undefined) {
            // Ephemeral events carry afterSequence; the SSE id still advances.
            const parsed = parseSseLastEventId(lastId);
            if (parsed) envelope.afterSequence = parsed.sequence;
          }
          onEnvelope(envelope);
        }
      }
      lastId = "";
      eventName = "";
      boundary = buffer.indexOf("\n\n");
    }
  }
}

/**
 * Substitute the route's path parameters from the call params. A missing
 * parameter is a caller bug: fail loudly instead of silently requesting
 * `/v1/sessions/`.
 */
function fillPathParams(
  routeName: keyof typeof RACP_HTTP_ROUTE_LIST,
  template: string,
  method: string,
  params: Record<string, unknown>,
): string {
  let path = template;
  for (const name of RACP_HTTP_ROUTE_PARAMS[routeName]) {
    const value = params[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new RacpError("INVALID_ARGUMENT", `the ${method} call needs a ${name} path parameter`);
    }
    path = path.replace(`{${name}}`, encodeURIComponent(value));
  }
  return path;
}

/** Query-string keys that would put a credential in a URL (security §3.1). */
const CREDENTIAL_PARAM = /(token|credential|secret|password|api[-_]?key|authorization)/i;

/**
 * Serialize the non-path parameters of a GET call (spec §11.2). The route table
 * declares which keys may travel in a query string and how each is encoded, so
 * an undeclared key fails loudly instead of being dropped — a credential-like
 * key is refused outright rather than leaking into the URL.
 */
function buildQuery(
  routeName: keyof typeof RACP_HTTP_ROUTE_LIST,
  method: string,
  params: Record<string, unknown>,
): string {
  const pathParams = new Set<string>(RACP_HTTP_ROUTE_PARAMS[routeName]);
  const declared = RACP_HTTP_QUERY_PARAMS[routeName];
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (pathParams.has(key) || value === undefined) continue;
    if (CREDENTIAL_PARAM.test(key)) {
      throw new RacpError("INVALID_ARGUMENT", `the ${method} call must never carry ${key} in the URL`);
    }
    const type = declared[key];
    if (type === undefined) {
      throw new RacpError("INVALID_ARGUMENT", `the ${method} call cannot carry ${key} in the query string`);
    }
    if (type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new RacpError("INVALID_ARGUMENT", `the ${method} call needs an integer ${key}`);
      }
    } else if (typeof value !== type) {
      throw new RacpError("INVALID_ARGUMENT", `the ${method} call needs a ${type} ${key}`);
    }
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** Re-exported for callers that need to inspect a server notification payload. */
export { isNotification, isRequest, isResponse, parseFrame, type JsonRpcMessage };
export type { RacpRemoteError };
