import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { listPluginMemoryWhenEnabled, normalizePluginMemoryListInput } = await import(
  "../electron/main/plugin-memory-read.ts"
);

test("plugin memory input normalization applies defaults and enforces project paths and bounds", () => {
  const projectPath = resolve("project");
  assert.deepEqual(normalizePluginMemoryListInput({ scope: "project", path: projectPath, kind: "fact" }), {
    scope: "project",
    path: projectPath,
    kind: "fact",
    limit: 50,
    offset: 0,
  });
  assert.deepEqual(normalizePluginMemoryListInput({ scope: "user" }), {
    scope: "user",
    limit: 50,
    offset: 0,
  });

  for (const input of [
    undefined,
    [],
    {},
    { scope: "workspace" },
    { scope: "project" },
    { scope: "project", path: "relative/path" },
    { scope: "user", path: "relative/path" },
    { scope: "user", kind: "unknown" },
    { scope: "user", limit: 0 },
    { scope: "user", limit: 201 },
    { scope: "user", offset: -1 },
    { scope: "user", offset: 1.5 },
    { scope: "user", offset: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => normalizePluginMemoryListInput(input), { code: "INVALID_PARAMS" });
  }
});

test("the disabled read switch returns an empty page without calling the memory service", async () => {
  let memoryRpcCalled = false;
  const result = await listPluginMemoryWhenEnabled(
    async () => false,
    async () => {
      memoryRpcCalled = true;
      return { entries: [{ id: "unexpected" }] };
    },
  );
  assert.deepEqual(result, { readEnabled: false, entries: [], nextOffset: null });
  assert.equal(memoryRpcCalled, false);
});

test("an enabled read switch delegates the listing unchanged", async () => {
  const page = { readEnabled: true, entries: [], nextOffset: null };
  let memoryRpcCalled = false;
  const result = await listPluginMemoryWhenEnabled(
    async () => true,
    async () => {
      memoryRpcCalled = true;
      return page;
    },
  );
  assert.equal(result, page);
  assert.equal(memoryRpcCalled, true);
});
