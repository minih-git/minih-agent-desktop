import { describe, expect, it } from "vitest";

import { RACP_HOST_CAPABILITIES, RACP_HOSTLINK_VERSION, type RacpHostLinkFrame, type RacpHostNotify } from "@minih-agent/shared";

import { HostLinkNotifier } from "./host-notifier.js";
import { HostLinkGatewayMux, createHostLinkHost, type HostLinkSocket } from "./hostlink.js";
import { flush, harness, type Harness } from "./test-harness.js";

/**
 * Compatibility of the redacted-push frame with the two sides it must not break
 * (protocol §11.4 rule 6, §11.6, R5 PR-6):
 *
 * - an older **Host** never sends `host.notify`: it advertises no `push.notify`,
 *   and the Gateway has nothing to do;
 * - an older **Gateway** that does not know the frame drops it and keeps the
 *   link, exactly like any other unknown frame type.
 */
class ScriptedSocket implements HostLinkSocket {
  readonly sent: RacpHostLinkFrame[] = [];
  open = true;
  private messageHandler: ((frame: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  send(frame: string): boolean {
    if (!this.open) return false;
    this.sent.push(JSON.parse(frame) as RacpHostLinkFrame);
    return true;
  }

  close(): void {
    this.open = false;
    this.closeHandler?.();
  }

  onMessage(handler: (frame: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  onError(): void {
    // No transport error is simulated.
  }

  feed(frame: unknown): void {
    this.messageHandler?.(JSON.stringify(frame));
  }

  framesOfType(type: RacpHostLinkFrame["type"]): RacpHostLinkFrame[] {
    return this.sent.filter((frame) => frame.type === type);
  }
}

function notify(overrides: Partial<RacpHostNotify> = {}): RacpHostNotify {
  return {
    notifyId: "ntf_1",
    kind: "turn.completed",
    sessionId: "s1",
    occurredAt: "2026-10-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("host.notify compatibility", () => {
  let h: Harness;
  let socket: ScriptedSocket;

  async function setup() {
    h = await harness();
    socket = new ScriptedSocket();
  }

  function openHost(notifier: HostLinkNotifier | null) {
    return createHostLinkHost({
      server: h.server,
      authenticator: h.authenticator,
      hostId: "host_push",
      log: () => undefined,
      now: () => Date.parse("2026-10-18T00:00:00.000Z"),
      ...(notifier ? { notifier } : {}),
      socket,
    });
  }

  it("announces push.notify when the Host has a notifier", async () => {
    await setup();
    const notifier = new HostLinkNotifier();
    openHost(notifier);

    const capabilities = socket.framesOfType("host.capabilities");
    expect(capabilities).toHaveLength(1);
    expect((capabilities[0] as { capabilities: string[] }).capabilities).toContain(RACP_HOST_CAPABILITIES.pushNotify);

    // The link attached its own sender above; re-attaching here would replace it
    // with a no-op and prove nothing.
    expect(notifier.attached).toBe(true);
    notifier.notify({ kind: "approval.requested", sessionId: "s1", approvalId: "ap_1" });
    const frames = socket.framesOfType("host.notify");
    expect(frames).toHaveLength(1);
    expect((frames[0] as { notify: RacpHostNotify }).notify).toMatchObject({ kind: "approval.requested", sessionId: "s1" });
    socket.close();
    await flush();
  });

  it("stays silent — and advertises nothing — on a Host without a notifier", async () => {
    await setup();
    // An older Host: no notifier, no device directory, so no capabilities frame
    // at all. The Gateway must treat it as a Host that reports nothing.
    openHost(null);
    expect(socket.framesOfType("host.capabilities")).toEqual([]);
    expect(socket.framesOfType("host.notify")).toEqual([]);
    socket.close();
    await flush();
  });

  it("detaches the sender when the link closes, so a later event is not written into it", async () => {
    await setup();
    const notifier = new HostLinkNotifier();
    openHost(notifier);
    expect(notifier.attached).toBe(true);
    socket.open = false;
    socket.close();
    await flush();
    expect(notifier.attached).toBe(false);
    expect(notifier.notify({ kind: "turn.failed", sessionId: "s1" })).toBe(false);
  });

  /**
   * The older-Gateway half: a mux that knows nothing about push. It has no
   * notify handler registered, so the frame must be dropped without closing the
   * link — a Host that reports one event must not lose its whole link for it.
   */
  it("drops the frame without closing the link when nothing listens", async () => {
    await setup();
    const adapter: HostLinkSocket = {
      send: () => true,
      close: () => undefined,
      onMessage: (handler) => socket.onMessage(handler),
      onClose: (handler) => socket.onClose(handler),
      onError: (handler) => socket.onError(handler),
    };
    const mux = new HostLinkGatewayMux(adapter, () => undefined);
    const closes: string[] = [];
    mux.onHostClose("cc_1", (code) => closes.push(code));
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "host.notify", notify: notify() });
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "host.notify", notify: { ...notify(), prompt: "secret" } });
    await flush();
    expect(closes).toEqual([]);
  });

  it("delivers a valid frame to a listener and drops a malformed one", async () => {
    await setup();
    const adapter: HostLinkSocket = {
      send: () => true,
      close: () => undefined,
      onMessage: (handler) => socket.onMessage(handler),
      onClose: (handler) => socket.onClose(handler),
      onError: (handler) => socket.onError(handler),
    };
    const mux = new HostLinkGatewayMux(adapter, () => undefined);
    const received: RacpHostNotify[] = [];
    mux.onHostNotify((frame) => received.push(frame));

    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "host.notify", notify: notify() });
    // A field the schema does not allow is a redaction violation, not a
    // judgment call: the frame is dropped, never delivered.
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "host.notify", notify: { ...notify({ notifyId: "ntf_2" }), prompt: "secret" } });
    // A kind outside the four is refused for the same reason.
    socket.feed({ link: RACP_HOSTLINK_VERSION, type: "host.notify", notify: { ...notify({ notifyId: "ntf_3" }), kind: "turn.started" } });

    await flush();
    expect(received.map((entry) => entry.notifyId)).toEqual(["ntf_1"]);
  });
});
