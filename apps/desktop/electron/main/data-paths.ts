import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { currentBrandProfile, type BrandName } from "@minih-agent/shared";

/**
 * The two directories that define an installation, and the development split
 * between them.
 *
 * A packaged desktop app and a `pnpm dev` host used to share both: the
 * name-derived `userData` — where Electron keeps the single-instance lock,
 * renderer `localStorage`, and the plugin panel partitions — and the data root
 * below the user's home, where host-core keeps `pi.sqlite` beside the
 * persistence outbox and the log tree. Sharing them meant a shipped app that
 * was already running held the lock, so the development launch quit on arrival;
 * a development host that won the race instead put a second host-core over the
 * same single-writer database, which is the divergence D236 exists to
 * prevent. Neither is workable while someone debugs against the app they use.
 *
 * Only the development side moves, and only these two names differ. The names
 * come from the brand profile, so `DESKTOP_BRAND=hungraim` builds own
 * `~/.hungraim-agent-desktop` instead of the minih root and the two brands can
 * sit side by side. The minih names are unchanged, so no upgrade relocates a
 * user's database, secrets, plugins, or renderer-local state.
 */

/** `MINIH_AGENT_DATA_DIR`: the minih override and the cross-brand channel. */
export const DATA_DIR_OVERRIDE_ENV = "MINIH_AGENT_DATA_DIR";
/** `HUNGRAIM_AGENT_DATA_DIR`: the hungraim brand's own override. */
export const HUNGRAIM_DATA_DIR_OVERRIDE_ENV = "HUNGRAIM_AGENT_DATA_DIR";

/** The brand this bundle resolves installation names for. */
const brand = currentBrandProfile();

/** Data directory of a shipped installation, below the user's home. */
export const INSTALLATION_DATA_DIR_NAME = brand.dataDirName;

/** Data directory of a development installation, below the user's home. */
export const DEVELOPMENT_DATA_DIR_NAME = brand.devDataDirName;

/** `userData` directory of a development installation, beside the shipped one. */
export const DEVELOPMENT_INSTALLATION_NAME = brand.devInstallationName;

/**
 * Environment variables that may override the data root, highest priority
 * first. A hungraim build reads its own variable before the minih one, which
 * stays a compatibility channel for pre-branding harnesses and child
 * processes; a minih build reads only `MINIH_AGENT_DATA_DIR`, exactly as
 * before.
 */
export function dataDirOverrideEnvNames(brandName: BrandName = brand.name): string[] {
  return brandName === "hungraim"
    ? [HUNGRAIM_DATA_DIR_OVERRIDE_ENV, DATA_DIR_OVERRIDE_ENV]
    : [DATA_DIR_OVERRIDE_ENV];
}

/**
 * The explicit data-root override in `env`, or undefined.
 *
 * A blank value is unset: every call site this replaced treated an empty
 * `MINIH_AGENT_DATA_DIR=` as absent, which is what keeps it from naming a
 * relative directory.
 */
export function dataDirOverrideFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  brandName: BrandName = brand.name,
): string | undefined {
  for (const name of dataDirOverrideEnvNames(brandName)) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Remove every override variable this brand may have been given. */
export function clearDataDirOverride(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of dataDirOverrideEnvNames(brand.name)) delete env[name];
}

export type DataDirInput = {
  /** Explicit directory; wins over either profile. */
  override: string | undefined;
  /** True for a development build. */
  development: boolean;
  /** The user's home directory. */
  home: string;
};

/**
 * The data directory one installation owns.
 *
 * An explicit directory wins, which is how the E2E harnesses, the capture rig,
 * and side-by-side profiles keep choosing their own root. The result is
 * absolute, because it reaches host-core as a child-process environment
 * variable from a working directory that need not be this one, and because
 * `homedir()` is the only other input that could be relative. Without an
 * override the profile picks the name, and that name is the whole difference
 * between the two installations.
 */
export function resolveDataDir({
  override,
  development,
  home,
}: DataDirInput): string {
  const explicit = override?.trim();
  if (explicit) return resolve(explicit);
  return resolve(
    join(
      home,
      development ? DEVELOPMENT_DATA_DIR_NAME : INSTALLATION_DATA_DIR_NAME,
    ),
  );
}

/**
 * The data directory this process owns.
 *
 * Electron main passes its own verdict for `development`, because only it can
 * ask `app.isPackaged`, and it publishes the resolved directory back to
 * `MINIH_AGENT_DATA_DIR` at boot. That publication is what keeps the plugin
 * runtime — which resolves this root from the environment rather than taking
 * it as a parameter — on one directory instead of falling back to the shipped
 * default, which would strand a development host's plugin data inside the
 * packaged profile.
 */
export function desktopDataDir(
  development: boolean = process.env.MINIH_AGENT_DEV === "1",
): string {
  return resolveDataDir({
    override: dataDirOverrideFromEnv(),
    development,
    home: homedir(),
  });
}

/** The Electron `app` surface this helper needs; kept structural so tests need no Electron. */
export type UserDataApp = {
  commandLine: { hasSwitch(name: string): boolean };
  getPath(name: "appData"): string;
  setPath(name: "userData", path: string): void;
};

/**
 * Give a development build its own `userData` so the single-instance lock
 * does not collide with a shipped app that is already running (D236, ADR 0094).
 * An explicit `--user-data-dir` wins, because that is how the E2E harnesses
 * point a build at a throwaway profile.
 */
export function applyDevelopmentUserData(
  app: UserDataApp,
  development: boolean,
): void {
  if (development && !app.commandLine.hasSwitch("user-data-dir")) {
    app.setPath(
      "userData",
      join(app.getPath("appData"), DEVELOPMENT_INSTALLATION_NAME),
    );
  }
}
