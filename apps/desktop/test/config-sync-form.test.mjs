import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const formModule = await import("../src/features/settings/config-sync-form.ts");
const { initialConfigSyncForm, configSyncConfigureInput, clearConfigSyncFormSecrets, selectionFromDraft, draftFromForm, draftFromState } = formModule;

const selection = selectionFromDraft();
const input = (form) => configSyncConfigureInput(form, selection, "This device");

test("the form carries account preferences only; S3 connection fields are gone", () => {
  const form = initialConfigSyncForm();
  assert.deepEqual(Object.keys(form).sort(),
    ["automaticSync", "backupPassword", "currentBackupPassword", "deviceLabel", "mode", "newBackupPassword"]);
  assert.deepEqual(form, {
    mode: "sync", automaticSync: true, deviceLabel: "",
    backupPassword: "", currentBackupPassword: "", newBackupPassword: "",
  });
  assert.equal("configSyncTestInput" in formModule, false);
});

test("configure input projects the router contract with a defaulted device label", () => {
  const form = { ...initialConfigSyncForm(), deviceLabel: "  MacBook Pro ", mode: "backup", automaticSync: false };
  assert.deepEqual(input(form), {
    deviceLabel: "MacBook Pro",
    backupPassword: "",
    mode: "backup",
    automaticSync: false,
    categories: selection,
    includeSecrets: false,
    includeMemory: false,
  });
  assert.equal(input(initialConfigSyncForm()).deviceLabel, "This device");
});

test("opt-in categories ride the request, and secrets never enter drafts", () => {
  const credentialsOn = selectionFromDraft({ credentials: true, memory: true });
  const form = initialConfigSyncForm({ ...draftFromForm(initialConfigSyncForm(), credentialsOn), deviceLabel: "Studio" });
  const request = configSyncConfigureInput(form, credentialsOn, "This device");
  assert.equal(request.includeSecrets, true);
  assert.equal(request.includeMemory, true);
  assert.equal(request.categories.credentials, true);
  assert.doesNotMatch(JSON.stringify(draftFromForm({ ...form, backupPassword: "x", currentBackupPassword: "y", newBackupPassword: "z" }, selection)), /[Pp]assword/);
  const cleared = clearConfigSyncFormSecrets({ ...form, backupPassword: "a", currentBackupPassword: "b", newBackupPassword: "c" });
  for (const key of ["backupPassword", "currentBackupPassword", "newBackupPassword"]) assert.equal(cleared[key], "");
  assert.equal(cleared.deviceLabel, "Studio");
});

test("saved choices hydrate without turning off opt-ins or turning on automatic runs", () => {
  const state = { ...initialConfigSyncForm(), automaticSync: false, categories: selection,
    includeSecrets: true, includeMemory: true, mode: "backup" };
  const draft = draftFromState(state);
  const form = initialConfigSyncForm(draft);
  assert.equal(form.automaticSync, false);
  assert.equal(form.mode, "backup");
  assert.equal(draft.categories.credentials, true);
  assert.equal(draft.categories.memory, true);
  assert.equal(draft.saved, true);
  assert.deepEqual(Object.keys(draft).sort(), ["automaticSync", "categories", "deviceLabel", "mode", "saved"]);
});

test("legacy project choices never enter the supported selection or request", () => {
  const legacy = { ...selection, projects: true, providers: false };
  const supported = selectionFromDraft(legacy);
  assert.equal(Object.hasOwn(supported, "projects"), false);
  assert.equal(supported.providers, false);
  assert.equal(Object.keys(supported).length, 10);
  const form = initialConfigSyncForm();
  for (const value of [
    draftFromState({ categories: legacy, includeSecrets: false, includeMemory: false }).categories,
    draftFromForm(form, legacy).categories,
    configSyncConfigureInput(form, legacy, "This device").categories,
  ]) {
    assert.equal(Object.hasOwn(value, "projects"), false);
    assert.equal(value.providers, false);
  }
});

test("shared sync categories exclude projects while keeping scoped content", async () => {
  const { CONFIG_SYNC_CATEGORIES } = await import("../../../packages/shared/src/types/config-sync.ts");
  assert.equal(CONFIG_SYNC_CATEGORIES.includes("projects"), false);
  for (const category of ["mcp", "skills", "instructions", "automation", "memory"]) {
    assert.equal(CONFIG_SYNC_CATEGORIES.includes(category), true);
  }
  assert.deepEqual(Object.keys(selection).sort(), [...CONFIG_SYNC_CATEGORIES].sort());
});
