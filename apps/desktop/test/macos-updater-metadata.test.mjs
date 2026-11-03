import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = await readFile(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");
const body = workflow.match(/ruby <<'RUBY'\n([\s\S]*?)\n          RUBY/)?.[1];
assert.ok(body, "the production macOS metadata merge step exists");
const script = body.split("\n").map((line) => line.replace(/^          /, "")).join("\n");
const sha512 = (bytes) => createHash("sha512").update(bytes).digest("base64");
const rubyAvailable = !spawnSync("ruby", ["--version"], { encoding: "utf8" }).error;

async function fixture(t) {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "mac-release-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originals = new Map();
  for (const arch of ["arm64", "x64"]) {
    const files = [];
    for (const suffix of ["-mac.zip", ".dmg"]) {
      const name = `Minih-Agent-Desktop-1.3.0-${arch}${suffix}`;
      const bytes = Buffer.from(`${arch}${suffix}: signed package`);
      await writeFile(join(root, name), bytes);
      originals.set(name, bytes);
      files.push({ url: name, size: bytes.length, sha512: sha512(bytes) });
    }
    await writeFile(join(root, `latest-mac-${arch}.yml`), JSON.stringify({
      version: "1.3.0", files, path: files[0].url, sha512: files[0].sha512,
    }));
  }
  return { root, originals };
}

function merge(root) {
  return spawnSync("ruby", ["-e", script], { cwd: root, encoding: "utf8", timeout: 30_000 });
}

function readFeed(root) {
  const result = spawnSync("ruby", ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load(File.read('latest-mac.yml'), permitted_classes: [], aliases: false))"], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("published macOS metadata hashes final stapled DMGs and both unchanged ZIPs", { skip: !rubyAvailable }, async (t) => {
  const { root, originals } = await fixture(t);
  for (const name of originals.keys()) {
    if (name.endsWith(".dmg")) await appendFile(join(root, name), "\nApple notarization ticket");
  }
  const result = merge(root);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const feed = readFeed(root);
  assert.equal(feed.version, "1.3.0");
  assert.equal(feed.files.length, 4);
  for (const file of feed.files) {
    const bytes = await readFile(join(root, file.url));
    assert.equal(file.size, bytes.length, `${file.url} must use the final size`);
    assert.equal(file.sha512, sha512(bytes), `${file.url} must use the final hash`);
    if (file.url.endsWith(".zip")) assert.deepEqual(bytes, originals.get(file.url));
  }
  assert.ok(feed.path.endsWith(".zip"));
  assert.equal(feed.sha512, sha512(await readFile(join(root, feed.path))));
});

test("publication refuses metadata whose final installer is absent", { skip: !rubyAvailable }, async (t) => {
  const { root } = await fixture(t);
  await unlink(join(root, "Minih-Agent-Desktop-1.3.0-x64.dmg"));
  assert.notEqual(merge(root).status, 0, "a missing artifact must not produce a publishable feed");
});

test("publication refuses an installer reference outside the artifact directory", { skip: !rubyAvailable }, async (t) => {
  const { root } = await fixture(t);
  const path = join(root, "latest-mac-x64.yml");
  const feed = JSON.parse(await readFile(path, "utf8"));
  feed.files[1].url = "../outside.dmg";
  await writeFile(path, JSON.stringify(feed));
  assert.notEqual(merge(root).status, 0, "feed entries cannot name paths outside the artifact directory");
});
