/**
 * Electron side of the packaging check: fork a real utility process and ask it
 * to drive the packaged plugin engine.
 *
 * The static `electron` import matters: registering the `ready` handler must
 * happen before the module's first `await`, or a slow dynamic import can miss the
 * event and wait forever. The Node driver (`verify-electron.mjs`) launches this
 * file with the release's Electron binary.
 */
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app, utilityProcess } from "electron";

const args = process.argv.slice(2);
const index = args.indexOf("--electron-target");
const target = resolve(index >= 0 ? args[index + 1] : join(import.meta.dirname, "..", "dist"));

function finish(result) {
  if (result?.ok) process.stdout.write(`PTY-OK ${result.output ?? ""}\n`);
  else process.stderr.write(`${result?.error ?? "unknown failure"}\n`);
  app.exit(result?.ok ? 0 : 1);
}

async function main() {
  const worker = join(mkdtempSync(join(tmpdir(), "pi-terminal-electron-")), "worker.cjs");
  writeFileSync(
    worker,
    `
const { TerminalEngine } = require(${JSON.stringify(join(target, "lib", "terminal-engine.js"))});
(async () => {
  try {
    const engine = new TerminalEngine();
    const opened = engine.open({ cwd: process.cwd(), cols: 80, rows: 24 });
    engine.write({ id: opened.id, data: "echo PTY-$((6*7))\\n" });
    let seen = "";
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !seen.includes("PTY-42")) {
      const reply = await engine.read({ id: opened.id, waitMs: 200 });
      seen += reply.data;
    }
    const closed = await engine.closeAll();
    process.parentPort.postMessage({ ok: seen.includes("PTY-42"), output: opened.shell + " " + JSON.stringify(closed) });
  } catch (error) {
    process.parentPort.postMessage({ ok: false, error: String(error?.message ?? error) });
  }
})();
`,
  );

  const child = utilityProcess.fork(worker, [], { stdio: "pipe", serviceName: "pi-terminal-verify" });
  child.stderr?.on("data", (data) => appendFileSync(join(tmpdir(), "pi-terminal-electron.log"), String(data)));
  const done = new Promise((resolveDone) => {
    child.on("message", (message) => resolveDone(message));
    child.on("exit", (code) => resolveDone({ ok: false, error: `utility process exited early: ${code}` }));
    setTimeout(() => resolveDone({ ok: false, error: "utility process timed out" }), 25_000);
  });
  finish(await done);
}

if (app.isReady()) void main();
else app.once("ready", () => void main());
