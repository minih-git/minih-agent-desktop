import { IPC, type PluginCredentialStatus } from "@minih-agent/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

/** Renderer can write and query public state, but cannot invoke the host-only resolver. */
export function registerPluginCredentialIpc(
  registrar: IpcRegistrar,
  getHost: () => HostProcess | null,
): void {
  registrar.handleWithEvent(IPC.invoke.pluginCredentialsStatus, async (event, input: { pluginId: string }) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) throw new Error("Cannot load plugin credential status: host unavailable");
    const result = await host.call<{ slots: PluginCredentialStatus[] }>("plugins.credentials.status", {
      pluginId: input?.pluginId,
    });
    // Project only declared metadata, so this IPC cannot return stored values.
    return { slots: result.slots.map((slot) => ({
      id: slot.id, title: slot.title, kind: slot.kind,
      fields: slot.fields.map(({ key, label, secret }) => ({ key, label, secret })),
      configured: slot.configured, lastUsedAt: slot.lastUsedAt,
    })) };
  });
  registrar.handleWithEvent(IPC.invoke.pluginCredentialsSet, async (event, input: {
    pluginId: string; slotId: string; fields: Record<string, string>;
  }) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) throw new Error("Cannot save plugin credentials: host unavailable");
    try {
      await host.call("plugins.credentials.set", input);
    } catch {
      // The request contains credentials; neither errors nor logs may echo it.
      throw new Error("Cannot save plugin credentials: invalid fields or storage failure");
    }
  });
  registrar.handleWithEvent(IPC.invoke.pluginCredentialsClear, async (event, input: {
    pluginId: string; slotId: string;
  }) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) throw new Error("Cannot clear plugin credentials: host unavailable");
    try {
      await host.call("plugins.credentials.clear", input);
    } catch {
      throw new Error("Cannot clear plugin credentials: invalid slot or storage failure");
    }
  });
}
