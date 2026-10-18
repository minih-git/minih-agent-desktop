import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readStoreModule } from "./helpers/source-contracts.mjs";

// The reminder for a pending ask/permission/plan has three layers: a sticky
// in-app toast, a durable host row that survives a restart, and the native
// banner. These checks pin the contract of each layer, because the failure that
// motivated them — a prompt whose only trace vanished with an 8 s toast — is
// invisible to a single unit test of any one piece.
const runtimeSource = await readFile(
  new URL("../src/stores/runtime/notification-runtime.ts", import.meta.url),
  "utf8",
);
const eventsSource = await readStoreModule("slices/events-slice.ts");
const catalogSource = await readStoreModule("slices/catalog-slice.ts");
const interactionSource = await readStoreModule("slices/interaction-slice.ts");
const centerSource = await readFile(
  new URL("../src/components/NotificationCenter.tsx", import.meta.url),
  "utf8",
);
const ipcSource = await readFile(
  new URL("../electron/main/ipc/notification-ipc.ts", import.meta.url),
  "utf8",
);
const shellSource = await readFile(
  new URL("../src/features/app/useAppShellRuntime.tsx", import.meta.url),
  "utf8",
);
const transcriptSource = await readStoreModule("slices/transcript-slice.ts");

test("every interactive request reports its runtime id for the durable row", () => {
  const blocks = eventsSource.split("notifyInteractivePrompt(").slice(1);
  assert.equal(blocks.length, 5, "ask/permission/plan are reported from both paths");
  for (const block of blocks) {
    const call = block.slice(0, 220);
    assert.match(call, /requestId:/, "a prompt row needs the runtime request id");
    assert.match(call, /turnId:/, "the turn that is blocked stays attributable");
  }
});

test("a prompt reminder records the durable row and keeps its toast", () => {
  assert.match(runtimeSource, /recordPromptNotification\(/);
  assert.match(runtimeSource, /requestId: payload\.requestId/);
  assert.match(runtimeSource, /duration: 0/);
  assert.match(runtimeSource, /promptRequestId: payload\.requestId/);
  assert.doesNotMatch(
    runtimeSource,
    /duration: 8_000/,
    "a pending prompt must not auto-dismiss",
  );
});

test("resolving a prompt closes its toast and marks the row read", () => {
  assert.match(catalogSource, /acknowledgePrompt: async \(requestId\)/);
  assert.match(catalogSource, /item\.promptRequestId !== requestId/);
  assert.match(catalogSource, /item\.requestId === requestId && !item\.readAt/);
  assert.match(catalogSource, /markNotificationRead\(notification\.id\)/);
  const acknowledgements = (interactionSource.match(/acknowledgePrompt\(/g) ?? []).length;
  assert.equal(acknowledgements, 3, "ask, permission, and plan each acknowledge");
});

test("the inbox renders prompt rows as a call to action", () => {
  assert.match(centerSource, /notification\.kind\.startsWith\("prompt\."\)/);
  assert.match(centerSource, /prompt === "prompt\.permission"/);
  assert.match(centerSource, /prompt === "prompt\.plan"/);
  assert.match(centerSource, /prompt === "prompt\.ask"/);
  assert.match(centerSource, /notifications\.promptAskTitle/);
});

test("main forwards the prompt row to the host and pushes it back", () => {
  assert.match(ipcSource, /IPC\.invoke\.notificationRecordPrompt/);
  assert.match(ipcSource, /"notification\.recordPrompt"/);
  assert.match(ipcSource, /IPC\.event\.notificationChanged/);
});

test("a prompt row never becomes a session outcome or a second banner", () => {
  assert.match(
    shellSource,
    /if \(!notification\.kind\.startsWith\("task\."\)\) return;/,
    "the task banner path must ignore prompt rows",
  );
  assert.match(
    catalogSource,
    /latestSessionOutcomes\(/,
    "the live row path must use the shared outcome rule",
  );
  assert.doesNotMatch(
    catalogSource,
    /\[notification\.sessionId\]:\s*\n\s*notification\.kind === "task\.failed"/,
    "a prompt row must not write a completed badge",
  );
});

test("a prompt dropped without an answer still closes its reminder", () => {
  const eventsAcknowledgements =
    (eventsSource.match(/acknowledgePrompt\(/g) ?? []).length;
  assert.ok(
    eventsAcknowledgements >= 3,
    "turn end, visible tool end, and background tool end all settle reminders",
  );
  assert.match(transcriptSource, /acknowledgePrompt\(permission\.requestId\)/);
});

test("a failed resolve keeps the reminder pending", () => {
  const permissionBlock =
    interactionSource.match(/resolvePermission: async[\s\S]*?resolveAsk: async/)?.[0] ??
    "";
  assert.match(permissionBlock, /let resolved = false/);
  assert.match(permissionBlock, /if \(resolved\)/);
  const askBlock =
    interactionSource.match(/resolveAsk: async[\s\S]*?resolvePlan: async/)?.[0] ?? "";
  assert.match(askBlock, /let resolved = false/);
  assert.match(askBlock, /if \(resolved\)/);
});
