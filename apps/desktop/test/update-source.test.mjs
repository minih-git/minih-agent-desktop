import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
register(pathToFileURL(join(here, "helpers/updater-module-stubs.mjs")));

const {
  GITHUB_UPDATE_FEED,
  MAX_UPDATE_MIRRORS,
  UPDATE_MIRRORS_ENV,
  configuredUpdateMirrors,
  parseUpdateMirrors,
  resolveUpdateSources,
} = await import("../electron/main/update-source.ts");
const { UPDATE_CHECK_TIMEOUT_CODE, isUpdateCheckTimeout, raceWithTimeout } =
  await import("../electron/main/update-timeout.ts");
const { UPDATER_SESSION_PARTITION } = await import("../electron/main/updater.ts");
const { readMainSource } = await import("./helpers/source-contracts.mjs");

const desktopRoot = join(here, "..");

test("mirror entries are validated, normalized and capped", () => {
  const parsed = parseUpdateMirrors(
    [
      " https://dl.example.com/minih/ ",
      "https://dl.example.com/minih/",
      "http://plain.example.com/updates",
      "https://user:secret@auth.example.com/updates",
      "https://query.example.com/updates?token=1",
      "https://github.com/minih-git/minih-agent-desktop/releases/download",
      "not-a-url",
      "https://cdn.example.com/a/b/",
      ...Array.from(
        { length: MAX_UPDATE_MIRRORS + 1 },
        (_value, index) => `https://extra${index}.example.com/updates`,
      ),
    ].join(","),
  );
  assert.equal(parsed.mirrors.length, MAX_UPDATE_MIRRORS);
  assert.deepEqual(
    parsed.rejected
      .filter((entry) => entry.reason.startsWith("more than"))
      .map((entry) => entry.value),
    ["https://extra1.example.com/updates", "https://extra2.example.com/updates", "https://extra3.example.com/updates"],
  );
  assert.deepEqual(
    parsed.rejected
      .filter((entry) => !entry.reason.startsWith("more than"))
      .map((entry) => entry.reason),
    [
      "must use https",
      "must not carry credentials",
      "must not carry a query or fragment",
      "duplicates the packaged GitHub feed",
      "not an absolute URL",
    ],
  );
});

test("an empty build keeps the packaged feed as the only source", () => {
  for (const configured of [undefined, null, "", "   ", [], 42]) {
    const sources = resolveUpdateSources(configured);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].kind, "packaged");
    assert.equal(sources[0].host, "github.com");
    assert.equal(sources[0].feed, undefined, "the packaged feed is never overridden");
  }
});

test("configured mirrors are ordered after an explicit GitHub feed", () => {
  const sources = resolveUpdateSources("https://dl.example.com/minih,https://cdn.example.com:8443/u");
  assert.deepEqual(
    sources.map((source) => [source.kind, source.host]),
    [
      ["github", "github.com"],
      ["mirror", "dl.example.com"],
      ["mirror", "cdn.example.com:8443"],
    ],
  );
  assert.deepEqual(sources[0].feed, {
    provider: "github",
    owner: GITHUB_UPDATE_FEED.owner,
    repo: GITHUB_UPDATE_FEED.repo,
  });
  assert.deepEqual(sources[1].feed, {
    provider: "generic",
    url: "https://dl.example.com/minih",
  });
});

test("the compiled GitHub coordinates match the shipped feed files", () => {
  const packaged = JSON.parse(
    readFileSync(join(desktopRoot, "package.json"), "utf8"),
  );
  const publish = packaged.build.publish.find((entry) => entry.provider === "github");
  assert.deepEqual(
    { owner: publish.owner, repo: publish.repo },
    { owner: GITHUB_UPDATE_FEED.owner, repo: GITHUB_UPDATE_FEED.repo },
    "update-source.ts must match apps/desktop/package.json build.publish",
  );

  const appUpdateYml = readFileSync(join(desktopRoot, "resources/app-update.yml"), "utf8");
  const field = (name) => appUpdateYml.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1].trim();
  assert.equal(field("provider"), "github");
  assert.equal(field("owner"), GITHUB_UPDATE_FEED.owner);
  assert.equal(field("repo"), GITHUB_UPDATE_FEED.repo);
});

test("the updater session partition mirrors electron-updater's own name", () => {
  const require = createRequire(import.meta.url);
  const executor = join(
    dirname(require.resolve("electron-updater")),
    "electronHttpExecutor.js",
  );
  const source = readFileSync(executor, "utf8");
  const declared = source.match(/NET_SESSION_NAME = "([^"]+)"/)?.[1];
  assert.equal(
    UPDATER_SESSION_PARTITION,
    declared,
    "registration must target the partition electron-updater requests on",
  );
});

test("main registers the updater session with the proxy module", async () => {
  const main = await readMainSource();
  assert.match(main, /registerNetworkProxySession\(UPDATER_SESSION_PARTITION/);
test("the mirror list stays a build-time input", () => {
  assert.equal(UPDATE_MIRRORS_ENV, "MAIN_VITE_MINIH_AGENT_UPDATE_MIRRORS");
  const source = readFileSync(join(desktopRoot, "electron/main/update-source.ts"), "utf8");
  assert.match(source, /import\.meta/);
  assert.match(source, /setFeedURL|UpdateFeed/, "the feed is applied in Main");
  assert.equal(configuredUpdateMirrors(), undefined, "absent under plain Node");
});
});

test("timeout detection stays with the bounded wait", async () => {
  const timeout = await raceWithTimeout(
    new Promise(() => undefined),
    5,
    "probe",
  ).catch((error) => error);
  assert.equal(timeout.code, UPDATE_CHECK_TIMEOUT_CODE);
  assert.equal(isUpdateCheckTimeout(timeout), true);
  assert.equal(isUpdateCheckTimeout(new Error("nope")), false);
  assert.equal(isUpdateCheckTimeout(undefined), false);
});
