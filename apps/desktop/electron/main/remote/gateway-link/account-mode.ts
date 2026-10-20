import os from "node:os";

import type { EasyTierStatus, RemoteGatewayAccountMode } from "@minih-agent/shared";

import { isMinihRouterVendorKey } from "@minih-agent/shared";

import type { GatewayCredentialStore } from "./gateway-credential-store.js";
import type { GatewayLinkPort, HostLinkCredentials } from "./gateway-link-port.js";

/**
 * Account mode: the desktop joins the Router account instead of typing a
 * registration code (ADR `remote-control-router-account-binding`, D666;
 * rollout R7 package E2).
 *
 * Everything the decision needs comes from host-core: `EasyTierStatus.remoteGateway`
 * already carries the advertised endpoint, the CA, the address to dial, and the
 * certificate identity (package E1). This module never parses the bootstrap
 * itself, so there is exactly one place that interprets a Router answer.
 *
 * The Router AccessKey is read from the saved `minih-router` provider row
 * through host-core (`providers.getSecret`), used for the one enrollment
 * request, and dropped. It never enters an IPC payload, the status projection,
 * a log line, or the encrypted credential file — the file holds only the Host
 * certificate and key, exactly like the self-hosted flow.
 */

/** The account-mode fields this module consumes from `EasyTierStatus`. */
export type AccountGateway = {
  /** Endpoint to dial: the loopback forward in No-TUN mode. */
  dialUrl: string;
  /** Pinned Gateway CA. */
  caPem: string;
  /** Certificate identity; never the loopback address. */
  tlsServerName: string;
  /** The advertised Host-link URL, for the settings page. */
  hostlinkUrl: string;
  /** The advertised HTTPS origin, for the settings page. */
  publicOrigin: string;
};

/** What the Router answered about account mode. */
export type AccountGatewayState = {
  /** Absent when this host-core does not report the field at all. */
  supported: boolean;
  mode: RemoteGatewayAccountMode;
  /** Present only when the endpoint is usable right now. */
  gateway?: AccountGateway;
};

type HostCaller = {
  call<T>(method: string, params?: unknown): Promise<T>;
};

/** Read account mode from host-core; a failure reads as "unsupported". */
export async function readAccountGateway(host: HostCaller | null): Promise<AccountGatewayState> {
  const none: AccountGatewayState = {
    supported: false,
    mode: { available: false, reason: "the local host is not running" },
  };
  if (!host) return none;
  let status: EasyTierStatus;
  try {
    status = await host.call<EasyTierStatus>("easytier.status", {});
  } catch {
    return none;
  }
  const reported = status?.remoteGateway;
  // An older host-core does not report the field: keep the self-hosted flow and
  // show no account-mode affordance at all.
  if (!reported) return { supported: false, mode: { available: false } };

  const reason = typeof reported.unavailableReason === "string" ? reported.unavailableReason.trim() : "";
  const mode: RemoteGatewayAccountMode = {
    available: reported.available === true,
    ...(reported.hostlinkUrl ? { url: reported.hostlinkUrl } : {}),
    ...(reported.publicOrigin ? { publicOrigin: reported.publicOrigin } : {}),
    ...(reported.available === true ? {} : { reason }),
  };
  if (reported.available !== true) return { supported: true, mode };

  const hostlinkUrl = typeof reported.hostlinkUrl === "string" ? reported.hostlinkUrl.trim() : "";
  const dialUrl = typeof reported.dialUrl === "string" ? reported.dialUrl.trim() : "";
  const caPem = typeof reported.caPem === "string" ? reported.caPem.trim() : "";
  const tlsServerName = typeof reported.tlsServerName === "string" ? reported.tlsServerName.trim() : "";
  // The advertised endpoint is the registration identity, so an answer without
  // it is incomplete even when an address is dialable.
  if (!hostlinkUrl || !dialUrl || !caPem || !tlsServerName) {
    return {
      supported: true,
      mode: { ...mode, available: false, reason: "the advertised endpoint is incomplete" },
    };
  }
  return {
    supported: true,
    mode,
    gateway: {
      dialUrl,
      caPem,
      tlsServerName,
      hostlinkUrl: reported.hostlinkUrl ?? "",
      publicOrigin: reported.publicOrigin ?? "",
    },
  };
}

/**
 * The name a phone shows for this computer, or `undefined` when there is none.
 *
 * The Gateway stores exactly what the Host reports and falls back to the
 * `host_<uuid>` id, which is what the phone was showing. `os.hostname()` is the
 * name the user gave the machine and the one every other tool on it shows; the
 * `.local` suffix is mDNS plumbing a phone cannot use, so it is dropped. The
 * value is trimmed, bounded to the Gateway's own limit (128) so a long name is
 * cut rather than rejected, and an empty result is left out entirely so the
 * Gateway keeps its fallback. Nothing else is derived or sent: the name must
 * never carry a key or an account identifier.
 */
export function desktopEnrollmentLabel(
  hostname: () => string | undefined = () => os.hostname(),
): string | undefined {
  const raw = (hostname() ?? "").trim();
  if (!raw) return undefined;
  const withoutSuffix = raw.replace(/\.local\.?$/i, "").trim() || raw;
  return withoutSuffix.slice(0, HOST_LABEL_MAX_LENGTH);
}

/** The Gateway's own bound on a Host label (`apps/remote-gateway/src/enrollment.ts`). */
const HOST_LABEL_MAX_LENGTH = 128;

/** The row shape `providers.list` returns, as far as account mode reads it. */
type ProviderRow = { id?: string; vendorKey?: string; hasSecret?: boolean; enabled?: boolean };

/** Why account mode cannot take over: there is no Router account to join. */
export const ACCOUNT_MODE_NO_KEY_REASON = "no Minih Router AccessKey is configured";

/**
 * The `minih-router` provider row account mode would enroll with, or `null`
 * when the user has no such row or it carries no token.
 *
 * The row is chosen the way the D661 rule does — the first enabled
 * `minih-router` row with a token — so account mode joins the account the
 * settings page already shows. This lists rows only and never decrypts a
 * secret, so it is safe to call just to answer "could account mode work?".
 */
async function findAccountProviderRow(host: HostCaller | null): Promise<ProviderRow | null> {
  if (!host) return null;
  let rows: ProviderRow[];
  try {
    const listed = await host.call<{ providers?: unknown[] }>("providers.list", {
      includeDisabled: true,
    });
    rows = Array.isArray(listed?.providers) ? (listed.providers as ProviderRow[]) : [];
  } catch {
    return null;
  }
  const row = rows.find(
    (candidate) =>
      typeof candidate.id === "string" &&
      candidate.hasSecret === true &&
      // A disabled row is the user saying "stop using this account"; account
      // mode must not enroll with it either.
      candidate.enabled !== false &&
      isMinihRouterVendorKey(candidate.vendorKey),
  );
  return row?.id ? row : null;
}

/**
 * The Minih Router AccessKey main will enroll with, or `null` when the user has
 * no Router row or that row carries no token.
 *
 * The key is returned to main only; the caller must not store it, log it, or
 * put it in a status projection.
 */
export async function resolveAccountAccessKey(
  host: HostCaller | null,
): Promise<{ accessKey: string; providerId: string } | null> {
  if (!host) return null;
  const row = await findAccountProviderRow(host);
  if (!row?.id) return null;
  try {
    const secret = await host.call<{ value?: string }>("providers.getSecret", { id: row.id });
    const accessKey = typeof secret?.value === "string" ? secret.value.trim() : "";
    return accessKey ? { accessKey, providerId: row.id } : null;
  } catch {
    return null;
  }
}

/**
 * Whether account mode could be used right now — decided without changing
 * anything.
 *
 * The settings page needs this *before* the user turns the remote-control
 * switch on, because the switch itself needs something to dial: an existing
 * enrollment, or an account mode that can enroll. Reading it only while
 * starting the link would leave a freshly installed desktop with a greyed
 * switch and no visible account mode at all, waiting for an enrollment that
 * the switch was waiting for.
 *
 * So this reads `EasyTierStatus.remoteGateway` and checks that a Router row
 * exists, and nothing more: it never decrypts the key, never enrolls, never
 * dials, and never starts a link. Turning the switch on is what enrolls.
 *
 * `undefined` means host-core does not report the field at all: the page then
 * keeps the self-hosted flow with no account-mode affordance, exactly as
 * before the feature existed.
 *
 * Cost: one `easytier.status` and one `providers.list` per call. Both are local
 * host-core RPCs, and host-core pushes no EasyTier-state event to subscribe to,
 * so this is called on the reads that already happen — boot and every status
 * request — and never on a timer.
 */
export async function readAccountModeAvailability(
  host: HostCaller | null,
): Promise<RemoteGatewayAccountMode | undefined> {
  const state = await readAccountGateway(host);
  if (!state.supported) return undefined;
  if (!state.mode.available) return state.mode;
  // The endpoint is usable; the missing piece would be the account to join.
  const row = await findAccountProviderRow(host);
  if (!row) return { ...state.mode, available: false, reason: ACCOUNT_MODE_NO_KEY_REASON };
  return state.mode;
}

/**
 * Whether the stored credentials still belong to the Gateway the Router
 * advertises now.
 *
 * The identity is the advertised endpoint — `hostlinkUrl`, the pinned CA, and
 * the certificate service name — never the address that is dialled: in No-TUN
 * mode that address is a loopback forward whose port host-core re-allocates on
 * every overlay start, so treating it as identity would re-enroll on every
 * restart and, with a disabled key, strand the Host on a dead port (ADR
 * decision 8). A rotation inside one account keeps the account, so the Host
 * certificate stays valid; what invalidates an enrollment is the Gateway really
 * changing. Comparing the identity tuple — never the key — decides that without
 * a network call.
 */
export function accountEnrollmentCurrent(
  credentials: HostLinkCredentials | undefined,
  gateway: AccountGateway,
): boolean {
  if (!credentials?.tlsServerName) return false;
  // A credential written before the identity was stored cannot prove which
  // endpoint it belongs to, so it is replaced once.
  const identity = credentials.hostlinkUrl ?? "";
  if (!identity) return false;
  return (
    identity === gateway.hostlinkUrl &&
    credentials.gatewayCaPem === gateway.caPem &&
    credentials.tlsServerName === gateway.tlsServerName
  );
}

export type AccountEnrollOutcome =
  | { state: "enrolled"; credentials: HostLinkCredentials }
  | { state: "unchanged"; credentials: HostLinkCredentials }
  | { state: "unavailable"; reason: string }
  | { state: "no-access-key" }
  | { state: "failed"; error: unknown };

export type AccountEnroller = {
  /**
   * Bring this desktop's account-mode enrollment in line with what the Router
   * advertises. Idempotent: a second call with the same endpoint does nothing
   * unless `force` is set (the settings page's explicit retry).
   */
  ensure(force?: boolean): Promise<AccountEnrollOutcome>;
};

export type AccountEnrollerOptions = {
  port: Pick<GatewayLinkPort, "enroll">;
  store: Pick<GatewayCredentialStore, "credentials" | "hostId" | "saveCredentials">;
  getHost: () => HostCaller | null;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  /** Test seam: the machine name reported to the Gateway. */
  hostname?: () => string | undefined;
};

export function createAccountEnroller(options: AccountEnrollerOptions): AccountEnroller {
  const { log } = options;
  /** Serialize enrollment so two triggers cannot mint two certificates. */
  let running: Promise<AccountEnrollOutcome> | null = null;
  /**
   * The Gateway identity that already failed, so a dead Gateway is not retried
   * in a loop. Full text, not a length: two CAs of the same size are different
   * Gateways, and the dial address must never take part (it moves on every
   * overlay start).
   */
  let failedFor: string | null = null;

  const enrollOnce = async (force: boolean): Promise<AccountEnrollOutcome> => {
    const state = await readAccountGateway(options.getHost());
    if (!state.gateway) {
      return { state: "unavailable", reason: state.mode.reason ?? "account mode is not available" };
    }
    const gateway = state.gateway;
    const current = options.store.credentials();
    // The identity decides, never the dialled address: the overlay re-allocates
    // its forward port on every start, and that must not look like a new
    // Gateway (ADR decision 8).
    if (!force && current && accountEnrollmentCurrent(current, gateway)) {
      return { state: "unchanged", credentials: current };
    }
    const fingerprint = `${gateway.hostlinkUrl}\n${gateway.caPem}`;
    if (!force && failedFor === fingerprint) {
      return { state: "failed", error: new Error("the previous enrollment for this Gateway failed") };
    }

    const resolved = await resolveAccountAccessKey(options.getHost());
    if (!resolved) {
      // Nothing to enroll with: the self-hosted flow stays available, and the
      // page explains why account mode did not take over.
      return { state: "no-access-key" };
    }
    try {
      // Account mode has no registration code, so this Host names itself: the
      // phone lists computers by this label, and the Gateway falls back to the
      // host id when it is missing.
      const label = desktopEnrollmentLabel(options.hostname);
      const credentials = await options.port.enroll({
        gatewayUrl: gateway.dialUrl,
        hostlinkUrl: gateway.hostlinkUrl,
        gatewayCaPem: gateway.caPem,
        accessKey: resolved.accessKey,
        hostId: options.store.hostId(),
        tlsServerName: gateway.tlsServerName,
        ...(label ? { label } : {}),
      });
      await options.store.saveCredentials(credentials);
      failedFor = null;
      log("info", "account mode enrolled this desktop", { hostId: credentials.hostId });
      return { state: "enrolled", credentials };
    } catch (error) {
      failedFor = fingerprint;
      // The reason is a Gateway error code; the key is never part of it.
      const code = (error as { errorCode?: string } | null)?.errorCode;
      log("warn", "account mode enrollment failed", {
        code: code ?? "UNKNOWN",
        message: error instanceof Error ? error.message : String(error),
      });
      return { state: "failed", error };
    }
  };

  return {
    ensure(force = false) {
      if (running) return running;
      running = enrollOnce(force).finally(() => {
        running = null;
      });
      return running;
    },
  };
}
