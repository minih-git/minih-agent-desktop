/**
 * Shared fixtures for the account device flow tests (protocol §11.5, rollout R7
 * package F): a scripted Gateway, a hand-driven timer, and the builders for the
 * login / host list / device request / device status answers.
 *
 * Nothing here waits on real time: the flow takes its clock and its timer from
 * the test, so the polling policy is asserted instead of waited out.
 */
import {
  AccountFlow,
  POLL_INTERVAL_MS,
  POLL_MAX_BACKOFF_MS,
  POLL_MAX_FAILURES,
  failureOf,
  pollDelayMs,
  remainingMs,
  rosterSummary,
  type AccountFlowState,
  type AccountTimer,
} from "./account-flow.js";
import type { AccountAdoption, AccountAdoptionOutcome, HostCredential } from "./credential-port.js";

export const ORIGIN = "https://gateway.example.com";
export const EXPIRES = "2026-10-18T00:05:00.000Z";
export const START = Date.parse("2026-10-18T00:00:00.000Z");

export type Scripted = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
export type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };

export function fakeFetch(route: (url: string, method: string) => Scripted) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url: String(url),
      method,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = route(String(url), method);
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export function errorBody(code: string, message: string, retriable = false): unknown {
  return { error: { code: -32000, message, data: { code, message, retriable, traceId: "t1" } } };
}

/** A timer the test drives by hand; nothing here waits on real time. */
export function fakeTimer() {
  let handle = 0;
  const scheduled = new Map<number, { callback: () => void; delayMs: number }>();
  const timer: AccountTimer = {
    set: (callback, delayMs) => {
      const id = (handle += 1);
      scheduled.set(id, { callback, delayMs });
      return id;
    },
    clear: (value) => {
      scheduled.delete(value as number);
    },
  };
  return {
    timer,
    /** The delays still waiting, oldest first. */
    delays: () => [...scheduled.values()].map((entry) => entry.delayMs),
    async fire(): Promise<void> {
      const [id, next] = [...scheduled.entries()][0] ?? [];
      if (id === undefined || !next) throw new Error("the flow scheduled no further poll");
      scheduled.delete(id);
      next.callback();
      await flush();
    },
  };
}

/** Let every pending microtask and the awaited `fetch` settle. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export const ROSTER = [
  { hostId: "host1", label: "desk", online: true, canConfirm: true, willAcceptGrant: true },
  { hostId: "host2", label: "laptop", online: false, canConfirm: false, willAcceptGrant: false },
];

export function loginOk(csrfToken = "csrf-account"): Scripted {
  return { status: 200, body: { result: { accountId: "11", expiresAt: "2026-10-18T12:00:00.000Z", csrfToken } } };
}

export function hostsOk(hosts = ROSTER.map((host) => ({ hostId: host.hostId, label: host.label, online: host.online }))): Scripted {
  return { status: 200, body: { result: { accountId: "11", hosts } } };
}

export function requestOk(hosts = ROSTER): Scripted {
  return { status: 200, body: { result: { requestId: "dreq_1", expiresAt: EXPIRES, hosts } } };
}

export function statusOk(result: Record<string, unknown>): Scripted {
  return { status: 200, body: { result: { requestId: "dreq_1", expiresAt: EXPIRES, hosts: ROSTER, ...result } } };
}

export function flowFor(options: {
  fetchImpl: typeof fetch;
  timer?: AccountTimer;
  adopt?: (input: AccountAdoption) => Promise<AccountAdoptionOutcome>;
  onSignOut?: (credential: HostCredential) => Promise<void>;
  now?: () => number;
}) {
  const adoptions: AccountAdoption[] = [];
  const signOuts: HostCredential[] = [];
  const flow = new AccountFlow({
    gatewayOrigin: ORIGIN,
    client: "web",
    deviceLabel: () => "iPad",
    adopt: async (input) => {
      adoptions.push(input);
      return options.adopt ? options.adopt(input) : { ok: true, hostIds: input.hosts.map((host) => host.hostId) };
    },
    // Push unregistration on sign-out (§11.6) is recorded, and can be made to
    // fail: a failed unregistration must not block signing out.
    onSignOut: async (credential) => {
      signOuts.push(credential);
      await options.onSignOut?.(credential);
    },
    fetchImpl: options.fetchImpl,
    ...(options.timer ? { timer: options.timer } : {}),
    // Pinned so the deadline of a request is measured against the same instant
    // in every run; only the test that ends a wait by the clock overrides it.
    now: options.now ?? (() => START),
  });
  return { flow, adoptions, signOuts };
}

export function statusCalls(calls: readonly Call[]): Call[] {
  return calls.filter((call) => call.url.includes("/v1/account/devices/"));
}

export function logoutCalls(calls: readonly Call[]): Call[] {
  return calls.filter((call) => call.url.endsWith("/v1/account/logout"));
}

/** Sign in and ask for a device; returns with the first poll already scheduled. */
export async function signedInAndRequesting(
  options: Omit<Parameters<typeof flowFor>[0], "fetchImpl"> & { route: (url: string, method: string) => Scripted },
) {
  const gateway = fakeFetch(options.route);
  const built = flowFor({ ...options, fetchImpl: gateway.fetchImpl });
  await built.flow.signIn("sk-gl-sentinel");
  await built.flow.requestDevice();
  return { ...built, ...gateway };
}
