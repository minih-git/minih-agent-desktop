/**
 * What one touch drag on a scrolling list means.
 *
 * The gesture is claimed only while the list sits at its very top and while one
 * finger is down: anything else is the list's own scrolling, which this must
 * never take over. Kept apart from the hook so the decision is testable without
 * a browser — this package runs no DOM environment on purpose.
 */
export const PULL_TRIGGER_PX = 64;

export type PullTracker = {
  /** A touch started; only a single finger at the top arms the gesture. */
  start(input: { touches: number; scrollTop: number; clientY: number }): void;
  /** A finger moved; returns whether the drag has passed the threshold. */
  move(input: { clientY: number }): boolean;
  /** The touch ended; returns whether it should refresh. Always disarms. */
  end(input: { clientY?: number }): boolean;
  /** The touch was cancelled or the platform stole it. */
  cancel(): void;
  readonly armed: boolean;
};

export function createPullTracker(options: { threshold?: number } = {}): PullTracker {
  const threshold = options.threshold ?? PULL_TRIGGER_PX;
  let startY: number | null = null;

  const distance = (currentY: number | undefined): number =>
    startY === null || currentY === undefined ? 0 : currentY - startY;

  const clear = () => {
    startY = null;
  };

  return {
    start({ touches, scrollTop, clientY }) {
      // Only a list already scrolled to its top can be pulled down, and a second
      // finger is a pinch or a scroll intent, not this gesture.
      if (touches !== 1 || scrollTop > 0) clear();
      else startY = clientY;
    },
    move({ clientY }) {
      return startY !== null && distance(clientY) >= threshold;
    },
    end({ clientY }) {
      const fired = startY !== null && distance(clientY) >= threshold;
      clear();
      return fired;
    },
    cancel() {
      clear();
    },
    get armed() {
      return startY !== null;
    },
  };
}