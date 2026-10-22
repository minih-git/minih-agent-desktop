/**
 * The session-rooted workspace reads both Hosts share (rollout R8 package D).
 *
 * The rules pinned down here are the ones a remote file panel depends on: every
 * read stays inside the session's durable project root, a `..` detour and a
 * symlink that leaves the root are refused rather than followed, and a file too
 * large to preview is reported as such instead of being loaded.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { remoteProjectPath } from "@minih-agent/shared";

import type { HostRpc } from "./host-ports.js";
import { createWorkspaceAccess } from "./workspace-access.js";
import { MAX_TEXT_BYTES } from "./workspace-files.js";

type Call = { method: string; params: Record<string, unknown> | undefined };

/** host-core as these reads see it: one session row with a project path. */
function fakeHost(projectPath: string | null): { host: HostRpc; calls: Call[] } {
  const calls: Call[] = [];
  const host = {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      if (method === "session.get") {
        return {
          session: params?.["id"] === "known" ? { id: "known", projectPath, mode: "agent" } : null,
        } as T;
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as HostRpc;
  return { host, calls };
}

let root = "";
let outside = "";

beforeEach(async () => {
  // `realpath` on both sides: `/var` is a symlink to `/private/var` on macOS, and
  // the containment check compares canonical paths.
  root = await realpath(await mkdtemp(join(tmpdir(), "workspace-access-root-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "workspace-access-outside-")));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "hello", "utf8");
  await writeFile(join(root, "src", "app.ts"), "export {};\n", "utf8");
  await writeFile(join(outside, "secret.txt"), "secret", "utf8");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("session workspace reads shared by both Hosts", () => {
  it("lists directories under the session's project root", async () => {
    const { host } = fakeHost(root);
    const access = createWorkspaceAccess(() => host);

    const top = await access.list("known", "");
    expect(top.entries.map((entry) => entry.name).sort()).toEqual(["README.md", "src"]);

    const nested = await access.list("known", "src");
    expect(nested.entries.map((entry) => entry.name)).toEqual(["app.ts"]);
  });

  it("reads a file inside the root and reports the file it read", async () => {
    const { host } = fakeHost(root);
    const access = createWorkspaceAccess(() => host);
    expect(await access.read("known", "README.md")).toMatchObject({ kind: "text", content: "hello" });
  });

  it("refuses a path that leaves the root with ..", async () => {
    const { host } = fakeHost(root);
    const access = createWorkspaceAccess(() => host);
    await expect(access.read("known", "../../etc/passwd")).rejects.toMatchObject({
      code: "REMOTE_PATH_FORBIDDEN",
    });
    await expect(access.list("known", "..")).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
  });

  it("refuses a symlink that points outside the root", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
    await symlink(outside, join(root, "escape-dir"));
    const { host } = fakeHost(root);
    const access = createWorkspaceAccess(() => host);

    // The link exists and looks local; only the canonical path reveals the escape.
    await expect(access.read("known", "escape.txt")).rejects.toMatchObject({
      code: "REMOTE_PATH_FORBIDDEN",
    });
    await expect(access.list("known", "escape-dir")).rejects.toMatchObject({
      code: "REMOTE_PATH_FORBIDDEN",
    });
  });

  it("refuses a path that cannot be resolved, rather than probing for it", async () => {
    const { host } = fakeHost(root);
    const access = createWorkspaceAccess(() => host);
    // The containment check canonicalizes first: a target that `realpath` cannot
    // resolve is refused as out-of-root, never stat-ed to find out what it is.
    // This is the behaviour `agent-host-cli` already had, kept identical so both
    // Hosts answer the same code for the same request.
    await expect(access.read("known", "nope.txt")).rejects.toMatchObject({
      code: "REMOTE_PATH_FORBIDDEN",
    });
  });

  it("refuses a directory where a file was expected", async () => {
    const { host } = fakeHost(root);
    const access = createWorkspaceAccess(() => host);
    await expect(access.read("known", "src")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("reports a file past the preview cap instead of loading it", async () => {
    await writeFile(join(root, "big.txt"), "x".repeat(MAX_TEXT_BYTES + 1), "utf8");
    const { host } = fakeHost(root);
    const access = createWorkspaceAccess(() => host);
    expect(await access.read("known", "big.txt")).toMatchObject({ kind: "tooLarge" });
  });

  it("has no workspace for a session without a project root", async () => {
    const { host } = fakeHost(null);
    const access = createWorkspaceAccess(() => host);
    await expect(access.list("known", "")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("does not read for a session the Host does not have", async () => {
    const { host } = fakeHost(root);
    const access = createWorkspaceAccess(() => host);
    await expect(access.read("unknown", "README.md")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses an opaque remote-project identifier instead of resolving it", async () => {
    // A session whose project lives on another machine carries
    // `remote-project:<hostKey,projectId>` (ADR `local-agent-remote-workspace-tools`).
    // That value is not a directory on any machine, so it must be refused
    // before any filesystem call: resolving it would fail, and a relative
    // spelling could even land on an unrelated local directory.
    const { host } = fakeHost(remoteProjectPath("host_sibling", "7"));
    const access = createWorkspaceAccess(() => host);
    await expect(access.list("known", "")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(access.read("known", "README.md")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(access.diff("known")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a relative project root, even one that names a real file", async () => {
    // `relative()` of a file that exists: resolving it against the process's
    // working directory would succeed and return that file's content, so getting
    // CONFLICT here is what proves the check runs before the filesystem.
    const relativeRoot = relative(process.cwd(), join(root, "README.md"));
    const { host } = fakeHost(relativeRoot);
    const access = createWorkspaceAccess(() => host);
    await expect(access.list("known", "")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(access.read("known", "README.md")).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
