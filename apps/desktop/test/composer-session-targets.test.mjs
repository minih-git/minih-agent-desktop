import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/**
 * The `#` Composer trigger's session candidates (D673).
 *
 * A target exists so work can be handed to that conversation, so the list must
 * follow the rule the `SessionList` tool reports: same project, local,
 * Agent-mode, not archived. Everything else here — the order, the query and the
 * cap — is what makes the group useful rather than merely correct.
 */
const { MAX_SESSION_TARGET_ITEMS, sessionTargetCandidates, sessionTargetChipInsert, sessionTargetProjectPath } =
  await import("../src/features/chat/composer/session-targets.ts");

const at = (iso) => iso;

function session(id, over = {}) {
  return {
    id,
    title: id,
    messageCount: 1,
    mode: "agent",
    thinkingLevel: "off",
    permissionMode: "ask",
    projectPath: "/work/app",
    updatedAt: at("2026-10-20T00:00:00.000Z"),
    createdAt: at("2026-10-01T00:00:00.000Z"),
    ...over,
  };
}

const ids = (candidates) => candidates.map((candidate) => candidate.session.id);

test("lists the caller's project only, newest first, never the caller itself", () => {
  const sessions = [
    session("old", { title: "Old review", updatedAt: at("2026-10-01T00:00:00.000Z") }),
    session("caller", { title: "Caller", updatedAt: at("2026-10-20T00:00:00.000Z") }),
    session("new", { title: "New review", updatedAt: at("2026-10-19T00:00:00.000Z") }),
    session("other-project", { title: "Elsewhere", projectPath: "/work/other" }),
  ];
  const candidates = sessionTargetCandidates({
    sessions,
    sessionMeta: {},
    activeSessionId: "caller",
    activeProjectPath: "/work/app",
    query: "",
  });
  assert.deepEqual(ids(candidates), ["new", "old"]);
});

test("a session without a project lists the other sessions without one", () => {
  const sessions = [
    session("temp-a", { projectPath: undefined, title: "Scratch A" }),
    session("temp-b", { projectPath: "  ", title: "Scratch B" }),
    session("project", { title: "Project" }),
  ];
  assert.deepEqual(
    ids(
      sessionTargetCandidates({
        sessions,
        sessionMeta: {},
        activeSessionId: "temp-a",
        activeProjectPath: undefined,
        query: "",
      }),
    ),
    ["temp-b"],
  );
});

test("the empty home falls back to the project the user selected there", () => {
  const sessions = [session("a"), session("b", { projectPath: "/work/other" })];
  // No session is open yet, so the home's selected project decides.
  assert.deepEqual(
    ids(
      sessionTargetCandidates({
        sessions,
        sessionMeta: {},
        activeSessionId: null,
        activeProjectPath: "/work/app/",
        query: "",
      }),
    ),
    ["a"],
  );
  assert.equal(
    sessionTargetProjectPath({ sessions, activeSessionId: null, activeProjectPath: "/work/app/" }),
    "/work/app",
  );
  // Windows separators normalize the same way the sidebar compares them.
  assert.equal(
    sessionTargetProjectPath({
      sessions: [session("w", { projectPath: String.raw`C:\work\app` })],
      activeSessionId: "w",
      activeProjectPath: "/ignored",
    }),
    "C:/work/app",
  );
});

test("excludes remote, archived, automation and non-Agent sessions", () => {
  const sessions = [
    session("desktop"),
    session("remote-source", { source: "remote" }),
    session("remote:id-prefixed"),
    session("archived", { archived: true }),
    session("archived-meta"),
    session("automation", { scheduledRun: true }),
    session("plan-mode", { mode: "plan" }),
    session("goal-mode", { mode: "goal" }),
  ];
  const candidates = sessionTargetCandidates({
    sessions,
    sessionMeta: { "archived-meta": { archived: true } },
    activeSessionId: null,
    activeProjectPath: "/work/app",
    query: "",
  });
  assert.deepEqual(ids(candidates), ["desktop"]);
});

test("orders ties deterministically instead of leaving them to the store", () => {
  const sessions = [
    session("b", { title: "Beta" }),
    session("a", { title: "Alpha" }),
  ];
  const candidates = sessionTargetCandidates({
    sessions,
    sessionMeta: {},
    activeSessionId: null,
    activeProjectPath: "/work/app",
    query: "",
  });
  // Same timestamp: the shared comparator's rule, shorter title first, so the
  // order never depends on the store's iteration order.
  assert.deepEqual(ids(candidates), ["b", "a"]);
});

test("a query matches a title by substring or subsequence and carries ranges", () => {
  const sessions = [
    session("review", { title: "Review the diff" }),
    session("deploy", { title: "Deploy notes" }),
    session("ready", { title: "Ready" }),
  ];
  const candidates = sessionTargetCandidates({
    sessions,
    sessionMeta: {},
    activeSessionId: null,
    activeProjectPath: "/work/app",
    query: "rev",
  });
  assert.deepEqual(ids(candidates), ["review"]);
  assert.deepEqual(candidates[0].match.ranges, [[0, 3]]);

  // Case folds, and a subsequence still finds the row, so `#RV` and `#rdy`
  // both work.
  assert.deepEqual(
    ids(
      sessionTargetCandidates({
        sessions,
        sessionMeta: {},
        activeSessionId: null,
        activeProjectPath: "/work/app",
        query: "RV",
      }),
    ),
    ["review"],
  );
  assert.deepEqual(
    ids(
      sessionTargetCandidates({
        sessions,
        sessionMeta: {},
        activeSessionId: null,
        activeProjectPath: "/work/app",
        query: "rdy",
      }),
    ),
    ["ready"],
  );
});

test("no match is an empty list, which is what keeps a heading as text", () => {
  const sessions = [session("review", { title: "Review the diff" })];
  for (const query of ["#", "123", "zzz"]) {
    assert.deepEqual(
      sessionTargetCandidates({
        sessions,
        sessionMeta: {},
        activeSessionId: null,
        activeProjectPath: "/work/app",
        query,
      }),
      [],
    );
  }
});

test("caps the group without dropping the newest rows", () => {
  const sessions = Array.from({ length: MAX_SESSION_TARGET_ITEMS + 12 }, (_, index) =>
    session(`s${String(index).padStart(3, "0")}`, {
      // Newer as the index grows, so the cap must keep the tail.
      updatedAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
    }),
  );
  const candidates = sessionTargetCandidates({
    sessions,
    sessionMeta: {},
    activeSessionId: null,
    activeProjectPath: "/work/app",
    query: "",
  });
  assert.equal(candidates.length, MAX_SESSION_TARGET_ITEMS);
  assert.equal(candidates[0].session.id, `s${String(sessions.length - 1).padStart(3, "0")}`);
});

test("an accepted chip keeps exactly one space after it", () => {
  // At the end of the draft the chip is followed by a space, so the caret can
  // keep typing after it.
  assert.equal(sessionTargetChipInsert("\uE001", undefined), "\uE001 ");
  // A space the draft already has is not doubled.
  assert.equal(sessionTargetChipInsert("\uE001", " "), "\uE001");
  assert.equal(sessionTargetChipInsert("\uE001", "\n"), "\uE001");
  // A following word still gets its separator.
  assert.equal(sessionTargetChipInsert("\uE001", "next"), "\uE001 ");
});
