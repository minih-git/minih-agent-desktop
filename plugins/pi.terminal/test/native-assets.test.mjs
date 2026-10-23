import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RELEASE_PLATFORMS,
  isPruned,
  normalizePlatform,
  planNativeAssets,
  unmetPlatforms,
} from "../scripts/native-assets.mjs";

/**
 * Which native assets a package carries.
 *
 * These are fixtures describing folders, not platforms: nothing here claims a
 * binary runs. What it pins is the decision that already went wrong once — a
 * package built without Linux assets must not be treated as a three-platform
 * delivery, and the palette of what counts as "present" must match what the
 * runtime actually loads.
 */

const darwin = ["pty.node", "spawn-helper"];
const darwinWithDebug = [...darwin, "pty.pdb"];
const win32 = [
  "pty.node",
  "conpty.node",
  "conpty_console_list.node",
  "conpty/conpty.dll",
  "conpty/OpenConsole.exe",
  "winpty.dll",
  "winpty-agent.exe",
  "pty.pdb",
];
const linux = ["pty.node"];

const allButLinux = {
  "darwin-arm64": darwinWithDebug,
  "darwin-x64": darwin,
  "win32-x64": win32,
  "win32-arm64": win32,
};

test("a package with the verified platforms is complete for those", () => {
  const plan = planNativeAssets({ prebuilds: allButLinux });
  assert.deepEqual(
    plan.platforms.map((entry) => entry.platform),
    ["darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64"],
  );
  assert.deepEqual(
    plan.missing.map((entry) => entry.platform),
    ["linux-x64", "linux-arm64"],
  );
});

test("debug symbols and the winpty shim are not packaged, and do not count as assets", () => {
  const plan = planNativeAssets({ prebuilds: allButLinux });
  const darwinArm = plan.platforms.find((entry) => entry.platform === "darwin-arm64");
  assert.deepEqual(darwinArm.files.sort(), [...darwin].sort());
  const windows = plan.platforms.find((entry) => entry.platform === "win32-x64");
  assert.ok(!windows.files.some((file) => isPruned(file)), windows.files.join(","));
  assert.ok(windows.files.includes("conpty/OpenConsole.exe"));
});

test("a platform folder missing a file the runtime loads is missing, not partial", () => {
  // macOS without its spawn helper cannot fork a pty at all.
  const plan = planNativeAssets({ prebuilds: { ...allButLinux, "darwin-arm64": ["pty.node"] } });
  assert.deepEqual(
    plan.missing.find((entry) => entry.platform === "darwin-arm64")?.files,
    ["spawn-helper"],
  );
  assert.ok(!plan.platforms.some((entry) => entry.platform === "darwin-arm64"));
});

test("a source build on this machine fills only this machine's platform", () => {
  // The documented Linux path: node-pty compiled into build/Release.
  const plan = planNativeAssets({
    prebuilds: allButLinux,
    localBuild: { platform: "linux-x64", files: ["pty.node", "obj.target/pty.o", "Makefile"] },
  });
  const linux64 = plan.platforms.find((entry) => entry.platform === "linux-x64");
  assert.equal(linux64?.source, "local-build");
  assert.ok(linux64.files.includes("pty.node"));
  // A build cannot produce the other architecture, so that one stays missing.
  assert.deepEqual(
    plan.missing.map((entry) => entry.platform),
    ["linux-arm64"],
  );
});

test("a local build of another platform does not masquerade as one of the targets", () => {
  const plan = planNativeAssets({
    prebuilds: {},
    localBuild: { platform: "freebsd-x64", files: ["pty.node"] },
  });
  assert.deepEqual(plan.platforms, []);
  assert.equal(plan.missing.length, RELEASE_PLATFORMS.length);
});

test("a release requires every target platform, a development package does not", () => {
  const development = planNativeAssets({ prebuilds: allButLinux });
  assert.deepEqual(unmetPlatforms(development, ["darwin-arm64", "win32-x64"]), []);
  assert.deepEqual(unmetPlatforms(development, RELEASE_PLATFORMS), [
    "linux-x64",
    "linux-arm64",
  ]);

  const release = planNativeAssets({
    prebuilds: allButLinux,
    localBuild: { platform: "linux-x64", files: linux },
  });
  assert.deepEqual(unmetPlatforms(release, ["linux-x64"]), []);
  assert.deepEqual(unmetPlatforms(release, RELEASE_PLATFORMS), ["linux-arm64"]);
});

test("only ids this plugin knows are platforms", () => {
  assert.equal(normalizePlatform("linux-x64"), "linux-x64");
  assert.equal(normalizePlatform("freebsd-x64"), null);
  assert.deepEqual(RELEASE_PLATFORMS.sort(), [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ]);
});
