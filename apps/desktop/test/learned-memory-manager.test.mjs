import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { editConflicted, escapeCloses, managerRequest, memoryErrorCode, showsEmptyState, sourceSessionOf } =
  await import("../src/lib/learned-memory-manager.ts");

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
