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
  REMOTE_UPDATE_SOURCES_DEFAULT_TTL_MS,
  REMOTE_UPDATE_SOURCES_MAX_TTL_MS,
  REMOTE_UPDATE_SOURCES_MIN_TTL_MS,
  REMOTE_UPDATE_SOURCES_PATH,
  REMOTE_UPDATE_SOURCES_URL_ENV,
  UPDATE_MIRRORS_ENV,
  configuredUpdateMirrors,
  githubReleaseFeedBase,
  officialUpdateSource,
  parseRemoteUpdateSources,
  parseRemoteUpdateSourcesTtl,
  parseUpdateMirrors,
  resolveUpdateSources,
  routerUpdateSourcesUrl,
} = await import("../electron/main/update-source.ts");
const { UPDATE_CHECK_TIMEOUT_CODE, isUpdateCheckTimeout, raceWithTimeout } =
  await import("../electron/main/update-timeout.ts");
const { UPDATER_SESSION_PARTITION } = await import("../electron/main/updater.ts");
const { readMainSource } = await import("./helpers/source-contracts.mjs");

const desktopRoot = join(here, "..");

/** Generic feed base a prefix-style accelerator expands to for this repo. */
const ACCELERATOR_BASE =
  "https://gh-proxy.org/https://github.com/minih-git/minih-agent-desktop/releases/latest/download";
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

test("accelerators are ordered before the official GitHub feed", () => {
  const sources = resolveUpdateSources("https://dl.example.com/minih,https://cdn.example.com:8443/u");
  assert.deepEqual(
    sources.map((source) => [source.kind, source.host]),
    [
      ["mirror", "dl.example.com"],
      ["mirror", "cdn.example.com:8443"],
      ["github", "github.com"],
    ],
  );
  assert.deepEqual(sources[0].feed, {
    provider: "generic",
    url: "https://dl.example.com/minih",
  });
  assert.deepEqual(sources.at(-1).feed, {
    provider: "github",
    owner: GITHUB_UPDATE_FEED.owner,
    repo: GITHUB_UPDATE_FEED.repo,
  });
});

test("router accelerators come first, then compiled mirrors, then the official feed", () => {
  const sources = resolveUpdateSources(
    "https://dl.example.com/minih",
    [ACCELERATOR_BASE, "https://ghfast.top/https://github.com/minih-git/minih-agent-desktop/releases/latest/download"],
  );
  assert.deepEqual(
    sources.map((source) => [source.kind, source.host]),
    [
      ["mirror", "gh-proxy.org"],
      ["mirror", "ghfast.top"],
      ["mirror", "dl.example.com"],
      ["github", "github.com"],
    ],
  );
  assert.deepEqual(sources[0].feed, { provider: "generic", url: ACCELERATOR_BASE });
});

test("the merged accelerator list stays capped, remote entries first", () => {
  const remote = Array.from(
    { length: MAX_UPDATE_MIRRORS + 1 },
    (_value, index) => `https://r${index}.example.com/https://github.com/minih-git/minih-agent-desktop/releases/latest/download`,
  );
  const sources = resolveUpdateSources(
    "https://dl.example.com/minih",
    remote.slice(0, MAX_UPDATE_MIRRORS),
  );
  assert.deepEqual(
    sources.map((source) => source.host),
    ["r0.example.com", "r1.example.com", "r2.example.com", "github.com"],
    "compiled mirrors never push the official feed past the cap",
  );
});

test("router payloads are parsed into generic feed bases", () => {
  const payload = {
    code: 0,
    message: "success",
    data: {
      sources: [
        { prefix: "https://gh-proxy.org/", label: "gh-proxy.org" },
        { prefix: "https://ghfast.top/", label: "ghfast.top" },
      ],
      ttl_seconds: 3600,
    },
  };
  assert.deepEqual(parseRemoteUpdateSources(payload), [
    ACCELERATOR_BASE,
    "https://ghfast.top/https://github.com/minih-git/minih-agent-desktop/releases/latest/download",
  ]);
  assert.equal(
    ACCELERATOR_BASE,
    githubReleaseFeedBase("https://gh-proxy.org/"),
    "the feed base is the accelerator prefix plus the GitHub release download root",
  );
  assert.equal(parseRemoteUpdateSourcesTtl(payload), 3_600_000);
});

test("unusable router entries are dropped on their own", () => {
  const payload = {
    data: {
      sources: [
        { prefix: "http://plain.example.com/" },
        { prefix: "https://user:secret@auth.example.com/" },
        { prefix: "https://query.example.com/?token=1" },
        { prefix: "https://github.com/" },
        { prefix: "not-a-url" },
        { prefix: 42 },
        { label: "no prefix" },
        null,
        { prefix: "https://gh-proxy.org/" },
        { prefix: "https://gh-proxy.org/" },
      ],
    },
  };
  assert.deepEqual(parseRemoteUpdateSources(payload), [ACCELERATOR_BASE]);
});

test("a payload that is not the router envelope yields no accelerator", () => {
  for (const payload of [
    undefined,
    null,
    42,
    "https://gh-proxy.org/",
    {},
    { data: null },
    { data: {} },
    { data: { sources: "https://gh-proxy.org/" } },
    { data: { sources: [] } },
  ]) {
    assert.deepEqual(parseRemoteUpdateSources(payload), [], JSON.stringify(payload));
  }
  assert.equal(
    parseRemoteUpdateSourcesTtl({ data: { sources: [] } }),
    REMOTE_UPDATE_SOURCES_DEFAULT_TTL_MS,
  );
});

test("a published TTL is clamped to a sane window", () => {
  assert.equal(
    parseRemoteUpdateSourcesTtl({ data: { sources: [], ttl_seconds: 1 } }),
    REMOTE_UPDATE_SOURCES_MIN_TTL_MS,
  );
  assert.equal(
    parseRemoteUpdateSourcesTtl({ data: { sources: [], ttl_seconds: 30 * 24 * 3600 } }),
    REMOTE_UPDATE_SOURCES_MAX_TTL_MS,
  );
  assert.equal(
    parseRemoteUpdateSourcesTtl({ data: { sources: [], ttl_seconds: "3600" } }),
    REMOTE_UPDATE_SOURCES_DEFAULT_TTL_MS,
  );
});

test("a hungraim build keeps its own feed and ignores the router list", () => {
  globalThis.__DESKTOP_BRAND__ = "hungraim";
  try {
    assert.deepEqual(
      resolveUpdateSources(undefined, [ACCELERATOR_BASE]),
      [],
      "the packaged generic feed needs no explicit source",
    );
    assert.deepEqual(
      resolveUpdateSources("https://dl.example.com/minih", [ACCELERATOR_BASE]).map(
        (source) => [source.kind, source.host],
      ),
      [["mirror", "dl.example.com"]],
    );
  } finally {
    delete globalThis.__DESKTOP_BRAND__;
  }
});

test("the accelerator list URL follows the brand router and the override", () => {
  assert.equal(
    routerUpdateSourcesUrl({}),
    `https://router.hmini.org${REMOTE_UPDATE_SOURCES_PATH}`,
  );
  assert.equal(
    routerUpdateSourcesUrl({
      [REMOTE_UPDATE_SOURCES_URL_ENV]: "  http://127.0.0.1:3001/api/desktop-update  ",
    }),
    "http://127.0.0.1:3001/api/desktop-update",
  );
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

test("the official feed is available as an explicit source, and never for hungraim", () => {
  assert.deepEqual(officialUpdateSource(), {
    kind: "github",
    host: "github.com",
    feed: {
      provider: "github",
      owner: GITHUB_UPDATE_FEED.owner,
      repo: GITHUB_UPDATE_FEED.repo,
    },
  });
  globalThis.__DESKTOP_BRAND__ = "hungraim";
  try {
    assert.equal(
      officialUpdateSource(),
      null,
      "a brand whose packaged feed is generic keeps that feed",
    );
  } finally {
    delete globalThis.__DESKTOP_BRAND__;
  }
});
