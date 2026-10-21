/**
 * Which root the app opens on (ADR mobile-direct-gateway-chat, spec §4/§17.3).
 *
 * A fresh native install opens Chats. The first launch after an upgrade of an
 * installation that already holds computers opens Computers. Afterwards the
 * app reopens the last selected root, remembered in `localStorage` under
 * `remote.last-root` — a credential-free preference, in the same store the host
 * registry already uses. The browser build has one root (`hosts`) and never
 * calls this module.
 *
 * Pure decision over the facts at launch, so the rule is unit-tested without a
 * DOM. The caller passes its own storage; `null` storage (blocked localStorage)
 * falls back to the decision without persistence, exactly like the registry.
 */
import type { RootKind } from "./screen-stack.js";

/** The `localStorage` key the last selected root is remembered under. */
export const LAST_ROOT_STORAGE_KEY = "remote.last-root";

/** A `Storage`-like reader/writer; the shape `localStorage` and fakes share. */
export type RootStorage = Pick<Storage, "getItem" | "setItem">;

export type LaunchRootInput = {
  /** Whether this build runs inside a native shell. */
  isNativeApp: boolean;
  /** Whether the host registry holds at least one computer right now. */
  hasHosts: boolean;
  /** `localStorage` when available; `null` when blocked or absent. */
  storage: RootStorage | null;
};

/** The default install has no computers and no remembered root: Chats. */
export function launchRoot(input: LaunchRootInput): RootKind {
  if (!input.isNativeApp) return "hosts";
  const remembered = input.storage?.getItem(LAST_ROOT_STORAGE_KEY) ?? null;
  if (remembered === "chats" || remembered === "hosts") return remembered;
  // An upgrade keeps its computers: the launch these users know must not move.
  // Without the flag there is nothing to distinguish from a fresh install, so
  // the one observation available at first launch decides.
  return input.hasHosts ? "hosts" : "chats";
}

/** Remember the root the user switched to; a blocked store simply forgets it. */
export function storeLastRoot(root: RootKind, storage: RootStorage | null): void {
  try {
    storage?.setItem(LAST_ROOT_STORAGE_KEY, root);
  } catch {
    // Quota errors and blocked storage keep the session working without the
    // preference, the same trade the host registry makes.
  }
}
