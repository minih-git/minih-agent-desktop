import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../../../", import.meta.url);
const readWorkflow = (name) => parse(readFileSync(new URL(`.github/workflows/${name}`, root), "utf8"));
const release = readWorkflow("release.yml");
const recovery = readWorkflow("recover-release-mirror.yml");
const recoverySteps = recovery.jobs.mirror.steps;
const download = recoverySteps.find((step) => step.name?.startsWith("Download the latest"));
const mirror = recoverySteps.find((step) => step.run === "node scripts/publish-update-mirror.mjs dist");

function assertScriptPrerequisites(steps, downloadIndex) {
  const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
  const node = steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));
  const mirrorIndex = steps.findIndex((step) => step.run === "node scripts/publish-update-mirror.mjs dist");
  assert.ok(checkout >= 0, "publish runs a repository script but never checks out the repository");
  assert.ok(checkout < downloadIndex, "checkout must not clean the already-downloaded artifacts");
  assert.ok(node >= 0 && node < mirrorIndex, "the mirror needs an explicitly provisioned Node runtime");
  assert.equal(steps[node].with["node-version"], 24);
  assert.equal(steps[checkout].with?.["persist-credentials"], false);
}

test("the publish job checks out its script before downloading assets and pins Node 24", () => {
  const steps = release.jobs.publish.steps;
  assertScriptPrerequisites(steps, steps.findIndex((step) => step.uses?.startsWith("actions/download-artifact@")));
});

test("mirror recovery is manual, main-only and cannot rewrite GitHub releases or tags", () => {
  assert.deepEqual(Object.keys(recovery.on), ["workflow_dispatch"]);
  assert.equal(recovery.on.workflow_dispatch.inputs.release_tag.required, true);
  assert.deepEqual(recovery.permissions, { contents: "read" });
  assert.equal(recovery.jobs.mirror.if, "github.ref == 'refs/heads/main'");
  assert.equal(recovery.concurrency["cancel-in-progress"], false);
  assert.equal(recovery.concurrency.group, "release-refs/tags/${{ inputs.release_tag }}");
  assert.equal(mirror["continue-on-error"], undefined);
  assertScriptPrerequisites(recoverySteps, recoverySteps.indexOf(download));
  const original = release.jobs.publish.steps.find((step) => step.run === mirror.run);
  assert.deepEqual(mirror.env, original.env, "recovery must use the same mirror configuration and secret bindings");
  assert.equal(download.env.RELEASE_TAG, "${{ inputs.release_tag }}");
  assert.doesNotMatch(download.run, /\$\{\{/, "dispatch input must reach shell commands through a quoted environment variable");
  assert.doesNotMatch(JSON.stringify(recoverySteps), /action-gh-release|git push|gh release (create|upload|edit)|pnpm|cargo/);
});

function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "release-mirror-workflow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "scripts"));
  writeFileSync(
    join(dir, "scripts/publish-update-mirror.mjs"),
    readFileSync(new URL("scripts/publish-update-mirror.mjs", root)),
  );
  const cli = (name, body) => writeFileSync(join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  cli("gh", `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + "\\n");
    if (args[0] === "api") {
      if (process.env.FAIL_GITHUB === "1") process.exit(1);
      console.log("v0.20.4");
    } else if (args[0] === "release" && args[1] === "download") {
      fs.mkdirSync("dist");
      fs.writeFileSync("dist/setup.exe", "existing release installer");
      fs.writeFileSync("dist/latest.yml", "version: 0.20.4\\nfiles: []\\n");
    } else process.exit(1);
  `);
  cli("aws", `
    require("node:fs").appendFileSync(process.env.AWS_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
    if (process.env.FAIL_AWS === "1") process.exit(1);
  `);
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    RELEASE_TAG: "v0.20.4",
    GITHUB_REPOSITORY: "fixture/desktop",
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    GH_CALLS: join(dir, "gh-calls.jsonl"),
    AWS_CALLS: join(dir, "aws-calls.jsonl"),
    MINIH_UPDATE_MIRROR_S3_BUCKET: "",
    ...overrides,
  };
  const run = (command) => spawnSync("/bin/bash", ["-e", "-c", command], { cwd: dir, env, encoding: "utf8", timeout: 10_000 });
  const calls = (path) => existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    : [];
  return { dir, env, run, calls };
}

const posix = {
  skip: process.platform === "win32" ? "Requires Bash and POSIX CLI fixtures" : false,
};

const configured = {
  MINIH_UPDATE_MIRROR_S3_BUCKET: "test-only-bucket",
  MINIH_UPDATE_MIRROR_S3_ACCESS_KEY_ID: "test-only-key",
  MINIH_UPDATE_MIRROR_S3_SECRET_ACCESS_KEY: "test-only-secret",
};

test("an unconfigured mirror recovers successfully without downloading assets or invoking AWS", posix, (t) => {
  const { dir, env, run, calls } = fixture(t);
  const result = run(download.run);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /No update mirror is configured/);
  const mirrored = run(mirror.run);
  assert.equal(mirrored.status, 0, mirrored.stderr);
  assert.match(mirrored.stdout, /publishing to GitHub Releases only/);
  assert.equal(existsSync(join(dir, "dist")), false);
  assert.equal(calls(env.GH_CALLS).length, 1);
  assert.deepEqual(calls(env.AWS_CALLS), []);
});

test("a configured mirror reuses the published assets and uploads artifacts before feeds", posix, (t) => {
  const { dir, env, run, calls } = fixture(t, configured);
  const result = run(download.run);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(env.GH_CALLS)[1], ["release", "download", "v0.20.4", "--repo", "fixture/desktop", "--dir", "dist"]);
  assert.equal(readFileSync(join(dir, "dist/setup.exe"), "utf8"), "existing release installer");
  const mirrored = run(mirror.run);
  assert.equal(mirrored.status, 0, mirrored.stderr);
  assert.deepEqual(calls(env.AWS_CALLS).map((args) => args.slice(0, 2)), [["s3", "sync"], ["s3", "cp"]]);
  assert.match(mirrored.stdout, /artifacts published for 0\.20\.4/);
});

test("an older release cannot replace the latest mirror feed", posix, (t) => {
  const { env, run, calls } = fixture(t, { ...configured, RELEASE_TAG: "v0.20.3" });
  const result = run(download.run);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /refusing to roll back/);
  assert.equal(calls(env.GH_CALLS).length, 1);
  assert.deepEqual(calls(env.AWS_CALLS), []);
});

test("release-tag input is data, never interpolated into executable shell", posix, (t) => {
  const { dir, env, run, calls } = fixture(t, { ...configured, RELEASE_TAG: "$(touch must-not-execute)" });
  assert.equal(run(download.run).status, 1);
  assert.equal(existsSync(join(dir, "must-not-execute")), false);
  assert.equal(calls(env.GH_CALLS).length, 1);
});

test("GitHub lookup failure cannot fall through to a mirror upload", posix, (t) => {
  const { env, run, calls } = fixture(t, { ...configured, FAIL_GITHUB: "1" });
  assert.equal(run(download.run).status, 1);
  assert.equal(calls(env.GH_CALLS).length, 1);
  assert.deepEqual(calls(env.AWS_CALLS), []);
});

test("a failed mirror upload remains a failed recovery", posix, (t) => {
  const { env, run, calls } = fixture(t, { ...configured, FAIL_AWS: "1" });
  assert.equal(run(download.run).status, 0);
  const result = run(mirror.run);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failed with exit code/);
  assert.equal(calls(env.AWS_CALLS).length, 1, "do not publish feeds after artifacts fail");
});
