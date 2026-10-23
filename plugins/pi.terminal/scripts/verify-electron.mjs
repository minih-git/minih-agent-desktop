#!/usr/bin/env node
/**
 * Prove the packaged PTY loads where it will actually run.
 *
 * The plugin backend is an Electron utility process, not a plain `node` one: its
 * Node ABI, environment, and module resolution differ. A binary that loads under
 * `node --test` is therefore not evidence that the packaged plugin works, so this
 * driver hands the packaged `dist/` to the release's own Electron binary:
 *
 *   node scripts/verify-electron.mjs --electron <release Electron> [--electron-target <dist>]
 *
 * It exits 0 only when the utility process loads the vendored `node-pty`, spawns a
 * real shell through it, receives that shell's output, and closes the terminal.
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const index = args.indexOf("--electron");
const electron = index >= 0 ? args[index + 1] : null;
const targetIndex = args.indexOf("--electron-target");
const target = targetIndex >= 0 ? args[targetIndex + 1] : join(here, "..", "dist");

if (!electron) {
  process.stderr.write(
    "usage: node scripts/verify-electron.mjs --electron <path> [--electron-target <dist>]\n",
  );
  process.exit(2);
}

const child = spawn(resolve(electron), [join(here, "verify-electron-main.mjs"), "--electron-target", resolve(target)], {
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (data) => {
  stdout += String(data);
});
child.stderr.on("data", (data) => {
  stderr += String(data);
});
const code = await new Promise((resolveExit) => child.once("exit", resolveExit));
const verdict = code === 0 && /PTY-OK/.test(stdout);
if (verdict) process.stdout.write(stdout);
else {
  process.stdout.write(stdout);
  process.stderr.write(stderr.slice(-2000));
}
process.stdout.write(
  verdict
    ? "electron utility process: PTY-OK (native module loaded, shell spawned, output received, terminals closed)\n"
    : "electron utility process: FAILED\n",
);
process.exit(verdict ? 0 : 1);
