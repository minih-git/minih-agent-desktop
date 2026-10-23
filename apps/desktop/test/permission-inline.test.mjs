import {
  readAppSource,
  readStoreModuleSync,
  readStoreSource,
  readTranscriptSource,
  readComposerSource,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  clearSessionPermissions,
  enqueuePermission,
  headPermission,
  queuedPermissionCount,
  removePermission,
  removePermissionForToolCall,
} from "../src/lib/pending-permissions.ts";
import {
  clearSessionAsks,
  enqueueAsk,
  headAsk,
  queuedAskCount,
  removeAsk,
  removeAskForToolCall,
} from "../src/lib/pending-asks.ts";
import { createNavigationIntentController } from "../src/lib/navigation-intent.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [appSource, chatSurfaceSource, sessionPaneSource, composerSource, transcriptSource, cardSource, askCardSource, storeSource, browserSource, messageStyleSource, composerStyleSource] =
  await Promise.all([
    readAppSource(),
    read("../src/components/ChatSurface.tsx"),
    read("../src/components/SessionPane.tsx"),
    readComposerSource(),
    readTranscriptSource(),
    read("../src/components/PermissionCard.tsx"),
    read("../src/components/AskToolCard.tsx"),
    readStoreSource(),
    read("../src/components/workpanel/PluginViewTab.tsx"),
    read("../src/styles/messages.css"),
    read("../src/styles/composer.css"),
  ]);

const eventsSource = readStoreModuleSync("slices/events-slice.ts");
const interactionSource = readStoreModuleSync("slices/interaction-slice.ts");
const transcriptSliceSource = readStoreModuleSync("slices/transcript-slice.ts");
const sessionRuntimeSource = readStoreModuleSync("runtime/session-runtime.ts");

function permission(sessionId, requestId, extra = {}) {
  return {
    sessionId,
    requestId,
    toolCallId: `tool-${requestId}`,
    toolName: "Write",
    argsPreview: { path: `${sessionId}.txt` },
    risk: "high",
    reason: "Modify a workspace file",
    ...extra,
  };
}

test("pending permissions stay isolated by session and request id", () => {
  const first = permission("session-a", "request-a");
  const second = permission("session-b", "request-b");
  const pending = enqueuePermission(
    enqueuePermission({}, first),
    second,
  );

  assert.deepEqual(Object.keys(pending).sort(), ["session-a", "session-b"]);
  assert.equal(
    removePermission(pending, "session-a", "stale-request"),
    pending,
  );

  const cleared = removePermission(pending, "session-a", "request-a");
  assert.equal(cleared["session-a"], undefined);
  assert.equal(headPermission(cleared, "session-b"), second);
});

test("parallel delegates queue behind the request on screen", () => {
  const first = permission("session-a", "request-first", {
    agentName: "explorer",
  });
  const second = permission("session-a", "request-second", {
    agentName: "test-runner",
  });
  const queues = enqueuePermission(enqueuePermission({}, first), second);

  assert.equal(headPermission(queues, "session-a"), first);
  assert.equal(queuedPermissionCount(queues, "session-a"), 1);
  // A duplicate delivery must not stack a second copy of the same request.
  assert.equal(enqueuePermission(queues, second), queues);

  const answered = removePermission(queues, "session-a", "request-first");
  assert.equal(headPermission(answered, "session-a"), second);
  assert.equal(queuedPermissionCount(answered, "session-a"), 0);
});

test("a finished tool call clears its request from anywhere in the queue", () => {
  const first = permission("session-a", "request-first");
  const second = permission("session-a", "request-second");
  const queues = enqueuePermission(enqueuePermission({}, first), second);

  // A cancelled request that was never shown still has to leave the queue on
  // `tool_end`.
  const afterCancellation = removePermissionForToolCall(
    queues,
    "session-a",
    "tool-request-second",
  );
  assert.equal(headPermission(afterCancellation, "session-a"), first);
  assert.equal(queuedPermissionCount(afterCancellation, "session-a"), 0);
  assert.equal(
    removePermissionForToolCall(queues, "session-a", "tool-unknown"),
    queues,
  );

  // Stopping the turn drops the whole queue, not just the visible request.
  const stopped = clearSessionPermissions(queues, "session-a");
  assert.equal(headPermission(stopped, "session-a"), undefined);
  assert.deepEqual(Object.keys(stopped), []);
});

test("a session with nothing pending keeps no empty queue", () => {
  const only = permission("session-a", "request-a");
  const queues = enqueuePermission({}, only);
  const emptied = removePermission(queues, "session-a", "request-a");

  assert.equal("session-a" in emptied, false);
  assert.equal(queuedPermissionCount(emptied, "session-a"), 0);
  assert.equal(headPermission(emptied, undefined), undefined);
});

test("asktool requests queue independently and never expire", () => {
  const first = {
    sessionId: "session-a",
    requestId: "ask-a",
    toolCallId: "tool-a",
    questions: [{ question: "Color?", options: ["Blue"] }],
  };
  const second = { ...first, requestId: "ask-b", toolCallId: "tool-b" };
  const queues = enqueueAsk(enqueueAsk({}, first), second);

  assert.equal(headAsk(queues, "session-a"), first);
  assert.equal(queuedAskCount(queues, "session-a"), 1);
  assert.equal(enqueueAsk(queues, second), queues);
  const next = removeAsk(queues, "session-a", "ask-a");
  assert.equal(headAsk(next, "session-a"), second);
  assert.equal(
    headAsk(removeAskForToolCall(next, "session-a", "tool-b"), "session-a"),
    undefined,
  );
  assert.deepEqual(Object.keys(clearSessionAsks(next, "session-a")), []);
});
test("asktool drafts are keyed by requestId and cleaned up on resolve, tool end, turn end, and session delete", async () => {
  const pendingAsksMod = await import("../src/lib/pending-asks.ts");
  assert.equal(typeof pendingAsksMod.emptyAskDraft, "function");
  assert.equal(typeof pendingAsksMod.setAskDraft, "function");
  assert.equal(typeof pendingAsksMod.dropAskDraft, "function");
  assert.equal(typeof pendingAsksMod.dropSessionAskDrafts, "function");
  assert.equal(typeof pendingAsksMod.dropToolCallAskDrafts, "function");

  const first = {
    sessionId: "session-a",
    requestId: "ask-a",
    toolCallId: "tool-a",
    questions: [
      { question: "Q1?", options: ["A", "B"] },
      { question: "Q2?", options: ["C"] },
    ],
  };
  const second = {
    ...first,
    requestId: "ask-b",
    toolCallId: "tool-b",
  };
  const otherSessionAsk = {
    ...first,
    sessionId: "session-b",
    requestId: "ask-c",
    toolCallId: "tool-c",
  };
  const queues = enqueueAsk(
    enqueueAsk(enqueueAsk({}, first), second),
    otherSessionAsk,
  );
  const draftA = {
    index: 1,
    answers: [
      { values: ["B"], customSelected: false, customText: "", skipped: false },
      { values: [], customSelected: false, customText: "", skipped: false },
    ],
  };
  const draftB = pendingAsksMod.emptyAskDraft(second.questions);
  const draftC = pendingAsksMod.emptyAskDraft(otherSessionAsk.questions);
  let drafts = pendingAsksMod.setAskDraft({}, "ask-a", draftA);
  drafts = pendingAsksMod.setAskDraft(drafts, "ask-b", draftB);
  drafts = pendingAsksMod.setAskDraft(drafts, "ask-c", draftC);

  assert.deepEqual(drafts["ask-a"], draftA);
  const afterToolEnd = pendingAsksMod.dropToolCallAskDrafts(
    drafts,
    queues,
    "session-a",
    "tool-a",
  );
  assert.equal("ask-a" in afterToolEnd, false);
  assert.equal("ask-b" in afterToolEnd, true);
  assert.equal("ask-c" in afterToolEnd, true);

  const afterSessionClear = pendingAsksMod.dropSessionAskDrafts(
    drafts,
    queues,
    "session-a",
  );
  assert.equal("ask-a" in afterSessionClear, false);
  assert.equal("ask-b" in afterSessionClear, false);
  assert.deepEqual(afterSessionClear["ask-c"], draftC);

  assert.match(askCardSource, /useAppStore\(\(state\) => state\.askDrafts\[request\.requestId\]\)/);
  assert.match(askCardSource, /useAppStore\(\(state\) => state\.setAskDraft\)/);
  assert.match(interactionSource, /askDrafts:\s*removeAskDraft\(state\.askDrafts,\s*resolution\.requestId\)/);
  assert.match(interactionSource, /acknowledgePrompt\(resolution\.requestId\)/);
  assert.match(eventsSource, /dropSessionAskDrafts\(\s*state\.askDrafts,\s*state\.pendingAsks,\s*envelope\.sessionId/s);
  assert.match(eventsSource, /dropToolCallAskDrafts\(\s*state\.askDrafts,\s*state\.pendingAsks,\s*envelope\.sessionId,\s*event\.toolCallId/s);
  const projectSliceSource = readStoreModuleSync("slices/project-slice.ts");
  assert.match(projectSliceSource, /dropSessionAskDrafts\(state\.askDrafts,\s*state\.pendingAsks,\s*id\)/);

  const { register } = await import("node:module");
  register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
  const { createInteractionSlice } = await import("../src/stores/slices/interaction-slice.ts");
  const { api } = await import("../src/lib/api.ts");
  const acknowledged = [];
  let sliceState = {
    pendingAsks: enqueueAsk({}, first),
    pendingPermissions: {},
    askDrafts: {},
    acknowledgePrompt: async (id) => {
      acknowledged.push(id);
    },
  };
  const slice = createInteractionSlice({
    get: () => sliceState,
    set: (update) => {
      sliceState = {
        ...sliceState,
        ...(typeof update === "function" ? update(sliceState) : update),
      };
    },
    runtime: { beginNavigationIntent: () => 1 },
    interactionRuntime: { planResolutionRequests: new Map(), nextToastId: () => 1 },
  });
  Object.assign(sliceState, slice);

  slice.setAskDraft("ask-a", draftA);
  assert.deepEqual(sliceState.askDrafts["ask-a"], draftA);
  const origResolveAsk = api.resolveAskTool;
  api.resolveAskTool = async () => ({ ok: true });
  try {
    await slice.resolveAsk("session-a", {
      requestId: "ask-a",
      sessionId: "session-a",
      answers: [["B"], null],
    });
  } finally {
    api.resolveAskTool = origResolveAsk;
  }
  assert.equal(sliceState.pendingAsks["session-a"], undefined);
  assert.equal("ask-a" in sliceState.askDrafts, false);
  assert.deepEqual(acknowledged, ["ask-a"]);
});

test("asktool card is a stepwise, non-expiring composer question surface", () => {
  assert.match(chatSurfaceSource, /pendingAsk/);
  assert.match(composerSource, /<AskToolCard/);
  assert.match(composerSource, /headAsk\(s\.pendingAsks/);
  assert.doesNotMatch(transcriptSource, /AskToolCard/);
  // Each retained pane subscribes to its own session's ask queue (ADR 0137).
  assert.match(sessionPaneSource, /askPending=\{transcript\.historical \? false : askPending\}/);
  assert.match(sessionPaneSource, /headAsk\(state\.pendingAsks, sessionId\)/);
  assert.match(storeSource, /event\.type === "asktool_request"/);
  assert.match(askCardSource, /current\.multiSelect/);
  assert.match(askCardSource, /customOption/);
  assert.match(askCardSource, /Decline all|askTool\.decline/);
  assert.match(askCardSource, /draft\.skipped/);
  assert.doesNotMatch(askCardSource, /permissionSecondsLeft|setInterval/);
  assert.match(messageStyleSource, /\.asktool-options[\s\S]*?overflow-y:\s*auto/);
  assert.match(messageStyleSource, /\.asktool-options[\s\S]*?max-height:\s*min\(208px,\s*24dvh\)/);
  assert.match(messageStyleSource, /\.asktool-options[\s\S]*?overscroll-behavior-y:\s*contain/);
  // A long question prompt scrolls inside the question body. Header actions
  // stay outside that scroller so Decline, Skip, and Next/Submit remain
  // reachable (issue #1531). The cap matches the option list.
  const questionBody = messageStyleSource.match(
    /\n\.asktool-question-body \{([^}]*)\}/,
  )?.[1];
  assert.ok(questionBody);
  assert.match(questionBody, /max-height:\s*min\(208px,\s*24vh\)/);
  assert.match(questionBody, /max-height:\s*min\(208px,\s*24dvh\)/);
  assert.match(questionBody, /overflow-x:\s*hidden/);
  assert.match(questionBody, /overflow-y:\s*auto/);
  assert.match(questionBody, /overscroll-behavior-y:\s*contain/);
  assert.doesNotMatch(questionBody, /scrollbar-gutter/);
  assert.match(questionBody, /overflow-wrap:\s*anywhere/);
  assert.match(
    askCardSource,
    /className="asktool-card-header-actions"[\s\S]*className="asktool-question-body"/,
  );
  // The card is a dock surface, not an in-flow tile: it paints the composer
  // plate with its shadow and its rows are inlaid on that plate (issue #360).
  assert.match(
    composerStyleSource,
    /\.composer-stack > \.asktool-card \{[^}]*background: var\(--ds-bg-composer\)/,
  );
  assert.match(
    composerStyleSource,
    /\.composer-stack > \.asktool-card \{[^}]*box-shadow: var\(--ds-shadow-composer\)/,
  );
  assert.doesNotMatch(messageStyleSource, /\.asktool-option \{[^}]*--ds-raised/);
  assert.match(messageStyleSource, /\.asktool-option \{[^}]*background: var\(--ds-tile-deep\)/);
  assert.match(
    messageStyleSource,
    /\.asktool-custom-input \{[^}]*background: var\(--ds-tile-deep\)/,
  );
});

test("asktool question body opens at the top when the question index changes", () => {
  // Next, Skip, and the step indicators only call setIndex. The question
  // body is one scroller for the whole request, so a later long prompt keeps
  // the previous scrollTop unless that body remounts with the index or the
  // offset is cleared when index changes (#1531).
  const bodyTag = askCardSource.match(
    /<span\b[^>]*className="asktool-question-body"[^>]*>/,
  )?.[0];
  assert.ok(bodyTag);
  const remountsOnIndex = /\bkey=\{index\}/.test(bodyTag);
  const clearsScrollOnIndex =
    /scrollTop\s*=\s*0/.test(askCardSource) &&
    /\[\s*index\s*\]/.test(askCardSource);
  assert.ok(
    remountsOnIndex || clearsScrollOnIndex,
    "question body keeps scrollTop across index changes",
  );
});

test("permission approval stays pending until an explicit decision", () => {
  assert.doesNotMatch(cardSource, /setInterval|permissionSecondsLeft|role="timer"/);
  assert.doesNotMatch(eventsSource, /receivedAt/);
});

test("permission approval is an inline transcript card, never a global dialog", () => {
  assert.doesNotMatch(appSource, /PermissionDialog/);
  assert.doesNotMatch(chatSurfaceSource, /PermissionDialog/);
  assert.doesNotMatch(appSource, /Boolean\(permission\)/);
  // The surface still needs the visible session's head request to decide
  // between the empty state and the panes; the card itself is rendered by the
  // pane that owns the session (ADR 0137).
  assert.match(chatSurfaceSource, /headPermission\(state\.pendingPermissions/);
  assert.match(
    sessionPaneSource,
    /pendingPermission=\{transcript\.historical \? undefined : pendingPermission\}/,
  );
  assert.match(
    sessionPaneSource,
    /headPermission\(state\.pendingPermissions, sessionId\)/,
  );
  assert.match(transcriptSource, /key=\{pendingPermission\.requestId\}/);
  assert.match(transcriptSource, /permission=\{pendingPermission\}/);
  assert.doesNotMatch(cardSource, /className="overlay"|className="dialog"/);
  assert.doesNotMatch(cardSource, /role="alertdialog"/);
  assert.match(cardSource, /role="region"/);
  assert.match(cardSource, /disabled=\{resolving\}/);
  assert.match(cardSource, /requestAnimationFrame/);
  assert.match(cardSource, /showToast/);
  assert.doesNotMatch(cardSource, /<section[^>]*aria-live=/);
  assert.doesNotMatch(cardSource, /permissionSecondsLeft|permission\.receivedAt/);
  assert.match(browserSource, /blocking overlay/);
  assert.doesNotMatch(browserSource, /permission dialog/);
});

test("the card names the delegate that asked and how many wait behind it", () => {
  assert.match(sessionPaneSource, /sessionPermissions\(/);
  assert.match(
    sessionPaneSource,
    /Math\.max\(0, sessionPermissions\(state\.pendingPermissions, sessionId\)\.length - 1\)/,
  );
  assert.match(
    sessionPaneSource,
    /queuedPermissions=\{queuedPermissions\}/,
  );
  assert.match(transcriptSource, /queued=\{queuedPermissions\}/);
  assert.match(cardSource, /t\("permission\.queued", \{ count: queued \}\)/);
  assert.match(
    cardSource,
    /t\("permission\.fromSubagent", \{ agent: permission\.agentName \}\)/,
  );
});

test("background permission events update only session-scoped state", () => {
  assert.match(
    storeSource,
    /pendingPermissions:\s*PermissionQueues/,
  );
  assert.doesNotMatch(storeSource, /permission\?:\s*ToolPermissionRequest/);
  const backgroundBlock = eventsSource.match(
    /if \(envelope\.sessionId !== get\(\)\.activeSessionId\)[\s\S]*?return;/,
  )?.[0];
  assert.ok(backgroundBlock);
  assert.match(backgroundBlock, /enqueuePermission/);
  assert.doesNotMatch(
    backgroundBlock,
    /selectSession|activeSessionId:\s*|messages:\s*|page:\s*/,
  );
  assert.match(
    interactionSource,
    /resolvePermission: async \(sessionId, requestId, decision\)/,
  );
  // Only the request on screen is answerable, and a late answer clears that
  // request alone rather than whatever now sits at the head.
  assert.match(storeSource, /headPermission\(get\(\)\.pendingPermissions, sessionId\)/);
  assert.match(
    storeSource,
    /removePermission\([\s\S]*state\.pendingPermissions,[\s\S]*sessionId,[\s\S]*requestId/,
  );
  assert.match(storeSource, /removePermissionForToolCall\(/);
  const abortStart = transcriptSliceSource.indexOf("abort: async");
  const abortBlock = transcriptSliceSource.slice(abortStart);
  assert.match(abortBlock, /Promise\.allSettled/);
  assert.match(abortBlock, /decision: "deny"/);
  // Every open request is denied: a queued delegate would otherwise keep its
  // tool call alive past the stop the user asked for.
  assert.match(abortBlock, /sessionPermissions\(/);
  assert.match(abortBlock, /clearSessionPermissions\(/);
});

test("new navigation intents invalidate older asynchronous commits", async () => {
  const navigation = createNavigationIntentController();
  let releaseOlder;
  const olderGate = new Promise((resolve) => {
    releaseOlder = resolve;
  });
  const committed = [];

  const older = (async () => {
    const intent = navigation.begin();
    await olderGate;
    if (navigation.isCurrent(intent)) committed.push("older");
  })();
  const newerIntent = navigation.begin();
  if (navigation.isCurrent(newerIntent)) committed.push("newer");
  releaseOlder();
  await older;

  assert.deepEqual(committed, ["newer"]);
});

test("session and page navigation share the latest-intent guard", () => {
  assert.match(storeSource, /createNavigationIntentController/);
  assert.doesNotMatch(storeSource, /sessionSelectionQueue/);
  assert.match(sessionRuntimeSource, /let sessionWorkspaceQueue: Promise<unknown>/);
  assert.match(
    storeSource,
    /const detailPromise = runtime\.loadSessionDetail\(id,\s*\{/,
  );
  assert.match(storeSource, /opts\?\.navigationIntent \?\? runtime\.beginNavigationIntent\(\)/);
  assert.match(sessionRuntimeSource, /sessionWorkspaceQueue\.then/);
  assert.ok(
    storeSource.match(/navigationIntentIsCurrent\(intent\)/g)?.length >= 12,
    "navigation intent must be checked after asynchronous boundaries",
  );
  assert.match(interactionSource, /setPage: \(page, opts\) => \{\s*runtime\.beginNavigationIntent\(\)/);
  assert.match(storeSource, /activateProject: async \(path, opts\)/);
  assert.match(storeSource, /clearProject: async \(opts\)/);
});
