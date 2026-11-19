import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { WebhookEventStore } = await import("../electron/main/plugin-webhook-store.ts");

function fakeHost() {
  const rows = [];
  return {
    rows,
    async call(method, params) {
      if (method === "plugin.webhook.recordEvent") {
        rows.push({ ...params, deliveredAt: null });
        return {};
      }
      if (method === "plugin.webhook.pending") return { events: rows.filter((row) => row.pluginId === params.pluginId && row.deliveredAt === null) };
      if (method === "plugin.webhook.markDelivered") {
        rows.find((row) => row.eventId === params.eventId).deliveredAt = 1;
        return {};
      }
      if (method === "plugin.webhook.list") {
        return { events: rows.filter((row) => (!params.pluginId || row.pluginId === params.pluginId) && (params.beforeMs === undefined || row.receivedAt < params.beforeMs)), nextCursor: null };
      }
      if (method === "plugin.webhook.deleteByIds") {
        for (const id of params.eventIds) {
          const index = rows.findIndex((row) => row.eventId === id && (!params.pluginId || row.pluginId === params.pluginId));
          if (index >= 0) rows.splice(index, 1);
        }
        return {};
      }
      if (method === "plugin.webhook.purge" || method === "plugin.webhook.prune") {
        const events = [];
        for (let i = rows.length - 1; i >= 0; i--) {
          const row = rows[i];
          if (method.endsWith("purge") ? row.pluginId === params.pluginId : row.receivedAt < params.beforeMs) {
            events.push(...rows.splice(i, 1));
          }
        }
        return { events };
      }
      throw new Error(`Unknown method ${method}`);
    },
  };
}

const event = { pluginId: "example.plugin", webhookId: "hook", method: "POST", headers: { "X-Minih-Webhook-Token": "secret", "X-Event": "push" }, bodyText: "body", sourceIp: "127.0.0.1", receivedAt: 1_000 };

async function fixture(t, deliver) {
  const root = await mkdtemp(join(tmpdir(), "webhook-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = fakeHost();
  const store = new WebhookEventStore(root, host, deliver);
  return { root, host, store };
}

test("writes a private sidecar without token before recording and replays only unacknowledged events", async (t) => {
  let failing = true;
  const seen = [];
  const { root, host, store } = await fixture(t, async (_plugin, payload) => {
    seen.push(payload);
    if (failing) throw new Error("handler failed");
  });
  await store.accept(event);
  const row = host.rows[0];
  const directory = join(root, "plugin-webhooks", event.pluginId);
  const path = join(directory, row.bodyRef);
  const contents = await readFile(path, "utf8");
  assert.doesNotMatch(contents, /secret|x-minih-webhook-token/i);
  assert.deepEqual(JSON.parse(contents), { method: "POST", headers: { "x-event": "push" }, bodyText: "body" });
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  await assert.rejects(store.replay(event.pluginId), /handler failed/);
  assert.equal(row.deliveredAt, null);
  failing = false;
  const restarted = new WebhookEventStore(root, host, async (_plugin, payload) => seen.push(payload));
  await restarted.replay(event.pluginId);
  await restarted.replay(event.pluginId);
  assert.equal(seen.length, 2);
  assert.equal(row.deliveredAt, 1);
  assert.deepEqual({ ...seen[1].headers }, { "x-event": "push" });
});

test("cleanup and uninstall remove the associated rows and files only", async (t) => {
  const { root, host, store } = await fixture(t, async () => {});
  await store.accept(event);
  await store.accept({ ...event, pluginId: "other.plugin", receivedAt: 100_000 });
  const oldPath = join(root, "plugin-webhooks", event.pluginId, host.rows[0].bodyRef);
  const otherPath = join(root, "plugin-webhooks", "other.plugin", host.rows[1].bodyRef);
  await store.cleanup(1_000 + 7 * 24 * 60 * 60 * 1000 + 1);
  await assert.rejects(stat(oldPath), { code: "ENOENT" });
  assert.ok(await stat(otherPath));
  await store.purge("other.plugin");
  await assert.rejects(stat(otherPath), { code: "ENOENT" });
  assert.equal(host.rows.length, 0);
});

test("startup orphan cleanup deletes only generated files without database references", async (t) => {
  const { root, host, store } = await fixture(t, async () => {});
  await store.accept(event);
  const dir = join(root, "plugin-webhooks", event.pluginId);
  const referenced = join(dir, host.rows[0].bodyRef);
  const orphan = join(dir, "12345678-1234-4234-8234-123456789abc.json");
  const unrelated = join(dir, "notes.json");
  const temporary = join(dir, ".receivers-12345678-1234-4234-8234-123456789abc.tmp");
  await writeFile(orphan, "orphan");
  await writeFile(temporary, "orphan index");
  await writeFile(unrelated, "keep");
  await mkdir(join(dir, "12345678-1234-4234-8234-123456789def.json"));
  await store.cleanupOrphans();
  await assert.rejects(stat(orphan), { code: "ENOENT" });
  await assert.rejects(stat(temporary), { code: "ENOENT" });
  assert.ok(await stat(referenced));
  assert.ok(await stat(unrelated));
  assert.ok(await stat(join(dir, "12345678-1234-4234-8234-123456789def.json")));
});

test("a file deletion failure leaves its database row intact for retry", async (t) => {
  const { root, host, store } = await fixture(t, async () => {});
  await store.accept(event);
  const path = join(root, "plugin-webhooks", event.pluginId, host.rows[0].bodyRef);
  await rm(path);
  await mkdir(path);
  await assert.rejects(store.purge(event.pluginId));
  assert.equal(host.rows.length, 1);
  await rm(path, { recursive: true });
  await store.purge(event.pluginId);
  assert.equal(host.rows.length, 0);
});

test("cleanup refuses symlinked plugin directories without deleting external files", async (t) => {
  const { root, host, store } = await fixture(t, async () => {});
  await store.accept(event);
  const directory = join(root, "plugin-webhooks", event.pluginId);
  const other = join(root, "unrelated");
  await mkdir(other);
  const protectedFile = join(other, host.rows[0].bodyRef);
  await writeFile(protectedFile, "keep");
  await rm(directory, { recursive: true });
  await symlink(other, directory, "dir");
  await assert.rejects(store.purge(event.pluginId), /not a directory/);
  assert.equal(host.rows.length, 1);
  assert.equal(await readFile(protectedFile, "utf8"), "keep");
});

test("interrupted retention deletion is retryable before replay on restart", async (t) => {
  const { root, host, store } = await fixture(t, async () => {});
  await store.accept(event);
  const path = join(root, "plugin-webhooks", event.pluginId, host.rows[0].bodyRef);
  const call = host.call.bind(host);
  host.call = async (method, params) => {
    if (method === "plugin.webhook.deleteByIds") throw new Error("host unavailable");
    return call(method, params);
  };
  const now = event.receivedAt + 7 * 24 * 60 * 60 * 1000 + 1;
  await assert.rejects(store.cleanup(now), /host unavailable/);
  await assert.rejects(stat(path), { code: "ENOENT" });
  assert.equal(host.rows.length, 1);
  host.call = call;
  const restarted = new WebhookEventStore(root, host, async () => { throw new Error("expired event must not replay"); });
  await restarted.cleanup(now);
  await restarted.replay(event.pluginId);
  assert.equal(host.rows.length, 0);
});
