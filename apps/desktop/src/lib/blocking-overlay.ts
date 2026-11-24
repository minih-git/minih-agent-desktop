import { useLayoutEffect, useSyncExternalStore } from "react";

// Native plugin views composite above the renderer, including its top layer.
// Count owners so dismissing one overlay cannot reveal a view under another.
const owners = new Set<symbol>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const isBlockingOverlayActive = () => owners.size > 0;

/**
 * Register this surface as a blocking overlay.
 *
 * The owner is held for as long as the calling component is mounted with
 * `active`, so a surface that stays mounted while closed (a dialog host, a
 * footer popover) passes its own open flag instead of registering for the
 * whole session.
 */
export function useBlockingOverlay(active = true) {
  useLayoutEffect(() => {
    if (!active) return;
    const owner = Symbol();
    owners.add(owner);
    notify();
    return () => { owners.delete(owner); notify(); };
  }, [active]);
}

export function useBlockingOverlayActive() {
  return useSyncExternalStore(subscribe, isBlockingOverlayActive, () => false);
}
