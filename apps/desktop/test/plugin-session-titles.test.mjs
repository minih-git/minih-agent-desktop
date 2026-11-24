import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createPluginTitleService } = await import("../electron/main/plugin-session-titles.ts");
const { checkpointSummaryFingerprint } = await import("@minih-agent/shared");

test("legacy context is unchanged; opt-in naming material reads only the owning session paste", async t => {
  const dataDir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "title-context-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const pasted = join(dataDir, "scratch/s1/pasted"); await mkdir(pasted, { recursive: true });
  const file = join(pasted, "notes.txt"); await writeFile(file, "命名材料".repeat(1000));
  const outside = join(dataDir, "other.txt"); await writeFile(outside, "OUTSIDE_CONTENT");
  const original = { sessionId: "s1", expectedTitle: "New task", userPrompt: `@${file} @${outside} Summarize`, modelKey: "p/m" };
  const service = createPluginTitleService({ getHost: () => null, dataDir, callSession: async () => original });
  assert.deepEqual(await service.getAutoTitleContext("plugin", { sessionId: "s1" }), original);
  const context = await service.getAutoTitleContext("plugin", { sessionId: "s1", includeMaterial: true });
  assert.equal(context.userPrompt, "Summarize");
  assert.ok(Array.from(context.pastedMaterial).length <= 3000);
  assert.match(context.pastedMaterial, /命名材料/); assert.doesNotMatch(context.pastedMaterial, /OUTSIDE_CONTENT/);
  assert.ok(context.referencedFiles.includes("other.txt"));
});

test("compaction context is bounded, excludes transcripts and rechecks staleness before writing", async () => {
  let summary = "摘要".repeat(2000), expectedTitle = "Generated title", reads = 0;
  const writes = [];
  const host = { async call(method) {
    if (method === "session.retitleContext") return expectedTitle ? { expectedTitle, modelKey: "p/m" } : null;
    if (method === "session.get") { reads++; return { session: { compaction: { summary }, messages: [{ text: "PRIVATE_TRANSCRIPT" }] } }; }
    throw new Error(method);
  } };
  const service = createPluginTitleService({ getHost: () => host, dataDir: "/unused", callSession: async (...args) => { writes.push(args); return { updated: true }; } });
  const fingerprint = checkpointSummaryFingerprint(summary);
  const input = { sessionId: "s1", summaryFingerprint: fingerprint };
  const context = await service.getAutoTitleContext("plugin", input);
  assert.equal(Array.from(context.summary).length, 1500); assert.equal(context.messages, undefined);
  summary = "New checkpoint";
  assert.deepEqual(await service.setAutoTitle("plugin", { ...input, expectedTitle, title: "Stale" }), { updated: false });
  assert.equal(writes.length, 0);
  expectedTitle = null;
  const before = reads;
  assert.equal(await service.getAutoTitleContext("plugin", { ...input, summaryFingerprint: checkpointSummaryFingerprint(summary) }), null);
  assert.equal(reads, before, "manual title must stop before summary access");
});

test("first-title writes and compaction refreshes retain their distinct CAS paths", async () => {
  const calls = [], summary = "Current topic";
  const host = { async call(method) {
    if (method === "session.retitleContext") return { expectedTitle: "Old" };
    if (method === "session.get") return { session: { compaction: { summary } } };
    throw new Error(method);
  } };
  const service = createPluginTitleService({ getHost: () => host, dataDir: "/unused", callSession: async (...args) => { calls.push(args); return { updated: true }; } });
  await service.setAutoTitle("plugin", { sessionId: "s1", expectedTitle: "Old", title: "New" });
  await service.setAutoTitle("plugin", { sessionId: "s1", expectedTitle: "Old", title: "New", summaryFingerprint: checkpointSummaryFingerprint(summary) });
  assert.equal(calls[0][0], "plugin.session.setAutoTitle"); assert.equal(calls[1][0], "session.retitleFromCompaction");
  assert.equal(calls[1][2].id, "s1");
});
