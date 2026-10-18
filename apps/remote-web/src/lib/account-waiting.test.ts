/**
 * The waiting policy and the outcome of an account device request (protocol
 * §11.5, rollout R7 package F).
 *
 * A request lives five minutes, nobody may be watching a computer, and the
 * Gateway rate-limits the status reads, so what is pinned down here is the
 * roster a user is shown up front, how long the client waits between reads, and
 * which state each way of ending the wait lands on.
 */
import { describe, expect, it } from "vitest";

import {
  POLL_INTERVAL_MS,
  POLL_MAX_BACKOFF_MS,
  rosterSummary,
  remainingMs,
  pollDelayMs,
  failureOf,
} from "./account-flow.js";
import type { AccountAdoptionOutcome } from "./credential-port.js";
import {
  EXPIRES,
  START,
  errorBody,
  fakeTimer,
  flush,
  deferred,
  ROSTER,
  loginOk,
  hostsOk,
  requestOk,
  statusOk,
  logoutCalls,
  signedInAndRequesting,
} from "./account-test-support.js";
import type {
  Scripted,
} from "./account-test-support.js";

describe("rosterSummary", () => {
  it("separates the Hosts that can answer from the ones that cannot", () => {
    const summary = rosterSummary(ROSTER);
    expect(summary.confirmable.map((host) => host.hostId)).toEqual(["host1"]);
    expect(summary.accepting.map((host) => host.hostId)).toEqual(["host1"]);
    expect(summary.silent.map((host) => host.hostId)).toEqual(["host2"]);
    expect(summary.anyCanConfirm).toBe(true);
  });

  it("says so when no Host of the account can confirm", () => {
    const summary = rosterSummary([
      { hostId: "host1", label: "desk", online: true, canConfirm: false, willAcceptGrant: true },
      { hostId: "host2", label: "laptop", online: false, canConfirm: true, willAcceptGrant: false },
    ]);
    // A Host with a confirmer that is switched off is as silent as one without.
    expect(summary.anyCanConfirm).toBe(false);
    expect(summary.silent).toHaveLength(2);
    expect(rosterSummary([]).anyCanConfirm).toBe(false);
  });
});


describe("waiting policy", () => {
  it("measures the time left without ever going negative", () => {
    expect(remainingMs(EXPIRES, START)).toBe(300_000);
    expect(remainingMs(EXPIRES, Date.parse(EXPIRES))).toBe(0);
    expect(remainingMs(EXPIRES, Date.parse("2026-10-19T00:00:00.000Z"))).toBe(0);
    expect(remainingMs("not a date", START)).toBe(0);
  });

  it("polls steadily, backs off after a failure, and obeys the Gateway's own hint", () => {
    expect(pollDelayMs({ consecutiveFailures: 0 })).toBe(POLL_INTERVAL_MS);
    expect(pollDelayMs({ consecutiveFailures: 1 })).toBe(4_000);
    expect(pollDelayMs({ consecutiveFailures: 2 })).toBe(8_000);
    expect(pollDelayMs({ consecutiveFailures: 3 })).toBe(POLL_MAX_BACKOFF_MS);
    expect(pollDelayMs({ consecutiveFailures: 40 })).toBe(POLL_MAX_BACKOFF_MS);
    const limited = { code: "RATE_LIMITED", message: "slow down", retriable: true, retryAfterMs: 7_000 };
    expect(pollDelayMs({ failure: limited, consecutiveFailures: 3 })).toBe(7_000);
    // A hint shorter than the normal interval does not make the client faster.
    expect(pollDelayMs({ failure: { ...limited, retryAfterMs: 100 }, consecutiveFailures: 3 })).toBe(POLL_INTERVAL_MS);
    expect(pollDelayMs({ failure: { ...limited, retryAfterMs: undefined }, consecutiveFailures: 0 })).toBe(POLL_INTERVAL_MS);
  });
});


describe("the outcome of a request", () => {
  const grantedRoute = (result: Record<string, unknown>) => (url: string, method: string): Scripted => {
    if (url.endsWith("/login")) return loginOk();
    if (url.endsWith("/hosts")) return hostsOk();
    if (url.endsWith("/logout")) return { status: 200, body: { result: { revoked: true } } };
    if (method === "POST") return requestOk();
    return statusOk({ status: "granted", deviceId: "dev_1", tokenDelivered: true, ...result });
  };

  it("adopts one device on every Host of the account, then drops the session", async () => {
    const timer = fakeTimer();
    const { flow, adoptions, calls } = await signedInAndRequesting({
      timer: timer.timer,
      route: grantedRoute({ token: "pdt1.device", signerHostId: "host1" }),
    });

    await timer.fire();

    expect(adoptions).toEqual([
      {
        deviceId: "dev_1",
        label: "iPad",
        hosts: [
          { hostId: "host1", label: "desk", requiresOwnConfirmation: false },
          { hostId: "host2", label: "laptop", requiresOwnConfirmation: false },
        ],
        token: "pdt1.device",
      },
    ]);
    expect(flow.getState()).toEqual({ kind: "adopted", hostIds: ["host1", "host2"] });
    const logout = logoutCalls(calls);
    expect(logout).toHaveLength(1);
    expect(logout[0]!.headers["x-csrf-token"]).toBe("csrf-account");
  });

  it("adopts a browser grant through the per-Host CSRF values instead of a token", async () => {
    const timer = fakeTimer();
    const { flow, adoptions } = await signedInAndRequesting({
      timer: timer.timer,
      route: grantedRoute({ csrfTokens: { host1: "csrf-device-1", host2: "csrf-device-2" } }),
    });

    await timer.fire();

    expect(adoptions[0]).toEqual({
      deviceId: "dev_1",
      label: "iPad",
      hosts: [
        { hostId: "host1", label: "desk", requiresOwnConfirmation: false },
        { hostId: "host2", label: "laptop", requiresOwnConfirmation: false },
      ],
      csrfTokens: { host1: "csrf-device-1", host2: "csrf-device-2" },
    });
    expect(adoptions[0]!.token).toBeUndefined();
    expect(flow.getState()).toEqual({ kind: "adopted", hostIds: ["host1", "host2"] });
  });

  /**
   * Which Host needs which next step is decided once, from the roster the
   * Gateway answered (protocol §11.5): a Host that is online and will not accept
   * a sibling's grant confirms every device itself, so no refresh will ever make
   * it ready and the client has to remember that.
   */
  it("remembers which Hosts of the roster need their own confirmation", async () => {
    const timer = fakeTimer();
    const roster = [
      { hostId: "host1", label: "desk", online: true, canConfirm: true, willAcceptGrant: true },
      { hostId: "host2", label: "laptop", online: true, canConfirm: true, willAcceptGrant: false },
      // Offline: it may catch up by itself once it is back, so it is not
      // recorded as one that will never adopt the grant.
      { hostId: "host3", label: "studio", online: false, canConfirm: false, willAcceptGrant: false },
    ];
    const { flow, adoptions } = await signedInAndRequesting({
      timer: timer.timer,
      route: (url, method) => {
        if (url.endsWith("/login")) return loginOk();
        if (url.endsWith("/hosts")) return hostsOk();
        if (url.endsWith("/logout")) return { status: 200, body: { result: { revoked: true } } };
        if (method === "POST") return requestOk(roster);
        return statusOk({ status: "granted", deviceId: "dev_1", token: "pdt1.device", tokenDelivered: true, hosts: roster });
      },
    });

    await timer.fire();

    expect(adoptions[0]!.hosts).toEqual([
      { hostId: "host1", label: "desk", requiresOwnConfirmation: false },
      { hostId: "host2", label: "laptop", requiresOwnConfirmation: true },
      { hostId: "host3", label: "studio", requiresOwnConfirmation: false },
    ]);
    expect(flow.getState()).toEqual({ kind: "adopted", hostIds: ["host1", "host2", "host3"] });
  });

  it("reports a grant whose pickup window closed as lost, and lets the user ask again", async () => {
    const timer = fakeTimer();
    const { flow, adoptions, calls } = await signedInAndRequesting({
      timer: timer.timer,
      route: grantedRoute({ tokenDelivered: false, signerHostId: "host1" }),
    });

    await timer.fire();

    expect(flow.getState()).toEqual({ kind: "lost", hosts: ROSTER });
    expect(adoptions).toEqual([]);
    // The session is kept: the user can ask again without signing in again.
    expect(logoutCalls(calls)).toEqual([]);
    await flow.requestDevice();
    expect(flow.getState().kind).toBe("requesting");
  });

  it("shows who approved while the device is being stored", async () => {
    const timer = fakeTimer();
    const gate = deferred<AccountAdoptionOutcome>();
    const { flow } = await signedInAndRequesting({
      timer: timer.timer,
      adopt: () => gate.promise,
      route: grantedRoute({ token: "pdt1.device", signerHostId: "host1" }),
    });

    await timer.fire();
    expect(flow.getState()).toEqual({
      kind: "granted",
      deviceId: "dev_1",
      expiresAt: EXPIRES,
      hosts: ROSTER,
      signerHostId: "host1",
    });

    gate.resolve({ ok: true, hostIds: ["host1", "host2"] });
    await flush();
    expect(flow.getState()).toEqual({ kind: "adopted", hostIds: ["host1", "host2"] });
  });

  it("reports a request the Gateway no longer knows as gone", async () => {
    const timer = fakeTimer();
    const { flow } = await signedInAndRequesting({
      timer: timer.timer,
      route: (url, method) => {
        if (url.endsWith("/login")) return loginOk();
        if (url.endsWith("/hosts")) return hostsOk();
        if (method === "POST") return requestOk();
        return { status: 404, body: errorBody("NOT_FOUND", "no such device request") };
      },
    });

    await timer.fire();
    expect(flow.getState()).toEqual({ kind: "gone" });
    expect(timer.delays()).toEqual([]);
  });

  it("reports a device that could not be stored, and retries from the roster", async () => {
    const timer = fakeTimer();
    const { flow, calls } = await signedInAndRequesting({
      timer: timer.timer,
      adopt: async () => ({
        ok: false,
        failure: { code: "STORAGE_FAILED", message: "the secure store refused the write", retriable: false },
      }),
      route: grantedRoute({ token: "pdt1.device" }),
    });

    await timer.fire();

    expect(flow.getState()).toEqual({
      kind: "failed",
      failure: { code: "STORAGE_FAILED", message: "the secure store refused the write", retriable: false },
    });
    // The device exists on the Gateway but was never kept here, so the session
    // is still the one that can ask again.
    expect(logoutCalls(calls)).toEqual([]);
    await flow.retry();
    expect(flow.getState().kind).toBe("signed-in");
    await flow.requestDevice();
    expect(flow.getState().kind).toBe("requesting");
  });

  it("survives a storage backend that throws instead of answering", async () => {
    const timer = fakeTimer();
    const { flow } = await signedInAndRequesting({
      timer: timer.timer,
      adopt: () => Promise.reject(new Error("QuotaExceededError: localStorage is full")),
      route: grantedRoute({ token: "pdt1.device" }),
    });

    await timer.fire();
    expect(flow.getState()).toEqual({
      kind: "failed",
      failure: { code: "INTERNAL", message: "QuotaExceededError: localStorage is full", retriable: true },
    });
  });
});


describe("failureOf", () => {
  it("turns a thrown value into something the screen can render", () => {
    expect(failureOf(new Error("boom"))).toEqual({ code: "INTERNAL", message: "boom", retriable: true });
    expect(failureOf("gone")).toEqual({ code: "INTERNAL", message: "gone", retriable: true });
  });
});
