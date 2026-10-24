/**
 * Account mode, client half: the missing caller of the account join round
 * (rollout R8 package E).
 *
 * Packages C and D shipped the Gateway routes, `account-join.ts` shipped the
 * reachability rules, and `boot.joinAccountComputers` shipped the registry work
 * — but nothing ever ran them, so the Host link went up, the settings page kept
 * saying "no account computers", and a second computer of the same account
 * never appeared on this one. This module is that caller: once the link is up,
 * ask the Gateway which computers the account has, obtain the device token
 * every sibling accepts, and hand both to the paired-host boot.
 *
 * Three rules shape it:
 *
 * - **The Gateway's answer is the only roster.** Nothing is guessed from the
 *   overlay, the Router, or earlier runs; a computer that is not listed is not
 *   dialled.
 * - **Failure never reaches the Host link.** A refused key, an unreachable
 *   Gateway, or a sibling that will not admit this machine leaves the link and
 *   the already joined computers untouched; the outcome only decides what is
 *   logged.
 * - **Nothing runs on a timer.** The caller runs one round per transition into
 *   `connected`, and the token is reused from the registry so a reconnect does
 *   not ask a sibling to admit this computer again.
 */
import { desktopEnrollmentLabel, resolveAccountAccessKey } from "./account-mode.js";
import {
  listAccountHosts,
  loginAccount,
  requestAccountDevice,
} from "./account-desktop-client.js";
import {
  reachableComputers,
  validateAccountHosts,
  type AccountComputer,
} from "../account-join.js";

/** What account mode needs from the local host: the Router AccessKey. */
type HostCaller = {
  call<T>(method: string, params?: unknown): Promise<T>;
};

/**
 * The registry work, as this module needs it: `boot.joinAccountComputers`.
 * Structural rather than imported from the boot so the Gateway-link domain does
 * not depend on the remote-host bootstrap (one direction of wiring only).
 */
export type AccountJoinPort = (input: {
  computers: readonly AccountComputer[];
  selfHostId: string;
  publicOrigin: string;
  deviceToken: string;
}) => Promise<readonly unknown[]>;

export type AccountComputersOptions = {
  getHost: () => HostCaller | null;
  /**
   * The device token an earlier round obtained for this origin, so a reconnect
   * reuses it instead of asking a sibling to admit this computer again.
   */
  existingDeviceToken: (publicOrigin: string) => Promise<string | undefined>;
  join: AccountJoinPort;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  /** Test seam: fetch, so a test never opens a socket. */
  fetch?: typeof fetch;
  /** Test seam: the clock behind the session-reuse window. */
  now?: () => number;
  /** Test seam: the machine name used as this computer's device label. */
  hostname?: () => string | undefined;
};

/**
 * What one round found. `reason` is a stable code the page shows; `detail` is the
 * Gateway's own error code behind a failure, when it named one — never a secret,
 * and never a guess: the login refusal the user saw for weeks was
 * `INVALID_ARGUMENT` and the page had no way to say it.
 */
export type AccountJoinOutcome =
  | { state: "joined"; computers: number }
  | { state: "skipped"; reason: "in-flight" | "no-access-key" | "self-only" }
  | { state: "failed"; reason: string; detail?: string };

/** What one round is told about the link that just came up. */
export type AccountJoinInput = {
  /** The Gateway's `https://` origin, as the Router advertised it. */
  publicOrigin: string;
  /** This desktop's own Host id, so its own row is never created. */
  hostId: string;
  /** The Host certificate the Gateway bound to this account. */
  certificatePem: string;
  privateKeyPem: string;
};

/** How long a session token is trusted before this round logs in again. */
const SESSION_REUSE_WINDOW_MS = 60_000;

/**
 * One account join round. `run()` is single-flight per account: concurrent calls
 * for the same Gateway and computer share the round already in progress instead
 * of minting a second device request, while a call about a *different* Gateway
 * starts its own round — a reconnect to another origin must not be answered by
 * the round the previous connection was running.
 */
export function createAccountComputers(options: AccountComputersOptions): {
  run(input: AccountJoinInput): Promise<AccountJoinOutcome>;
} {
  const log = options.log;
  const now = options.now ?? (() => Date.now());
  const doFetch = options.fetch;
  /** The Gateway session this module obtained, kept only in memory. */
  let session: { origin: string; token: string; expiresAt: number } | null = null;
  /** Rounds in flight, keyed by what they are about. */
  const running = new Map<string, Promise<AccountJoinOutcome>>();

  /**
   * A session credential for `origin`, or the Gateway's refusal code when it
   * will not issue one. The AccessKey is presented once per window and never
   * stored; the code is what the page needs to say why no computer was found.
   */
  const sessionToken = async (
    origin: string,
    accessKey: string,
  ): Promise<{ token: string } | { error: string }> => {
    if (session && session.origin === origin && session.expiresAt > now() + SESSION_REUSE_WINDOW_MS) {
      return { token: session.token };
    }
    session = null;
    const answer = await loginAccount({
      publicOrigin: origin,
      accessKey,
      label: desktopEnrollmentLabel(options.hostname),
      log,
      ...(doFetch ? { fetch: doFetch } : {}),
    });
    if ("error" in answer) return { error: answer.error };
    const parsed = Date.parse(answer.expiresAt);
    session = {
      origin,
      token: answer.token,
      expiresAt: Number.isNaN(parsed) ? now() + 5 * 60_000 : parsed,
    };
    return { token: answer.token };
  };

  /** The token a sibling admits, reused from the registry when one exists. */
  const deviceToken = async (
    input: AccountJoinInput,
    session: string,
  ): Promise<{ token: string } | { reason: string }> => {
    const existing = await options.existingDeviceToken(input.publicOrigin);
    if (existing) return { token: existing };
    const outcome = await requestAccountDevice(
      {
        publicOrigin: input.publicOrigin,
        deviceLabel: desktopEnrollmentLabel(options.hostname) ?? input.hostId,
        signer: { certificatePem: input.certificatePem, privateKeyPem: input.privateKeyPem },
        hostId: input.hostId,
        log,
        ...(doFetch ? { fetch: doFetch } : {}),
        ...(options.now ? { now: options.now } : {}),
      },
      session,
    );
    if (outcome.state === "granted" && outcome.token) return { token: outcome.token };
    return { reason: outcome.state === "granted" ? "GRANT_WITHOUT_TOKEN" : outcome.reason };
  };

  const round = async (input: AccountJoinInput): Promise<AccountJoinOutcome> => {
    const origin = input.publicOrigin.trim();
    if (!/^https?:\/\//.test(origin)) {
      return { state: "failed", reason: "ACCOUNT_ORIGIN_INVALID" };
    }
    const account = await resolveAccountAccessKey(options.getHost());
    if (!account) {
      // Not an error: a desktop without a Router row simply is not in account
      // mode, and the login form is the way in.
      log("info", "account computers were not joined: no Minih Router AccessKey");
      return { state: "skipped", reason: "no-access-key" };
    }
    const login = await sessionToken(origin, account.accessKey);
    if ("error" in login) {
      log("warn", "account computers were not joined: the account login was refused", { reason: login.error });
      return { state: "failed", reason: "ACCOUNT_LOGIN_REFUSED", detail: login.error };
    }

    const roster = await listAccountHosts({
      publicOrigin: origin,
      sessionToken: login.token,
      log,
      validate: validateAccountHosts,
      ...(doFetch ? { fetch: doFetch } : {}),
    });
    // `null` is "the Gateway could not answer", never an empty account: keeping
    // the previous rows is the honest answer, so nothing is joined or pruned.
    if (roster === null) return { state: "failed", reason: "ACCOUNT_ROSTER_UNAVAILABLE" };

    const reachable = reachableComputers(roster, input.hostId);
    if (reachable.length === 0) {
      // Nothing to dial. The call still runs so a computer that left the account
      // loses its row; no device token is asked for, because no sibling would
      // answer a request in a one-computer account.
      await options.join({
        computers: [],
        selfHostId: input.hostId,
        publicOrigin: origin,
        deviceToken: "",
      });
      log("info", "the account has no other computer to join");
      return { state: "skipped", reason: "self-only" };
    }

    const deviceTokenResult = await deviceToken(input, login.token);
    if ("reason" in deviceTokenResult) {
      log("warn", "account computers were not joined: no device token", { reason: deviceTokenResult.reason });
      return { state: "failed", reason: deviceTokenResult.reason };
    }

    const joined = await options.join({
      computers: reachable,
      selfHostId: input.hostId,
      publicOrigin: origin,
      deviceToken: deviceTokenResult.token,
    });
    log("info", "account computers joined", { computers: String(joined.length) });
    return { state: "joined", computers: joined.length };
  };

  return {
    run(input) {
      const key = `${input.publicOrigin}|${input.hostId}`;
      const inFlight = running.get(key);
      if (inFlight) return inFlight;
      const roundInFlight = round(input)
        .catch((error: unknown): AccountJoinOutcome => {
          log("warn", "the account join round failed", { error: String(error) });
          return { state: "failed", reason: error instanceof Error ? error.message : String(error) };
        })
        .finally(() => {
          if (running.get(key) === roundInFlight) running.delete(key);
        });
      running.set(key, roundInFlight);
      return roundInFlight;
    },
  };
}