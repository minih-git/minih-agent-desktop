/**
 * The app-state and hardware-back signals shared with the native shell (PR-5).
 *
 * `App.tsx` owns the screen stack, but the Android `backButton` event arrives
 * from the native side. This module is the one meeting point: the bootstrap
 * dispatches a back request, and whichever screen is current installs a
 * handler. No handler means "there is nowhere left to go", so the app exits.
 */

export type BackHandler = () => void;

let handler: BackHandler | null = null;

/** Install (or clear) the current screen's back handler. */
export function setBackHandler(next: BackHandler | null): void {
  handler = next;
}

/** Ask the current screen to go back. Returns false when the app may exit. */
export function dispatchBack(): boolean {
  if (!handler) return false;
  handler();
  return true;
}
