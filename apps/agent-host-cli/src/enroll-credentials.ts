/**
 * Where `agent-host-cli enroll` gets its Router AccessKey (protocol §11.5,
 * security gate 30).
 *
 * A key typed on the command line is readable by every user on the machine
 * through `ps` and `/proc/<pid>/cmdline`, and it lands in the shell history, so
 * `--access-key <value>` is refused rather than accepted quietly. The accepted
 * sources keep the key out of argv: an owner-only file, stdin, or the
 * environment. This module holds only that rule, so it can be tested without
 * starting a Host.
 */
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { CliArgs } from "./config.js";

/**
 * The Router AccessKey for `enroll`, read from exactly one source that keeps it
 * out of `ps`, `/proc/<pid>/cmdline`, and the shell history: `--access-key-file
 * <path>` (mode 0600, owned by this user), `--access-key-stdin`, or
 * `MINIH_ROUTER_ACCESS_KEY`. A key typed on the command line is refused rather
 * than accepted quietly (security gate 30).
 */
export async function readAccountKey(
  args: CliArgs,
  io: { env: NodeJS.ProcessEnv; readStdin: () => Promise<string> },
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  if (typeof args["access-key"] === "string") {
    return {
      ok: false,
      error:
        "refusing --access-key <value>: a command line is readable by every user on this machine; use --access-key-file <path> (mode 0600), --access-key-stdin, or MINIH_ROUTER_ACCESS_KEY",
    };
  }
  const fromFile = typeof args["access-key-file"] === "string" ? args["access-key-file"] : "";
  const fromStdin = args["access-key-stdin"] === true || args["access-key-stdin"] === "true";
  const fromEnv = io.env.MINIH_ROUTER_ACCESS_KEY ?? "";
  const chosen = [fromFile ? "file" : "", fromStdin ? "stdin" : "", fromEnv ? "environment" : ""].filter(Boolean);
  if (chosen.length !== 1) {
    return {
      ok: false,
      error: `an account key needs exactly one source, not ${chosen.length}: --access-key-file <path>, --access-key-stdin, or MINIH_ROUTER_ACCESS_KEY`,
    };
  }
  if (fromFile) {
    const path = resolve(fromFile);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(path);
    } catch {
      return { ok: false, error: `--access-key-file ${path} cannot be read` };
    }
    if (!stat.isFile()) return { ok: false, error: `--access-key-file ${path} is not a regular file` };
    if ((stat.mode & 0o077) !== 0) {
      return { ok: false, error: `--access-key-file ${path} is readable by other users; chmod 600 it first` };
    }
    if (process.getuid && stat.uid !== process.getuid()) {
      return { ok: false, error: `--access-key-file ${path} is not owned by this user` };
    }
    const key = (await readFile(path, "utf8")).trim();
    return key ? { ok: true, key } : { ok: false, error: `--access-key-file ${path} is empty` };
  }
  const key = (fromStdin ? await io.readStdin() : fromEnv).trim();
  return key ? { ok: true, key } : { ok: false, error: "the AccessKey is empty" };
}

/** Everything on stdin, trimmed: the `--access-key-stdin` source. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
