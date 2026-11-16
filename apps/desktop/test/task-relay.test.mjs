import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { catalogs } from "@minih-agent/i18n";
import { createServer } from "vite";

/*
 * The relay copy: what a chained step's card says (employee mode 0.5 slice 7).
 *
 * 1.7.0 removed the task card dock, and with it the "Follows …" line that
 * quoted the previous card's goal. What remains is the chain itself: a batch
 * row that labels steps in order, and a blocked step that names the predecessor
 * it cannot continue from. Both are copy, so they are asserted as text.
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

const task = (patch) => ({
  id: patch.id,
  employeeSessionId: patch.employeeSessionId ?? "router-backend",
  sessionId: `session-${patch.id}`,
  title: patch.title ?? "Billing",
  origin: "direct",
  stage: patch.stage ?? "working",
  shortId: patch.shortId ?? patch.id.slice(0, 6),
  createdAt: "2026-11-11T00:00:00.000Z",
  ...patch,
});

test("a blocked step names the predecessor it cannot continue from", async (t) => {
  const { relayBlockerText } = await load(t);
  assert.equal(
    relayBlockerText({ reason: "relay-orphaned", parent: "7d1c9f" }, translate),
    "The step before this one (#7d1c9f) was abandoned",
  );
  assert.equal(
    relayBlockerText({ reason: "relay-base", parent: "7d1c9f" }, translate),
    "The branch of step #7d1c9f is gone",
  );
  // Any other blocker is not a relay one, so the relay card says nothing.
  assert.equal(relayBlockerText({ reason: "workspace" }, translate), null);
  assert.equal(relayBlockerText(null, translate), null);
});

test("only a lost predecessor counts as a relay block", async (t) => {
  const { isRelayBlocked } = await load(t);
  assert.equal(isRelayBlocked({ reason: "relay-orphaned" }), true);
  assert.equal(isRelayBlocked({ reason: "relay-base" }), true);
  assert.equal(isRelayBlocked({ reason: "workspace" }), false);
  assert.equal(isRelayBlocked(undefined), false);
});

test("a chain is one row, labelled in step order", async (t) => {
  const { chainLines, rowLabel, batchRows } = await load(t);
  const first = task({ id: "a1111111", shortId: "a11111", relayStep: 1, relayTotal: 3 });
  const second = task({ id: "b2222222", shortId: "b22222", relayStep: 2, relayTotal: 3, relayParentTaskId: first.id });
  const third = task({ id: "c3333333", shortId: "c33333", relayStep: 3, relayTotal: 3, relayParentTaskId: second.id });
  const alone = task({ id: "d4444444", shortId: "d44444" });

  // One row for the whole chain, one for the task that stands alone.
  const rows = batchRows([first, second, third, alone], [first, second, third, alone]);
  assert.deepEqual(
    rows.map((row) => ({ chain: row.chain, label: rowLabel(row) })),
    [
      { chain: true, label: "#a11111 → #b22222 → #c33333" },
      { chain: false, label: "#d44444" },
    ],
  );

  // The summary card's own line names the chain once, not one per step.
  assert.deepEqual(chainLines([first, second, third], translate), [
    {
      ids: [first.id, second.id, third.id],
      text: "Chain: #a11111 → #b22222 → #c33333 (merged at the last step)",
    },
  ]);
  assert.deepEqual(chainLines([alone], translate), [], "a single task is no chain");
});

test("a step knows where it sits in its chain", async (t) => {
  const { relayPosition } = await load(t);
  assert.deepEqual(relayPosition(task({ id: "x1", relayStep: 2, relayTotal: 3 })), {
    step: 2,
    total: 3,
    isLast: false,
  });
  assert.deepEqual(relayPosition(task({ id: "x2", relayStep: 3, relayTotal: 3 })), {
    step: 3,
    total: 3,
    isLast: true,
  });
  // A task in no chain is 1 of 1, so nothing about a chain is said about it.
  assert.deepEqual(relayPosition(task({ id: "x3" })), { step: 1, total: 1, isLast: true });
});