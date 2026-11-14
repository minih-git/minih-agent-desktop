import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { catalogs } from "@minih-agent/i18n";
import { createServer } from "vite";

/*
 * The line that says which step a chained card continues (employee mode 0.5
 * slice 7).
 *
 * It quotes the *previous card's goal*, not its draft id: the id is a handle the
 * app made up, so 「接在 #7d1c9f2a 之后」 tells the person nothing about which
 * step they are looking at, while 「接在「加上 active 列」之后」 does. A goal
 * longer than the dock's limit is cut, and a previous card that is no longer in
 * the list falls back to the short id rather than to an empty quote.
 */

async function load(t) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(async () => server.close());
  return server.ssrLoadModule("/src/features/bots/task-relay.ts");
}

/** The English catalog, read the way i18next would read it. */
const translate = (key, options = {}) => {
  const value = key
    .split(".")
    .reduce((node, part) => (node == null ? node : node[part]), catalogs.en);
  assert.equal(typeof value, "string", `missing catalogs.en key ${key}`);
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ""));
};

const PREVIOUS = "7d1c9f2a-4b6e-4d1f-9a02-0b8f3c5e7a11";
const NEXT = "b2e4a8c6-1f3d-4a97-8c55-6d0e2b9f4c33";

const card = (id, goal, afterDraftId) => ({
  id,
  sessionId: "steward",
  status: "proposed",
  card: { goal },
  afterDraftId,
});

test("the line quotes the previous card's goal, not its id", async (t) => {
  const { followsLine } = await load(t);
  const previous = card(PREVIOUS, "加上 active 列");
  const next = card(NEXT, "回填并切换读路径", PREVIOUS);
  assert.deepEqual(followsLine(next, [previous, next], translate), {
    shortId: "7d1c9f",
    title: "加上 active 列",
    text: "Follows “加上 active 列”",
  });
});

test("a goal longer than the dock's limit is cut with an ellipsis", async (t) => {
  const { followsLine, FOLLOWS_TITLE_CHARS } = await load(t);
  const goal = "把 active 列加上并回填，再切换所有读路径，最后删掉旧的读路径";
  const previous = card(PREVIOUS, goal);
  const next = card(NEXT, "回填并切换读路径", PREVIOUS);
  const line = followsLine(next, [previous, next], translate);
  assert.equal(line.title, goal, "the raw title is kept for the caller");
  const quoted = line.text.slice("Follows “".length, -"”".length);
  assert.equal(quoted.length, FOLLOWS_TITLE_CHARS);
  assert.ok(quoted.endsWith("…"), `not cut with an ellipsis: ${quoted}`);
  assert.ok(goal.startsWith(quoted.slice(0, -1)), "the cut does not start at the goal");
});

test("a previous card that is gone falls back to the short id", async (t) => {
  const { followsLine } = await load(t);
  const next = card(NEXT, "回填并切换读路径", PREVIOUS);
  assert.deepEqual(followsLine(next, [next], translate), {
    shortId: "7d1c9f",
    title: null,
    text: "Follows #7d1c9f",
  });
});

test("a card that starts a chain says nothing about following", async (t) => {
  const { followsLine } = await load(t);
  const first = card(NEXT, "加上 active 列");
  assert.equal(followsLine(first, [first], translate), null);
});