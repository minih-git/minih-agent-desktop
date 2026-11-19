import type { IpcRegistrar } from "./types";
import type { PluginWebhookManager } from "../plugin-webhook-manager";

type Channels = { list: string; setLoopback: string; tokenDialog: string };
type Dependencies = {
  registrar: Pick<IpcRegistrar, "handleWithEvent" | "assertMainWindowSender">;
  webhooks: Pick<PluginWebhookManager, "list" | "setLoopbackOnly">;
  openTokenDialog: (pluginId: string, webhookId: string) => Promise<void>;
  confirmLan: () => Promise<boolean>;
  onModeChanged?: () => void;
  onError: (operation: string) => void;
};

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    throw Object.assign(new Error("Invalid webhook identifier"), { errorCode: "INVALID_ARGUMENT" });
  }
  return value;
}

/** Renderer IPC never carries a token; the system-owned dialog handles it. */
export function registerWebhookIpc({ registrar, webhooks, openTokenDialog, onError, confirmLan, onModeChanged }: Dependencies, channels: Channels): void {
  registrar.handleWithEvent(channels.list, async (event, pluginId: unknown) => {
    registrar.assertMainWindowSender(event);
    const plugin = id(pluginId);
    try {
      const status = await webhooks.list(plugin);
      return { loopbackOnly: status.loopbackOnly, receivers: status.receivers.map(({ id, url, enabled }) => ({ id, url, enabled })) };
    } catch {
      onError("webhook receivers could not be listed");
      throw new Error("Unable to list webhook receivers: host unavailable or listener failed");
    }
  });
  registrar.handleWithEvent(channels.setLoopback, async (event, loopbackOnly: unknown) => {
    registrar.assertMainWindowSender(event);
    if (typeof loopbackOnly !== "boolean") throw new Error("Invalid webhook listening mode");
    if (!loopbackOnly && !(await confirmLan())) return;
    try {
      await webhooks.setLoopbackOnly(loopbackOnly);
      onModeChanged?.();
    } catch {
      onError("webhook listening mode could not be changed");
      throw new Error("Unable to change webhook listening mode: host unavailable or listener failed");
    }
  });
  registrar.handleWithEvent(channels.tokenDialog, async (event, pluginId: unknown, webhookId: unknown) => {
    registrar.assertMainWindowSender(event);
    const plugin = id(pluginId);
    const receiver = id(webhookId);
    try {
      await openTokenDialog(plugin, receiver);
    } catch {
      onError("webhook token dialog failed");
      throw new Error("Unable to manage webhook token: host unavailable or receiver disabled");
    }
  });
}
