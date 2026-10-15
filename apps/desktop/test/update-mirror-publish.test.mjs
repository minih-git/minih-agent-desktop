import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const script = join(root, "scripts/publish-update-mirror.mjs");

function fixture({ version = "1.2.3", feeds = ["latest.yml", "latest-linux.yml"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mirror-fixture-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Minih-Agent-Desktop-Setup-1.2.3.exe"), "installer");
  writeFileSync(join(dir, "Minih-Agent-Desktop-Setup-1.2.3.exe.blockmap"), "blockmap");
  for (const feed of feeds) {
    writeFileSync(join(dir, feed), `version: ${version}\nfiles:\n  - url: setup.exe\n`);
  }
  return dir;
}

function runMirror(dir, env = {}, extraArgs = []) {
  return spawnSync(process.execPath, [script, dir, ...extraArgs], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MINIH_UPDATE_MIRROR_S3_BUCKET: "",
      ...env,
    },
  });
}

test("a release without a configured mirror publishes to GitHub only", (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = runMirror(dir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /publishing to GitHub Releases only/);
});

test("a configured mirror uploads artifacts before the feeds", (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = runMirror(
    dir,
    {
      MINIH_UPDATE_MIRROR_S3_BUCKET: "minih-updates",
      MINIH_UPDATE_MIRROR_S3_ACCESS_KEY_ID: "key",
      MINIH_UPDATE_MIRROR_S3_SECRET_ACCESS_KEY: "secret",
      MINIH_UPDATE_MIRROR_S3_ENDPOINT: "https://oss.example.com",
      MINIH_UPDATE_MIRROR_S3_PREFIX: "/minih/desktop/",
      MINIH_UPDATE_MIRROR_PUBLIC_URL: "https://dl.example.com",
    },
    ["--dry-run"],
  );
  assert.equal(result.status, 0);
  const lines = result.stdout.trim().split("\n");
  const sync = lines.findIndex((line) => line.includes("aws s3 sync"));
  const feed = lines.findIndex((line) => line.includes("latest.yml"));
  assert.ok(sync !== -1 && feed !== -1, result.stdout);
  assert.ok(sync < feed, "feeds must be uploaded after the artifacts they reference");
  assert.match(lines[sync], /s3:\/\/minih-updates\/minih\/desktop --endpoint-url https:\/\/oss\.example\.com --delete --exclude latest\*\.yml/);
  assert.match(lines[feed], /--cache-control no-cache/);
  assert.match(result.stdout, /verify https:\/\/dl\.example\.com\/minih\/desktop\/latest\.yml serves 1\.2\.3/);
  assert.match(result.stdout, /2 feed\(s\)/);
});

test("a configured mirror without credentials fails the release", (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = runMirror(dir, {
    MINIH_UPDATE_MIRROR_S3_BUCKET: "minih-updates",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ACCESS_KEY_ID/);
});

test("feeds that disagree on a version never reach the mirror", (t) => {
  const dir = fixture({ feeds: ["latest.yml"] });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "latest-linux.yml"), "version: 1.2.4\nfiles: []\n");
  const result = runMirror(dir, {
    MINIH_UPDATE_MIRROR_S3_BUCKET: "minih-updates",
    MINIH_UPDATE_MIRROR_S3_ACCESS_KEY_ID: "key",
    MINIH_UPDATE_MIRROR_S3_SECRET_ACCESS_KEY: "secret",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /disagree on version/);
});

test("a release without updater feeds never reaches the mirror", (t) => {
  const dir = fixture({ feeds: [] });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = runMirror(dir, {
    MINIH_UPDATE_MIRROR_S3_BUCKET: "minih-updates",
    MINIH_UPDATE_MIRROR_S3_ACCESS_KEY_ID: "key",
    MINIH_UPDATE_MIRROR_S3_SECRET_ACCESS_KEY: "secret",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no latest\*\.yml/);
});
