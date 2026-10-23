/**
 * A stand-in for the plugin host process, used by the owner-death test.
 *
 * It opens one real terminal, starts a long-lived job inside it, reports the
 * job's pid on stdout, and then just waits to be killed. The point is to observe
 * what happens to the shell and its job when the process holding the PTY dies
 * without any chance to run cleanup — the crash case, not a graceful unload.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TerminalEngine } = require("../../dist/lib/terminal-engine.js");

const engine = new TerminalEngine();
const terminal = engine.open({ cwd: process.cwd(), cols: 100, rows: 30 });
engine.write({ id: terminal.id, data: "sleep 300 & echo JOB=$!\n" });

const deadline = Date.now() + 15_000;
let seen = "";
while (Date.now() < deadline) {
  const reply = await engine.read({ id: terminal.id, waitMs: 200 });
  seen += reply.data;
  const match = /JOB=(\d+)/.exec(seen);
  if (match) {
    process.stdout.write(`JOB=${match[1]}\n`);
    // Keep the process (and therefore the PTY master) alive until the test kills
    // it; nothing here is cleaned up on purpose.
    setInterval(() => {}, 1_000);
    break;
  }
  if (reply.exited) break;
}
