/**
 * The account device flow as a state machine (protocol §11.5, rollout R7
 * package F): signing in, asking for a device, and what a client does when the
 * Gateway is slow, refuses the request, or has already lost the session.
 *
 * Every wait here is driven by the injected timer, so the assertions are about
 * what the screen would render, not about wall-clock timing.
 */
import { describe, expect, it } from "vitest";

import {
  POLL_INTERVAL_MS,
  POLL_MAX_BACKOFF_MS,
  POLL_MAX_FAILURES,
  type AccountFlowState,
} from "./account-flow.js";
import {
  EXPIRES,
  START,
  fakeFetch,
  errorBody,
  fakeTimer,
  deferred,
  ROSTER,
  loginOk,
  hostsOk,
  requestOk,
  statusOk,
  flowFor,
  statusCalls,
  logoutCalls,
  signedInAndRequesting,
} from "./account-test-support.js";
import type {
  Scripted,
} from "./account-test-support.js";

describe("signing in", () => {
  it("signs in with the AccessKey, lists the account's Hosts, and keeps the key nowhere", async () => {
    const { fetchImpl, calls } = fakeFetch((url) => (url.endsWith("/login") ? loginOk() : hostsOk()));
    const { flow } = flowFor({ fetchImpl });
    const seen: AccountFlowState[] = [];
    flow.subscribe(() => seen.push(flow.getState()));

    await flow.signIn("sk-gl-sentinel");

    expect(seen.map((state) => state.kind)).toEqual(["signing-in", "signed-in"]);
    expect(flow.getState()).toEqual({
      kind: "signed-in",
      accountId: "11",
      hosts: [
        { hostId: "host1", label: "desk", online: true },
        { hostId: "host2", label: "laptop", online: false },
      ],
    });
    // The key rides the Authorization header of the login call, once.
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-gl-sentinel");
    expect(calls[0]!.body).toEqual({ client: "web" });
    const leaked = calls.filter((call) => call.url.endsWith("/login") === false && JSON.stringify(call).includes("sk-gl-sentinel"));
    expect(leaked).toEqual([]);
    // And it survives nowhere in the state the screen renders.
    expect(JSON.stringify(flow.getState())).not.toContain("sk-gl-sentinel");
  });

  it("names the reason a sign-in was refused and lets the user try again", async () => {
    let answer: Scripted = { status: 401, body: errorBody("ACCESS_KEY_INVALID", "the key was replaced") };
    const { fetchImpl } = fakeFetch(() => answer);
    const { flow } = flowFor({ fetchImpl });

    await flow.signIn("sk-gl-stale");
    expect(flow.getState()).toEqual({
      kind: "sign-in-failed",
      failure: { code: "ACCESS_KEY_INVALID", message: "the key was replaced", retriable: false },
    });

    answer = loginOk();
    await flow.signIn("sk-gl-fresh");
    expect(flow.getState().kind).toBe("signed-in");
  });

  it("fails the sign-in when the Host list cannot be read, and revokes the session", async () => {
    const { fetchImpl, calls } = fakeFetch((url) =>
      url.endsWith("/login") ? loginOk() : { status: 503, body: errorBody("ACCESS_KEY_UNAVAILABLE", "the Router is down", true) },
    );
    const { flow } = flowFor({ fetchImpl });
    await flow.signIn("sk-gl-1");
    expect(flow.getState()).toEqual({
      kind: "sign-in-failed",
      failure: { code: "ACCESS_KEY_UNAVAILABLE", message: "the Router is down", retriable: true },
    });
    // The session exists but is unusable: it is revoked rather than left behind
    // for the next sign-in to overwrite.
    expect(logoutCalls(calls)).toHaveLength(1);
  });

  it("ignores a second sign-in while the first is still in flight", async () => {
    const gate = deferred<unknown>();
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      const payload = await gate.promise;
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const { flow } = flowFor({ fetchImpl });

    const first = flow.signIn("sk-gl-one");
    await flow.signIn("sk-gl-two");
    expect(calls).toHaveLength(1);
    gate.resolve({ result: { accountId: "11", expiresAt: EXPIRES, csrfToken: "csrf" } });
    await first;
    expect(flow.getState().kind).toBe("signed-in");
  });
});


describe("requesting a device", () => {
  it("asks with the device name and the build's client kind, then polls", async () => {
    const { flow, calls } = await signedInAndRequesting({
      timer: fakeTimer().timer,
      route: (url) => (url.endsWith("/login") ? loginOk() : url.endsWith("/hosts") ? hostsOk() : requestOk()),
    });
    expect(flow.getState()).toEqual({ kind: "requesting", requestId: "dreq_1", expiresAt: EXPIRES, hosts: ROSTER });
    const request = calls.find((call) => call.method === "POST" && call.url.endsWith("/devices"))!;
    expect(request.body).toEqual({ deviceLabel: "iPad", client: "web" });
    expect(request.headers["x-csrf-token"]).toBe("csrf-account");
  });

  it("refreshes the roster while the request is still pending", async () => {
    const timer = fakeTimer();
    const refreshed = [{ hostId: "host2", label: "laptop", online: true, canConfirm: true, willAcceptGrant: true }];
    let reads = 0;
    const { flow } = await signedInAndRequesting({
      timer: timer.timer,
      now: () => START,
      route: (url, method) => {
        if (url.endsWith("/login")) return loginOk();
        if (url.endsWith("/hosts")) return hostsOk();
        if (method === "POST") return requestOk();
        reads += 1;
        return reads === 1 ? statusOk({ status: "pending" }) : statusOk({ status: "pending", hosts: refreshed });
      },
    });

    expect(timer.delays()).toEqual([POLL_INTERVAL_MS]);
    await timer.fire();
    expect(flow.getState()).toEqual({ kind: "requesting", requestId: "dreq_1", expiresAt: EXPIRES, hosts: ROSTER });
    await timer.fire();
    expect(flow.getState()).toEqual({ kind: "requesting", requestId: "dreq_1", expiresAt: EXPIRES, hosts: refreshed });
    expect(timer.delays()).toEqual([POLL_INTERVAL_MS]);
  });

  it("stops waiting when nobody approved before the deadline, and can ask again", async () => {
    const timer = fakeTimer();
    let reads = 0;
    const { flow, calls } = await signedInAndRequesting({
      timer: timer.timer,
      route: (url, method) => {
        if (url.endsWith("/login")) return loginOk();
        if (url.endsWith("/hosts")) return hostsOk();
        if (method === "POST") return requestOk();
        reads += 1;
        return reads === 1 ? statusOk({ status: "pending" }) : statusOk({ status: "expired" });
      },
    });

    await timer.fire();
    expect(flow.getState().kind).toBe("requesting");

    // The Gateway itself says the request is over.
    await timer.fire();
    expect(flow.getState()).toEqual({ kind: "expired", hosts: ROSTER });
    expect(timer.delays()).toEqual([]);
    expect(statusCalls(calls)).toHaveLength(2);

    // "Ask again" is not a dead end: the same session authorises a new request.
    await flow.requestDevice();
    expect(flow.getState().kind).toBe("requesting");
  });

  it("ends the wait on its own deadline without reading the status again", async () => {
    const timer = fakeTimer();
    let now = START;
    const { flow, calls } = await signedInAndRequesting({
      timer: timer.timer,
      now: () => now,
      route: (url, method) => {
        if (url.endsWith("/login")) return loginOk();
        if (url.endsWith("/hosts")) return hostsOk();
        if (method === "POST") return requestOk();
        return statusOk({ status: "pending" });
      },
    });

    now = Date.parse(EXPIRES) + 1;
    await timer.fire();
    expect(flow.getState()).toEqual({ kind: "expired", hosts: ROSTER });
    expect(statusCalls(calls)).toEqual([]);
  });

  it("stops waiting on cancel, keeping the account session", async () => {
    const timer = fakeTimer();
    const { flow, calls } = await signedInAndRequesting({
      timer: timer.timer,
      route: (url, method) => {
        if (url.endsWith("/login")) return loginOk();
        if (url.endsWith("/hosts")) return hostsOk();
        if (method === "POST") return requestOk();
        return statusOk({ status: "pending" });
      },
    });

    flow.cancel();
    // Back to the roster, not to the AccessKey: cancelling is not signing out.
    expect(flow.getState()).toEqual({
      kind: "signed-in",
      accountId: "11",
      hosts: [
        { hostId: "host1", label: "desk", online: true },
        { hostId: "host2", label: "laptop", online: false },
      ],
    });
    expect(timer.delays()).toEqual([]);
    expect(logoutCalls(calls)).toEqual([]);
  });
});


describe("a Gateway that is not answering", () => {
  const failingRoute = (answer: () => Scripted) => (url: string, method: string): Scripted => {
    if (url.endsWith("/login")) return loginOk();
    if (url.endsWith("/hosts")) return hostsOk();
    if (method === "POST") return requestOk();
    return answer();
  };

  it("backs off, then gives up after a run of failed reads", async () => {
    const timer = fakeTimer();
    const { flow } = await signedInAndRequesting({
      timer: timer.timer,
      route: failingRoute(() => ({ status: 502, body: errorBody("INTERNAL", "the Gateway is restarting", true) })),
    });

    const delays: number[] = [];
    for (let attempt = 1; attempt <= POLL_MAX_FAILURES; attempt += 1) {
      delays.push(timer.delays()[0]!);
      await timer.fire();
    }

    expect(delays).toEqual([POLL_INTERVAL_MS, 4_000, 8_000, POLL_MAX_BACKOFF_MS, POLL_MAX_BACKOFF_MS, POLL_MAX_BACKOFF_MS, POLL_MAX_BACKOFF_MS, POLL_MAX_BACKOFF_MS]);
    expect(flow.getState()).toEqual({
      kind: "failed",
      failure: { code: "INTERNAL", message: "the Gateway is restarting", retriable: true },
    });
    expect(timer.delays()).toEqual([]);
  });

  it("waits exactly as long as a rate-limited Gateway asked", async () => {
    const timer = fakeTimer();
    let limited = true;
    const { flow } = await signedInAndRequesting({
      timer: timer.timer,
      route: failingRoute(() =>
        limited
          ? { status: 429, body: errorBody("RATE_LIMITED", "retry in 7000 ms", true), headers: { "retry-after": "7" } }
          : statusOk({ status: "pending" }),
      ),
    });

    await timer.fire();
    expect(timer.delays()).toEqual([7_000]);
    expect(flow.getState().kind).toBe("requesting");

    limited = false;
    await timer.fire();
    // A successful read clears the backoff: the next wait is the normal one.
    expect(timer.delays()).toEqual([POLL_INTERVAL_MS]);
  });

  it("reports a refused device request, then retries from the roster or revokes the session", async () => {
    const timer = fakeTimer();
    const { flow, calls } = await signedInAndRequesting({
      timer: timer.timer,
      route: (url, method) => {
        if (url.endsWith("/login")) return loginOk();
        if (url.endsWith("/hosts")) return hostsOk();
        if (url.endsWith("/logout")) return { status: 200, body: { result: { revoked: true } } };
        if (method === "POST") return { status: 409, body: errorBody("CONFLICT", "a request is already pending") };
        return statusOk({ status: "pending" });
      },
    });

    // `signedInAndRequesting` swallows the refusal: the state says what happened.
    expect(flow.getState()).toEqual({
      kind: "failed",
      failure: { code: "CONFLICT", message: "a request is already pending", retriable: false },
    });
    await flow.retry();
    expect(flow.getState().kind).toBe("signed-in");

    // Giving up revokes the session, and the next sign-in gets one of its own.
    await flow.abandon();
    expect(flow.getState()).toEqual({ kind: "idle" });
    expect(logoutCalls(calls)).toHaveLength(1);
  });

  it("revokes the session of a second sign-in too", async () => {
    const timer = fakeTimer();
    const { flow, calls } = await signedInAndRequesting({
      timer: timer.timer,
      route: (url, method) => {
        if (url.endsWith("/login")) return loginOk();
        if (url.endsWith("/hosts")) return hostsOk();
        if (url.endsWith("/logout")) return { status: 200, body: { result: { revoked: true } } };
        if (method === "POST") return requestOk();
        return statusOk({ status: "granted", deviceId: "dev_1", token: "pdt1.device", tokenDelivered: true });
      },
    });

    await flow.abandon();
    await flow.signIn("sk-gl-again");
    await flow.requestDevice();
    await timer.fire();

    expect(flow.getState()).toEqual({ kind: "adopted", hostIds: ["host1", "host2"] });
    expect(logoutCalls(calls)).toHaveLength(2);
  });

  it("drops a refused account session and returns to sign-in", async () => {
    const timer = fakeTimer();
    const { flow, calls } = await signedInAndRequesting({
      timer: timer.timer,
      route: (url, method) => {
        if (url.endsWith("/login")) return loginOk();
        if (url.endsWith("/hosts")) return hostsOk();
        if (url.endsWith("/logout")) return { status: 200, body: { result: { revoked: true } } };
        if (method === "POST") return requestOk();
        return { status: 401, body: errorBody("UNAUTHORIZED", "the session is gone") };
      },
    });

    await timer.fire();

    expect(flow.getState()).toEqual({
      kind: "failed",
      failure: { code: "UNAUTHORIZED", message: "the session is gone", retriable: false },
    });
    expect(timer.delays()).toEqual([]);
    // The session is dead, so "try again" means signing in again rather than
    // repeating a request the Gateway will refuse.
    await flow.retry();
    expect(flow.getState()).toEqual({ kind: "idle" });
    expect(logoutCalls(calls)).toEqual([]);
  });

  it("drops the pending poll and its listeners on dispose", async () => {
    const timer = fakeTimer();
    const { flow } = await signedInAndRequesting({
      timer: timer.timer,
      route: (url, method) => {
        if (url.endsWith("/login")) return loginOk();
        if (url.endsWith("/hosts")) return hostsOk();
        if (method === "POST") return requestOk();
        return statusOk({ status: "pending" });
      },
    });
    let notified = 0;
    flow.subscribe(() => {
      notified += 1;
    });

    flow.dispose();

    expect(timer.delays()).toEqual([]);
    flow.cancel();
    expect(notified).toBe(0);
  });
});

describe("push on sign-out (§11.6)", () => {
  const granted = () => statusOk({ status: "granted", deviceId: "dev_1", token: "pdt1.device", tokenDelivered: true });

  it("unregisters the account device when the account session ends", async () => {
    const timer = fakeTimer();
    const seen: Array<{ kind: string; token?: string }> = [];
    const { flow, signOuts } = await signedInAndRequesting({
      timer: timer.timer,
      onSignOut: async (credential) => {
        seen.push(credential.kind === "header" ? { kind: credential.kind, token: credential.token } : { kind: credential.kind });
      },
      route: (url, method) => {
        if (url.endsWith("/login")) return loginOk();
        if (url.endsWith("/hosts")) return hostsOk();
        if (url.endsWith("/logout")) return { status: 200, body: { result: { revoked: true } } };
        if (method === "POST") return requestOk();
        return granted();
      },
    });

    await timer.fire();
    expect(flow.getState()).toMatchObject({ kind: "adopted" });
    // Adopting ends the account session, and that is the moment the device
    // credential can still stop push: it is used exactly once.
    expect(seen).toEqual([{ kind: "header", token: "pdt1.device" }]);
    expect(signOuts).toHaveLength(1);
  });

  it("still ends the session when the unregistration fails", async () => {
    const timer = fakeTimer();
    const { flow, calls } = await signedInAndRequesting({
      timer: timer.timer,
      onSignOut: async () => {
        throw new Error("the gateway refused the DELETE");
      },
      route: (url, method) => {
        if (url.endsWith("/login")) return loginOk();
        if (url.endsWith("/hosts")) return hostsOk();
        if (url.endsWith("/logout")) return { status: 200, body: { result: { revoked: true } } };
        if (method === "POST") return requestOk();
        return granted();
      },
    });

    await timer.fire();
    // A failed unregistration is reported by the caller's log, never surfaced as
    // a failure of the adoption, and never leaves the session behind.
    expect(flow.getState()).toMatchObject({ kind: "adopted" });
    expect(logoutCalls(calls)).toHaveLength(1);
  });

  it("takes the registration away on a sign-out after adoption, once", async () => {
    const timer = fakeTimer();
    const signOuts: string[] = [];
    const { flow } = await signedInAndRequesting({
      timer: timer.timer,
      onSignOut: async (credential) => {
        signOuts.push(credential.kind === "header" ? credential.token : "cookie");
      },
      route: (url, method) => {
        if (url.endsWith("/login")) return loginOk();
        if (url.endsWith("/hosts")) return hostsOk();
        if (url.endsWith("/logout")) return { status: 200, body: { result: { revoked: true } } };
        if (method === "POST") return requestOk();
        return granted();
      },
    });

    await timer.fire();
    expect(flow.getState()).toMatchObject({ kind: "adopted" });
    expect(signOuts).toHaveLength(1);

    // Signing out after the device was adopted must not register a second
    // unregistration for the same device; it is one device, one DELETE.
    await flow.abandon();
    expect(flow.getState()).toEqual({ kind: "idle" });
    expect(signOuts).toHaveLength(1);
  });
});
