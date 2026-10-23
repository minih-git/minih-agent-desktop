/**
 * Cancellation state for one in-flight `tools.execute` call (ADR
 * tool-stop-side-effect-boundaries).
 *
 * The runtime's tool executor awaits the host result with no deadline, so a
 * stop has to say when that wait may end. Three classes exist:
 *
 * - `Bash` and `GenerateImages`: host-core kills the process tree, so the
 *   wait survives a bounded grace window for the output collected before the
 *   kill, then settles as `TOOL_ABORTED`.
 * - Local `Read`, `Glob`, `Grep`: read-only. The wait may end the moment the
 *   stop lands; a late host result is discarded and cannot mutate anything.
 * - Everything else (writes, MCP, plugin, session delivery, remote): the
 *   runtime requests typed cancellation but keeps awaiting the host result,
 *   so a reported stop never hides a side effect that is still running.
 *
 * The registry of active abort handlers lets `Runtime.abort()` drive the same
 * path when the signal handed to a tool never fires; without it, one
 * unyielding tool pinned the whole session (#1767).
 */

/** Local core tools whose host work is read-only and may be abandoned. */
export const READ_ONLY_CORE_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
]);

/**
 * How long a stop waits for a tool that host-core can actually interrupt
 * (`Bash`, `GenerateImages`) to hand back the output it collected before the
 * kill (#1767).
 */
export const TOOL_ABORT_GRACE_MS = 10_000;

/** Sentinel the race resolves with when the stop ended the wait. */
const STOPPED = Symbol("tool-execution-stopped");
export type ToolExecutionOutcome<T> = T | typeof STOPPED;

export function isToolExecutionStopped<T>(
  outcome: ToolExecutionOutcome<T>,
): outcome is typeof STOPPED {
  return outcome === STOPPED;
}

/** Extra cancellation state for one tool call awaiting `tools.execute`. */
export class ToolExecutionCancellation {
  readonly hostAbortsProcess: boolean;
  readonly canAbandonWait: boolean;
  private stopped = false;
  private graceTimer?: ReturnType<typeof setTimeout>;
  private resolveStopped!: (marker: typeof STOPPED) => void;
  private readonly stoppedPromise = new Promise<typeof STOPPED>((resolve) => {
    this.resolveStopped = resolve;
  });

  constructor(
    toolName: string,
    options: { hostAbortsProcess: boolean } = { hostAbortsProcess: false },
  ) {
    this.hostAbortsProcess = options.hostAbortsProcess;
    this.canAbandonWait = READ_ONLY_CORE_TOOLS.has(toolName);
  }

  /**
   * Arm the stop path once the typed `tools.abort` request is out. Arming is
   * idempotent per call; callers invoke it from their abort handler.
   */
  arm(): void {
    if (this.stopped) return;
    if (this.hostAbortsProcess) {
      // Bounded window for the partial output the host collected before the
      // kill; past it the turn ends regardless.
      if (!this.graceTimer) {
        this.graceTimer = setTimeout(
          () => this.stopWaiting(),
          TOOL_ABORT_GRACE_MS,
        );
      }
    } else if (this.canAbandonWait) {
      // Read-only host work cannot leave a write behind, so the user-facing
      // wait ends now while the blocking worker drains on its own.
      this.stopWaiting();
    }
  }

  /** Race the host execution against the armed stop path. */
  async race<T>(execution: Promise<T>): Promise<ToolExecutionOutcome<T>> {
    return Promise.race([execution, this.stoppedPromise]);
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Release the grace timer; called from the executor's cleanup. */
  dispose(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
  }

  private stopWaiting(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.dispose();
    this.resolveStopped(STOPPED);
  }
}

/**
 * Abort handlers for the tool calls currently awaiting `tools.execute`.
 * `Runtime.abort()` walks these directly, so a stop releases every in-flight
 * tool even when the signal it was handed never fired.
 */
export class ToolAbortRegistry {
  private readonly handlers = new Set<() => void>();

  register(handler: () => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Run every registered handler once; handlers are idempotent per call. */
  abortAll(): void {
    for (const handler of [...this.handlers]) handler();
  }

  get size(): number {
    return this.handlers.size;
  }
}
