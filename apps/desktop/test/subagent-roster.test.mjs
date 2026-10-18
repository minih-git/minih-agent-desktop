import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  buildSessionSubagentRoster,
  groupSessionSubagentRoster,
  mergeDelegationRows,
  sessionSubagentSummary,
} = await import("../src/lib/subagent-roster.ts");

function message(id, extra = {}) {
  return { id, role: "tool", content: "", createdAt: "2026-10-18T00:00:00.000Z", ...extra };
}

function taskCall(id, delegation, task, extra = {}) {
  return message(id, {
    toolName: "Task",
    toolCallId: id,
    toolArgs: { agent: "explorer", task },
    toolResult: { details: { delegationId: delegation, status: "running", ...extra } },
  });
}

test("one Task call becomes one roster entry with its brief and agent", () => {
  const roster = buildSessionSubagentRoster([
    taskCall("call-1", "del-1", "Find the auth entry points"),
  ]);
  assert.equal(roster.length, 1);
  assert.equal(roster[0].delegationId, "del-1");
  assert.equal(roster[0].agentName, "explorer");
  assert.equal(roster[0].title, "Find the auth entry points");
  assert.equal(roster[0].status, "running");
  assert.equal(roster[0].running, true);
});

test("same-name delegates stay separate and are keyed by delegation id", () => {
  const roster = buildSessionSubagentRoster([
    taskCall("call-1", "del-1", "First task", { startedAt: 1_000 }),
    taskCall("call-2", "del-2", "Second task", { startedAt: 2_000 }),
  ]);
  assert.deepEqual(
    roster.map((entry) => entry.delegationId),
    ["del-2", "del-1"],
  );
  assert.deepEqual(
    roster.map((entry) => entry.agentName),
    ["explorer", "explorer"],
  );
});

test("a lifecycle row settles the delegate it names", () => {
  const roster = buildSessionSubagentRoster([
    taskCall("call-1", "del-1", "Run the suite"),
    message("wait-1", {
      toolName: "TaskWait",
      toolCallId: "wait-1",
      toolResult: {
        details: {
          delegations: [
            { delegationId: "del-1", agent: "test-runner", status: "completed" },
          ],
        },
      },
    }),
  ]);
  assert.equal(roster[0].status, "completed");
  assert.equal(roster[0].running, false);
  // Only the delegate is a roster row; the lifecycle tool is not.
  assert.equal(roster.length, 1);
});

test("a finished turn does not leave a stale running delegate", () => {
  const roster = buildSessionSubagentRoster(
    [taskCall("call-1", "del-1", "Long task")],
    { turnLive: false },
  );
  assert.equal(roster[0].status, "aborted");
  assert.equal(roster[0].running, false);
});

test("a rejected Task never becomes a roster row", () => {
  const roster = buildSessionSubagentRoster([
    message("call-1", {
      toolName: "Task",
      toolCallId: "call-1",
      toolArgs: { agent: "missing", task: "nope" },
      toolResult: { details: { status: "error" } },
    }),
  ]);
  assert.deepEqual(roster, []);
});

test("a resume call keeps the chain's first brief and does not duplicate it", () => {
  const roster = buildSessionSubagentRoster([
    taskCall("call-1", "del-1", "First brief"),
    message("call-2", {
      toolName: "Task",
      toolCallId: "call-2",
      toolArgs: { agent: "explorer", task: "Follow up", resume: "del-1" },
      toolResult: { details: { delegationId: "del-1", status: "completed" } },
    }),
  ]);
  assert.equal(roster.length, 1);
  assert.equal(roster[0].title, "First brief");
});

test("a delegate whose start row is gone still appears from its own rows", () => {
  const roster = buildSessionSubagentRoster([
    message("step-1", {
      toolName: "Read",
      parentToolCallId: "call-1",
      agentName: "explorer",
    }),
  ]);
  assert.equal(roster.length, 1);
  assert.equal(roster[0].delegationId, "call-1");
  assert.equal(roster[0].agentName, "explorer");
});

test("a lifecycle roster entry survives without the delegate's own rows", () => {
  const roster = buildSessionSubagentRoster([
    message("list-1", {
      toolName: "TaskList",
      toolCallId: "list-1",
      toolResult: {
        details: {
          delegations: [
            {
              delegationId: "del-gone",
              agent: "code-reviewer",
              status: "failed",
              startedAt: 1_000,
              completedAt: 3_000,
            },
          ],
        },
      },
    }),
  ]);
  assert.equal(roster[0].delegationId, "del-gone");
  assert.equal(roster[0].agentName, "code-reviewer");
  assert.equal(roster[0].status, "failed");
  assert.equal(roster[0].durationMs, 2_000);
});

test("the host's older rows and the live rows merge without duplicating a row", () => {
  const hostRows = [taskCall("call-1", "del-1", "From disk")];
  const liveRows = [
    taskCall("call-1", "del-1", "From disk", { status: "completed" }),
    taskCall("call-2", "del-2", "Only in memory"),
  ];
  const merged = mergeDelegationRows(hostRows, liveRows);
  assert.equal(merged.length, 2);
  const roster = buildSessionSubagentRoster(merged);
  assert.equal(roster.length, 2);
  const first = roster.find((entry) => entry.delegationId === "del-1");
  assert.equal(first.status, "completed");
});

test("running entries lead, then settled entries, both newest first", () => {
  const roster = buildSessionSubagentRoster([
    taskCall("call-old", "del-old", "Old", { status: "completed", startedAt: 1_000 }),
    taskCall("call-new", "del-new", "New", { startedAt: 3_000 }),
    taskCall("call-mid", "del-mid", "Mid", { status: "completed", startedAt: 2_000 }),
  ]);
  const groups = groupSessionSubagentRoster(roster);
  assert.deepEqual(
    groups.running.map((entry) => entry.delegationId),
    ["del-new"],
  );
  assert.deepEqual(
    groups.settled.map((entry) => entry.delegationId),
    ["del-mid", "del-old"],
  );
  assert.deepEqual(sessionSubagentSummary(roster), { total: 3, running: 1 });
});

test("the roster title falls back to the agent when the brief is empty", () => {
  const roster = buildSessionSubagentRoster([
    message("call-1", {
      toolName: "Task",
      toolCallId: "call-1",
      toolArgs: { agent: "planner", task: "" },
      toolResult: { details: { delegationId: "del-1", status: "running" } },
    }),
  ]);
  assert.equal(roster[0].title, "planner");
});

test("a multi-line brief keeps only its first line", () => {
  const roster = buildSessionSubagentRoster([
    taskCall("call-1", "del-1", "First line\nSecond line"),
  ]);
  assert.equal(roster[0].title, "First line");
});
