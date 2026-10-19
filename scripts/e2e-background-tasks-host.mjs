#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { beginTurn, configureSession, createSession, endTurn } from "./e2e/session.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, ".cache", "background-tasks-host-e2e");
await mkdir(artifacts, { recursive: true });
const scratch = await mkdtemp(join(artifacts, "run-"));
const workspace = join(scratch, "workspace");
await mkdir(workspace);
await copyFile(join(root, "scripts/e2e/background-task-output.mjs"), join(workspace, "output.mjs"));
await writeFile(join(workspace, "lifecycle.mjs"), `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
console.log("ready");
setInterval(() => {}, 1000);
`);
const { seedOfflineHostData } = await import("./e2e/offline-host-data.mjs");
seedOfflineHostData(root, join(scratch, "data"));
const host = new Host(resolveHostBinary(), join(scratch, "data"), {
  quiet: true,
  env: { PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter) },
});
const ownedPids = new Set();
const rpcDurations = [];
const timedCall = async (method, params = {}) => {
  const start = performance.now();
  const result = await host.call(method, params);
  rpcDurations.push(performance.now() - start);
  return result;
};
const until = async (check, message) => {
  const deadline = performance.now() + 30_000;
  while (!(await check())) {
    assert(performance.now() < deadline, message);
    await setImmediate();
  }
};
const exists = (path) => access(path).then(() => true, (error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});
const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const readPid = async (name) => {
  await until(() => exists(join(workspace, name)), `child ${name} must become ready`);
  const pid = Number(await readFile(join(workspace, name), "utf8"));
  assert(Number.isSafeInteger(pid) && pid > 0, "fixture must publish a real process id");
  ownedPids.add(pid);
  return pid;
};
try {
  await host.start();
  if (process.platform === "win32") await host.call("settings.set", { defaultCommandShell: "cmd" });
  const { effective: shell } = await host.call("commandShells.list");
  assert(shell && ["cmd", "posix"].includes(shell.dialect), "fixture needs cmd or a POSIX shell");
  const start = (session, turnId, toolCallId, command) => host.call("tools.execute", {
    sessionId: session.id, turnId, toolCallId, toolName: "Bash", mode: "agent",
    args: { command, runInBackground: true }, runInBackground: true, timeoutMs: 1_000,
    expectedCommandShellId: shell.id, expectedCommandShellDialect: shell.dialect,
  });
  const permission = async (toolCallId) => {
    let card;
    await until(() => {
      card = host.notifications.find((entry) => entry.method === "permissions.request"
        && entry.params?.toolCallId === toolCallId)?.params;
      return Boolean(card);
    }, `permission for ${toolCallId} must be visible`);
    return card;
  };

  // The real permission path must run before any detached process starts.
  const asked = await createSession(host, workspace, "Background approval");
  await configureSession(host, asked, "agent", "ask");
  const askedTurn = await beginTurn(host, asked.id);
  const deniedPromise = start(asked, askedTurn, "denied-background", "node lifecycle.mjs denied.pid");
  const deniedCard = await permission("denied-background");
  assert.equal(await exists(join(workspace, "denied.pid")), false);
  await host.call("permissions.resolve", { requestId: deniedCard.requestId, decision: "deny" });
  const denied = await deniedPromise;
  assert.equal(denied.errorCode, "TOOL_DENIED");
  assert.equal(await exists(join(workspace, "denied.pid")), false);

  const cancelledPromise = start(asked, askedTurn, "cancelled-background", "node lifecycle.mjs cancelled.pid");
  await permission("cancelled-background");
  await host.call("tools.abort", { sessionId: asked.id, toolCallId: "cancelled-background" });
  const cancelled = await cancelledPromise;
  assert.equal(cancelled.errorCode, "TOOL_ABORTED");
  assert.equal(await exists(join(workspace, "cancelled.pid")), false);
  assert.equal((await host.call("backgroundTasks.list")).tasks.length, 0);
  await endTurn(host, askedTurn, "aborted");

  // Local read/stop failures stay observable and never invent task output.
  await assert.rejects(host.call("backgroundTasks.output", { id: "missing" }),
    (error) => error.errorCode === "NOT_FOUND");
  await assert.rejects(host.call("backgroundTasks.output", { id: "" }),
    (error) => error.errorCode === "INVALID_PARAMS");
  assert.equal((await host.call("backgroundTasks.stop", { id: "missing" })).found, false);
  const unsupported = await host.call("tools.workspaceExecute", {
    sessionId: asked.id, toolCallId: "remote-background", path: workspace,
    toolName: "Bash", args: { command: "node lifecycle.mjs remote.pid" }, runInBackground: true,
  });
  assert.equal(unsupported.errorCode, "CAPABILITY_UNAVAILABLE");
  assert.equal(await exists(join(workspace, "remote.pid")), false);

  const session = await createSession(host, workspace, "Background output stress");
  await configureSession(host, session, "agent", "auto");
  const turnId = await beginTurn(host, session.id);
  const ids = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
    const result = await start(session, turnId, `stress-${index}`, `node output.mjs . ${index}`);
    assert(result.ok && result.content.backgroundTaskId, JSON.stringify(result));
    return result.content.backgroundTaskId;
  }));
  await until(async () => {
    const { tasks } = await host.call("backgroundTasks.list");
    const failed = tasks.find((task) => task.state === "failed");
    if (failed) {
      const output = await host.call("backgroundTasks.output", { id: failed.id });
      throw new Error(`Fixture failed to start: ${output.stderr.slice(-2_000)}`);
    }
    return (await Promise.all(ids.map((_, index) => exists(join(workspace, `${index}.ready`))))).every(Boolean);
  }, "all ten commands must start");
  await Promise.all(ids.map((_, index) =>
    host.call("tools.abort", { sessionId: session.id, toolCallId: `stress-${index}` }),
  ));
  await endTurn(host, turnId, "aborted");
  let summaries = (await timedCall("backgroundTasks.list")).tasks;
  assert.equal(summaries.filter((task) => task.state === "running").length, 10,
    "turn abort must preserve running background tasks");
  await writeFile(join(workspace, "release"), "");
  let polls = 0;
  await until(async () => {
    summaries = (await timedCall("backgroundTasks.list")).tasks;
    const output = await timedCall("backgroundTasks.output", { id: ids[polls++ % ids.length] });
    assert(Buffer.byteLength(output.stdout) <= 256 * 1024);
    assert(Buffer.byteLength(output.stderr) <= 256 * 1024);
    return summaries.every((task) => task.state !== "running");
  }, "large output commands must drain and settle");
  for (const [index, id] of ids.entries()) {
    const output = await timedCall("backgroundTasks.output", { id });
    assert.equal(output.state, "exited", JSON.stringify({ index, state: output.state,
      stdoutTail: output.stdout.slice(-500), stderrTail: output.stderr.slice(-2_000) }));
    assert.equal(output.exitCode, 0);
    assert.equal(output.truncated, true);
    assert(output.stdout.endsWith(`stdout-done-${index}\n`), "final stdout must not be lost");
    assert(output.stderr.endsWith(`stderr-done-${index}\n`), "final stderr must not be lost");
    assert(Buffer.byteLength(output.stdout) <= 256 * 1024);
    assert(Buffer.byteLength(output.stderr) <= 256 * 1024);
  }

  const lifecycleTurn = await beginTurn(host, session.id);
  const stopped = await start(session, lifecycleTurn, "explicit-stop", "node lifecycle.mjs stopped.pid");
  assert(stopped.ok && stopped.content.backgroundTaskId);
  const stoppedId = stopped.content.backgroundTaskId;
  const stoppedPid = await readPid("stopped.pid");
  assert.equal((await host.call("backgroundTasks.stop", { id: stoppedId })).found, true);
  assert.equal((await host.call("backgroundTasks.stop", { id: stoppedId })).found, false);
  await until(async () => {
    const output = await host.call("backgroundTasks.output", { id: stoppedId });
    assert.notEqual(output.state, "failed", JSON.stringify({ output, hostErrors: host.stderr.slice(-6000) }));
    return output.state === "stopped";
  }, "Stop must settle after cleanup");
  await until(() => !alive(stoppedPid), "Stop must terminate the actual child");
  ownedPids.delete(stoppedPid);

  const exiting = await start(session, lifecycleTurn, "shutdown-cleanup", "node lifecycle.mjs shutdown.pid");
  assert(exiting.ok && exiting.content.backgroundTaskId);
  const shutdownPid = await readPid("shutdown.pid");
  await endTurn(host, lifecycleTurn, "completed");
  assert(alive(shutdownPid), "turn completion must preserve the background child");
  host.child.stdin.end();
  let timer;
  const exit = await Promise.race([host.exitPromise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("graceful Host shutdown timed out")), 10_000);
  })]).finally(() => clearTimeout(timer));
  assert.equal(exit.code, 0, host.stderr.slice(-2_000));
  await until(() => !alive(shutdownPid), "Host exit must not leave an orphan child");
  ownedPids.delete(shutdownPid);

  rpcDurations.sort((a, b) => a - b);
  const result = {
    tasks: 10, shell: shell.id, linesPerTaskPerStream: 100_000, bytesProduced: 202_000_000,
    maxRetainedBytesPerStream: 256 * 1024, polls,
    rpcP95Ms: Number(rpcDurations[Math.floor(rpcDurations.length * 0.95)].toFixed(2)),
    rpcMaxMs: Number(rpcDurations.at(-1).toFixed(2)),
    permissionDeniedBeforeSpawn: true, pendingApprovalCancelled: true,
    remoteBackgroundRejected: true, turnAbortSurvived: true, finalOutputRetained: true,
    explicitStopReapedChild: true, hostExitReapedChild: true,
  };
  await writeFile(join(scratch, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await host.stop();
  for (const pid of ownedPids) {
    if (alive(pid)) {
      try { process.kill(pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
}
