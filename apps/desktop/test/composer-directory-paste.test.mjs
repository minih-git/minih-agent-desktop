/**
 * Composer folder paste through the real paste handler (issue #2087): a native
 * directory selection becomes a lazy directory card, never a recursive copy or a
 * binary attachment. The handler source is executed, not string-matched, so the
 * pending-metadata branches run for real.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function extract(source, name) {
  const tree = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true);
  let result;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(tree).replace(/^export\s+/, "");
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) result = node.initializer?.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(result, name);
  return result;
}

function harness(native, {
  files = [], text = "", items = [], paused, sourceSessionId = "source",
  attachmentsAllowed = true, nativeError, importPaused,
} = {}) {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const editor = read("../src/features/chat/composer/editor.ts");
  const hook = read("../src/features/chat/composer/hooks/useComposerAttachments.ts");
  const drafts = [];
  const errors = [];
  const writes = [];
  const imported = [];
  const transfers = [];
  const created = [];
  const nativeReads = [];
  const textInsertions = [];
  const revisions = new Map();
  const snapshots = new Map();
  let activeSessionId = sourceSessionId;
  let workspacePath = "/synthetic/project";
  const element = { textContent: "before after" };
  const context = {
    inputBlocked: false,
    attachmentsAllowed,
    activeSessionId,
    draftKey: sourceSessionId ?? "home",
    largePasteThreshold: 1000,
    ref: { current: element },
    valueRef: { current: element.textContent },
    previousWorkspacePathRef: { current: "/synthetic/project" },
    snapshotReferences: () => [],
    invalidateComposerTransforms() {},
    applyEditorDraft: (nextText, references) => drafts.push({ text: nextText, references }),
    showToast(message, options) {
      if (options?.variant === "error") errors.push(message);
    },
    t: (key) => key,
  };
  let sequence = 0;
  const environment = {
    module: { exports: {} },
    Array,
    TextEncoder,
    crypto,
    context: () => context,
    ...context,
    draft: context,
    isInputBlocked: false,
    setPasting() {},
    readEditorValue: (target) => target.textContent,
    editorSelectionRange: () => ({ start: 7, end: 7 }),
    pasteSessionLinks: () => false,
    parseSessionLinks: () => [],
    normalizeClipboardLineEndings: (value) => value,
    showErrorToast: (error) => errors.push(error.message),
    api: {
      getDroppedFilePath: () => null,
      readClipboardDirectories: async () => {
        nativeReads.push(true);
        if (nativeError) throw nativeError;
        if (paused) await paused;
        return native;
      },
      recordClipboardPaste: async () => {},
      importFiles: async (session, token) => {
        imported.push({ session, token });
        if (importPaused) await importPaused;
        return { files: [{ path: "/synthetic/scratch/notes.txt", name: "notes.txt", kind: "file" }] };
      },
      pasteFiles: async (_session, payload) => {
        transfers.push(payload);
        return {
          files: payload.map((file) => ({
            path: "/synthetic/scratch/" + file.name,
            name: file.name,
            kind: "file",
            mimeType: file.mimeType,
          })),
        };
      },
    },
    nextChipToken: () => String.fromCodePoint(0xe001 + sequence++),
    createFileReference: (path, name, sessionId, metadata) => ({ path, name, sessionId, ...metadata }),
    draftFileReference: (reference) => reference,
    writeComposerDraft: (key, snapshot) => writes.push({ key, snapshot }),
    readComposerDraftRevision: key => revisions.get(key) ?? 0,
    readComposerDraft: key => snapshots.get(key),
    document: { execCommand: (_command, _showUi, value) => { textInsertions.push(value); return true; } },
    insertClipboardText: (_target, value) => { textInsertions.push(value); return true; },
    deleteComposerDraft() {},
    HOME_DRAFT_KEY: "home",
    useAppStore: {
      getState: () => ({
        activeSessionId,
        workspace: { path: workspacePath },
        sessions: [{ id: "source" }, { id: "created" }, { id: "other" }],
      }),
    },
    materializeDraftSession: async () => {
      created.push(workspacePath);
      activeSessionId = "created";
      return "created";
    },
  };
  const code = extract(editor, "clipboardFiles")
    + "\n" + extract(editor, "preferClipboardText")
    + "\nmodule.exports = " + extract(hook, "pasteClipboardFiles");
  vm.runInNewContext(
    ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    environment,
  );
  return {
    drafts, errors, writes, imported, transfers, created, nativeReads, textInsertions,
    edit(value) {
      element.textContent = value;
      const key = activeSessionId ?? "home";
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
      snapshots.set(key, { text: value, fileReferences: [] });
    },
    switchSession() { activeSessionId = "other"; },
    switchProject() { workspacePath = "/synthetic/other-project"; },
    paste: () => environment.module.exports({
      currentTarget: element,
      preventDefault() {},
      clipboardData: { files, items, types: ["Files"], getData: () => text },
    }),
  };
}

const folder = { kind: "directory", path: "/synthetic/copied folder", name: "copied folder" };

test("paste uses native directory paths even when Chromium exposes no File", async () => {
  const run = harness({ items: [folder], token: null });
  await run.paste();
  assert.equal(run.drafts.length, 1);
  assert.equal(run.drafts[0].references[0].kind, "directory");
  assert.equal(run.drafts[0].references[0].path, folder.path);
  assert.equal(run.drafts[0].references[0].sessionId, "source");
  assert.equal(run.drafts[0].text, "before \ue001after");
  assert.equal(run.imported.length, 0, "a folder-only paste creates no import token");
  assert.equal(run.transfers.length, 0, "no binary paste for a folder");
  assert.deepEqual(run.errors, []);
  assert.equal(run.writes[0].key, "source");
  assert.equal(run.writes[0].snapshot.fileReferences[0].kind, "directory");
});

test("mixed native folders and files preserve their order and use the existing import token", async () => {
  const run = harness({ items: [folder, { kind: "file", name: "notes.txt" }], token: "native-selection" });
  await run.paste();
  assert.equal(run.drafts.length, 1);
  assert.deepEqual(Array.from(run.drafts[0].references, (reference) => reference.kind), ["directory", "file"]);
  assert.deepEqual(run.imported, [{ session: "source", token: "native-selection" }]);
});

test("pending directory paste stays with its captured session", async () => {
  let resume;
  const paused = new Promise((resolve) => { resume = resolve; });
  const run = harness({ items: [folder], token: null }, { paused });
  const pending = run.paste();
  run.switchSession();
  resume();
  await pending;
  assert.equal(run.drafts.length, 0, "a paste that finished elsewhere must not touch the new draft");
  assert.equal(run.writes[0].key, "source");
  assert.equal(run.writes[0].snapshot.fileReferences[0].path, folder.path);
});

test("directory paste preserves edits made while native metadata is pending", async () => {
  let resume;
  const paused = new Promise((resolve) => { resume = resolve; });
  const run = harness({ items: [folder], token: null }, { paused });
  const pending = run.paste();
  run.edit("newer edits remain");
  resume();
  await pending;
  assert.equal(run.drafts[0].text, "newer e\ue001dits remain");
});

test("native directory paste never reads browser directory bytes", async () => {
  const directory = new File([], "copied folder", { type: "application/x-directory" });
  directory.arrayBuffer = () => assert.fail("directory bytes were read");
  const run = harness({ items: [folder], token: null }, { files: [directory] });
  await run.paste();
  assert.equal(run.drafts[0].references[0].kind, "directory");
  assert.equal(run.transfers.length, 0);
});

test("ordinary native files keep their existing byte attachment flow", async () => {
  const run = harness(null, { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] });
  await run.paste();
  assert.equal(run.drafts[0].references[0].kind, "file");
  assert.equal(run.transfers.length, 1);
  assert.equal(new TextDecoder().decode(run.transfers[0][0].data), "notes");
});

for (const navigate of ["switchSession", "switchProject"]) {
  test(`pending home folder paste cannot materialize in a destination after ${navigate}`, async () => {
    let resume;
    const paused = new Promise((resolve) => { resume = resolve; });
    const run = harness({ items: [folder], token: null }, { paused, sourceSessionId: null });
    const pending = run.paste();
    run[navigate]();
    resume();
    await pending;
    assert.deepEqual(run.created, [], "a home paste must not open a task in the destination");
    assert.deepEqual(run.writes, []);
    assert.deepEqual(run.drafts, []);
  });
}

test("home folder paste materializes only its original unchanged workspace", async () => {
  const run = harness({ items: [folder], token: null }, { sourceSessionId: null });
  await run.paste();
  assert.deepEqual(run.created, ["/synthetic/project"]);
  assert.equal(run.drafts[0].references[0].sessionId, "created");
});

test("Word text plus a generated image keeps text paste without a native file read", async () => {
  const run = harness(null, { text: "Copied text from Word", files: [new File([], "image.png", { type: "image/png" })] });
  await run.paste();
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.nativeReads, [], "preferred editable text must not reach the native clipboard");
  assert.deepEqual(run.textInsertions, ["Copied text from Word"]);
});

test("a session without attach permission never reads the native clipboard or attaches a folder", async () => {
  const run = harness({ items: [folder], token: null }, { text: "remote prompt", attachmentsAllowed: false });
  run.paste();
  assert.deepEqual(run.nativeReads, [], "remote sessions must not bypass the attachment gate");
  assert.deepEqual(run.textInsertions, ["remote prompt"], "the plain text still reaches the draft");
  assert.deepEqual(run.writes, []);
  assert.deepEqual(run.drafts, []);
  assert.deepEqual(run.errors, []);
});

test("a folder that vanished in main surfaces an error and keeps the draft unchanged", async () => {
  const run = harness(null, { nativeError: new Error("ENOENT: no such file or directory, realpath '/synthetic/copied folder'") });
  await run.paste();
  assert.equal(run.errors.length, 1);
  assert.match(run.errors[0], /no such file or directory/);
  assert.deepEqual(run.drafts, [], "a failed folder read must not silently paste text instead");
  assert.deepEqual(run.writes, []);
  assert.deepEqual(run.transfers, []);
});

test("a Files-only paste without native metadata reports the missing path instead of dropping it", async () => {
  const run = harness(null, { files: [], items: [], text: "" });
  await run.paste();
  assert.deepEqual(run.errors, ["chat.directoryPasteUnavailable"]);
  assert.deepEqual(run.drafts, []);
  assert.deepEqual(run.writes, []);
});

for (const switchAway of [false, true]) {
  test(`home mixed paste preserves the adopted session's edits${switchAway ? " after switching away" : ""}`, async () => {
    const gate = Promise.withResolvers();
    const run = harness({ items: [folder, { kind: "file", name: "notes.txt" }], token: "selection" },
      { sourceSessionId: null, importPaused: gate.promise });
    const paste = run.paste();
    for (let n = 0; n < 20 && run.imported.length === 0; n++) await Promise.resolve();
    assert.equal(run.imported.length, 1, "the home draft must have materialized and started import");
    run.edit("new text during created-session import");
    if (switchAway) run.switchSession();
    gate.resolve();
    await paste;
    assert.equal(run.writes[0].key, "created");
    assert.ok(run.writes[0].snapshot.text.startsWith("new text during created-session import"));
    assert.equal(run.writes[0].snapshot.fileReferences.length, 2);
    assert.equal(run.errors.length, 0);
  });
}