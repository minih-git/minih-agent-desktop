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
  const at = source.indexOf('session.role === "task"');
  assert.ok(at > 0, "a task session no longer gets its own rules");
  const near = source.slice(at, at + 260);
  assert.match(near, /TASK_SESSION_BRIEFING/);
  assert.match(source, /const turnBriefing = isSteward/);
  // A persisted copy would be the bug: the block must not be sent through the
  // transcript path.
  const appended = source.match(/appendMessage[\s\S]{0,200}TASK_SESSION_BRIEFING/);
  assert.equal(appended, null, "the rules are being written to the transcript");
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
  // The schema the model sees, next to the declaration that uses it.
  assert.match(runtime, /TaskReport: \{\n\s+status: Type\.Literal\("blocked"\)/);
  // And the host is the one that refills the session id.
  const tool = await read("crates/host-core/src/rpc/task_tools.rs");
  assert.match(tool, /map\.insert\("sessionId"\.into\(\), json!\(p\.session_id\)\)/);
});

test("a task's stage is written from its own turns, not only from a delivery", async () => {
  const sessions = await read("crates/host-core/src/sessions.rs");
  assert.match(sessions, /crate::tasks::turn_began\(db, db\.conn\(\), session_id\)\?/);
  assert.match(sessions, /crate::tasks::turn_ended\(db, db\.conn\(\), session_id, status, error_code\)\?/);
  const tasks = await read("crates/host-core/src/tasks.rs");
  // One writer: every stage path goes through it.
  assert.match(tasks, /fn move_stage\(/);
  assert.match(tasks, /stage_seq=\?3/);
});