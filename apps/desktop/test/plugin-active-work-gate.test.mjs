/**
 * The interruption check every user-initiated plugin teardown shares
 * (spec 07-plugins/05 §3.0).
 *
 * A plugin without the hook, or with nothing running, must keep exactly the
 * teardown it had before: no dialog, no change in outcome. Only a plugin that
 * answers with a sentence produces a prompt, and Cancel must come back as "do
 * nothing".
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
// Only the `electron` specifier is stubbed: the decision logic under test is
// production code, and the dialog is a recorded stub.
register(new URL("./helpers/electron-dialog-stub-hook.mjs", import.meta.url));

const { confirmPluginInterruption, activeWorkMessages } = await import(
  "../electron/main/plugin-active-work.ts"
);
const { dialog } = await import("electron");

const deps = (answers, locale = "en") => ({
  plugins: {
    activeWork: async (id) => {
      const answer = answers[id];
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    },
  },
  getLocale: () => locale,
});

test.beforeEach(() => dialog.reset());

test("a plugin with nothing running is torn down exactly as before", async () => {
  assert.equal(await confirmPluginInterruption(deps({}), ["acme.git"]), true);
  assert.equal(dialog.calls.length, 0, "no prompt when nothing would be lost");
});

test("a silent or broken plugin never blocks the teardown", async () => {
  const answers = { "acme.silent": null, "acme.broken": new Error("hook failed") };
  const messages = await activeWorkMessages(deps(answers).plugins, [
    "acme.silent",
    "acme.broken",
  ]);
  assert.deepEqual(messages, []);
  assert.equal(await confirmPluginInterruption(deps(answers), ["acme.broken"]), true);
  assert.equal(dialog.calls.length, 0);
});

test("the prompt names the plugin's own sentence and Cancel keeps everything", async () => {
  dialog.response = 0;
  const answers = { "pi.terminal": "Terminal: 2 shells are still running." };
  assert.equal(await confirmPluginInterruption(deps(answers), ["pi.terminal"]), false);

  assert.equal(dialog.calls.length, 1);
  const { options } = dialog.calls[0];
  assert.match(options.detail, /Terminal: 2 shells are still running\./);
  assert.match(options.detail, /Continuing ends it/);
  // Cancel is the default and the escape path: a warning nobody reads must not
  // end work by accident.
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
  assert.equal(options.buttons[0], "Cancel");
});

test("accepting continues, and the copy follows the app language", async () => {
  dialog.response = 1;
  const answers = { "pi.terminal": "终端插件：仍有 1 个 shell 在运行。" };
  assert.equal(await confirmPluginInterruption(deps(answers, "zh-CN"), ["pi.terminal"]), true);
  const { options } = dialog.calls[0];
  assert.equal(options.title, "插件仍有工作在进行");
  assert.match(options.detail, /仍有 1 个 shell 在运行/);
  assert.equal(options.buttons[1], "结束并继续");
});

test("a duplicate request joins the open prompt instead of stacking one", async () => {
  dialog.response = 0;
  const answers = { "pi.terminal": "Terminal: 1 shell is still running." };
  const shared = deps(answers);
  const [first, second] = await Promise.all([
    confirmPluginInterruption(shared, ["pi.terminal"]),
    confirmPluginInterruption(shared, ["pi.terminal"]),
  ]);
  assert.equal(first, false);
  assert.equal(second, false);
  assert.equal(dialog.calls.length, 1, "one decision, one dialog");
});

test("only the plugins that answered are mentioned", async () => {
  dialog.response = 1;
  const answers = { "pi.terminal": "Terminal: 1 shell is still running.", "acme.git": null };
  await confirmPluginInterruption(deps(answers), ["pi.terminal", "acme.git", ""]);
  const { options } = dialog.calls[0];
  assert.match(options.detail, /Terminal: 1 shell is still running\./);
  assert.equal(options.detail.match(/•/g).length, 1);
});
