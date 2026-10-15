import {
  readStoreModuleSync,
  readMainSourceSync,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  latestSessionOutcomes,
  sidebarCollapsedProjectStatus,
  sidebarSessionStatus,
} from "../src/lib/sidebar-session-status.ts";
import { loadStylesSync } from "./helpers/styles.mjs";

function notification(overrides) {
  return {
    id: "notification-1",
    kind: "task.completed",
    sessionId: "session-1",
    sessionTitle: "Session",
    turnId: "turn-1",
    createdAt: "2026-07-27T10:00:00.000Z",
    readAt: null,
    ...overrides,
  };
}

test("keeps the newest unread completed or failed outcome for each session", () => {
  const outcomes = latestSessionOutcomes([
    notification({ id: "latest", kind: "task.completed" }),
    notification({ id: "older", kind: "task.failed" }),
  ,
    notification({
      id: "other",
      kind: "task.failed",
      sessionId: "session-2",
    }),
  ].filter(Boolean));

  assert.deepEqual(outcomes, {
    "session-1": "completed",
    "session-2": "failed",
  });
});

test("read task notifications leave no sidebar indicator", () => {
  const outcomes = latestSessionOutcomes([
    notification({ id: "latest", readAt: "2026-07-27T10:05:00.000Z" }),
    notification({ id: "older", kind: "task.failed" }),
  ]);

  assert.deepEqual(outcomes, {});
});

test("prioritizes in-progress and selected states over terminal outcomes", () => {
  assert.equal(
    sidebarSessionStatus({ running: true, selected: true, outcome: "failed" }),
    "running",
  );
  assert.equal(
    sidebarSessionStatus({ running: false, selected: true, outcome: "failed" }),
    "selected",
  );
  assert.equal(
    sidebarSessionStatus({ running: false, selected: false, outcome: "completed" }),
    "completed",
  );
  assert.equal(sidebarSessionStatus({ running: false, selected: false }), null);
});

test("treats a pending question card as awaiting the user like a pending permission", () => {
  assert.equal(
    sidebarSessionStatus({ running: true, selected: true, hasPendingAsk: true }),
    "permission",
  );
  assert.equal(
    sidebarSessionStatus({ running: true, selected: false, hasPendingAsk: true }),
    "permission",
  );
  assert.equal(
    sidebarSessionStatus({ running: true, selected: false, hasPendingAsk: false }),
    "running",
  );
});

test("shows collapsed project status only when project is collapsed and has running or permission-pending sessions", () => {
  const sessions = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];

  assert.equal(
    sidebarCollapsedProjectStatus({
      collapsed: false,
      sessions,
      runningSessions: { s1: true, s2: true },
      pendingPermissions: { s3: [{ id: "perm-1" }] },
    }),
    null,
    "expanded projects must not duplicate row status badges",
  );

  assert.equal(
    sidebarCollapsedProjectStatus({
      collapsed: true,
      sessions,
      runningSessions: {},
      pendingPermissions: {},
    }),
    null,
  );

  assert.deepEqual(
    sidebarCollapsedProjectStatus({
      collapsed: true,
      sessions,
      runningSessions: { s1: true },
      pendingPermissions: {},
    }),
    {
      kind: "running",
      runningCount: 1,
      permissionCount: 0,
    },
  );

  assert.deepEqual(
    sidebarCollapsedProjectStatus({
      collapsed: true,
      sessions,
      runningSessions: { s1: true, s2: true },
      pendingPermissions: { s2: [{ id: "perm-1" }] },
    }),
    {
      kind: "permission",
      runningCount: 2,
      permissionCount: 1,
    },
  );

  assert.deepEqual(
    sidebarCollapsedProjectStatus({
      collapsed: true,
      sessions,
      runningSessions: {},
      pendingPermissions: {},
      pendingAsks: { s3: [{ id: "ask-1" }] },
    }),
    {
      kind: "permission",
      runningCount: 1,
      permissionCount: 1,
    },
  );
});

test("opening a conversation acknowledges its outcome badge before loading details", () => {
  const sessionSource = readStoreModuleSync("slices/session-slice.ts");
  const catalogSource = readStoreModuleSync("slices/catalog-slice.ts");
  const selectBlock = sessionSource.match(/selectSession: async[\s\S]*?\n    newSession:/)?.[0] ?? "";
  const acknowledgementStart = selectBlock.indexOf(
    "const outcomeAcknowledgement = get().acknowledgeSessionOutcome(id);",
  );
  const detailLoadStart = selectBlock.indexOf(
    "const detailPromise = runtime.loadSessionDetail(id",
  );
  assert.ok(acknowledgementStart >= 0);
  assert.ok(detailLoadStart >= 0);
  assert.ok(
    acknowledgementStart < detailLoadStart,
    "session outcome acknowledgement must start before detail loading",
  );
  assert.match(selectBlock, /await outcomeAcknowledgement/);

  const ackBlock = catalogSource.slice(
    catalogSource.indexOf("acknowledgeSessionOutcome: async"),
  );
  assert.match(ackBlock, /withoutRecordKey\(state\.sessionOutcomes, sessionId\)/);
  assert.match(ackBlock, /markNotificationRead\(item\.id\)/);
});

test("renders semantic, shape-distinct sidebar status indicators", () => {
  const sidebar = fs.readFileSync(
    new URL("../src/components/Sidebar.tsx", import.meta.url),
    "utf8",
  );
  const styles = loadStylesSync();
  // The status fixture lives in the capture rig, which App only loads lazily
  // behind __PI_CAPTURE__.
  const app = fs.readFileSync(
    new URL("../src/capture/capture-rig.ts", import.meta.url),
    "utf8",
  );
  const main = readMainSourceSync();

  assert.match(sidebar, /sessionSelected[\s\S]*sessionCompleted[\s\S]*sessionFailed/);
  assert.match(sidebar, /IconCheck[\s\S]*IconCircleAlert/);
  assert.match(styles, /thread-item-status\.running::before[\s\S]*--ds-warning/);
  assert.match(styles, /thread-item-status\.selected::before[\s\S]*--ds-accent/);
  assert.match(styles, /thread-item-status\.completed[\s\S]*--ds-success/);
  assert.match(styles, /thread-item-status\.failed[\s\S]*--ds-error/);
  assert.match(
    styles,
    /prefers-reduced-motion: reduce[\s\S]*thread-item-status\.running::before[\s\S]*animation: none/,
  );
  assert.match(
    styles,
    /\.sidebar-project-status\.running \.sidebar-project-status-dot[\s\S]*--ds-warning/,
  );
  assert.match(
    styles,
    /\.sidebar-project-status\.permission \.sidebar-project-status-dot[\s\S]*--ds-purple/,
  );
  assert.match(
    app,
    /seedSidebarStatuses[\s\S]*runningSessions[\s\S]*sessionOutcomes/,
  );
  assert.match(
    main,
    /MINIH_AGENT_CAPTURE_STATUS_ONLY[\s\S]*prefers-reduced-motion[\s\S]*SIDEBAR_STATUS_PROBE[\s\S]*pi-sidebar-status-/,
  );
});
