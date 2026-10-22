/**
 * The Gateway's redacted push service (protocol §11.6, R5 PR-6, ADR 0331
 * decision 7).
 *
 * What it does: takes one `host.notify` a Host reported, resolves which devices
 * may be pushed about that Host, and delivers a payload of a fixed kind, two
 * localization keys, and ids to the provider. What it never does: read a
 * transcript, name a tool, copy a prompt, or look at a Host or account it was
 * not asked about.
 *
 * The gates this module enforces, each with a test:
 *
 * - **Audience (§11.5, gate 29).** A device is pushed about a Host only when it
 *   may open that Host: its own Host for a §11.4 device, a live Host of its own
 *   account for an account-mode device. A revoked device is filtered out here
 *   *and* loses its registration, so a revoked device cannot be revived by a
 *   request that was already in flight when the revocation landed.
 * - **Dedupe.** One `notifyId` produces at most one push, whatever the Host
 *   retries: a Host that reconnects re-sends nothing, and a duplicate frame is
 *   dropped here rather than delivered twice.
 * - **Budget.** A per-device token bucket and a per-Host one bound a Host that
 *   reports far more often than a person can act, so one noisy Host cannot turn
 *   into a notification storm on someone's phone.
 * - **Bounded delivery.** Devices are delivered to with a small fixed
 *   concurrency, and one provider timeout or failure never stops the rest or the
 *   audit record.
 * - **Cleanup.** Only a provider answer that means "this token is gone" deletes
 *   a registration; a revocation deletes it as well.
 */
import type { RacpHostNotify, RacpNotifyKind, RacpPushPayload } from "@minih-agent/shared";
import { RACP_HOST_CAPABILITIES, pushKeysForKind } from "@minih-agent/shared";

import type { GatewayLog } from "./router.js";
import type { RateLimitPolicy } from "./rate-limit.js";
import type { GatewayPushRegistrationRecord, GatewayStore } from "./store.js";
import { ApnsClient, FcmClient, type PushDeliveryResult } from "./push-providers.js";
import type { PushConfig } from "./push-config.js";

/** Per-device notification budget: ten in a burst, then one every ten seconds. */
export const DEFAULT_PUSH_DEVICE_LIMIT: RateLimitPolicy = { capacity: 10, refillPerSecond: 0.1 };
/**
 * Per-Host budget, tighter than the per-device one on purpose: a Host that is
 * looping must not be able to notify every device of its account in a burst.
 */
export const DEFAULT_PUSH_HOST_LIMIT: RateLimitPolicy = { capacity: 20, refillPerSecond: 0.2 };
/** How many notify ids are remembered for dedupe; older ids are forgotten. */
const DEDUPE_WINDOW = 4096;
/**
 * How many devices one notification is delivered to at once. Enough that a
 * handful of phones hear about an approval together, small enough that a
 * thousand registrations cannot occupy the Gateway's sockets at once.
 */
export const PUSH_DELIVERY_CONCURRENCY = 4;

type Bucket = { tokens: number; updatedAt: number };

/** One provider client, as the service uses it. */
export type PushProvider = {
  send(token: string, payload: RacpPushPayload): Promise<PushDeliveryResult>;
  /** Release pooled connections; absent for injected test providers. */
  close?: () => void;
};

export type PushHostSource = {
  capabilitiesFor(hostId: string): readonly string[];
  isOnline(hostId: string): boolean;
};

export type PushServiceOptions = {
  store: GatewayStore;
  config: PushConfig | null;
  hostLinks: PushHostSource;
  log: GatewayLog;
  now?: () => number;
  /** Injected in tests so no request leaves the machine. */
  apns?: PushProvider;
  fcm?: PushProvider;
  deviceLimit?: RateLimitPolicy;
  hostLimit?: RateLimitPolicy;
};

export type PushNotificationOutcome =
  /** Push is off: the operator configured no provider. */
  | { status: "disabled" }
  /** The Host may not send this notification (capability, audience, or budget). */
  | { status: "ignored"; reason: "capability" | "audience" | "duplicate" | "rate-limited" }
  /** Delivered (or accepted by the provider) to this many registrations. */
  | { status: "sent"; delivered: number };

/**
 * The two kinds that require the user (§17.6.5). A registration that asked for
 * "only things that need me" still receives these, and no others.
 */
export const PUSH_ACTIONABLE_KINDS: readonly RacpNotifyKind[] = ["approval.requested", "input.requested"];

/**
 * The one payload a push may carry. Built here, from ids only, so every caller
 * gets the same fields and nothing else (§11.6, security gate 34).
 */
export function buildPushPayload(input: { notify: RacpHostNotify; hostId: string }): RacpPushPayload {
  const keys = pushKeysForKind(input.notify.kind);
  return {
    kind: input.notify.kind,
    titleKey: keys.titleKey,
    bodyKey: keys.bodyKey,
    hostId: input.hostId,
    sessionId: input.notify.sessionId,
    ...(input.notify.approvalId ? { approvalId: input.notify.approvalId } : {}),
    ...(input.notify.attentionCount === undefined ? {} : { attentionCount: input.notify.attentionCount }),
    notifyId: input.notify.notifyId,
  };
}

export class PushService {
  private readonly deviceBuckets = new Map<string, Bucket>();
  private readonly hostBuckets = new Map<string, Bucket>();
  /** Notification ids already delivered, oldest first. */
  private readonly delivered: string[] = [];
  private readonly deliveredSet = new Set<string>();
  private readonly apns: PushProvider | null;
  private readonly fcm: PushProvider | null;

  constructor(private readonly options: PushServiceOptions) {
    const providerOptions = { ...(options.now ? { now: options.now } : {}) };
    this.apns = options.apns ?? (options.config?.apns ? new ApnsClient(options.config.apns, providerOptions) : null);
    this.fcm = options.fcm ?? (options.config?.fcm ? new FcmClient(options.config.fcm, providerOptions) : null);
  }

  /** Whether this Gateway can push at all: no credentials, no push. */
  get enabled(): boolean {
    return Boolean(this.options.config);
  }

  /** Which platforms have a configured provider. */
  platforms(): { ios: boolean; android: boolean } {
    return { ios: Boolean(this.options.config?.apns), android: Boolean(this.options.config?.fcm) };
  }

  /** Release the providers' pooled connections; called when the Gateway stops. */
  close(): void {
    this.apns?.close?.();
    this.fcm?.close?.();
  }

  private now(): number {
    return (this.options.now ?? (() => Date.now()))();
  }

  /**
   * A token bucket, checked without consuming until every bucket allows the
   * event: a refused notification must not spend the other bucket's budget.
   */
  private allowed(key: string, buckets: Map<string, Bucket>, policy: RateLimitPolicy, now: number): boolean {
    const bucket = buckets.get(key);
    const tokens = bucket === undefined ? policy.capacity : Math.min(policy.capacity, bucket.tokens + ((now - bucket.updatedAt) / 1000) * policy.refillPerSecond);
    return tokens >= 1;
  }

  private consume(key: string, buckets: Map<string, Bucket>, policy: RateLimitPolicy, now: number): void {
    const bucket = buckets.get(key);
    const tokens = bucket === undefined ? policy.capacity : Math.min(policy.capacity, bucket.tokens + ((now - bucket.updatedAt) / 1000) * policy.refillPerSecond);
    buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    // Bound the map: a Gateway that has seen thousands of devices must not keep
    // a bucket per device forever.
    if (buckets.size > 4096) {
      for (const [staleKey, stale] of buckets) {
        if (now - stale.updatedAt > 3_600_000) buckets.delete(staleKey);
      }
    }
  }

  /** Remember a notify id; false when it was already delivered. */
  private claimNotifyId(notifyId: string): boolean {
    if (this.deliveredSet.has(notifyId)) return false;
    this.deliveredSet.add(notifyId);
    this.delivered.push(notifyId);
    while (this.delivered.length > DEDUPE_WINDOW) {
      const evicted = this.delivered.shift();
      if (evicted) this.deliveredSet.delete(evicted);
    }
    return true;
  }

  /**
   * One `host.notify` from one Host. Everything a push needs is decided here:
   * whether the Host may send it, who may hear about it, and whether it is news.
   */
  async handleNotify(hostId: string, notify: RacpHostNotify): Promise<PushNotificationOutcome> {
    if (!this.enabled) return { status: "disabled" };
    // Gate: only a Host that announced `push.notify` may report an event, the
    // same rule the device frames follow (§11.5, §11.6).
    if (!this.options.hostLinks.capabilitiesFor(hostId).includes(RACP_HOST_CAPABILITIES.pushNotify)) {
      this.options.log("warn", "gateway ignored a notification from a Host that did not announce push.notify", { hostId });
      return { status: "ignored", reason: "capability" };
    }
    const host = this.options.store.findHost(hostId);
    if (!host || host.revokedAt) return { status: "ignored", reason: "audience" };

    const now = this.now();
    const deviceLimit = this.options.deviceLimit ?? DEFAULT_PUSH_DEVICE_LIMIT;
    const hostLimit = this.options.hostLimit ?? DEFAULT_PUSH_HOST_LIMIT;
    // The per-Host bucket is checked before the per-device ones so a Host that
    // is over budget cannot even spend a device's tokens.
    if (!this.allowed(`host:${hostId}`, this.hostBuckets, hostLimit, now)) {
      this.options.log("warn", "gateway dropped a notification: this Host is over its push budget", { hostId });
      return { status: "ignored", reason: "rate-limited" };
    }
    if (!this.claimNotifyId(`${hostId}:${notify.notifyId}`)) return { status: "ignored", reason: "duplicate" };

    const audience = this.audienceFor(host.accountId ?? null, hostId);
    if (audience.length === 0) {
      // Nothing to tell: no device of this Host has registered for push. The
      // id stays claimed, so a retry is still not a second delivery.
      return { status: "sent", delivered: 0 };
    }
    this.consume(`host:${hostId}`, this.hostBuckets, hostLimit, now);
    const payload = buildPushPayload({ notify, hostId });

    // Which devices may be told at all is decided above the concurrency below,
    // so the budget is spent once per device rather than once per attempt.
    const targets: GatewayPushRegistrationRecord[] = [];
    for (const registration of audience) {
      // The device's own preference (§17.6.5): "only things that need me" drops the
      // two outcome kinds. Filtered here rather than on the phone because a
      // delivered notification cannot be recalled, and counted as a skip rather
      // than a failure: this device simply did not want this one.
      if (registration.onlyActionable === true && !PUSH_ACTIONABLE_KINDS.includes(notify.kind)) {
        this.options.log("info", "gateway skipped a notification: this device asked for actionable only", {
          deviceId: registration.deviceId,
          kind: notify.kind,
        });
        continue;
      }
      if (!this.allowed(`device:${registration.deviceId}`, this.deviceBuckets, deviceLimit, now)) {
        this.options.log("warn", "gateway dropped a notification for one device: it is over its push budget", {
          deviceId: registration.deviceId,
        });
        continue;
      }
      this.consume(`device:${registration.deviceId}`, this.deviceBuckets, deviceLimit, now);
      targets.push(registration);
    }
    const delivered = await this.deliverAll(targets, payload);

    // The audit names the event and the ids, never the payload: §11.6 allows a
    // push to say which event happened, and the audit says no more than that.
    await this.options.store
      .appendAudit({
        op: "push.notify",
        hostId,
        deviceId: audience.length === 1 ? audience[0]!.deviceId : undefined,
        ...(host.accountId ? { accountId: host.accountId } : {}),
        ip: "push",
        result: "ok",
      })
      .catch((error: unknown) => {
        this.options.log("warn", "gateway audit append failed", { error: String(error) });
      });
    return { status: "sent", delivered };
  }

  /**
   * Deliver to every target with a fixed concurrency. One device's timeout or
   * provider error is reported and forgotten here: the loop drains every worker,
   * so a slow phone cannot keep the next device or the audit waiting.
   */
  private async deliverAll(targets: GatewayPushRegistrationRecord[], payload: RacpPushPayload): Promise<number> {
    let delivered = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        const registration = targets[index];
        if (!registration) return;
        if (await this.deliverOne(registration, payload)) delivered += 1;
      }
    };
    const workers = Array.from({ length: Math.min(PUSH_DELIVERY_CONCURRENCY, targets.length) }, () => worker());
    await Promise.all(workers);
    return delivered;
  }

  /**
   * One target's delivery. Every failure is contained here — including a store
   * write that refuses (a full disk) — because a worker that rejects would take
   * `Promise.all` with it, skip the audit, and strand the targets the other
   * workers had not reached yet.
   */
  private async deliverOne(registration: GatewayPushRegistrationRecord, payload: RacpPushPayload): Promise<boolean> {
    let result: PushDeliveryResult;
    try {
      result = await this.deliver(registration, payload);
    } catch (error) {
      // A provider client that throws is a bug or a socket error: report it and
      // keep the other devices going.
      this.options.log("warn", "gateway push delivery threw", { platform: registration.platform, error: String(error) });
      return false;
    }
    try {
      if (result.ok) return true;
      if (result.reason === "unregistered") {
        // The provider says this token is dead: drop that one registration so the
        // next event does not pay for the same failure.
        await this.options.store.removePushRegistrationByToken(registration.platform, registration.token);
        this.options.log("info", "gateway removed a push registration the provider reported as unknown", {
          platform: registration.platform,
        });
        return false;
      }
      this.options.log(result.reason === "configuration" ? "error" : "warn", "gateway push delivery failed", {
        platform: registration.platform,
        reason: result.reason,
        status: result.status,
      });
    } catch (error) {
      // Cleanup or logging failed; the delivery already happened, and this
      // target must not take the rest of the batch down with it.
      this.options.log("warn", "gateway could not record a push delivery result", {
        platform: registration.platform,
        error: String(error),
      });
    }
    return false;
  }

  /**
   * Which registrations may hear about this Host: a §11.4 device bound to it, or
   * an account-mode device whose account owns it. Cross-account isolation is a
   * filter, not a check somewhere else (gate 29).
   */
  private audienceFor(hostAccountId: string | null, hostId: string): GatewayPushRegistrationRecord[] {
    return this.options.store.listPushRegistrations().filter((registration) => {
      const device = this.options.store.findDevice(registration.deviceId);
      // A revoked device has no registration (revocation deletes it), but a
      // registration written by a request that was already in flight when the
      // revocation landed would otherwise keep pushing to it. Check the device
      // state here as well, so the audience never contains a revoked device.
      if (!device || device.revokedAt) return false;
      if (registration.accountId) {
        // An account device: the Host must be of that account, and that Host
        // must be in the audience captured at registration.
        return hostAccountId === registration.accountId && registration.hostIds.includes(hostId);
      }
      return registration.hostId === hostId;
    });
  }

  private async deliver(registration: GatewayPushRegistrationRecord, payload: RacpPushPayload): Promise<PushDeliveryResult> {
    if (registration.platform === "ios") {
      if (!this.apns) return { ok: false, reason: "configuration", status: 0 };
      return this.apns.send(registration.token, payload);
    }
    if (!this.fcm) return { ok: false, reason: "configuration", status: 0 };
    return this.fcm.send(registration.token, payload);
  }

  /**
   * A registration to create for this device, or `null` when the device may not
   * register at all (it has no Host, or the Host is gone). The audience is
   * captured here: every live Host the device can open right now.
   */
  registrationAudience(device: {
    deviceId: string;
    hostId: string;
    accountId?: string;
  }): { hostIds: string[]; hostId: string; accountId?: string } {
    if (!device.accountId) return { hostIds: [device.hostId], hostId: device.hostId };
    const hostIds = this.options.store
      .listHostsForAccount(device.accountId)
      .filter((host) => !host.revokedAt)
      .map((host) => host.hostId);
    return { hostIds: hostIds.length > 0 ? hostIds : [device.hostId], hostId: device.hostId, accountId: device.accountId };
  }
}
