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

test("sending a side note steers the running turn and never stops it", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const previousWindow = globalThis.window;
  try {
    const { createQueueSlice } = await server.ssrLoadModule("/src/stores/slices/queue-slice.ts");
    const invoked = [];
    globalThis.window = { minihAgent: { invoke: async (channel, payload) => {
      invoked.push([channel, payload]);
      if (channel === IPC.invoke.agentSteer) return { ok: true, data: { accepted: true, turnId: "turn-1" } };
      throw new Error(`Unexpected IPC: ${channel}`);
    } } };
    const inserted = [];
    const retracted = [];
    let state = {
      activeSessionId: "session-a",
      sessions: [{ id: "session-a", source: "desktop" }],
      pendingPlans: {},
      runningSessions: { "session-a": true },
      agentStatuses: { "session-a": { currentTurnId: "turn-1" } },
      showToast: assert.fail,
    };
    const slice = createQueueSlice({
      get: () => state,
      set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
      runtime: {
        insertOptimisticUserMessage: (_sessionId, message) => inserted.push(message),
        retractOptimisticUserMessage: (_sessionId, message) => retracted.push(message),
      },
      promptAttachmentsFromDraft: () => [],
      withoutRecordKey: (record, key) => {
        const next = { ...record };
        delete next[key];
        return next;
      },
      viewingSessionIdForPrompt: () => "session-a",
      messageErrorFromUnknown: (error) => ({ code: "FAILED", message: String(error) }),
      assistantErrorMessage: () => ({ role: "assistant", content: "failed" }),
      materializeDraftSession: async () => null,
    });

    assert.equal(await slice.sendSideNote("  How far along are you?  "), true);
    assert.equal(inserted.length, 1);
    // The optimistic row and the host call agree about what this input is.
    assert.equal(inserted[0].sideNote, true);
    assert.equal(inserted[0].steering, true);
    assert.equal(inserted[0].content, "  How far along are you?  ");
    assert.deepEqual(
      invoked.filter(([channel]) => channel === IPC.invoke.agentSteer),
      [[IPC.invoke.agentSteer, {
        sessionId: "session-a",
        expectedTurnId: "turn-1",
        content: "  How far along are you?  ",
        messageId: inserted[0].id,
        attachments: [],
        sideNote: true,
      }]],
    );
    // A note is input to the running turn: nothing asks the session to stop.
    assert.equal(invoked.some(([channel]) => channel === IPC.invoke.agentStop), false);
    assert.deepEqual(retracted, []);

    // An empty note is refused before any IPC, and an idle session reports why.
    assert.equal(await slice.sendSideNote("   "), false);
    assert.equal(invoked.length, 1);
    state = { ...state, runningSessions: {}, showToast: () => {} };
    assert.equal(await slice.sendSideNote("Anything else?"), false);
    assert.equal(invoked.length, 1);
  } finally {
    globalThis.window = previousWindow;
    await server.close();
  }
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
    runningSessions: {},
    agentStatuses: {},
    pendingPlans: {},
    sendSideNote: async () => true,
  };
  const idle = renderToStaticMarkup(
    React.createElement(loadSideNotesTab(idleStore, [])),
  );
  assert.match(idle, /panel\.sideNotes\.emptyTitle/);
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
});
