import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const PASSWORD = "portable-backup-password";
export const MARKERS = ["S3 shared provider", "fixture-provider-secret", "S3 fixture instructions", "resource-first", "resource-updated", "fixture-mcp-secret", "fixture-router-backup-token", "Personal backup account", "Portable reasoning model"];
const categories = Object.fromEntries(["application", "providers", "credentials", "mcp", "skills", "subagents", "instructions", "plugins", "automation"].map((name) => [name, true]));
export const rpc = (host, method, params = {}) => host.call(method, params, 120_000);
const sync = (host) => rpc(host, "configSync.syncNow");
const settings = (host) => rpc(host, "settings.get");
const provider = async (host, id) => (await rpc(host, "providers.get", { id })).provider;

export function config(deviceLabel, extra = {}) {
  return { deviceLabel, backupPassword: PASSWORD, categories: { ...categories, memory: false }, includeSecrets: true, includeMemory: false, automaticSync: false, mode: "sync", ...extra };
}

// Link the Minih Router account the backup transport authenticates with. The
// row is device-local: every Host stores its own copy of the same account.
export async function connectRouter(host, router) {
  await rpc(host, "providers.create", {
    name: "Minih Router test account", vendorKey: "minih-router", type: "openai_compatible",
    protocol: "openai_compatible", authKind: "api_key_and_base_url",
    baseUrl: `${router.endpoint}/v1`, secretValue: router.accessKey, models: [],
  });
}

export async function approveAll(host, state, projectPath) {
  let next = state;
  for (let n = 0; next.pendingApprovals.length; n += 1) {
    assert.ok(n < 64, "approvals must converge");
    const item = next.pendingApprovals[0];
    assert.notEqual(item.reason, "conflict", "conflicts require an explicit choice");
    if (item.mappingKey) {
      assert.ok(projectPath, "mapped capability requires a local path");
      await rpc(host, "configSync.mapProject", { logicalId: item.mappingKey, paths: [projectPath] });
    }
    next = await rpc(host, "configSync.approve", { approvalId: item.id, digest: item.digest });
  }
  return next;
}

async function choose(host, state, suffix) {
  const item = state.pendingApprovals.find((value) => value.reason === "conflict" && value.entityId.endsWith(suffix));
  assert.ok(item, `missing explicit ${suffix} conflict candidate`);
  return rpc(host, "configSync.approve", { approvalId: item.id, digest: item.digest });
}

export async function runSyncJourney({ a, b, router, store, step }) {
  const configA = config("Device A");
  const configB = config("Device B", { includeSecrets: false });
  step("configure-and-credential-reuse");
  assert.deepEqual(await rpc(a, "configSync.test"), { ok: true, conditionalWrites: true });
  assert.equal((await rpc(a, "configSync.configure", configA)).mode, "sync");
  // The vault password is entered once; a later save reuses the unlocked key.
  assert.equal((await rpc(a, "configSync.configure", { ...configA, backupPassword: "" })).configured, true);
  await rpc(a, "settings.set", { theme: "light", language: "en", networkPolicy: { mode: "strict" } });
  // Strict mode is device-local. Local HTTP is tested under relaxed policy only.
  if (router.endpoint.startsWith("http:")) await rpc(a, "settings.set", { networkPolicy: { mode: "relaxed" } });
  await sync(a);
  const { provider: shared } = await rpc(a, "providers.create", {
    name: MARKERS[0], vendorKey: "s3-fixture", type: "openai_compatible", protocol: "openai_compatible",
    authKind: "api_key_and_base_url", secretValue: MARKERS[1], baseUrl: "http://127.0.0.1:9/v1", models: [],
  });
  await rpc(b, "settings.set", { theme: "light", language: "en" });
  await sync(a);
  await rpc(b, "configSync.configure", configB);
  step("new-device-approval-and-credential-opt-out");
  let state = await sync(b);
  assert.ok(state.pendingApprovals.some((item) => item.entityId.includes(shared.id)));
  assert.equal(await provider(b, shared.id), null, "provider must not appear before approval");
  state = await approveAll(b, state);
  assert.equal((await provider(b, shared.id)).hasSecret, false);
  assert.equal((await provider(b, shared.id)).enabled, false);
  assert.equal((await provider(a, shared.id)).hasSecret, true);
  assert.equal((await settings(b)).theme, "light");
  assert.equal((await settings(b)).networkPolicy.mode, "relaxed", "local policy is not synchronized");
  step("mcp-approval-and-credential-opt-out");
  await rpc(a, "mcp.upsert", { id: "s3-mcp", label: "S3 fixture MCP", level: "global", transport: "stdio", command: "never-execute-this-fixture", env: { API_KEY: MARKERS[5] }, enabled: false });
  await sync(a);
  state = await sync(b);
  assert.ok(state.pendingApprovals.some((item) => item.domain === "mcp"));
  assert.equal((await rpc(b, "mcp.list", { level: "global" })).servers.length, 0);
  await approveAll(b, state);
  const importedMcp = (await rpc(b, "mcp.list", { level: "global" })).servers.find((item) => item.id === "s3-mcp");
  assert.ok(importedMcp);
  assert.deepEqual(importedMcp.env ?? {}, {});
  assert.deepEqual(importedMcp.headers ?? {}, {});
  assert.equal(importedMcp.enabled, false);
  await rpc(a, "mcp.remove", { id: "s3-mcp", level: "global" });
  await sync(a);
  await approveAll(b, await sync(b));
  await sync(b);
  await sync(a);
  assert.equal((await rpc(b, "mcp.list", { level: "global" })).servers.length, 0);


  step("concurrent-disjoint-edits");
  await rpc(a, "settings.set", { theme: "dark" });
  await rpc(b, "settings.set", { language: "de" });
  await Promise.all([sync(a), sync(b)]);
  await sync(a);
  await sync(b);
  for (const host of [a, b]) {
    const value = await settings(host);
    assert.equal(value.theme, "dark");
    assert.equal(value.language, "de");
    assert.equal((await rpc(host, "configSync.getState")).pendingApprovals.length, 0);
  }

  step("same-entity-conflict-explicit-choice");
  await rpc(a, "settings.set", { theme: "light" });
  await rpc(b, "settings.set", { theme: "system" });
  await sync(a);
  state = await sync(b);
  assert.equal(state.status, "conflict");
  assert.equal((await settings(b)).theme, "system", "unapproved conflict must not overwrite local settings");
  await choose(b, state, ":remote");
  assert.equal((await settings(b)).theme, "light");
  await sync(b);
  await sync(a);

  step("remote-deletion-versus-offline-edit");
  await rpc(b, "providers.update", { id: shared.id, name: "Offline provider edit" });
  await rpc(a, "providers.delete", { id: shared.id });
  await sync(a);
  state = await sync(b);
  assert.equal(state.status, "conflict");
  assert.equal((await provider(b, shared.id)).name, "Offline provider edit");
  await choose(b, state, ":local");
  assert.equal((await provider(b, shared.id)).name, "Offline provider edit");
  await sync(b);
  await approveAll(a, await sync(a));
  assert.equal((await provider(a, shared.id)).name, "Offline provider edit");
  await rpc(a, "providers.delete", { id: shared.id });
  await sync(a);
  await approveAll(b, await sync(b));
  await sync(b);
  await sync(a);
  assert.equal(await provider(b, shared.id), null, "unchanged opted-out receiver must accept deletion");

  step("project-data-stays-local");
  const projectA = join(a.dataDir, "project-a");
  const projectB = join(b.dataDir, "project-b");
  await Promise.all([mkdir(projectA), mkdir(projectB)]);
  const { group: sourceGroup } = await rpc(a, "project.group.create", { name: "Device A workspace", folders: [projectA] });
  const remoteProjectsBefore = await rpc(b, "projects.list");
  const remoteGroupsBefore = await rpc(b, "project.groups.list");
  // Every project-scoped record device A can produce: an instruction file, a
  // project and group memory note, a project MCP server, a project skill with a
  // package resource, and a folder-bound automation.
  await writeFile(join(projectA, "AGENTS.md"), "device A guidance\n");
  await rpc(a, "project.memory.set", { path: projectA, content: "device A memory" });
  await rpc(a, "project.group.memory.set", { groupId: sourceGroup.id, entries: [{ id: "note", title: "Note", content: "device A group memory" }] });
  await rpc(a, "mcp.upsert", { id: "s3-project-mcp", label: "Device A project MCP", level: "project", projectPath: projectA, transport: "stdio", command: "never-execute-this-fixture", env: { PROJECT_TOKEN: "device-a-mcp-secret" }, enabled: false });
  const { skill: projectSkill } = await rpc(a, "skills.create", {
    id: "s3-project-skill", name: "S3 project skill", level: "project", projectPath: projectA,
    body: "device A skill", shape: "dir",
  });
  const projectResource = join(dirname(projectSkill.path), "data.txt");
  await writeFile(projectResource, MARKERS[3]);
  await rpc(a, "scheduled.create", { title: "Device A daily", prompt: "device A only", cadence: "daily", workspacePath: projectA, enabled: false, schedule: { hour: 9, minute: 0, weekday: 0 } });
  await sync(a);
  // Nothing above needs an approval, because none of it travels.
  state = await sync(b);
  assert.equal(state.pendingApprovals.length, 0, "project data must never reach the approval inbox");
  assert.equal((await rpc(b, "skills.list", { level: "project", projectPath: projectB })).skills.length, 0);
  assert.equal((await rpc(b, "mcp.list", { level: "project", projectPath: projectB })).servers.length, 0);
  assert.equal((await rpc(b, "scheduled.list")).tasks.length, 0, "folder-bound automations stay on their device");
  assert.equal((await rpc(b, "project.memory.get", { path: projectB })).memory.content, "");
  assert.deepEqual(await rpc(b, "projects.list"), remoteProjectsBefore, "sync must not register source projects on another device");
  assert.deepEqual(await rpc(b, "project.groups.list"), remoteGroupsBefore, "sync must not create source project groups");
  // Workspace registration stays a local user action.
  await rpc(b, "project.group.create", { name: "Device B workspace", folders: [projectB] });
  const localGroups = await rpc(b, "project.groups.list");
  await rpc(a, "project.group.rename", { groupId: sourceGroup.id, name: "Renamed Device A workspace" });
  await sync(a);
  await sync(b);
  assert.deepEqual(await rpc(b, "project.groups.list"), localGroups, "a device keeps its own project groups");
  assert.equal((await rpc(b, "skills.list", { level: "project", projectPath: projectB })).skills.length, 0);

  step("project-archive-cross-device-import");
  const archivePath = join(a.dataDir, "device-a-project.zip");
  const exported = await rpc(a, "project.archive.export", { projectPath: projectA, targetPath: archivePath });
  assert.equal(exported.roots, 1);
  assert.ok(exported.files >= 2, `archive files: ${exported.files}`);
  const archiveBytes = await readFile(archivePath);
  assert.equal(
    archiveBytes.includes(Buffer.from("device-a-mcp-secret")),
    false,
    "an MCP env value must never travel in the archive",
  );
  assert.equal(archiveBytes.includes(Buffer.from(a.dataDir)), false, "no source path in the archive");
  const destination = join(b.dataDir, "imported");
  await mkdir(destination, { recursive: true });
  const imported = await rpc(b, "project.archive.import", { archivePath, targetParentPath: destination });
  assert.equal(imported.projectPaths.length, 1);
  const restoredProject = imported.projectPaths[0];
  assert.ok(restoredProject.startsWith(destination), "the project is restored under the chosen parent");
  assert.equal(await readFile(join(restoredProject, "AGENTS.md"), "utf8"), "device A guidance\n");
  // The app-managed records come from the manifest, sanitized and disabled.
  const restoredMcp = (await rpc(b, "mcp.list", { level: "project", projectPath: restoredProject })).servers
    .find((item) => item.id === "s3-project-mcp");
  assert.ok(restoredMcp);
  assert.equal(restoredMcp.enabled, false);
  assert.deepEqual(restoredMcp.env ?? {}, {});
  // A project skill travels as the file it is and is re-scanned on the far side.
  const restoredSkills = (await rpc(b, "skills.list", { level: "project", projectPath: restoredProject })).skills;
  assert.ok(restoredSkills.some((item) => item.id === "s3-project-skill"), JSON.stringify(restoredSkills));
  const restoredTasks = (await rpc(b, "scheduled.list")).tasks
    .filter((item) => item.workspacePath === restoredProject);
  assert.equal(restoredTasks.length, 1, "the bound automation travels with the project");
  assert.equal(restoredTasks[0].enabled, false, "an imported automation stays disabled");
  // A second import into the same parent is refused and leaves no copy behind.
  await assert.rejects(
    rpc(b, "project.archive.import", { archivePath, targetParentPath: destination }),
    /PROJECT_ARCHIVE_CONFLICT/,
  );

  step("global-skill-approval-resource-update-and-deletion");
  const { skill } = await rpc(a, "skills.create", {
    id: "s3-resource-skill", name: "S3 resource skill", level: "global",
    body: MARKERS[2], shape: "dir",
  });
  const source = join(dirname(skill.path), "data.txt");
  await writeFile(source, MARKERS[3]);
  await sync(a);
  state = await sync(b);
  assert.ok(state.pendingApprovals.some((item) => item.domain === "skills"));
  const skillsOnB = async () => (await rpc(b, "skills.list", { level: "global" })).skills.filter((item) => item.id === skill.id);
  assert.equal((await skillsOnB()).length, 0);
  await approveAll(b, state);
  const importedSkill = (await skillsOnB())[0];
  assert.ok(importedSkill, "approved global skill must arrive");
  assert.ok(
    !importedSkill.path.startsWith(a.dataDir),
    "source machine path must not become destination",
  );
  const globalResource = join(dirname(importedSkill.path), "data.txt");
  assert.equal(await readFile(globalResource, "utf8"), MARKERS[3]);
  await writeFile(source, MARKERS[4]);
  await sync(a);
  await approveAll(b, await sync(b));
  assert.equal(await readFile(globalResource, "utf8"), MARKERS[4]);
  await rpc(a, "skills.remove", { id: skill.id, level: "global" });
  await sync(a);
  await approveAll(b, await sync(b));
  assert.equal((await skillsOnB()).length, 0, "a removed global skill must be deleted on the peer");
  // The regression this guards: a deletion that is re-advertised on the next
  // capture would come back as a new approval after any repeated sync.
  await sync(b);
  await sync(a);
  await sync(b);
  assert.equal((await skillsOnB()).length, 0, "a deleted global skill must not revive");
  assert.equal((await rpc(b, "configSync.getState")).pendingApprovals.length, 0);

  step("plugin-uninstall-deletion-convergence");
  const pluginSource = join(a.dataDir, "plugin-fixture");
  await mkdir(pluginSource, { recursive: true });
  await writeFile(join(pluginSource, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: "s3-e2e-plugin", name: "S3 e2e plugin", version: "1.0.0", main: "main.js", permissions: [] }));
  await writeFile(join(pluginSource, "main.js"), "module.exports = {};");
  await rpc(a, "plugins.installFromPath", { path: pluginSource, enable: false });
  await sync(a);
  state = await sync(b);
  assert.ok(state.pendingApprovals.some((item) => item.domain === "plugins"), "an installation intent needs approval");
  await approveAll(b, state);
  assert.ok((await rpc(b, "plugins.list")).plugins.every((item) => item.id !== "s3-e2e-plugin"), "intent never installs bytes");
  await rpc(a, "plugins.uninstall", { id: "s3-e2e-plugin" });
  await sync(a);
  await approveAll(b, await sync(b));
  await sync(b);
  await sync(a);
  await sync(b);
  assert.equal((await rpc(b, "configSync.getState")).pendingApprovals.length, 0, "an uninstalled plugin must not be re-advertised");

  await approveAll(a, await sync(a));
  await approveAll(b, await sync(b));
  step("sync-restore-publishes-and-survives-restart");
  await rpc(a, "settings.set", { theme: "dark" });
  const oldRevision = (await sync(a)).lastRevisionId;
  await sync(b);
  await rpc(a, "settings.set", { theme: "light" });
  await sync(a);
  await sync(b);
  await assert.rejects(rpc(a, "configSync.restore", { revisionId: oldRevision }), /CONFIG_SYNC_INVALID/);
  const restored = await rpc(a, "configSync.restore", { revisionId: oldRevision, acknowledgePropagation: true });
  assert.notEqual(restored.lastRevisionId, oldRevision);
  await approveAll(a, restored, projectA);
  assert.equal((await settings(a)).theme, "dark");
  await approveAll(b, await sync(b), projectB);
  assert.equal((await settings(b)).theme, "dark");
  const files = await readdir(join(a.dataDir, "config-sync"), { recursive: true });
  assert.ok(files.some((name) => name.includes("recovery")), "restore must create local recovery data");
  await b.restart();
  const restartedState = await rpc(b, "configSync.getState");
  assert.equal(restartedState.configured, true, "Host restart must preserve S3 configuration");
  assert.equal((await settings(b)).theme, "dark");
  await sync(b);
  if (store.failWith) {
    step("temporary-outage-and-retry");
    store.failWith(502);
    await assert.rejects(sync(b), /CONFIG_SYNC_SERVER/);
    assert.equal((await rpc(b, "configSync.getState")).status, "offline");
    store.failWith(null);
    await sync(b);
    assert.equal((await settings(b)).theme, "dark");
  }
  return { projectA, projectB };
}

export async function runBackupJourney({ a, b, c, d, step }) {
  step("backup-isolation-and-local-only-restore");
  const backupConfig = config("Backup C", { mode: "backup" });
  await rpc(c, "configSync.configure", backupConfig);
  await rpc(c, "settings.set", { theme: "system" });
  const syncHead = (await rpc(a, "configSync.listHistory"))[0].revisionId;
  const first = (await sync(c)).lastRevisionId;
  assert.equal((await settings(c)).theme, "system");
  assert.equal((await rpc(c, "providers.list")).providers.filter((row) => row.vendorKey !== "minih-router").length, 0);
  assert.equal((await sync(c)).lastRevisionId, first, "unchanged backup must not duplicate revisions");
  await rpc(d, "configSync.configure", config("Backup D", { mode: "backup" }));
  await rpc(d, "settings.set", { theme: "light" });
  const second = (await sync(d)).lastRevisionId;
  assert.notEqual(second, first);
  assert.equal((await settings(d)).theme, "light");
  assert.equal((await sync(c)).lastRevisionId, first, "another device's backup is not merged");
  assert.equal((await settings(c)).theme, "system");
  const history = await rpc(c, "configSync.listHistory");
  assert.equal(history[0].revisionId, second);
  assert.ok(history.some((entry) => entry.revisionId === first));
  await rpc(c, "settings.set", { theme: "dark" });
  await rpc(c, "configSync.restore", { revisionId: first });
  assert.equal((await settings(c)).theme, "system");
  assert.equal((await rpc(c, "configSync.listHistory"))[0].revisionId, second);
  assert.equal((await rpc(a, "configSync.listHistory"))[0].revisionId, syncHead);
  assert.equal((await settings(a)).theme, "dark");

  step("account-model-configuration-backup-and-fresh-device-restore");
  // An ordinary provider account. The connected Minih Router row is the backup
  // transport's own identity, stays device-local, and is deliberately not here.
  const { provider: router } = await rpc(c, "providers.create", {
    name: MARKERS[7], vendorKey: "fixture-cloud", type: "openai_compatible",
    protocol: "openai_compatible", authKind: "api_key_and_base_url",
    baseUrl: "http://127.0.0.1:9/v1", secretValue: MARKERS[6],
    oauthAccountLabel: "Fixture account label", apiStyle: "responses",
    supportsReasoning: true, supportedThinkingLevels: ["low", "high"],
    contextWindow: 200000, maxOutputTokens: 8192, temperature: 0.4,
    headers: { "User-Agent": "Portable fixture" },
    models: [{
      id: "fixture-reasoning", alias: MARKERS[8],
      contextWindow: 200000, contextWindowSource: "user",
      maxTokens: 8192, maxTokensSource: "user",
      thinkingLevels: ["low", "high"], defaultThinkingLevel: "high",
      thinkingProtocol: "adaptive", supportsImages: true, supportsDocuments: false,
      availableForSubagents: true, nativeWebSearch: true, apiStyle: "responses",
    }, {
      id: "fixture-second", alias: "Secondary model",
      contextWindow: 64000, maxTokens: 4096, thinkingLevels: [],
    }],
  });
  const imageBinding = { providerId: router.id, modelId: "fixture-second" };
  await rpc(c, "settings.set", {
    defaultProviderId: router.id, defaultModelId: "fixture-second",
    imageGeneration: imageBinding, imageGenerationModels: [imageBinding],
  });
  const accountRevision = (await sync(c)).lastRevisionId;
  const beforeRestoreHistory = await rpc(d, "configSync.listHistory");
  assert.equal(await provider(d, router.id), null);
  const pending = await rpc(d, "configSync.restore", { revisionId: accountRevision });
  assert.ok(pending.pendingApprovals.some((item) => item.domain === "providers"));
  assert.equal(await provider(d, router.id), null, "restored credentials require approval");
  await approveAll(d, pending);
  const checkRestoredAccount = async () => {
    const restoredRouter = await provider(d, router.id);
    assert.ok(restoredRouter?.hasSecret, "approved opt-in restores the saved router token");
    assert.equal(restoredRouter.hasOauth, false, "restore never invents an OAuth session");
    for (const field of ["name", "vendorKey", "baseUrl", "authKind", "oauthAccountLabel",
      "apiStyle", "supportsReasoning", "supportedThinkingLevels", "contextWindow",
      "maxOutputTokens", "temperature", "headers", "models", "defaultModelId"]) {
      assert.deepEqual(restoredRouter[field], router[field], `restored account field: ${field}`);
    }
    const restoredSettings = await settings(d);
    assert.equal(restoredSettings.defaultProviderId, router.id);
    assert.equal(restoredSettings.defaultModelId, "fixture-second");
    assert.deepEqual(restoredSettings.imageGeneration, imageBinding);
    assert.deepEqual(restoredSettings.imageGenerationModels, [imageBinding]);
    assert.equal((await rpc(d, "providers.list")).providers.filter((row) => row.id === router.id).length, 1);
    assert.deepEqual(await rpc(d, "configSync.listHistory"), beforeRestoreHistory,
      "restoring an account does not publish a backup revision");
    assert.equal((await rpc(a, "configSync.listHistory"))[0].revisionId, syncHead);
  };
  await checkRestoredAccount();
  await d.restart();
  await checkRestoredAccount();

  step("password-rewrap-new-device-and-existing-device");
  const nextPassword = "replacement-backup-password";
  await rpc(a, "configSync.changePassword", { currentPassword: PASSWORD, newPassword: nextPassword });
  await sync(b); // An unlocked peer retains the data key: rewrap is not revocation.
  await rpc(d, "configSync.disconnect");
  await assert.rejects(rpc(d, "configSync.configure", config("Fresh D")), /CONFIG_SYNC_CRYPTO/);
  await rpc(d, "configSync.configure", config("Fresh D", { backupPassword: nextPassword, mode: "backup" }));
  assert.equal((await rpc(d, "configSync.getState")).configured, true);
}
