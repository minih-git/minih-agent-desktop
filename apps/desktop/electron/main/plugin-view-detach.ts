/**
 * Detaching the visible plugin view, free of Electron so it stays unit-testable
 * (the same split `plugin-view-location.ts` and `plugin-view-bounds.ts` use).
 *
 * A `WebContentsView` composites above the renderer and holds the keyboard
 * while it is attached. Removing it is what lets a renderer overlay be seen,
 * and the focus handoff that goes with it is what lets the overlay be *typed
 * into*: a page that keeps focus swallows the Escape and Tab the user sends to
 * the dialog underneath.
 *
 * The order matters and is the whole reason this lives in its own module. A
 * view that leaves the window's view tree gives up focus as part of leaving, so
 * asking `isFocused()` afterwards answers no for a page that was focused a
 * moment earlier, and the handoff silently never happens.
 */

type DetachView = {
  webContents: {
    isDestroyed(): boolean;
    isFocused(): boolean;
  };
};

type DetachWindow = {
  isDestroyed(): boolean;
  contentView: {
    children: readonly unknown[];
    removeChildView(view: never): void;
  };
  webContents: {
    focus(): void;
  };
};

export type PluginViewDetachTarget = {
  window: DetachWindow;
  view: DetachView;
};

/**
 * Remove `view` from `window` and, when it held the keyboard, give the keyboard
 * back to the window's own renderer. Returns whether the focus was handed over,
 * so a caller can be tested on a decision rather than on a side effect alone.
 */
export function detachPluginView({ window, view }: PluginViewDetachTarget): boolean {
  if (window.isDestroyed()) return false;
  const contents = view.webContents;
  // Before the removal, never after.
  const hadFocus = !contents.isDestroyed() && contents.isFocused();
  if (window.contentView.children.includes(view)) {
    window.contentView.removeChildView(view as never);
  }
  if (!hadFocus) return false;
  window.webContents.focus();
  return true;
}