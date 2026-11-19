import { clipboard, dialog, type BrowserWindow, type MessageBoxOptions } from "electron";
import { catalogs, resolveLocale } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import type { IpcRegistrar } from "./types";
import type { PluginWebhookManager } from "../plugin-webhook-manager";
import { showWebhookTokenDialog } from "../plugin-webhook-token-dialog";
import { registerWebhookIpc } from "./plugin-webhook-ipc";

export function registerDesktopWebhookIpc(options: {
  registrar: IpcRegistrar;
  webhooks: PluginWebhookManager;
  getMainWindow: () => BrowserWindow | null;
  getLocale: () => string;
  onError: (operation: string) => void;
  onModeChanged: () => void;
}): void {
  const { registrar, webhooks, getMainWindow, getLocale, onError, onModeChanged } = options;
  let dialogOpen = false;
  const show = (messageOptions: MessageBoxOptions) => {
    const parent = getMainWindow();
    if (!parent) throw new Error("Main window unavailable");
    return dialog.showMessageBox(parent, messageOptions);
  };
  registerWebhookIpc({
    registrar,
    webhooks,
    onError,
    onModeChanged,
    confirmLan: async () => {
      const labels = catalogs[resolveLocale(getLocale())].plugins.webhook;
      const response = await show({
        type: "warning", title: labels.lanConfirmTitle, message: labels.lanConfirmTitle,
        detail: labels.lanWarning, buttons: [labels.tokenCancel, labels.enableLan],
        defaultId: 0, cancelId: 0, noLink: true,
      });
      return response.response === 1;
    },
    openTokenDialog: async (pluginId, webhookId) => {
      if (dialogOpen) throw new Error("Webhook token dialog is already open");
      dialogOpen = true;
      try {
        await showWebhookTokenDialog({
          labels: catalogs[resolveLocale(getLocale())].plugins.webhook,
          show,
          reveal: () => webhooks.reveal(pluginId, webhookId),
          rotate: () => webhooks.rotate(pluginId, webhookId),
          copy: (value) => clipboard.writeText(value),
        });
      } finally {
        dialogOpen = false;
      }
    },
  }, {
    list: IPC.invoke.pluginWebhookList,
    setLoopback: IPC.invoke.pluginWebhookSetLoopback,
    tokenDialog: IPC.invoke.pluginWebhookTokenDialog,
  });
}
