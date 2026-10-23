/**
 * The settings sheet's mount lifecycle.
 *
 * The sheet outlives the page change by its exit animation, so the shell cannot
 * unmount it on `page !== "settings"`. While it is mounted — including the exit
 * — the app behind it stays inert and the scrim keeps taking the pointer.
 *
 * Extracted from AppShell so the isolated renderer tests drive the shipped
 * lifecycle instead of a hand-written stand-in.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** The exit animation is ~180ms; this only covers a missing animationend. */
const EXIT_FALLBACK_MS = 400;

export type SettingsSheetPresence = {
  /** The sheet is in the tree (open, or still playing its exit). */
  mounted: boolean;
  /** The page already changed; the sheet is leaving. */
  exiting: boolean;
  /** Ends the exit. A re-open in the meantime cancels it. */
  onExited: () => void;
};

export function useSettingsSheetPresence(open: boolean): SettingsSheetPresence {
  const [mounted, setMounted] = useState(open);
  const [exiting, setExiting] = useState(false);
  // Every open or close starts a new generation, so a late animationend from
  // an exit that a re-open already cancelled cannot unmount the new sheet.
  const generation = useRef(0);

  const finish = useCallback((token: number) => {
    if (generation.current !== token) return;
    setExiting(false);
    setMounted(false);
  }, []);

  useEffect(() => {
    if (open) {
      generation.current += 1;
      setMounted(true);
      setExiting(false);
      return;
    }
    if (!mounted) return;
    const token = generation.current + 1;
    generation.current = token;
    setExiting(true);
    const timer = window.setTimeout(() => finish(token), EXIT_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [finish, mounted, open]);

  const onExited = useCallback(() => finish(generation.current), [finish]);

  return { mounted, exiting, onExited };
}
