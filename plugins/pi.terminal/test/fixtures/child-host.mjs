/**
 * A stand-in for the plugin host process, used by the owner-death test.
 *
 * It opens one real terminal, starts a long-lived job inside it, reports the
 * shell, the shell's pid, and the job's pid on stdout, and then waits to be
 * killed. The point is to observe what happens when the process holding the PTY
 * dies without any chance to run cleanup — the crash case, not a graceful unload.
 *
 * The record is delimited (`... END`) because a pid split across two reads must
 * not be mistaken for a shorter pid: the earlier fixture matched the first digits
 * it saw and reported a process it had never started.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TerminalEngine } = require("../../dist/lib/terminal-engine.js");

const engine = new TerminalEngine();
const terminal = engine.open({ cwd: process.cwd(), cols: 100, rows: 30 });
// The shell reports both pids itself: `$$` is the session leader the kernel
// hangs up, `$!` is the job that must not outlive it.
engine.write({
  id: terminal.id,
  // Single-quoted format, unquoted expansions: no nested quoting for the line
  // editor to lose, which is how an earlier version ended up at `dquote>`.
  data: "sleep 300 & printf 'META shellpid=%s job=%s END\\n' $$ $!\n",
});

const deadline = Date.now() + 20_000;
let seen = "";
while (Date.now() < deadline) {
  const reply = await engine.read({ id: terminal.id, waitMs: 200 });
  seen += reply.data;
  const match = /META shellpid=(\d+) job=(\d+) END\r?\n/.exec(seen);
  if (match) {
    process.stdout.write(
      `META shell=${terminal.shell} shellpid=${match[1]} job=${match[2]} END\n`,
    );
    // Keep the process (and therefore the PTY master) alive until the test kills
    // it; nothing here is cleaned up on purpose.
    setInterval(() => {}, 1_000);
    break;
  }
  if (reply.exited) break;
}
