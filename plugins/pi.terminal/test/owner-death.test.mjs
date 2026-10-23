import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitFor(predicate, timeoutMs, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

/**
 * The crash case: the process that owns the PTY is killed with SIGKILL, so no
 * handler, no `onUnload`, and no `dispose()` runs. Closing the PTY master makes
 * the kernel hang up the shell's session; the shell then hangs up its own jobs.
 *
 * This is the only evidence for "a plugin crash does not leave unmanaged shell
 * jobs" — killing the plugin process is *not* by itself proof that its
 * descendants died, so the job pid is measured rather than assumed.
 */
test(
  "killing the process that owns the terminal takes the shell's job with it",
  { skip: process.platform === "win32" && "posix job control semantics" },
  async () => {
    const child = spawn(process.execPath, [join(here, "fixtures", "child-host.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    const reported = await waitFor(() => /JOB=(\d+)/.test(stdout), 20_000);
    assert.ok(reported, `child host never reported its job: ${stdout.slice(-400)}`);
    const jobPid = Number(/JOB=(\d+)/.exec(stdout)[1]);
    assert.ok(alive(jobPid), "the job must be running before the crash");

    // SIGKILL: the plugin process cannot run cleanup, exactly like a crash.
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    const gone = await waitFor(() => !alive(jobPid), 10_000);
    if (!gone) {
      try {
        process.kill(jobPid, "SIGKILL");
      } catch {
        // Already gone between the check and the cleanup.
      }
    }
    assert.equal(gone, true, `job ${jobPid} survived its terminal owner`);
  },
);
