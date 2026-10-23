/**
 * Interactive shell catalog for the terminal plugin.
 *
 * Only programs that are actually installed are offered, and none of them is
 * discovered by sourcing a startup or profile file: the list is a fixed set of
 * well-known install paths plus the user's own login shell. A profile that
 * disappears between listing and opening fails with the missing path instead of
 * silently running something else, because a substituted shell changes what the
 * user's commands mean.
 *
 * These are interactive shells. They are deliberately unrelated to the Agent's
 * non-interactive command shell: nothing here adds `-NonInteractive`, `-c`, or
 * any other flag that would change the Agent's defaults.
 */
const { statSync } = require("node:fs");

/** @typedef {{ id: string, label: string, file: string, args: string[] }} ShellProfile */

function fileExists(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The program name of a path. Both separators are honoured because the Windows
 * catalog is built and (in tests) read on every platform.
 */
function programName(file) {
  const parts = String(file).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? String(file);
}

/** A profile id from a program name: stable, lowercase, no path. */
function profileId(file, taken) {
  const base = programName(file)
    .toLowerCase()
    .replace(/\.exe$/, "");
  const slug = base.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "shell";
  return taken.has(slug) ? null : slug;
}

/**
 * Build the profile list for one platform.
 *
 * `isFile` is injected so tests can describe a machine without creating it, and
 * `env` / `platform` are injected for the same reason.
 */
function detectShellProfiles({
  platform = process.platform,
  env = process.env,
  isFile = fileExists,
} = {}) {
  const candidates =
    platform === "win32" ? windowsCandidates(env) : posixCandidates(platform, env);
  /** @type {ShellProfile[]} */
  const profiles = [];
  const taken = new Set();
  for (const file of candidates) {
    if (!file || !isFile(file)) continue;
    const id = profileId(file, taken);
    // Two installs of one shell (`/bin/bash` and Homebrew's) resolve to the same
    // id; the first is the one the platform would run, so later copies are
    // dropped rather than offered under a made-up name.
    if (!id) continue;
    taken.add(id);
    profiles.push({ id, label: programName(file), file, args: [] });
  }
  return profiles;
}

function posixCandidates(platform, env) {
  const candidates = [];
  const loginShell = typeof env.SHELL === "string" ? env.SHELL.trim() : "";
  if (loginShell) candidates.push(loginShell);
  if (platform === "darwin") {
    candidates.push(
      "/bin/zsh",
      "/bin/bash",
      "/opt/homebrew/bin/bash",
      "/usr/local/bin/bash",
      "/usr/local/bin/zsh",
      "/usr/local/bin/fish",
      "/opt/homebrew/bin/fish",
      "/bin/sh",
    );
  } else {
    candidates.push(
      "/bin/bash",
      "/usr/bin/bash",
      "/usr/bin/zsh",
      "/bin/zsh",
      "/usr/bin/fish",
      "/usr/local/bin/fish",
      "/bin/sh",
    );
  }
  return candidates;
}

function windowsCandidates(env) {
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const systemRoot = env.SystemRoot || env.windir || "C:\\Windows";
  const localAppData = env.LOCALAPPDATA || "";
  const candidates = [
    `${programFiles}\\PowerShell\\7\\pwsh.exe`,
    `${programFiles}\\PowerShell\\7-preview\\pwsh.exe`,
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    `${systemRoot}\\System32\\cmd.exe`,
    `${programFiles}\\Git\\bin\\bash.exe`,
  ];
  if (localAppData) candidates.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`);
  return candidates;
}

/** The profile a new terminal starts with when the user names none. */
function defaultProfile(profiles) {
  return profiles[0] ?? null;
}

/** Look a profile up by id, or answer `null` for an id this machine lost. */
function findProfile(profiles, id) {
  if (!id) return defaultProfile(profiles);
  return profiles.find((profile) => profile.id === id) ?? null;
}

/**
 * Whether a directory can host a local shell. Used to keep a remote project path
 * from being treated as a local directory: the path is only accepted when it
 * exists here.
 */
function isLocalDirectory(path, isDirectory = (target) => {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}) {
  return typeof path === "string" && path.length > 0 && isDirectory(path);
}

module.exports = {
  detectShellProfiles,
  defaultProfile,
  findProfile,
  isLocalDirectory,
};
