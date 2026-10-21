import { describe, expect, it } from "vitest";

import { tabBarVisible } from "./tab-bar.js";
import type { RootKind, Screen } from "./screen-stack.js";

/**
 * The bar shows on the two roots of a native build only (ADR
 * mobile-direct-gateway-chat, spec §4): pushed pages hide it so the
 * conversation viewport is unchanged, and the browser build keeps today's
 * single hierarchy with no bar and no Chats.
 */
describe("tabBarVisible", () => {
  it("shows on both roots of a native build", () => {
    expect(tabBarVisible({ kind: "chats" }, { isNativeApp: true })).toBe(true);
    expect(tabBarVisible({ kind: "hosts" }, { isNativeApp: true })).toBe(true);
  });

  it("hides on every pushed page of a native build", () => {
    expect(tabBarVisible({ kind: "session", hostId: "h1", sessionId: "s1", title: "" }, { isNativeApp: true })).toBe(false);
    expect(tabBarVisible({ kind: "projects", hostId: "h1" }, { isNativeApp: true })).toBe(false);
    expect(tabBarVisible({ kind: "chat" }, { isNativeApp: true })).toBe(false);
    expect(tabBarVisible({ kind: "chatArchive" }, { isNativeApp: true })).toBe(false);
    expect(tabBarVisible({ kind: "modelGateway", from: "chats" }, { isNativeApp: true })).toBe(false);
    expect(tabBarVisible({ kind: "settings", from: "chats" }, { isNativeApp: true })).toBe(false);
  });

  it("never shows in the browser build", () => {
    expect(tabBarVisible({ kind: "hosts" }, { isNativeApp: false })).toBe(false);
    expect(tabBarVisible({ kind: "chats" }, { isNativeApp: false })).toBe(false);
  });

  it("narrows the screen to a root, so the caller can name the root it draws", () => {
    const screen: Screen = { kind: "chats" };
    if (tabBarVisible(screen, { isNativeApp: true })) {
      // The type is what matters here: assigning the narrowed kind to RootKind
      // only compiles while the guard keeps telling the caller which root it is.
      const root: RootKind = screen.kind;
      expect(root).toBe("chats");
    } else {
      throw new Error("the Chats root must show the bar");
    }
  });
});
