import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const {
  acceptancePercent,
  badgeCount,
  editConflicted,
  escapeCloses,
  initialManagerTab,
  managerRequest,
  formatIndexSize,
  memoryErrorCode,
  showsEmptyState,
  sourceSessionOf,
  suggestionSummary,
  todayExtractionSpend,
} = await import("../src/lib/learned-memory-manager.ts");

// ADR agent-long-term-memory §3.2: the manager's rules, tested without a DOM.
// Each case is a decision the dialog must get right, and each one is a real
// boundary — a scope it reads, a conflict it survives, a session it can open.

test("a project scope reads that project and a user scope reads no path", () => {
  assert.deepEqual(managerRequest({ scope: "project", projectPath: "/tmp/app" }), {
    scope: "project",
    path: "/tmp/app",
  });
  // Filters travel only when they are set; an empty string means "all".
  assert.deepEqual(
    managerRequest({ scope: "project", projectPath: "/tmp/app", status: "active", kind: "fact" }),
    { scope: "project", path: "/tmp/app", status: "active", kind: "fact" },
  );
  assert.deepEqual(
    managerRequest({ scope: "user", projectPath: "/tmp/app", status: "", kind: "" }),
    { scope: "user" },
  );
});

test("a conflict is recognized by its stable code, not by a message", () => {
  assert.equal(editConflicted({ errorCode: "MEMORY_REVISION_CONFLICT" }), true);
  assert.equal(editConflicted({ data: { errorCode: "MEMORY_REVISION_CONFLICT" } }), true);
  // Any other refusal is a different problem and must not be read as a conflict.
  assert.equal(editConflicted({ errorCode: "MEMORY_CREDENTIAL_DETECTED" }), false);
  assert.equal(editConflicted(new Error("memory changed since it was read")), false);
  assert.equal(editConflicted(null), false);
  assert.equal(memoryErrorCode(undefined), "");
  assert.equal(memoryErrorCode({ errorCode: 42 }), "");
});

test("escape closes the manager only when nothing is in flight", () => {
  assert.equal(escapeCloses("Escape", false), true);
  assert.equal(escapeCloses("Escape", true), false);
  assert.equal(escapeCloses("Enter", false), false);
});

test("an empty list is a state of its own, and a note knows its conversation", () => {
  assert.equal(showsEmptyState([]), true);
  assert.equal(showsEmptyState(null), false);
  assert.equal(showsEmptyState([{ id: "entry-1" }]), false);
  assert.equal(sourceSessionOf({ sourceSessionId: "session-1" }), "session-1");
  assert.equal(sourceSessionOf({ sourceSessionId: "" }), undefined);
  assert.equal(sourceSessionOf({}), undefined);
});

test("the inbox tab shows a quiet count and opens on whichever tab has work", () => {
  // Nothing waiting renders no badge at all: the tab must not look like a
  // notification the user has to clear.
  assert.equal(badgeCount(0), null);
  assert.equal(badgeCount(-3), null);
  assert.equal(badgeCount(Number.NaN), null);
  assert.equal(badgeCount(2), 2);
  assert.equal(badgeCount(2.9), 2);

  assert.equal(initialManagerTab(0), "entries");
  assert.equal(initialManagerTab(3), "suggestions");
});

test("a suggestion shows the user's own words, and says nothing when it has none", () => {
  assert.deepEqual(suggestionSummary({ quotes: [{ text: "  Use pnpm  " }] }), {
    quote: "Use pnpm",
  });
  assert.deepEqual(suggestionSummary({ quotes: [] }), {});
  assert.deepEqual(suggestionSummary({}), {});
  assert.deepEqual(suggestionSummary({ quotes: [{ text: "   " }] }), {});
});

// Plan §1: the manager reports this device's own usage. Each number has a state
// before it exists, and none of them may read as a wrong value.
test("a rate exists only once something was decided", () => {
  assert.equal(acceptancePercent(0, 0), null);
  assert.equal(acceptancePercent(3, 1), 75);
  assert.equal(acceptancePercent(0, 4), 0);
  assert.equal(acceptancePercent(2, 1), 67);
});

test("an index size reads in the unit a person can judge", () => {
  assert.equal(formatIndexSize(0), "0 B");
  assert.equal(formatIndexSize(512), "512 B");
  assert.equal(formatIndexSize(1024), "1 KB");
  assert.equal(formatIndexSize(3584), "3.5 KB");
  assert.equal(formatIndexSize(20480), "20 KB");
});

test("a ledger from an earlier day is not today's spend", () => {
  assert.equal(todayExtractionSpend({ day: "2026-10-20", tokens: 1200 }, "2026-10-20"), 1200);
  assert.equal(todayExtractionSpend({ day: "2026-10-19", tokens: 1200 }, "2026-10-20"), 0);
  assert.equal(todayExtractionSpend({ day: "", tokens: 5 }, "2026-10-20"), 0);
});
