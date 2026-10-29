import { afterEach, describe, expect, it } from "vitest";

import type { RacpHostNotify, RacpPushPayload } from "@minih-agent/shared";

import { PUSH_DELIVERY_CONCURRENCY, PushService, buildPushPayload, type PushHostSource } from "./push.js";
import type { PushDeliveryResult } from "./push-providers.js";
import { GatewayStore } from "./store.js";

/**
 * The Gateway's redacted push routing (protocol §11.6, R5 PR-6, ADR 0331
 * decision 7).
 *
 * The provider is a recorder here: what these tests pin down is the decision
 * *before* delivery — who may be pushed about a Host, what the payload says, and
 * what happens when the same event, a noisy Host, or a dead token arrives. The
 * provider transport itself is covered in `push-providers.test.ts`, and the
 * end-to-end path over a local TLS stub in `scripts/e2e-remote-account-push.mjs`.
 */
type Recorder = {
  sent: Array<{ platform: "ios" | "android"; token: string; payload: RacpPushPayload }>;
  answer: (token: string) => PushDeliveryResult | Promise<PushDeliveryResult>;
  apns: { send(token: string, payload: RacpPushPayload): Promise<PushDeliveryResult> };
  fcm: { send(token: string, payload: RacpPushPayload): Promise<PushDeliveryResult> };
  /** How many deliveries are in flight right now, and the peak. */
  inFlight: () => number;
  peak: () => number;
};

function recorder(answer: (token: string) => PushDeliveryResult | Promise<PushDeliveryResult> = () => ({ ok: true })): Recorder {
  const sent: Recorder["sent"] = [];
  let current = 0;
  let peak = 0;
  const record = (platform: "ios" | "android") => ({
    async send(token: string, payload: RacpPushPayload): Promise<PushDeliveryResult> {
      current += 1;
      peak = Math.max(peak, current);
      sent.push({ platform, token, payload });
      try {
        return await answer(token);
      } finally {
        current -= 1;
      }
    },
  });
  return { sent, answer, apns: record("ios"), fcm: record("android"), inFlight: () => current, peak: () => peak };
}

function capabilitiesOf(hosts: Record<string, string[]>): PushHostSource {
  return {
    capabilitiesFor: (hostId) => hosts[hostId] ?? [],
    isOnline: (hostId) => hostId in hosts,
  };
}

function notify(overrides: Partial<RacpHostNotify> = {}): RacpHostNotify {
  return {
    notifyId: "ntf_1",
    kind: "approval.requested",
    sessionId: "s1",
    approvalId: "ap_1",
    occurredAt: "2026-10-18T00:00:00.000Z",
    ...overrides,
  };
}

const PUSH = "push.notify";

async function storeWith(hosts: Array<{ hostId: string; accountId?: string }>): Promise<GatewayStore> {
  // A temporary data directory per test, so registrations do not leak between
  // cases and the 0600/atomic-write path is the real one.
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "push-store-"));
  const store = await GatewayStore.open(dir);
  for (const host of hosts) {
    await saveHost(store, host.hostId, host.accountId);
  }
  return store;
}


/** Register one Host, as enrollment would (its certificate is never used here). */
async function saveHost(store: GatewayStore, hostId: string, accountId?: string): Promise<void> {
  await store.saveHostIfUnchanged(
    {
      hostId,
      label: hostId,
      certificatePem: "-----BEGIN CERTIFICATE-----\nunused\n-----END CERTIFICATE-----\n",
      certificateFingerprint256: "0".repeat(64),
      registeredAt: "2026-10-18T00:00:00.000Z",
      ...(accountId ? { accountId } : {}),
    },
    (current) => current === null,
  );
}

function service(options: {
  store: GatewayStore;
  hostLinks: PushHostSource;
  providers?: Recorder;
  config?: boolean;
  now?: () => number;
  deviceLimit?: { capacity: number; refillPerSecond: number };
  hostLimit?: { capacity: number; refillPerSecond: number };
}) {
  const providers = options.providers ?? recorder();
  const push = new PushService({
    store: options.store,
    config: options.config === false ? null : { apns: { privateKeyPem: "unused", keyId: "k", teamId: "t", topic: "app.test", endpoint: "https://apns.test" } },
    hostLinks: options.hostLinks,
    log: () => undefined,
    apns: providers.apns,
    fcm: providers.fcm,
    ...(options.now ? { now: options.now } : {}),
    ...(options.deviceLimit ? { deviceLimit: options.deviceLimit } : {}),
    ...(options.hostLimit ? { hostLimit: options.hostLimit } : {}),
  });
  return { push, providers };
}

/** A registration as the route would write it. */
async function register(
  store: GatewayStore,
  input: {
    deviceId: string;
    hostId: string;
    accountId?: string;
    hostIds?: string[];
    platform?: "ios" | "android";
    token?: string;
    onlyActionable?: boolean;
  },
) {
  await store.saveDevice({
    deviceId: input.deviceId,
    hostId: input.hostId,
    label: "phone",
    tokenHash: `hash_${input.deviceId}`,
    createdAt: "2026-10-18T00:00:00.000Z",
    ...(input.accountId ? { accountId: input.accountId } : {}),
  });
  await store.savePushRegistration({
    deviceId: input.deviceId,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    hostId: input.hostId,
    hostIds: input.hostIds ?? [input.hostId],
    platform: input.platform ?? "ios",
    token: input.token ?? `token_${input.deviceId}`,
    ...(input.onlyActionable === undefined ? {} : { onlyActionable: input.onlyActionable }),
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  });
}

describe("push service", () => {
  const open: GatewayStore[] = [];
  afterEach(async () => {
    for (const store of open.splice(0)) await store.flush();
  });

  async function newStore(hosts: Array<{ hostId: string; accountId?: string }>) {
    const store = await storeWith(hosts);
    open.push(store);
    return store;
  }

  it("sends nothing at all when no provider is configured", async () => {
    const store = await newStore([{ hostId: "host_a" }]);
    await register(store, { deviceId: "dev_1", hostId: "host_a" });
    const { push, providers } = service({ store, hostLinks: capabilitiesOf({ host_a: [PUSH] }), config: false });

    expect(push.enabled).toBe(false);
    expect(await push.handleNotify("host_a", notify())).toEqual({ status: "disabled" });
    expect(providers.sent).toEqual([]);
  });

  it("delivers one notification once per phone, even when re-pairing left a second registration", async () => {
    // A §11.4 device is minted per pairing, so pairing again leaves the older
    // registration in the store and both match this Host. The token is the
    // delivery target: pushing to each registration sent the same event twice.
    const store = await newStore([{ hostId: "host_a" }]);
    await register(store, { deviceId: "dev_old", hostId: "host_a", token: "token_phone" });
    await register(store, { deviceId: "dev_new", hostId: "host_a", token: "token_phone" });
    await register(store, { deviceId: "dev_other", hostId: "host_a", token: "token_other" });
    const { push, providers } = service({ store, hostLinks: capabilitiesOf({ host_a: [PUSH] }) });

    expect(await push.handleNotify("host_a", notify())).toEqual({ status: "sent", delivered: 2 });
    expect(providers.sent.map((entry) => entry.token).sort()).toEqual(["token_other", "token_phone"]);
  });

  it("refuses a notification from a Host that never announced push.notify", async () => {
    const store = await newStore([{ hostId: "host_a" }]);
    await register(store, { deviceId: "dev_1", hostId: "host_a" });
    const { push, providers } = service({ store, hostLinks: capabilitiesOf({ host_a: ["device.confirm"] }) });

    expect(await push.handleNotify("host_a", notify())).toEqual({ status: "ignored", reason: "capability" });
    expect(providers.sent).toEqual([]);
  });

  it("delivers a payload of ids and localization keys, and nothing else", async () => {
    const store = await newStore([{ hostId: "host_a" }]);
    await register(store, { deviceId: "dev_1", hostId: "host_a" });
    const { push, providers } = service({ store, hostLinks: capabilitiesOf({ host_a: [PUSH] }) });

    expect(await push.handleNotify("host_a", notify())).toEqual({ status: "sent", delivered: 1 });
    expect(providers.sent).toHaveLength(1);
    expect(providers.sent[0]!.payload).toEqual({
      kind: "approval.requested",
      titleKey: "push.notify.approval.requested.title",
      bodyKey: "push.notify.approval.requested.body",
      hostId: "host_a",
      sessionId: "s1",
      approvalId: "ap_1",
      notifyId: "ntf_1",
    });
    // The whole point of §11.6: no content field exists, so none can leak.
    expect(Object.keys(providers.sent[0]!.payload).sort()).toEqual(
      ["approvalId", "bodyKey", "hostId", "kind", "notifyId", "sessionId", "titleKey"],
    );
    expect(buildPushPayload({ notify: notify({ approvalId: undefined }), hostId: "host_a" })).not.toHaveProperty("approvalId");
  });

  it("pushes a §11.4 device only about its own Host", async () => {
    const store = await newStore([{ hostId: "host_a" }, { hostId: "host_b" }]);
    await register(store, { deviceId: "dev_a", hostId: "host_a" });
    await register(store, { deviceId: "dev_b", hostId: "host_b" });
    const { push, providers } = service({ store, hostLinks: capabilitiesOf({ host_a: [PUSH], host_b: [PUSH] }) });

    await push.handleNotify("host_a", notify({ notifyId: "n1" }));
    expect(providers.sent.map((entry) => entry.token)).toEqual(["token_dev_a"]);

    // And a notification about B never names A's device.
    providers.sent.length = 0;
    await push.handleNotify("host_b", notify({ notifyId: "n2" }));
    expect(providers.sent.map((entry) => entry.token)).toEqual(["token_dev_b"]);
  });

  it("pushes an account device about every Host of its account, and no other account's", async () => {
    const store = await newStore([
      { hostId: "host_a1", accountId: "42" },
      { hostId: "host_a2", accountId: "42" },
      { hostId: "host_b1", accountId: "77" },
    ]);
    await register(store, {
      deviceId: "dev_acct",
      hostId: "host_a1",
      accountId: "42",
      hostIds: ["host_a1", "host_a2"],
    });
    const { push, providers } = service({
      store,
      hostLinks: capabilitiesOf({ host_a1: [PUSH], host_a2: [PUSH], host_b1: [PUSH] }),
    });

    await push.handleNotify("host_a2", notify({ notifyId: "n_a" }));
    expect(providers.sent.map((entry) => entry.token)).toEqual(["token_dev_acct"]);

    // Another account's Host is not in this device's audience at all (gate 29).
    providers.sent.length = 0;
    await push.handleNotify("host_b1", notify({ notifyId: "n_b" }));
    expect(providers.sent).toEqual([]);
  });

  it("skips the outcome kinds for a device that asked for actionable only", async () => {
    const store = await newStore([{ hostId: "host_a" }]);
    await register(store, { deviceId: "dev_1", hostId: "host_a", onlyActionable: true });
    const { push, providers } = service({ store, hostLinks: capabilitiesOf({ host_a: [PUSH] }) });

    const completed = await push.handleNotify("host_a", {
      notifyId: "n_completed",
      kind: "turn.completed",
      sessionId: "session_1",
      occurredAt: "2026-10-18T00:00:00.000Z",
    });
    expect(completed).toEqual({ status: "sent", delivered: 0 });
    expect(providers.sent).toHaveLength(0);

    // The same device still hears about the things it has to act on.
    const approval = await push.handleNotify("host_a", {
      notifyId: "n_approval",
      kind: "approval.requested",
      sessionId: "session_1",
      occurredAt: "2026-10-18T00:00:00.000Z",
    });
    expect(approval).toEqual({ status: "sent", delivered: 1 });
    expect(providers.sent.map((entry) => entry.payload.kind)).toEqual(["approval.requested"]);
  });

  it("still sends every kind to a device that never set the preference", async () => {
    const store = await newStore([{ hostId: "host_a" }]);
    await register(store, { deviceId: "dev_1", hostId: "host_a" });
    const { push, providers } = service({ store, hostLinks: capabilitiesOf({ host_a: [PUSH] }) });

    await push.handleNotify("host_a", {
      notifyId: "n_completed",
      kind: "turn.completed",
      sessionId: "session_1",
      occurredAt: "2026-10-18T00:00:00.000Z",
    });
    expect(providers.sent).toHaveLength(1);
  });

  it("sends one push per event, however often the Host repeats it", async () => {
    const store = await newStore([{ hostId: "host_a" }]);
    await register(store, { deviceId: "dev_1", hostId: "host_a" });
    const { push, providers } = service({ store, hostLinks: capabilitiesOf({ host_a: [PUSH] }) });

    await push.handleNotify("host_a", notify({ notifyId: "n1" }));
    expect(await push.handleNotify("host_a", notify({ notifyId: "n1" }))).toEqual({ status: "ignored", reason: "duplicate" });
    expect(providers.sent).toHaveLength(1);
    // A different event is news again.
    await push.handleNotify("host_a", notify({ notifyId: "n2" }));
    expect(providers.sent).toHaveLength(2);
  });

  it("holds a noisy Host to its own budget before it spends a device's", async () => {
    const store = await newStore([{ hostId: "host_a" }]);
    await register(store, { deviceId: "dev_1", hostId: "host_a" });
    let now = Date.parse("2026-10-18T00:00:00.000Z");
    const { push, providers } = service({
      store,
      hostLinks: capabilitiesOf({ host_a: [PUSH] }),
      now: () => now,
      // Two in the burst, one more every ten seconds: a Host that reports more
      // often than a person can act is the case under test.
      hostLimit: { capacity: 2, refillPerSecond: 0.1 },
      deviceLimit: { capacity: 10, refillPerSecond: 0 },
    });

    expect((await push.handleNotify("host_a", notify({ notifyId: "n1" }))).status).toBe("sent");
    expect((await push.handleNotify("host_a", notify({ notifyId: "n2" }))).status).toBe("sent");
    expect(await push.handleNotify("host_a", notify({ notifyId: "n3" }))).toEqual({ status: "ignored", reason: "rate-limited" });
    expect(providers.sent).toHaveLength(2);
    now += 60_000;
    expect((await push.handleNotify("host_a", notify({ notifyId: "n4" }))).status).toBe("sent");
  });

  it("drops one device over its own budget without blocking the others", async () => {
    const store = await newStore([{ hostId: "host_a", accountId: "42" }]);
    await register(store, { deviceId: "dev_1", hostId: "host_a", accountId: "42" });
    await register(store, { deviceId: "dev_2", hostId: "host_a", accountId: "42" });
    const { push, providers } = service({
      store,
      hostLinks: capabilitiesOf({ host_a: [PUSH] }),
      deviceLimit: { capacity: 1, refillPerSecond: 0 },
      hostLimit: { capacity: 10, refillPerSecond: 0 },
    });

    // The first event reaches both (each device starts with one token); the
    // second event reaches neither.
    await push.handleNotify("host_a", notify({ notifyId: "n1" }));
    expect(providers.sent).toHaveLength(2);
    providers.sent.length = 0;
    await push.handleNotify("host_a", notify({ notifyId: "n2" }));
    expect(providers.sent).toHaveLength(0);
  });

  it("deletes a registration the provider reports as a dead token", async () => {
    const store = await newStore([{ hostId: "host_a" }]);
    await register(store, { deviceId: "dev_1", hostId: "host_a", token: "dead_token" });
    const { push } = service({
      store,
      hostLinks: capabilitiesOf({ host_a: [PUSH] }),
      providers: recorder(() => ({ ok: false, reason: "unregistered", status: 410 })),
    });

    await push.handleNotify("host_a", notify({ notifyId: "n1" }));
    expect(store.findPushRegistration("dev_1")).toBeNull();
    // The next event has nobody to tell, and costs nothing.
    expect(await push.handleNotify("host_a", notify({ notifyId: "n2" }))).toEqual({ status: "sent", delivered: 0 });
  });

  it("keeps a registration after a transient failure", async () => {
    const store = await newStore([{ hostId: "host_a" }]);
    await register(store, { deviceId: "dev_1", hostId: "host_a" });
    const { push } = service({
      store,
      hostLinks: capabilitiesOf({ host_a: [PUSH] }),
      providers: recorder(() => ({ ok: false, reason: "transient", status: 503 })),
    });
    expect((await push.handleNotify("host_a", notify())).status).toBe("sent");
    expect(store.findPushRegistration("dev_1")).not.toBeNull();
  });

  it("drops the registration when the device is revoked, so a revoked device is never pushed", async () => {
    const store = await newStore([{ hostId: "host_a" }]);
    await register(store, { deviceId: "dev_1", hostId: "host_a" });
    expect(store.findPushRegistration("dev_1")).not.toBeNull();

    await store.revokeDevice("dev_1", "2026-10-18T00:00:01.000Z");
    expect(store.findPushRegistration("dev_1")).toBeNull();

    const { push, providers } = service({ store, hostLinks: capabilitiesOf({ host_a: [PUSH] }) });
    await push.handleNotify("host_a", notify());
    expect(providers.sent).toEqual([]);
  });

  it("captures the audience at registration, so a later enrollment cannot widen it", async () => {
    const store = await newStore([{ hostId: "host_a", accountId: "42" }]);
    await store.saveDevice({
      deviceId: "dev_1",
      hostId: "host_a",
      label: "phone",
      tokenHash: "hash_dev_1",
      createdAt: "2026-10-18T00:00:00.000Z",
      accountId: "42",
    });
    const { push, providers } = service({
      store,
      hostLinks: capabilitiesOf({ host_a: [PUSH], host_late: [PUSH] }),
    });

    // What the route writes: the audience resolved at this moment.
    const audience = push.registrationAudience({ deviceId: "dev_1", hostId: "host_a", accountId: "42" });
    expect(audience.hostIds).toEqual(["host_a"]);
    await store.savePushRegistration({
      deviceId: "dev_1",
      accountId: "42",
      hostId: "host_a",
      hostIds: audience.hostIds,
      platform: "ios",
      token: "token_dev_1",
      createdAt: "2026-10-18T00:00:00.000Z",
      updatedAt: "2026-10-18T00:00:00.000Z",
    });

    await saveHost(store, "host_late", "42");
    // A Host enrolled after the fact is not silently added to the stored record:
    // the push for it reaches nobody until the device registers again.
    await push.handleNotify("host_late", notify({ notifyId: "n_late" }));
    expect(providers.sent).toEqual([]);
    expect(store.findPushRegistration("dev_1")?.hostIds).toEqual(["host_a"]);

    // A new registration is what picks the Host up.
    expect(push.registrationAudience({ deviceId: "dev_1", hostId: "host_a", accountId: "42" }).hostIds).toEqual([
      "host_a",
      "host_late",
    ]);
    // And the Host the record does cover is still reachable.
    await push.handleNotify("host_a", notify({ notifyId: "n_a" }));
    expect(providers.sent.map((entry) => entry.token)).toEqual(["token_dev_1"]);
  });

  it("never pushes to a device that was revoked while its registration was being written", async () => {
    // The registration row exists, but the device was revoked after it: the
    // audience must be built from the device's *current* state, not from the row
    // alone, or a revoked phone keeps receiving events.
    const store = await newStore([{ hostId: "host_a" }]);
    await register(store, { deviceId: "dev_1", hostId: "host_a" });
    await store.saveDevice({
      deviceId: "dev_1",
      hostId: "host_a",
      label: "phone",
      tokenHash: "hash_dev_1",
      createdAt: "2026-10-18T00:00:00.000Z",
      revokedAt: "2026-10-18T00:00:01.000Z",
    });
    const { push, providers } = service({ store, hostLinks: capabilitiesOf({ host_a: [PUSH] }) });
    await push.handleNotify("host_a", notify());
    expect(providers.sent).toEqual([]);
  });

  it("keeps delivering to the other devices when one provider call throws", async () => {
    const store = await newStore([{ hostId: "host_a" }]);
    await register(store, { deviceId: "dev_a", hostId: "host_a", token: "token_a" });
    await register(store, { deviceId: "dev_b", hostId: "host_a", token: "token_b" });
    const { push, providers } = service({
      store,
      hostLinks: capabilitiesOf({ host_a: [PUSH] }),
      providers: recorder((token) => {
        if (token === "token_a") throw new Error("socket hang up");
        return { ok: true };
      }),
    });
    expect(await push.handleNotify("host_a", notify())).toEqual({ status: "sent", delivered: 1 });
    expect(providers.sent.map((entry) => entry.token).sort()).toEqual(["token_a", "token_b"]);
    // The failed delivery is reported, and its registration is kept: a thrown
    // error is not a dead token.
    expect(store.findPushRegistration("dev_a")).not.toBeNull();
  });

  it("bounds how many devices one notification reaches at once", async () => {
    const store = await newStore([{ hostId: "host_a" }]);
    for (let index = 0; index < 12; index += 1) {
      await register(store, { deviceId: `dev_${index}`, hostId: "host_a", token: `token_${index}` });
    }
    const { push, providers } = service({
      store,
      hostLinks: capabilitiesOf({ host_a: [PUSH] }),
      providers: recorder(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: true };
      }),
    });
    expect(await push.handleNotify("host_a", notify())).toEqual({ status: "sent", delivered: 12 });
    // Bounded, not serial: four at a time, never twelve sockets open together.
    expect(providers.peak()).toBeLessThanOrEqual(PUSH_DELIVERY_CONCURRENCY);
    expect(providers.peak()).toBeGreaterThan(1);
    expect(providers.inFlight()).toBe(0);
  });

  it("does not let one device's slow provider delay the audit or the others", async () => {
    const store = await newStore([{ hostId: "host_a" }]);
    await register(store, { deviceId: "dev_slow", hostId: "host_a", token: "slow" });
    await register(store, { deviceId: "dev_fast", hostId: "host_a", token: "fast" });
    // The fast device's delivery must *finish* while the slow one is still
    // waiting: that is the property, and a serial loop cannot satisfy it.
    let fastFinishedBeforeSlow = false;
    let slowDone = false;
    const { push, providers } = service({
      store,
      hostLinks: capabilitiesOf({ host_a: [PUSH] }),
      providers: recorder(async (token) => {
        if (token === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 80));
          slowDone = true;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (!slowDone) fastFinishedBeforeSlow = true;
        }
        return { ok: true };
      }),
    });
    expect(await push.handleNotify("host_a", notify())).toEqual({ status: "sent", delivered: 2 });
    expect(fastFinishedBeforeSlow).toBe(true);
    // The audit record is written after delivery, for every device, whatever a
    // single provider did.
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    const audit = await store.audit.read(day);
    expect(audit.some((entry) => entry.op === "push.notify")).toBe(true);
    expect(providers.sent).toHaveLength(2);
  });

  it("still audits and keeps the other deliveries when the store cannot record a dead token", async () => {
    const store = await newStore([{ hostId: "host_a" }]);
    await register(store, { deviceId: "dev_dead", hostId: "host_a", token: "dead" });
    await register(store, { deviceId: "dev_live", hostId: "host_a", token: "live" });
    // A full disk makes the cleanup write throw. That must not reject the worker,
    // skip the audit, or strand the other device.
    store.removePushRegistrationByToken = async () => {
      throw new Error("ENOSPC: no space left on device");
    };
    const { push, providers } = service({
      store,
      hostLinks: capabilitiesOf({ host_a: [PUSH] }),
      providers: recorder((token) => (token === "dead" ? { ok: false, reason: "unregistered", status: 410 } : { ok: true })),
    });
    expect(await push.handleNotify("host_a", notify())).toEqual({ status: "sent", delivered: 1 });
    expect(providers.sent.map((entry) => entry.token).sort()).toEqual(["dead", "live"]);
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    const audit = await store.audit.read(day);
    expect(audit.some((entry) => entry.op === "push.notify")).toBe(true);
  });

  it("names no Host the device could not open, even with a stale audience", async () => {
    const store = await newStore([{ hostId: "host_a", accountId: "42" }]);
    await register(store, {
      deviceId: "dev_1",
      hostId: "host_a",
      accountId: "42",
      // A Host of another account left over in a stale record.
      hostIds: ["host_a", "host_other"],
    });
    const { push, providers } = service({
      store,
      hostLinks: capabilitiesOf({ host_a: [PUSH], host_other: [PUSH] }),
    });
    await push.handleNotify("host_other", notify());
    expect(providers.sent).toEqual([]);
  });

  it("takes the newest registration for a token, so its preferences apply", async () => {
  const store = await newStore([{ hostId: "host_a" }]);
  // Re-pairing left the older row behind, and the newer one asked for
  // "only things that need me". Filtering on the older row would deliver an
  // outcome this phone explicitly did not want.
  await register(store, { deviceId: "dev_old", hostId: "host_a", token: "token_phone" });
  await register(store, { deviceId: "dev_new", hostId: "host_a", token: "token_phone", onlyActionable: true });
  const { push, providers } = service({ store, hostLinks: capabilitiesOf({ host_a: [PUSH] }) });

  const outcome = await push.handleNotify("host_a", {
    notifyId: "ntf_turn",
    kind: "turn.completed",
    sessionId: "s1",
    occurredAt: "2026-10-18T00:00:00.000Z",
  });
  expect(outcome).toEqual({ status: "sent", delivered: 0 });
  expect(providers.sent).toEqual([]);
});
});
