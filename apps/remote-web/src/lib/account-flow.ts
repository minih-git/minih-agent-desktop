/**
 * The account device flow as a state machine (protocol §11.5, rollout R7
 * package F).
 *
 * One approval on any Host of the account produces one device token that every
 * Host of that account accepts, so the client's job is: sign in, ask, wait, and
 * then adopt that ONE device on every Host the Gateway named. Waiting is the
 * part worth getting right — a device request lives five minutes, nobody may be
 * watching a Host, and the Gateway rate-limits the status reads — so the polling
 * policy is here, with an injected clock and timer, rather than inside a React
 * effect where it could only be tested by waiting.
 *
 * Nothing here stores a secret. The AccessKey goes to `accountLogin` and is
 * dropped by the caller; the account session lives in memory for the length of
 * the flow and is revoked and forgotten the moment the device is adopted.
 */
import {
  accountLogin,
  accountLogout,
  fetchAccountDeviceStatus,
  listAccountHosts,
  requestAccountDevice,
  type AccountClientKind,
  type AccountClientOptions,
  type AccountDeviceHost,
  type AccountHostSummary,
} from "./account-client.js";
import type { AccountAdoption, AccountAdoptionOutcome, HostCredential } from "./credential-port.js";
import { failureFrom, type OperationFailure } from "./errors.js";

/** How often the status route is read while a request is pending. */
export const POLL_INTERVAL_MS = 2_000;
/** Ceiling for the backoff that follows a failed poll. */
export const POLL_MAX_BACKOFF_MS = 15_000;
/** Consecutive failed polls before the client stops waiting and says so. */
export const POLL_MAX_FAILURES = 8;

/** The timer the flow uses, injected so the polling policy is testable. */
export type AccountTimer = {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
};

export const systemTimer: AccountTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type AccountFlowState =
  /** Waiting for an AccessKey. */
  | { kind: "idle" }
  | { kind: "signing-in" }
  | { kind: "sign-in-failed"; failure: OperationFailure }
  /** Signed in; the Host list of the account is known and a device can be asked for. */
  | { kind: "signed-in"; accountId: string; hosts: AccountHostSummary[] }
  | { kind: "requesting"; requestId: string; expiresAt: string; hosts: AccountDeviceHost[] }
  /** A Host approved and the client is adopting the device on every Host. */
  | { kind: "granted"; deviceId: string; expiresAt: string; hosts: AccountDeviceHost[]; signerHostId?: string }
  /** Every Host of the account is now holding this device. */
  | { kind: "adopted"; hostIds: string[] }
  | { kind: "expired"; hosts: AccountDeviceHost[] }
  /** Granted, but the pickup window closed before the token was read. */
  | { kind: "lost"; hosts: AccountDeviceHost[] }
  /** The Gateway no longer knows this request (it expired, or the session changed). */
  | { kind: "gone" }
  | { kind: "failed"; failure: OperationFailure };

export type RosterSummary = {
  /** Online Hosts that can ask their user. */
  confirmable: AccountDeviceHost[];
  /** Online Hosts that would adopt the resulting token. */
  accepting: AccountDeviceHost[];
  /** Hosts that cannot answer at all: offline, or without a confirmer. */
  silent: AccountDeviceHost[];
  anyCanConfirm: boolean;
};

/** Which Hosts of the roster can answer, which would adopt, and which cannot. */
export function rosterSummary(hosts: readonly AccountDeviceHost[]): RosterSummary {
  const confirmable = hosts.filter((host) => host.online && host.canConfirm);
  const accepting = hosts.filter((host) => host.online && host.willAcceptGrant);
  const silent = hosts.filter((host) => !(host.online && host.canConfirm));
  return { confirmable, accepting, silent, anyCanConfirm: confirmable.length > 0 };
}

/** Milliseconds left before the request expires; never negative. */
export function remainingMs(expiresAt: string, now: number): number {
  const deadline = Date.parse(expiresAt);
  if (!Number.isFinite(deadline)) return 0;
  return Math.max(0, deadline - now);
}

/**
 * How long to wait before the next status read. A `RATE_LIMITED` answer wins
 * with the server's own hint; any other failure backs off exponentially, so a
 * Gateway that is restarting is not polled into the ground.
 */
export function pollDelayMs(input: { failure?: OperationFailure; consecutiveFailures: number }): number {
  if (input.failure?.code === "RATE_LIMITED") {
    return Math.max(POLL_INTERVAL_MS, input.failure.retryAfterMs ?? POLL_INTERVAL_MS);
  }
  if (input.consecutiveFailures <= 0) return POLL_INTERVAL_MS;
  return Math.min(POLL_MAX_BACKOFF_MS, POLL_INTERVAL_MS * 2 ** Math.min(input.consecutiveFailures, 4));
}

export type AccountFlowOptions = {
  gatewayOrigin: string;
  /** The profile this build signs in with (`web`, `ios`, `android`). */
  client: AccountClientKind;
  /** The device name the Hosts will show when they ask their user. */
  deviceLabel: () => string;
  /** Stores the adopted device on every Host of the account. */
  adopt: (input: AccountAdoption) => Promise<AccountAdoptionOutcome>;
  /**
   * Called before the account session is revoked, with the device credential the
   * account handed out. Signing out is the last moment the client can tell the
   * Gateway to stop pushing to this device (§11.6), so the caller unregisters
   * here; a failure is the caller's to log and must not block sign-out.
   */
  onSignOut?: (credential: HostCredential) => Promise<void>;
  fetchImpl?: typeof fetch;
  timer?: AccountTimer;
  now?: () => number;
};

/**
 * The flow, driven from the screen. Every method is safe to call in any state:
 * an impossible call is ignored rather than throwing at a tap that arrived
 * twice.
 */
export class AccountFlow {
  private state: AccountFlowState = { kind: "idle" };
  private listeners = new Set<() => void>();
  private pendingTimer: unknown = null;
  /** The account session, in memory only, for the length of the flow. */
  private sessionCredential: HostCredential | null = null;
  private consecutiveFailures = 0;
  /** Set once the flow is done with the account session. */
  private finished = false;
  /**
   * The device credential the account handed out. Kept after the session ends so
   * a later sign-out can unregister push with it (§11.6); it is not a session
   * credential and authorizes nothing else.
   */
  private deviceCredential: HostCredential | null = null;
  /** Whether the post-adoption sign-out already unregistered push. */
  private signedOut = false;
  /** What sign-in learned, so a retry can return to the step it can repeat. */
  private accountId = "";
  private accountHosts: AccountHostSummary[] = [];

  constructor(private readonly options: AccountFlowOptions) {}

  private readonly clientOptions = (): AccountClientOptions => ({
    gatewayOrigin: this.options.gatewayOrigin,
    ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
  });

  private now(): number {
    return (this.options.now ?? (() => Date.now()))();
  }

  private timer(): AccountTimer {
    return this.options.timer ?? systemTimer;
  }

  private credential(): HostCredential | null {
    return this.sessionCredential;
  }

  getState(): AccountFlowState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(next: AccountFlowState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  private stopPolling(): void {
    if (this.pendingTimer === null) return;
    this.timer().clear(this.pendingTimer);
    this.pendingTimer = null;
  }

  /** Sign in with an AccessKey. The key is used once and never kept. */
  async signIn(accessKey: string): Promise<void> {
    if (this.state.kind !== "idle" && this.state.kind !== "sign-in-failed") return;
    // A sign-in opens a session of its own, and that session is the one the
    // next adoption revokes: a flow that was already finished once (signed in,
    // signed out, signed in again) must not skip its own logout.
    this.finished = false;
    this.setState({ kind: "signing-in" });
    const login = await accountLogin({ ...this.clientOptions(), accessKey, client: this.options.client });
    if (!login.ok) {
      this.setState({ kind: "sign-in-failed", failure: login.failure });
      return;
    }
    this.sessionCredential = login.value.credential;
    const listing = await listAccountHosts({ ...this.clientOptions(), credential: login.value.credential });
    if (!listing.ok) {
      // The session was created but is unusable — its account list cannot be
      // read — so it is revoked instead of left behind for the next attempt to
      // overwrite.
      await this.finishSession();
      this.setState({ kind: "sign-in-failed", failure: listing.failure });
      return;
    }
    this.accountId = listing.value.accountId;
    this.accountHosts = listing.value.hosts;
    this.setState({ kind: "signed-in", accountId: listing.value.accountId, hosts: listing.value.hosts });
  }

  /**
   * Ask the account's Hosts to approve a new device, then wait for one to.
   * Repeatable: a request that expired, was lost, or never reached a Host is
   * retried from where it stopped, under the same account session.
   */
  async requestDevice(): Promise<void> {
    if (!this.canRequestDevice()) return;
    const credential = this.credential();
    if (!credential) {
      this.setState({ kind: "idle" });
      return;
    }
    const requested = await requestAccountDevice({
      ...this.clientOptions(),
      credential,
      deviceLabel: this.options.deviceLabel(),
      client: this.options.client,
    });
    if (!requested.ok) {
      if (requested.failure.code === "UNAUTHORIZED") {
        this.sessionRefused(requested.failure);
        return;
      }
      this.setState({ kind: "failed", failure: requested.failure });
      return;
    }
    this.consecutiveFailures = 0;
    this.setState({
      kind: "requesting",
      requestId: requested.value.requestId,
      expiresAt: requested.value.expiresAt,
      hosts: requested.value.hosts,
    });
    this.schedulePoll(POLL_INTERVAL_MS);
  }

  /**
   * Stop waiting for an approval. The Gateway abandons the request when it
   * expires, and the account session is kept: cancelling a request is not
   * signing out, so the client goes back to the step it can repeat.
   */
  cancel(): void {
    this.stopPolling();
    if (this.state.kind !== "requesting") return;
    this.backToSignedIn();
  }

  /**
   * Come back from a failure. A refused device request or a run of failed
   * polls leaves the account session alive, so the client returns to the step
   * it can repeat; a failure that lost the session returns to sign-in, and the
   * session is revoked rather than left behind.
   */
  async retry(): Promise<void> {
    if (this.state.kind !== "failed") return;
    this.consecutiveFailures = 0;
    if (this.canRequestDevice()) {
      this.backToSignedIn();
      return;
    }
    await this.abandon();
  }

  /**
   * Give up on the account session entirely, revoking it server-side and taking
   * the device's push registration with it. Called from the account screen when
   * the user signs out; the adopted device keeps working on the Hosts, but the
   * phone stops being pushed for the account when the user has said so.
   */
  async abandon(): Promise<void> {
    this.stopPolling();
    if (this.state.kind === "adopted" && this.deviceCredential && !this.signedOut) {
      // Post-adoption sign-out: the session is already gone, so only the push
      // registration is left to take away.
      const credential = this.deviceCredential;
      this.signedOut = await this.notifySignOut(credential);
      this.deviceCredential = null;
      this.setState({ kind: "idle" });
      return;
    }
    await this.finishSession();
    this.setState({ kind: "idle" });
  }

  /**
   * Hand the device credential to the caller's unregistration, and report
   * whether it worked. A failure is logged by the caller and never blocks
   * sign-out: forgetting a local token is safer than keeping it.
   */
  private async notifySignOut(credential: HostCredential): Promise<boolean> {
    if (!this.options.onSignOut) return false;
    try {
      await this.options.onSignOut(credential);
      return true;
    } catch (error) {
      console.warn("[remote-web] push unregistration on sign-out failed", error);
      return false;
    }
  }

  /** A device can be asked for whenever the session that authorises it is alive. */
  private canRequestDevice(): boolean {
    const kind = this.state.kind;
    return (kind === "signed-in" || kind === "expired" || kind === "lost" || kind === "failed") && this.credential() !== null;
  }

  /**
   * The Gateway refused the account session itself: it was revoked, or its
   * twelve hours ran out. Nothing this flow can send will be accepted again, so
   * it forgets the session and lets the user sign in once more instead of
   * repeating a request that cannot succeed.
   */
  private sessionRefused(failure: OperationFailure): void {
    this.stopPolling();
    this.sessionCredential = null;
    this.finished = true;
    this.setState({ kind: "failed", failure });
  }

  /** Back to the roster, the step between signing in and asking for a device. */
  private backToSignedIn(): void {
    if (!this.credential()) {
      this.setState({ kind: "idle" });
      return;
    }
    this.setState({ kind: "signed-in", accountId: this.accountId, hosts: this.accountHosts });
  }

  private schedulePoll(delayMs: number): void {
    this.stopPolling();
    this.pendingTimer = this.timer().set(() => {
      this.pendingTimer = null;
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    const state = this.state;
    if (state.kind !== "requesting") return;
    const credential = this.credential();
    if (!credential) {
      this.setState({ kind: "idle" });
      return;
    }
    if (remainingMs(state.expiresAt, this.now()) <= 0) {
      // The client's own deadline ends the wait, whether or not the next read
      // would have been answered.
      this.setState({ kind: "expired", hosts: state.hosts });
      return;
    }
    const status = await fetchAccountDeviceStatus({ ...this.clientOptions(), credential, requestId: state.requestId });
    if (!status.ok) {
      if (status.failure.code === "NOT_FOUND") {
        this.setState({ kind: "gone" });
        return;
      }
      if (status.failure.code === "UNAUTHORIZED") {
        this.sessionRefused(status.failure);
        return;
      }
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= POLL_MAX_FAILURES) {
        this.setState({ kind: "failed", failure: status.failure });
        return;
      }
      this.schedulePoll(pollDelayMs({ failure: status.failure, consecutiveFailures: this.consecutiveFailures }));
      return;
    }
    this.consecutiveFailures = 0;
    const outcome = status.value;
    if (outcome.status === "expired") {
      this.setState({ kind: "expired", hosts: outcome.hosts });
      return;
    }
    if (outcome.status === "granted") {
      if (!outcome.deviceId || (!outcome.token && !outcome.csrfTokens)) {
        // Granted, but the pickup window had already closed: the token exists
        // and nobody can read it any more, so the client asks again.
        this.setState({ kind: "lost", hosts: outcome.hosts });
        return;
      }
      this.setState({
        kind: "granted",
        deviceId: outcome.deviceId,
        expiresAt: outcome.expiresAt,
        hosts: outcome.hosts,
        ...(outcome.signerHostId ? { signerHostId: outcome.signerHostId } : {}),
      });
      await this.adoptDevice(outcome);
      return;
    }
    // Still pending: the roster may have changed (a Host came online, or
    // another one announced its capabilities), so refresh it in place.
    this.setState({ kind: "requesting", requestId: state.requestId, expiresAt: state.expiresAt, hosts: outcome.hosts });
    this.schedulePoll(POLL_INTERVAL_MS);
  }

  /** Store the device on every Host of the account, then drop the session. */
  private async adoptDevice(outcome: {
    deviceId?: string;
    hosts: AccountDeviceHost[];
    token?: string;
    csrfTokens?: Record<string, string>;
  }): Promise<void> {
    let adopted: AccountAdoptionOutcome;
    try {
      adopted = await this.options.adopt({
        deviceId: outcome.deviceId ?? "",
        label: this.options.deviceLabel(),
        hosts: outcome.hosts.map((host) => ({
          hostId: host.hostId,
          label: host.label,
          // An online Host that will not accept a sibling's grant is one that
          // confirms every device with its own user, so only a new request can
          // ever reach it (§11.5).
          requiresOwnConfirmation: host.online && !host.willAcceptGrant,
        })),
        ...(outcome.csrfTokens ? { csrfTokens: outcome.csrfTokens } : {}),
        ...(outcome.token ? { token: outcome.token } : {}),
      });
    } catch (error) {
      // A storage backend that throws (a full `localStorage`, a Keychain the
      // platform refuses) must not become an unhandled rejection in a poll the
      // screen is not awaiting: the device is granted but not kept, and the
      // user has to be told so they can ask again.
      this.setState({ kind: "failed", failure: failureFrom(error) });
      return;
    }
    if (!adopted.ok) {
      this.setState({ kind: "failed", failure: adopted.failure });
      return;
    }
    // Keep the device credential: the post-adoption sign-out below unregisters
    // push with it before the account session is revoked (§11.6), and a later
    // sign-out can retry if that failed.
    this.deviceCredential = outcome.token ? { kind: "header", token: outcome.token } : this.sessionCredential;
    await this.finishSession();
    this.setState({ kind: "adopted", hostIds: adopted.hostIds });
  }

  /**
   * Drop the account session: revoke it on the Gateway and forget the
   * credential. A failure here is reported to the caller's log, never to the
   * user — the device token is already stored, and a session that outlives its
   * purpose expires on its own within twelve hours.
   *
   * Signing out also takes the account device's push registration away, before
   * the session that authorizes the `DELETE` goes: otherwise the phone keeps
   * receiving notifications for an account the user has signed out of.
   */
  private async finishSession(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const credential = this.credential();
    this.sessionCredential = null;
    if (!credential) return;
    // The account device keeps its credential after the session ends: the user
    // may still sign out later (or the app may be reset), and that is the last
    // moment this client can ask the Gateway to stop pushing to it.
    const deviceCredential: HostCredential | null = this.deviceCredential;
    if (deviceCredential) this.signedOut = await this.notifySignOut(deviceCredential);
    await accountLogout({ ...this.clientOptions(), credential });
  }

  /** Release the timer; the screen calls this when it unmounts. */
  dispose(): void {
    this.stopPolling();
    this.listeners.clear();
  }
}

/** Turn any thrown value into the failure shape the screen renders. */
export function failureOf(error: unknown): OperationFailure {
  return failureFrom(error);
}
