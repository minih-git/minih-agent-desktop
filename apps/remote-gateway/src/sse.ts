/**
 * Server-Sent Events relay (protocol §11.2, §11.4 rule 3). Each stream owns a
 * logical connection, subscribes with the cursor from `Last-Event-ID`, prints
 * `formatSseEvent` frames, and sends a `: ping` comment every 15 seconds so a
 * proxy does not close an idle stream. Durable events are never dropped: if
 * the Host's bounded queue overflows, the Host closes the logical connection
 * with `CLIENT_TOO_SLOW` and the client resumes from its cursor.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  RACP_EVENT_NOTIFICATION,
  RACP_SUBSCRIPTION_CLOSED_NOTIFICATION,
  formatSseEvent,
  parseSseLastEventId,
  type RacpCursor,
  type RacpEventEnvelope,
} from "@minih-agent/shared";

import type { GatewayLog } from "./router.js";
import { GatewayRpcError, LogicalConnectionPool, type ConnectionIdentity } from "./router.js";

export type StreamSubscription = { scope: "session"; sessionId: string } | { scope: "host" };

const PING_INTERVAL_MS = 15_000;

function writeChunk(response: ServerResponse, text: string): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(text);
}

export type ServeStreamOptions = {
  request: IncomingMessage;
  response: ServerResponse;
  pool: LogicalConnectionPool;
  identity: ConnectionIdentity;
  subscription: StreamSubscription;
  /** Raw `Last-Event-ID` header; parsed here so the cursor stays a header. */
  lastEventId: string | null;
  log: GatewayLog;
  corsHeaders?: Record<string, string>;
};

/**
 * Relay one subscription until either side closes. Resolves once the response
 * has ended; the caller does not write anything else afterwards.
 */
export async function serveEventStream(options: ServeStreamOptions): Promise<void> {
  const { request, response, pool, identity, subscription, log } = options;
  // Nothing has been written yet, so a failure here still reaches the client
  // as a JSON error from the caller.
  const connection = await pool.stream(identity);
  const after: RacpCursor | null = options.lastEventId ? parseSseLastEventId(options.lastEventId) : null;
  let subscriptionId: string | null = null;
  let finished = false;
  let ping: ReturnType<typeof setInterval> | null = null;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (ping) clearInterval(ping);
    if (subscriptionId && !connection.isClosed) {
      // Best effort: the Host may already have dropped the connection.
      void connection.request("events/unsubscribe", { subscriptionId }, 2_000).catch(() => undefined);
    }
    connection.close("the event stream ended");
    if (!response.writableEnded) response.end();
  };
  ping = setInterval(() => writeChunk(response, ": ping\n\n"), PING_INTERVAL_MS);
  ping.unref?.();

  connection.onNotification((method, params) => {
    if (method === RACP_EVENT_NOTIFICATION) {
      const envelope = params as RacpEventEnvelope;
      writeChunk(response, formatSseEvent(envelope));
      return;
    }
    if (method === RACP_SUBSCRIPTION_CLOSED_NOTIFICATION) {
      const notice = params as { subscriptionId?: string; error?: { code?: string } };
      log("warn", "gateway subscription closed by the Host", {
        clientConnectionId: connection.id,
        code: notice.error?.code,
      });
      finish();
    }
  });
  connection.onClose(() => finish());
  const onClientClose = () => finish();
  request.on("close", onClientClose);

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Nginx must not buffer the stream (README deployment section).
    "x-accel-buffering": "no",
    ...options.corsHeaders,
  });
  response.flushHeaders?.();

  try {
    const result = await connection.request<{ subscriptionId: string }>("events/subscribe", {
      ...subscription,
      ...(after ? { after } : {}),
    });
    subscriptionId = result.subscriptionId;
  } catch (error) {
    const code = error instanceof GatewayRpcError ? error.code : "INTERNAL";
    log("warn", "gateway could not subscribe", { code, clientConnectionId: connection.id });
    // The stream already started; tell the client why it ends.
    writeChunk(response, `event: racp.error\ndata: ${JSON.stringify({ code })}\n\n`);
    finish();
    return;
  }
  if (finished) return;
  // Hold the response open until either side ends it.
  await new Promise<void>((resolve) => {
    if (response.writableEnded || response.destroyed) {
      resolve();
      return;
    }
    response.once("close", () => {
      request.off("close", onClientClose);
      finish();
      resolve();
    });
  });
}
