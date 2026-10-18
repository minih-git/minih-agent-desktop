import { describe, expect, it } from "vitest";

import {
  watchAppState,
  watchForeground,
  watchVisibility,
  type AppStateSource,
  type VisibilitySource,
} from "./app-state.js";

function fakeDocument(initial: "visible" | "hidden" = "visible") {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: initial as DocumentVisibilityState,
    addEventListener: (_type: "visibilitychange", listener: () => void): void => {
      listeners.add(listener);
    },
    removeEventListener: (_type: "visibilitychange", listener: () => void): void => {
      listeners.delete(listener);
    },
  };
  return {
    doc: doc as unknown as VisibilitySource,
    set(state: "visible" | "hidden"): void {
      doc.visibilityState = state as DocumentVisibilityState;
      for (const listener of [...listeners]) listener();
    },
    listeners: (): number => listeners.size,
  };
}

function fakeAppState(options: { failWith?: Error } = {}) {
  const listeners = new Set<(state: { isActive: boolean }) => void>();
  const source: AppStateSource = {
    addListener: async (_name, listener) => {
      if (options.failWith) throw options.failWith;
      listeners.add(listener);
      return {
        remove: async () => {
          listeners.delete(listener);
        },
      };
    },
  };
  return {
    source,
    emit(isActive: boolean): void {
      for (const listener of [...listeners]) listener({ isActive });
    },
    listeners: (): number => listeners.size,
  };
}

describe("watchVisibility", () => {
  it("pauses on hidden and resumes on visible", () => {
    const page = fakeDocument();
    const seen: string[] = [];
    const stop = watchVisibility({ onHidden: () => seen.push("hidden"), onVisible: () => seen.push("visible") }, page.doc);
    page.set("hidden");
    page.set("visible");
    stop();
    page.set("hidden");
    expect(seen).toEqual(["hidden", "visible"]);
    expect(page.listeners()).toBe(0);
  });
});

describe("watchAppState", () => {
  it("feeds the same handlers from the native app state", async () => {
    const app = fakeAppState();
    const seen: string[] = [];
    const stop = watchAppState({ onHidden: () => seen.push("hidden"), onVisible: () => seen.push("visible") }, app.source);
    await Promise.resolve();
    app.emit(false);
    app.emit(true);
    stop();
    await Promise.resolve();
    app.emit(false);
    expect(seen).toEqual(["hidden", "visible"]);
    expect(app.listeners()).toBe(0);
  });

  it("removes a listener that resolves after stop()", async () => {
    const pending: Array<{ remove: () => Promise<void> }> = [];
    const source: AppStateSource = {
      addListener: async () => {
        const handle = { remove: async () => undefined };
        pending.push(handle);
        return handle;
      },
    };
    const stop = watchAppState({ onHidden: () => undefined, onVisible: () => undefined }, source);
    stop();
    await Promise.resolve();
    expect(pending).toHaveLength(1);
  });

  it("reports a failed registration instead of failing silently", async () => {
    const errors: unknown[] = [];
    const app = fakeAppState({ failWith: new Error("no bridge") });
    watchAppState({ onHidden: () => undefined, onVisible: () => undefined }, app.source, (error) => errors.push(error));
    await Promise.resolve();
    await Promise.resolve();
    expect(String(errors[0])).toContain("no bridge");
  });
});

describe("watchForeground", () => {
  it("combines the page and native sources and unsubscribes both", async () => {
    const page = fakeDocument();
    const app = fakeAppState();
    const seen: string[] = [];
    const stop = watchForeground(
      { onHidden: () => seen.push("hidden"), onVisible: () => seen.push("visible") },
      { doc: page.doc, appState: app.source },
    );
    await Promise.resolve();
    page.set("hidden");
    app.emit(true);
    stop();
    await Promise.resolve();
    page.set("visible");
    app.emit(false);
    expect(seen).toEqual(["hidden", "visible"]);
    expect(page.listeners()).toBe(0);
    expect(app.listeners()).toBe(0);
  });
});
