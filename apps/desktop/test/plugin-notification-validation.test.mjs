import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { normalizePluginNotification } = await import("../electron/main/plugin-notification-center.ts");

const manifest = { contributes: { views: [{ id: "inbox" }], commands: [{ id: "refresh" }] } };

test("notification input accepts only own declared activation targets", () => {
  assert.deepEqual(normalizePluginNotification({ title: "Ready", link: { view: "inbox" } }, manifest), {
    kind: "alert", title: "Ready", linkJson: '{"view":"inbox"}',
  });
  assert.equal(normalizePluginNotification({ title: "Ready", link: { command: "refresh" } }, manifest).linkJson, '{"command":"refresh"}');
  for (const link of [{ view: "other/inbox" }, { command: "other/refresh" }, { url: "https://example.test" }, { view: "inbox", command: "refresh" }]) {
    assert.throws(() => normalizePluginNotification({ title: "Ready", link }, manifest), { code: "INVALID_ARGUMENT" });
  }
});

test("notification input rejects oversize or malformed data and reserved keys", () => {
  for (const input of [
    {}, { title: " " }, { title: "x".repeat(201) }, { title: "ok", body: "x".repeat(2001) },
    { title: "ok", level: "info" }, { title: "ok", dedupeKey: "__minih_notify_overflow__" },
    { title: "ok", dedupeKey: "x".repeat(257) }, { title: "ok", kind: null },
  ]) assert.throws(() => normalizePluginNotification(input, manifest), { code: "INVALID_ARGUMENT" });
});
