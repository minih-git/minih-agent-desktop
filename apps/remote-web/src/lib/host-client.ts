/**
 * Per-host RACP-HTTP client (PR-4).
 *
 * One host = one base URL (`/hosts/{hostId}`) plus the credential the port
 * hands out. Commands are plain HTTP requests; events stream through
 * `fetch`-based SSE, which sends the cursor back in the `Last-Event-ID` header
 * and never in the URL.
 *
 * Reconnection is owned by `StreamSupervisor` in this package, so the transport
 * is built with its own retry loop disabled: a hidden page must be able to
 * pause the stream, and the supervisor needs one settled promise per drop.
 */
import { createHttpSseClient, type HttpSseClient } from "@minih-agent/racp/browser";
import type { RacpCursor, RacpEventEnvelope } from "@minih-agent/shared";

import packageJson from "../../package.json";
import type { HostCredential } from "./credential-port.js";

export const CLIENT_NAME = "minih-remote-web";
export const CLIENT_VERSION: string = packageJson.version;

export type HostClientLog = (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;

export type HostClientOptions = {
  /** Origin of the Gateway that served this page; empty means "same origin". */
  gatewayOrigin: string;
  hostId: string;
  credential: HostCredential;
  onEvent: (envelope: RacpEventEnvelope) => void;
  log?: HostClientLog;
  fetchImpl?: typeof fetch;
};

export type HostClient = {
  readonly hostId: string;
  readonly baseUrl: string;
  /** One RACP command; `idempotencyKey` rides the command body (`turn/start`). */
  request<T = unknown>(method: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T>;
  /**
   * Open one event stream, optionally starting at a cursor (the snapshot's own
   * cursor on the first subscription); resolves when the stream ends.
   */
  stream(eventsPath: string, from?: RacpCursor): Promise<void>;
  /** Abort one event stream and its in-flight reconnect. */
  closeStream(eventsPath: string): void;
  close(): void;
  lastCursor(eventsPath: string): RacpCursor | null;
};

export function hostBaseUrl(gatewayOrigin: string, hostId: string): string {
  const origin = gatewayOrigin.replace(/\/+$/, "");
  return `${origin}/hosts/${encodeURIComponent(hostId)}`;
}

export function sessionEventsPath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/events`;
}

export function hostEventsPath(): string {
  return "/v1/events";
}

export function createHostClient(options: HostClientOptions): HostClient {
  const baseUrl = hostBaseUrl(options.gatewayOrigin, options.hostId);
  const credential = options.credential;
  const auth =
    credential.kind === "cookie"
      ? ({ kind: "cookie", csrfToken: () => credential.csrfToken } as const)
      : ({ kind: "header", token: () => credential.token } as const);

  const streams = new Map<string, HttpSseClient>();
  const streamFor = (eventsPath: string): HttpSseClient => {
    const existing = streams.get(eventsPath);
    if (existing) return existing;
    const client = createHttpSseClient({
      baseUrl,
      auth,
      client: { name: CLIENT_NAME, version: CLIENT_VERSION },
      eventsPath,
      onEvent: options.onEvent,
      reconnect: { enabled: false },
      ...(options.log ? { log: options.log } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    streams.set(eventsPath, client);
    return client;
  };

  // Commands never touch a stream; the host-scope client is used as the
  // command channel so a host stream can still be opened on it later.
  const commandClient = streamFor(hostEventsPath());

  return {
    hostId: options.hostId,
    baseUrl,
    request: <T,>(method: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> =>
      commandClient.request(method, params, idempotencyKey) as Promise<T>,
    stream: (eventsPath, from) => streamFor(eventsPath).stream(from),
    closeStream: (eventsPath) => {
      streams.get(eventsPath)?.close();
    },
    close: () => {
      for (const client of streams.values()) client.close();
    },
    lastCursor: (eventsPath) => streams.get(eventsPath)?.lastCursor ?? null,
  };
}
