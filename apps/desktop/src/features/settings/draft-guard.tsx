/**
 * Unsaved-edit protection for the settings sheet.
 *
 * Forms that save only on an explicit action register here, and every way out
 * of a destination — a category, a tab, a search result, the scrim, Escape, the
 * close button — asks the registry first. Automatically saved rows never
 * register, so they gain no global save button.
 */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type SettingsDraftStatus = {
  /** The form holds edits that are not saved yet. */
  dirty: boolean;
  /** A save is in flight; leaving would race it. */
  saving: boolean;
};

export type SettingsBlock = "none" | "dirty" | "saving";

export type SettingsDraftRegistry = {
  register(id: string, status: SettingsDraftStatus): void;
  release(id: string): void;
  /** What blocks leaving the current destination, if anything. */
  blocked(): SettingsBlock;
};

type Drafts = Map<string, SettingsDraftStatus>;

/**
 * Own one registry for the sheet; the panel passes it down through context.
 *
 * A registration change re-renders the panel, because the pending-leave dialog
 * reads `blocked()` while it is on screen: an in-flight save must unlock its
 * discard as soon as it settles, without waiting for another render.
 */
export function useSettingsDraftRegistry(): SettingsDraftRegistry {
  const drafts = useRef<Drafts>(new Map());
  const [, bump] = useState(0);
  return useMemo<SettingsDraftRegistry>(() => ({
    register: (id, status) => {
      const current = drafts.current.get(id);
      if (current && current.dirty === status.dirty && current.saving === status.saving) return;
      drafts.current.set(id, status);
      bump((version) => version + 1);
    },
    release: (id) => {
      if (drafts.current.delete(id)) bump((version) => version + 1);
    },
    blocked: () => {
      let dirty = false;
      for (const status of drafts.current.values()) {
        if (status.saving) return "saving";
        if (status.dirty) dirty = true;
      }
      return dirty ? "dirty" : "none";
    },
  }), []);
}

const SettingsDraftContext = createContext<SettingsDraftRegistry | null>(null);

export const SettingsDraftProvider = SettingsDraftContext.Provider;

/**
 * Register a form's unsaved state for as long as it is mounted.
 *
 * Layout effects keep the registry in step with the rendered state, so a click
 * that arrives in the same frame as the last keystroke still sees it.
 */
export function useSettingsDraftGuard(status: SettingsDraftStatus): void {
  const registry = useContext(SettingsDraftContext);
  const id = useId();
  const { dirty, saving } = status;
  useLayoutEffect(() => {
    if (!registry) return;
    registry.register(id, { dirty, saving });
  }, [dirty, registry, id, saving]);
  useEffect(() => {
    if (!registry) return;
    return () => registry.release(id);
  }, [registry, id]);
}
