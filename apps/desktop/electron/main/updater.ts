/**
 * App auto-update via electron-updater against GitHub Releases.
 *
 * The feed (latest*.yml + installers) is attached to each GitHub Release by
 * .github/workflows/release.yml. A release may compile in HTTPS mirrors
 * (`MAIN_VITE_MINIH_AGENT_UPDATE_MIRRORS`) that carry the same files for the
 * same version; the packaged GitHub feed is always tried first and mirrors
 * only replace the host, never the release (ADR 0022 amendment, see
 * ./update-source). Discovery always tracks the latest stable release
 * (`allowPrerelease = false`) so RC installs still graduate to newer stables.
 * Delivery mode per install:
 *  - Windows NSIS / Linux AppImage / packaged macOS → full in-app flow: silent
 *    background download, "restart to update" prompt, install-on-quit fallback.
 *  - Windows ZIP / legacy portable (`piDistribution = "zip"` or
 *    `PORTABLE_EXECUTABLE_FILE`) → notify + link. The
 *    NSIS installer must not replace a no-install run.
 *  - Linux deb (no $APPIMAGE in env) → notify + link.
 *  - Unpackaged dev runs → disabled (no app-update.yml in resources).
 *
 * A check that fails or times out moves the next attempt to the next source,
 * and a download that stops making progress is cancelled and retried against
 * the next usable source before the failure is reported.
 *
 * The installer download cache lives in the user cache directory rather than
 * beside the installation; `MINIH_AGENT_UPDATE_CACHE_DIR` relocates it, and
 * `./update-cache` owns what may be reclaimed from it (#1098).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, shell } from "electron";
import electronUpdaterPkg from "electron-updater";
import type { AppUpdater, UpdateInfo, ProgressInfo } from "electron-updater";
import {
  formatChangelogNotes,
  IPC,
  type UpdatePreference,
  type UpdateState,
  currentBrandProfile,
} from "@minih-agent/shared";
import type { Logger } from "./logger";
import { parseAllowedExternalUrl } from "./safe-open-external";
import {
  defaultUpdateCacheBasePath,
  relocateUpdateCacheBasePath,
  resolveUpdateCacheOverride,
  UPDATE_CACHE_DIR_ENV,
} from "./update-cache";
import { UpdateCacheMaintenance } from "./update-cache-maintenance";
import {
  isUpdateCheckTimeout,
  raceWithTimeout,
} from "./update-timeout";
import {
  resolveDefaultUpdatePreference,
  resolveEffectiveUpdatePreference,
  resolveStoredUpdatePreference,
  resolveUpdateMode as resolveUpdateModePolicy,
  supportsAutomaticUpdates,
  type WindowsDistribution,
} from "./update-policy";
import { ManualUpdateReminderTracker } from "./manual-update-reminder";
import {
  configuredUpdateMirrors,
  parseUpdateMirrors,
  resolveUpdateSources,
  type UpdateSource,
} from "./update-source";

export { resolveUpdateMode } from "./update-policy";
export type { WindowsDistribution } from "./update-policy";

const { NsisUpdater, autoUpdater } = electronUpdaterPkg;

/** Windows NSIS updater with a caller-selected cache base. */
class RelocatedNsisUpdater extends NsisUpdater {
  constructor(baseCachePath: string) {
    super();
    relocateUpdateCacheBasePath(this.app, baseCachePath);
  }
}

function createRelocatedUpdater(
  platform: NodeJS.Platform,
  baseCachePath: string,
): AppUpdater | null {
  return platform === "win32" ? new RelocatedNsisUpdater(baseCachePath) : null;
}

/**
 * The page the "check for updates" surface opens in a browser: the minih
 * GitHub releases list, or the hungraim updates page (see ./brand.ts).
 */
export const RELEASES_URL = currentBrandProfile().releasesUrl;

/**
 * Chromium partition electron-updater requests on (`NET_SESSION_NAME` in its
 * `electronHttpExecutor`). Main registers it with ./network-proxy so update
 * traffic follows Settings → Network on the first check and after changes.
 */
export const UPDATER_SESSION_PARTITION = "electron-updater";

const AUTO_CHECK_INITIAL_DELAY_MS = 15_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Auto-check wait. Chromium's GitHub hang is ~60s; do not pin UI on that. */
export const AUTO_CHECK_TIMEOUT_MS = 8_000;
/** Manual check can wait a bit longer; still far below the socket timeout. */
export const MANUAL_CHECK_TIMEOUT_MS = 15_000;

/** Background bound on waiting for a failed attempt to settle before the next source is tried. */
export const SOURCE_SETTLE_TIMEOUT_MS = 75_000;
/** No transfer progress for this long means the source stalled the download. */
export const DOWNLOAD_STALL_TIMEOUT_MS = 45_000;
/** Pause before a stalled download restarts against the next source. */
export const DOWNLOAD_RETRY_BACKOFF_MS = 3_000;
/** Stalled-download retries per discovered version before the failure is reported. */
const DOWNLOAD_STALL_MAX_RETRIES = 1;

export type UpdaterSettings = {
  updatePreference?: unknown;
  lastNotifiedUpdateVersion?: unknown;
  updateDismissedVersion?: unknown;
};

export type UpdaterOptions = {
  logger: Logger;
  send: (channel: string, payload: unknown) => void;
  currentVersion: string;
  readUpdateSettings?: () => Promise<UpdaterSettings>;
  persistLastNotifiedVersion?: (version: string) => Promise<void>;
  /** Persists the version whose update notice the user dismissed (#1317). */
  persistDismissedVersion?: (version: string | null) => Promise<void>;
  /** Overrides the Electron singleton in controller tests. */
  autoUpdater?: AppUpdater;
  /**
   * Active product UI locale for shipped-locale release notes.
   * Called when attaching notes to update state; defaults to English.
   */
  getLocale?: () => string | null | undefined;
  /**
   * `MINIH_AGENT_UPDATE_CACHE_DIR`; an absolute directory moves the updater's
   * download cache out of the user cache directory. Empty keeps the default.
   */
  updateCacheDirOverride?: string | null;
  /**
   * Feed order; defaults to the packaged GitHub feed plus any compiled-in
   * mirrors (`MAIN_VITE_MINIH_AGENT_UPDATE_MIRRORS`).
   */
  sources?: UpdateSource[];
  /** Overrides for the bounded check waits (tests). */
  autoCheckTimeoutMs?: number;
  manualCheckTimeoutMs?: number;
  /** Bounded background wait for a timed-out attempt to settle. */
  sourceSettleTimeoutMs?: number;
  /** No download progress for this long marks the transfer stalled. */
  downloadStallTimeoutMs?: number;
  /** Pause before a stalled download is retried against the next source. */
  downloadRetryBackoffMs?: number;
  /** Overrides for tests. */
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  distribution?: WindowsDistribution;
};

export class AppUpdaterController {
  private readonly logger: Logger;
  private readonly send: (channel: string, payload: unknown) => void;
  private readonly getLocale: () => string | null | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly isPackaged: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private readonly distribution?: WindowsDistribution;
  private readonly defaultPreference: UpdatePreference;
  private readonly automaticSupported: boolean;
  private readonly readUpdateSettings?: () => Promise<UpdaterSettings>;
  private readonly persistLastNotifiedVersion?: (version: string) => Promise<void>;
  private readonly persistDismissedVersion?: (
    version: string | null,
  ) => Promise<void>;
  private dismissedVersionPersistence: Promise<void> = Promise.resolve();
  private readonly manualReminderTracker = new ManualUpdateReminderTracker();
  private preference: UpdatePreference;
  private preferenceRevision = 0;
  private settingsReady: Promise<void> | null = null;
  private autoCheckStarted = false;
  private disposed = false;
  private state: UpdateState;
  /** Version whose notice the user dismissed; cleared when a new one appears. */
  private dismissedVersion?: string;
  private activeDownloadCancellation?: {
    version: string;
    cancel: () => void;
  };
  private manualRequested = false;
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private listenersAttached = false;
  /**
   * Set before a downloaded update is handed to the platform installer.
   *
   * electron-updater spawns that installer synchronously and only asks the app
   * to quit afterwards, so the shutdown path must already know that the quit it
   * is about to see is the update restart.
   */
  private installRequested = false;
  private readonly autoUpdater: AppUpdater;
  private readonly cacheMaintenance: UpdateCacheMaintenance;
  private readonly sources: UpdateSource[];
  private readonly autoCheckTimeoutMs: number;
  private readonly manualCheckTimeoutMs: number;
  private readonly sourceSettleTimeoutMs: number;
  /** Source currently applied to the updater; null before the first apply. */
  private appliedSourceIndex: number | null = null;
  private readonly downloadStallTimeoutMs: number;
  private readonly downloadRetryBackoffMs: number;
  /** Preferred source for the next attempt; stays on the last host that answered. */
  private sourceIndex = 0;
  /** A settle-driven source fallback is already waiting. */
  private fallbackPending = false;
  /** Fires when a download stops reporting progress. */
  private stallTimer: NodeJS.Timeout | null = null;
  /** Delays the restart of a stalled download. */
  private retryTimer: NodeJS.Timeout | null = null;
  /** Stalled-download retries already spent on `stallRetryVersion`. */
  private stallRetries = 0;
  private stallRetryVersion?: string;

  private readPackagedDistribution(
    isPackaged: boolean,
  ): WindowsDistribution | undefined {
    if (!isPackaged) return undefined;
    try {
      const packageJson = JSON.parse(
        readFileSync(join(app.getAppPath(), "package.json"), "utf8"),
      ) as unknown;
      if (typeof packageJson !== "object" || packageJson === null) {
        return undefined;
      }
      const distribution = (packageJson as Record<string, unknown>)
        .piDistribution;
      return distribution === "installed" || distribution === "zip" || distribution === "portable"
        ? distribution
        : undefined;
    } catch (error) {
      this.logger.app(
        "updater",
        "warn",
        "packaged distribution metadata unavailable",
        { data: { detail: String(error) } },
      );
      return undefined;
    }
  }

  constructor(options: UpdaterOptions) {
    this.logger = options.logger;
    this.send = options.send;
    this.getLocale = options.getLocale ?? (() => "en");
    const platform = options.platform ?? process.platform;
    const isPackaged = options.isPackaged ?? app.isPackaged;
    const distribution =
      options.distribution ??
      (platform === "win32"
        ? this.readPackagedDistribution(isPackaged)
        : undefined);
    this.platform = platform;
    this.isPackaged = isPackaged;
    this.env = process.env;
    this.distribution = distribution;
    this.defaultPreference = resolveDefaultUpdatePreference(
      platform,
      isPackaged,
      this.env,
      distribution,
    );
    this.preference = this.defaultPreference;
    this.automaticSupported = supportsAutomaticUpdates(
      platform,
      isPackaged,
      this.env,
    );
    this.readUpdateSettings = options.readUpdateSettings;
    this.persistLastNotifiedVersion = options.persistLastNotifiedVersion;
    this.autoCheckTimeoutMs =
      options.autoCheckTimeoutMs ?? AUTO_CHECK_TIMEOUT_MS;
    this.manualCheckTimeoutMs =
      options.manualCheckTimeoutMs ?? MANUAL_CHECK_TIMEOUT_MS;
    this.persistDismissedVersion = options.persistDismissedVersion;
    const mode = resolveUpdateModePolicy(
      platform,
      isPackaged,
      this.env,
      distribution,
      this.preference,
    );
    const defaultCacheBasePath = defaultUpdateCacheBasePath({
      platform,
      env: process.env,
      home: homedir(),
    });
    const requestedCacheBasePath =
      options.updateCacheDirOverride ??
      resolveUpdateCacheOverride(process.env[UPDATE_CACHE_DIR_ENV]);
    const relocated =
      mode !== "in-app" || !requestedCacheBasePath
        ? null
        : createRelocatedUpdater(platform, requestedCacheBasePath);
    const activeBasePath =
      relocated && requestedCacheBasePath
        ? requestedCacheBasePath
        : defaultCacheBasePath;
    const legacyBasePath = relocated ? defaultCacheBasePath : null;
    if (requestedCacheBasePath && !relocated && mode !== "disabled") {
      this.logger.app(
        "updater",
        "warn",
        "update cache relocation is not supported on this target",
        { data: { platform } },
      );
    }
    this.autoUpdater = options.autoUpdater ?? relocated ?? autoUpdater;
    this.cacheMaintenance = new UpdateCacheMaintenance({
      resourcesPath: process.resourcesPath,
      activeBasePath,
      legacyBasePath,
      logger: this.logger,
    });
    this.state = {
      mode,
      preference: this.preference,
      defaultPreference: this.defaultPreference,
      automaticSupported: this.automaticSupported,
      manualReminder: false,
      status: "idle",
      currentVersion: options.currentVersion,
      releasesUrl: RELEASES_URL,
    };
    const configuredMirrors = configuredUpdateMirrors();
    this.sources = options.sources ?? resolveUpdateSources(configuredMirrors);
    this.sourceSettleTimeoutMs =
      options.sourceSettleTimeoutMs ?? SOURCE_SETTLE_TIMEOUT_MS;
    this.downloadStallTimeoutMs =
      options.downloadStallTimeoutMs ?? DOWNLOAD_STALL_TIMEOUT_MS;
    this.downloadRetryBackoffMs =
      options.downloadRetryBackoffMs ?? DOWNLOAD_RETRY_BACKOFF_MS;
    if (mode !== "disabled" && options.sources === undefined) {
      for (const entry of parseUpdateMirrors(configuredMirrors).rejected) {
        this.logger.app(
          "updater",
          "warn",
          "ignored unusable update mirror entry",
          { data: entry },
        );
      }
    }
    if (this.sources.length === 0) {
      this.sources = [{ kind: "packaged", host: "github.com" }];
    }
    this.state = { ...this.state, feedHost: this.sources[0]?.host };
    if (mode !== "disabled") this.applySource(0);
    if (mode !== "disabled") this.attachListeners();
  }
  /** Localized product notes for a discovered version, if catalogued. */
  private notesFor(version: string | undefined): string | undefined {
    if (!version) return undefined;
    return formatChangelogNotes(version, this.getLocale());
  }


  /**
   * Point the updater at `sources[index]` and publish the diagnostic host.
   *
   * The packaged source carries no feed, so `app-update.yml` keeps driving the
   * check exactly as before; only a build with compiled-in mirrors applies an
   * explicit feed. Applying the same source twice is a no-op, so a repeated
   * attempt does not re-issue the feed.
   */
  private applySource(index: number): void {
    const source = this.sources[index];
    if (!source) return;
    this.sourceIndex = index;
    if (source.feed && this.appliedSourceIndex !== index) {
      this.autoUpdater.setFeedURL(source.feed);
      this.appliedSourceIndex = index;
    }
    if (this.state.feedHost !== source.host) {
      this.setState({ feedHost: source.host });
    }
  }

  private nextSourceIndex(): number {
    return (this.sourceIndex + 1) % this.sources.length;
  }

  /**
   * Watchdog for a transfer that stops producing bytes.
   *
   * electron-updater has no download deadline of its own, so a source that
   * accepts the request and then goes quiet pins the card on "downloading"
   * forever.
   */
  private armDownloadWatchdog(): void {
    this.clearDownloadWatchdog();
    if (this.disposed || this.state.mode !== "in-app") return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      this.handleDownloadStall();
    }, this.downloadStallTimeoutMs);
    this.stallTimer.unref?.();
  }

  private clearDownloadWatchdog(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  /**
   * Cancel a stalled download and retry once against the next usable source.
   *
   * The retry runs as a fresh check so the new source resolves its own installer
   * URLs; the second stall for the same version reports the failure instead of
   * looping.
   */
  private handleDownloadStall(): void {
    if (this.disposed || this.state.mode !== "in-app") return;
    const version = this.state.availableVersion;
    const cancellation = this.activeDownloadCancellation;
    if (!version || !cancellation) return;
    if (this.dismissedVersion === version) return;
    if (this.stallRetryVersion !== version) {
      this.stallRetryVersion = version;
      this.stallRetries = 0;
    }
    if (this.stallRetries >= DOWNLOAD_STALL_MAX_RETRIES) {
      this.logger.app("updater", "warn", "update download stalled again", {
        data: { version, host: this.state.feedHost },
      });
      // Stop the hung transfer too; leaving it running would keep a socket and
      // a partial installer behind an error the user already sees.
      cancellation.cancel();
      this.activeDownloadCancellation = undefined;
      this.setState({
        status: "error",
        progressPercent: undefined,
        error: "update download stalled",
        errorCode: "download-stalled",
      });
      return;
    }
    this.stallRetries += 1;
    this.logger.app("updater", "warn", "update download stalled, retrying", {
      data: {
        version,
        host: this.state.feedHost,
        attempt: this.stallRetries,
      },
    });
    cancellation.cancel();
    this.activeDownloadCancellation = undefined;
    // `update-cancelled` follows the cancel. Leaving "downloading" here is what
    // lets the retry pass the busy guard in check().
    this.setState({ status: "available", progressPercent: undefined });
    if (this.sources.length > 1) this.applySource(this.nextSourceIndex());
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.disposed) return;
      void this.check({ manual: true }).catch(() => undefined);
    }, this.downloadRetryBackoffMs);
    this.retryTimer.unref?.();
  }

  private ensureSettingsLoaded(): Promise<void> {
    if (this.settingsReady) return this.settingsReady;
    const preferenceRevision = this.preferenceRevision;
    this.settingsReady = (async () => {
      if (!this.readUpdateSettings) {
        this.applyPreference(this.preference, false);
        return;
      }
      try {
        const settings = await this.readUpdateSettings();
        if (this.disposed) return;
        const lastNotifiedVersion = settings.lastNotifiedUpdateVersion;
        if (
          typeof lastNotifiedVersion === "string" &&
          lastNotifiedVersion.length > 0 &&
          lastNotifiedVersion.length <= 128
        ) {
          this.manualReminderTracker.hydrate(lastNotifiedVersion);
        }
        const dismissedVersion = settings.updateDismissedVersion;
        if (
          typeof dismissedVersion === "string" &&
          dismissedVersion.length > 0 &&
          dismissedVersion.length <= 128
        ) {
          this.dismissedVersion = dismissedVersion;
          if (this.state.availableVersion === dismissedVersion) {
            this.setState({ dismissed: true });
          }
        }
        const preference = resolveStoredUpdatePreference(
          settings.updatePreference,
          this.defaultPreference,
        );
        if (preferenceRevision === this.preferenceRevision) {
          this.applyPreference(preference, false);
        }
      } catch (error) {
        this.logger.app("updater", "warn", "update preferences unavailable", {
          data: { detail: String(error) },
        });
        if (preferenceRevision === this.preferenceRevision) {
          this.applyPreference("manual", false);
        }
      }
    })();
    return this.settingsReady;
  }

  private manualReminderFor(version: string): boolean {
    const decision = this.manualReminderTracker.observe(version);
    if (decision.persist && this.persistLastNotifiedVersion) {
      void this.persistLastNotifiedVersion(version).catch((error) => {
        this.logger.app("updater", "warn", "manual update reminder persistence failed", {
          data: { detail: String(error), version },
        });
      });
    }
    return decision.show;
  }

  private applyPreference(
    preference: UpdatePreference,
    checkImmediately: boolean,
  ): void {
    const previousMode = this.state.mode;
    const effectivePreference = resolveEffectiveUpdatePreference(
      preference,
      this.automaticSupported,
    );
    const mode = resolveUpdateModePolicy(
      this.platform,
      this.isPackaged,
      this.env,
      this.distribution,
      effectivePreference,
    );
    const preferenceChanged =
      effectivePreference !== this.preference || mode !== previousMode;
    this.preference = effectivePreference;
    const dismissed =
      this.state.availableVersion !== undefined &&
      this.dismissedVersion === this.state.availableVersion;
    this.autoUpdater.autoDownload = mode === "in-app" && !dismissed;
    this.autoUpdater.autoInstallOnAppQuit = mode === "in-app" && !dismissed;
    if (!preferenceChanged) return;

    const patch: Partial<UpdateState> = {
      mode,
      preference: effectivePreference,
      manualReminder: false,
    };
    if (mode === "manual") {
      if (
        this.state.status === "downloading" ||
        this.state.status === "downloaded"
      ) {
        patch.status = this.state.availableVersion ? "available" : "idle";
        patch.progressPercent = undefined;
      }
      if (this.state.availableVersion) {
        patch.manualReminder = this.manualReminderFor(
          this.state.availableVersion,
        );
      }
    }
    this.setState(patch);
    if (
      checkImmediately &&
      previousMode === "manual" &&
      mode === "in-app"
    ) {
      void this.check().catch(() => undefined);
    }
  }

  setPreference(preference: UpdatePreference): void {
    if (preference !== "automatic" && preference !== "manual") return;
    this.preferenceRevision += 1;
    this.applyPreference(preference, true);
  }

  /**
   * Records the user's decision to stop nudging about `availableVersion`
   * until a newer version is detected (#1317). The banner hides itself from
   * the pushed `dismissed` flag, so the decision survives restarts.
   */
  async dismiss(): Promise<void> {
    const version = this.state.availableVersion;
    if (!version) return;
    this.dismissedVersion = version;
    this.clearDownloadWatchdog();
    if (this.state.mode === "in-app") {
      this.autoUpdater.autoDownload = false;
      this.autoUpdater.autoInstallOnAppQuit = false;
    }
    this.setState({
      status:
        this.state.status === "downloading" || this.state.status === "downloaded"
          ? "available"
          : this.state.status,
      progressPercent: undefined,
      dismissed: true,
    });
    if (this.activeDownloadCancellation?.version === version) {
      this.activeDownloadCancellation.cancel();
      this.activeDownloadCancellation = undefined;
    }
    await this.persistDismissedVersionInOrder(version);
  }

  private persistDismissedVersionInOrder(version: string | null): Promise<void> {
    if (!this.persistDismissedVersion) return Promise.resolve();
    const write = this.dismissedVersionPersistence.then(() =>
      this.persistDismissedVersion?.(version),
    );
    this.dismissedVersionPersistence = write.catch((error: unknown) => {
      this.logger.app("updater", "warn", "update dismissal persistence failed", {
        data: { detail: String(error), version },
      });
    });
    return this.dismissedVersionPersistence;
  }

  private trackAutomaticDownload(
    result: Awaited<ReturnType<AppUpdater["checkForUpdates"]>>,
  ): void {
    const downloadPromise = result?.downloadPromise;
    const cancellationToken = result?.cancellationToken;
    if (!downloadPromise || !cancellationToken) return;
    this.activeDownloadCancellation = {
      version: result.updateInfo.version,
      cancel: () => cancellationToken.cancel(),
    };
    // electron-updater emits `error` or `update-cancelled` before rejecting
    // this promise. The event handlers own diagnostics and state transitions.
    void downloadPromise.catch(() => undefined);
    if (this.dismissedVersion === result.updateInfo.version) {
      cancellationToken.cancel();
    }
  }

  private attachListeners() {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    // Do not let cached updates download or install before Host preferences load.
    this.autoUpdater.autoDownload = false;
    this.autoUpdater.autoInstallOnAppQuit = false;
    // electron-updater defaults allowPrerelease=true when the installed
    // version has a prerelease component (e.g. 0.2.0-rc.6). That pins the
    // GitHub provider to the same custom channel ("rc") and never offers a
    // newer stable release such as 0.2.2. Always track GitHub's latest
    // stable release so RC installs can graduate to stable.
    this.autoUpdater.allowPrerelease = false;
    // Only automatic mode may install on quit; manual mode never hands an
    // installer a no-install/portable directory.
    this.autoUpdater.logger = {
      info: (m: unknown) =>
        this.logger.app("updater", "info", "updater diagnostic", {
          data: { detail: String(m) },
        }),
      warn: (m: unknown) =>
        this.logger.app("updater", "warn", "updater diagnostic", {
          data: { detail: String(m) },
        }),
      error: (m: unknown) =>
        this.logger.app("updater", "error", "updater diagnostic", {
          data: { detail: String(m) },
        }),
      debug: (m: unknown) =>
        this.logger.app("updater", "debug", "updater diagnostic", {
          data: { detail: String(m) },
        }),
    };

    this.autoUpdater.on("checking-for-update", () => {
      this.setState({ status: "checking", error: undefined, errorCode: undefined });
    });
    this.autoUpdater.on("update-available", (info: UpdateInfo) => {
      // A newly discovered version supersedes any earlier dismissal.
      if (this.dismissedVersion && this.dismissedVersion !== info.version) {
        this.dismissedVersion = undefined;
        void this.persistDismissedVersionInOrder(null);
      }
      // Stall retries are counted per discovered version.
      if (this.stallRetryVersion !== info.version) {
        this.stallRetryVersion = undefined;
        this.stallRetries = 0;
      }
      const dismissed = this.dismissedVersion === info.version;
      const automatic = this.state.mode === "in-app" && !dismissed;
      this.autoUpdater.autoDownload = automatic;
      this.autoUpdater.autoInstallOnAppQuit = automatic;
      this.setState({
        status: automatic ? "downloading" : "available",
        availableVersion: info.version,
        releaseNotes: this.notesFor(info.version),
        progressPercent: automatic ? 0 : undefined,
        dismissed,
        error: undefined,
        errorCode: undefined,
        manualReminder: automatic
          ? false
          : this.manualReminderFor(info.version),
      });
      if (automatic) this.armDownloadWatchdog();
    });
    this.autoUpdater.on("update-not-available", () => {
      this.clearDownloadWatchdog();
      this.stallRetryVersion = undefined;
      this.stallRetries = 0;
      this.setState({
        status: "up-to-date",
        availableVersion: undefined,
        releaseNotes: undefined,
        progressPercent: undefined,
        manualReminder: false,
        error: undefined,
        errorCode: undefined,
      });
      // In-app installs have no newer staged installer after the feed reports
      // current. Keep the differential baselines for the next update. Manual
      // delivery modes may share a cache with an installed NSIS copy.
      if (this.state.mode === "in-app") {
        void this.cacheMaintenance.discardDownloadedInstaller();
      }
    });
    this.autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      if (this.state.mode !== "in-app") return;
      if (this.dismissedVersion === this.state.availableVersion) return;
      this.setState({
        status: "downloading",
        // Preserve notes already attached when discovery advanced to download.
        releaseNotes:
          this.state.releaseNotes ?? this.notesFor(this.state.availableVersion),
        progressPercent: Math.round(progress.percent),
        error: undefined,
        errorCode: undefined,
      });
      // Bytes arrived: restart the stall window from here.
      this.armDownloadWatchdog();
    });
    this.autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      const dismissed = this.dismissedVersion === info.version;
      const automatic = this.state.mode === "in-app" && !dismissed;
      this.clearDownloadWatchdog();
      this.activeDownloadCancellation = undefined;
      this.stallRetryVersion = undefined;
      this.stallRetries = 0;
      this.autoUpdater.autoInstallOnAppQuit = automatic;
      this.setState({
        status: automatic ? "downloaded" : "available",
        availableVersion: info.version,
        releaseNotes: this.notesFor(info.version),
        progressPercent: automatic ? 100 : undefined,
        dismissed,
        error: undefined,
        errorCode: undefined,
        manualReminder: automatic
          ? false
          : this.manualReminderFor(info.version),
      });
    });
    this.autoUpdater.on("update-cancelled", (info: UpdateInfo) => {
      this.clearDownloadWatchdog();
      if (this.activeDownloadCancellation?.version === info.version) {
        this.activeDownloadCancellation = undefined;
      }
      if (this.dismissedVersion !== info.version) return;
      this.setState({
        status: "available",
        progressPercent: undefined,
        dismissed: true,
      });
    });
    this.autoUpdater.on("error", (error: Error) => {
      // Auto checks fail quietly (offline, private repo, rate limits);
      // the renderer only surfaces errors when `manual` is set.
      this.clearDownloadWatchdog();
      const wasDownloading = this.activeDownloadCancellation !== undefined;
      this.activeDownloadCancellation = undefined;
      this.logger.app("updater", "warn", "updater error", { data: String(error) });
      if (
        wasDownloading &&
        this.state.mode === "in-app" &&
        this.sources.length > 1
      ) {
        // A source that cannot deliver the installer must not be retried first.
        this.applySource(this.nextSourceIndex());
      }
      this.setState({
        status: "error",
        error: error.message,
        errorCode: undefined,
      });
    });
  }

  private setState(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch, manual: this.manualRequested };
    this.send(IPC.event.updatesState, this.state);
  }

  getState(): UpdateState {
    return this.state;
  }

  /**
   * Re-resolve release notes after the product UI locale changes so the
   * banner and Settings → Info stay aligned without a new feed check.
   */
  refreshReleaseNotes(): UpdateState {
    if (!this.state.availableVersion) return this.state;
    const next = this.notesFor(this.state.availableVersion);
    if (next === this.state.releaseNotes) return this.state;
    this.setState({ releaseNotes: next });
    return this.state;
  }

  /** User- or schedule-triggered check. Resolves with the settled state. */
  async check(options: { manual?: boolean } = {}): Promise<UpdateState> {
    await this.ensureSettingsLoaded();
    if (this.state.mode === "disabled") {
      throw new Error("updates are disabled in development builds");
    }
    if (
      this.state.status === "checking" ||
      this.state.status === "downloading" ||
      this.state.status === "downloaded"
    ) {
      return this.state;
    }
    this.manualRequested = Boolean(options.manual);
    const timeoutMs = this.manualRequested
      ? this.manualCheckTimeoutMs
      : this.autoCheckTimeoutMs;
    // Fire-and-forget relative to boot: callers must not await this from the
    // first-window path. The race only bounds *our* wait; electron-updater may
    // still finish later and emit available/up-to-date.
    const attempt = await this.runCheckAttempt(timeoutMs);
    if (attempt.ok) return this.state;

    if (isUpdateCheckTimeout(attempt.error)) {
      if (this.manualRequested) {
        this.setState({
          status: "error",
          error: "update check timed out",
          errorCode: "check-timeout",
        });
      } else if (this.getState().status === "checking") {
        // Auto checks fail quietly. Drop "checking" so a 60s GitHub hang
        // cannot skip the next interval or freeze Settings on a spinner.
        // Read through getState(): check() already narrowed this.state.status
        // away from "checking", but the checking-for-update listener can set
        // it during the awaited race.
        this.setState({
          status: "idle",
          error: undefined,
          errorCode: undefined,
        });
      }
    }
    // A source that could not answer this time is not tried first again, and
    // the fallback below may reach it as soon as this attempt has failed.
    if (this.sources.length > 1) this.applySource(this.nextSourceIndex());
    this.scheduleSourceFallback(attempt.settled, this.manualRequested);
    // The 'error' listener already recorded a non-timeout failure; rethrow for
    // manual callers so the invoke rejects and the UI can report it.
    if (options.manual) throw attempt.error;
    return this.state;
  }

  /**
   * One bounded feed attempt against the preferred source.
   *
   * `settled` reports how the underlying request ended. It is what keeps a
   * timed-out attempt from racing the next source.
   */
  private async runCheckAttempt(timeoutMs: number): Promise<
    | { ok: true }
    | { ok: false; error: unknown; settled: Promise<"ok" | "failed"> }
  > {
    const checkPromise = this.autoUpdater.checkForUpdates();
    const settled = new Promise<"ok" | "failed">((resolve) => {
      void checkPromise.then(
        () => resolve("ok"),
        () => resolve("failed"),
      );
    });
    void checkPromise.then(
      (result) => this.trackAutomaticDownload(result),
      () => undefined,
    );
    try {
      await raceWithTimeout(checkPromise, timeoutMs, "update check");
      return { ok: true };
    } catch (error) {
      return { ok: false, error, settled };
    }
  }

  /**
   * Retry the check against the source the preference moved to, once the
   * failed attempt has actually settled.
   *
   * Waiting for settlement keeps one check in flight at a time: a request that
   * hangs past our window and then succeeds must not download from the host
   * the desktop has already left.
   */
  private scheduleSourceFallback(
    settled: Promise<"ok" | "failed">,
    manual: boolean,
  ): void {
    if (this.sources.length < 2 || this.disposed || this.fallbackPending) {
      return;
    }
    this.fallbackPending = true;
    void (async () => {
      try {
        if (!(await this.settledAsFailure(settled))) return;
        if (this.disposed) return;
        this.logger.app(
          "updater",
          "info",
          "update check retried on another source",
          { data: { host: this.state.feedHost } },
        );
        await this.check({ manual }).catch(() => undefined);
      } finally {
        this.fallbackPending = false;
      }
    })();
  }

  /** True once `settled` failed; false while it is still in flight. */
  private async settledAsFailure(
    settled: Promise<"ok" | "failed">,
  ): Promise<boolean> {
    try {
      const outcome = await raceWithTimeout(
        settled,
        this.sourceSettleTimeoutMs,
        "update source settle",
      );
      return outcome === "failed";
    } catch {
      // Still in flight after the settle window: leave it alone rather than
      // race a second feed request against a request that may still answer.
      return false;
    }
  }

  /** Explicit download for in-app installs when a check was manual-only. */
  async download(): Promise<UpdateState> {
    if (this.state.mode !== "in-app") {
      throw new Error("in-app download is not supported on this install");
    }
    if (this.state.status === "downloading" || this.state.status === "downloaded") {
      return this.state;
    }
    await this.autoUpdater.downloadUpdate();
    return this.state;
  }

  /**
   * True once a downloaded update was handed to the platform installer.
   *
   * The NSIS/AppImage installer is spawned before `app.quit()` and gives up
   * after a few seconds when the app is still running, so the quit that follows
   * must not be deferred — including by the explicit-quit confirmation.
   */
  isInstallingUpdate(): boolean {
    return this.installRequested;
  }

  /** Quit and install a downloaded update (in-app mode). */
  install(): void {
    if (this.state.mode !== "in-app" || this.state.status !== "downloaded") {
      throw new Error("no downloaded update to install");
    }
    // Marked before the call: quitAndInstall spawns the installer itself, so
    // the shutdown handler must already know this quit is the update restart.
    this.installRequested = true;
    // Fires 'before-quit' first, so host/sidecar shutdown still runs.
    this.autoUpdater.quitAndInstall(false, true);
  }
  /** Adopt legacy NSIS cache files before the first update check. */
  reclaimRelocatedUpdateCache(): Promise<void> {
    if (this.state.mode === "disabled") return Promise.resolve();
    return this.cacheMaintenance.reclaimLegacyCache();
  }

  async openReleases(): Promise<void> {
    const url = parseAllowedExternalUrl(RELEASES_URL);
    if (!url) throw new Error("DISALLOWED_EXTERNAL_URL");
    await shell.openExternal(url);
  }

  /**
   * Schedule background GitHub feed checks. Never await this from boot: the
   * first check is delayed and time-bounded so a hung feed cannot block the
   * first window or pin the updater on `checking`.
   */
  startAutoCheck() {
    if (this.autoCheckStarted || this.state.mode === "disabled") return;
    this.autoCheckStarted = true;
    void this.ensureSettingsLoaded().then(() => {
      if (this.disposed || this.state.mode === "disabled") return;
      this.initialTimer = setTimeout(() => {
        void this.check().catch(() => undefined);
      }, AUTO_CHECK_INITIAL_DELAY_MS);
      this.intervalTimer = setInterval(() => {
        void this.check().catch(() => undefined);
      }, AUTO_CHECK_INTERVAL_MS);
    });
  }

  dispose() {
    this.disposed = true;
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
    this.retryTimer = null;
    this.clearDownloadWatchdog();
  }
}
