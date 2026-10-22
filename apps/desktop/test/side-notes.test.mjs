import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import ts from "typescript";
import { IPC } from "@minih-agent/shared";
import { sideNoteInputState, sideNotesFromMessages } from "../src/lib/side-notes.ts";

const userRow = (id, content, sideNote) => ({
  id,
  role: "user",
  content,
  status: "complete",
  createdAt: "2026-10-13T00:00:00.000Z",
  ...(sideNote ? { sideNote: true } : {}),
});

test("the side-note list keeps only the marked user rows", () => {
  const notes = sideNotesFromMessages([
    userRow("prompt", "Refactor the queue slice"),
    { ...userRow("reply", "Done"), role: "assistant" },
    userRow("note", "How far along are you?", true),
    { ...userRow("marked-reply", "Halfway", true), role: "assistant" },
  ]);

  assert.deepEqual(notes.map((note) => note.id), ["note"]);
});

test("a side note is only sendable into a running turn", () => {
  assert.equal(sideNoteInputState({ running: true, turnId: "turn-1", planPending: false }), "ready");
  // An idle session has no turn to deliver into.
  assert.equal(sideNoteInputState({ running: false, turnId: undefined, planPending: false }), "idle");
  // A turn that already finalized no longer accepts input.
  assert.equal(sideNoteInputState({ running: false, turnId: "turn-1", planPending: false }), "idle");
  assert.equal(sideNoteInputState({ running: true, turnId: undefined, planPending: false }), "idle");
  // A turn waiting for plan approval owns the next request.
  assert.equal(sideNoteInputState({ running: true, turnId: "turn-1", planPending: true }), "idle");
});

test("side questions use independent IPC, never main transcript or steering", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const previousWindow = globalThis.window;
  try {
    const { createSideNotesSlice } = await server.ssrLoadModule("/src/stores/slices/side-notes-slice.ts");
    const invoked = [];
    const notes = [];
    const toasts = [];
    let answer;
    let load;
    globalThis.window = { minihAgent: { invoke: async (channel, payload) => {
      invoked.push([channel, payload]);
      if (channel === IPC.invoke.agentSideNote) return await answer(payload);
      if (channel === IPC.invoke.agentSideNotesList) return load ? await load() : { ok: true, data: { notes: [...notes] } };
      assert.fail(`Unexpected IPC: ${channel}`);
    } } };
    let state = {
      activeSessionId: "session-a",
      sessions: ["session-a", "session-b"].map(id => ({ id, source: "desktop" })),
      pendingPlans: {}, runningSessions: { "session-a": true, "session-b": true },
      agentStatuses: { "session-a": { currentTurnId: "turn-a" }, "session-b": { currentTurnId: "turn-b" } },
      messages: [userRow("main", "Keep doing the main task")],
      showToast: message => toasts.push(message),
    };
    const access = { get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; } };
    const slice = createSideNotesSlice(access);
    Object.assign(state, slice);
    const mainMessages = state.messages;
    answer = async req => {
      const note = { id: "note-1", question: req.content, answer: "Independent answer", createdAt: "2026-10-20T00:00:00Z" };
      notes.push(note);
      return { ok: true, data: { note } };
    };
    assert.equal(await slice.sendSideNote("  Question  "), true);
    assert.equal(state.sideNotes["session-a"][0].answer, "Independent answer");
    assert.deepEqual(invoked[0], [IPC.invoke.agentSideNote, { sessionId: "session-a", expectedTurnId: "turn-a", content: "Question" }]);
    assert.equal(state.messages, mainMessages);
    assert.deepEqual(state.sideNotePending, {});
    assert.equal(await slice.sendSideNote("  "), false);
    assert.equal(invoked.length, 1);

    let resolveAnswer;
    answer = req => new Promise(resolve => { resolveAnswer = () => resolve({ ok: true, data: { note: { id: "note-2", question: req.content, answer: "Late answer", createdAt: "2026-10-20T00:00:01Z" } } }); });
    const pending = slice.sendSideNote("Second question");
    assert.equal(state.sideNotePending["session-a"], "Second question");
    assert.equal(await slice.sendSideNote("Duplicate"), false);
    let resolveLoad;
    load = () => new Promise(resolve => { resolveLoad = () => resolve({ ok: true, data: { notes: [notes[0]] } }); });
    const loading = slice.loadSideNotes("session-a");
    state = { ...state, activeSessionId: "session-b" };
    resolveAnswer();
    assert.equal(await pending, true);
    resolveLoad(); await loading;
    assert.equal(state.sideNotes["session-a"].length, 2, "late history load must not erase a new answer");
    assert.equal(state.sideNotes["session-b"], undefined);
    assert.equal(state.messages, mainMessages);

    answer = async () => { throw new Error("Side provider failed"); };
    assert.equal(await slice.sendSideNote("Fail independently"), false);
    assert.match(toasts.at(-1), /Side provider failed/);
    assert.deepEqual(state.sideNotePending, {});
    state = { ...state, runningSessions: {} };
    const count = invoked.length;
    assert.equal(await slice.sendSideNote("Idle"), false);
    assert.equal(invoked.length, count);
    assert.ok(invoked.every(([channel]) => channel !== IPC.invoke.agentSteer && channel !== IPC.invoke.agentStop));
  } finally { globalThis.window = previousWindow; await server.close(); }
});

const t = (key) => key;
const Icon = () => React.createElement("svg", { "aria-hidden": true });
const Textarea = ({ children, ...props }) => React.createElement("textarea", props, children);
const Button = ({ children, ...props }) => React.createElement("button", props, children);

function loadSideNotesTab(store, messages) {
  const file = new URL("../src/components/workpanel/SideNotesTab.tsx", import.meta.url);
  const source = readFileSync(file, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    fileName: file.pathname,
  });
  const imports = {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "react-i18next": { useTranslation: () => ({ t }) },
    "../../hooks/use-transcript-view": { useTranscriptView: () => ({ messages }) },
    "../../lib/side-notes": { sideNoteInputState, sideNotesFromMessages },
    "../../lib/remote-session-safety": { sessionAllows: session => session?.source !== "remote" },
    "../Markdown": { Markdown: ({ source }) => React.createElement("div", { className: "markdown" }, source) },
    "../../stores/app-store": { useAppStore: (selector) => selector(store) },
    "../icons": new Proxy({}, { get: () => Icon }),
    "../ui": { Button, Textarea },
    "./WorkTabEmpty": {
      WorkTabEmpty: ({ title, body }) =>
        React.createElement("div", { className: "work-tab-empty" }, title, body),
    },
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unmocked side-notes dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports.SideNotesTab;
}

test("the side-notes tab lists the notes and explains an idle session", () => {
  const idleStore = {
    activeSessionId: "session-a",
    sessions: [{ id: "session-a", source: "desktop" }],
    sideNotes: { "session-a": [{ id: "new-note", question: "Independent question", answer: "Independent answer", createdAt: "2026-10-20T00:00:00Z" }] },
    sideNotePending: {},
    loadSideNotes: async () => {},
    runningSessions: {},
    agentStatuses: {},
    pendingPlans: {},
    sendSideNote: async () => true,
  };
  const idle = renderToStaticMarkup(
    React.createElement(loadSideNotesTab(idleStore, [])),
  );
  assert.match(idle, /Independent question/);
  assert.match(idle, /Independent answer/);
  assert.match(idle, /panel\.sideNotes\.idlePlaceholder/);
  assert.match(idle, /panel\.sideNotes\.idleHint/);
  // Nothing can be sent while no turn is running.
  assert.match(idle, /<textarea[^>]*disabled/);
  assert.match(idle, /<button[^>]*disabled/);

  const runningStore = {
    ...idleStore,
    runningSessions: { "session-a": true },
    agentStatuses: { "session-a": { currentTurnId: "turn-1" } },
  };
  const running = renderToStaticMarkup(
    React.createElement(loadSideNotesTab(runningStore, [
      userRow("prompt", "Refactor the queue slice"),
      userRow("note", "How far along are you?", true),
    ])),
  );
  assert.match(running, /How far along are you\?/);
  // The turn's own prompt is not a note, and the composer is usable.
  assert.doesNotMatch(running, /Refactor the queue slice/);
  assert.match(running, /panel\.sideNotes\.placeholder/);
  assert.match(running, /panel\.sideNotes\.hint/);
  // The composer is usable while the turn runs: only the send button of the
  // still-empty draft is inert.
  assert.doesNotMatch(running, /<textarea[^>]*disabled/);
  assert.doesNotMatch(running, /side-notes-preset"[^>]*disabled/);
  assert.match(running, /side-note-answer-body prose-chat selectable/);
  assert.match(running, /side-notes-composer-shell/);
});

test("topbar exposes a quick side-notes button and /btw dispatches to side notes", async () => {
  const topbarSource = readFileSync(
    new URL("../src/components/ConversationTopbar.tsx", import.meta.url),
    "utf8",
  );
  const submitSource = readFileSync(
    new URL("../src/features/chat/composer/hooks/useComposerSubmit.ts", import.meta.url),
    "utf8",
  );
  assert.match(topbarSource, /data-testid="topbar-side-notes"/);
  assert.match(topbarSource, /openWorkPanelTab\(sideNotesWorkPanelTab\(\)\)/);
  assert.match(submitSource, /command\.id === "builtin\.agent\.sideNote" && commandBody/);
  assert.match(submitSource, /runSideNoteCommand\(noteQuestion\)/);
});
