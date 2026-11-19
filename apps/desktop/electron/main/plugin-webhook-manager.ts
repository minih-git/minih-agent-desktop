import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { PluginWebhookServer, WEBHOOK_MAX_BODY_BYTES, WEBHOOK_MAX_RATE_PER_MINUTE } from "./plugin-webhook-server";
import { WebhookEventStore } from "./plugin-webhook-store";

type Host = { call: <T>(method: string, params?: Record<string, unknown>) => Promise<T> };
type Declaration = { id: string; maxBodyBytes?: number; ratePerMinute?: number };
type Loaded = {
  manifest: { id: string; contributes?: { webhooks?: Declaration[] } };
  permissions: ReadonlySet<string>;
  runtimeId: string;
  disposing: boolean;
  child?: unknown;
};
type Receiver = { pluginId: string; runtimeId: string; id: string; token: string; maxBodyBytes: number; ratePerMinute: number };
type ReceiverInfo = { id: string; url: string; enabled: boolean };

type Options = {
  dataDir: string;
  getHost: () => Host | null;
  plugins: () => Loaded[];
  deliver: ConstructorParameters<typeof WebhookEventStore>[2];
  onError: (operation: string) => void;
};

const keyFor = (pluginId: string, webhookId: string) => JSON.stringify([pluginId, webhookId]);
const secretRef = (pluginId: string, webhookId: string) => `plugin.webhook:${pluginId}:${webhookId}`;

function lanAddress(): string {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (!entry.internal && entry.family === "IPv4") return entry.address;
    }
  }
  return "127.0.0.1";
}

/** Owns the listener, token cache, replay and the cleanup timer. */
export class PluginWebhookManager {
  private readonly options: Options;
  private readonly store: WebhookEventStore;
  private readonly server: PluginWebhookServer;
  private receivers = new Map<string, Receiver>();
  private port: number | null = null;
  private loopbackOnly = false;
  private initialized: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(options: Options) {
    this.options = options;
    const rpc: Host = { call: (method, params) => this.host().call(method, params) };
    this.store = new WebhookEventStore(options.dataDir, rpc, options.deliver);
    this.server = new PluginWebhookServer({
      dataDir: options.dataDir,
      receiver: (pluginId, webhookId) => this.activeReceiver(pluginId, webhookId),
      accept: async (event) => {
        await this.store.accept(event);
        setImmediate(() => {
          if (!this.disposed) void this.store.replay(event.pluginId).catch(() => this.options.onError("webhook delivery failed"));
        });
      },
      onError: options.onError,
    });
  }

  private host(): Host {
    const host = this.options.getHost();
    if (!host) throw new Error("Webhook host is unavailable");
    return host;
  }

  private initialize(): Promise<void> {
    if (this.initialized) return this.initialized;
    const initializing = (async () => {
      try {
        const raw: unknown = JSON.parse(await readFile(join(this.options.dataDir, "webhook-preferences.json"), "utf8"));
        if (!raw || typeof raw !== "object" || typeof (raw as { loopbackOnly?: unknown }).loopbackOnly !== "boolean") {
          throw new Error("Invalid webhook preferences");
        }
        this.loopbackOnly = (raw as { loopbackOnly: boolean }).loopbackOnly;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // No listener exists yet: orphan scanning cannot race with acceptance.
      await this.store.cleanupOrphans();
      const installed = await this.host().call<{ plugins: Array<{ id: string }> }>("plugins.list");
      const installedIds = new Set(installed.plugins.map((plugin) => plugin.id));
      for (const pluginId of await this.store.storedPluginIds()) {
        if (!installedIds.has(pluginId)) await this.cleanupPlugin(pluginId, []);
      }
      await this.store.cleanup();
      this.timer = setInterval(() => {
        void this.store.cleanup().catch(() => this.options.onError("webhook cleanup failed"));
      }, 60 * 60 * 1000);
      this.timer.unref();
    })();
    this.initialized = initializing;
    void initializing.catch(() => { if (this.initialized === initializing) this.initialized = null; });
    return initializing;
  }

  private activeReceiver(pluginId: string, webhookId: string): Receiver | undefined {
    if (this.disposed) return undefined;
    const receiver = this.receivers.get(keyFor(pluginId, webhookId));
    if (!receiver) return undefined;
    const loaded = this.options.plugins().find((plugin) => plugin.manifest.id === pluginId);
    if (!loaded?.child || loaded.disposing || loaded.runtimeId !== receiver.runtimeId || !loaded.permissions.has("inbound.webhook")) return undefined;
    if (!loaded.manifest.contributes?.webhooks?.some((entry) => entry.id === webhookId)) return undefined;
    return receiver;
  }

  private async token(pluginId: string, webhookId: string): Promise<string> {
    await this.store.rememberReceiver(pluginId, webhookId);
    const secret = secretRef(pluginId, webhookId);
    const existing = await this.host().call<{ value: string | null }>("secrets.getForRuntime", { secretRef: secret });
    if (existing.value) return existing.value;
    const value = randomBytes(32).toString("base64url");
    await this.host().call("secrets.set", { secretRef: secret, value });
    return value;
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const guarded = () => {
      if (this.disposed) throw new Error("Webhook service is stopped");
      return run();
    };
    const task = this.chain.then(guarded, guarded);
    this.chain = task.then(() => undefined, () => undefined);
    return task;
  }

  reconcile(): Promise<void> {
    return this.serialize(() => this.reconcileNow());
  }

  private async reconcileNow(): Promise<void> {
    if (this.disposed) return;
    await this.initialize();
    if (this.disposed) return;
    const next = new Map<string, Receiver>();
    for (const plugin of this.options.plugins()) {
      if (!plugin.child || plugin.disposing || !plugin.permissions.has("inbound.webhook")) continue;
      for (const declaration of plugin.manifest.contributes?.webhooks ?? []) {
        const token = await this.token(plugin.manifest.id, declaration.id);
        next.set(keyFor(plugin.manifest.id, declaration.id), {
          pluginId: plugin.manifest.id,
          runtimeId: plugin.runtimeId,
          id: declaration.id,
          token,
          maxBodyBytes: declaration.maxBodyBytes ?? WEBHOOK_MAX_BODY_BYTES,
          ratePerMinute: declaration.ratePerMinute ?? WEBHOOK_MAX_RATE_PER_MINUTE,
        });
      }
    }
    if (this.disposed) return;
    this.receivers = next;
    for (const [key, receiver] of next) {
      if (!this.activeReceiver(receiver.pluginId, receiver.id)) next.delete(key);
    }
    if (next.size === 0 && this.port !== null) {
      await this.server.stop();
      this.port = null;
    } else if (next.size > 0 && this.port === null) {
      this.port = await this.server.start(this.loopbackOnly);
    }
  }

  async list(pluginId: string): Promise<{ loopbackOnly: boolean; receivers: ReceiverInfo[] }> {
    await this.reconcile();
    const host = this.loopbackOnly ? "127.0.0.1" : lanAddress();
    const receivers = [...this.receivers.values()].filter((entry) => entry.pluginId === pluginId).map((entry) => ({
      id: entry.id,
      url: `http://${host}:${this.port}/hooks/${encodeURIComponent(pluginId)}/${encodeURIComponent(entry.id)}`,
      enabled: Boolean(this.activeReceiver(pluginId, entry.id) && this.port !== null),
    }));
    return { loopbackOnly: this.loopbackOnly, receivers };
  }

  async reveal(pluginId: string, webhookId: string): Promise<string> {
    await this.reconcile();
    const receiver = this.activeReceiver(pluginId, webhookId);
    if (!receiver) throw new Error("Webhook receiver is unavailable");
    return receiver.token;
  }

  rotate(pluginId: string, webhookId: string): Promise<string> {
    return this.serialize(async () => {
      await this.reconcileNow();
      const receiver = this.activeReceiver(pluginId, webhookId);
      if (!receiver) throw new Error("Webhook receiver is unavailable");
      const value = randomBytes(32).toString("base64url");
      await this.host().call("secrets.set", { secretRef: secretRef(pluginId, webhookId), value });
      receiver.token = value;
      return value;
    });
  }

  setLoopbackOnly(loopbackOnly: boolean): Promise<void> {
    return this.serialize(async () => {
      await this.initialize();
      if (this.loopbackOnly === loopbackOnly) return;
      const path = join(this.options.dataDir, "webhook-preferences.json");
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ loopbackOnly }), { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
      this.loopbackOnly = loopbackOnly;
      if (this.port !== null) {
        await this.server.stop();
        this.port = null;
      }
      await this.reconcileNow();
    });
  }

  async pluginLoaded(pluginId: string): Promise<void> {
    await this.reconcile();
    if ([...this.receivers.values()].some((receiver) => receiver.pluginId === pluginId)) {
      await this.store.replay(pluginId);
    }
  }

  uninstall(pluginId: string, webhookIds: readonly string[]): Promise<void> {
    return this.serialize(async () => {
      if (this.options.plugins().some((plugin) => plugin.manifest.id === pluginId && plugin.child && !plugin.disposing)) {
        throw new Error("Webhook plugin must be unloaded before uninstall");
      }
      await this.reconcileNow();
      await this.server.revoke(pluginId);
      await this.cleanupPlugin(pluginId, webhookIds);
      await this.reconcileNow();
    });
  }

  private async cleanupPlugin(pluginId: string, webhookIds: readonly string[]): Promise<void> {
    const ids = new Set([...webhookIds, ...await this.store.receiverIds(pluginId)]);
    await this.store.purge(pluginId);
    for (const webhookId of ids) {
      await this.host().call("secrets.delete", { secretRef: secretRef(pluginId, webhookId) });
    }
    await this.store.removeReceiverIndex(pluginId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.chain;
    if (this.timer) clearInterval(this.timer);
    await this.server.stop();
    this.port = null;
    this.receivers.clear();
  }
}
