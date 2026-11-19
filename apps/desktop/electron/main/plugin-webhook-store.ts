import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { WebhookRequest } from "./plugin-webhook-server";

const TOKEN_HEADER = "x-minih-webhook-token";
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BODY_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const INDEX_TEMP_FILE = /^\.receivers-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

type Rpc = { call: <T>(method: string, params: Record<string, unknown>) => Promise<T> };
type Row = { eventId: string; pluginId: string; webhookId: string; sourceIp: string | null; bodyRef: string | null; receivedAt: number | null };
type Removed = { eventId: string; pluginId: string; bodyRef: string | null };
type Delivery = Omit<WebhookRequest, "pluginId">;

function directoryName(pluginId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(pluginId)) throw new Error("Invalid webhook plugin id");
  return pluginId;
}

function filename(bodyRef: string | null): string {
  if (!bodyRef || !BODY_FILE.test(bodyRef)) throw new Error("Invalid webhook body reference");
  return bodyRef;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Webhook storage path is not a directory");
  await chmod(path, 0o700);
}

async function existingDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Webhook storage path is not a directory");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Durable sidecars are written before the host records the accepted request. */
export class WebhookEventStore {
  private readonly root: string;
  private readonly rpc: Rpc;
  private readonly deliver: (pluginId: string, event: Delivery) => Promise<void>;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(dataDir: string, rpc: Rpc, deliver: (pluginId: string, event: Delivery) => Promise<void>) {
    this.root = join(dataDir, "plugin-webhooks");
    this.rpc = rpc;
    this.deliver = deliver;
  }

  private async pluginDirectory(pluginId: string): Promise<string> {
    await privateDirectory(this.root);
    const directory = join(this.root, directoryName(pluginId));
    await privateDirectory(directory);
    return directory;
  }

  /** Non-secret IDs let uninstall remove tokens for receivers removed by upgrades. */
  async receiverIds(pluginId: string): Promise<string[]> {
    if (!await existingDirectory(this.root)) return [];
    const directory = join(this.root, directoryName(pluginId));
    if (!await existingDirectory(directory)) return [];
    const path = join(directory, "receivers.json");
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Invalid webhook receiver index");
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))) {
        throw new Error("Invalid webhook receiver index");
      }
      return [...new Set(value)];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async rememberReceiver(pluginId: string, webhookId: string): Promise<void> {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(webhookId)) throw new Error("Invalid webhook receiver id");
    const ids = await this.receiverIds(pluginId);
    if (ids.includes(webhookId)) return;
    const directory = await this.pluginDirectory(pluginId);
    const temporary = join(directory, `.receivers-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify([...ids, webhookId]), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, "receivers.json"));
  }

  async removeReceiverIndex(pluginId: string): Promise<void> {
    if (!await existingDirectory(this.root)) return;
    const directory = join(this.root, directoryName(pluginId));
    if (!await existingDirectory(directory)) return;
    const path = join(directory, "receivers.json");
    try { await unlink(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async storedPluginIds(): Promise<string[]> {
    if (!await existingDirectory(this.root)) return [];
    return (await readdir(this.root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(entry.name))
      .map((entry) => entry.name);
  }

  async accept(event: WebhookRequest): Promise<void> {
    const directory = await this.pluginDirectory(event.pluginId);
    const eventId = randomUUID();
    const bodyRef = `${eventId}.json`;
    const headers: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(event.headers)) {
      if (name.toLowerCase() !== TOKEN_HEADER) headers[name.toLowerCase()] = value;
    }
    const file = await open(join(directory, bodyRef), "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ method: event.method, headers, bodyText: event.bodyText }), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await this.rpc.call("plugin.webhook.recordEvent", {
      eventId,
      pluginId: event.pluginId,
      webhookId: event.webhookId,
      sourceIp: event.sourceIp,
      bodyRef,
      receivedAt: event.receivedAt,
    });
  }

  /** A failed or interrupted handler leaves its row pending for the next replay. */
  replay(pluginId: string): Promise<void> {
    const prior = this.inFlight.get(pluginId) ?? Promise.resolve();
    const task = prior.then(() => this.drain(pluginId), () => this.drain(pluginId));
    this.inFlight.set(pluginId, task);
    void task.then(
      () => { if (this.inFlight.get(pluginId) === task) this.inFlight.delete(pluginId); },
      () => { if (this.inFlight.get(pluginId) === task) this.inFlight.delete(pluginId); },
    );
    return task;
  }

  private async drain(pluginId: string): Promise<void> {
    const directory = await this.pluginDirectory(pluginId);
    for (;;) {
      const page = await this.rpc.call<{ events: Row[] }>("plugin.webhook.pending", { pluginId, limit: 100 });
      if (page.events.length === 0) return;
      for (const row of page.events) {
        const contents: unknown = JSON.parse(await readFile(join(directory, filename(row.bodyRef)), "utf8"));
        if (!contents || typeof contents !== "object") throw new Error("Invalid webhook sidecar");
        const { method, headers, bodyText } = contents as { method?: unknown; headers?: unknown; bodyText?: unknown };
        if (method !== "POST" || !headers || typeof headers !== "object" || Array.isArray(headers) || typeof bodyText !== "string") {
          throw new Error("Invalid webhook sidecar");
        }
        const cleanHeaders: Record<string, string> = Object.create(null);
        for (const [name, value] of Object.entries(headers)) {
          if (typeof value !== "string") throw new Error("Invalid webhook sidecar header");
          if (name.toLowerCase() !== TOKEN_HEADER) cleanHeaders[name.toLowerCase()] = value;
        }
        await this.deliver(pluginId, {
          webhookId: row.webhookId,
          method,
          headers: cleanHeaders,
          bodyText,
          sourceIp: row.sourceIp ?? "",
          receivedAt: row.receivedAt ?? 0,
        });
        await this.rpc.call("plugin.webhook.markDelivered", { eventId: row.eventId, pluginId });
      }
    }
  }

  async purge(pluginId: string): Promise<void> {
    await this.removeSelected({ pluginId });
    await this.cleanupOrphans(pluginId);
  }

  async cleanup(now = Date.now()): Promise<void> {
    await this.removeSelected({ beforeMs: now - RETENTION_MS });
  }

  private async removeSelected(filter: Record<string, unknown>): Promise<void> {
    let cursor: string | null = null;
    do {
      const page: { events: Removed[]; nextCursor: string | null } = await this.rpc.call(
        "plugin.webhook.list", { ...filter, limit: 100, ...(cursor ? { cursor } : {}) },
      );
      await this.removeFiles(page.events);
      if (page.events.length > 0) {
        await this.rpc.call("plugin.webhook.deleteByIds", {
          eventIds: page.events.map((entry) => entry.eventId),
          ...(typeof filter.pluginId === "string" ? { pluginId: filter.pluginId } : {}),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }

  /** Global scans run before listening; scoped scans require the plugin to be stopped. */
  async cleanupOrphans(pluginId?: string): Promise<void> {
    const references = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { events: Removed[]; nextCursor: string | null } = await this.rpc.call(
        "plugin.webhook.list", { limit: 500, ...(pluginId ? { pluginId: directoryName(pluginId) } : {}), ...(cursor ? { cursor } : {}) },
      );
      for (const entry of page.events) {
        if (entry.bodyRef) references.add(`${entry.pluginId}/${entry.bodyRef}`);
      }
      cursor = page.nextCursor;
    } while (cursor);
    if (!await existingDirectory(this.root)) return;
    let directories;
    try {
      directories = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const directory of directories) {
      if (pluginId && directory.name !== pluginId) continue;
      if (!directory.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(directory.name)) continue;
      const path = join(this.root, directory.name);
      for (const file of await readdir(path, { withFileTypes: true })) {
        if (!file.isFile() || (!BODY_FILE.test(file.name) && !INDEX_TEMP_FILE.test(file.name))) continue;
        if (!references.has(`${directory.name}/${file.name}`)) await unlink(join(path, file.name));
      }
    }
  }

  private async removeFiles(records: Removed[]): Promise<void> {
    if (!await existingDirectory(this.root)) return;
    for (const record of records) {
      if (!record.bodyRef) continue;
      const directory = join(this.root, directoryName(record.pluginId));
      if (!await existingDirectory(directory)) continue;
      try {
        await unlink(join(directory, filename(record.bodyRef)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}
