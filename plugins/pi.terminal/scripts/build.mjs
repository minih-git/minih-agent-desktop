#!/usr/bin/env node
/**
 * Assemble the installable terminal plugin.
 *
 * The plugin ships its native and browser assets inside the package, because the
 * host never runs `npm install`, a build toolchain, or downloaded code when a
 * user enables it. This script therefore:
 *
 * 1. copies the plugin's own sources into `dist/`,
 * 2. copies xterm.js and its two addons from `node_modules` into `dist/view/vendor`,
 * 3. stages the pinned `node-pty` runtime plus the prebuilt binaries it can find
 *    into `dist/vendor/node-pty`, and
 * 4. reports exactly which platforms the result can run on.
 *
 * Two modes, because "it built" and "it is deliverable" are different claims:
 *
 *   node scripts/build.mjs                       development package
 *   node scripts/build.mjs --require-platforms linux-x64,linux-arm64
 *                                                release package; exit 1 if any
 *                                                required platform has no assets
 *
 * A development package may carry a subset — that is what a machine without a
 * Linux toolchain produces — but it is printed as a subset and never described
 * as a three-platform delivery. `pack:release` refuses instead of producing it.
 */
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_PLATFORMS,
  isPruned,
  planNativeAssets,
  unmetPlatforms,
} from "./native-assets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const modules = join(root, "node_modules");

/** Files copied verbatim from the source tree. */
const SOURCES = ["manifest.json", "main.js", "lib", "view"];

/** xterm asset: source, then destination inside `dist/view/vendor`. */
const VIEW_ASSETS = [
  ["@xterm/xterm/lib/xterm.js", "xterm.js"],
  ["@xterm/xterm/css/xterm.css", "xterm.css"],
  ["@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
  ["@xterm/addon-search/lib/addon-search.js", "addon-search.js"],
];

const report = { copied: 0, bytes: 0 };

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/**
 * Copy one file.
 *
 * node-pty's macOS `spawn-helper` arrives without its executable bit from some
 * stores and package managers, and a helper that cannot be executed fails the
 * spawn with a bare "posix_spawnp failed". Any file that is executable at the
 * source keeps that bit here, which is what makes the packaged helper runnable.
 */
function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  if (statSync(from).mode & 0o111) chmodSync(to, 0o755);
  report.copied += 1;
  report.bytes += statSync(to).size;
}

function copyTree(from, to, skip = () => false) {
  for (const file of walk(from)) {
    if (skip(file)) continue;
    copy(file, join(to, relative(from, file)));
  }
}

function relativeFiles(dir) {
  return walk(dir).map((file) => relative(dir, file).split(sep).join("/"));
}

// --- sources and browser assets -------------------------------------------

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const entry of SOURCES) {
  const source = join(root, "src", entry);
  const target = join(dist, entry);
  if (statSync(source).isDirectory()) copyTree(source, target);
  else copy(source, target);
}

for (const [source, name] of VIEW_ASSETS) {
  copy(join(modules, source), join(dist, "view", "vendor", name));
}

// --- native payload -------------------------------------------------------

const pty = join(modules, "node-pty");
copy(join(pty, "package.json"), join(dist, "vendor", "node-pty", "package.json"));
copyTree(join(pty, "lib"), join(dist, "vendor", "node-pty", "lib"), (file) =>
  file.endsWith(".map") || file.endsWith(".test.js"),
);

const prebuildsRoot = join(pty, "prebuilds");
const prebuilds = {};
if (statSync(prebuildsRoot, { throwIfNoEntry: false })?.isDirectory()) {
  for (const entry of readdirSync(prebuildsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    prebuilds[entry.name] = relativeFiles(join(prebuildsRoot, entry.name));
  }
}

// A `node-pty` compiled on this machine (`npm_config_build_from_source=1`) lands
// in `build/Release`. That is the documented Linux path, so it counts as this
// host's own platform when no prebuild exists for it.
const releaseRoot = join(pty, "build", "Release");
const localBuild = statSync(releaseRoot, { throwIfNoEntry: false })?.isDirectory()
  ? { platform: `${process.platform}-${process.arch}`, files: relativeFiles(releaseRoot) }
  : null;

const plan = planNativeAssets({ prebuilds, localBuild });

for (const entry of plan.platforms) {
  const from = entry.source === "prebuild" ? join(prebuildsRoot, entry.platform) : releaseRoot;
  const to = join(dist, "vendor", "node-pty", "prebuilds", entry.platform);
  for (const file of entry.files) copy(join(from, file), join(to, file));
  // node-pty executes this helper directly to fork the pty on macOS.
  try {
    chmodSync(join(to, "spawn-helper"), 0o755);
  } catch {
    // Only macOS carries a helper; every other platform has none.
  }
  if (entry.source === "local-build") {
    process.stdout.write(`  packaged ${entry.platform} from this machine's build/Release\n`);
  }
}

// --- verify and report ----------------------------------------------------

const required = [
  "manifest.json",
  "main.js",
  "lib/terminal-engine.js",
  "lib/shells.js",
  "view/index.html",
  "view/terminal.js",
  "view/terminal.css",
  "view/vendor/xterm.js",
  "view/vendor/xterm.css",
  "view/vendor/addon-fit.js",
  "view/vendor/addon-search.js",
  "vendor/node-pty/package.json",
  "vendor/node-pty/lib/index.js",
];
const absent = required.filter((file) => !statSync(join(dist, file), { throwIfNoEntry: false })?.isFile());
if (absent.length > 0) {
  process.stderr.write(`build failed, missing: ${absent.join(", ")}\n`);
  process.exit(1);
}

const carried = plan.platforms.map((entry) => entry.platform);
const megabytes = (report.bytes / 1024 / 1024).toFixed(2);
process.stdout.write(
  `pi.terminal: ${report.copied} files, ${megabytes} MB, PTY platforms: ${carried.join(", ") || "none"}\n`,
);
for (const entry of plan.missing) {
  process.stdout.write(`  missing ${entry.platform}: ${entry.files.join(", ")}\n`);
}

// --- release gate ---------------------------------------------------------

const flagIndex = process.argv.indexOf("--require-platforms");
if (flagIndex >= 0) {
  const requested = String(process.argv[flagIndex + 1] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unknown = requested.filter((platform) => !RELEASE_PLATFORMS.includes(platform));
  if (requested.length === 0 || unknown.length > 0) {
    process.stderr.write(
      `--require-platforms needs known ids (${RELEASE_PLATFORMS.join(", ")}); got ${requested.join(", ") || "nothing"}\n`,
    );
    rmSync(dist, { recursive: true, force: true });
    process.exit(1);
  }
  const unmet = unmetPlatforms(plan, requested);
  if (unmet.length > 0) {
    process.stderr.write(
      `release package refused: no PTY assets for ${unmet.join(", ")}. This build cannot be shipped as a package for those platforms — build node-pty from source on each of them (npm_config_build_from_source=1 pnpm rebuild node-pty) and re-run there.\n`,
    );
    rmSync(dist, { recursive: true, force: true });
    process.exit(1);
  }
  process.stdout.write(`release package: every required platform is present (${requested.join(", ")})\n`);
} else if (plan.missing.length > 0) {
  process.stdout.write(
    "  this is a development package for a platform subset, not a three-platform delivery\n",
  );
}

// Debug symbols and the winpty shim are the only files intentionally dropped.
void isPruned;
