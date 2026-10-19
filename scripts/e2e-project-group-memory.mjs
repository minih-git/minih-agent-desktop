#!/usr/bin/env node
/**
 * E2E-PROJECT-group-pinned-memory-follows-its-folders.
 *
 * A real host binary and three real folders: the pinned memory a folder carries
 * must survive every way that folder becomes part of a project group. The group
 * is the identity a session reads its pinned memory through, so losing it here
 * means a project silently forgets what the user wrote. No model, no network.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Host, resolveHostBinary } from "./e2e/host.mjs";

const binary = resolveHostBinary();
const scratch = await realpath(await mkdtemp(join(tmpdir(), "pi-project-group-memory-")));
const first = join(scratch, "first");
const second = join(scratch, "second");
const third = join(scratch, "third");
for (const folder of [first, second, third]) await mkdir(folder);
const host = new Host(binary, join(scratch, "data"));
const summary = {};

const entry = (id, content, title = "") => ({ id, title, content });
const contents = (memory) => (memory.entries ?? []).map((item) => item.content);

try {
  await host.start();
  await host.call("project.memory.set", { path: first, content: "Remember the first root." });
  await host.call("project.memory.set", { path: second, content: "Remember the second root." });

  // (a) A new group built around saved projects keeps both folders' memory.
  const { group } = await host.call("project.group.create", {
    name: "Workspace",
    folders: [first, second],
  });
  const created = (await host.call("project.group.memory.get", { groupId: group.id })).memory;
  assert.deepEqual(contents(created), [
    "Remember the first root.",
    "Remember the second root.",
  ]);
  summary.newGroupKeepsItsProjectsMemory = "in-root-order";

  // (b) A stored group gaining a root keeps what it had, in order, and appends.
  await host.call("project.group.memory.set", {
    groupId: group.id,
    entries: [entry("group-note", "Existing group note.", "Group")],
  });
  await host.call("project.memory.set", { path: third, content: "Remember the third root." });
  await host.call("project.group.update", {
    groupId: group.id,
    name: "Workspace",
    folders: [first, second, third],
  });
  const grown = (await host.call("project.group.memory.get", { groupId: group.id })).memory;
  assert.deepEqual(contents(grown), [
    "Existing group note.",
    "Remember the third root.",
  ]);
  summary.addedRootIsAppended = "behind-the-existing-entries";

  // (c) Moving a root out and back is a reorganisation, not a new note.
  await host.call("project.group.update", {
    groupId: group.id,
    name: "Workspace",
    folders: [first, second],
  });
  await host.call("project.group.update", {
    groupId: group.id,
    name: "Workspace",
    folders: [first, second, third],
  });
  const reordered = (await host.call("project.group.memory.get", { groupId: group.id })).memory;
  assert.deepEqual(contents(reordered), [
    "Existing group note.",
    "Remember the third root.",
  ]);
  summary.movingARootOutAndBack = "does-not-duplicate";

  // (d) The path-scoped record itself is untouched, so nothing was migrated away.
  const kept = (await host.call("project.memory.get", { path: first })).memory;
  assert.equal(kept.content, "Remember the first root.");
  summary.pathScopedRecord = "left-in-place";

  // (e) A group whose roots carry no memory stays empty rather than inventing one.
  const empty = join(scratch, "empty");
  await mkdir(empty);
  const { group: bare } = await host.call("project.group.create", {
    name: "Bare",
    folders: [empty],
  });
  const bareMemory = (await host.call("project.group.memory.get", { groupId: bare.id })).memory;
  assert.deepEqual(bareMemory.entries ?? [], []);
  summary.emptyRoots = "no-group-memory";
} finally {
  await host.stop().catch(() => {});
  await rm(scratch, { recursive: true, force: true });
}

console.log("PASS E2E-PROJECT-group-pinned-memory-follows-its-folders");
console.log(JSON.stringify(summary));
