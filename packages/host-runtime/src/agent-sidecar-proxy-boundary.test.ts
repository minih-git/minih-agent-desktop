import { describe, expect, it } from "vitest";
import { HOST_PROXY_ALLOWED } from "./agent-sidecar.js";

/**
 * The sidecar reaches host-core through the reverse `host.proxy` channel. That
 * channel is deliberately narrower than the host's own RPC route, because the
 * sidecar runs the model and its plugins, which have no person to confirm
 * anything with.
 *
 * Routing `bot.*` / `taskCard.*` on the host must not widen this: the desktop
 * calls those methods directly, and `taskCard.confirm` is a person's click by
 * definition.
 */
describe("host proxy allowlist", () => {
  it("never exposes the employee surface to the sidecar", () => {
    const leaked = [...HOST_PROXY_ALLOWED].filter(
      (method) => method.startsWith("bot.") || method.startsWith("taskCard."),
    );
    expect(leaked).toEqual([]);
  });

  it("keeps the methods the sidecar does need", () => {
    // A guard against over-tightening: these are the session and tool calls the
    // agent loop makes on every turn.
    expect([...HOST_PROXY_ALLOWED]).toEqual(
      expect.arrayContaining(["tools.execute", "session.get", "session.appendMessage"]),
    );
  });
});
