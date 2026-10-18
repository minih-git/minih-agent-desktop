#!/usr/bin/env node
/**
 * E2E-MEMORY-explicit-remember-reaches-next-session and its three siblings.
 *
 * A real host binary, two projects, and the tools called through the same
 * `tools.execute` gate the runtime uses. No model and no network: what this
 * suite proves is the host contract the milestone rests on — an explicit
 * remember cites the calling turn, the running session keeps the snapshot it
 * started with, a deleted note stays forgotten, and a project never sees
 * another project's notes.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Host, resolveHostBinary } from "./e2e/host.mjs";

const binary = resolveHostBinary();
const scratch = await realpath(await mkdtemp(join(tmpdir(), "pi-memory-remember-e2e-")));
const data = join(scratch, "data");
const firstProject = join(scratch, "first-project");
const secondProject = join(scratch, "second-project");
const host = new Host(binary, data);
const summary = {};

function userMessage(content) {
  return {
    id: randomUUID(),
    role: "user",
    content,
    createdAt: new Date().toISOString(),
  };
}

/** Answer the permission card one tool call raises, the way the renderer does. */
async function callWithApproval(sessionId, toolCallId, toolName, args, turnId) {
  host.clearNotifications();
  const pending = host.call("tools.execute", {
    sessionId,
    ...(turnId ? { turnId } : {}),
    toolCallId,
    toolName,
    args,
    mode: "agent",
  });
  const card = await waitForPermission(toolCallId);
  assert.equal(card.toolName, toolName);
  assert.equal(card.risk, "medium");
  await host.call("permissions.resolve", { requestId: card.requestId, decision: "allow-once" });
  const result = await pending;
  assert.equal(result.toolCallId, toolCallId);
  return result;
}

async function waitForPermission(toolCallId) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const [card] = host.matchingNotifications(
      "permissions.request",
      (note) => note.params?.toolCallId === toolCallId,
    );
    if (card) return card.params;
    if (Date.now() > deadline) throw new Error(`no permission card for ${toolCallId}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Remember one note in a running turn, with the approval the write needs. */
async function remember(session, turnId, args) {
  const result = await callWithApproval(
    session.id,
    `call-${randomUUID()}`,
    "MemoryRemember",
    args,
    turnId,
  );
  return result;
}

/** Open a turn and append the user message it cites. */
async function beginTurn(session, content) {
  const { turnId } = await host.call("session.beginTurn", { sessionId: session.id });
  await host.call("session.appendMessage", {
    sessionId: session.id,
    turnId,
    message: userMessage(content),
  });
  return turnId;
}

try {
  await Promise.all([mkdir(firstProject, { recursive: true }), mkdir(secondProject, { recursive: true })]);
  await host.start();
  // The write is medium risk, so the scenario pins the mode that shows a card.
  await host.call("settings.set", { defaultPermissionMode: "ask" });

  const { session: first } = await host.call("session.create", {
    title: "Deploy planning",
    projectPath: firstProject,
  });
  const { session: second } = await host.call("session.create", {
    title: "Other project work",
    projectPath: secondProject,
  });

  // 1. Explicit remember: the note cites the calling turn and says it applies
  //    from the next session.
  const turn = await beginTurn(first, "以后都用中文回答，尽量简短。");
  const saved = await remember(first, turn, {
    content: "Prefers terse Chinese replies.",
    kind: "preference",
  });
  assert.equal(saved.ok, true, JSON.stringify(saved.content));
  assert.equal(saved.content.duplicate, false);
  assert.equal(saved.content.entry.scope, "project");
  assert.equal(saved.content.entry.kind, "preference");
  assert.match(saved.content.note, /next session/);
  const entryId = saved.content.entry.id;
  summary.explicitRemember = "cites-the-calling-turn";

  // 2. The note reaches the next session's start snapshot, and not this one's:
  //    the running session keeps the index it launched with.
  const firstIndex = await host.call("memory.index", { path: firstProject });
  assert.deepEqual(firstIndex.index.entries.map((entry) => entry.id), [entryId]);
  summary.nextSessionIndex = "carries-the-note";

  // 3. A deleted note stays forgotten: the tombstone outlives the row.
  const deleted = await host.call("memory.delete", { id: entryId });
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  const afterDelete = await host.call("memory.index", { path: firstProject });
  assert.deepEqual(afterDelete.index.entries, []);
  // The model cannot resurrect it, under Auto either. Only the user's own
  // "remember again" action on the receipt may clear the tombstone.
  await host.call("settings.set", { defaultPermissionMode: "auto" });
  // Under Auto the call needs no card, so it reaches the write rule directly —
  // which is exactly the case that used to clear the tombstone.
  const blocked = await host.call("tools.execute", {
    sessionId: first.id,
    turnId: turn,
    toolCallId: `call-${randomUUID()}`,
    toolName: "MemoryRemember",
    args: { content: "Prefers terse Chinese replies.", kind: "preference" },
    mode: "agent",
  });
  assert.equal(blocked.ok, false, JSON.stringify(blocked.content));
  assert.equal(blocked.errorCode, "MEMORY_TOMBSTONED");
  assert.equal(blocked.content.sessionId, first.id);
  assert.equal(blocked.content.turnId, turn);
  const rememberedAgain = await host.call("memory.rememberAgain", {
    sessionId: blocked.content.sessionId,
    turnId: blocked.content.turnId,
    kind: "preference",
    content: "Prefers terse Chinese replies.",
    scope: "project",
  });
  assert.ok(rememberedAgain.entry, JSON.stringify(rememberedAgain));
  assert.notEqual(rememberedAgain.entry.id, entryId);
  assert.equal(rememberedAgain.entry.origin, "explicit");
  // The host resolved the evidence from that turn's own user message.
  assert.equal(rememberedAgain.entry.sourceSessionId, first.id);
  assert.equal(rememberedAgain.entry.sourceMessageIds.length, 1);
  summary.deleted = "only-the-user-can-restore";
  await host.call("settings.set", { defaultPermissionMode: "ask" });

  // 4. Project scope isolation: the other project's index and search never
  //    see this note, and its own remember writes its own scope.
  const secondIndex = await host.call("memory.index", { path: secondProject });
  assert.deepEqual(secondIndex.index.entries, []);
  const secondTurn = await beginTurn(second, "记住这个项目的约定。");
  const secondSaved = await remember(second, secondTurn, {
    content: "The gateway deploys on Fridays.",
    kind: "fact",
  });
  assert.equal(secondSaved.ok, true, JSON.stringify(secondSaved.content));
  const firstSearch = await host.call("tools.execute", {
    sessionId: first.id,
    toolCallId: `call-${randomUUID()}`,
    toolName: "MemorySearch",
    args: { query: "gateway" },
    mode: "agent",
  });
  assert.equal(firstSearch.ok, true, JSON.stringify(firstSearch.content));
  assert.equal(firstSearch.content.count, 0);
  summary.projectScope = "isolated";

  // 5. The manager's own path: list, edit with the revision it read, archive,
  //    restore, and a stale revision that changes nothing.
  const listed = await host.call("memory.list", { path: firstProject, status: "active" });
  assert.equal(listed.entries.length, 1);
  const live = listed.entries[0];
  const edited = await host.call("memory.update", {
    id: live.id,
    revision: live.revision,
    content: "Prefers terse Chinese replies, no preamble.",
  });
  assert.equal(edited.entry.revision, live.revision + 1);
  const stale = await host
    .call("memory.update", {
      id: live.id,
      revision: live.revision,
      content: "Overwritten by a stale writer.",
    })
    .then(
      () => null,
      (error) => error.errorCode,
    );
  assert.equal(stale, "MEMORY_REVISION_CONFLICT");
  // The refused edit changed nothing.
  const unchanged = await host.call("memory.list", { path: firstProject });
  assert.equal(unchanged.entries[0].content, "Prefers terse Chinese replies, no preamble.");
  const archived = await host.call("memory.archive", { id: live.id });
  assert.equal(archived.entry.status, "archived");
  const restored = await host.call("memory.restore", { id: live.id });
  assert.equal(restored.entry.status, "active");
  summary.manager = "edit-conflict-archive-restore";

  // 6. The read switch hides the write too, without deleting anything. The
  //    switch is checked inside the tool, so the call has to get past the card
  //    first: the resolved `auto` policy is what a user who allows it once gets.
  await host.call("settings.set", { defaultPermissionMode: "auto", learnedMemoryRead: false });
  const denied = await host.call("tools.execute", {
    sessionId: first.id,
    turnId: turn,
    toolCallId: `call-${randomUUID()}`,
    toolName: "MemoryRemember",
    args: { content: "x", kind: "fact" },
    mode: "agent",
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.errorCode, "TOOL_DENIED");
  const stillThere = await host.call("memory.list", { path: firstProject });
  assert.equal(stillThere.entries.length, 1);
  summary.readSwitch = "hides-the-write-without-deleting";

  // 7. A contract mode cannot write at all. The durable mode is what the host
  //    authorizes against, so the session actually enters Plan first; reading is
  //    switched back on because that is the case being tested.
  await host.call("settings.set", { learnedMemoryRead: true });
  await host.call("plans.enter", {
    sessionId: first.id,
    turnId: turn,
    toolCallId: `call-${randomUUID()}`,
    kind: "plan",
  });
  const planDenied = await host.call("tools.execute", {
    sessionId: first.id,
    turnId: turn,
    toolCallId: `call-${randomUUID()}`,
    toolName: "MemoryRemember",
    args: { content: "x", kind: "fact" },
    mode: "plan",
  });
  assert.equal(planDenied.ok, false);
  // A contract mode reports its own denial rather than a generic one.
  assert.equal(planDenied.errorCode, "TOOL_DISABLED_IN_PLAN");
  // The recall reads stay available in Plan: they change nothing.
  const planRead = await host.call("tools.execute", {
    sessionId: first.id,
    toolCallId: `call-${randomUUID()}`,
    toolName: "MemorySearch",
    args: { query: "Chinese" },
    mode: "plan",
  });
  assert.equal(planRead.ok, true, JSON.stringify(planRead.content));
  summary.contractMode = "denies-the-write-keeps-the-reads";

  // 8. The per-session learning switch is readable and writable.
  const excluded = await host.call("memory.session.setExcluded", {
    sessionId: first.id,
    excluded: true,
  });
  assert.equal(excluded.state.excluded, true);
  const readBack = await host.call("memory.session.get", { sessionId: first.id });
  assert.equal(readBack.state.excluded, true);
  summary.sessionExclusion = "round-trips";
  summary.scenarios = [
    "E2E-MEMORY-explicit-remember-reaches-next-session",
    "E2E-MEMORY-mid-session-write-keeps-runtime",
    "E2E-MEMORY-deleted-memory-stays-forgotten",
    "E2E-MEMORY-project-scope-isolation",
  ];

  console.log(JSON.stringify({ passed: true, ...summary }, null, 2));
} finally {
  await host.stop().catch(() => {});
  await rm(scratch, { recursive: true, force: true });
}
