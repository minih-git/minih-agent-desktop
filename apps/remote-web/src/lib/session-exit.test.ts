import { describe, expect, it } from "vitest";

import { leaveRevokedSession } from "./session-exit.js";

/**
 * Bug B8: a revoked session offered nothing, because the route that reaches the
 * session screen never passed the "forget and pair again" handler. The rule that
 * handler encodes — leave first, then unregister, and report a failure instead of
 * swallowing it — is pinned here.
 */
describe("leaving a revoked session", () => {
  it("moves the user off the dead end before the unregistration resolves", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const forgotten = new Promise<void>((resolve) => {
      release = resolve;
    });

    const leaving = leaveRevokedSession({
      hostId: "host-1",
      forget: async (hostId) => {
        order.push(`forget:${hostId}`);
        await forgotten;
      },
      onLeft: () => order.push("left"),
    });

    // The screen has already moved while the network work is still pending.
    expect(order).toEqual(["left", "forget:host-1"]);
    release();
    expect(await leaving).toEqual({ ok: true });
  });

  it("reports the reason when the credential cannot be dropped", async () => {
    const outcome = await leaveRevokedSession({
      hostId: "host-1",
      forget: async () => {
        throw new Error("the store refused");
      },
      onLeft: () => {},
    });
    expect(outcome).toEqual({ ok: false, reason: "the store refused" });
  });

  it("reports a non-Error rejection as text rather than dropping it", async () => {
    const outcome = await leaveRevokedSession({
      hostId: "host-1",
      forget: () => Promise.reject("refused"),
      onLeft: () => {},
    });
    expect(outcome).toEqual({ ok: false, reason: "refused" });
  });
});