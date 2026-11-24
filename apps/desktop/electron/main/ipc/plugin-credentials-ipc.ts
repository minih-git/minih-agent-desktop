import {
  IPC,
  type PluginCredentialDialogAnswer,
  type PluginCredentialStatus,
} from "@minih-agent/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

/**
 * The renderer half of plugin credentials. It can write and query public state,
 * but cannot invoke the host-only resolver, and it never receives a stored value.
 *
 * Two flows meet here:
 *
 * * the Settings sheet adds, clears, and removes an instance itself;
 * * a plugin asks the host for a dialog (`pi.credentials.requestAdd`), Main pushes
 *   the request to this same window, and the answer comes back on
 *   `pluginCredentialsDialogAnswer` so Main can store the value the user typed.
 *   The value travels renderer → main → host-core and never reaches the plugin
 *   process.
 */
export function registerPluginCredentialIpc(
  registrar: IpcRegistrar,
  getHost: () => HostProcess | null,
  onChanged: (pluginId: string, slotId: string) => void,
  answerDialog: (requestId: string, answer: PluginCredentialDialogAnswer) => boolean,
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
      // Only declared metadata: a control the manifest did not name stays absent
      // so the sheet keeps its pre-`type` rendering.
      fields: slot.fields.map(({ key, label, secret, type, options }) => ({
        key, label, secret,
        ...(type ? { type } : {}),
        ...(options ? { options } : {}),
      })),
      configured: slot.configured,
      ...(slot.lastUsedAt === undefined ? {} : { lastUsedAt: slot.lastUsedAt }),
      ...(slot.multiple ? { multiple: true as const, max: slot.max, limit: slot.limit } : {}),
      ...(slot.instances
        ? {
            instances: slot.instances.map(({ instanceId, label, publicFields, configured }) => ({
              instanceId, label, publicFields, configured,
            })),
          }
        : {}),
      ...(slot.labelField ? { labelField: slot.labelField } : {}),
      ...(slot.userEndpoint ? { userEndpoint: slot.userEndpoint } : {}),
    })) };
  });
  registrar.handleWithEvent(IPC.invoke.pluginCredentialsSet, async (event, input: {
    pluginId: string; slotId: string; fields: Record<string, string>;
  }) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) throw new Error("Cannot save plugin credentials: host unavailable");
    let answer: { instanceId?: unknown } | null = null;
    try {
      answer = await host.call<{ instanceId?: unknown } | null>("plugins.credentials.set", input);
    } catch {
      // The request contains credentials; neither errors nor logs may echo it.
      throw new Error("Cannot save plugin credentials: invalid fields or storage failure");
    }
    onChanged(input.pluginId, input.slotId);
    // A multi-instance slot answers the id it created, so the sheet can point at
    // the new row instead of guessing which one it is.
    return typeof answer?.instanceId === "string" ? { instanceId: answer.instanceId } : {};
  });
  registrar.handleWithEvent(IPC.invoke.pluginCredentialsClear, async (event, input: {
    pluginId: string; slotId: string; instanceId?: string;
  }) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) throw new Error("Cannot clear plugin credentials: host unavailable");
    try {
      await host.call("plugins.credentials.clear", {
        pluginId: input.pluginId,
        slotId: input.slotId,
        // Absent clears the whole slot; present drops one instance of it.
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
      });
    } catch {
      throw new Error("Cannot clear plugin credentials: invalid slot or storage failure");
    }
    onChanged(input.pluginId, input.slotId);
  });
  registrar.handleWithEvent(
    IPC.invoke.pluginCredentialDialogAnswer,
    async (
      event,
      input: { requestId: string; answer: PluginCredentialDialogAnswer },
    ) => {
      registrar.assertMainWindowSender(event);
      const requestId = typeof input?.requestId === "string" ? input.requestId : "";
      const answer = input?.answer;
      if (!requestId || !answer || typeof answer.action !== "string") {
        throw new Error("Cannot answer the credential dialog: the answer is malformed");
      }
      // `false` means the dialog was already answered, timed out, or belonged to
      // a window that is gone. The renderer closes its modal either way.
      return { accepted: answerDialog(requestId, answer) };
    },
  );
}