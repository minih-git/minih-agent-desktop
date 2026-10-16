import type { ConfigSyncCategorySelection, ConfigSyncConfigureInput, ConfigSyncMode, ConfigSyncState } from "@minih-agent/shared";
import type { ConfigSyncDraft } from "./config-sync-preferences";

/** Transient form memory only. Never serialize this object directly. */
export type ConfigSyncForm = {
  mode: ConfigSyncMode;
  automaticSync: boolean;
  deviceLabel: string;
  backupPassword: string;
  currentBackupPassword: string;
  newBackupPassword: string;
};

export function selectionFromDraft(categories?: Partial<ConfigSyncCategorySelection>): ConfigSyncCategorySelection {
  const selection: ConfigSyncCategorySelection = {
    application: true, providers: true, credentials: false, mcp: true,
    skills: true, subagents: true, instructions: true,
    plugins: true, automation: true, memory: false,
  };
  // Project selection from older drafts is no longer part of the portable contract.
  for (const key of Object.keys(selection) as Array<keyof ConfigSyncCategorySelection>) {
    if (typeof categories?.[key] === "boolean") selection[key] = categories[key];
  }
  return selection;
}

export function initialConfigSyncForm(draft: ConfigSyncDraft = {}): ConfigSyncForm {
  return {
    mode: draft.mode ?? "sync",
    automaticSync: draft.automaticSync ?? true,
    deviceLabel: draft.deviceLabel ?? "",
    backupPassword: "", currentBackupPassword: "", newBackupPassword: "",
  };
}

export function draftFromState(next: ConfigSyncState): ConfigSyncDraft {
  return {
    mode: next.mode, automaticSync: next.automaticSync, deviceLabel: next.deviceLabel,
    categories: selectionFromDraft({ ...next.categories, credentials: next.includeSecrets, memory: next.includeMemory }),
    saved: true,
  };
}

export function draftFromForm(form: ConfigSyncForm, categories: ConfigSyncCategorySelection): ConfigSyncDraft {
  return {
    mode: form.mode, automaticSync: form.automaticSync, deviceLabel: form.deviceLabel,
    categories: selectionFromDraft(categories), saved: false,
  };
}

/** One request projection for saves. The vault password stays byte-exact. */
export function configSyncConfigureInput(form: ConfigSyncForm, categories: ConfigSyncCategorySelection, defaultDevice: string): ConfigSyncConfigureInput {
  return {
    deviceLabel: form.deviceLabel.trim() || defaultDevice,
    backupPassword: form.backupPassword,
    mode: form.mode,
    automaticSync: form.automaticSync,
    categories: selectionFromDraft(categories),
    includeSecrets: categories.credentials,
    includeMemory: categories.memory,
  };
}

export function clearConfigSyncFormSecrets(form: ConfigSyncForm): ConfigSyncForm {
  return { ...form, backupPassword: "", currentBackupPassword: "", newBackupPassword: "" };
}
