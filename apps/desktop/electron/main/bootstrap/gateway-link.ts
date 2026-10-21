import type { AgentHost } from "@minih-agent/agent-host";
import type { HostRpc } from "@minih-agent/host-runtime";
import type { HostNotifier } from "@minih-agent/racp";
import type {
  AppSettings,
  RemoteGatewayAccountMode,
  RemoteGatewayDeviceNotice,
  RemoteGatewayDeviceRequest,
  RemoteGatewayDeviceSummary,
  RemoteGatewayEnrollRequest,
  RemoteGatewayPairingCodeResult,
  RemoteGatewaySettings,
  RemoteGatewayStatus,
} from "@minih-agent/shared";

import { readAccountModeAvailability } from "../remote/gateway-link/account-mode.js";
import {
  createGatewayCredentialStore,
  type GatewayCredentialStore,
} from "../remote/gateway-link/gateway-credential-store.js";
import {
  createGatewayLinkService,
  GATEWAY_LINK_FAILED,
  type GatewayLinkService,
} from "../remote/gateway-link/gateway-link-service.js";
import {
  GATEWAY_LINK_UNAVAILABLE,
  type GatewayLinkPort,
} from "../remote/gateway-link/gateway-link-port.js";
import type { EncryptionPort } from "../remote/remote-host-registry.js";

/**
 * Desktop-as-connected-Host boot and wiring (rollout R5, ADR 0331).
 *
 * Reads the device-local `remoteGateway` setting and creates the link service
 * *only* when the switch is on: with the feature off nothing is opened, no
 * `RacpServer` exists, and no outbound socket is dialed (security gate 27).
 *
 * The link belongs to the main process. A renderer reload only drops that
 * renderer's own `remoteGatewayStatusChanged` subscription — the IPC layer
 * re-subscribes on load — so the Host keeps serving remote devices across a
 * window reload.
 */

export type GatewayLinkBootstrapOptions = {
  dataDir: string;
  encryption: EncryptionPort;
  /**
   * The Gateway transport. Required: `bootstrap/startup.ts` passes
   * `racpGatewayLinkPort`, tests pass an in-memory port, and a caller that
   * forgets one fails to compile instead of shipping a silently disabled link.
   */
  port: GatewayLinkPort;
  getSettings: () => Promise<AppSettings | null>;
  /** Persist the device-local switch without touching the other settings. */
  saveSettings: (remoteGateway: RemoteGatewaySettings) => Promise<void>;
  getHost: () => HostRpc | null;
  /** The bridge's existing Agent Host instance; never a new one. */
  getAgentHost: () => AgentHost;
  serverVersion: string;
  /** Fan one status snapshot out to the renderer. */
  emitStatus: (status: RemoteGatewayStatus) => void;
  /** Push one `device.request` to the renderer for the confirmation dialog. */
  emitDeviceRequest?: (request: RemoteGatewayDeviceRequest) => void;
  /** One "new device" style notice per mint, adoption, and revocation. */
  emitDeviceNotice?: (notice: RemoteGatewayDeviceNotice) => void;
  /**
   * Redacted push (§11.6): the notifier the Agent Host feeds and the link
   * carries. Absent (or `notifyEnabled: false`) means this desktop advertises
   * nothing and reports no events.
   */
  notifier?: HostNotifier | null;
  /** Test seam: pretend this Host reports no notification events. */
  notifyEnabled?: boolean;
  log?: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  now?: () => number;
};

/** What the remote-gateway IPC handlers call; every method reports status. */
export type GatewayLinkController = {
  status(): Promise<RemoteGatewayStatus>;
  setEnabled(enabled: boolean): Promise<RemoteGatewayStatus>;
  enroll(input: RemoteGatewayEnrollRequest): Promise<RemoteGatewayStatus>;
  createPairingCode(): Promise<RemoteGatewayPairingCodeResult>;
  listDevices(): Promise<RemoteGatewayDeviceSummary[]>;
  revokeDevice(deviceId: string): Promise<boolean>;
  /** Account mode: answer one pending device request. */
  answerDeviceRequest(requestId: string, approved: boolean): Promise<boolean>;
  /** Account mode: requests still waiting for this desktop's user. */
  pendingDeviceRequests(): Promise<RemoteGatewayDeviceRequest[]>;
  /** The confirmation dialog host came or went. */
  devicePresence(present: boolean): Promise<number>;
  /** ADR decision 9: require confirmation on every terminal. */
  setStrictDevices(strictDevices: boolean): Promise<RemoteGatewayStatus>;
  /** ADR amendment 3: allow or refuse automatic admission of a same-account computer. */
  setDesktopAutoAdmission(enabled: boolean): Promise<RemoteGatewayStatus>;
};

export type GatewayLinkBootstrap = {
  /** Apply the persisted switch; a no-op when the feature is off. */
  open(): Promise<void>;
  controller(): GatewayLinkController;
  dispose(): Promise<void>;
};

let activeGatewayLink: GatewayLinkBootstrap | null = null;

export function setActiveGatewayLink(bootstrap: GatewayLinkBootstrap | null): void {
  activeGatewayLink = bootstrap;
}

export function getActiveGatewayLink(): GatewayLinkBootstrap | null {
  return activeGatewayLink;
}

function failure(error: unknown, code: string): { code: string; message: string } {
  const reported = (error as { errorCode?: string } | null)?.errorCode;
  return { code: reported ?? code, message: error instanceof Error ? error.message : String(error) };
}

export function createGatewayLinkBootstrap(
  options: GatewayLinkBootstrapOptions,
): GatewayLinkBootstrap {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => Date.now());
  const port = options.port;

  let configuredEnabled = false;
  let configuredUrl = "";
  let configuredStrictDevices = false;
  /** On by default: absent in a stored setting means automatic admission is on. */
  let configuredDesktopAuto = true;
  let store: GatewayCredentialStore | null = null;
  let service: GatewayLinkService | null = null;
  let serviceInitialized = false;
  let disposed = false;
  /** Enrollment probe for the disabled path; failures are reported, not cached as "empty". */
  let enrollmentProbe: Promise<{ enrolled: boolean; hostId?: string; error?: Error }> | null = null;
  // Redacted push (§11.6): the notifier is owned by the bootstrap that also
  // owns the Agent Host, so the Host's events and the link's sender are one
  // object. Absent means this desktop reports no notification events.
  const notifier = options.notifyEnabled === false ? null : (options.notifier ?? null);

  const ensureStore = (): GatewayCredentialStore => {
    store ??= createGatewayCredentialStore({
      dataDir: options.dataDir,
      encryption: options.encryption,
      log: (level, message, data) => log(level, message, data),
    });
    return store;
  };

  const decorate = (status: RemoteGatewayStatus): RemoteGatewayStatus => ({
    ...status,
    ...(configuredUrl ? { url: configuredUrl } : {}),
  });

  const emit = (status: RemoteGatewayStatus): void => {
    try {
      options.emitStatus(decorate(status));
    } catch (error) {
      log("warn", "gateway link status could not be delivered", { error: String(error) });
    }
  };

  const ensureService = (): GatewayLinkService => {
    if (service) return service;
    const created = createGatewayLinkService({
      port,
      store: ensureStore(),
      dataDir: options.dataDir,
      agentHost: options.getAgentHost,
      getHost: options.getHost,
      serverVersion: options.serverVersion,
      log,
      now,
      strictDevices: configuredStrictDevices,
      desktopAutoAdmission: configuredDesktopAuto,
      ...(notifier ? { notifier } : {}),
      // Persist the strict-mode switch on its own: it is device-local and must
      // not rewrite the link switch or the Gateway URL.
      saveStrictDevices: async (strictDevices) => {
        configuredStrictDevices = strictDevices;
        await options.saveSettings({
          enabled: configuredEnabled,
          url: configuredUrl,
          strictDevices,
          ...(configuredDesktopAuto ? {} : { desktopAutoAdmission: false }),
        });
      },
      // Same rule for the automatic-admission switch (ADR amendment 3).
      saveDesktopAutoAdmission: async (desktopAutoAdmission) => {
        configuredDesktopAuto = desktopAutoAdmission;
        await options.saveSettings({
          enabled: configuredEnabled,
          url: configuredUrl,
          ...(configuredStrictDevices ? { strictDevices: true } : {}),
          desktopAutoAdmission,
        });
      },
      ...(options.emitDeviceRequest ? { emitDeviceRequest: options.emitDeviceRequest } : {}),
      ...(options.emitDeviceNotice ? { emitDeviceNotice: options.emitDeviceNotice } : {}),
    });
    created.onChange(emit);
    service = created;
    return created;
  };

  /**
   * Create the service on demand and apply the switch once. Initialization is
   * idempotent per service instance so calling it from several entry points
   * cannot start the link twice.
   */
  const activate = async (): Promise<GatewayLinkService> => {
    const created = ensureService();
    if (!serviceInitialized) {
      serviceInitialized = true;
      await created.initialize({ enabled: configuredEnabled });
    }
    return created;
  };

  const probeEnrollment = async (): Promise<{ enrolled: boolean; hostId?: string; error?: Error }> => {
    enrollmentProbe ??= (async () => {
      const candidate = ensureStore();
      await candidate.open();
      return { enrolled: candidate.enrolled(), hostId: candidate.hostId() };
    })().catch((error: unknown) => {
      log("error", "gateway credentials could not be read", { error: String(error) });
      enrollmentProbe = null;
      return { enrolled: false, error: error instanceof Error ? error : new Error(String(error)) };
    });
    return enrollmentProbe;
  };
  /**
   * Whether account mode could work, read without enrolling or dialing.
   *
   * A fresh install has no other way in: the switch waits for an enrollment and
   * the enrollment waits for the switch, so the page needs this answer to offer
   * the switch at all. It follows the overlay and the Router key, both of which
   * change without the switch being touched, so this is a single flight and not
   * a cache: concurrent callers share one read, and the next read asks again.
   * Nothing here runs on a timer — host-core pushes no EasyTier-state event to
   * subscribe to, so this runs on the status reads the page already makes.
   */
  let accountModeProbe: Promise<RemoteGatewayAccountMode | undefined> | null = null;
  const probeAccountMode = async (): Promise<RemoteGatewayAccountMode | undefined> => {
    if (!accountModeProbe) {
      const read = readAccountModeAvailability(options.getHost()).then(
        (mode) => mode,
        (error: unknown) => {
          log("warn", "account mode availability could not be read", { error: String(error) });
          return { available: false, reason: String(error) } satisfies RemoteGatewayAccountMode;
        },
      );
      // Released when the read settles: a desktop that finished connecting its
      // overlay, or that added a Router key, must not keep showing the first
      // answer for the rest of the session.
      accountModeProbe = read.finally(() => {
        accountModeProbe = null;
      });
    }
    return accountModeProbe;
  };


  /** The status a disabled feature reports: honest about enrollment, but idle. */
  const disabledStatus = async (): Promise<RemoteGatewayStatus> => {
    const [probe, accountMode] = await Promise.all([probeEnrollment(), probeAccountMode()]);
    return {
      state: probe.error ? "error" : "disabled",
      since: new Date(now()).toISOString(),
      enabled: false,
      enrolled: probe.enrolled,
      ...(probe.hostId ? { hostId: probe.hostId } : {}),
      ...(configuredUrl ? { url: configuredUrl } : {}),
      ...(probe.error ? { lastError: failure(probe.error, GATEWAY_LINK_FAILED) } : {}),
      // Account mode is what makes the switch usable before any enrollment
      // exists, so the page needs it even while the feature is off.
      ...(accountMode ? { accountMode } : {}),
    };
  };

  /**
   * Mutations run strictly in call order. The controller awaits the settings
   * write and the lazy service creation before it reaches the link, so two
   * quick switch calls would otherwise interleave and let an earlier intent
   * land last.
   */
  let commandQueue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(command: () => Promise<T>): Promise<T> => {
    const run = commandQueue.then(command);
    commandQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const controller: GatewayLinkController = {
    async status() {
      if (!service) return disabledStatus();
      // Off: the service re-reads account mode, because that answer is what
      // would offer the switch again. On: the running link already keeps it
      // current, so a status read stays a plain snapshot.
      const current = service.status();
      if (current.enabled) return decorate(current);
      return decorate(await service.refreshStatus());
    },
    setEnabled(enabled) {
      return enqueue(async () => {
        if (disposed) {
          throw Object.assign(new Error("the gateway link is shutting down"), {
            errorCode: GATEWAY_LINK_UNAVAILABLE,
          });
        }
        // Persist first: a crash between the two leaves the switch truthful
        // and the next boot dials (or stays off) accordingly.
        await options.saveSettings({ enabled, url: configuredUrl });
        configuredEnabled = enabled;
        if (!enabled) {
          if (service) {
            await service.setEnabled(false);
            return decorate(service.status());
          }
          return disabledStatus();
        }
        const created = await activate();
        await created.setEnabled(true);
        return decorate(created.status());
      });
    },
    enroll(input) {
      return enqueue(async () => {
        const created = await activate();
        // Enrollment works with the switch off too: the credentials are stored
        // and the link starts the next time the switch is on.
        await created.enroll(input);
        configuredUrl = input.url.trim();
        await options.saveSettings({ enabled: configuredEnabled, url: configuredUrl });
        return decorate(created.status());
      });
    },
    async createPairingCode() {
      const created = await activate();
      return created.createPairingCode();
    },
    async listDevices() {
      const created = await activate();
      return created.listDevices();
    },
    async revokeDevice(deviceId) {
      const created = await activate();
      return created.revokeDevice(deviceId);
    },
    async answerDeviceRequest(requestId, approved) {
      // The dialog is answered against the live link; a stopped link has no
      // pending request, and the service reports that as "no".
      if (!service) return false;
      return service.answerDeviceRequest(requestId, approved);
    },
    async pendingDeviceRequests() {
      return service?.pendingDeviceRequests() ?? [];
    },
    async devicePresence(present) {
      return service?.devicePresence(present) ?? 0;
    },
    setStrictDevices(strictDevices) {
      return enqueue(async () => {
        if (disposed) {
          throw Object.assign(new Error("the gateway link is shutting down"), {
            errorCode: GATEWAY_LINK_UNAVAILABLE,
          });
        }
        const created = await activate();
        return decorate(await created.setStrictDevices(strictDevices));
      });
    },
    setDesktopAutoAdmission(enabled) {
      return enqueue(async () => {
        if (disposed) {
          throw Object.assign(new Error("the gateway link is shutting down"), {
            errorCode: GATEWAY_LINK_UNAVAILABLE,
          });
        }
        const created = await activate();
        return decorate(await created.setDesktopAutoAdmission(enabled));
      });
    },
  };

  const result: GatewayLinkBootstrap = {
    async open() {
      let settings: AppSettings | null = null;
      try {
        settings = await options.getSettings();
      } catch (error) {
        log("warn", "gateway settings could not be read", { error: String(error) });
      }
      const configured = settings?.remoteGateway;
      configuredEnabled = configured?.enabled === true;
      configuredUrl = typeof configured?.url === "string" ? configured.url : "";
      configuredStrictDevices = configured?.strictDevices === true;
      // S12: an absent or disabled setting must not create a store, a server,
      // or a socket. The switch flips this through `setEnabled`.
      if (!configuredEnabled) return;
      await activate();
    },
    controller() {
      return controller;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const current = service;
      service = null;
      serviceInitialized = false;
      if (current) await current.dispose();
      if (activeGatewayLink === result) activeGatewayLink = null;
    },
  };
  return result;
}
