import { describe, expect, it } from "vitest";
import { DeviceTokenAuthenticator, GATEWAY_PAIR_ROLES, MemoryCredentialStore, hashToken } from "./auth.js";
import { replaceDeviceInstallation } from "./device-installations.js";

const INSTALLATION = "11111111-1111-4111-8111-111111111111";

describe("per-Host installation pairing", () => {
  it("requires another single-use code, then replaces only this installation's ticket credential", async () => {
    const store = new MemoryCredentialStore();
    let now = Date.parse("2026-11-01T00:00:00Z");
    const auth = new DeviceTokenAuthenticator(store, () => now);
    const pair = async (id?: string) => {
      now += 1000;
      const code = await auth.issuePairingToken(60_000, "gateway");
      return auth.pair(hashToken(code.token), "iOS app", [...GATEWAY_PAIR_ROLES], "gateway", id);
    };
    const legacy = await pair();
    const first = await pair(INSTALLATION);
    const other = await pair("22222222-2222-4222-8222-222222222222");
    const replacement = await pair(INSTALLATION);
    const authenticate = (token: string) => auth.authenticate({ authorization: `Bearer ${token}`, connectionId: "test", origin: "gateway" });
    expect(await authenticate(first.token)).toBeNull();
    expect(await authenticate(legacy.token)).not.toBeNull();
    expect(await authenticate(other.token)).not.toBeNull();
    expect(await authenticate(replacement.token)).not.toBeNull();
    expect((await store.listDevices()).filter((record) => !record.revokedAt)).toHaveLength(3);
    await expect(auth.pair("unknown", "iOS app", [...GATEWAY_PAIR_ROLES], "gateway", INSTALLATION)).rejects.toThrow(/unknown/);
    expect(await authenticate(replacement.token)).not.toBeNull();
  });

  it("does not match a ticket credential to an account credential with the same installation id", async () => {
    const store = new MemoryCredentialStore();
    const old = { deviceId: "ticket", label: "iOS app", roles: [] as [], tokenHash: "a".repeat(64), origin: "gateway" as const,
      installationId: INSTALLATION, createdAt: "2026-11-01T00:00:00Z" };
    await store.saveDevice(old);
    const account = { ...old, deviceId: "account", accountId: "42", createdAt: "2026-11-01T00:01:00Z" };
    await store.saveDevice(account);
    expect(await replaceDeviceInstallation(store, account, account.createdAt)).toEqual([]);
    expect((await store.listDevices()).every((record) => !record.revokedAt)).toBe(true);
  });
});
