/**
 * The session origin tag, its filter, and the scheduled-run fold
 * (ADR persisted-session-origin).
 *
 * These are the renderer rules that decide what a row says and what the view
 * menu hides, so they are pinned here rather than through a rendered sidebar:
 * an old host's summary has no origin, a preference written before the filter
 * existed selects everything, one task's runs fold into its newest run, and a
 * renderer payload cannot carry a provenance key into the host.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  SESSION_ORIGINS,
  normalizeOrigins,
  originFilterActive,
  originLabelKey,
  originTooltip,
  sessionMatchesOrigins,
  sessionOrigin,
} = await import("../src/features/sessions/session-origin-tags.ts");
const { SCHEDULED_RUNS_SHOWN, foldScheduledRuns } = await import(
  "../src/features/sessions/scheduled-run-groups.ts"
);
const { getSidebarActivitySessions } = await import(
  "../src/lib/sidebar-session-groups.ts"
);
const { loadSidebarPreferences, SIDEBAR_PREFERENCES_KEY } = await import(
  "../src/lib/sidebar-preferences.ts"
);
const { withoutSessionOrigin } = await import(
  "../electron/main/ipc/session-origin-payload.ts"
);

const session = (overrides) => ({
  id: "s",
  title: "Task",
  messageCount: 0,
  mode: "agent",
  thinkingLevel: "off",
  permissionMode: "inherit",
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

test("a summary from a host that predates the column reads as the person's own", () => {
  assert.equal(sessionOrigin({}), "user");
  assert.equal(sessionOrigin({ origin: "agent" }), "agent");
  // A value a newer host could write is not trusted blindly.
  assert.equal(sessionOrigin({ origin: "steward" }), "user");
});

test("only the person's own conversations go untagged", () => {
  assert.equal(originLabelKey("user"), null);
  assert.equal(originLabelKey("agent"), "nav.originAgent");
  assert.equal(originLabelKey("plugin"), "nav.originPlugin");
  assert.equal(originLabelKey("task"), "nav.originTask");
  assert.equal(originLabelKey("scheduled"), "nav.originScheduled");
});

test("the tooltip names the session that dispatched the work", () => {
  const handedOff = session({
    origin: "agent",
    originSession: { sessionId: "p", title: "Parent", available: true },
  });
  assert.deepEqual(originTooltip(handedOff), {
    key: "nav.originDispatchedBy",
    title: "Parent",
  });

  // A deleted creator keeps the tag and loses the title, so the wording changes
  // instead of quoting an empty name.
  const orphaned = session({
    origin: "plugin",
    originSession: { sessionId: "p", title: "", available: false },
  });
  assert.deepEqual(originTooltip(orphaned), { key: "nav.originDispatchedByDeleted" });

  assert.deepEqual(originTooltip(session({ origin: "scheduled", title: "Nightly" })), {
    key: "nav.originScheduledTooltip",
    title: "Nightly",
  });
});

test("a missing, malformed, or empty filter selects every origin", () => {
  assert.deepEqual(normalizeOrigins(undefined), [...SESSION_ORIGINS]);
  assert.deepEqual(normalizeOrigins("agent"), [...SESSION_ORIGINS]);
  assert.deepEqual(normalizeOrigins([]), [...SESSION_ORIGINS]);
  assert.deepEqual(normalizeOrigins(["agent", "steward"]), ["agent"]);
  assert.equal(originFilterActive([...SESSION_ORIGINS]), false);
  assert.equal(originFilterActive(["user", "agent"]), true);
});

test("the filter matches the stored origin, not the raw shape", () => {
  assert.equal(sessionMatchesOrigins({}, ["user"]), true);
  assert.equal(sessionMatchesOrigins({ origin: "scheduled" }, ["scheduled"]), true);
  assert.equal(sessionMatchesOrigins({ origin: "scheduled" }, ["user"]), false);
});

test("one task's runs fold into its newest run", () => {
  const runs = [
    session({ id: "r1", origin: "scheduled", originTaskId: "t1", updatedAt: "2026-01-01T00:00:00.000Z" }),
    session({ id: "r2", origin: "scheduled", originTaskId: "t1", updatedAt: "2026-01-03T00:00:00.000Z" }),
    session({ id: "r3", origin: "scheduled", originTaskId: "t1", updatedAt: "2026-01-02T00:00:00.000Z" }),
    session({ id: "chat", origin: "user", updatedAt: "2026-01-04T00:00:00.000Z" }),
  ];

  const rows = foldScheduledRuns(runs);

  assert.deepEqual(
    rows.map((row) => row.id),
    ["r2", "chat"],
    "the newest run stands for the task, at its own position",
  );
  const folded = rows[0];
  assert.equal(folded.scheduledGroup.runCount, 3);
  assert.deepEqual(
    folded.scheduledGroup.runs.map((run) => run.id),
    ["r2", "r3", "r1"],
    "the expansion is newest first",
  );
});

test("the activity feed folds one task's runs like the project groups do", () => {
  // A five-minute task runs 288 times a day; a feed that listed every run would
  // be all automation and no conversation.
  const runs = [
    session({ id: "r1", origin: "scheduled", originTaskId: "t1", updatedAt: "2026-01-01T00:00:00.000Z" }),
    session({ id: "r2", origin: "scheduled", originTaskId: "t1", updatedAt: "2026-01-02T00:00:00.000Z" }),
    session({ id: "chat", origin: "user", updatedAt: "2025-12-31T00:00:00.000Z" }),
  ];
  const feed = getSidebarActivitySessions({
    sessions: foldScheduledRuns(runs),
    sessionMeta: {},
    projectMeta: {},
    showArchived: false,
  });
  assert.deepEqual(
    feed.map((row) => row.id),
    ["r2", "chat"],
    "the newest run stands for the task, in the feed's own time order",
  );
});

test("a run without a task id stays its own row", () => {
  const rows = foldScheduledRuns([
    session({ id: "r1", origin: "scheduled" }),
    session({ id: "r2", origin: "scheduled" }),
  ]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["r1", "r2"],
  );
  assert.equal(rows[0].scheduledGroup, undefined);
});

test("the expansion stops at five runs and reports the real total", () => {
  const runs = Array.from({ length: SCHEDULED_RUNS_SHOWN + 3 }, (_, index) =>
    session({
      id: `r${index}`,
      origin: "scheduled",
      originTaskId: "t1",
      updatedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    }),
  );
  const [row] = foldScheduledRuns(runs);
  assert.equal(row.scheduledGroup.runCount, SCHEDULED_RUNS_SHOWN + 3);
  assert.equal(row.scheduledGroup.runs.length, SCHEDULED_RUNS_SHOWN);
});

test("a sidebar preference written before the filter existed selects everything", () => {
  const stored = {
    sessionMeta: {},
    projectMeta: {},
    projectSort: "recent",
    sessionView: { sort: "recent", archived: false },
    openProjectPaths: [],
  };
  const restored = loadSidebarPreferences(stored);
  assert.deepEqual(restored.sessionView.origins, [...SESSION_ORIGINS]);
  assert.equal(SIDEBAR_PREFERENCES_KEY, "pi.desktop.sidebarPreferences");

  const narrowed = loadSidebarPreferences({
    ...stored,
    sessionView: { ...stored.sessionView, origins: ["user", "scheduled"] },
  });
  assert.deepEqual(narrowed.sessionView.origins, ["user", "scheduled"]);

  const garbage = loadSidebarPreferences({
    ...stored,
    sessionView: { ...stored.sessionView, origins: [42, "nope"] },
  });
  assert.deepEqual(garbage.sessionView.origins, [...SESSION_ORIGINS]);
});

test("a renderer payload cannot carry a provenance key into the host", () => {
  const input = { title: "New task", projectPath: "/repo", origin: "agent" };
  assert.deepEqual(withoutSessionOrigin(input), {
    title: "New task",
    projectPath: "/repo",
  });
  assert.deepEqual(withoutSessionOrigin(null), {});
  assert.deepEqual(withoutSessionOrigin("agent"), {});
  assert.deepEqual(
    withoutSessionOrigin({ originSessionId: "s", originTaskId: "t", projectId: "3" }),
    { projectId: "3" },
  );
  // The original object is untouched: the caller's own reference is not mutated.
  assert.equal(input.origin, "agent");
});