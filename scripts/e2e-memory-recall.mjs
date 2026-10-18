#!/usr/bin/env node
/**
 * E2E-MEMORY-history-search-finds-prior-session.
 *
 * A real host binary, two projects, and the two recall tools called through the
 * `tools.execute` gate the runtime uses. No model, no network: the tools are
 * host-side reads, so what this suite proves is the host contract — scope,
 * result shape, the read switch, and the bounded session-start index.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Host, resolveHostBinary } from "./e2e/host.mjs";

const binary = resolveHostBinary();
const scratch = await realpath(await mkdtemp(join(tmpdir(), "pi-memory-recall-e2e-")));
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

/** Call one recall tool exactly as the runtime does. */
async function recall(sessionId, toolName, args, toolCallId = `call-${randomUUID()}`) {
  const result = await host.call("tools.execute", {
    sessionId,
    toolCallId,
    toolName,
    args,
    mode: "agent",
  });
  assert.equal(result.toolCallId, toolCallId);
  return result;
}

/** Wait for the permission card the host emits for one tool call. */
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

/**
 * Call a recall tool that needs the user's approval. Reading every project is
 * medium risk, so the host emits a card and waits: the scenario answers it the
 * way the renderer does, and asserts what the card said.
 */
async function recallWithApproval(sessionId, toolName, args) {
  host.clearNotifications();
  const toolCallId = `call-${randomUUID()}`;
  const pending = host.call("tools.execute", {
    sessionId,
    toolCallId,
    toolName,
    args,
    mode: "agent",
  });
  const card = await waitForPermission(toolCallId);
  assert.equal(card.toolName, toolName);
  assert.equal(card.risk, "medium");
  assert.equal(card.reason, "Reads conversations from every project");
  await host.call("permissions.resolve", { requestId: card.requestId, decision: "allow-once" });
  const result = await pending;
  assert.equal(result.toolCallId, toolCallId);
  assert.equal(result.ok, true, JSON.stringify(result.content));
  return result;
}

async function expectToolFailure(promise, errorCode) {
  const result = await promise;
  assert.equal(result.ok, false, `expected ${errorCode}, got ${JSON.stringify(result.content)}`);
  assert.equal(result.errorCode, errorCode);
  return result.content;
}

try {
  await Promise.all([mkdir(firstProject, { recursive: true }), mkdir(secondProject, { recursive: true })]);
  await host.start();
  // The scope=all read takes the normal approval path, so the scenario pins the
  // permission mode that shows a card instead of inheriting the machine's.
  await host.call("settings.set", { defaultPermissionMode: "ask" });

  const { session: prior } = await host.call("session.create", {
    title: "Deploy planning",
    projectPath: firstProject,
  });
  const { session: later } = await host.call("session.create", {
    title: "Follow-up",
    projectPath: firstProject,
  });
  const { session: elsewhere } = await host.call("session.create", {
    title: "Other project work",
    projectPath: secondProject,
  });
  // A real append: the index row the search reads.
  await host.call("session.appendMessage", {
    sessionId: prior.id,
    message: userMessage("We decided the gateway deploys on Friday, after the migration."),
  });
  await host.call("session.appendMessage", {
    sessionId: elsewhere.id,
    message: userMessage("We decided the gateway deploys on Friday, in the other project."),
  });

  // 1. The scenario: a later session finds what an earlier one decided.
  const found = await recall(later.id, "SessionHistorySearch", { query: "deploys on Friday" });
  assert.equal(found.ok, true, JSON.stringify(found.content));
  assert.equal(found.content.scope, "project");
  assert.equal(found.content.count, 1);
  assert.equal(found.content.results[0].sessionId, prior.id);
  assert.equal(found.content.results[0].title, "Deploy planning");
  assert.match(found.content.results[0].snippets[0].text, /deploys on Friday/);
  assert.match(found.content.note, /not instructions/);
  summary.scenario = "E2E-MEMORY-history-search-finds-prior-session";

  // 2. Another project stays out of reach until the caller asks for it — and
  //    asking is a medium-risk call the user approves first.
  const widened = await recallWithApproval(later.id, "SessionHistorySearch", {
    query: "deploys on Friday",
    scope: "all",
  });
  assert.equal(widened.content.scope, "all");
  assert.deepEqual(
    widened.content.results.map((row) => row.sessionId).sort(),
    [elsewhere.id, prior.id].sort(),
  );
  const crafted = await recall(later.id, "SessionHistorySearch", {
    query: "deploys on Friday",
    path: secondProject,
    projectPath: secondProject,
    sessionId: elsewhere.id,
  });
  assert.deepEqual(crafted.content.results.map((row) => row.sessionId), [prior.id]);
  summary.scope = "project-only";
  summary.scopeApproval = "card-then-allow";

  // 3. Learned memory: the project scope plus the user scope, and a read
  //    records that it was used.
  const created = await host.call("memory.create", {
    path: firstProject,
    kind: "fact",
    content: "The gateway deploys on Fridays.",
    origin: "user_ui",
  });
  assert.ok(created.entry?.id, JSON.stringify(created));
  const remembered = await recall(later.id, "MemorySearch", { query: "gateway" });
  assert.equal(remembered.ok, true, JSON.stringify(remembered.content));
  assert.equal(remembered.content.count, 1);
  assert.equal(remembered.content.results[0].id, created.entry.id);
  assert.equal(remembered.content.results[0].scope, "project");
  assert.equal(remembered.content.results[0].kind, "fact");
  const index = await host.call("memory.index", { path: firstProject });
  assert.deepEqual(index.index.entries.map((entry) => entry.id), [created.entry.id]);
  const used = await host.call("memory.list", { path: firstProject });
  assert.equal(used.entries[0].useCount, 1);
  assert.ok(used.entries[0].lastUsedAt > 0);
  summary.memorySearch = "scoped-and-counted";

  // 4. The portable read switch hides both tools without deleting anything.
  await host.call("settings.set", { learnedMemoryRead: false });
  await expectToolFailure(
    recall(later.id, "SessionHistorySearch", { query: "deploys on Friday" }),
    "TOOL_DENIED",
  );
  await expectToolFailure(
    recall(later.id, "MemorySearch", { query: "gateway" }),
    "TOOL_DENIED",
  );
  const stillThere = await host.call("memory.list", { path: firstProject });
  assert.equal(stillThere.entries.length, 1);
  await host.call("settings.set", { learnedMemoryRead: true });
  const back = await recall(later.id, "SessionHistorySearch", { query: "deploys on Friday" });
  assert.equal(back.content.count, 1);
  summary.readSwitch = "hides-without-deleting";

  // 5. A malformed call fails closed without reaching the search.
  const missing = await expectToolFailure(
    recall(later.id, "SessionHistorySearch", { query: "  " }),
    "INVALID_ARGUMENT",
  );
  assert.match(missing.error, /query required/);

  console.log(JSON.stringify({ passed: true, ...summary }, null, 2));
} finally {
  await host.stop().catch(() => {});
  await rm(scratch, { recursive: true, force: true });
}
