import { describe, expect, it } from "vitest";

import type { HostRegistryEntry } from "./host-registry.js";
import {
  attachPushListeners,
  destinationForTap,
  enablePush,
  obtainPushToken,
  registerPushToken,
  unregisterPushToken,
  type PushPlugin,
} from "./push.js";
import { pushAccounts, registerAccounts, registrationKey, unregisterDevice } from "./push-registration.js";

/**
 * The native push client (protocol §11.6, R5 PR-6).
 *
 * Two things are worth pinning down without a device: the provider token goes to
 * the Gateway exactly once and is never stored by this client, and a tap
 * resolves a screen from ids only — the payload's text is a localization key
 * this app resolves itself, so a notification can never inject a label.
 */
const ORIGIN = "https://gateway.example.com";
const TOKEN = "pdt1.device";
const HEADER = { kind: "header" as const, token: TOKEN };

function recording() {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const answers: Array<{ status: number; body: unknown }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null,
    });
    const next = answers.shift() ?? { status: 200, body: { result: { enabled: true, platform: "ios", hostIds: ["host1"] } } };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, answers, fetchImpl };
}

function entry(hostId: string, deviceId: string): HostRegistryEntry {
  return { hostId, label: hostId, deviceId, pairedAt: "2026-10-18T00:00:00.000Z", profile: "native" };
}

describe("registerPushToken", () => {
  it("sends the provider token in the body, with the device credential", async () => {
    const { calls, fetchImpl } = recording();
    const result = await registerPushToken(
      { gatewayOrigin: ORIGIN, credential: HEADER, fetchImpl },
      { platform: "ios", token: "apns-token" },
    );

    expect(result).toEqual({ ok: true, hostIds: ["host1"] });
    expect(calls[0]!.url).toBe(`${ORIGIN}/v1/push/registration`);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body).toEqual({ platform: "ios", token: "apns-token" });
  });

  it("carries the 'only things that need me' preference, and omits it when unset", async () => {
    const { calls, fetchImpl } = recording();
    await registerPushToken(
      { gatewayOrigin: ORIGIN, credential: HEADER, fetchImpl },
      { platform: "ios", token: "apns-token", onlyActionable: true },
    );
    expect(calls[0]!.body).toEqual({ platform: "ios", token: "apns-token", onlyActionable: true });

    // Absent means "ask for nothing in particular": the Gateway keeps its stored
    // preference, and a Gateway without the field behaves exactly as before.
    const second = recording();
    await registerPushToken({ gatewayOrigin: ORIGIN, credential: HEADER, fetchImpl: second.fetchImpl }, { platform: "ios", token: "apns-token" });
    expect(second.calls[0]!.body).toEqual({ platform: "ios", token: "apns-token" });
  });

  it("sends the CSRF value instead of a bearer token for the cookie profile", async () => {
    const { calls, fetchImpl } = recording();
    await registerPushToken(
      { gatewayOrigin: ORIGIN, credential: { kind: "cookie", csrfToken: "csrf-1" }, fetchImpl },
      { platform: "android", token: "fcm-token" },
    );
    expect(calls[0]!.headers["x-csrf-token"]).toBe("csrf-1");
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("reports a Gateway that does not push, so the client stops asking", async () => {
    const { answers, fetchImpl } = recording();
    answers.push({ status: 200, body: { result: { enabled: false, platform: "ios", hostIds: [] } } });
    expect(
      await registerPushToken({ gatewayOrigin: ORIGIN, credential: HEADER, fetchImpl }, { platform: "ios", token: "x" }),
    ).toEqual({
      ok: true,
      disabled: true,
    });
  });

  it("reports a refused or unreachable registration without throwing", async () => {
    const { answers, fetchImpl } = recording();
    answers.push({ status: 401, body: { error: { message: "unknown device" } } });
    expect(
      await registerPushToken({ gatewayOrigin: ORIGIN, credential: HEADER, fetchImpl }, { platform: "ios", token: "x" }),
    ).toEqual({ ok: false, reason: "request-failed", message: "HTTP 401" });

    const failing = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(
      await registerPushToken({ gatewayOrigin: ORIGIN, credential: HEADER, fetchImpl: failing }, { platform: "ios", token: "x" }),
    ).toEqual({ ok: false, reason: "request-failed", message: "offline" });
  });
});

describe("unregisterPushToken", () => {
  it("sends DELETE with the same credential", async () => {
    const { calls, fetchImpl } = recording();
    expect(await unregisterPushToken({ gatewayOrigin: ORIGIN, credential: HEADER, fetchImpl })).toBe(true);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("answers false instead of throwing when the Gateway cannot be reached", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await unregisterPushToken({ gatewayOrigin: ORIGIN, credential: HEADER, fetchImpl: failing })).toBe(false);
  });
});

describe("pushAccounts", () => {
  it("registers once per account device and once per §11.4 device", () => {
    // Two Hosts of one account share a device id; a third Host was paired on its
    // own. The first two collapse, the third does not.
    const hosts = [entry("host_a", "dev_account"), entry("host_b", "dev_account"), entry("host_c", "dev_pair_c")];
    const accounts = pushAccounts(hosts, () => HEADER);
    expect(accounts.map((account) => account.deviceId)).toEqual(["dev_account", "dev_pair_c"]);
    expect(accounts[0]!.hostIds).toEqual(["host_a", "host_b"]);
    expect(accounts[1]!.hostIds).toEqual(["host_c"]);
    // The key carries the audience, not just the device: forgetting a Host has
    // to change it so the registration is written again.
    expect(registrationKey(accounts[0]!)).toBe("dev_account:host_a+host_b");
    expect(registrationKey(accounts[1]!)).toBe("dev_pair_c:host_c");
  });

  it("skips a Host with no credential: there is nothing to authorize with", () => {
    const hosts = [entry("host_a", "dev_a"), entry("host_b", "dev_b")];
    const accounts = pushAccounts(hosts, (hostId) => (hostId === "host_b" ? HEADER : null));
    expect(accounts.map((account) => account.deviceId)).toEqual(["dev_b"]);
  });
});

describe("registerAccounts", () => {
  it("writes one registration per device, and remembers what it did", async () => {
    const { calls, fetchImpl } = recording();
    const hosts = [entry("host_a", "dev_a"), entry("host_b", "dev_b")];
    const registered = new Set<string>();
    const accounts = pushAccounts(hosts, () => HEADER);

    const first = await registerAccounts(accounts, { platform: "ios", token: "apns" }, { gatewayOrigin: ORIGIN, fetchImpl }, registered);
    expect(first.registered).toEqual(["dev_a", "dev_b"]);
    expect(calls).toHaveLength(2);

    // A re-render with the same credentials sends nothing new.
    const second = await registerAccounts(accounts, { platform: "ios", token: "apns" }, { gatewayOrigin: ORIGIN, fetchImpl }, registered);
    expect(second.registered).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("stops at a Gateway that does not push, instead of registering the rest", async () => {
    const { answers, calls, fetchImpl } = recording();
    answers.push({ status: 200, body: { result: { enabled: false, platform: "ios", hostIds: [] } } });
    const accounts = pushAccounts([entry("host_a", "dev_a"), entry("host_b", "dev_b")], () => HEADER);
    const outcome = await registerAccounts(
      accounts,
      { platform: "ios", token: "apns" },
      { gatewayOrigin: ORIGIN, fetchImpl },
      new Set(),
    );
    expect(outcome.disabled).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("keeps going when one credential is refused, and does not record it", async () => {
    const { answers, fetchImpl } = recording();
    answers.push({ status: 401, body: { error: { message: "revoked" } } });
    const registered = new Set<string>();
    const outcome = await registerAccounts(
      pushAccounts([entry("host_a", "dev_a"), entry("host_b", "dev_b")], () => HEADER),
      { platform: "ios", token: "apns" },
      { gatewayOrigin: ORIGIN, fetchImpl },
      registered,
    );
    expect(outcome.registered).toEqual(["dev_b"]);
    expect([...registered]).toEqual(["dev_b:host_b"]);
  });
});

describe("unregisterDevice", () => {
  it("reports a failed DELETE instead of swallowing it", async () => {
    const failures: unknown[] = [];
    const removed = await unregisterDevice(entry("host_a", "dev_a"), {
      credential: HEADER,
      gatewayOrigin: ORIGIN,
      fetchImpl: (async () => new Response("{}", { status: 404 })) as typeof fetch,
      onFailure: (error) => failures.push(error),
    });
    expect(removed).toBe(false);
    expect(failures).toHaveLength(1);
  });

  it("does nothing without a credential: the Gateway can no longer be told", async () => {
    const calls: string[] = [];
    const removed = await unregisterDevice(entry("host_a", "dev_a"), {
      credential: null,
      gatewayOrigin: ORIGIN,
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
      onFailure: () => undefined,
    });
    expect(removed).toBe(false);
    expect(calls).toEqual([]);
  });
});

function fakePlugin(token: string | null): PushPlugin & { listeners(): number; permissionRequests: number } {
  let listeners = 0;
  const state = { permissionRequests: 0 };
  const handle = async () => {
    listeners -= 1;
  };
  return {
    listeners: () => listeners,
    get permissionRequests() {
      return state.permissionRequests;
    },
    async requestPermissions() {
      state.permissionRequests += 1;
      return { receive: "granted" };
    },
    async register() {
      // The token arrives asynchronously, as iOS does it.
      setTimeout(() => undefined, 0);
    },
    addListener: (async (event: string, handler: (value: never) => void) => {
      listeners += 1;
      if (event === "registration" && token) setTimeout(() => handler({ value: token } as never), 0);
      return { remove: handle };
    }) as PushPlugin["addListener"],
  };
}

describe("obtainPushToken", () => {
  it("removes the listeners it added once the token arrives", async () => {
    const plugin = fakePlugin("apns-token");
    expect(await obtainPushToken(plugin)).toEqual({ ok: true, token: "apns-token" });
    expect(plugin.listeners()).toBe(0);
    expect(plugin.permissionRequests).toBe(1);
  });

  it("asks no permission twice, and still removes its listeners", async () => {
    const plugin = fakePlugin("apns-token");
    expect(await obtainPushToken(plugin, { skipPermissionRequest: true })).toEqual({ ok: true, token: "apns-token" });
    expect(plugin.permissionRequests).toBe(0);
    expect(plugin.listeners()).toBe(0);
  });

  it("removes a listener handle that only arrives after the call returned", async () => {
    let added = 0;
    let removed = 0;
    const plugin: PushPlugin = {
      async requestPermissions() {
        return { receive: "granted" };
      },
      async register() {
        // The token never arrives, so the deadline ends the wait first.
      },
      addListener: (async (event: string) => {
        added += 1;
        // The handle lands on a later tick than the call that asked for it.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          remove: async () => {
            removed += 1;
            if (event === "registration") throw new Error("already gone");
          },
        };
      }) as PushPlugin["addListener"],
    };
    expect(await obtainPushToken(plugin, { timeoutMs: 1, skipPermissionRequest: true })).toEqual({
      ok: false,
      reason: "no-token",
    });
    // Wait for the late handles, then check every one of them was removed.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(added).toBe(2);
    expect(removed).toBe(2);
  });

  it("turns a rejected listener registration into a reported failure, not an unhandled rejection", async () => {
    const plugin: PushPlugin = {
      async requestPermissions() {
        return { receive: "granted" };
      },
      async register() {
        // Nothing happens; the deadline decides.
      },
      addListener: (async () => {
        throw new Error("the plugin refused the listener");
      }) as PushPlugin["addListener"],
    };
    expect(await obtainPushToken(plugin, { timeoutMs: 20, skipPermissionRequest: true })).toEqual({
      ok: false,
      reason: "no-token",
    });
  });

  it("reports a denied permission without asking the platform for a token", async () => {
    const plugin: PushPlugin = {
      ...fakePlugin(null),
      requestPermissions: async () => ({ receive: "denied" }),
    };
    expect(await obtainPushToken(plugin)).toEqual({ ok: false, reason: "permission" });
  });
});

describe("enablePush", () => {
  it("registers the token the plugin reported", async () => {
    const { calls, fetchImpl } = recording();
    const result = await enablePush(fakePlugin("apns-token"), { gatewayOrigin: ORIGIN, credential: HEADER, fetchImpl }, {
      platform: "ios",
    });
    expect(result).toEqual({ ok: true, hostIds: ["host1"] });
    expect(calls[0]!.body).toEqual({ platform: "ios", token: "apns-token" });
  });

  it("maps a missing token to a reported failure rather than a request", async () => {
    const { calls, fetchImpl } = recording();
    const result = await enablePush(fakePlugin(null), { gatewayOrigin: ORIGIN, credential: HEADER, fetchImpl }, {
      platform: "ios",
      timeoutMs: 5,
    });
    expect(result).toEqual({ ok: false, reason: "no-token" });
    expect(calls).toEqual([]);
  });
});

describe("destinationForTap", () => {
  it("resolves a session screen from ids, and ignores anything that is not an id", () => {
    expect(destinationForTap({ hostId: "host_a", sessionId: "s1", approvalId: "ap_1", titleKey: "ignored" })).toEqual({
      kind: "session",
      hostId: "host_a",
      sessionId: "s1",
      approvalId: "ap_1",
    });
    expect(destinationForTap({ hostId: "host_a" })).toEqual({ kind: "hosts" });
    expect(destinationForTap(null)).toEqual({ kind: "hosts" });
    expect(destinationForTap({ hostId: "", sessionId: "s1" })).toEqual({ kind: "hosts" });
  });
});

describe("attachPushListeners", () => {
  it("removes every listener on dispose, so a sign-out leaves none behind", async () => {
    const plugin = fakePlugin(null);
    const taps: unknown[] = [];
    const dispose = await attachPushListeners(plugin, { onToken: () => undefined, onTap: (tap) => taps.push(tap) });
    // registration, registrationError, the tap, and the foreground event (§17.6.4).
    expect(plugin.listeners()).toBe(4);
    await dispose();
    expect(plugin.listeners()).toBe(0);
    expect(taps).toEqual([]);
  });
});

describe("registration lifecycle", () => {
  it("registers a §11.4 phone paired with three Hosts three times, and an account device once", async () => {
    // A phone can hold both: an account device covering two Hosts, and a Host it
    // was paired with on its own. Only the account device may collapse.
    const hosts = [
      entry("host_a", "dev_account"),
      entry("host_b", "dev_account"),
      entry("host_c", "dev_pair_c"),
    ];
    const { calls, fetchImpl } = recording();
    const outcome = await registerAccounts(
      pushAccounts(hosts, () => HEADER),
      { platform: "ios", token: "apns" },
      { gatewayOrigin: ORIGIN, fetchImpl },
      new Set(),
    );
    expect(outcome.registered).toEqual(["dev_account", "dev_pair_c"]);
    // Two registrations, not three: the shared account token is registered once.
    expect(calls).toHaveLength(2);
    // Each carries the same provider token; the audience is the Gateway's to decide.
    expect(calls.map((call) => (call.body as { token: string }).token)).toEqual(["apns", "apns"]);
  });

  it("re-registers when a new credential appears, and not for one already done", async () => {
    const { calls, fetchImpl } = recording();
    const registered = new Set<string>();
    const transport = { gatewayOrigin: ORIGIN, fetchImpl };
    const input = { platform: "ios" as const, token: "apns" };

    await registerAccounts(pushAccounts([entry("host_a", "dev_a")], () => HEADER), input, transport, registered);
    expect(calls).toHaveLength(1);

    // The user pairs a second Host later: only that new device is registered.
    await registerAccounts(
      pushAccounts([entry("host_a", "dev_a"), entry("host_b", "dev_b")], () => HEADER),
      input,
      transport,
      registered,
    );
    expect(calls).toHaveLength(2);
    expect([...registered].sort()).toEqual(["dev_a:host_a", "dev_b:host_b"]);
  });

  it("registers again when a Host is forgotten, so the audience shrinks", async () => {
    const { calls, fetchImpl } = recording();
    const registered = new Set<string>();
    const transport = { gatewayOrigin: ORIGIN, fetchImpl };
    const input = { platform: "ios" as const, token: "apns" };

    await registerAccounts(
      pushAccounts([entry("host_a", "dev_account"), entry("host_b", "dev_account")], () => HEADER),
      input,
      transport,
      registered,
    );
    expect(calls).toHaveLength(1);
    expect([...registered]).toEqual(["dev_account:host_a+host_b"]);

    // The user forgets `host_b`. The device id is unchanged, but the audience is
    // not: the Gateway keeps a registration until it is written again.
    await registerAccounts(
      pushAccounts([entry("host_a", "dev_account")], () => HEADER),
      input,
      transport,
      registered,
    );
    expect(calls).toHaveLength(2);
    expect([...registered]).toEqual(["dev_account:host_a"]);
  });
});
