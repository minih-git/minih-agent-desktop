/**
 * Account-mode device request / confirm / grant relay (protocol §11.5, D666 /
 * rollout R7 package D; security §3.8, gates 29–33).
 *
 * A logged-in account session asks for a device. The Gateway fans the request
 * out to the account's online Hosts that advertise `device.confirm`, and the
 * first Host whose user approves answers a signed grant. The Gateway verifies
 * that signature against its own CA before it relays anything — it never signs
 * a grant itself (ADR `remote-control-router-account-binding` decision 5 is
 * rejected) and it can neither approve nor invent a token a Host would accept.
 *
 * The approving Host mints the device token with the ordinary §11.4 machinery
 * and keeps only its hash. The raw token travels Host to Gateway once and is
 * handed to the client that asked; it is never written to disk, never logged,
 * and never part of the grant the siblings receive — they adopt the device by
 * `tokenHash` (gate 30). The Gateway records the hash so its pre-routing fast
 * reject knows the device, exactly as it does for a §11.4 device.
 *
 * The Gateway is the only party that knows the account's Hosts and their live
 * capabilities, so it is the only party that can tell the client up front which
 * Host could have answered (gate 33) and which ones still need the grant
 * (offline Hosts receive it when their link comes up, §11.5 "Deferred grants").
 *
 * Everything here is scoped by account and by session: a request belongs to the
 * account session that created it, the in-flight table is bounded per account
 * rather than globally, and no read or relay ever names another account's Host.
 */
import { randomUUID } from "node:crypto";
import { hashToken, verifyHostArtifact } from "@minih-agent/racp";
import {
  RACP_DEVICE_TOKEN_PREFIX,
  RACP_HOST_CAPABILITIES,
  RACP_HOSTLINK_VERSION,
  RacpDeviceRequestHttpRequestSchema,
  RacpDesktopProofHttpRequestSchema,
  deviceGrantSigningPayload,
  deviceRevokeSigningPayload,
  hostAdvertisesCapability,
  hostProofSigningPayload,
  type RacpAccountDeviceHost,
  type RacpDeviceGrantFrame,
  type RacpDeviceHostProof,
  type RacpDeviceRequest,
  type RacpDeviceRevokeFrame,
} from "@minih-agent/shared";
import * as Value from "typebox/value";

import type { AccountOutcome } from "./account.js";
import type { AuditResult } from "./audit.js";
import type { GatewayAuthority } from "./ca.js";
import {
  acceptsSiblingGrants,
  relayGrantFrame,
  relayRevocationFrame,
  relayToSiblings,
  type DeviceRelayPort,
} from "./device-frames.js";
import { COOKIE_MAX_AGE_SECONDS, CSRF_COOKIE, DEVICE_COOKIE, csrfTokenFor, gatewayCookieAttributes } from "./pairing.js";
import { GatewayRpcError, type GatewayLog } from "./router.js";
import type {
  GatewayAccountSessionRecord,
  GatewayPendingGrantRecord,
  GatewayPendingRevocationRecord,
  GatewayStore,
} from "./store.js";

/** How long a client has to confirm a device request before it expires. */
export const DEVICE_REQUEST_TTL_MS = 5 * 60 * 1000;
/** How long the Gateway keeps offering a grant or revocation to an offline Host. */
export const GRANT_DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** In-flight requests one account may hold; more is `RATE_LIMITED`, never an eviction. */
export const MAX_LIVE_REQUESTS_PER_ACCOUNT = 4;
/** In-flight requests the Gateway holds in total; a full table refuses new ones. */
export const MAX_LIVE_REQUESTS = 256;
/**
 * How long a request is kept past its deadline. Without it `expired` could
 * never be observed, because the record would be gone the moment it expired.
 */
const EXPIRED_REQUEST_RETENTION_MS = 60 * 1000;
/**
 * How long the token stays available after its first delivery. It exists so a
 * client whose HTTP response was lost can retry the read; after it the Gateway
 * drops the token and reports `tokenDelivered: false`, and the client starts a
 * new request instead of waiting for a token that no longer exists.
 */
export const TOKEN_PICKUP_WINDOW_MS = 30 * 1000;
/** Desktop nonces the Gateway keeps at once; each outlives one request at most. */
const MAX_NONCES = 4096;

/** The frames this service relays and who may receive them live in `device-frames.ts`. */
export type { DeviceRelayPort } from "./device-frames.js";

export type DeviceRequestServiceOptions = {
  store: GatewayStore;
  hostLinks: DeviceRelayPort;
  authority: () => Promise<GatewayAuthority>;
  log: GatewayLog;
  now?: () => number;
};

/**
 * One in-flight device request. Memory only: a Gateway restart abandons a
 * request that no Host has answered yet, and the client starts a new one. The
 * grant that follows it is durable (`device-grants.json`), because it must
 * still reach a Host that was offline.
 */
type LiveRequest = {
  requestId: string;
  /** The account session that asked; another session gets the same `NOT_FOUND`. */
  sessionId: string;
  accountId: string;
  deviceLabel: string;
  client: "web" | "ios" | "android" | "desktop";
  requestedAt: string;
  expiresAt: string;
  /** The Hosts this request was fanned out to; only they may answer it. */
  hosts: string[];
  /**
   * Desktop-class only: the Gateway's nonce, the computer it was issued to, and
   * the proof the client presented. Kept so a Host's grant can be checked
   * against the same request, and so the Gateway's own pre-check has something
   * to compare (ADR decision 2).
   */
  desktop?: { nonce: string; applicantHostId: string; proof: RacpDeviceHostProof };
  /** The one grant that won; a second approver is ignored. */
  granted?: {
    deviceId: string;
    roles: string[];
    signerHostId: string;
    /** `null` once the pickup window has closed. */
    token: string | null;
    /** When the client first took the token; `null` while it is untaken. */
    takenAt: number | null;
    /** `"desktop"` when the approving Host admitted it with a verified proof. */
    deviceClass?: "phone" | "desktop";
  };
};

export class DeviceRequestService {
  private readonly live = new Map<string, LiveRequest>();
  /**
   * The desktop nonces this Gateway minted, each bound to one request and
   * marked once it is used. Bounded: an entry this old belongs to a request
   * that has already expired or been answered.
   */
  private readonly nonces = new Map<string, { at: number; requestId: string; used: boolean }>();

  constructor(private readonly options: DeviceRequestServiceOptions) {}

  private nowMs(): number {
    return (this.options.now ?? (() => Date.now()))();
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  /**
   * Drop what can no longer be used: a request a minute past its deadline (so
   * `expired` is still observable), and the raw token of a grant whose pickup
   * window has closed. Nothing here ever drops another account's request to
   * make room — a full table refuses new requests instead (gate 29).
   */
  private prune(): void {
    const now = this.nowMs();
    for (const [requestId, request] of [...this.live]) {
      if (Date.parse(request.expiresAt) + EXPIRED_REQUEST_RETENTION_MS <= now) {
        this.live.delete(requestId);
        continue;
      }
      const granted = request.granted;
      if (granted?.token && granted.takenAt !== null && now - granted.takenAt > TOKEN_PICKUP_WINDOW_MS) granted.token = null;
    }
  }

  /** The account's Hosts as the device flow reports them (gate 29, gate 33). */
  private roster(accountId: string): RacpAccountDeviceHost[] {
    return this.options.store.listHostsForAccount(accountId).map((host) => {
      const online = this.options.hostLinks.isOnline(host.hostId);
      const capabilities = this.options.hostLinks.capabilitiesFor(host.hostId);
      return {
        hostId: host.hostId,
        label: host.label,
        online,
        // A Host that never announced the capability cannot be asked; saying so
        // now is what stops the client waiting for an answer that cannot come.
        canConfirm: online && hostAdvertisesCapability(capabilities, RACP_HOST_CAPABILITIES.deviceConfirm),
        willAcceptGrant: online && hostAdvertisesCapability(capabilities, RACP_HOST_CAPABILITIES.deviceAcceptSiblingGrant),
        // A computer that has not announced this one predates amendment 3: it
        // would drop a desktop request silently, so the requesting desktop is
        // told to show "this computer needs an update" instead (decision 6).
        supportsDesktopAuto: online && hostAdvertisesCapability(capabilities, RACP_HOST_CAPABILITIES.deviceDesktopAuto),
      };
    });
  }

  /**
   * `POST /v1/account/devices`: ask the account's Hosts to approve a new device.
   * The answer names every Host of the account with its online state and its
   * capabilities, so the client knows immediately which ones cannot confirm.
   *
   * A `desktop` request does not mint its own nonce here: the client proved
   * itself on `POST /v1/account/desktop-proof` first, so this call carries the
   * `hostProof` that proof produced and is refused without it (ADR decision 2).
   * The Gateway verifies the proof as a **fast reject only** — every target
   * Host verifies the same proof itself, and a Host link frame that claims an
   * admission the Host has not verified is refused (decision 3).
   */
  async request(input: { session: GatewayAccountSessionRecord; body: unknown; ip: string }): Promise<AccountOutcome> {
    this.prune();
    if (!Value.Check(RacpDeviceRequestHttpRequestSchema, input.body)) {
      await this.audit("account.devices", input.ip, "error", input.session.accountId);
      throw new GatewayRpcError("INVALID_ARGUMENT", "the device request is malformed");
    }
    const body = input.body;
    if (body.client === "desktop" && !body.hostProof) {
      // The class alone is never an admission: without proof this would be a
      // bare AccessKey asking for `owner` on every computer.
      await this.audit("account.devices", input.ip, "denied", input.session.accountId);
      throw new GatewayRpcError("INVALID_ARGUMENT", "a desktop device request needs a hostProof");
    }
    const held = [...this.live.values()].filter((request) => request.accountId === input.session.accountId).length;
    if (held >= MAX_LIVE_REQUESTS_PER_ACCOUNT || this.live.size >= MAX_LIVE_REQUESTS) {
      // A refusal, never an eviction: one account must not be able to push
      // another account's request — or a granted token it has not taken yet —
      // out of the table.
      await this.audit("account.devices", input.ip, "denied", input.session.accountId);
      throw new GatewayRpcError(
        "RATE_LIMITED",
        held >= MAX_LIVE_REQUESTS_PER_ACCOUNT
          ? `this account already has ${held} device requests waiting`
          : "the Gateway is holding as many device requests as it can",
        true,
      );
    }
    const desktopProof = body.hostProof;
    if (desktopProof) {
      // The nonce is what makes the proof belong to one request: it was minted
      // by `desktopProof()` below, is single-use, and expires with the request.
      const live = body.requestId ? this.live.get(body.requestId) : undefined;
      if (!live || live.accountId !== input.session.accountId || live.sessionId !== input.session.sessionId) {
        await this.audit("account.devices", input.ip, "denied", input.session.accountId);
        throw new GatewayRpcError("INVALID_ARGUMENT", "this proof belongs to no device request of yours");
      }
      if (live.desktop) {
        // One proof per request: a second presentation is a replay.
        await this.audit("account.devices", input.ip, "denied", input.session.accountId);
        throw new GatewayRpcError("INVALID_ARGUMENT", "this nonce was already used");
      }
      if (Date.parse(live.expiresAt) <= this.nowMs()) {
        await this.audit("account.devices", input.ip, "denied", input.session.accountId);
        throw new GatewayRpcError("INVALID_ARGUMENT", "this device request has expired");
      }
      const refused = await this.preCheckProof({
        request: live,
        proof: desktopProof,
        accountId: input.session.accountId,
        ip: input.ip,
      });
      if (refused) throw refused;
      live.desktop = { nonce: desktopProof.nonce, applicantHostId: desktopProof.applicantHostId, proof: desktopProof };
      await this.fanOut(live, input.ip);
      return { status: 200, cookies: [], payload: { result: { requestId: live.requestId, expiresAt: live.expiresAt, hosts: this.roster(live.accountId) } } };
    }
    const requestId = `dreq_${randomUUID()}`;
    const requestedAt = this.nowIso();
    const expiresAt = new Date(this.nowMs() + DEVICE_REQUEST_TTL_MS).toISOString();
    const request: RacpDeviceRequest = {
      requestId,
      accountId: input.session.accountId,
      deviceLabel: body.deviceLabel,
      client: body.client,
      requestedAt,
      expiresAt,
    };
    const live: LiveRequest = {
      requestId,
      sessionId: input.session.sessionId,
      accountId: input.session.accountId,
      deviceLabel: body.deviceLabel,
      client: body.client,
      requestedAt,
      expiresAt,
      hosts: [],
    };
    this.live.set(requestId, live);
    const asked = this.fanOut(live, input.ip);
    await this.audit("account.devices", input.ip, "ok", input.session.accountId);
    this.options.log("info", "gateway fanned out a device request", { requestId, hosts: asked.length });
    return { status: 200, cookies: [], payload: { result: { requestId, expiresAt, hosts: this.roster(input.session.accountId) } } };
  }

  /**
   * Send one live request to the Hosts that can answer it, and record which
   * ones. A phone request goes to every Host that can confirm; a desktop
   * request goes only to a Host that advertises `device.desktop-auto`, because
   * a computer that predates amendment 3 drops the frame silently and would
   * leave the client waiting forever (protocol §11.4 rule 7, decision 6).
   */
  private fanOut(live: LiveRequest, ip: string): string[] {
    const desktop = live.client === "desktop";
    const request: RacpDeviceRequest = {
      requestId: live.requestId,
      accountId: live.accountId,
      deviceLabel: live.deviceLabel,
      client: live.client,
      requestedAt: live.requestedAt,
      expiresAt: live.expiresAt,
      ...(live.desktop ? { hostProof: live.desktop.proof } : {}),
    };
    const asked: string[] = [];
    for (const host of this.roster(live.accountId)) {
      const reachable = desktop ? host.supportsDesktopAuto : host.canConfirm;
      if (!reachable) continue;
      if (this.options.hostLinks.sendToHost(host.hostId, { link: RACP_HOSTLINK_VERSION, type: "device.request", request })) {
        asked.push(host.hostId);
      }
    }
    live.hosts = asked;
    if (desktop && asked.length === 0) {
      // Not an error: the client is told through the roster that no computer of
      // the account can be asked, and shows "needs an update" instead of
      // waiting. Logged because it is the visible symptom of a fleet that has
      // not been upgraded.
      this.options.log("warn", "no Host of the account can admit a desktop device", { requestId: live.requestId, ip });
    }
    return asked;
  }

  /**
   * `POST /v1/account/desktop-proof`: mint the values a desktop signs.
   *
   * The Gateway owns the nonce because only it can bound one to a single
   * request with a single deadline. This call creates the pending request; the
   * `POST /v1/account/devices` that follows presents the signed proof and is
   * what fans the request out. Nothing is authorized here: the applicant is
   * only checked for being a registered, unrevoked Host of the caller's own
   * account, which is a fast reject (ADR decision 2).
   */
  async desktopProof(input: { session: GatewayAccountSessionRecord; body: unknown; ip: string }): Promise<AccountOutcome> {
    this.prune();
    if (!Value.Check(RacpDesktopProofHttpRequestSchema, input.body)) {
      await this.audit("account.devices.desktop", input.ip, "error", input.session.accountId);
      throw new GatewayRpcError("INVALID_ARGUMENT", "the desktop proof request is malformed");
    }
    const body = input.body;
    const applicant = this.options.store.findHost(body.applicantHostId);
    if (!applicant || applicant.revokedAt || applicant.accountId !== input.session.accountId) {
      // Same answer for unknown, revoked, and foreign: the caller learns nothing
      // about another account's computers (gate 29).
      await this.audit("account.devices.desktop", input.ip, "denied", input.session.accountId);
      throw new GatewayRpcError("FORBIDDEN", "this computer is not a Host of your account");
    }
    const held = [...this.live.values()].filter((request) => request.accountId === input.session.accountId).length;
    if (held >= MAX_LIVE_REQUESTS_PER_ACCOUNT || this.live.size >= MAX_LIVE_REQUESTS) {
      await this.audit("account.devices.desktop", input.ip, "denied", input.session.accountId);
      throw new GatewayRpcError("RATE_LIMITED", "the Gateway is holding as many device requests as it can", true);
    }
    const requestId = `dreq_${randomUUID()}`;
    const requestedAt = this.nowIso();
    const expiresAt = new Date(this.nowMs() + DEVICE_REQUEST_TTL_MS).toISOString();
    const nonce = this.mintNonce(requestId);
    const live: LiveRequest = {
      requestId,
      sessionId: input.session.sessionId,
      accountId: input.session.accountId,
      deviceLabel: body.deviceLabel,
      client: "desktop",
      requestedAt,
      expiresAt,
      hosts: [],
    };
    this.live.set(requestId, live);
    await this.audit("account.devices.desktop", input.ip, "ok", input.session.accountId);
    return {
      status: 200,
      cookies: [],
      payload: {
        result: {
          requestId,
          nonce,
          applicantHostId: body.applicantHostId,
          accountId: input.session.accountId,
          expiresAt,
          hosts: this.roster(input.session.accountId),
        },
      },
    };
  }

  /**
   * Mint one nonce and remember it against the request it belongs to, so the
   * proof that comes back is bound to that request and can be used once. Bounded
   * by `MAX_NONCES`: an entry that old belongs to a request already expired or
   * answered.
   */
  private mintNonce(requestId: string): string {
    const nonce = `dn_${randomUUID()}`;
    this.nonces.set(nonce, { at: this.nowMs(), requestId, used: false });
    if (this.nonces.size > MAX_NONCES) {
      const idle = [...this.nonces].sort((left, right) => left[1].at - right[1].at);
      for (const [key] of idle.slice(0, this.nonces.size - MAX_NONCES)) this.nonces.delete(key);
    }
    return nonce;
  }

  /**
   * The Gateway's **fast reject** for a desktop proof (ADR decision 2): the
   * nonce is one it minted for this very request, the signature chains to its
   * own CA with this account's binding, and the signing computer is the
   * applicant it names. None of this authorizes anything — the target Host
   * verifies the same proof itself (decision 3) — so a compromised Gateway
   * still cannot mint an `owner` device on its own.
   */
  private async preCheckProof(input: {
    request: LiveRequest;
    proof: { nonce: string; applicantHostId: string; signature: string };
    accountId: string;
    ip: string;
  }): Promise<GatewayRpcError | null> {
    const denied = async (reason: string): Promise<GatewayRpcError> => {
      this.options.log("warn", "gateway refused a desktop proof", { requestId: input.request.requestId, reason });
      await this.audit("account.devices.desktop", input.ip, "denied", input.accountId);
      return new GatewayRpcError("FORBIDDEN", "the desktop proof was not accepted");
    };
    const issued = this.nonces.get(input.proof.nonce);
    if (!issued || issued.requestId !== input.request.requestId) return denied("unknown_nonce");
    if (issued.used) return denied("replayed_nonce");
    const applicant = this.options.store.findHost(input.proof.applicantHostId);
    if (!applicant || applicant.revokedAt || applicant.accountId !== input.accountId) return denied("unknown_applicant");
    const authority = await this.options.authority();
    const verdict = verifyHostArtifact({
      payload: hostProofSigningPayload({
        requestId: input.request.requestId,
        nonce: input.proof.nonce,
        applicantHostId: input.proof.applicantHostId,
        accountId: input.accountId,
        expiresAt: input.request.expiresAt,
      }),
      signature: input.proof.signature,
      signerCertificate: applicant.certificatePem,
      gatewayCaPem: authority.ca.certificatePem,
      now: this.nowMs(),
    });
    if (!verdict.ok || verdict.signerHostId !== input.proof.applicantHostId || verdict.accountId !== input.accountId) {
      return denied(verdict.ok ? "signer_mismatch" : verdict.reason);
    }
    this.nonces.get(input.proof.nonce)!.used = true;
    return null;
  }

  /**
   * Tell the account's other computers that a Host joined (ADR amendment 3,
   * Accepted risk). Stored first, so a computer that is offline receives it
   * when its link comes up — the same window and re-offer rule as a device
   * revocation. Only a Host that advertises `device.desktop-auto` is told: a
   * computer that predates the frame drops it silently anyway.
   */
  async announceHostJoined(input: { hostId: string; label: string; accountId: string; ip?: string }): Promise<string[]> {
    const noticeId = `joined_${input.hostId}`;
    const joinedAt = this.nowIso();
    await this.options.store.saveHostJoined({
      noticeId,
      accountId: input.accountId,
      hostId: input.hostId,
      label: input.label,
      joinedAt,
      relayUntil: new Date(this.nowMs() + GRANT_DELIVERY_WINDOW_MS).toISOString(),
    });
    const relayed = this.relayHostJoined(input.accountId, input.hostId);
    await this.audit("account.host.joined", input.ip ?? "hostlink", "ok", input.accountId, { hostId: input.hostId });
    this.options.log("info", "gateway announced a new account computer", { hostId: input.hostId, relayed: relayed.length });
    return relayed;
  }

  /** Send the account's host-joined notices to one Host that can receive them. */
  private relayHostJoined(accountId: string, joinedHostId: string): string[] {
    const relayed: string[] = [];
    for (const sibling of this.options.store.listHostsForAccount(accountId)) {
      if (sibling.hostId === joinedHostId) continue;
      if (!hostAdvertisesCapability(this.options.hostLinks.capabilitiesFor(sibling.hostId), RACP_HOST_CAPABILITIES.deviceDesktopAuto)) continue;
      for (const notice of this.options.store.listHostJoined(accountId)) {
        if (notice.hostId === sibling.hostId) continue;
        const frame = {
          link: RACP_HOSTLINK_VERSION as typeof RACP_HOSTLINK_VERSION,
          type: "host.joined" as const,
          notice: {
            noticeId: notice.noticeId,
            accountId: notice.accountId,
            hostId: notice.hostId,
            label: notice.label,
            joinedAt: notice.joinedAt,
          },
        };
        if (this.options.hostLinks.sendToHost(sibling.hostId, frame)) relayed.push(sibling.hostId);
      }
    }
    return relayed;
  }

  /**
   * `GET /v1/account/devices/{requestId}`: the outcome, the token once a Host
   * approved, and the live roster. A foreign account, an unknown id, and another
   * session of the same account all answer the same `NOT_FOUND`: the request id
   * travels to every Host and through this Gateway's logs, so it is not a
   * credential and it is not treated as one.
   */
  async status(input: { session: GatewayAccountSessionRecord; requestId: string; ip: string }): Promise<AccountOutcome> {
    this.prune();
    const request = this.live.get(input.requestId);
    if (!request || request.accountId !== input.session.accountId || request.sessionId !== input.session.sessionId) {
      await this.audit("account.devices.status", input.ip, "denied", input.session.accountId);
      throw new GatewayRpcError("NOT_FOUND", "no such device request");
    }
    const now = this.nowMs();
    const expired = Date.parse(request.expiresAt) <= now;
    const status = request.granted ? "granted" : expired ? "expired" : "pending";
    let token: string | undefined;
    const granted = request.granted;
    if (granted?.token) {
      if (granted.takenAt === null || now - granted.takenAt <= TOKEN_PICKUP_WINDOW_MS) {
        token = granted.token;
        granted.takenAt ??= now;
      } else {
        // Past the pickup window the token is gone; the client must ask again.
        granted.token = null;
      }
    }
    // A browser cannot keep a device token in JavaScript and still meet gate 24,
    // so the token is handed over the way the pairing route hands it over: an
    // `HttpOnly` cookie per Host of the account, plus the CSRF value the client
    // repeats on every mutation to that Host. A native client reads `token`
    // from the body instead and stores it in its platform secure store.
    const browser = input.session.client === "web";
    const handover = token && granted && browser ? this.browserHandover(request.accountId, granted.deviceId, token) : null;
    await this.audit("account.devices.status", input.ip, "ok", input.session.accountId);
    return {
      status: 200,
      cookies: handover?.cookies ?? [],
      payload: {
        result: {
          requestId: request.requestId,
          status,
          expiresAt: request.expiresAt,
          hosts: this.roster(request.accountId),
          ...(granted
            ? {
                deviceId: granted.deviceId,
                roles: granted.roles,
                signerHostId: granted.signerHostId,
                ...(token && !browser ? { token } : {}),
                // True for a browser too: the token did leave the Gateway, as
                // the cookies above.
                tokenDelivered: Boolean(token),
                ...(handover ? { csrfTokens: handover.csrfTokens } : {}),
              }
            : {}),
        },
      },
    };
  }

  /**
   * One `HttpOnly` device cookie and one readable CSRF cookie per Host of the
   * account, exactly as the pairing route sets them for one Host, so every
   * existing host-scoped call works unchanged. `csrfTokens` carries the same
   * CSRF values in the body, because a cookie scoped to `Path=/hosts/{hostId}`
   * is not visible to `document.cookie` on the app's own path.
   */
  private browserHandover(accountId: string, deviceId: string, token: string): { cookies: string[]; csrfTokens: Record<string, string> } {
    const csrfToken = csrfTokenFor(this.options.store.secret, deviceId);
    const cookies: string[] = [];
    const csrfTokens: Record<string, string> = {};
    for (const host of this.options.store.listHostsForAccount(accountId)) {
      const attributes = gatewayCookieAttributes({ path: `/hosts/${host.hostId}`, maxAgeSeconds: COOKIE_MAX_AGE_SECONDS });
      cookies.push(
        `${DEVICE_COOKIE}=${token}; ${attributes}; HttpOnly`,
        `${CSRF_COOKIE}=${csrfToken}; ${attributes}`,
      );
      csrfTokens[host.hostId] = csrfToken;
    }
    return { cookies, csrfTokens };
  }

  /**
   * Handle a `device.grant` a Host sent after its user approved. The Gateway
   * verifies the signature against its own CA and the account binding of the
   * signer before it trusts anything, records the device for its fast reject,
   * keeps the grant for the account's offline Hosts, and relays it to the ones
   * that are up. Nothing here can produce a token a Host would accept: the
   * grant is signed by a Host certificate, and the Gateway holds no such key.
   */
  async handleGrant(frame: RacpDeviceGrantFrame, signerHostId: string): Promise<void> {
    const { grant } = frame;
    const request = this.live.get(grant.requestId);
    if (!request || request.accountId !== grant.accountId || !request.hosts.includes(signerHostId)) {
      this.options.log("warn", "gateway refused a device grant for an unknown request", { grantId: grant.grantId });
      return;
    }
    if (request.granted) {
      // The first approval wins; a second Host minted its own token, which this
      // account will never use.
      this.options.log("info", "gateway ignored a second device grant", { requestId: request.requestId });
      return;
    }
    if (Date.parse(request.expiresAt) <= this.nowMs()) {
      // The client has stopped waiting; minting the device now would leave it
      // orphaned on the Host that approved.
      this.options.log("warn", "gateway refused a device grant for an expired request", { requestId: request.requestId });
      return;
    }
    const host = this.options.store.findHost(signerHostId);
    if (!host || host.revokedAt || host.accountId !== grant.accountId || grant.signerHostId !== signerHostId) {
      this.options.log("warn", "gateway refused a device grant from a Host of another account", { grantId: grant.grantId });
      return;
    }
    const authority = await this.options.authority();
    const verdict = verifyHostArtifact({
      payload: deviceGrantSigningPayload(grant),
      signature: frame.signature,
      signerCertificate: frame.signerCertificate,
      gatewayCaPem: authority.ca.certificatePem,
      now: this.nowMs(),
    });
    if (!verdict.ok || verdict.signerHostId !== signerHostId || verdict.accountId !== grant.accountId) {
      this.options.log("warn", "gateway refused a device grant with an invalid signature", {
        grantId: grant.grantId,
        reason: verdict.ok ? "signer_mismatch" : verdict.reason,
      });
      return;
    }
    if (Date.parse(grant.deliverUntil) <= this.nowMs()) {
      this.options.log("warn", "gateway refused an expired device grant", { grantId: grant.grantId });
      return;
    }
    const token = frame.deviceToken;
    // The token must be the one the signed hash names; anything else would let
    // a Host hand the client a credential no sibling would ever accept.
    if (!token || !token.startsWith(RACP_DEVICE_TOKEN_PREFIX) || hashToken(token) !== grant.tokenHash) {
      this.options.log("warn", "gateway refused a device grant whose token does not match its hash", { grantId: grant.grantId });
      return;
    }
    const existing = this.options.store.findDevice(grant.deviceId);
    if (existing && (existing.accountId !== grant.accountId || existing.tokenHash !== grant.tokenHash)) {
      // Never let one account take over a device id another account recorded.
      this.options.log("warn", "gateway refused a device grant that collides with another device", { deviceId: grant.deviceId });
      return;
    }

    request.granted = { deviceId: grant.deviceId, roles: [...grant.roles], signerHostId, token, takenAt: null };
    // The Gateway learns the device exactly as §11.4 does: the hash only, and
    // scoped to the account, because the token works on every Host of it.
    await this.options.store.saveDevice({
      deviceId: grant.deviceId,
      hostId: signerHostId,
      label: grant.deviceLabel,
      tokenHash: grant.tokenHash,
      createdAt: this.nowIso(),
      accountId: grant.accountId,
    });
    const pending: GatewayPendingGrantRecord = {
      grantId: grant.grantId,
      requestId: grant.requestId,
      accountId: grant.accountId,
      signerHostId,
      deviceId: grant.deviceId,
      deviceLabel: grant.deviceLabel,
      tokenHash: grant.tokenHash,
      roles: [...grant.roles],
      issuedAt: grant.issuedAt,
      // Signed by the approving Host, and relayed exactly as signed.
      deliverUntil: grant.deliverUntil,
      // The Gateway's own retention, which is not part of any signature.
      relayUntil: new Date(Math.min(Date.parse(grant.deliverUntil), this.nowMs() + GRANT_DELIVERY_WINDOW_MS)).toISOString(),
      signature: frame.signature,
      signerCertificate: frame.signerCertificate,
      // Desktop-class grants carry the proof inside the approving Host's
      // signature; a sibling re-verifies it, so the Gateway relays it as signed
      // and never reconstructs it.
      ...(grant.deviceClass ? { deviceClass: grant.deviceClass } : {}),
      ...(grant.applicantHostId ? { applicantHostId: grant.applicantHostId } : {}),
      ...(grant.hostProofNonce ? { hostProofNonce: grant.hostProofNonce } : {}),
      ...(grant.requestExpiresAt ? { requestExpiresAt: grant.requestExpiresAt } : {}),
      ...(grant.applicantCertificate ? { applicantCertificate: grant.applicantCertificate } : {}),
      ...(grant.hostProofSignature ? { hostProofSignature: grant.hostProofSignature } : {}),
    };
    await this.options.store.savePendingGrant(pending);
    const relayed = relayToSiblings({
      store: this.options.store,
      hostLinks: this.options.hostLinks,
      accountId: pending.accountId,
      signerHostId: pending.signerHostId,
      frame: relayGrantFrame(pending),
      audience: "accepts",
    });
    await this.audit("account.devices.grant", "hostlink", "ok", grant.accountId, {
      deviceId: grant.deviceId,
      hostId: signerHostId,
    });
    this.options.log("info", "gateway relayed a device grant", { deviceId: grant.deviceId, relayed: relayed.length });
  }

  /**
   * Relay a signed revocation to the account's other Hosts, and revoke the
   * Gateway's own record so its fast reject stops accepting the token at once.
   * A Host never waits for this: it revoked locally before it sent the frame.
   */
  async handleRevoke(frame: RacpDeviceRevokeFrame, signerHostId: string): Promise<void> {
    const { revoke } = frame;
    const host = this.options.store.findHost(signerHostId);
    if (!host || host.revokedAt || host.accountId !== revoke.accountId || revoke.signerHostId !== signerHostId) {
      this.options.log("warn", "gateway refused a device revocation from a Host of another account");
      return;
    }
    const authority = await this.options.authority();
    const verdict = verifyHostArtifact({
      payload: deviceRevokeSigningPayload(revoke),
      signature: frame.signature,
      signerCertificate: frame.signerCertificate,
      gatewayCaPem: authority.ca.certificatePem,
      now: this.nowMs(),
    });
    if (!verdict.ok || verdict.signerHostId !== signerHostId || verdict.accountId !== revoke.accountId) {
      this.options.log("warn", "gateway refused a device revocation with an invalid signature", {
        deviceId: revoke.deviceId,
        reason: verdict.ok ? "signer_mismatch" : verdict.reason,
      });
      return;
    }
    const known = this.options.store.findDevice(revoke.deviceId);
    if (known && known.accountId === revoke.accountId) {
      await this.options.store.revokeDevice(revoke.deviceId, revoke.revokedAt);
    }
    // Drop the pending grant BEFORE relaying: a Host that reconnects during the
    // relay must not be able to adopt a device this account just revoked.
    for (const pending of this.options.store.listPendingGrants(revoke.accountId)) {
      if (pending.deviceId === revoke.deviceId) await this.options.store.deletePendingGrant(pending.grantId);
    }
    const record: GatewayPendingRevocationRecord = {
      revokeId: revoke.revokeId,
      accountId: revoke.accountId,
      signerHostId,
      deviceId: revoke.deviceId,
      revokedAt: revoke.revokedAt,
      relayUntil: new Date(this.nowMs() + GRANT_DELIVERY_WINDOW_MS).toISOString(),
      signature: frame.signature,
      signerCertificate: frame.signerCertificate,
    };
    // Kept for the Hosts that are down now, and re-offered when they come back.
    await this.options.store.savePendingRevocation(record);
    const relayed = relayToSiblings({
      store: this.options.store,
      hostLinks: this.options.hostLinks,
      accountId: record.accountId,
      signerHostId: record.signerHostId,
      frame: relayRevocationFrame(record),
      // Every Host with a device directory, not only the ones that take grants:
      // a sibling may hold this device from before it became strict.
      audience: "any",
    });
    await this.audit("account.devices.revoke", "hostlink", "ok", revoke.accountId, { deviceId: revoke.deviceId });
    this.options.log("info", "gateway relayed a device revocation", { deviceId: revoke.deviceId, relayed: relayed.length });
  }

  /**
   * A Host announced its capabilities on a new link: offer it every grant and
   * revocation of its account that it has not taken yet. Capabilities arrive
   * before this call, so a Host that does not accept sibling grants is not
   * offered one it would refuse, and a Host that cannot confirm is not offered
   * a revocation either. Re-delivery is idempotent.
   */
  async deliverPending(hostId: string): Promise<void> {
    const host = this.options.store.findHost(hostId);
    if (!host?.accountId || host.revokedAt) return;
    if (!this.options.hostLinks.hasAnnouncedCapabilities(hostId)) return;
    let delivered = 0;
    // A grant only reaches a Host that would take it; a revocation reaches every
    // Host that has a device directory (see `device-frames.ts`).
    if (acceptsSiblingGrants(this.options.hostLinks, hostId)) {
      for (const pending of this.options.store.listPendingGrants(host.accountId)) {
        if (pending.signerHostId === hostId) continue;
        if (this.options.hostLinks.sendToHost(hostId, relayGrantFrame(pending))) delivered += 1;
      }
    }
    for (const revocation of this.options.store.listPendingRevocations(host.accountId)) {
      if (revocation.signerHostId === hostId) continue;
      if (this.options.hostLinks.sendToHost(hostId, relayRevocationFrame(revocation))) delivered += 1;
    }
    // A computer that was offline when another joined still shows the notice
    // when its link comes up, for the same reason a missed revocation is
    // re-offered (ADR amendment 3, Accepted risk).
    for (const notice of this.options.store.listHostJoined(host.accountId)) {
      if (notice.hostId === hostId) continue;
      const frame = {
        link: RACP_HOSTLINK_VERSION as typeof RACP_HOSTLINK_VERSION,
        type: "host.joined" as const,
        notice: {
          noticeId: notice.noticeId,
          accountId: notice.accountId,
          hostId: notice.hostId,
          label: notice.label,
          joinedAt: notice.joinedAt,
        },
      };
      if (hostAdvertisesCapability(this.options.hostLinks.capabilitiesFor(hostId), RACP_HOST_CAPABILITIES.deviceDesktopAuto)) {
        if (this.options.hostLinks.sendToHost(hostId, frame)) delivered += 1;
      }
    }
    // A computer that was offline when another was revoked still applies it, for
    // the same reason a missed device revocation is re-offered.
    for (const notice of this.options.store.listHostRevoked(host.accountId)) {
      const frame = {
        link: RACP_HOSTLINK_VERSION as typeof RACP_HOSTLINK_VERSION,
        type: "host.revoked" as const,
        revocation: { hostId: notice.hostId, accountId: notice.accountId, revokedAt: notice.revokedAt },
      };
      if (hostAdvertisesCapability(this.options.hostLinks.capabilitiesFor(hostId), RACP_HOST_CAPABILITIES.deviceDesktopAuto)) {
        if (this.options.hostLinks.sendToHost(hostId, frame)) delivered += 1;
      }
    }
  }

  /**
   * Tell the account's computers that one of them was revoked on the Gateway
   * (ADR amendment 3, decision 4). Each of them revokes the desktop devices that
   * computer's proof admitted, so `owner` really does follow the certificate.
   *
   * Stored first and re-offered on reconnect, exactly like `host.joined`: a
   * computer that was asleep when the revocation happened still applies it. Only
   * a Host that advertises `device.desktop-auto` is told, because only such a
   * Host can hold a desktop-class device at all.
   */
  async announceHostRevoked(input: { hostId: string; revokedAt: string }): Promise<string[]> {
    const host = this.options.store.findHost(input.hostId);
    if (!host?.accountId) return [];
    await this.options.store.saveHostRevoked({
      noticeId: `revoked_${input.hostId}`,
      accountId: host.accountId,
      hostId: input.hostId,
      revokedAt: input.revokedAt,
      relayUntil: new Date(this.nowMs() + GRANT_DELIVERY_WINDOW_MS).toISOString(),
    });
    const relayed = this.relayHostRevoked(host.accountId, input.hostId);
    await this.audit("account.host.revoked", "admin", "ok", host.accountId, { hostId: input.hostId });
    this.options.log("info", "gateway announced a revoked account computer", { hostId: input.hostId, relayed: relayed.length });
    return relayed;
  }

  /** Send the account's host-revoked notices to the Hosts that can act on them. */
  private relayHostRevoked(accountId: string, exceptHostId?: string): string[] {
    const relayed: string[] = [];
    for (const sibling of this.options.store.listHostsForAccount(accountId)) {
      if (sibling.hostId === exceptHostId) continue;
      if (!hostAdvertisesCapability(this.options.hostLinks.capabilitiesFor(sibling.hostId), RACP_HOST_CAPABILITIES.deviceDesktopAuto)) continue;
      for (const notice of this.options.store.listHostRevoked(accountId)) {
        const frame = {
          link: RACP_HOSTLINK_VERSION as typeof RACP_HOSTLINK_VERSION,
          type: "host.revoked" as const,
          revocation: { hostId: notice.hostId, accountId: notice.accountId, revokedAt: notice.revokedAt },
        };
        if (this.options.hostLinks.sendToHost(sibling.hostId, frame)) relayed.push(sibling.hostId);
      }
    }
    return relayed;
  }

  private async audit(
    op: string,
    ip: string,
    result: AuditResult,
    accountId: string,
    extra: { deviceId?: string; hostId?: string } = {},
  ): Promise<void> {
    // The audit record type is closed on purpose: a token, a credential, and
    // free-form user text never reach it (gate 30).
    await this.options.store.appendAudit({ op, ip, result, accountId, ...extra });
  }
}
