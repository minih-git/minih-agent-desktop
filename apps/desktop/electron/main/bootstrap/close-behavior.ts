import { dialog, type BrowserWindow } from "electron";
import { catalogs, resolveLocale } from "@minih-agent/i18n";
import type { CloseBehavior } from "@minih-agent/shared";
import {
  readCloseBehavior,
  writeCloseBehavior,
} from "../window-preferences";
import type { WindowLifecycleState } from "./window";

export type CloseBehaviorDependencies = {
  state: WindowLifecycleState;
  dataDir: string;
  getLocale: () => string;
  createTray: () => void;
  /**
   * Plugin work that quitting would end, in each plugin's own words. Empty, or
   * absent, when nothing is running — the dialog then reads exactly as before
   * (spec 07-plugins/05 §3.0).
   */
  activeWorkLines?: () => Promise<string[]>;
};

export function createCloseBehaviorRuntime({
  state,
  dataDir,
  getLocale,
  createTray,
  activeWorkLines,
}: CloseBehaviorDependencies) {
  const applyCloseBehavior = (next: CloseBehavior): void => {
    state.closeBehavior = next;
    writeCloseBehavior(dataDir, next);
    if (next === "tray") createTray();
  };

  const askCloseBehavior = async (
    window: BrowserWindow,
  ): Promise<"tray" | "quit" | null> => {
    const labels = catalogs[resolveLocale(getLocale())];
    const { response } = await dialog.showMessageBox(window, {
      type: "question",
      title: labels.tray.askTitle,
      message: labels.tray.askTitle,
      detail: labels.tray.askBody,
      buttons: [labels.common.cancel, labels.tray.closeToTray, labels.tray.quit],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    return response === 1 ? "tray" : response === 2 ? "quit" : null;
  };

  const confirmQuitDialog = async (): Promise<boolean> => {
    const labels = catalogs[resolveLocale(getLocale())];
    // Quitting ends whatever the plugins are running, so the existing prompt
    // says so instead of adding a second dialog after it.
    const running = ((await activeWorkLines?.()) ?? []).filter(
      (line) => typeof line === "string" && line.trim().length > 0,
    );
    const detail = running.length
      ? [
          labels.plugins.interruptionBody,
          ...running.map((line) => `• ${line}`),
          labels.tray.confirmQuitBody,
        ].join("\n\n")
      : labels.tray.confirmQuitBody;
    const parent =
      state.mainWindow && !state.mainWindow.isDestroyed()
        ? state.mainWindow
        : undefined;
    const options = {
      type: "warning" as const,
      title: labels.tray.confirmQuitTitle,
      message: labels.tray.confirmQuitTitle,
      detail,
      buttons: [labels.common.cancel, labels.tray.confirmQuit],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return response === 1;
  };

  return {
    applyCloseBehavior,
    askCloseBehavior,
    confirmQuitDialog,
    readCloseBehavior: () => readCloseBehavior(dataDir),
  };
}
