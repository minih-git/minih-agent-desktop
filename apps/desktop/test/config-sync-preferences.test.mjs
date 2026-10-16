import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../src/features/settings/config-sync-preferences.ts", import.meta.url),
  "utf8",
);
const require = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url));
const { transform } = require("esbuild");
const compiled = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
const preferences = await import(`data:text/javascript,${encodeURIComponent(compiled.code)}`);

function fakeStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const preferences0 = {
  mode: "sync",
  automaticSync: false,
  deviceLabel: "MacBook",
};
const entries = [{ revisionId: "revision-a", current: true }];

test("router drafts round-trip only typed non-sensitive choices", () => {
  const store = fakeStorage();
  const draft = {
    ...preferences0,
    categories: { providers: true, credentials: false },
    saved: false,
  };
  preferences.writeConfigSyncDraft({
    ...draft,
    backupPassword: "never-persist-password",
    currentBackupPassword: "never-persist-current",
    newBackupPassword: "never-persist-new",
  }, store);
  const raw = store.values.get(preferences.CONFIG_SYNC_DRAFT_STORAGE_KEY);
  assert.doesNotMatch(raw, /never-persist|endpoint|bucket|accessKeyId|[Pp]assword/);
  assert.deepEqual(preferences.readConfigSyncDraft(store), draft);
});

test("the draft key is the router key and S3 fields are gone from it", () => {
  assert.equal(preferences.CONFIG_SYNC_DRAFT_STORAGE_KEY, "pi.desktop.configSyncRouterDraft.v1");
  assert.match(source, /const TEXT_FIELDS = \["deviceLabel"\]/);
  assert.match(source, /const BOOLEAN_FIELDS = \["automaticSync", "saved"\]/);
  const store = fakeStorage();
  store.setItem(preferences.CONFIG_SYNC_DRAFT_STORAGE_KEY, JSON.stringify({
    ...preferences0,
    endpoint: "https://s3.example.com", bucket: "private", accessKeyId: "id", pathStyle: true,
  }));
  assert.deepEqual(preferences.readConfigSyncDraft(store), preferences0);
});

test("writing the router draft retires the legacy S3 draft key", () => {
  const store = fakeStorage();
  store.setItem("pi.desktop.configSyncS3Draft.v1", JSON.stringify({ endpoint: "https://s3.example.com", bucket: "private" }));
  preferences.writeConfigSyncDraft(preferences0, store);
  assert.equal(store.getItem("pi.desktop.configSyncS3Draft.v1"), null);
  assert.ok(store.getItem(preferences.CONFIG_SYNC_DRAFT_STORAGE_KEY));
});

test("old WebDAV drafts are ignored and left untouched", () => {
  const store = fakeStorage();
  const legacy = JSON.stringify({ endpoint: "https://dav.example.com", username: "alice", directory: "old" });
  store.setItem("pi.desktop.configSyncDraft", legacy);
  assert.deepEqual(preferences.readConfigSyncDraft(store), {});
  preferences.clearConfigSyncDraft(store);
  assert.equal(store.getItem("pi.desktop.configSyncDraft"), legacy);
});

test("draft rejects malformed fields and strips injected credentials on read", () => {
  const store = fakeStorage();
  store.setItem(preferences.CONFIG_SYNC_DRAFT_STORAGE_KEY, JSON.stringify({
    deviceLabel: "x".repeat(2049), mode: "unsafe", automaticSync: "yes",
    categories: { providers: "yes", mcp: true }, saved: "no",
    backupPassword: "hidden",
  }));
  assert.deepEqual(preferences.readConfigSyncDraft(store), { categories: { mcp: true } });
  store.setItem(preferences.CONFIG_SYNC_DRAFT_STORAGE_KEY, "{");
  assert.deepEqual(preferences.readConfigSyncDraft(store), {});
});

test("history expires and account or mode changes invalidate it immediately", () => {
  const account = { accountConnected: true, accountEndpoint: "https://router.example.com", mode: "sync" };
  preferences.cacheConfigSyncState({ ...account, configured: true });
  preferences.cacheConfigSyncHistory(entries, 1000);
  assert.equal(preferences.hasFreshConfigSyncHistory(1000), true);
  assert.equal(preferences.hasFreshConfigSyncHistory(1000 + preferences.CONFIG_SYNC_HISTORY_CACHE_TTL_MS), false);
  preferences.cacheConfigSyncState({ ...account, configured: true, status: "syncing" });
  assert.deepEqual(preferences.getCachedConfigSyncHistory(), entries);
  for (const [field, value] of Object.entries({
    accountConnected: false, accountEndpoint: "https://other.example.com", mode: "backup", configured: false,
  })) {
    preferences.cacheConfigSyncState({ ...account, configured: true });
    preferences.cacheConfigSyncHistory(entries, 1000);
    assert.equal(preferences.cacheConfigSyncState({ ...account, configured: true, [field]: value }), true);
    assert.deepEqual(preferences.getCachedConfigSyncHistory(), [], field);
    assert.equal(preferences.hasFreshConfigSyncHistory(1000), false, field);
  }
});

test("legacy project selection is discarded on draft read and write", () => {
  const store = fakeStorage();
  store.setItem(preferences.CONFIG_SYNC_DRAFT_STORAGE_KEY, JSON.stringify({
    ...preferences0, categories: { projects: true, providers: false, memory: true },
  }));
  assert.deepEqual(preferences.readConfigSyncDraft(store), {
    ...preferences0, categories: { providers: false, memory: true },
  });
  preferences.writeConfigSyncDraft({ ...preferences0, categories: { projects: false, mcp: true } }, store);
  const saved = JSON.parse(store.getItem(preferences.CONFIG_SYNC_DRAFT_STORAGE_KEY));
  assert.deepEqual(saved.categories, { mcp: true });
  assert.equal(Object.hasOwn(saved.categories, "projects"), false);
});
