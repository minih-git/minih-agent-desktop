import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { seedRunningSessionApi } from "./helpers/session-running-fixture.mjs";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "minih-running-bootstrap-"));
const entry = join(temp, "store.cjs");
await build({ stdin: { contents: `
  export { useAppStore } from "./src/stores/app-store";
  export { api } from "./src/lib/api";
  export { sidebarSessionStatus } from "./src/lib/sidebar-session-status";
  export { PROTOCOL_VERSION } from "@minih-agent/shared";
`, resolveDir: join(root, "apps/desktop"), loader: "ts" }, outfile: entry, bundle: true,
  platform: "node", format: "cjs", jsx: "automatic", define: { "import.meta.env.DEV": "false" } });
after(() => rm(temp, { recursive: true, force: true }));
const require = createRequire(import.meta.url);
function harness(runningSessionIds = ["running"]) {
  delete require.cache[entry];
  const h = require(entry);
  const snapshot = seedRunningSessionApi(h.api, h.PROTOCOL_VERSION, runningSessionIds);
  return { ...h, snapshot };
}
test("reopening restores running badges and selecting the live session restores running controls", async () => {
  const h = harness(); await h.useAppStore.getState().bootstrap();
  const state = h.useAppStore.getState();
  assert.equal(state.healthOk, true, state.error);
  assert.equal(state.runningSessions.running, true);
  assert.notEqual(state.runningSessions.idle, true);
  assert.equal(h.sidebarSessionStatus({ running: state.runningSessions.running, selected: false, outcome: state.sessionOutcomes.running }), "running");
  await state.selectSession("running"); assert.equal(h.useAppStore.getState().isRunning, true);
});
for (const liveType of ["agent_end", "agent_start"]) {
  test(`${liveType} received during bootstrap outranks the snapshot`, async () => {
    const h = harness(liveType === "agent_end" ? ["running"] : []);
    const response = Promise.withResolvers(); h.api.listSessions = () => response.promise;
    const pending = h.useAppStore.getState().bootstrap();
    h.useAppStore.getState().handleAgentEvent({ sessionId: "running", ts: 1, event: { type: liveType } });
    response.resolve(h.snapshot); await pending;
    assert.equal(h.useAppStore.getState().healthOk, true, h.useAppStore.getState().error);
    assert.equal(h.useAppStore.getState().runningSessions.running, liveType === "agent_start");
  });
}
test("older session-list responses without a running snapshot stay compatible", async () => {
  const h = harness(null); h.useAppStore.setState({ runningSessions: {} });
  await h.useAppStore.getState().bootstrap();
  assert.equal(h.useAppStore.getState().healthOk, true, h.useAppStore.getState().error);
  assert.deepEqual(h.useAppStore.getState().runningSessions, {});
});
