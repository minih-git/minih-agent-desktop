import { describe, expect, it } from "vitest";

import { HostLinkNotifier } from "./host-notifier.js";

/**
 * The Host's link-bound notifier (protocol §11.6, R5 PR-6, ADR 0331 decision 7).
 *
 * What matters here is the boundary, not the plumbing: a notification is ids
 * and one of four fixed kinds, it goes out only while a link is up, and it is
 * never queued — a buzz about an approval the user already answered is worse
 * than no buzz.
 */
function notifier() {
  const sent: Array<Record<string, unknown>> = [];
  let counter = 0;
  const instance = new HostLinkNotifier({
    now: () => Date.parse("2026-10-18T00:00:00.000Z"),
    newId: () => `ntf_${(counter += 1)}`,
  });
  return { instance, sent, attach: () => instance.attach((notify) => sent.push(notify as unknown as Record<string, unknown>)) };
}

describe("HostLinkNotifier", () => {
  it("reports the four notification-worthy kinds with ids only", () => {
    const { instance, sent, attach } = notifier();
    attach();

    expect(instance.notify({ kind: "approval.requested", sessionId: "s1", approvalId: "ap_1" })).toBe(true);
    expect(instance.notify({ kind: "input.requested", sessionId: "s1", approvalId: "in_1" })).toBe(true);
    expect(instance.notify({ kind: "turn.completed", sessionId: "s1" })).toBe(true);
    expect(instance.notify({ kind: "turn.failed", sessionId: "s2" })).toBe(true);

    expect(sent).toEqual([
      { notifyId: "ntf_1", kind: "approval.requested", sessionId: "s1", approvalId: "ap_1", occurredAt: "2026-10-18T00:00:00.000Z" },
      { notifyId: "ntf_2", kind: "input.requested", sessionId: "s1", approvalId: "in_1", occurredAt: "2026-10-18T00:00:00.000Z" },
      { notifyId: "ntf_3", kind: "turn.completed", sessionId: "s1", occurredAt: "2026-10-18T00:00:00.000Z" },
      { notifyId: "ntf_4", kind: "turn.failed", sessionId: "s2", occurredAt: "2026-10-18T00:00:00.000Z" },
    ]);
    // The frame is the whole payload: no content field exists to fill in.
    for (const notify of sent) {
      expect(Object.keys(notify).sort()).toEqual(
        notify["approvalId"]
          ? ["approvalId", "kind", "notifyId", "occurredAt", "sessionId"]
          : ["kind", "notifyId", "occurredAt", "sessionId"],
      );
    }
  });

  it("says it sent nothing while no link is attached, and queues nothing", () => {
    const { instance, sent, attach } = notifier();
    expect(instance.attached).toBe(false);
    expect(instance.notify({ kind: "turn.completed", sessionId: "s1" })).toBe(false);
    expect(sent).toEqual([]);

    attach();
    expect(instance.notify({ kind: "turn.completed", sessionId: "s1" })).toBe(true);
    instance.detach();
    // The link is gone: the event is not buffered for a reconnect, because it
    // describes something the user could already be looking at.
    expect(instance.notify({ kind: "turn.completed", sessionId: "s1" })).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("never lets a listener failure reach the turn that caused it", () => {
    const logs: string[] = [];
    const instance = new HostLinkNotifier({ log: (_level, message) => logs.push(message) });
    instance.attach(() => {
      throw new Error("the socket exploded");
    });
    expect(instance.notify({ kind: "turn.failed", sessionId: "s1" })).toBe(false);
    expect(logs).toContain("host notifier could not send");
  });

  it("drops a kind that is not one of the four", () => {
    const logs: string[] = [];
    const instance = new HostLinkNotifier({ log: (_level, message) => logs.push(message) });
    const sent: unknown[] = [];
    instance.attach((notify) => sent.push(notify));
    // The type system already refuses this; a caller that bypasses it must not
    // teach the Gateway a fifth kind.
    expect(instance.notify({ kind: "turn.started" as never, sessionId: "s1" })).toBe(false);
    expect(sent).toEqual([]);
    expect(logs).toContain("host notifier ignored an unknown notification kind");
  });
});
