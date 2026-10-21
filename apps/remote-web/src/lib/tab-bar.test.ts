import { describe, expect, it } from "vitest";

import { tabBarVisible } from "./tab-bar.js";

/**
 * The bar shows on the two roots of a native build only (ADR
 * mobile-direct-gateway-chat, spec §4): pushed pages hide it so the
 * conversation viewport is unchanged, and the browser build keeps today's
 * single hierarchy with no bar and no Chats.
 */
describe("tabBarVisible", () => {
  it("shows on both roots of a native build", () => {
    expect(tabBarVisible({ isNativeApp: true, screen: { kind: "chats" } })).toBe(true);
    expect(tabBarVisible({ isNativeApp: true, screen: { kind: "hosts" } })).toBe(true);
  });

  it("hides on every pushed page of a native build", () => {
    expect(tabBarVisible({ isNativeApp: true, screen: { kind: "session", hostId: "h1", sessionId: "s1", title: "" } })).toBe(false);
    expect(tabBarVisible({ isNativeApp: true, screen: { kind: "projects", hostId: "h1" } })).toBe(false);
    expect(tabBarVisible({ isNativeApp: true, screen: { kind: "chat" } })).toBe(false);
    expect(tabBarVisible({ isNativeApp: true, screen: { kind: "chatArchive" } })).toBe(false);
    expect(tabBarVisible({ isNativeApp: true, screen: { kind: "modelGateway" } })).toBe(false);
    expect(tabBarVisible({ isNativeApp: true, screen: { kind: "settings", from: "chats" } })).toBe(false);
  });

  it("never shows in the browser build", () => {
    expect(tabBarVisible({ isNativeApp: false, screen: { kind: "hosts" } })).toBe(false);
    expect(tabBarVisible({ isNativeApp: false, screen: { kind: "chats" } })).toBe(false);
  });
});
