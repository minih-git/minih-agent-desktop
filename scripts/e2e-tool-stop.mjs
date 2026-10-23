#!/usr/bin/env node
/** Offline real-Host cancellation boundaries; never starts the user's Desktop. */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Host } from "./e2e/host.mjs";
import { seedOfflineHostData } from "./e2e/offline-host-data.mjs";
import { beginTurn, configureSession, createSession, endTurn } from "./e2e/session.mjs";
import { waitForNotification } from "./e2e/wait.mjs";

assert(process.env.MINIH_AGENT_HOST_BIN, "Set MINIH_AGENT_HOST_BIN to the Host built from this worktree");
const root = fileURLToPath(new URL("..", import.meta.url));
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "tool-stop-"));
const workspace = join(temp, "workspace");
const home = join(temp, "home");
await mkdir(workspace); await mkdir(home);
seedOfflineHostData(root, join(temp, "data"));
const host = new Host(process.env.MINIH_AGENT_HOST_BIN, join(temp, "data"), {
  quiet: true, env: { HOME: home, USERPROFILE: home, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter) },
});
let backgroundId;
const passed = [];
try {
  await host.start();
  const asked = await createSession(host, workspace, "Pending write cancellation");
  await configureSession(host, asked, "agent", "ask");
  const turnId = await beginTurn(host, asked.id);
  const target = join(workspace, "must-not-exist.txt");
  const pending = host.call("tools.execute", {
    sessionId: asked.id, turnId, toolCallId: "pending-write", toolName: "Write", mode: "agent",
    args: { path: target, content: "must not be written" },
  });
  const notification = await waitForNotification(host.notifications,
    (entry) => entry.method === "permissions.request" && entry.params?.toolCallId === "pending-write");
  assert(notification, "the real permission request must be observable before Stop");
  await host.call("tools.abort", { sessionId: asked.id, toolCallId: "pending-write", toolName: "Write" });
  assert.equal((await pending).errorCode, "TOOL_ABORTED");
  await assert.rejects(access(target), { code: "ENOENT" });
  await assert.rejects(host.call("permissions.resolve", { requestId: notification.params.requestId, decision: "allow-once" }),
    (error) => error.errorCode === "NOT_FOUND");
  await endTurn(host, turnId, "aborted");
  passed.push("stopped pending Write cannot be approved or mutate files");

  const session = await createSession(host, workspace, "Typed cancellation and detached process");
  await configureSession(host, session, "agent", "auto");
  const activeTurn = await beginTurn(host, session.id);
  const execute = (toolName, args, extra = {}) => host.call("tools.execute", {
    sessionId: session.id, turnId: activeTurn, toolCallId: "same-id", toolName, mode: "agent", args, ...extra,
  });
  await host.call("tools.abort", { sessionId: session.id, toolCallId: "same-id", toolName: "Grep" });
  const file = join(workspace, "typed.txt");
  assert.equal((await execute("Write", { path: file, content: "typed scope" })).ok, true);
  assert.equal(await readFile(file, "utf8"), "typed scope");
  assert.equal((await execute("Grep", { path: workspace, pattern: "typed" })).errorCode, "TOOL_ABORTED");
  passed.push("an early Grep abort cannot cancel a different tool reusing the ID");

  const { effective: shell } = await host.call("commandShells.list");
  assert(shell && ["posix", "cmd"].includes(shell.dialect), "fixture requires a command shell");
  const background = await host.call("tools.execute", {
    sessionId: session.id, turnId: activeTurn, toolCallId: "detached", toolName: "Bash", mode: "agent",
    args: { command: 'node -e "console.log(123); setInterval(() => {}, 1000)"', runInBackground: true },
    runInBackground: true, expectedCommandShellId: shell.id, expectedCommandShellDialect: shell.dialect,
  });
  assert.equal(background.ok, true);
  backgroundId = background.content.backgroundTaskId;
  assert(backgroundId);
  await host.call("tools.abort", { sessionId: session.id, toolCallId: "detached", toolName: "Bash" });
  await endTurn(host, activeTurn, "aborted");
  const task = (await host.call("backgroundTasks.list")).tasks.find((item) => item.id === backgroundId);
  assert.equal(task?.state, "running", "a registered detached task survives its turn Stop");
  assert.equal((await host.call("backgroundTasks.stop", { id: backgroundId })).found, true);
  backgroundId = undefined;
  passed.push("an admitted background Bash survives turn Stop and supports explicit task Stop");
  console.log(JSON.stringify({ ok: true, checks: passed, isolatedData: temp }));
} finally {
  await host.stop();
}
