/**
 * The host-owned credential dialog (`pi.credentials.requestAdd` /
 * `requestRemove`).
 *
 * Two layers, both real:
 *
 * * the port (`plugin-credential-dialog.ts`) decides the three refusals the user
 *   never sees a form for — not focused, dialog busy, and everything the timeout
 *   or a shutdown must clean up;
 * * the runtime decides what the plugin may ask at all — a declared
 *   multi-instance slot, under its `max`, with a slot it may address.
 *
 * The value a user types never appears in either answer: the plugin is told an
 * instance id, and nothing else.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createPluginCredentialDialog } = await import("../electron/main/plugin-credential-dialog.ts");
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));

const SECRET = "synthetic-password-for-the-dialog";
const INSTANCES = [
  { instanceId: "acc_00000001", label: "a@example.com", publicFields: { username: "a@example.com" }, configured: true },
  { instanceId: "acc_00000002", label: "b@example.com", publicFields: { username: "b@example.com" }, configured: true },
];

function code(name) {
  return (error) => {
    assert.equal(error.code, name, `expected ${name}, got ${error.code} (${error.message})`);
    return true;
  };
}

/** A port over a fake renderer that records what it was asked to show. */
function port(overrides = {}) {
  const sent = [];
  const stored = [];
  const cleared = [];
  const instance = createPluginCredentialDialog({
    send: (channel, payload) => sent.push({ channel, payload }),
    isWindowFocused: () => true,
    setCredential: async (pluginId, slotId, fields) => {
      stored.push({ pluginId, slotId, fields });
      return "acc_00000003";
    },
    clearCredential: async (pluginId, slotId, instanceId) => {
      cleared.push({ pluginId, slotId, instanceId });
      return true;
    },
    timeoutMs: 40,
    cooldownMs: 30,
    ...overrides,
  });
  return { instance, sent, stored, cleared };
}

const scope = { pluginId: "demo.mail", pluginName: "Mail", slotId: "mailbox" };

test("a plugin with a focused window gets a form, and only the instance id comes back", async () => {
  const { instance, sent, stored } = port();
  const pending = instance.add(scope);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.kind, "add");
  assert.equal(sent[0].payload.pluginName, "Mail");
  assert.equal(sent[0].payload.slotId, "mailbox");
  assert.equal(instance.answer(sent[0].payload.requestId, { action: "submit", fields: { password: SECRET } }), true);
  const answer = await pending;
  assert.deepEqual(answer, { instanceId: "acc_00000003" });
  assert.deepEqual(stored, [{ pluginId: "demo.mail", slotId: "mailbox", fields: { password: SECRET } }]);
});

test("a second dialog for the same plugin is refused while the first is open", async () => {
  const { instance, sent } = port();
  const first = instance.add(scope);
  assert.equal(sent.length, 1);
  await assert.rejects(instance.add(scope), code("CREDENTIAL_DIALOG_BUSY"));
  // The busy refusal did not open a second form.
  assert.equal(sent.length, 1);
  instance.answer(sent[0].payload.requestId, { action: "cancel" });
  assert.deepEqual(await first, { cancelled: true });
});

test("no dialog is shown while the app window is not in front", async () => {
  const { instance, sent } = port({ isWindowFocused: () => false });
  await assert.rejects(instance.add(scope), code("CREDENTIAL_DIALOG_UNAVAILABLE"));
  assert.deepEqual(sent, []);
});

test("an unanswered dialog times out as cancelled", async () => {
  const { instance } = port({ timeoutMs: 10 });
  assert.deepEqual(await instance.add(scope), { cancelled: true });
});

test("cancelling and unloading both close the form, and a late answer is not accepted", async () => {
  const { instance, sent } = port({ timeoutMs: 5_000 });
  const first = instance.add(scope);
  instance.cancelPlugin("demo.mail");
  assert.deepEqual(await first, { cancelled: true });
  assert.equal(instance.answer(sent[0].payload.requestId, { action: "submit", fields: {} }), false);

  const second = instance.add({ ...scope, pluginId: "demo.other", pluginName: "Other" });
  instance.cancelAll();
  assert.deepEqual(await second, { cancelled: true });
});

test("the plugin is told a coded refusal when the store rejects the new instance", async () => {
  const { instance, sent } = port({
    setCredential: async () => {
      throw Object.assign(new Error("duplicate label"), { errorCode: "CREDENTIAL_INVALID" });
    },
  });
  const pending = instance.add(scope);
  instance.answer(sent[0].payload.requestId, { action: "submit", fields: { username: "a@example.com" } });
  await assert.rejects(pending, code("CREDENTIAL_INVALID"));
});

test("removing an instance asks for confirmation and reports the removal", async () => {
  const { instance, sent, cleared } = port();
  const pending = instance.remove({ ...scope, instanceId: "acc_00000001", label: "a@example.com" });
  assert.equal(sent[0].payload.kind, "remove");
  assert.equal(sent[0].payload.instanceLabel, "a@example.com");
  instance.answer(sent[0].payload.requestId, { action: "confirm" });
  assert.deepEqual(await pending, { removed: true });
  assert.deepEqual(cleared, [{ pluginId: "demo.mail", slotId: "mailbox", instanceId: "acc_00000001" }]);
});

test("declining the confirmation removes nothing", async () => {
  const { instance, sent, cleared } = port();
  const pending = instance.remove({ ...scope, instanceId: "acc_00000001", label: "a@example.com" });
  instance.answer(sent[0].payload.requestId, { action: "cancel" });
  assert.deepEqual(await pending, { cancelled: true });
  assert.deepEqual(cleared, []);
});

/*
 * A dismissed dialog starts a cooldown. The modal covers the whole app, so a
 * plugin that re-asked the moment it closed would be holding the window hostage
 * one form at a time; a dialog the user answered does not.
 */
test("a dismissed dialog puts the plugin on a cooldown", async () => {
  const { instance, sent } = port({ cooldownMs: 60_000 });
  const first = instance.add(scope);
  instance.answer(sent[0].payload.requestId, { action: "cancel" });
  assert.deepEqual(await first, { cancelled: true });

  await assert.rejects(instance.add(scope), (error) => {
    assert.equal(error.code, "CREDENTIAL_DIALOG_BUSY");
    assert.match(error.message, /dismissed/);
    assert.match(error.message, /may ask again in \d+s/);
    return true;
  });
  // A refused-by-cooldown ask opens nothing.
  assert.equal(sent.length, 1);
});

test("a timed-out dialog puts the plugin on a cooldown too", async () => {
  const { instance } = port({ timeoutMs: 10, cooldownMs: 60_000 });
  assert.deepEqual(await instance.add(scope), { cancelled: true });
  await assert.rejects(instance.add(scope), code("CREDENTIAL_DIALOG_BUSY"));
});

test("the cooldown expires, and asking again then works", async () => {
  const { instance, sent } = port({ cooldownMs: 20 });
  const first = instance.add(scope);
  instance.answer(sent[0].payload.requestId, { action: "cancel" });
  await first;
  await assert.rejects(instance.add(scope), code("CREDENTIAL_DIALOG_BUSY"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const again = instance.add(scope);
  assert.equal(sent.length, 2, "the second dialog opened once the cooldown passed");
  instance.answer(sent[1].payload.requestId, { action: "cancel" });
  assert.deepEqual(await again, { cancelled: true });
});

test("an answered dialog does not start a cooldown", async () => {
  const { instance, sent } = port({ cooldownMs: 60_000 });
  const first = instance.add(scope);
  instance.answer(sent[0].payload.requestId, { action: "submit", fields: { password: SECRET } });
  assert.deepEqual(await first, { instanceId: "acc_00000003" });

  // The user answered, so the plugin may ask again for another account.
  const second = instance.add(scope);
  assert.equal(sent.length, 2);
  instance.answer(sent[1].payload.requestId, { action: "cancel" });
  assert.deepEqual(await second, { cancelled: true });
});

test("a confirmed removal does not start a cooldown either", async () => {
  const { instance, sent } = port({ cooldownMs: 60_000 });
  const removal = instance.remove({ ...scope, instanceId: "acc_00000001", label: "a@example.com" });
  instance.answer(sent[0].payload.requestId, { action: "confirm" });
  assert.deepEqual(await removal, { removed: true });
  const again = instance.add(scope);
  assert.equal(sent.length, 2);
  instance.answer(sent[1].payload.requestId, { action: "cancel" });
  assert.deepEqual(await again, { cancelled: true });
});

const MAIN = `
module.exports = {
  async onPanelInvoke(channel, payload) {
    if (channel === "requestAdd") return globalThis.pi.credentials.requestAdd(payload.slotId);
    if (channel === "requestRemove") return globalThis.pi.credentials.requestRemove(payload.slotId, payload.instanceId);
    if (channel === "list") return globalThis.pi.credentials.list();
    throw new Error("unknown channel: " + channel);
  },
};
`;

const SLOTS = [
  {
    id: "mailbox",
    title: "Mailbox",
    kind: "imap",
    fields: [{ key: "username", label: "Address" }, { key: "password", label: "Password", secret: true }],
    scope: { domains: ["imap.example.com"] },
    multiple: { max: 2 },
    labelField: "username",
  },
  {
    id: "single",
    title: "Single",
    kind: "bearer",
    fields: [{ key: "token", label: "Token", secret: true }],
    scope: { domains: ["imap.example.com"] },
  },
];

/**
 * One plugin, loaded through the real runtime and the real host process, with the
 * host store and the dialog stubbed the way Electron wires them.
 */
async function fixture(t, { instances = INSTANCES, dialogs } = {}) {
  const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "pi-credential-dialog-"));
  const dialogs_ = dialogs ?? {
    add: async () => ({ instanceId: "acc_00000003" }),
    remove: async () => ({ removed: true }),
    answer: () => false,
    cancelPlugin: () => undefined,
    cancelAll: () => undefined,
  };
  const asked = [];
  const audits = [];
  const frames = [];
  const runtime = new PluginRuntime({
    hostEntry,
    audit: (entry) => audits.push(entry),
    credentialDialogs: {
      answer: () => false,
      cancelPlugin: () => undefined,
      cancelAll: () => undefined,
      ...dialogs_,
      add: async (request) => {
        asked.push({ kind: "add", ...request });
        return dialogs_.add(request);
      },
      remove: async (request) => {
        asked.push({ kind: "remove", ...request });
        return dialogs_.remove(request);
      },
    },
    listPluginCredentialSlots: async () => [
      { id: "mailbox", configured: true, multiple: true, max: 2, instances, labelField: "username" },
      { id: "single", configured: true },
    ],
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const record = (message) => frames.push(JSON.parse(JSON.stringify(message)));
      return {
        postMessage: (message) => {
          record(message);
          if (child.connected) child.send(message);
        },
        onMessage: (handler) =>
          child.on("message", (message) => {
            record(message);
            handler(message);
          }),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
    runtime.disposeWatchers();
    rmSync(root, { recursive: true, force: true });
  });

  const dir = join(root, "mail");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "test.mail",
      name: "Mail",
      version: "1.0.0",
      main: "main.js",
      permissions: ["credentials.use"],
      contributes: { credentials: SLOTS },
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), MAIN, "utf8");
  await runtime.loadFromPath(dir, ["credentials.use"]);
  return {
    runtime,
    asked,
    audits,
    frames,
    requestAdd: (slotId) => runtime.invokePanelBridge("test.mail", "requestAdd", { slotId }),
    requestRemove: (slotId, instanceId) =>
      runtime.invokePanelBridge("test.mail", "requestRemove", { slotId, instanceId }),
    list: () => runtime.invokePanelBridge("test.mail", "list", {}),
  };
}

test("a plugin can ask the host for one more account", async (t) => {
  // One account of two: the slot still has room, so the dialog is what decides.
  const { asked, audits, requestAdd } = await fixture(t, { instances: [INSTANCES[0]] });
  const answer = await requestAdd("mailbox");
  assert.deepEqual(answer, { instanceId: "acc_00000003" });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].slotId, "mailbox");
  assert.equal(asked[0].pluginName, "Mail");
  const entry = audits.find((item) => item.api === "credentials.requestAdd");
  assert.equal(entry.ok, true);
  assert.equal(entry.credential, "mailbox");
  assert.equal(entry.credentialInstance, "acc_00000003");
  assert.equal(JSON.stringify(audits).includes(SECRET), false);
});

test("a slot at its maximum is refused before the user is asked", async (t) => {
  const { asked, requestAdd } = await fixture(t);
  await assert.rejects(requestAdd("mailbox"), code("CREDENTIAL_LIMIT"));
  assert.deepEqual(asked, [], "no form is shown for a slot that is already full");
});

test("a single-value slot cannot be added to", async (t) => {
  const { asked, requestAdd } = await fixture(t);
  await assert.rejects(requestAdd("single"), code("INVALID_ARGUMENT"));
  assert.deepEqual(asked, []);
});

test("an undeclared slot is refused", async (t) => {
  const { requestAdd } = await fixture(t);
  await assert.rejects(requestAdd("nope"), code("INVALID_ARGUMENT"));
});

test("a plugin removes the account it names, not another", async (t) => {
  const { asked, requestRemove, audits } = await fixture(t);
  assert.deepEqual(await requestRemove("mailbox", "acc_00000002"), { removed: true });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].instanceId, "acc_00000002");
  assert.equal(asked[0].label, "b@example.com");
  assert.equal(audits.find((item) => item.api === "credentials.requestRemove")?.ok, true);
});

test("removing an instance that is not configured is refused without a dialog", async (t) => {
  const { asked, requestRemove } = await fixture(t);
  await assert.rejects(requestRemove("mailbox", "acc_0000dead"), code("CREDENTIAL_NOT_CONFIGURED"));
  assert.deepEqual(asked, []);
});

test("closing a dialog as cancelled tells the plugin so", async (t) => {
  const { requestAdd, audits } = await fixture(t, {
    instances: [INSTANCES[0]],
    dialogs: {
      add: async () => ({ cancelled: true }),
      remove: async () => ({ cancelled: true }),
    },
  });
  assert.deepEqual(await requestAdd("mailbox"), { cancelled: true });
  assert.equal(audits.find((item) => item.api === "credentials.requestAdd")?.errorCode, "CANCELLED");
});

test("a host without a dialog refuses instead of pretending", async (t) => {
  const { runtime, requestAdd } = await fixture(t);
  runtime.setServices({ credentialDialogs: undefined });
  await assert.rejects(requestAdd("mailbox"), code("UNSUPPORTED"));
});

test("list reports the instances of a multi-instance slot and no secret", async (t) => {
  const { list } = await fixture(t);
  const slots = await list();
  const mailbox = slots.find((entry) => entry.id === "mailbox");
  assert.equal(mailbox.multiple, true);
  assert.equal(mailbox.max, 2);
  assert.deepEqual(
    mailbox.instances.map((instance) => [instance.instanceId, instance.label]),
    [
      ["acc_00000001", "a@example.com"],
      ["acc_00000002", "b@example.com"],
    ],
  );
  assert.deepEqual(slots.find((entry) => entry.id === "single"), { id: "single", configured: true });
  assert.equal(JSON.stringify(slots).includes(SECRET), false);
});