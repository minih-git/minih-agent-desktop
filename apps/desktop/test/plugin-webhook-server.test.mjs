import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { createServer, request } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginWebhookServer } = await import("../electron/main/plugin-webhook-server.ts");

async function occupyPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

function post(port, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: options.path ?? "/hooks/demo/hook", method: options.method ?? "POST", headers: options.headers ?? {} }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    if (options.keepOpen) req.flushHeaders();
    else req.end(options.body);
  });
}

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "webhook-test-"));
  const occupied = await occupyPort();
  await writeFile(join(dataDir, "webhook.port"), String(occupied.port));
  const events = [];
  const errors = [];
  const receiver = { token: "secret", maxBodyBytes: 8, ratePerMinute: 2 };
  const server = new PluginWebhookServer({
    dataDir,
    receiver: (pluginId, webhookId) => pluginId === "demo" && webhookId === "hook" ? receiver : undefined,
    accept: async (event) => events.push(event),
    onError: (error) => errors.push(error),
    ...overrides,
  });
  const port = await server.start(true);
  t.after(async () => {
    await server.stop();
    await new Promise((resolve) => occupied.server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { server, port, dataDir, occupied, events, errors, receiver };
}

const token = { "X-Minih-Webhook-Token": "secret" };

test("HTTP response codes, bounded body and sanitized event", async (t) => {
  const { port, events } = await fixture(t);
  assert.equal(await post(port, { path: "/hooks/other/hook" }), 404);
  assert.equal(await post(port, { method: "GET" }), 405);
  assert.equal(await post(port), 401);
  assert.equal(await post(port, { headers: { ...token, "X-Minih-Webhook-Token": "wrong" } }), 401);
  assert.equal(await post(port, { headers: token, body: "012345678" }), 413);
  assert.equal(await post(port, { headers: { ...token, "X-Event": "push" }, body: "hello" }), 202);
  assert.equal(events.length, 1);
  assert.equal(events[0].bodyText, "hello");
  assert.equal(events[0].headers["x-event"], "push");
  assert.equal(events[0].headers["x-minih-webhook-token"], undefined);
  assert.equal(await post(port, { headers: token }), 202);
  assert.equal(await post(port, { headers: token }), 429);
});

test("delivered headers have bounded count and value size", async (t) => {
  const { port, events } = await fixture(t);
  const headers = { ...token, "x-long": "a".repeat(5000) };
  for (let index = 0; index < 80; index += 1) headers[`x-field-${index}`] = "value";
  assert.equal(await post(port, { headers, body: "ok" }), 202);
  assert.equal(events[0].headers["x-long"].length, 4096);
  assert.ok(Object.keys(events[0].headers).length <= 64);
  assert.equal(events[0].headers["x-minih-webhook-token"], undefined);
});

test("rejects an oversized chunked stream without waiting for its end", async (t) => {
  const { port, events } = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/hooks/demo/hook", method: "POST", headers: token }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.write("012345678");
  });
  assert.equal(status, 413);
  assert.deepEqual(events, []);
});

test("rejects disallowed source before the request body arrives", async (t) => {
  const { port, events } = await fixture(t, { sourceFilter: { allows: () => false } });
  assert.equal(await post(port, { headers: token, keepOpen: true }), 403);
  assert.deepEqual(events, []);
});

test("occupied preferred port falls back, persists and is reused", async (t) => {
  const { server, port, dataDir, occupied } = await fixture(t);
  assert.notEqual(port, occupied.port);
  assert.equal(Number((await readFile(join(dataDir, "webhook.port"), "utf8")).trim()), port);
  await server.stop();
  assert.equal(await server.start(true), port);
});

test("a persistence failure cannot be accepted and does not consume the rate limit", async (t) => {
  let fail = true;
  const { port, errors } = await fixture(t, { accept: async () => { if (fail) throw new Error("sensitive body"); } });
  assert.equal(await post(port, { headers: token }), 500);
  fail = false;
  assert.equal(await post(port, { headers: token }), 202);
  assert.equal(await post(port, { headers: token }), 202);
  assert.equal(await post(port, { headers: token }), 429);
  assert.deepEqual(errors, ["webhook request failed"]);
});

test("revocation waits for a persistence write already in progress", async (t) => {
  let started;
  let release;
  const writing = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const { server, port } = await fixture(t, { accept: async () => { started(); await gate; } });
  const response = post(port, { headers: token, body: "ok" }).catch(() => null);
  await writing;
  let revoked = false;
  const pending = server.revoke("demo").then(() => { revoked = true; });
  await Promise.resolve();
  assert.equal(revoked, false);
  release();
  await pending;
  await response;
  assert.equal(revoked, true);
});
