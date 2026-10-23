/**
 * The OS motion preference as live React state (ADR mobile-redesign D4).
 *
 * A global CSS rule can switch off a class-based transition, but it cannot
 * reach a `transition` a component writes inline from JavaScript. The two
 * primitives that animate from state — `Sheet`'s drag snap-back and
 * `SwipeRow`'s reveal — therefore ask this hook and drop the animated
 * transition themselves. The decision is a pure function so it is tested in
 * Node without a DOM.
 */
import { useEffect, useState } from "react";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Minimal `MediaQueryList` interface shared by `matchMedia` and test fakes. */
export type ReducedMotionQuery = {
  matches: boolean;
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
};

/** Whether the given query list currently asks for reduced motion. */
export function reduceMotionFrom(mediaQueryList: ReducedMotionQuery | null | undefined): boolean {
  return mediaQueryList?.matches === true;
}

/**
 * The live query list, or `null` on a platform without `matchMedia` (an old
 * WebView) or one that refuses the query. Both degrade to full motion.
 */
function currentQuery(): ReducedMotionQuery | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY);
  } catch {
    return null;
  }
}

/** Track `prefers-reduced-motion: reduce` for the lifetime of the component. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reduceMotionFrom(currentQuery()));

  useEffect(() => {
    const mediaQueryList = currentQuery();
    if (!mediaQueryList?.addEventListener) return undefined;
    const handleChange = () => setReduced(reduceMotionFrom(mediaQueryList));
    mediaQueryList.addEventListener("change", handleChange);
    return () => mediaQueryList.removeEventListener?.("change", handleChange);
  }, []);

  return reduced;
}