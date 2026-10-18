import { describe, expect, it } from "vitest";

import { previousScreen } from "./screen-stack.js";

/**
 * The Android hardware back button pops the in-app stack (PR-5): Session →
 * Sessions → Hosts. Only the Host list has nowhere to go, and there the app
 * exits instead.
 */
describe("previousScreen", () => {
  it("goes from a session back to its host's session list", () => {
    expect(previousScreen({ kind: "session", hostId: "host1", sessionId: "s1", title: "one" })).toEqual({
      kind: "sessions",
      hostId: "host1",
    });
  });

  it("goes from a session list, the pairing screen, or the account screen back to the Host list", () => {
    expect(previousScreen({ kind: "sessions", hostId: "host1" })).toEqual({ kind: "hosts" });
    expect(previousScreen({ kind: "pair" })).toEqual({ kind: "hosts" });
    expect(previousScreen({ kind: "account" })).toEqual({ kind: "hosts" });
  });

  it("has nowhere to go from the Host list", () => {
    expect(previousScreen({ kind: "hosts" })).toBeNull();
  });
});
