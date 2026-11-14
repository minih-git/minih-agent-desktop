import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot } from "../../../scripts/e2e/boot.mjs";

/*
 * The anchors two behaviours depend on, asserted where they live (employee mode
 * 0.5 slice 4a).
 *
 * Two of this slice's rules are invisible to a renderer test and too small to
 * prove by driving a whole turn:
 *
 * - **The task session's rules ride with the turn, and never into the transcript.**
 *   A task has no employee definition, so this block is the only thing that tells
 *   it to ask one structured question and to report being stuck instead of
 *   ending with a paragraph of prose. If it ever became a persisted message, every
 *   turn after it would carry a stale copy of the rules and a compaction would
 *   summarize them as history.
 * - **The steward relays, she does not answer.** The one thing she must never do
 *   is answer a question the person was asked.
 *
 * These are source anchors rather than interaction tests on purpose: the thing
 * that can regress is the *text* and *where it is attached*, and both are visible
 * exactly there.
 */

const root = repositoryRoot();

async function read(relative) {
  return readFile(join(root, relative), "utf8");
}

test("a task session is told how to ask, how to report being stuck, and how to finish", async () => {
  const source = await read("apps/desktop/electron/main/services/task-status.ts");
  const start = source.indexOf("export const TASK_SESSION_BRIEFING");
  assert.ok(start > 0, "the task-session briefing is gone");
  const block = source.slice(start, source.indexOf("].join(", start));
  // One specific question with concrete options, never prose.
  assert.match(block, /AskTool/);
  assert.match(block, /2–4 concrete options/);
  assert.match(block, /Never end a turn with a question in prose/);
  // The structured exit, with the exact argument names the host validates.
  assert.match(block, /TaskReport/);
  assert.match(block, /status: "blocked", where, tried, suggestion/);
  // Permission goes through the tool call, not through prose.
  assert.match(block, /let the host ask/);
  // It is a per-turn block, so it has to stay small.
  assert.ok(block.length < 1400, `the briefing grew to ${block.length} characters`);
});

test("the rules are attached as this turn's briefing and never appended to the transcript", async () => {
  const source = await read("apps/desktop/electron/main/ipc/agent-ipc.ts");
  // The last occurrence: an earlier one reconciles the stage after beginTurn.
  const at = source.lastIndexOf('session.role === "task"');
  assert.ok(at > 0, "a task session no longer gets its own rules");
  const near = source.slice(at, at + 300);
  // Slice 6 moved the text behind one builder, which now returns the rules plus
  // whatever team norms the person wrote.
  assert.match(near, /buildTaskSessionBriefing/);
  assert.match(source, /const turnBriefing = isSteward/);
  // A persisted copy would be the bug: neither the rules nor the norms may go
  // through the transcript path.
  const appendedRules = source.match(/appendMessage[\s\S]{0,200}TASK_SESSION_BRIEFING/);
  assert.equal(appendedRules, null, "the rules are being written to the transcript");
  const appendedNorms = source.match(/appendMessage[\s\S]{0,200}teamNormsBriefing/);
  assert.equal(appendedNorms, null, "the norms are being written to the transcript");
  // Both ride in the per-turn field only, which the sidecar injects into this
  // request and nothing else reads.
  assert.match(source, /\.\.\.\(turnBriefing \? \{ turnBriefing \} : \{\}\)/);
});

test("the steward is told to relay a question and never to answer it", async () => {
  const source = await read("apps/desktop/electron/main/services/task-status.ts");
  const at = source.indexOf("export function stewardBriefing");
  const block = source.slice(at, at + 4000);
  assert.match(block, /never answer it yourself/);
  assert.match(block, /quote it exactly/);
});

test("TaskReport is declared only for a task session's Agent turn", async () => {
  const runtime = await read("packages/agent-runtime/src/runtime.ts");
  assert.match(runtime, /if \(declaresTaskReport\(this\.mode, this\.taskReporter\)\)/);
  // The schema the model sees, next to the declaration that uses it: two
  // statuses in one object, because a top-level union is refused by some
  // providers, and the host — not the schema — enforces which fields each
  // status needs.
  assert.match(
    runtime,
    /TaskReport: \{\n\s+status: Type\.Union\(\[Type\.Literal\("blocked"\), Type\.Literal\("ready"\)\]\)/,
  );
  assert.match(runtime, /acceptance: Type\.Optional\(/);
  assert.match(runtime, /where: Type\.Optional\(/);
  // And the host is the one that refills the session id.
  const tool = await read("crates/host-core/src/rpc/task_tools.rs");
  assert.match(tool, /map\.insert\("sessionId"\.into\(\), json!\(p\.session_id\)\)/);
});

test("a task's stage is written from its own turns, not only from a delivery", async () => {
  const sessions = await read("crates/host-core/src/sessions.rs");
  // Both writes are logged, never raised: a settled turn must not report a
  // failed RPC because a display column could not be updated.
  assert.match(sessions, /if let Err\(error\) = crate::tasks::turn_began\(db, db\.conn\(\), session_id\)/);
  assert.match(
    sessions,
    /if let Err\(error\) = crate::tasks::turn_ended\(db, db\.conn\(\), session_id, status, error_code\)/,
  );
  // One writer: every stage path goes through it. It lives beside `tasks.rs`
  // rather than inside it, because the module budget is 1000 lines and the task
  // row's own CRUD took it close.
  const stage = await read("crates/host-core/src/task_stage.rs");
  assert.match(stage, /fn move_stage\(/);
  assert.match(stage, /stage_seq=\?3/);
  assert.match(stage, /pub fn turn_ended\(/);
});