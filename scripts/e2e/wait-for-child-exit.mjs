/**
 * Await a spawned child's exit under a bounded budget. SIGTERM is a request:
 * a child still initialising (an Electron main process mid-start is the case
 * this guards) can ignore it, and `close` then never arrives, so the step holds
 * the job open until CI cancels it. Escalate to SIGKILL after a short grace
 * period and report which signal fired so the caller can fail with output.
 *
 * Timers are injectable so the escalation is covered by a controlled clock
 * instead of waiting a real minute.
 */
export async function waitForChildExitWithEscalation(
  child,
  {
    termAfterMs = 60_000,
    killAfterMs = 65_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  let killedBy = null;
  const termTimer = setTimer(() => {
    killedBy = "SIGTERM";
    child.kill("SIGTERM");
  }, termAfterMs);
  const killTimer = setTimer(() => {
    killedBy = "SIGKILL";
    child.kill("SIGKILL");
  }, killAfterMs);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, killedBy };
  } finally {
    clearTimer(termTimer);
    clearTimer(killTimer);
  }
}