/**
 * A title written inside Electron Main has to reach an attached remote client.
 *
 * The reported symptom was a phone whose session header kept the old task name
 * after the desktop generated or changed one. The desktop's own sidebar was
 * never stale, because Main fans the change out to the renderer; the RACP Host
 * was simply never told, and a phone only learns a title from a
 * `session.changed` event.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { createSessionChangeNotifier } = await import(
  "../electron/main/session-change-notifier.ts"
);

/** The catalog row the Host's `session.list` would return for one session. */
const SUMMARY = {
  id: "s1",
  title: "Fix the login bug",
  projectId: "proj",
  workspaceLabel: "app",
  mode: "agent",
  permissionMode: "ask",
  planningState: "inactive",
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:01:00.000Z",
};

function harness({ summaries = [SUMMARY], host = {}, bridge = {} } = {}) {
  const published = [];
  const warnings = [];
  const notifier = createSessionChangeNotifier({
    getHost: () => ("host" in host ? host.host : { call: async () => ({}) }),
    getAgentHost: () =>
      "bridge" in bridge
        ? bridge.bridge
        : {
            agentHost: {
              publishSessionChange: (kind, summary) => published.push({ kind, summary }),
            },
          },
    logger: {
      app: (category, level, message, fields) => warnings.push({ category, level, message, fields }),
    },
    listSummaries: async () => summaries,
  });
  return { notifier, published, warnings };
}

test("announces a title change as session.changed with the catalog summary", async () => {
  const { notifier, published } = harness();
  await notifier.titleChanged("s1");
  assert.equal(published.length, 1);
  assert.equal(published[0].kind, "session.changed");
  // The whole summary travels: the phone's header renders title, mode,
  // permission mode, and planning state from it.
  assert.deepEqual(published[0].summary, SUMMARY);
});

test("announces nothing for a session the catalog does not hold", async () => {
  const { notifier, published } = harness({ summaries: [{ ...SUMMARY, id: "other" }] });
  await notifier.titleChanged("s1");
  assert.equal(published.length, 0);
});

test("announces nothing before the Agent Host bridge exists", async () => {
  const { notifier, published } = harness({ bridge: { bridge: null } });
  await notifier.titleChanged("s1");
  assert.equal(published.length, 0);
});

test("announces nothing when host-core is gone, and does not throw", async () => {
  const { notifier, published } = harness({ host: { host: null } });
  await assert.doesNotReject(notifier.titleChanged("s1"));
  assert.equal(published.length, 0);
});

test("a failed catalog read is logged, not thrown at the rename that caused it", async () => {
  const warnings = [];
  const notifier = createSessionChangeNotifier({
    getHost: () => ({ call: async () => ({}) }),
    getAgentHost: () => ({ agentHost: { publishSessionChange: () => assert.fail("must not publish") } }),
    logger: { app: (...args) => warnings.push(args) },
    listSummaries: async () => {
      throw new Error("host-core exited");
    },
  });
  await assert.doesNotReject(notifier.titleChanged("s1"));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "session");
  assert.equal(warnings[0][1], "warn");
  assert.equal(warnings[0][2], "session title announcement failed");
  assert.match(JSON.stringify(warnings[0][3]), /host-core exited/);
});

test("an empty session id is not a lookup", async () => {
  let listed = 0;
  const notifier = createSessionChangeNotifier({
    getHost: () => ({ call: async () => ({}) }),
    getAgentHost: () => ({ agentHost: { publishSessionChange: () => undefined } }),
    logger: { app: () => undefined },
    listSummaries: async () => {
      listed += 1;
      return [SUMMARY];
    },
  });
  await notifier.titleChanged("   ");
  assert.equal(listed, 0);
});
