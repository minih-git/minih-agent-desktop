/**
 * Which `node-pty` native assets a package carries, and whether that is enough.
 *
 * The selection is a pure function of file names so the tests can describe a fake
 * package — a folder per platform, a local `build/Release` — without being on
 * those platforms. It decides nothing about whether a binary *runs*; that can
 * only be established on the machine itself.
 */

/** Files the runtime genuinely loads, per platform. */
export const REQUIRED_PREBUILDS = {
  "darwin-arm64": ["pty.node", "spawn-helper"],
  "darwin-x64": ["pty.node", "spawn-helper"],
  "win32-x64": [
    "conpty.node",
    "conpty_console_list.node",
    "pty.node",
    "conpty/conpty.dll",
    "conpty/OpenConsole.exe",
  ],
  "win32-arm64": [
    "conpty.node",
    "conpty_console_list.node",
    "pty.node",
    "conpty/conpty.dll",
    "conpty/OpenConsole.exe",
  ],
  "linux-x64": ["pty.node"],
  "linux-arm64": ["pty.node"],
};

/** Every platform this plugin is meant to ship for. */
export const RELEASE_PLATFORMS = Object.keys(REQUIRED_PREBUILDS);

/** Treat `win32-x64`-style ids as the supported key, or `null`. */
export function normalizePlatform(fileName) {
  return Object.hasOwn(REQUIRED_PREBUILDS, fileName) ? fileName : null;
}

/**
 * Debug symbols and the legacy winpty shim are not loaded by a modern Windows
 * (`conpty` is), so they are not worth the archive bytes.
 */
export function isPruned(file) {
  return file.endsWith(".pdb") || /(^|\/)winpty[^/]*$/.test(file);
}

/** Files under one platform that are kept and that the runtime needs. */
function platformFiles(files) {
  return files.filter((file) => !isPruned(file));
}

function missingFiles(keep, platform) {
  return REQUIRED_PREBUILDS[platform].filter((file) => !keep.includes(file));
}

/**
 * Plan the native payload of one package.
 *
 * - `prebuilds` maps a platform id to the files inside its `prebuilds/<id>`
 *   folder, exactly as `node-pty` ships them.
 * - `localBuild` is `{ platform, files }` for a `node-pty/build/Release` built
 *   from source on this machine (the documented Linux path). It only fills the
 *   host's own platform: a build can be compiled for the machine it runs on, not
 *   for another one.
 *
 * Returns the platforms the package can carry, and the ones it cannot, with the
 * files each of those is missing.
 */
export function planNativeAssets({ prebuilds = {}, localBuild = null } = {}) {
  const platforms = [];
  const missing = [];

  for (const platform of RELEASE_PLATFORMS) {
    const shipped = prebuilds[platform];
    const keep = shipped ? platformFiles(shipped) : [];
    const absent = missingFiles(keep, platform);
    if (shipped && absent.length === 0) {
      platforms.push({ platform, files: keep, source: "prebuild" });
      continue;
    }

    const buildable =
      localBuild &&
      normalizePlatform(localBuild.platform) === platform &&
      missingFiles(platformFiles(localBuild.files), platform).length === 0;
    if (buildable) {
      platforms.push({
        platform,
        files: platformFiles(localBuild.files),
        source: "local-build",
      });
      continue;
    }

    missing.push({ platform, files: absent.length > 0 ? absent : REQUIRED_PREBUILDS[platform] });
  }

  return { platforms, missing };
}

/**
 * Whether this plan may be called a package for `required` platforms.
 *
 * A development package may legitimately carry a subset; a release package may
 * not, and the caller turns the answer into an exit code.
 */
export function unmetPlatforms(plan, required) {
  const carried = new Set(plan.platforms.map((entry) => entry.platform));
  return required.filter((platform) => !carried.has(platform));
}
