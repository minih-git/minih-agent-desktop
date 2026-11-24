import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const bundled = await build({
  entryPoints: [join(root, "apps/desktop/electron/main/ipc/plugin-credentials-ipc.ts")],
  bundle: true, platform: "node", format: "esm", write: false,
  alias: { "@minih-agent/shared": join(root, "packages/shared/src/protocol.ts") },
});
const { registerPluginCredentialIpc } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const { IPC } = await import("../../../packages/shared/src/protocol.ts");

function harness(host) {
  const handlers = new Map();
  const changed = [];
  const answered = [];
  const registrar = {
    handleWithEvent(channel, handler) { handlers.set(channel, handler); },
    assertMainWindowSender(event) { if (!event.main) throw new Error("unauthorized sender"); },
  };
  registerPluginCredentialIpc(
    registrar,
    () => host,
    (pluginId, slotId) => changed.push({ pluginId, slotId }),
    (requestId, answer) => {
      answered.push({ requestId, answer });
      return true;
    },
  );
  const call = (channel, input, main = true) => handlers.get(channel)({ main }, input);
  return Object.assign(call, { changed, answered });
}

test("credential IPC returns only declared metadata and state, never stored values", async () => {
  const secret = "synthetic-credential-for-ipc-test";
  const call = harness({ call: async () => ({ slots: [{
    id: "mail", title: "Mail", kind: "bearer", configured: true, lastUsedAt: null,
    value: secret, fields: [{ key: "token", label: "Token", secret: true, value: secret }],
  }] }) });
  const result = await call(IPC.invoke.pluginCredentialsStatus, { pluginId: "demo.mail" });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(result.slots[0], {
    id: "mail", title: "Mail", kind: "bearer", configured: true, lastUsedAt: null,
    fields: [{ key: "token", label: "Token", secret: true }],
  });
  await assert.rejects(call(IPC.invoke.pluginCredentialsStatus, { pluginId: "demo.mail" }, false), /unauthorized sender/);
});

test("saving credentials never returns a host result or exposes host errors", async () => {
  const secret = "synthetic-credential-for-ipc-test";
  let fail = false;
  const requests = [];
  const call = harness({ call: async (method, params) => {
    requests.push({ method, params });
    if (fail) throw new Error(`injected failure ${secret}`);
    return { value: secret };
  } });
  const input = { pluginId: "demo.mail", slotId: "mail", fields: { token: secret } };
  // The IPC answers whether an instance was created, and never a stored value.
  assert.deepEqual(await call(IPC.invoke.pluginCredentialsSet, input), {});
  assert.equal(requests[0].method, "plugins.credentials.set");
  fail = true;
  await assert.rejects(call(IPC.invoke.pluginCredentialsSet, input), (error) => !error.message.includes(secret) && /save plugin credentials/i.test(error.message));
  await assert.rejects(call(IPC.invoke.pluginCredentialsClear, input), (error) => !error.message.includes(secret) && /clear plugin credentials/i.test(error.message));
});

test("editing an account forwards its instance id and announces the change", async () => {
  const requests = [];
  const call = harness({ call: async (method, params) => {
    requests.push({ method, params });
    return { instanceId: params.instanceId };
  } });
  const saved = await call(IPC.invoke.pluginCredentialsSet, {
    pluginId: "demo.multi",
    slotId: "mailbox",
    instanceId: "acc_00000001",
    fields: { username: "a@example.com", password: "synthetic-password" },
  });
  // The id travels with the fields: the host replaces that account in place
  // instead of adding a second one.
  assert.deepEqual(requests, [{
    method: "plugins.credentials.set",
    params: {
      pluginId: "demo.multi",
      slotId: "mailbox",
      instanceId: "acc_00000001",
      fields: { username: "a@example.com", password: "synthetic-password" },
    },
  }]);
  assert.deepEqual(saved, { instanceId: "acc_00000001" });
  // The plugin is told to re-read its accounts, exactly as after an add.
  assert.deepEqual(call.changed, [{ pluginId: "demo.multi", slotId: "mailbox" }]);
});
