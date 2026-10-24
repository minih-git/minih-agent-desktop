import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const hookUrl = new URL("../src/features/chat/composer/hooks/useComposerSubmit.ts", import.meta.url);

async function productionSubmit() {
  const source = readFileSync(hookUrl, "utf8");
  const helper = source.includes("submit-with-latest-draft-restore.mjs")
    ? await import("../src/features/chat/composer/hooks/submit-with-latest-draft-restore.mjs")
    : null;
  const module = { exports: {} };
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const imports = (name) => {
    if (name === "@minih-agent/shared") return {
      serializeComposerFileReferences: (text) => text,
      serializeInlineComposerFileReferences: (text) => text,
    };
    if (name.endsWith("submit-with-latest-draft-restore.mjs")) return helper;
    if (name.endsWith("/editor")) return { readEditorValue: () => { throw new Error("No editor is mounted in this hook fixture"); } };
    // Local command paths are disabled; reaching them is a fixture failure.
    if (["../../../../lib/api", "../../../../lib/commands", "../../../../hooks/use-composer-autocomplete", "../slash-dispatch"].includes(name)) return {};
    return require(name);
  };
  new Function("require", "module", "exports", output)(imports, module, module.exports);
  return module.exports.useComposerSubmit;
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function harness(useComposerSubmit, key) {
  const restored = [];
  const history = [];
  const draft = {
    ref: { current: null },
    draftRevision: () => 1,
    draftSnapshot: (text) => ({ text, fileReferences: [{ path: "/project/attachment.png" }] }),
    clearDraftForKey: () => {},
    restoreDraftForKey: (draftKey, snapshot) => restored.push({ draftKey, snapshot }),
  };
  const send = (text, pending, steering = false) => useComposerSubmit({
    value: text, draftKey: key, activeSessionId: key, modelReady: true, sendBlocked: false,
    localCommandsAllowed: false, invalidateComposerTransforms: () => {}, pasting: false,
    activeFileReferences: [], t: (key) => key, showToast: () => assert.fail("unexpected toast"),
    sendPrompt: () => pending.promise, steerPrompt: () => pending.promise,
    recordHistory: (snapshot, session) => history.push({ snapshot, session }), draft,
  }).submit(steering);
  return { send, restored, history };
}

test("production submit never restores an old rejection after a newer accepted send", async () => {
  const useSubmit = await productionSubmit();
  const h = harness(useSubmit, "race-accepted");
  const old = deferred(); const recent = deferred();
  const first = h.send("old", old); const second = h.send("recent", recent);
  recent.resolve(true); await second; old.resolve(false); await first;
  assert.deepEqual(h.restored, []);
  assert.deepEqual(h.history.map((entry) => entry.snapshot.text), ["recent"]);
});

test("an older steering rejection cannot regain ownership when its draft slot is reused", async () => {
  const h = harness(await productionSubmit(), "race-reused");
  const old = deferred(); const accepted = deferred(); const newest = deferred();
  const first = h.send("old steer", old, true);
  const second = h.send("accepted", accepted); accepted.resolve(true); await second;
  const third = h.send("latest", newest, true); old.resolve(false); await first;
  assert.deepEqual(h.restored, []);
  newest.resolve(false); await third;
  assert.equal(h.restored.length, 1);
  assert.equal(h.restored[0].snapshot.text, "latest");
  assert.equal(h.restored[0].snapshot.fileReferences[0].path, "/project/attachment.png");
});

test("concurrent sessions retain independent rejected drafts", async () => {
  const submit = await productionSubmit();
  const a = harness(submit, "race-session-a"); const b = harness(submit, "race-session-b");
  const pa = deferred(); const pb = deferred();
  const first = a.send("A", pa); const second = b.send("B", pb);
  pb.resolve(false); pa.resolve(false); await Promise.all([first, second]);
  assert.equal(a.restored[0].draftKey, "race-session-a");
  assert.equal(b.restored[0].draftKey, "race-session-b");
});
