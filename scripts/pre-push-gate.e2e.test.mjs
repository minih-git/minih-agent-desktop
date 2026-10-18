import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "scripts/check-pre-push-fast.mjs");
const quote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const options = { skip: process.platform === "win32" };

function fixture(t) {
  const directory = mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pre-push-e2e-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, "checkout");
  const remote = join(directory, "remote.git");
  const bin = join(directory, "bin");
  const log = join(directory, "checks.log");
  mkdirSync(cwd);
  mkdirSync(bin);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    PI_SKIP_PREPUSH: "",
    GATE_TEST_FAIL: "",
    GATE_TEST_LOG: log,
    PATH: `${bin}:${process.env.PATH}`,
  };
  function git(args, overrides = {}) {
    const result = spawnSync("git", args, { cwd, env: { ...env, ...overrides }, encoding: "utf8", timeout: 30000 });
    assert.ifError(result.error);
    return result;
  }
  function ok(args) {
    const result = git(args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  ok(["init", "--bare", remote]);
  ok(["init", "-b", "main"]);
  ok(["config", "user.name", "Gate Test"]);
  ok(["config", "user.email", "gate@example.invalid"]);
  ok(["config", "core.hooksPath", ".githooks"]);
  for (const file of [".githooks/pre-push", "scripts/check-pre-push-fast.mjs", "scripts/pre-push-gate.mjs"]) {
    const target = join(cwd, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, file), target);
  }
  for (const command of ["node", "pnpm", "cargo"]) {
    const forward = command === "node"
      ? `case "$1" in *check-pre-push-fast.mjs) exec ${quote(process.execPath)} "$@" ;; esac\n`
      : "";
    writeFileSync(join(bin, command), `#!/bin/sh
${forward}echo '${command}' >> "$GATE_TEST_LOG"
if [ "$GATE_TEST_FAIL" = '${command}' ]; then exit 23; fi
exit 0
`, { mode: 0o755 });
  }
  ok(["add", ".githooks/pre-push", "scripts/check-pre-push-fast.mjs", "scripts/pre-push-gate.mjs"]);
  ok(["-c", "commit.gpgsign=false", "commit", "-m", "test(tooling): seed isolated push fixture", "-m", "Exercise the real pre-push hook without a network remote."]);
  const head = ok(["rev-parse", "HEAD"]);
  return {
    git, head, remote, env,
    remoteHead: (ref) => ok(["--git-dir", remote, "rev-parse", ref]),
    calls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split(/\s+/) : [],
    resetCalls: () => { if (existsSync(log)) rmSync(log); },
  };
}

test("real local Git push executes the hook and publishes the checked branch", options, (t) => {
  const f = fixture(t);
  const result = f.git(["push", f.remote, "HEAD:refs/heads/topic"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pre-push gate passed/);
  assert.equal(f.calls().length, 9);
  assert.equal(f.remoteHead("refs/heads/topic"), f.head);
});

test("a failed check blocks a real local push and stops later checks", options, (t) => {
  const f = fixture(t);
  const result = f.git(["push", f.remote, "HEAD:refs/heads/rejected"], { GATE_TEST_FAIL: "pnpm" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Workspace package builds exited with 23/);
  assert.doesNotMatch(result.stdout, /pre-push gate passed/);
  assert.deepEqual(f.calls(), ["pnpm"]);
  const refs = f.git(["--git-dir", f.remote, "for-each-ref", "refs/heads/rejected"]);
  assert.equal(refs.status, 0, refs.stderr);
  assert.equal(refs.stdout.trim(), "");
});

test("explicit bypass, tag-only push and branch deletion skip the checks", options, (t) => {
  const f = fixture(t);
  const bypass = f.git(["push", f.remote, "HEAD:refs/heads/temporary"], { PI_SKIP_PREPUSH: "1", GATE_TEST_FAIL: "pnpm" });
  assert.equal(bypass.status, 0, bypass.stderr);
  assert.match(bypass.stdout, /PI_SKIP_PREPUSH is set/);
  assert.equal(f.calls().length, 0);
  const tag = f.git(["push", f.remote, "HEAD:refs/tags/gate-test"], { GATE_TEST_FAIL: "pnpm" });
  assert.equal(tag.status, 0, tag.stderr);
  assert.match(tag.stdout, /tag-only push/);
  const deletion = f.git(["push", f.remote, ":refs/heads/temporary"], { GATE_TEST_FAIL: "pnpm" });
  assert.equal(deletion.status, 0, deletion.stderr);
  assert.match(deletion.stdout, /branch deletion only/);
  assert.equal(f.calls().length, 0);
});

test("missing executables are reported as incomplete, never passed", options, (t) => {
  const directory = mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pre-push-no-tools-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli], {
    env: { ...process.env, PATH: directory, PI_SKIP_PREPUSH: "" },
    encoding: "utf8", timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pre-push gate incomplete/);
  assert.doesNotMatch(result.stdout, /pre-push gate passed/);
});

test("CLI accepts pnpm separators without running checks in list mode", () => {
  const result = spawnSync(process.execPath, [cli, "--", "--list"], { encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Workspace package builds/);
  assert.doesNotMatch(result.stdout, /pre-push gate passed/);
});
