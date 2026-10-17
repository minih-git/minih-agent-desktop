type FrameHandle = number;

/**
 * Coalesces high-frequency updates until the next paint opportunity.
 *
 * A key keeps only the latest value for one streaming target while preserving
 * insertion order between different targets. Terminal events can call
 * flushNow() so a final state never waits behind the frame.
 */
export function createFrameBatcher<T>(
  flush: (values: readonly T[]) => void,
) {
  const pending = new Map<string, T>();
  let handle: FrameHandle | null = null;
  let fallback: FrameHandle | null = null;
  let usesAnimationFrame = false;

  const clearFallback = () => {
    if (fallback !== null) {
      globalThis.clearTimeout(fallback);
      fallback = null;
    }
  };

  const cancelScheduledFlush = () => {
    if (handle === null) return;
    if (
      usesAnimationFrame &&
      typeof globalThis.cancelAnimationFrame === "function"
    ) {
      globalThis.cancelAnimationFrame(handle);
    } else {
      globalThis.clearTimeout(handle);
    }
    handle = null;
  };

  const run = () => {
    handle = null;
    clearFallback();
    if (pending.size === 0) return;
    const values = [...pending.values()];
    pending.clear();
    flush(values);
  };

  const schedule = () => {
    if (handle !== null) return;
    if (typeof globalThis.requestAnimationFrame === "function") {
      usesAnimationFrame = true;
      handle = globalThis.requestAnimationFrame(run);
      /*
        Headless surfaces (xvfb, hidden windows, occluded panes) can starve
        rAF indefinitely, which would strand every enqueued update forever.
        The rAF handle stays primary so steady state keeps single-frame
        latency; the timeout only fires when the compositor stays silent.
      */
      fallback = globalThis.setTimeout(run, 250) as unknown as FrameHandle;
      return;
    }
    usesAnimationFrame = false;
    handle = globalThis.setTimeout(run, 16) as unknown as FrameHandle;
  };

  return {
    enqueue(key: string, value: T, merge?: (previous: T, next: T) => T) {
      const existing = pending.get(key);
      pending.set(key, existing && merge ? merge(existing, value) : value);
      schedule();
    },
    flushNow() {
      cancelScheduledFlush();
      run();
    },
    get size() {
      return pending.size;
    },
  };
}
