import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../src/features/settings/config-sync-conflicts.ts", import.meta.url),
  "utf8",
);
const card = await readFile(
  new URL("../src/components/settings/ConfigSyncApprovals.tsx", import.meta.url),
  "utf8",
);
const require = createRequire(
  new URL("../../../packages/agent-runtime/package.json", import.meta.url),
);
const { transform } = require("esbuild");
const compiled = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
const { groupConfigSyncApprovals } = await import(
  `data:text/javascript,${encodeURIComponent(compiled.code)}`
);

const approval = (id, extra = {}) => ({
  id,
  domain: "application",
  entityId: `${id}:local`,
  label: "App preferences",
  reason: "conflict",
  digest: `digest-${id}`,
  createdAt: "2026-01-02T00:00:00Z",
  ...extra,
});

test("both sides of one conflict become a single decision", () => {
  const local = approval("app", { conflict: { baseId: "app", side: "local" } });
  const remote = approval("app", { conflict: { baseId: "app", side: "remote" } });
  const groups = groupConfigSyncApprovals([local, remote]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "conflict");
  assert.equal(groups[0].baseId, "app");
  assert.equal(groups[0].label, "App preferences");
  assert.equal(groups[0].local, local);
  assert.equal(groups[0].remote, remote);
});

test("conflict order follows the first side that appeared", () => {
  const remote = approval("remote-first", { conflict: { baseId: "one", side: "remote" } });
  const local = approval("local-first", { conflict: { baseId: "one", side: "local" } });
  const other = approval("plain", { reason: "newDevice", conflict: undefined });
  const groups = groupConfigSyncApprovals([remote, other, local]);
  assert.deepEqual(
    groups.map((group) => group.key),
    ["conflict:application:one", "approval:plain"],
  );
  assert.equal(groups[0].kind === "conflict" && groups[0].local, local);
});

test("different domains and plain approvals never merge", () => {
  const application = approval("app", { conflict: { baseId: "same", side: "local" } });
  const providers = approval("provider", {
    domain: "providers",
    conflict: { baseId: "same", side: "remote" },
  });
  const plain = approval("skill", { reason: "dependency", conflict: undefined });
  const groups = groupConfigSyncApprovals([application, providers, plain]);
  assert.deepEqual(
    groups.map((group) => group.key),
    ["conflict:application:same", "conflict:providers:same", "approval:skill"],
  );
  assert.equal(groups[2].kind === "single" && groups[2].approval, plain);
});

test("a mapping needed by either side stays on the conflict", () => {
  const local = approval("skill", {
    conflict: { baseId: "skill", side: "local" },
    mappingKey: "project-one",
  });
  const remote = approval("skill", { conflict: { baseId: "skill", side: "remote" } });
  const groups = groupConfigSyncApprovals([remote, local]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].mappingKey, "project-one");
});

test("the conflict card offers one button per side instead of approve and reject", () => {
  assert.match(card, /settings\.configSync\.conflictAcceptLocal/);
  assert.match(card, /settings\.configSync\.conflictAcceptRemote/);
  assert.match(card, /groupConfigSyncApprovals\(approvals\)/);
  assert.match(card, /data-config-sync-conflict=\{group\.baseId\}/);
  assert.match(card, /onApprove\(local\.id, local\.digest\)/);
  assert.match(card, /onApprove\(remote\.id, remote\.digest\)/);
});
