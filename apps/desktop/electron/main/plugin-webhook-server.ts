import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { normalizeWebhookSource, WebhookSourceFilter } from "./plugin-webhook-network";

export const WEBHOOK_DEFAULT_PORT = 37124;
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
export const WEBHOOK_MAX_RATE_PER_MINUTE = 120;
const TOKEN_HEADER = "x-minih-webhook-token";

type Receiver = {
  token: string;
  maxBodyBytes: number;
  ratePerMinute: number;
};

export type WebhookRequest = {
  pluginId: string;
  webhookId: string;
  method: "POST";
  headers: Record<string, string>;
  bodyText: string;
  sourceIp: string;
  receivedAt: number;
};

export type WebhookServerOptions = {
  dataDir: string;
  receiver: (pluginId: string, webhookId: string) => Receiver | undefined;
  accept: (event: WebhookRequest) => Promise<void>;
  onError: (operation: string) => void;
  sourceFilter?: { allows: (address: string | undefined) => boolean };
  now?: () => number;
};

function respond(res: ServerResponse, status: number): void {
  res.writeHead(status, { "content-length": "0", connection: "close" });
  res.end();
}

function equalToken(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

function route(url: string | undefined): [string, string] | null {
  const match = /^\/hooks\/([^/?#]+)\/([^/?#]+)(?:\?[^#]*)?$/.exec(url ?? "");
  if (!match) return null;
  try {
    const pluginId = decodeURIComponent(match[1]);
    const webhookId = decodeURIComponent(match[2]);
    if (pluginId.includes("/") || webhookId.includes("/")) return null;
    return [pluginId, webhookId];
  } catch {
    return null;
  }
}

function readBounded(req: IncomingMessage, res: ServerResponse, limit: number): Promise<Buffer | null> {
  const length = req.headers["content-length"];
  if (length !== undefined && Number(length) > limit) {
    respond(res, 413);
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        done = true;
        req.pause();
        respond(res, 413);
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks, size));
    });
    req.on("aborted", () => {
      if (!done) reject(new Error("request aborted"));
    });
    req.on("error", (error) => {
      if (!done) reject(error);
    });
  });
}

/** macOS may permit a wildcard bind over an existing specific-address bind. */
async function portIsOccupied(port: number, loopbackOnly: boolean): Promise<boolean> {
  const addresses = new Set<string>(loopbackOnly ? ["0.0.0.0"] : ["127.0.0.1"]);
  if (!loopbackOnly) {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) if (entry.family === "IPv4") addresses.add(entry.address);
    }
    addresses.add("::1");
  }
  for (const host of addresses) {
    const probe = createServer();
    const occupied = await new Promise<boolean>((resolve, reject) => {
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") resolve(true);
        else if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT" || error.code === "EPROTONOSUPPORT") resolve(false);
        else reject(error);
      });
      probe.listen({ host, port, exclusive: true, ...(host.includes(":") ? { ipv6Only: true } : {}) }, () => probe.close((error) => error ? reject(error) : resolve(false)));
    });
    if (occupied) return true;
  }
  return false;
}

/** Listener lifecycle belongs to its owner; the callback persists before 202. */
export class PluginWebhookServer {
  private server: Server | null = null;
  private ipv6Server: Server | null = null;
  private readonly sourceFilter: { allows: (address: string | undefined) => boolean };
  private readonly now: () => number;
  private readonly options: WebhookServerOptions;
  private readonly rates = new Map<string, Array<{ time: number }>>();
  private readonly requests = new Map<IncomingMessage, { pluginId: string | null; done: Promise<void> }>();
  constructor(options: WebhookServerOptions) {
    this.options = options;
    this.sourceFilter = options.sourceFilter ?? new WebhookSourceFilter();
    this.now = options.now ?? Date.now;
  }

  async start(loopbackOnly: boolean): Promise<number> {
    if (this.server) throw new Error("Webhook listener is already running");
    await mkdir(this.options.dataDir, { recursive: true });
    const portFile = join(this.options.dataDir, "webhook.port");
    let preferred = WEBHOOK_DEFAULT_PORT;
    try {
      const text = await readFile(portFile, "utf8");
      const port = Number(text.trim());
      if (Number.isInteger(port) && port > 0 && port <= 65535) preferred = port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const done = this.handle(req, res).catch(() => {
        this.options.onError("webhook request failed");
        if (!res.headersSent && !res.destroyed) respond(res, 500);
        else res.destroy();
      }).finally(() => this.requests.delete(req));
      this.requests.set(req, { pluginId: route(req.url)?.[0] ?? null, done });
    };
    const server = createServer(handler);
    let ipv6: Server | null = null;
    const host = loopbackOnly ? "127.0.0.1" : "0.0.0.0";
    const listen = (target: Server, port: number, address: string, ipv6Only = false) => new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      target.once("error", failed);
      target.listen({ port, host: address, ipv6Only }, () => {
        target.off("error", failed);
        resolve();
      });
    });
    try {
      let port = await portIsOccupied(preferred, loopbackOnly) ? 0 : preferred;
      let collisions = 0;
      for (;;) {
        try {
          await listen(server, port, host);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || port === 0) throw error;
          port = 0;
          continue;
        }
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Webhook listener has no port");
        if (!loopbackOnly) {
          ipv6 = createServer(handler);
          try {
            await listen(ipv6, address.port, "::", true);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            ipv6 = null;
            if (code === "EADDRINUSE" && collisions++ < 5) {
              await new Promise<void>((resolve, reject) => server.close((failure) => failure ? reject(failure) : resolve()));
              port = 0;
              continue;
            }
            if (code !== "EAFNOSUPPORT" && code !== "EADDRNOTAVAIL" && code !== "EPROTONOSUPPORT") throw error;
          }
        }
        await writeFile(portFile, `${address.port}\n`, { mode: 0o600 });
        server.on("error", () => this.options.onError("webhook listener failed"));
        ipv6?.on("error", () => this.options.onError("webhook listener failed"));
        this.server = server;
        this.ipv6Server = ipv6;
        return address.port;
      }
    } catch (error) {
      if (server.listening) server.close();
      if (ipv6?.listening) ipv6.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const servers = [this.server, this.ipv6Server].filter((entry): entry is Server => entry !== null);
    if (servers.length === 0) return;
    this.server = null;
    this.ipv6Server = null;
    const closed = servers.map((server) => {
      const result = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      return result;
    });
    await Promise.all(closed);
    await Promise.all([...this.requests.values()].map((entry) => entry.done));
    this.rates.clear();
  }

  /** Reject unfinished requests and wait for any already-started writes. */
  async revoke(pluginId: string): Promise<void> {
    const active = [...this.requests.entries()].filter(([, entry]) => entry.pluginId === pluginId);
    for (const [request] of active) request.destroy();
    await Promise.all(active.map(([, entry]) => entry.done));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sourceIp = normalizeWebhookSource(req.socket.remoteAddress);
    if (!this.sourceFilter.allows(sourceIp)) return respond(res, 403);
    const target = route(req.url);
    if (!target) return respond(res, 404);
    const [pluginId, webhookId] = target;
    const receiver = this.options.receiver(pluginId, webhookId);
    if (!receiver?.token) return respond(res, 404);
    if (req.method !== "POST") return respond(res, 405);
    const provided = req.headers[TOKEN_HEADER];
    if (typeof provided !== "string" || !equalToken(provided, receiver.token)) return respond(res, 401);
    const key = JSON.stringify([pluginId, webhookId]);
    const time = this.now();
    const recent = (this.rates.get(key) ?? []).filter((entry) => entry.time > time - 60_000);
    if (recent.length >= Math.min(receiver.ratePerMinute, WEBHOOK_MAX_RATE_PER_MINUTE)) return respond(res, 429);
    const reservation = { time };
    recent.push(reservation);
    this.rates.set(key, recent);
    let accepted = false;
    try {
      const body = await readBounded(req, res, Math.min(receiver.maxBodyBytes, WEBHOOK_MAX_BODY_BYTES));
      if (!body) return;
      const headers: Record<string, string> = Object.create(null);
      for (const [name, value] of Object.entries(req.headers)) {
        if (name === TOKEN_HEADER || value === undefined) continue;
        if (Object.keys(headers).length >= 64) break;
        headers[name] = (Array.isArray(value) ? value.join(", ") : value).slice(0, 4096);
      }
      await this.options.accept({ pluginId, webhookId, method: "POST", headers, bodyText: body.toString("utf8"), sourceIp: sourceIp ?? "", receivedAt: time });
      accepted = true;
      respond(res, 202);
    } finally {
      if (!accepted) {
        const current = this.rates.get(key);
        const index = current?.indexOf(reservation) ?? -1;
        if (index !== -1) current?.splice(index, 1);
      }
    }
  }
}
