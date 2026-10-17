/**
 * Dual-brand build profiles (minih default, hungraim secondary).
 *
 * One build-time variable — `DESKTOP_BRAND` — selects every user-visible
 * identity coordinate: product name, application ID, data directories, update
 * feed, `agent-host-cli` download base, and the Minih Router / EasyTier
 * network defaults. The table below is the single source of truth; the
 * electron.vite config injects the brand into the Main and renderer bundles
 * as `__DESKTOP_BRAND__`, and the Rust host-core reads the same variable via
 * `option_env!`.
 *
 * The default brand (`minih`) must stay behaviorally identical to the
 * pre-branding release: same product name, same `~/.minih-agent-desktop`
 * data root, same GitHub update feed, same Router and EasyTier defaults.
 */

export type BrandName = "minih" | "hungraim";

/**
 * Build-time brand injection (electron.vite `define` for Main and renderer).
 * Ambient so plain Node — where the global does not exist — still typechecks;
 * `typeof` keeps the runtime read safe when the binding is absent.
 */
declare const __DESKTOP_BRAND__: string | undefined;

export type BrandUpdateFeed =
  | { provider: "github"; owner: string; repo: string }
  | { provider: "generic"; url: string };

export type BrandProfile = {
  name: BrandName;
  /** Window titles, tray tooltip, About panel, crash reporter product name. */
  productName: string;
  /** Windows AppUserModelID / packaged application ID. */
  appId: string;
  /** Shipped data root below the user's home, e.g. `~/.minih-agent-desktop`. */
  dataDirName: string;
  /** Development data root below the user's home. */
  devDataDirName: string;
  /** `userData` directory name of a development installation. */
  devInstallationName: string;
  /** Environment variable that overrides the data root outright. */
  dataDirOverrideEnv: string;
  /**
   * Legacy override variable still honored after the brand's own variable,
   * so pre-branding tooling keeps pointing a hungraim build at a directory.
   */
  compatDataDirOverrideEnv?: string;
  /** electron-updater feed compiled into the packaged `app-update.yml`. */
  updateFeed: BrandUpdateFeed;
  /** Page the "check for updates" surface opens in a browser. */
  releasesUrl: string;
  /**
   * `agent-host-cli` bundle download base; the tarball and its checksum live
   * at `<base>/v<version>/<name>`.
   */
  agentHostCliDownloadBase: string;
  /** Default public Minih Router deployment for a fresh provider row. */
  routerDefaultBaseUrl: string;
  /** Built-in EasyTier virtual LAN defaults. */
  easyTierNetworkName: string;
  easyTierPeers: readonly string[];
  easyTierRouterLanUrl: string;
};

const HUNGRAIM_UPDATE_FEED_URL = "https://updates.hungraim.com/desktop/stable";

export const BRAND_PROFILES: Record<BrandName, BrandProfile> = {
  minih: {
    name: "minih",
    productName: "Minih-Agent-Desktop",
    appId: "org.hmini.agent",
    dataDirName: ".minih-agent-desktop",
    devDataDirName: ".minih-agent-desktop-dev",
    devInstallationName: "Minih-Agent-Desktop Dev",
    dataDirOverrideEnv: "MINIH_AGENT_DATA_DIR",
    updateFeed: { provider: "github", owner: "minih-git", repo: "minih-agent-desktop" },
    releasesUrl: "https://github.com/minih-git/minih-agent-desktop/releases/latest",
    agentHostCliDownloadBase:
      "https://github.com/minih-git/minih-agent-desktop/releases/download",
    routerDefaultBaseUrl: "https://router.hmini.org/v1",
    easyTierNetworkName: "minih-router",
    easyTierPeers: [
      "udp://router.hmini.org:11012",
      "tcp://router.hmini.org:11012",
    ],
    easyTierRouterLanUrl: "http://11.12.0.1:3001/v1",
  },
  hungraim: {
    name: "hungraim",
    productName: "Hungraim-Agent-Desktop",
    appId: "com.hungraim.agent",
    dataDirName: ".hungraim-agent-desktop",
    devDataDirName: ".hungraim-agent-desktop-dev",
    devInstallationName: "Hungraim-Agent-Desktop Dev",
    // The brand's own variable wins; the minih variable stays a compatibility
    // channel so pre-branding harnesses and child processes keep working.
    dataDirOverrideEnv: "HUNGRAIM_AGENT_DATA_DIR",
    compatDataDirOverrideEnv: "MINIH_AGENT_DATA_DIR",
    updateFeed: { provider: "generic", url: HUNGRAIM_UPDATE_FEED_URL },
    releasesUrl: "https://updates.hungraim.com/desktop/",
    agentHostCliDownloadBase: "https://updates.hungraim.com/desktop/agent-host-cli",
    routerDefaultBaseUrl: "https://aiapi.hungraim.com/v1",
    easyTierNetworkName: "hungraim-router",
    easyTierPeers: [
      "udp://router-mesh.hungraim.com:11023",
      "tcp://router-mesh.hungraim.com:11023",
    ],
    easyTierRouterLanUrl: "http://11.123.0.1:3001/v1",
  },
} as const;

/** Environment variables a build may name the brand with, highest priority first. */
const BRAND_ENV_KEYS = [
  "DESKTOP_BRAND",
  "MAIN_VITE_DESKTOP_BRAND",
  "VITE_DESKTOP_BRAND",
] as const;

const DEFAULT_BRAND: BrandName = "minih";

/**
 * Resolve the brand from the first environment entry that names one.
 *
 * Unknown or empty values fall back to `minih` — a typo must never strand a
 * build without an identity, and the default brand must stay byte-compatible
 * with the pre-branding release.
 */
export function resolveBrandName(read: (key: string) => string | undefined): BrandName {
  for (const key of BRAND_ENV_KEYS) {
    const value = read(key)?.trim().toLowerCase();
    if (value === "minih" || value === "hungraim") return value;
  }
  return DEFAULT_BRAND;
}

/** The brand profile for `name`; unknown names resolve to the default. */
export function brandProfileFor(name: string | undefined | null): BrandProfile {
  return name === "hungraim" ? BRAND_PROFILES.hungraim : BRAND_PROFILES.minih;
}

/**
 * The brand profile this bundle was built for.
 *
 * `__DESKTOP_BRAND__` is injected at build time by electron.vite's `define`
 * for the Main and renderer bundles. Plain Node (tests, tooling, the shared
 * package's own dist) has no such global, so it resolves to the default
 * brand; the compile-time injection is the only way a build differs.
 */
export function currentBrandProfile(): BrandProfile {
  return brandProfileFor(
    resolveBrandName((key) =>
      key === "DESKTOP_BRAND"
        ? typeof __DESKTOP_BRAND__ === "undefined"
          ? undefined
          : __DESKTOP_BRAND__
        : undefined,
    ),
  );
}

/** Product name of the brand this bundle was built for. */
export function currentAppName(): string {
  return currentBrandProfile().productName;
}

/** Application ID of the brand this bundle was built for. */
export function currentAppId(): string {
  return currentBrandProfile().appId;
}
