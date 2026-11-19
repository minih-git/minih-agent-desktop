import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { showWebhookTokenDialog } = await import("../electron/main/plugin-webhook-token-dialog.ts");

const labels = Object.fromEntries(["tokenActionsTitle", "tokenActionsBody", "tokenShow", "tokenRotate", "tokenCancel", "tokenRotateTitle", "tokenRotateBody", "tokenValueTitle", "tokenValueBody", "tokenCopy", "tokenClose"].map((key) => [key, key]));

function fixture(responses) {
  const dialogs = [];
  const calls = [];
  return {
    dialogs, calls,
    async run() {
      return showWebhookTokenDialog({
        labels,
        show: async (options) => { dialogs.push(options); return { response: responses.shift(), checkboxChecked: false }; },
        reveal: async () => { calls.push("reveal"); return "fixture-secret"; },
        rotate: async () => { calls.push("rotate"); return "fixture-rotated"; },
        copy: (value) => calls.push(value === "fixture-secret" ? "copied-original" : "copied-rotated"),
      });
    },
  };
}

test("cancel never retrieves a token", async () => {
  const dialog = fixture([2]);
  assert.equal(await dialog.run(), undefined);
  assert.deepEqual(dialog.calls, []);
  assert.equal(dialog.dialogs.length, 1);
});

test("token appears only in the native dialog and is copied only on explicit action", async () => {
  const dialog = fixture([0, 0]);
  assert.equal(await dialog.run(), undefined);
  assert.deepEqual(dialog.calls, ["reveal", "copied-original"]);
  assert.equal(dialog.dialogs[1].detail, "fixture-secret");
  const closed = fixture([0, 1]);
  await closed.run();
  assert.deepEqual(closed.calls, ["reveal"]);
});

test("rotation requires confirmation and exposes no token in the return value", async () => {
  const cancelled = fixture([1, 0]);
  await cancelled.run();
  assert.deepEqual(cancelled.calls, []);
  const rotated = fixture([1, 1, 1]);
  assert.equal(await rotated.run(), undefined);
  assert.deepEqual(rotated.calls, ["rotate"]);
  assert.equal(rotated.dialogs[2].detail, "fixture-rotated");
});
