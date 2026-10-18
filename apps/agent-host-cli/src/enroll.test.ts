import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readAccountKey } from "./enroll-credentials.js";

/**
 * How `agent-host-cli enroll` receives a Router AccessKey (protocol §11.5,
 * security gate 30). A key typed on the command line is visible to every user
 * on the machine through `ps` and lands in the shell history, so the only
 * accepted sources keep it out of argv: a 0600 file, stdin, or the environment.
 */
describe("enroll credential sources", () => {
  const directories: string[] = [];

  afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  async function keyFile(contents: string, mode: number): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "agent-host-cli-enroll-"));
    directories.push(directory);
    const path = join(directory, "access-key");
    await writeFile(path, contents, { mode });
    return path;
  }

  it("refuses a key typed on the command line", async () => {
    const result = await readAccountKey({ "access-key": "sk-gl-sentinel-typed" }, { env: {}, readStdin: async () => "" });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("refusing --access-key");
  });

  it("needs exactly one source, and says so when there is none or more than one", async () => {
    const none = await readAccountKey({}, { env: {}, readStdin: async () => "" });
    expect(none.ok).toBe(false);
    const two = await readAccountKey(
      { "access-key-stdin": true },
      { env: { MINIH_ROUTER_ACCESS_KEY: "sk-gl-sentinel-env" }, readStdin: async () => "sk-gl-sentinel-stdin" },
    );
    expect(two.ok).toBe(false);
    expect(two.ok ? "" : two.error).toContain("exactly one source");
  });

  it("reads a key from an owner-only file", async () => {
    const path = await keyFile("sk-gl-sentinel-file\n", 0o600);
    expect(await readAccountKey({ "access-key-file": path }, { env: {}, readStdin: async () => "" })).toEqual({
      ok: true,
      key: "sk-gl-sentinel-file",
    });
  });

  it("refuses a key file other users can read, or one that is not a file", async () => {
    const readable = await keyFile("sk-gl-sentinel-file\n", 0o644);
    const permissive = await readAccountKey({ "access-key-file": readable }, { env: {}, readStdin: async () => "" });
    expect(permissive.ok).toBe(false);
    expect(permissive.ok ? "" : permissive.error).toContain("readable by other users");

    const directory = await mkdtemp(join(tmpdir(), "agent-host-cli-enroll-"));
    directories.push(directory);
    const notAFile = await readAccountKey({ "access-key-file": directory }, { env: {}, readStdin: async () => "" });
    expect(notAFile.ok).toBe(false);
    expect(notAFile.ok ? "" : notAFile.error).toContain("not a regular file");

    const missing = await readAccountKey({ "access-key-file": join(directory, "nope") }, { env: {}, readStdin: async () => "" });
    expect(missing.ok).toBe(false);
  });

  it("reads a key from stdin and from the environment", async () => {
    expect(await readAccountKey({ "access-key-stdin": true }, { env: {}, readStdin: async () => "  sk-gl-sentinel-stdin \n" })).toEqual({
      ok: true,
      key: "sk-gl-sentinel-stdin",
    });
    expect(await readAccountKey({}, { env: { MINIH_ROUTER_ACCESS_KEY: "sk-gl-sentinel-env" }, readStdin: async () => "" })).toEqual({
      ok: true,
      key: "sk-gl-sentinel-env",
    });
    // An empty source is not a credential.
    expect((await readAccountKey({}, { env: {}, readStdin: async () => "" })).ok).toBe(false);
  });
});
