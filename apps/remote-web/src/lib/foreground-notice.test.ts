import { describe, expect, it } from "vitest";

import { shouldShowForegroundNotice } from "./foreground-notice.js";
import type { Screen } from "./screen-stack.js";

const session: Screen = { kind: "session", hostId: "h1", sessionId: "s1", title: "Refactor" };

describe("whether a notification that arrived in the foreground is shown", () => {
  it("stays quiet when the user is already in that session", () => {
    // The decision dock behind the notice is the notice (§17.6.4).
    expect(shouldShowForegroundNotice(session, { hostId: "h1", sessionId: "s1" })).toBe(false);
  });

  it("shows a notification for another session of the same computer", () => {
    expect(shouldShowForegroundNotice(session, { hostId: "h1", sessionId: "s2" })).toBe(true);
  });

  it("shows a notification for another computer", () => {
    expect(shouldShowForegroundNotice(session, { hostId: "h2", sessionId: "s1" })).toBe(true);
  });

  it("shows a notification from anywhere that is not a session", () => {
    const elsewhere: Screen[] = [
      { kind: "chats" },
      { kind: "studio" },
      { kind: "hosts" },
      { kind: "projects", hostId: "h1" },
      { kind: "settings", from: "chats" },
    ];
    for (const screen of elsewhere) {
      expect(shouldShowForegroundNotice(screen, { hostId: "h1", sessionId: "s1" })).toBe(true);
    }
  });
});