import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The crash case: the process that owns the PTY is killed with SIGKILL, so no
 * handler, no `onUnload`, and no `dispose()` runs. The kernel then hangs up the
 * shell's session.
 *
 * What that guarantees is measured rather than assumed, and it is not the same
 * for every shell: the session leader (the shell) always goes away, while its
 * background jobs only follow when the shell resends SIGHUP to them on exit —
 * bash and zsh do, dash-like `sh` does not. The graceful paths do not depend on
 * that behaviour at all: `close()` signals the shell's whole process group, which
 * `engine.test.mjs` asserts for every installed shell.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** Shells documented to resend SIGHUP to their jobs when they exit. */
const HANGS_UP_JOBS = new Set(["bash", "zsh"]);

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

test(
  "killing the process that owns the terminal takes the shell with it",
  { skip: process.platform === "win32" && "posix session semantics" },
  async (t) => {
    const child = spawn(process.execPath, [join(here, "fixtures", "child-host.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // A failure must not leave the child (and its PTY) holding the test process
    // open: that turns an assertion into a hang.
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    let stdout = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    const stderr = [];
    child.stderr.on("data", (data) => stderr.push(String(data)));

    const reported = await waitFor(() => /META .* END\r?\n/.test(stdout), 30_000);
    assert.ok(
      reported,
      `child host never reported its shell and job: ${stdout.slice(-400)} ${stderr.join("").slice(-400)}`,
    );
    const [, shell, shellPid, jobPid] = /META shell=(\S+) shellpid=(\d+) job=(\d+) END/.exec(stdout);
    t.diagnostic(`shell ${shell} shellpid ${shellPid} job ${jobPid}`);
    assert.ok(alive(Number(shellPid)), "the shell must be running before the crash");
    assert.ok(alive(Number(jobPid)), "the job must be running before the crash");

    // SIGKILL: the plugin process cannot run cleanup, exactly like a crash.
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    const shellGone = await waitFor(() => !alive(Number(shellPid)), 15_000);
    const jobGone = await waitFor(() => !alive(Number(jobPid)), 15_000);
    if (!shellGone || !jobGone) {
      for (const pid of [shellPid, jobPid]) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    assert.equal(shellGone, true, `shell ${shellPid} survived its terminal owner`);

    if (HANGS_UP_JOBS.has(basename(shell))) {
      assert.equal(jobGone, true, `job ${jobPid} of ${basename(shell)} survived its shell`);
    } else {
      // A shell that does not hang up its jobs on exit is a documented limit of
      // the crash path, not a silent one: the README has to say so.
      t.diagnostic(`${basename(shell)} does not resend SIGHUP to jobs; job cleanup is documented as best effort`);
      const readme = readFileSync(join(here, "..", "README.md"), "utf8");
      assert.match(
        readme,
        /does not hang up its jobs/,
        "the crash-path limitation for such shells must stay documented",
      );
    }
  },
);
