import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { curationTitle, groupCurationBatches, showsCuration, undoConflict } = await import(
  "../src/lib/learned-memory-curation.ts"
);

// ADR learned-memory-consolidation §3: "recently curated" is a list of recorded
// changes, grouped by the batch one undo reverses. These are the decisions the
// block makes, tested without a DOM.

function row(overrides = {}) {
  return {
    id: 1,
    batchId: "b1",
    entryId: "e1",
    op: "activate",
    actor: "auto",
    after: { content: "Prefers terse Chinese replies.", status: "active", revision: 2 },
    createdAt: 1_760_000_000_000,
    ...overrides,
  };
}

test("an activation is its own batch and names one note", () => {
  const batches = groupCurationBatches([row()]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].kind, "activate");
  assert.equal(batches[0].rows.length, 1);
  assert.equal(batches[0].undone, false);
});

test("a merge reads as one merge, not as its five rows", () => {
  const batches = groupCurationBatches([
    row({ id: 1, op: "merge_new", entryId: "new" }),
    row({
      id: 2,
      op: "merge_archive",
      entryId: "old-1",
      before: { content: "Deploys on Friday.", status: "active", revision: 1 },
      after: { content: "Deploys on Friday.", status: "archived", supersededBy: "new", revision: 2 },
    }),
    row({
      id: 3,
      op: "merge_archive",
      entryId: "old-2",
      before: { content: "Deploys every Friday.", status: "active", revision: 1 },
      after: { content: "Deploys every Friday.", status: "archived", supersededBy: "new", revision: 2 },
    }),
  ]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].kind, "merge");
  assert.equal(batches[0].rows.length, 3);
  // The archived notes keep their wording in `before`, which is what the block
  // crosses out.
  const archived = batches[0].rows.filter((entry) => entry.op === "merge_archive");
  assert.equal(archived.length, 2);
  assert.equal(archived[0].before.content, "Deploys on Friday.");
});

test("a replace and a reword keep their own names", () => {
  const replace = groupCurationBatches([
    row({ op: "replace_archive", before: { content: "old", status: "active", revision: 1 } }),
  ]);
  assert.equal(replace[0].kind, "replace");
  const reword = groupCurationBatches([
    row({
      op: "reword",
      before: { content: "gateway on 8787", status: "active", revision: 2 },
      after: { content: "The gateway listens on port 8787.", status: "active", revision: 3 },
    }),
  ]);
  assert.equal(reword[0].kind, "reword");
});

test("batches come newest first, and a batch whose rows are all undone is marked", () => {
  const batches = groupCurationBatches([
    row({ id: 1, batchId: "old", createdAt: 1_000 }),
    row({ id: 2, batchId: "new", createdAt: 2_000 }),
    row({ id: 3, batchId: "undone", createdAt: 3_000, undoneAt: 4_000 }),
  ]);
  assert.deepEqual(
    batches.map((batch) => batch.batchId),
    ["undone", "new", "old"],
  );
  assert.equal(batches[0].undone, true);
  assert.equal(batches[1].undone, false);
});

test("an empty history shows nothing at all", () => {
  assert.equal(showsCuration([]), false);
  assert.equal(showsCuration(null), false);
  assert.equal(showsCuration([row()]), true);
});

test("the title says what happened, not just a number", () => {
  assert.equal(curationTitle(0), "memory.curationSummaryNone");
  assert.equal(curationTitle(1), "memory.curationSummaryOne");
  assert.equal(curationTitle(4), "memory.curationSummary");
});

test("only MEMORY_UNDO_CONFLICT is the 'note changed after the pass' message", () => {
  assert.equal(undoConflict({ errorCode: "MEMORY_UNDO_CONFLICT" }), true);
  assert.equal(undoConflict({ data: { errorCode: "MEMORY_UNDO_CONFLICT" } }), true);
  assert.equal(undoConflict({ errorCode: "MEMORY_UNDO_ALREADY_DONE" }), false);
  assert.equal(undoConflict(new Error("pipe closed")), false);
  assert.equal(undoConflict(null), false);
});
