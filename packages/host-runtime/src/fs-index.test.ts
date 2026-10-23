import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import * as fileIndex from "./fs-index.js";

const DEEP = "Assets/_Game/Scripts/Gameplay/Player/Controllers/FeatureController.cs";
const temps: string[] = [];
afterAll(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeFiles(root: string, paths: string[]) {
  for (let start = 0; start < paths.length; start += 500) {
    await Promise.all(paths.slice(start, start + 500).map(async (path) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "fixture");
    }));
  }
}

async function largeTree() {
  const root = await mkdtemp(join(tmpdir(), "minih-file-search-"));
  temps.push(root);
  await writeFiles(root, [
    ...Array.from({ length: fileIndex.FS_INDEX_MAX_ENTRIES + 100 }, (_, i) =>
      `Assets/Art/Group${Math.floor(i / 300)}/asset_${i}.png`),
    DEEP,
    "node_modules/pkg/FeatureController.cs",
  ]);
  return root;
}

it("finds a deep file missing from the truncated snapshot without walking ignored trees", async () => {
  const root = await largeTree();
  const snapshot = await fileIndex.getWorkspaceFileIndex(root);
  expect(snapshot.truncated).toBe(true);
  expect(snapshot.entries).toHaveLength(fileIndex.FS_INDEX_MAX_ENTRIES);
  expect(snapshot.entries.some((entry) => entry.path === DEEP)).toBe(false);
  const found = await fileIndex.searchWorkspaceFiles(root, "FeatureController");
  expect(found.truncated).toBe(false);
  expect(found.entries.map((entry) => entry.path)).toEqual([DEEP]);
});

it("searches the full git listing while retaining gitignore and the panel ignore set", async (ctx) => {
  if (spawnSync("git", ["--version"]).status !== 0) return ctx.skip();
  const root = await largeTree();
  await writeFiles(root, ["Generated/FeatureController.cs"]);
  await writeFile(join(root, ".gitignore"), "Generated/\n");
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  const snapshot = await fileIndex.getWorkspaceFileIndex(root);
  expect(snapshot.truncated).toBe(true);
  expect(snapshot.entries.some((entry) => entry.path === DEEP)).toBe(false);
  const found = await fileIndex.searchWorkspaceFiles(root, "FeatureController");
  expect(found.truncated).toBe(false);
  expect(found.entries.map((entry) => entry.path)).toEqual([DEEP]);
});

it("returns directory matches and bounds the best results", async () => {
  const root = await largeTree();
  const dirs = await fileIndex.searchWorkspaceFiles(root, "Controllers");
  expect(dirs.entries[0]).toEqual({
    path: "Assets/_Game/Scripts/Gameplay/Player/Controllers", kind: "dir",
  });
  expect((await fileIndex.searchWorkspaceFiles(root, "asset_", 5)).entries).toHaveLength(5);
  expect(await fileIndex.searchWorkspaceFiles(root, "  ")).toEqual({ entries: [], truncated: false });
});

it("a non-git walk does not follow a directory symlink outside the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "minih-file-search-links-"));
  const outside = await mkdtemp(join(tmpdir(), "minih-file-search-outside-"));
  temps.push(root, outside);
  await writeFiles(root, ["local.ts"]);
  await writeFiles(outside, ["outside-secret.ts"]);
  await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  const found = await fileIndex.searchWorkspaceFiles(root, "outside-secret");
  expect(found).toEqual({ entries: [], truncated: false });
});
