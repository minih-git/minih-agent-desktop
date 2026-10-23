/**
 * The interruption check every user-initiated plugin teardown shares.
 *
 * A plugin that runs work the user would notice losing — a shell, a background
 * job — reports it through `onActiveWork` (spec 07-plugins/05 §3.0). Nothing
 * here knows which plugins those are: this module asks, and only a plugin that
 * answers with a sentence produces a prompt. A plugin without the hook, with
 * nothing running, or that cannot answer in its budget is silent, so every
 * existing plugin keeps exactly the teardown it had before.
 *
 * The one rule callers must respect: ask **before** the destructive step, and
 * treat `false` as "do nothing at all".
 */
import { dialog, type BrowserWindow } from "electron";
import { catalogs, resolveLocale } from "@minih-agent/i18n";
import type { PluginRuntime } from "./plugin-runtime";

export type ActiveWorkDependencies = {
  plugins: Pick<PluginRuntime, "activeWork">;
  getLocale: () => string;
  /** The window the prompt belongs to, when one is open. */
  window?: () => BrowserWindow | undefined;
};

/**
 * Decisions already being asked about. A second request for the same plugin
 * joins the open prompt instead of stacking a duplicate, which is what a
 * double-click on Disable would otherwise do.
 */
const deciding = new Map<string, Promise<boolean>>();

/** Prompts run one at a time: two dialogs for one action would be a bug. */
let queue: Promise<unknown> = Promise.resolve();

function uniqueIds(ids: readonly unknown[]): string[] {
  const targets = ids.filter(
    (id): id is string => typeof id === "string" && id.trim().length > 0,
  );
  return [...new Set(targets)].sort();
}

/** What each plugin says it would lose, with the silent plugins left out. */
export async function activeWorkMessages(
  plugins: Pick<PluginRuntime, "activeWork">,
  ids: readonly string[],
): Promise<string[]> {
  const answers = await Promise.all(ids.map((id) => plugins.activeWork(id).catch(() => null)));
  return answers.filter((message): message is string => typeof message === "string" && !!message);
}

/**
 * Ask the plugins named in `ids` before ending their work. `true` means "go
 * ahead": either nothing is running, or the user accepted. `false` means the
 * caller must leave every piece of state exactly as it found it.
 */
export async function confirmPluginInterruption(
  dependencies: ActiveWorkDependencies,
  ids: readonly unknown[],
): Promise<boolean> {
  const targets = uniqueIds(ids);
  if (targets.length === 0) return true;

  const pending = targets.map((id) => deciding.get(id)).filter(Boolean) as Promise<boolean>[];
  if (pending.length === targets.length) {
    const answers = await Promise.all(pending);
    return answers.every(Boolean);
  }

  const decision = queue.then(() => askAndShow(dependencies, targets));
  for (const id of targets) deciding.set(id, decision);
  queue = decision.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await decision;
  } finally {
    for (const id of targets) {
      if (deciding.get(id) === decision) deciding.delete(id);
    }
  }
}

async function askAndShow(
  dependencies: ActiveWorkDependencies,
  targets: string[],
): Promise<boolean> {
  const messages = await activeWorkMessages(dependencies.plugins, targets);
  if (messages.length === 0) return true;

  const labels = catalogs[resolveLocale(dependencies.getLocale())];
  const detail = [labels.plugins.interruptionBody, ...messages.map((line) => `• ${line}`)].join(
    "\n\n",
  );
  const options = {
    type: "warning" as const,
    title: labels.plugins.interruptionTitle,
    message: labels.plugins.interruptionTitle,
    detail,
    buttons: [labels.common.cancel, labels.plugins.interruptionContinue],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const parent = dependencies.window?.();
  const { response } =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
  return response === 1;
}
