/**
 * The project catalog's root rule (rollout A2).
 *
 * Both Hosts delegate to this module, so what is pinned down here is the rule
 * itself rather than one Host's wiring: browse and register stay inside one
 * directory, a `..` detour or a symlink that leaves it are refused, and a path
 * that does not exist is reported as missing instead of being created.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProjectCatalog, isInsideRoot, projectBrowseRoot, shortenHomePath } from "./project-catalog.js";
import type { HostRpc } from "./host-ports.js";

type Call = { method: string; params: Record<string, unknown> | undefined };

function fakeHost(): { host: HostRpc; calls: Call[] } {
  const calls: Call[] = [];
  const host = {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      if (method === "projects.list") {
        return { projects: [{ id: 1, path: "/registered", name: "registered" }] } as T;
      }
      if (method === "projects.create") {
        const path = String(params?.["path"] ?? "");
        return { project: { id: 2, path, name: path.split("/").pop() ?? path } } as T;
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as HostRpc;
  return { host, calls };
}

let root = "";
let outside = "";
/** The same two directories in their real spelling (`/var` is a symlink on macOS). */
let rootReal = "";
let outsideReal = "";

beforeEach(async () => {
  // The run root contains the browse root, so an outside path is a sibling, not
  // a parent that would trivially fail on every platform.
  const base = await realpath(await mkdtemp(join(tmpdir(), "project-catalog-")));
  root = join(base, "home");
  outside = join(base, "elsewhere");
  await mkdir(join(root, "work", "app"), { recursive: true });
  await mkdir(join(root, "empty"), { recursive: true });
  await mkdir(outside, { recursive: true });
  rootReal = await realpath(root);
  outsideReal = await realpath(outside);
});

afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

function catalogFor(host: HostRpc) {
  return createProjectCatalog({ getHost: () => host, browseRoot: root });
}

describe("project browse root", () => {
  it("resolves the root to its real spelling", async () => {
    expect(await projectBrowseRoot(root)).toBe(await projectBrowseRoot(root));
    expect(await projectBrowseRoot(join(root, "work", ".."))).toBe(rootReal);
  });

  it("treats the root itself as inside, and a sibling prefix as outside", () => {
    expect(isInsideRoot("/home/user", "/home/user")).toBe(true);
    expect(isInsideRoot("/home/user", "/home/user/project")).toBe(true);
    expect(isInsideRoot("/home/user", "/home/user2")).toBe(false);
    expect(isInsideRoot("/home/user", "/home")).toBe(false);
  });
});

describe("shortenHomePath", () => {
  it("writes the root as ~ and keeps a path under it relative", () => {
    expect(shortenHomePath("/home/user", "/home/user")).toBe("~");
    expect(shortenHomePath("/home/user/Projects/app", "/home/user")).toBe("~/Projects/app");
    expect(shortenHomePath("/home/user/Projects/app", "/home/user/")).toBe("~/Projects/app");
  });

  it("uses a Windows Host's own separator", () => {
    // A Windows Host answers `C:\…`; writing the shortened form with `/` left
    // the whole path unshortened, which printed the account name on a phone.
    expect(shortenHomePath("C:\\Users\\user", "C:\\Users\\user")).toBe("~");
    expect(shortenHomePath("C:\\Users\\user\\Projects\\app", "C:\\Users\\user")).toBe("~\\Projects\\app");
    expect(shortenHomePath("C:\\Users\\user\\Projects\\app", "C:\\Users\\user\\")).toBe("~\\Projects\\app");
    expect(shortenHomePath("C:\\Users", "C:\\")).toBe("~\\Users");
    expect(shortenHomePath("C:\\Users\\user2\\app", "C:\\Users\\user")).toBe("C:\\Users\\user2\\app");
  });

  it("leaves a path outside the root, and a sibling prefix, untouched", () => {
    expect(shortenHomePath("/srv/data", "/home/user")).toBe("/srv/data");
    expect(shortenHomePath("/home/user2/app", "/home/user")).toBe("/home/user2/app");
  });
});

describe("browse", () => {
  it("starts at the root and lists only visible directories", async () => {
    const { host } = fakeHost();
    const catalog = catalogFor(host);
    await mkdir(join(root, "work", ".hidden"), { recursive: true });
    await writeFile(join(root, "file.txt"), "not a directory");

    const top = await catalog.browse();

    expect(top.path).toBe(rootReal);
    expect(top.parent).toBeUndefined();
    expect(top.entries.map((entry) => entry.name)).toEqual(["empty", "work"]);
    expect(top.entries.every((entry) => entry.path.startsWith(rootReal))).toBe(true);
  });

  it("walks down a level and offers the way back up", async () => {
    const { host } = fakeHost();
    const catalog = catalogFor(host);

    const nested = await catalog.browse(join(root, "work"));

    expect(nested.path).toBe(join(rootReal, "work"));
    expect(nested.parent).toBe(rootReal);
    expect(nested.entries.map((entry) => entry.name)).toEqual(["app"]);
  });

  it("answers the same refusal for an existing and a missing path outside the root", async () => {
    const { host } = fakeHost();
    const catalog = catalogFor(host);

    // A path outside the root must not reveal whether it exists: the same code
    // and the same message, or a device could map the filesystem by probing.
    const existing = await catalog.browse(outside).catch((error: { code?: string; message?: string }) => error);
    const missing = await catalog
      .browse(join(outside, "nope"))
      .catch((error: { code?: string; message?: string }) => error);

    expect(existing.code).toBe("REMOTE_PATH_FORBIDDEN");
    expect(missing.code).toBe("REMOTE_PATH_FORBIDDEN");
    expect(missing.message).toBe(existing.message);
  });

  it("answers the same refusal through a symlink that leaves the root", async () => {
    const { host } = fakeHost();
    const catalog = catalogFor(host);
    // A symlink inside the root pointing at the root's parent: `~/link/etc` and
    // `~/link/nothing` must be indistinguishable, or the link becomes a probe.
    await mkdir(join(outside, "present"), { recursive: true });
    await symlink(outside, join(root, "link"));

    const existing = await catalog
      .browse(join(root, "link", "present"))
      .catch((error: { code?: string; message?: string }) => error);
    const missing = await catalog
      .browse(join(root, "link", "nothing"))
      .catch((error: { code?: string; message?: string }) => error);

    expect(existing.code).toBe("REMOTE_PATH_FORBIDDEN");
    expect(missing.code).toBe("REMOTE_PATH_FORBIDDEN");
    expect(missing.message).toBe(existing.message);
  });

  it("refuses a path outside the root", async () => {
    const { host } = fakeHost();
    const catalog = catalogFor(host);

    await expect(catalog.browse(outside)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
  });

  it("refuses a relative path and a `..` detour that leaves the root", async () => {
    const { host } = fakeHost();
    const catalog = catalogFor(host);

    await expect(catalog.browse("work")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(catalog.browse(join(root, "..", "elsewhere"))).rejects.toMatchObject({
      code: "REMOTE_PATH_FORBIDDEN",
    });
  });

  it("refuses a symlink that points outside the root", async () => {
    const { host } = fakeHost();
    const catalog = catalogFor(host);
    const escape = join(root, "escape");
    await symlink(outside, escape);

    await expect(catalog.browse(escape)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
  });

  it("follows a symlink that stays inside the root", async () => {
    const { host } = fakeHost();
    const catalog = catalogFor(host);
    const inside = join(root, "shortcut");
    await symlink(join(root, "work"), inside);

    const listed = await catalog.browse(inside);

    // The answer carries the real directory, so a client tracks one spelling.
    expect(listed.path).toBe(join(rootReal, "work"));
  });

  it("reports a missing path and a file as missing, not as forbidden", async () => {
    const { host } = fakeHost();
    const catalog = catalogFor(host);
    await writeFile(join(root, "notes.md"), "x");

    await expect(catalog.browse(join(root, "missing"))).rejects.toMatchObject({
      code: "REMOTE_PATH_NOT_FOUND",
    });
    await expect(catalog.browse(join(root, "notes.md"))).rejects.toMatchObject({
      code: "REMOTE_PATH_NOT_FOUND",
    });
  });
});

describe("register", () => {
  it("registers a directory inside the root with its canonical path", async () => {
    const { host, calls } = fakeHost();
    const catalog = catalogFor(host);

    const project = await catalog.register(join(root, "work", "app"));

    expect(project).toMatchObject({ id: "2", path: join(rootReal, "work", "app") });
    expect(calls.find((call) => call.method === "projects.create")?.params).toEqual({
      path: join(rootReal, "work", "app"),
    });
  });

  it("answers the same refusal when registering a missing path outside the root", async () => {
    const { host, calls } = fakeHost();
    const catalog = catalogFor(host);

    const existing = await catalog.register(outside).catch((error: { code?: string; message?: string }) => error);
    const missing = await catalog
      .register(join(outside, "nope"))
      .catch((error: { code?: string; message?: string }) => error);

    expect(existing.code).toBe("REMOTE_PATH_FORBIDDEN");
    expect(missing.code).toBe("REMOTE_PATH_FORBIDDEN");
    expect(missing.message).toBe(existing.message);
    expect(calls.some((call) => call.method === "projects.create")).toBe(false);
  });

  it("answers the same refusal through a symlink when registering", async () => {
    const { host, calls } = fakeHost();
    const catalog = catalogFor(host);
    await mkdir(join(outside, "present"), { recursive: true });
    await symlink(outside, join(root, "link"));

    const existing = await catalog
      .register(join(root, "link", "present"))
      .catch((error: { code?: string; message?: string }) => error);
    const missing = await catalog
      .register(join(root, "link", "nothing"))
      .catch((error: { code?: string; message?: string }) => error);

    expect(existing.code).toBe("REMOTE_PATH_FORBIDDEN");
    expect(missing.code).toBe("REMOTE_PATH_FORBIDDEN");
    expect(missing.message).toBe(existing.message);
    expect(calls.some((call) => call.method === "projects.create")).toBe(false);
  });

  it("refuses to register anything outside the root", async () => {
    const { host, calls } = fakeHost();
    const catalog = catalogFor(host);

    await expect(catalog.register(outside)).rejects.toMatchObject({ code: "REMOTE_PATH_FORBIDDEN" });
    // Nothing reached host-core, so no row was created for a refused path.
    expect(calls.some((call) => call.method === "projects.create")).toBe(false);
  });

  it("refuses a symlinked directory that resolves outside the root", async () => {
    const { host, calls } = fakeHost();
    const catalog = catalogFor(host);
    await symlink(outside, join(root, "escape"));

    await expect(catalog.register(join(root, "escape"))).rejects.toMatchObject({
      code: "REMOTE_PATH_FORBIDDEN",
    });
    expect(calls.some((call) => call.method === "projects.create")).toBe(false);
  });

  it("refuses a directory that does not exist", async () => {
    const { host, calls } = fakeHost();
    const catalog = catalogFor(host);

    await expect(catalog.register(join(root, "nope"))).rejects.toMatchObject({
      code: "REMOTE_PATH_NOT_FOUND",
    });
    expect(calls.some((call) => call.method === "projects.create")).toBe(false);
  });
});
