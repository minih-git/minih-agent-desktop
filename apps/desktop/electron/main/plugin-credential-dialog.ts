/**
 * The host-owned credential dialog behind `pi.credentials.requestAdd` and
 * `pi.credentials.requestRemove`.
 *
 * A plugin cannot read a stored secret, so it also cannot write one. When a
 * mailbox plugin needs another account it asks the host, the host asks the user
 * through its own renderer modal, and the value travels renderer → main →
 * host-core. The plugin process learns only the instance id it can then address
 * as `slot#instance`.
 *
 * Three refusals are decided here, before any UI exists, because each one is a
 * way a plugin could otherwise bother the user:
 *
 * * `CREDENTIAL_DIALOG_UNAVAILABLE` — the app window is not in front, so a
 *   background plugin cannot interrupt with a form;
 * * `CREDENTIAL_DIALOG_BUSY` — this plugin already has a dialog open, or the
 *   user just dismissed one;
 * * `CREDENTIAL_LIMIT` arrives from host-core when `multiple.max` is reached.
 *
 * Every open dialog has an owner: the map below. A timeout, a window that goes
 * away, a plugin unload, and a host shutdown all end in `cancel`, so no promise
 * is left waiting and no modal is left on a screen for a plugin that is gone.
 */
import { randomUUID } from "node:crypto";
import {
  IPC,
  type PluginCredentialDialogAnswer,
  type PluginCredentialDialogRequest,
} from "@minih-agent/shared";
import { PluginCredentialError, dialogFailure } from "./plugin-credential-slots";

export type {
  PluginCredentialDialogAnswer,
  PluginCredentialDialogRequest,
} from "@minih-agent/shared";

/**
 * How long one dialog may sit unanswered. A user who walked away is not an
 * answer, and the plugin should retry later instead of holding a pending call.
 */
export const CREDENTIAL_DIALOG_TIMEOUT_MS = 5 * 60_000;

/**
 * How long a plugin has to wait after the user dismissed its dialog.
 *
 * Without this, a plugin could re-ask the moment the form closes: the modal
 * covers the whole app, so an immediate retry loop would take the window away
 * from the user. A successful save, or a confirmed removal, does not start a
 * cooldown — the user answered, and the plugin may reasonably ask again for
 * another account.
 */
export const CREDENTIAL_DIALOG_COOLDOWN_MS = 30_000;

/** Who is asking, in the terms the modal shows. */
export type PluginCredentialDialogScope = {
  pluginId: string;
  pluginName: string;
  slotId: string;
};

/** The port the plugin runtime and the IPC layer share. */
export type PluginCredentialDialogPort = {
  /** Collect one new instance from the user. */
  add: (scope: PluginCredentialDialogScope) => Promise<{ instanceId: string } | { cancelled: true }>;
  /** Ask the user to confirm dropping one instance. */
  remove: (
    scope: PluginCredentialDialogScope & { instanceId: string; label: string },
  ) => Promise<{ removed: true } | { cancelled: true }>;
  /** Apply the renderer's answer. `false` when no dialog is waiting on it. */
  answer: (requestId: string, answer: PluginCredentialDialogAnswer) => boolean;
  /** Close whatever one plugin has open, on unload or crash. */
  cancelPlugin: (pluginId: string) => void;
  /** Close everything, on host shutdown. */
  cancelAll: () => void;
};

type PendingDialog = {
  request: PluginCredentialDialogRequest;
  settle: (answer: PluginCredentialDialogAnswer | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type PluginCredentialDialogDeps = {
  /** Push one dialog request to the renderer. */
  send: (channel: string, payload: unknown) => void;
  /** Whether the app window is in front of the user right now. */
  isWindowFocused: () => boolean;
  /** Store one new instance; answers the id host-core assigned. */
  setCredential: (
    pluginId: string,
    slotId: string,
    fields: Record<string, string>,
  ) => Promise<string | undefined>;
  /** Drop one instance. */
  clearCredential: (pluginId: string, slotId: string, instanceId: string) => Promise<boolean>;
  timeoutMs?: number;
  cooldownMs?: number;
};

export function createPluginCredentialDialog(
  deps: PluginCredentialDialogDeps,
): PluginCredentialDialogPort {
  const open = new Map<string, PendingDialog>();
  /** pluginId → the one dialog it is waiting on. */
  const byPlugin = new Map<string, string>();
  const timeoutMs = deps.timeoutMs ?? CREDENTIAL_DIALOG_TIMEOUT_MS;
  const cooldownMs = deps.cooldownMs ?? CREDENTIAL_DIALOG_COOLDOWN_MS;
  /** pluginId → the moment its dismissed dialog stops blocking a new one. */
  const coolingDown = new Map<string, number>();

  const cooling = (pluginId: string): number => {
    const until = coolingDown.get(pluginId) ?? 0;
    if (!until) return 0;
    if (until <= Date.now()) {
      coolingDown.delete(pluginId);
      return 0;
    }
    return until;
  };

  const settle = (
    requestId: string,
    answer: PluginCredentialDialogAnswer | null,
  ): boolean => {
    const pending = open.get(requestId);
    if (!pending) return false;
    open.delete(requestId);
    byPlugin.delete(pending.request.pluginId);
    clearTimeout(pending.timer);
    // A dialog nobody answered — dismissed, timed out, or closed by an unload —
    // starts the cooldown. An submitted or confirmed one does not.
    if (!answer || answer.action === "cancel") {
      coolingDown.set(pending.request.pluginId, Date.now() + cooldownMs);
    }
    pending.settle(answer);
    return true;
  };

  /**
   * Show one dialog and wait. Every exit path — answer, cancel, timeout, shutdown
   * — goes through `settle`, so the map cannot grow a stale entry.
   */
  const ask = (request: Omit<PluginCredentialDialogRequest, "requestId">): Promise<PluginCredentialDialogAnswer | null> => {
    if (byPlugin.has(request.pluginId)) {
      return Promise.reject(
        new PluginCredentialError(
          "CREDENTIAL_DIALOG_BUSY",
          "this plugin already has a credential dialog open",
        ),
      );
    }
    const coolingUntil = cooling(request.pluginId);
    if (coolingUntil) {
      const seconds = Math.max(1, Math.ceil((coolingUntil - Date.now()) / 1000));
      return Promise.reject(
        new PluginCredentialError(
          "CREDENTIAL_DIALOG_BUSY",
          `the user dismissed this plugin's credential dialog; it may ask again in ${seconds}s`,
        ),
      );
    }
    if (!deps.isWindowFocused()) {
      return Promise.reject(
        new PluginCredentialError(
          "CREDENTIAL_DIALOG_UNAVAILABLE",
          "the app window is not in front, so the host cannot ask the user for a credential",
        ),
      );
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        settle(requestId, null);
      }, timeoutMs);
      // A pending dialog must not keep the process alive by itself.
      timer.unref?.();
      open.set(requestId, {
        request: { ...request, requestId },
        settle: resolve,
        timer,
      });
      byPlugin.set(request.pluginId, requestId);
      try {
        deps.send(IPC.event.pluginCredentialDialog, { ...request, requestId });
      } catch {
        // A renderer that cannot be reached is not an answer: fail the request
        // instead of leaving the plugin waiting for a form nobody saw.
        settle(requestId, null);
      }
    });
  };

  return {
    async add(scope) {
      const answer = await ask({
        kind: "add",
        pluginId: scope.pluginId,
        pluginName: scope.pluginName,
        slotId: scope.slotId,
      });
      if (!answer || answer.action !== "submit") return { cancelled: true };
      try {
        const instanceId = await deps.setCredential(
          scope.pluginId,
          scope.slotId,
          answer.fields,
        );
        if (!instanceId) {
          throw new PluginCredentialError(
            "CREDENTIAL_UNAVAILABLE",
            "the credential store did not report the new instance",
          );
        }
        return { instanceId };
      } catch (error) {
        throw dialogFailure(error);
      }
    },

    async remove(scope) {
      const answer = await ask({
        kind: "remove",
        pluginId: scope.pluginId,
        pluginName: scope.pluginName,
        slotId: scope.slotId,
        instanceId: scope.instanceId,
        instanceLabel: scope.label,
      });
      if (!answer || answer.action !== "confirm") return { cancelled: true };
      try {
        await deps.clearCredential(scope.pluginId, scope.slotId, scope.instanceId);
        return { removed: true as const };
      } catch (error) {
        throw dialogFailure(error);
      }
    },

    answer(requestId, answer) {
      // A late answer for a dialog that already timed out is not an error: the
      // user simply answered after the plugin stopped waiting.
      return settle(requestId, answer);
    },

    cancelPlugin(pluginId) {
      const requestId = byPlugin.get(pluginId);
      if (requestId) settle(requestId, null);
    },

    cancelAll() {
      for (const requestId of [...open.keys()]) settle(requestId, null);
    },
  };
}