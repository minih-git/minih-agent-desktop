import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  defaultProfile,
  detectShellProfiles,
  findProfile,
  isLocalDirectory,
} = require("../dist/lib/shells.js");

test("detects installed shells and never invents one", () => {
  const profiles = detectShellProfiles({
    platform: "darwin",
    env: { SHELL: "/bin/zsh" },
    isFile: (file) => ["/bin/zsh", "/bin/bash", "/opt/homebrew/bin/bash"].includes(file),
  });
  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["zsh", "bash"],
  );
  for (const profile of profiles) {
    assert.ok(profile.file.startsWith("/"), profile.file);
    assert.deepEqual(profile.args, [], "interactive shells are started without flags");
  }
});

test("a missing login shell is skipped instead of substituted silently", () => {
  const profiles = detectShellProfiles({
    platform: "darwin",
    env: { SHELL: "/opt/nowhere/zsh" },
    isFile: (file) => file === "/bin/bash",
  });
  assert.deepEqual(profiles.map((profile) => profile.id), ["bash"]);
});

test("two installs of one shell collapse to the first, so a profile id stays stable", () => {
  const profiles = detectShellProfiles({
    platform: "darwin",
    env: { SHELL: "/opt/homebrew/bin/bash" },
    isFile: () => true,
  });
  assert.equal(profiles[0].id, "bash");
  assert.equal(profiles[0].file, "/opt/homebrew/bin/bash");
  assert.equal(new Set(profiles.map((profile) => profile.id)).size, profiles.length);
});

test("windows offers PowerShell, cmd, and Git Bash only when installed", () => {
  const profiles = detectShellProfiles({
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
    isFile: (file) =>
      file === "C:\\Program Files\\PowerShell\\7\\pwsh.exe" ||
      file === "C:\\Windows\\System32\\cmd.exe",
  });
  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["pwsh", "cmd"],
  );
});

test("no installed shell yields an empty catalog rather than a fake default", () => {
  assert.deepEqual(detectShellProfiles({ platform: "linux", env: {}, isFile: () => false }), []);
  assert.equal(defaultProfile([]), null);
});

test("a profile id this machine lost is refused, not replaced", () => {
  const profiles = [{ id: "zsh", label: "zsh", file: "/bin/zsh", args: [] }];
  assert.equal(findProfile(profiles, "zsh")?.file, "/bin/zsh");
  assert.equal(findProfile(profiles, "pwsh"), null);
  assert.equal(findProfile(profiles, undefined)?.id, "zsh");
});

test("only an existing local directory can host a terminal", () => {
  assert.equal(isLocalDirectory("/work", (path) => path === "/work"), true);
  assert.equal(isLocalDirectory("/remote/only", () => false), false);
  assert.equal(isLocalDirectory("", () => true), false);
  assert.equal(isLocalDirectory(null, () => true), false);
});
