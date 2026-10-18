import type { AgentHost } from "@minih-agent/agent-host";
import type { HostRpc } from "@minih-agent/host-runtime";
import { DeviceTokenAuthenticator, RacpServer } from "@minih-agent/racp";
import type {
  RemoteGatewayDeviceSummary,
  RemoteGatewayEnrollRequest,
  RemoteGatewayFailure,
  RemoteGatewayLinkState,
  RemoteGatewayPairingCodeResult,
  RemoteGatewayStatus,
} from "@minih-agent/shared";

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
  /** The desktop's existing Agent Host instance; never a new one. */
  agentHost: () => AgentHost;
  /** The same host-core RPC source the bridge uses. */
  getHost: () => HostRpc | null;
  /** `server.name` reported to a remote client. */
  serverName?: string;
  serverVersion: string;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  /** Wall clock, injectable for tests. */
  now?: () => number;
  /** Reconnect backoff handed to the transport. */
  backoff?: { baseDelayMs?: number; maxDelayMs?: number };
};

export type GatewayLinkService = {
  /** Read the stored credentials and apply the persisted switch state. */
  initialize(options: { enabled: boolean }): Promise<void>;
  status(): RemoteGatewayStatus;
  setEnabled(enabled: boolean): Promise<RemoteGatewayLinkState>;
  enroll(input: RemoteGatewayEnrollRequest): Promise<void>;
  createPairingCode(): Promise<RemoteGatewayPairingCodeResult>;
  listDevices(): Promise<RemoteGatewayDeviceSummary[]>;
  revokeDevice(deviceId: string): Promise<boolean>;
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
    ...(state.lastError ? { lastError: state.lastError } : {}),
    ...(state.nextRetryAt ? { nextRetryAt: state.nextRetryAt } : {}),
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
    const revoked = await options.store.revokeDevice(deviceId, iso(now));
    if (!revoked) return false;
    const closed = server ? server.closeConnectionsForSubject(deviceId, "device revoked") : 0;
    log("info", "gateway device revoked", { deviceId, closedConnections: closed });
    return true;
  };

  const startLink = async (): Promise<void> => {
    if (disposed || !enabled || handle || server) return;
    const credentials = options.store.credentials();
    if (!credentials) {
      setState("not-enrolled");
      return;
    }
    setState("starting");
    const racpServer = new RacpServer({
      agentHost: options.agentHost(),
      operations: createDesktopHostOperations({
        getHost: options.getHost,
        revokeDevice: revokeStoredDevice,
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
      });
    } catch (error) {
      // The transport is missing or refused to start: report it, never keep a
      // half-built server around.
      racpServer.close();
      log("error", "gateway link transport start failed", { error: String(error) });
      setState("error", { lastError: failureOf(error, GATEWAY_LINK_UNAVAILABLE) });
      return;
    }
    server = racpServer;
    handle = started;
    log("info", "gateway link started", { hostId: credentials.hostId });
    applyTransportStatus(started.status());
  };

  const stopLink = async (): Promise<void> => {
    const stopping = handle;
    const stoppingServer = server;
    handle = null;
    server = null;
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
        setState("disabled");
        return;
      }
      await transition(startLink);
    },
    status() {
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
      return (await options.store.listDevices()).map((device) => ({
        deviceId: device.deviceId,
        label: device.label,
        roles: [...device.roles],
        createdAt: device.createdAt,
        ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
        ...(device.revokedAt ? { revokedAt: device.revokedAt } : {}),
      }));
    },
    revokeDevice(deviceId) {
      return revokeStoredDevice(deviceId);
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
