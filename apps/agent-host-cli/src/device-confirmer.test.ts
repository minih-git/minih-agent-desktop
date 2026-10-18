import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RacpDeviceRequest } from "@minih-agent/shared";

import {
  sendDeviceDecision,
  sendDeviceRevoke,
  sendDevicesPending,
  startAdminSocket,
  type AdminDevicePort,
  type AdminSocket,
} from "./admin-socket.js";
import { AdminDeviceConfirmer } from "./device-confirmer.js";

/**
 * The `agent-host-cli` half of the account-mode device flow (protocol §11.5,
 * D666 / rollout R7 package D): the local user answers a `device.request`
 * through the owner-only admin socket, and the revocation path announces the
 * decision on the Host link.
 */

const initialCwd = process.cwd();
const directories: string[] = [];
const servers: AdminSocket[] = [];

beforeAll(() => {
  process.chdir(process.env.PI_SCRATCH_DIR ?? tmpdir());
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
afterAll(() => {
  process.chdir(initialCwd);
});

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), "device-confirm-"));
  directories.push(dir);
  return dir;
}

function request(overrides: Partial<RacpDeviceRequest> = {}): RacpDeviceRequest {
  return {
    requestId: "dreq_1",
    accountId: "42",
    deviceLabel: "iPad",
    client: "ios",
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe("admin device confirmer", () => {
  it("asks the local user and settles on their decision", async () => {
    const logs: string[] = [];
    const confirmer = new AdminDeviceConfirmer((_level, message) => logs.push(message));

    const answer = confirmer.confirm(request());
    expect(confirmer.pending()).toEqual([
      { requestId: "dreq_1", deviceLabel: "iPad", client: "ios", requestedAt: expect.any(String), expiresAt: expect.any(String) },
    ]);

    expect(confirmer.decide("dreq_1", "approved")).toBe(true);
    expect(await answer).toBe("approved");
    expect(confirmer.pending()).toEqual([]);
    // An already answered request cannot be answered twice.
    expect(confirmer.decide("dreq_1", "denied")).toBe(false);
    expect(confirmer.decide("dreq_unknown", "denied")).toBe(false);
    expect(logs).toContain("device request waiting for a local decision");
  });

  it("denies a request nobody answers before it expires", async () => {
    const confirmer = new AdminDeviceConfirmer(() => undefined);
    const answer = confirmer.confirm(request({ expiresAt: new Date(Date.now() + 20).toISOString() }));
    expect(await answer).toBe("denied");
    expect(confirmer.pending()).toEqual([]);
  });

  it("denies everything still waiting when the Host stops", async () => {
    const confirmer = new AdminDeviceConfirmer(() => undefined);
    const first = confirmer.confirm(request({ requestId: "dreq_a" }));
    const second = confirmer.confirm(request({ requestId: "dreq_b" }));

    confirmer.close();

    expect(await first).toBe("denied");
    expect(await second).toBe("denied");
    expect(confirmer.pending()).toEqual([]);
  });

  it("keeps each request independent", async () => {
    const confirmer = new AdminDeviceConfirmer(() => undefined);
    const first = confirmer.confirm(request({ requestId: "dreq_a", deviceLabel: "iPhone" }));
    const second = confirmer.confirm(request({ requestId: "dreq_b", deviceLabel: "Mac" }));

    expect(confirmer.pending().map((pending) => pending.deviceLabel)).toEqual(["iPhone", "Mac"]);
    confirmer.decide("dreq_b", "approved");

    expect(await second).toBe("approved");
    expect(confirmer.pending().map((pending) => pending.requestId)).toEqual(["dreq_a"]);
    confirmer.decide("dreq_a", "denied");
    expect(await first).toBe("denied");
  });
});

describe("admin socket device operations", () => {
  async function socketWithDevices(devices: AdminDevicePort): Promise<string> {
    const dataDir = await directory();
    servers.push(await startAdminSocket({ dataDir, getHost: () => null, devices, log: () => undefined }));
    return dataDir;
  }

  it("lists the pending requests and answers one over the socket", async () => {
    const confirmer = new AdminDeviceConfirmer(() => undefined);
    const dataDir = await socketWithDevices({
      pending: () => confirmer.pending(),
      decide: (requestId, decision) => confirmer.decide(requestId, decision === "approve" ? "approved" : "denied"),
      revoke: async () => ({ revoked: true, announced: true }),
    });

    const answer = confirmer.confirm(request());
    const listing = await sendDevicesPending(dataDir);
    expect(listing.ok).toBe(true);
    expect(listing.ok ? listing.devices.map((pending) => pending.requestId) : []).toEqual(["dreq_1"]);

    const decided = await sendDeviceDecision(dataDir, "dreq_1", "approve");
    expect(decided).toEqual({ ok: true, decided: { requestId: "dreq_1", decision: "approve" } });
    expect(await answer).toBe("approved");

    // An unknown request id is refused, not silently accepted.
    expect(await sendDeviceDecision(dataDir, "dreq_gone", "deny")).toEqual({ ok: false, code: "INVALID_REQUEST" });
    expect(await sendDevicesPending(dataDir)).toEqual({ ok: true, devices: [] });
  });

  it("revokes a device through the socket, and never reports a queued frame as announced", async () => {
    const revoked: string[] = [];
    let announced = true;
    const dataDir = await socketWithDevices({
      pending: () => [],
      decide: () => false,
      revoke: async (deviceId) => {
        revoked.push(deviceId);
        return deviceId.startsWith("dev_") ? { revoked: true, announced } : { revoked: false, announced: false };
      },
    });

    expect(await sendDeviceRevoke(dataDir, "dev_1")).toEqual({ ok: true, revoked: { deviceId: "dev_1", announced: true } });
    expect(revoked).toEqual(["dev_1"]);

    // The link went down, so the frame is queued for the next one. The caller
    // must be told that, not told the account has been notified.
    announced = false;
    expect(await sendDeviceRevoke(dataDir, "dev_2")).toEqual({ ok: true, revoked: { deviceId: "dev_2", announced: false } });

    expect(await sendDeviceRevoke(dataDir, "unknown")).toEqual({ ok: false, code: "INVALID_REQUEST" });
  });

  it("answers ADMIN_UNAVAILABLE when this Host has no device surface", async () => {
    const dataDir = await directory();
    servers.push(await startAdminSocket({ dataDir, getHost: () => null, log: () => undefined }));

    expect(await sendDevicesPending(dataDir)).toEqual({ ok: false, code: "ADMIN_UNAVAILABLE" });
    expect(await sendDeviceDecision(dataDir, "dreq_1", "approve")).toEqual({ ok: false, code: "ADMIN_UNAVAILABLE" });
    expect(await sendDeviceRevoke(dataDir, "dev_1")).toEqual({ ok: false, code: "ADMIN_UNAVAILABLE" });
  });
});
