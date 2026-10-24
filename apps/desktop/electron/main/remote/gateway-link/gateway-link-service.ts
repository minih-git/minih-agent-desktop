import type { AgentHost } from "@minih-agent/agent-host";
import type { HostRpc } from "@minih-agent/host-runtime";
import { DeviceTokenAuthenticator, RacpServer, type HostNotifier } from "@minih-agent/racp";
import type {
  RemoteGatewayAccountMode,
  RemoteGatewayDeviceNotice,
  RemoteGatewayDeviceRequest,
  RemoteGatewayDeviceSummary,
  RemoteGatewayEnrollRequest,
  RemoteGatewayFailure,
  RemoteGatewayLinkState,
  RemoteGatewayPairingCodeResult,
  RemoteGatewayStatus,
} from "@minih-agent/shared";

import {
  ACCOUNT_MODE_NO_KEY_REASON,
  accountEnrollmentCurrent,
  createAccountEnroller,
  desktopEnrollmentLabel,
  readAccountGateway,
  readAccountModeAvailability,
  type AccountGatewayState,
} from "./account-mode.js";
import { createDesktopDevices, type DesktopDevices } from "./account-devices.js";
import { createDesktopHostOperations } from "./desktop-host-operations.js";
import type { GatewayCredentialStore } from "./gateway-credential-store.js";
import {
  GATEWAY_LINK_UNAVAILABLE,
  type GatewayLinkPort,
  type HostLinkHandle,
  type HostLinkStatus,
} from "./gateway-link-port.js";

/**
 * The single owner of the desktop Host link's lifecycle (rollout R5, ADR 0331).
 *
 * The desktop dials the user's Gateway over one outbound Host link and never
 * listens. Nothing here runs while the feature is off: `RacpServer` and the
 * transport handle are only created when the switch is on *and* an enrollment
 * exists, and both are torn down before the state leaves the running set.
 *
 * Async safety (AGENTS §9):
 * - an enrollment still in flight when the switch turns off (or the service is
 *   disposed) is discarded — its credentials are neither stored nor started;
 * - rapid on/off calls are serialized, so each performs exactly one transition
 *   and a second `start` can never overlap a live handle;
 * - `dispose()` is idempotent and leaves no handle, server, or listener.
 */

/** Pairing codes are valid for ten minutes, as the settings page states. */
export const GATEWAY_PAIRING_CODE_LIFETIME_MS = 10 * 60_000;

export const GATEWAY_LINK_ENROLL_FAILED = "GATEWAY_LINK_ENROLL_FAILED";
export const GATEWAY_LINK_REJECTED = "GATEWAY_LINK_REJECTED";
export const GATEWAY_LINK_FAILED = "GATEWAY_LINK_FAILED";

export type GatewayLinkServiceOptions = {
  port: GatewayLinkPort;
  /** Encrypted credential store; the service opens it, the caller owns it. */
  store: GatewayCredentialStore;
  /** Data directory: the device revocation queue lives under it. */
  dataDir: string;
  /** The desktop's existing Agent Host instance; never a new one. */
  agentHost: () => AgentHost;
  /** The same host-core RPC source the bridge uses. */
  getHost: () => HostRpc | null;
  /**
   * Whether a session has an active turn; configuration and deletion are
   * idle-only (package D).
   */
  isSessionBusy?: (sessionId: string) => boolean;
  /**
   * Remove a session the way the app's own delete does, after the row is gone:
   * cancel derived work, drop queued persistence, dispose the runtime session.
   */
  removeSession?: (sessionId: string) => Promise<void>;
  /** `server.name` reported to a remote client. */
  serverName?: string;
  serverVersion: string;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  /** Wall clock, injectable for tests. */
  now?: () => number;
  /** Reconnect backoff handed to the transport. */
  backoff?: { baseDelayMs?: number; maxDelayMs?: number };
  /** Persisted strict-mode switch (ADR decision 9); off when absent. */
  strictDevices?: boolean;
  /** Persist the strict-mode switch without touching the other settings. */
  saveStrictDevices?: (strictDevices: boolean) => Promise<void>;
  /**
   * "Allow same-account computers to join automatically" (ADR amendment 3,
   * decision 3). On when absent. Unlike strict mode it is not part of the
   * capability list, so flipping it needs no link rebuild.
   */
  desktopAutoAdmission?: boolean;
  /** Persist that switch without touching the other settings. */
  saveDesktopAutoAdmission?: (desktopAutoAdmission: boolean) => Promise<void>;
  /** Push one `device.request` to the renderer; absent means no window can ask. */
  emitDeviceRequest?: (request: RemoteGatewayDeviceRequest) => void;
  /** One notice per mint, adoption, and revocation (ADR decision 6). */
  emitDeviceNotice?: (notice: RemoteGatewayDeviceNotice) => void;
  /**
   * Redacted push (§11.6): the link-bound notifier created by the bootstrap. It
   * carries the four notification-worthy events to `host.notify` while a link is
   * up; absent means this desktop reports none, and no push names it.
   */
  notifier?: HostNotifier | null;
};

export type GatewayLinkService = {
  /** Read the stored credentials and apply the persisted switch state. */
  initialize(options: { enabled: boolean }): Promise<void>;
  status(): RemoteGatewayStatus;
  /**
   * The same snapshot, with the account-mode answer re-read first while the
   * switch is off. While it is on, `syncAccountMode` owns that answer and
   * nothing extra is read; the synchronous `status()` stays unchanged for every
   * existing caller.
   */
  refreshStatus(): Promise<RemoteGatewayStatus>;
  setEnabled(enabled: boolean): Promise<RemoteGatewayLinkState>;
  enroll(input: RemoteGatewayEnrollRequest): Promise<void>;
  createPairingCode(): Promise<RemoteGatewayPairingCodeResult>;
  listDevices(): Promise<RemoteGatewayDeviceSummary[]>;
  revokeDevice(deviceId: string): Promise<boolean>;
  /** Account mode: answer one pending `device.request`. */
  answerDeviceRequest(requestId: string, approved: boolean): boolean;
  /** Account mode: requests still waiting for this desktop's user. */
  pendingDeviceRequests(): RemoteGatewayDeviceRequest[];
  /** The dialog host went away: refuse everything waiting. */
  devicePresence(present: boolean): number;
  /** ADR decision 9: rebuild the link so the capability list matches. */
  setStrictDevices(strictDevices: boolean): Promise<RemoteGatewayStatus>;
  /**
   * ADR amendment 3: allow or refuse automatic admission of a same-account
   * computer. The capability list does not change, so the link is not rebuilt —
   * only the decision the directory makes for the next proof.
   */
  setDesktopAutoAdmission(enabled: boolean): Promise<RemoteGatewayStatus>;
  /** Status pushes; the returned function removes the listener. */
  onChange(listener: (status: RemoteGatewayStatus) => void): () => void;
  dispose(): Promise<void>;
};

/** States a transport report can put the service in. */
type TransportState = Exclude<HostLinkStatus["state"], "stopped"> | "disabled";

/** How one transport state reads to the settings page. */
function mapTransportState(state: HostLinkStatus["state"], enabled: boolean): TransportState {
  switch (state) {
    case "connected":
      return "connected";
    case "connecting":
      return "connecting";
    case "backoff":
      return "backoff";
    case "rejected":
      return "rejected";
    case "stopped":
      // We stop the handle ourselves on disable; a transport that reports a
      // stop while the switch is on lost its link and is being restarted.
      return enabled ? "connecting" : "disabled";
  }
}

function failureOf(error: unknown, code: string): RemoteGatewayFailure {
  const message = error instanceof Error ? error.message : String(error);
  const reported = (error as { errorCode?: string } | null)?.errorCode;
  return { code: reported ?? code, message };
}

function iso(now: () => number): string {
  return new Date(now()).toISOString();
}

export function createGatewayLinkService(options: GatewayLinkServiceOptions): GatewayLinkService {
  const log = options.log;
  const now = options.now ?? (() => Date.now());
  const authenticator = new DeviceTokenAuthenticator(options.store, now);
  const listeners = new Set<(status: RemoteGatewayStatus) => void>();

  let enabled = false;
  let opened = false;
  let disposed = false;
  let server: RacpServer | null = null;
  let handle: HostLinkHandle | null = null;
  /** Account mode as the Router answered it last; `undefined` until read. */
  let accountMode: RemoteGatewayAccountMode | undefined;
  /** The device directory of the running link; null when not account-bound. */
  let accountDevices: DesktopDevices | null = null;
  let strictDevices = options.strictDevices === true;
  let desktopAutoAdmission = options.desktopAutoAdmission !== false;
  const enroller = createAccountEnroller({
    port: options.port,
    store: options.store,
    getHost: options.getHost,
    log,
  });
  let state: {
    name: RemoteGatewayLinkState;
    since: string;
    lastError?: RemoteGatewayFailure;
    nextRetryAt?: string;
  } = { name: "disabled", since: iso(now) };
  /**
   * Bumped whenever a run of enrollment stops being wanted. An enrollment that
   * finishes under a newer generation is dropped instead of persisted/started.
   */
  let enrollmentGeneration = 0;
  let transitionQueue: Promise<void> = Promise.resolve();

  const snapshot = (): RemoteGatewayStatus => ({
    state: state.name,
    since: state.since,
    enabled,
    enrolled: opened ? options.store.enrolled() : false,
    ...(opened ? { hostId: options.store.hostId() } : {}),
    // The name a phone already shows for this computer; the accounts page
    // labels "This computer" with it.
    ...(desktopEnrollmentLabel() ? { hostLabel: desktopEnrollmentLabel() } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
    ...(state.nextRetryAt ? { nextRetryAt: state.nextRetryAt } : {}),
    // Account mode is reported once the Router answer has been read; until then
    // the page keeps showing the self-hosted flow.
    ...(accountMode ? { accountMode } : {}),
    strictDevices,
    desktopAutoAdmission,
  });

  const emit = (): void => {
    const current = snapshot();
    for (const listener of [...listeners]) {
      try {
        listener(current);
      } catch (error) {
        log("warn", "gateway link status listener failed", { error: String(error) });
      }
    }
  };

  const setState = (
    name: RemoteGatewayLinkState,
    extra?: { lastError?: RemoteGatewayFailure; nextRetryAt?: string },
  ): void => {
    state = { name, since: iso(now), lastError: extra?.lastError, nextRetryAt: extra?.nextRetryAt };
    emit();
  };

  /** Serialize lifecycle transitions so a start never overlaps a live handle. */
  const transition = (operation: () => Promise<void>): Promise<void> => {
    const run = transitionQueue.then(operation);
    transitionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** Open the store once; a retry after a transient failure is allowed. */
  const ensureOpen = async (): Promise<void> => {
    if (opened) return;
    await options.store.open();
    opened = true;
  };

  const applyTransportStatus = (transportStatus: HostLinkStatus): void => {
    if (disposed) return;
    const name = mapTransportState(transportStatus.state, enabled);
    const failing = name === "rejected" || name === "backoff";
    setState(name, {
      ...(failing
        ? {
            lastError: {
              code: name === "rejected" ? GATEWAY_LINK_REJECTED : GATEWAY_LINK_FAILED,
              message: transportStatus.lastError ?? "the gateway link is not connected",
            },
          }
        : {}),
      ...(transportStatus.nextRetryAt ? { nextRetryAt: transportStatus.nextRetryAt } : {}),
    });
  };

  /**
   * Revoke one paired device (security §3.7, gate 26 / S9).
   *
   * Both revocation paths land here — the settings page
   * (`service.revokeDevice`) and RACP `session/revoke`
   * (`operations.revokeDevice`) — so a revoked device loses its open logical
   * connections the moment the store records the revocation, not on its next
   * reconnect. The closed count is logged; the subject is the device id the
   * authenticator already put on the connection, never a token.
   */
  const revokeStoredDevice = async (deviceId: string): Promise<boolean> => {
    // Account mode: the revocation must also reach the account's other Hosts,
    // so it goes through the signed frame — queued while the link is down, so a
    // device revoked offline still stops working everywhere (protocol §11.5).
    const current = handle;
    if (current?.revokeDevice && accountDevices) {
      const outcome = await current.revokeDevice(deviceId);
      const closed = server ? server.closeConnectionsForSubject(deviceId, "device revoked") : 0;
      log("info", "account-mode device revoked", {
        deviceId,
        announced: outcome.announced,
        closedConnections: closed,
      });
      return outcome.revoked;
    }
    const revoked = await options.store.revokeDevice(deviceId, iso(now));
    if (!revoked) return false;
    const closed = server ? server.closeConnectionsForSubject(deviceId, "device revoked") : 0;
    log("info", "gateway device revoked", { deviceId, closedConnections: closed });
    return true;
  };

  /**
   * Refresh the account-mode answer and, when the Router offers it, make this
   * desktop's enrollment match it.
   *
   * Called before every start, so the link follows the Router: an endpoint that
   * moved re-enrolls, one that disappeared leaves the stored credentials alone
   * (a key change revokes nothing by itself, ADR decision 8) and the page
   * explains why account mode is off.
   */
  const syncAccountMode = async (): Promise<AccountGatewayState> => {
    const previous = accountMode?.available === true;
    let state_: AccountGatewayState;
    try {
      state_ = await readAccountGateway(options.getHost());
    } catch (error) {
      state_ = { supported: false, mode: { available: false, reason: String(error) } };
    }
    accountMode = state_.mode;
    if (!state_.gateway) {
      if (previous) {
        log("info", "account mode is no longer advertised; keeping the stored enrollment", {
          reason: state_.mode.reason ?? "",
        });
      }
      return state_;
    }
    const outcome = await enroller.ensure();
    if (outcome.state === "no-access-key") {
      log("info", "account mode needs a Minih Router key; the self-hosted flow applies");
      accountMode = {
        ...state_.mode,
        available: false,
        reason: ACCOUNT_MODE_NO_KEY_REASON,
      };
    } else if (outcome.state === "failed") {
      const failure = failureOf(outcome.error, GATEWAY_LINK_ENROLL_FAILED);
      accountMode = { ...state_.mode, available: false, reason: failure.message };
    }
    return { ...state_, mode: accountMode ?? state_.mode };
  };

  /**
   * Refresh the account-mode answer while the switch is off.
   *
   * A desktop that has not enrolled has nothing to dial, so the switch is the
   * only thing that could bring the link up — and the page has to be able to
   * say whether that switch would work. This reads availability without
   * enrolling, dialing, or opening anything (see `readAccountModeAvailability`),
   * and is what makes a fresh install show account mode instead of waiting for
   * the enrollment the switch was waiting for.
   */
  const refreshAccountModeAvailability = async (): Promise<void> => {
    try {
      accountMode = await readAccountModeAvailability(options.getHost());
    } catch (error) {
      // An unreadable answer is not an unreachable Gateway: report the reason
      // the page can show and keep the rest of the status untouched.
      accountMode = { available: false, reason: String(error) };
    }
  };

  /**
   * The address this attempt dials: whatever the overlay reaches the Gateway on
   * right now. No-TUN re-allocates the forward port on every overlay start, so
   * it is read per connection — the credentials keep only the advertised
   * endpoint. An answer without a usable endpoint is a transport failure, never
   * a reason to dial the port that happened to exist at enrollment.
   */
  const resolveAccountDialUrl = async (): Promise<string> => {
    const state = await readAccountGateway(options.getHost());
    if (!state.gateway) {
      throw new Error(state.mode.reason ?? "account mode is not available");
    }
    return state.gateway.dialUrl;
  };

  const startLink = async (): Promise<void> => {
    if (disposed || !enabled || handle || server) return;
    accountDevices = null;
    await syncAccountMode();
    const credentials = options.store.credentials();
    if (!credentials) {
      setState("not-enrolled");
      emit();
      return;
    }
    setState("starting");
    // An account-bound certificate is what a sibling Host accepts, so only then
    // does this desktop advertise `device.confirm` (security gate 33).
    accountDevices = createDesktopDevices({
      dataDir: options.dataDir,
      hostId: credentials.hostId || options.store.hostId(),
      signer: { certificatePem: credentials.certificatePem, privateKeyPem: credentials.privateKeyPem },
      gatewayCaPem: credentials.gatewayCaPem,
      store: options.store,
      log,
      ...(options.emitDeviceRequest ? { emitRequest: options.emitDeviceRequest } : {}),
      strictDevices,
      desktopAutoAdmission,
      ...(options.emitDeviceNotice
        ? {
            onNotice: (notice) =>
              options.emitDeviceNotice?.({
                kind: notice.kind,
                deviceId: notice.deviceId,
                label: notice.label,
                at: notice.at,
                ...(notice.deviceClass ? { deviceClass: notice.deviceClass } : {}),
              }),
          }
        : {}),
      now,
    });
    const racpServer = new RacpServer({
      agentHost: options.agentHost(),
      operations: createDesktopHostOperations({
        getHost: options.getHost,
        revokeDevice: revokeStoredDevice,
        // Inline attachments from a phone land in the same content-addressed
        // store the desktop itself uses for the files it attaches.
        dataDir: options.dataDir,
        // Package D: the two questions a desktop-class device's session
        // controls ask. Busy means AGENT_BUSY, and a deleted row is cleaned up
        // exactly as the local delete does.
        ...(options.isSessionBusy ? { isSessionBusy: options.isSessionBusy } : {}),
        ...(options.removeSession ? { removeSession: options.removeSession } : {}),
        // A phone that starts a conversation here or registers a folder changed
        // this computer's state, so the person sitting at it has to learn about
        // it at once. It travels on the notice channel the settings page
        // already renders (ADR decision 6) and through the Host log with the
        // device id, so it is auditable without a second mechanism.
        reportRemoteAction: (action) => {
          const at = new Date(now()).toISOString();
          options.emitDeviceNotice?.({
            kind: action.kind === "project.registered" ? "device.project-registered"
              : action.kind === "session.configured" ? "device.session-configured"
              : "device.session-created",
            deviceId: action.deviceId,
            label: action.changes?.join(", ") ?? action.path ?? action.sessionId ?? "",
            at,
          });
          log("info", "remote device changed local state", {
            kind: action.kind,
            deviceId: action.deviceId,
            ...(action.projectId ? { projectId: action.projectId } : {}),
            ...(action.sessionId ? { sessionId: action.sessionId } : {}),
            ...(action.path ? { path: action.path } : {}),
            ...(action.changes ? { changes: action.changes } : {}),
          });
        },
      }),
      authenticator,
      hostId: credentials.hostId || options.store.hostId(),
      serverName: options.serverName ?? "minih-agent-desktop",
      serverVersion: options.serverVersion,
      // Default policy: `remoteMaxPermissionMode: "ask"`. A gateway-origin
      // principal is additionally clamped by AgentHost regardless of policy.
      log,
      now,
    });
    let started: HostLinkHandle;
    try {
      started = options.port.start({
        credentials,
        server: racpServer,
        authenticator,
        log,
        onStatus: applyTransportStatus,
        ...(options.backoff ? { backoff: options.backoff } : {}),
        ...(credentials.tlsServerName ? { tlsServerName: credentials.tlsServerName } : {}),
        // Account mode follows the overlay's current forward port on every
        // connect and reconnect; the self-hosted flow dials its stored URL.
        ...(credentials.hostlinkUrl ? { resolveDialUrl: resolveAccountDialUrl } : {}),
        ...(accountDevices ? { devices: accountDevices.directory } : {}),
        ...(accountDevices ? { revocations: accountDevices.revocations } : {}),
        ...(options.notifier ? { notifier: options.notifier } : {}),
        // "A new computer joined the account" is information for the person at
        // this machine, never an authorization, so it becomes the same notice a
        // device gets (ADR amendment 3, Accepted risk).
        ...(options.emitDeviceNotice
          ? {
              onHostJoined: (notice) =>
                options.emitDeviceNotice?.({
                  kind: "host.joined",
                  deviceId: notice.hostId,
                  label: notice.label,
                  at: notice.joinedAt,
                }),
            }
          : {}),
      });
    } catch (error) {
      // The transport is missing or refused to start: report it, never keep a
      // half-built server around.
      racpServer.close();
      accountDevices = null;
      log("error", "gateway link transport start failed", { error: String(error) });
      setState("error", { lastError: failureOf(error, GATEWAY_LINK_UNAVAILABLE) });
      return;
    }
    server = racpServer;
    handle = started;
    log("info", "gateway link started", {
      hostId: credentials.hostId,
      accountMode: Boolean(credentials.tlsServerName),
      capabilities: accountDevices?.capabilities.length ?? 0,
    });
    applyTransportStatus(started.status());
    emit();
  };

  const stopLink = async (): Promise<void> => {
    const stopping = handle;
    const stoppingServer = server;
    handle = null;
    server = null;
    // A dialog with no link behind it can never be answered meaningfully.
    accountDevices?.confirmer.denyAll("the gateway link stopped");
    accountDevices = null;
    if (stopping) {
      try {
        await stopping.stop();
      } catch (error) {
        log("warn", "gateway link stop failed", { error: String(error) });
      }
    }
    stoppingServer?.close();
    if (stopping) log("info", "gateway link stopped");
    setState(enabled ? "connecting" : "disabled");
  };

  return {
    async initialize({ enabled: shouldEnable }) {
      enabled = shouldEnable;
      try {
        await ensureOpen();
      } catch (error) {
        log("error", "gateway credentials could not be loaded", { error: String(error) });
        setState("error", { lastError: failureOf(error, GATEWAY_LINK_FAILED) });
        return;
      }

      if (!shouldEnable) {
        // The switch is the only way this desktop could ever enroll, so the
        // page has to know whether that switch would work — read now, without
        // enrolling anything.
        await refreshAccountModeAvailability();
        setState("disabled");
        return;
      }
      await transition(startLink);
    },
    status() {
      return snapshot();
    },
    async refreshStatus() {
      // Off means nothing is dialed and nothing enrolls, so the only way this
      // desktop could come back is the switch — and the page has to know
      // whether that would work right now. On, the running link keeps the
      // answer current (`syncAccountMode`), and re-reading here would be
      // duplicated RPCs on every status request.
      if (!disposed && !enabled) await refreshAccountModeAvailability();
      return snapshot();
    },
    async setEnabled(next) {
      if (disposed) {
        enabled = false;
        return snapshot().state;
      }
      if (!next) enrollmentGeneration += 1;
      enabled = next;
      if (next) {
        try {
          await ensureOpen();
        } catch (error) {
          log("error", "gateway credentials could not be loaded", { error: String(error) });
          setState("error", { lastError: failureOf(error, GATEWAY_LINK_FAILED) });
          return snapshot().state;
        }
      }
      await transition(async () => {
        if (!enabled) {
          await stopLink();
          // Switched back off: keep reporting whether account mode is usable,
          // so the page still offers the way back in.
          await refreshAccountModeAvailability();
          emit();
          return;
        }
        await startLink();
      });
      return snapshot().state;
    },
    async enroll(input) {
      if (disposed) {
        throw Object.assign(new Error("the gateway link has been disposed"), {
          errorCode: GATEWAY_LINK_FAILED,
        });
      }
      const gatewayUrl = input.url.trim();
      const gatewayCaPem = input.caPem.trim();
      const enrollmentCode = input.code.trim();
      if (!gatewayUrl || !gatewayCaPem || !enrollmentCode) {
        throw Object.assign(
          new Error("gateway URL, CA certificate, and registration code are required"),
          { errorCode: "INVALID_ARGUMENT" },
        );
      }
      await ensureOpen();
      const generation = (enrollmentGeneration += 1);
      setState("enrolling");
      let credentials;
      try {
        credentials = await options.port.enroll({
          gatewayUrl,
          gatewayCaPem,
          enrollmentCode,
          hostId: options.store.hostId(),
        });
      } catch (error) {
        const failure = failureOf(error, GATEWAY_LINK_ENROLL_FAILED);
        if (generation === enrollmentGeneration) {
          setState(handle ? state.name : enabled ? "not-enrolled" : "disabled", {
            lastError: failure,
          });
        }
        throw error;
      }
      if (generation !== enrollmentGeneration || disposed) {
        // The switch went off (or the app is closing) while the Gateway was
        // answering: the result is void, and nothing is persisted or started.
        log("info", "gateway enrollment result discarded", { reason: "superseded" });
        return;
      }
      await options.store.saveCredentials(credentials);
      log("info", "gateway enrollment stored", { hostId: credentials.hostId });
      await transition(async () => {
        await stopLink();
        if (enabled) await startLink();
      });
    },
    async createPairingCode() {
      await ensureOpen();
      const { token, expiresAt } = await authenticator.issuePairingToken(
        GATEWAY_PAIRING_CODE_LIFETIME_MS,
        "gateway",
      );
      // The Host id travels with the code: the browser pairs against
      // `/v1/hosts/{hostId}/pair` and cannot look it up through the
      // Host-scoped cookie path.
      return { code: token, expiresAt, hostId: options.store.hostId() };
    },
    async listDevices() {
      await ensureOpen();
      // A revoked record is a tombstone, not a device: it stays in the store so a
      // re-delivered grant cannot resurrect it (protocol §11.5), but it is not
      // something the accounts page offers to revoke, and listing it made one
      // phone look like several. Only live devices reach the renderer.
      return (await options.store.listDevices())
        .filter((device) => !device.revokedAt)
        .map((device) => ({
          deviceId: device.deviceId,
          label: device.label,
          roles: [...device.roles],
          createdAt: device.createdAt,
          ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
          // What the row is, for the accounts page's "My devices": a computer
          // admitted with a verified proof, a phone paired through the Gateway,
          // or an SSH pairing from before the Gateway existed.
          ...(device.deviceClass ? { deviceClass: device.deviceClass === "desktop" ? "desktop" as const : "phone" as const } : {}),
          ...(device.origin ? { origin: device.origin } : { origin: "ssh" as const }),
        }));
    },
    revokeDevice(deviceId) {
      return revokeStoredDevice(deviceId);
    },
    answerDeviceRequest(requestId, approved) {
      // A dialog for a link that already stopped is refused, not applied.
      return accountDevices?.confirmer.answer(requestId, approved) ?? false;
    },
    pendingDeviceRequests() {
      return accountDevices?.confirmer.pending() ?? [];
    },
    devicePresence(present) {
      // The window that was asked went away (closed or reloaded): every dialog
      // it was showing is refused, so no client waits on a dead prompt.
      if (present) return 0;
      return accountDevices?.confirmer.denyAll("the confirmation window went away") ?? 0;
    },
    async setStrictDevices(next) {
      if (disposed) return snapshot();
      if (strictDevices === next) return snapshot();
      // Persist first: a crash between the two leaves the switch truthful.
      if (options.saveStrictDevices) await options.saveStrictDevices(next);
      strictDevices = next;
      emit();
      // The capability list is part of what the link announces, so a change
      // takes effect by rebuilding it. Nothing else about the link changes.
      await transition(async () => {
        await stopLink();
        if (enabled) await startLink();
      });
      return snapshot();
    },
    async setDesktopAutoAdmission(next) {
      if (disposed) return snapshot();
      if (desktopAutoAdmission === next) return snapshot();
      // Persist first, for the same reason as the strict switch.
      if (options.saveDesktopAutoAdmission) await options.saveDesktopAutoAdmission(next);
      desktopAutoAdmission = next;
      // The capability list does not change, so no link rebuild is needed and no
      // relayed connection is dropped: the directory simply stops (or starts)
      // admitting a verified proof without asking.
      accountDevices?.directory.setDesktopAutoAdmission(next);
      emit();
      return snapshot();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      enrollmentGeneration += 1;
      enabled = false;
      await transition(stopLink);
      listeners.clear();
    },
  };
}
