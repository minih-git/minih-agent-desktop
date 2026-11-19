import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerWebhookIpc } = await import("../electron/main/ipc/plugin-webhook-ipc.ts");

function fixture() {
  const handlers = new Map();
  const calls = [];
  let allowLan = false;
  registerWebhookIpc({
    registrar: {
      handleWithEvent: (channel, handler) => handlers.set(channel, handler),
      assertMainWindowSender: (event) => { if (!event.main) throw new Error("PERMISSION_DENIED"); },
    },
    webhooks: {
      list: async () => ({ loopbackOnly: false, receivers: [{ id: "hook", url: "http://127.0.0.1/hook", enabled: true, token: "fixture-secret" }] }),
      setLoopbackOnly: async (value) => calls.push(value),
    },
    openTokenDialog: async (pluginId, webhookId) => calls.push([pluginId, webhookId]),
    confirmLan: async () => allowLan,
    onError: () => {},
  }, { list: "list", setLoopback: "bind", tokenDialog: "dialog" });
  return { handlers, calls, allowLan: () => { allowLan = true; } };
}

test("main renderer sees receiver metadata but no token; other senders are denied", async () => {
  const { handlers, calls } = fixture();
  assert.deepEqual(await handlers.get("list")({ main: true }, "example.plugin"), {
    loopbackOnly: false,
    receivers: [{ id: "hook", url: "http://127.0.0.1/hook", enabled: true }],
  });
  await assert.rejects(handlers.get("dialog")({ main: false }, "example.plugin", "hook"), /PERMISSION_DENIED/);
  assert.equal(await handlers.get("dialog")({ main: true }, "example.plugin", "hook"), undefined);
  assert.deepEqual(calls, [["example.plugin", "hook"]]);
});

test("widening listener reach requires native confirmation", async () => {
  const { handlers, calls, allowLan } = fixture();
  await handlers.get("bind")({ main: true }, false);
  assert.deepEqual(calls, []);
  await handlers.get("bind")({ main: true }, true);
  allowLan();
  await handlers.get("bind")({ main: true }, false);
  assert.deepEqual(calls, [true, false]);
});
