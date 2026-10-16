/**
 * Bound an updater wait without cancelling the underlying work. A hung feed
 * must not pin the desktop's update state indefinitely.
 */

export const UPDATE_CHECK_TIMEOUT_CODE = "UPDATE_CHECK_TIMEOUT";

/** True when `error` is this module's bounded-wait rejection. */
export function isUpdateCheckTimeout(error: unknown): boolean {
  return (
    (error as { code?: unknown } | null)?.code === UPDATE_CHECK_TIMEOUT_CODE
  );
}

export function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        Object.assign(new Error(`${label} timed out`), {
          code: UPDATE_CHECK_TIMEOUT_CODE,
        }),
      );
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
