import { missedTicks, nextSchedule, type ScheduleExpression } from "./plugin-schedule-time";

export const SCHEDULE_IDLE_SECONDS = 60;
export const SCHEDULE_TIMEOUT_MS = 5 * 60_000;
export const SCHEDULE_FAILURE_LIMIT = 5;
const POLL_MS = 15_000;

export type ScheduleState = {
  pluginId: string;
  scheduleId: string;
  lastRunAt: number | null;
  lastOk: boolean | null;
  attempts: number;
  paused: boolean;
};
export type ScheduleDeclaration = ScheduleExpression & {
  pluginId: string;
  scheduleId: string;
  runtimeId: string;
  runWhen?: "always" | "idle";
};
export type ScheduleClock = {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};
/** Unreferenced timers cannot keep the desktop process alive during shutdown. */
export const systemScheduleClock: ScheduleClock = {
  now: Date.now,
  setTimeout: (callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return timer;
  },
  clearTimeout,
};

export type ScheduleDependencies = {
  clock: ScheduleClock;
  idleSeconds(): number;
  declarations(): ScheduleDeclaration[];
  read(): Promise<ScheduleState[]>;
  write(state: ScheduleState): Promise<void>;
  deliver(declaration: ScheduleDeclaration, event: { scheduleId: string; firedAt: number; missed: number }, signal: AbortSignal): Promise<void>;
  onChange?(): void;
  onError(error: unknown): void;
};

const key = (pluginId: string, scheduleId: string) => JSON.stringify([pluginId, scheduleId]);

/** Owns timers and in-flight attempts; declarations and persisted state remain host-owned. */
export class PluginScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private initialized = false;
  private initializing?: Promise<void>;
  private generation = 0;
  private scanning = false;
  private running = new Map<string, { pluginId: string; runtimeId: string; cancelled: boolean; cancel?: () => void; done: Promise<void>; finish: () => void }>();
  private initialCron = new Map<string, { runtimeId: string; at: number }>();
  private runtimeIds = new Map<string, string>();
  private state = new Map<string, ScheduleState>();
  private writes = new Map<string, Promise<void>>();
  private readonly deps: ScheduleDependencies;

  constructor(deps: ScheduleDependencies) {
    this.deps = deps;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initializing) {
      this.initializing = (async () => {
        const rows = await this.deps.read();
        for (const row of rows) this.state.set(key(row.pluginId, row.scheduleId), row);
        this.initialized = true;
      })().finally(() => { this.initializing = undefined; });
    }
    await this.initializing;
  }

  async start(): Promise<void> {
    const generation = this.generation;
    await this.initialize();
    if (generation !== this.generation || !this.stopped || this.deps.declarations().length === 0) return;
    this.stopped = false;
    try {
      await this.tick();
    } catch (error) {
      this.stopped = true;
      throw error;
    }
  }

  stop(): void {
    this.generation++;
    this.stopped = true;
    if (this.timer) this.deps.clock.clearTimeout(this.timer);
    this.timer = undefined;
    for (const run of this.running.values()) {
      run.cancelled = true;
      run.cancel?.();
    }
    this.running.clear();
    this.initialCron.clear();
    this.runtimeIds.clear();
  }

  /** Call on resume and on plugin load/unload to re-evaluate promptly. */
  async tick(): Promise<void> {
    if (this.stopped || this.scanning) return;
    this.scanning = true;
    if (this.timer) this.deps.clock.clearTimeout(this.timer);
    this.timer = undefined;
    try {
      const declarations = this.deps.declarations();
      const current = new Set(declarations.map((item) => key(item.pluginId, item.scheduleId)));
      for (const [id, run] of this.running) {
        if (!current.has(id) || !declarations.some((item) => key(item.pluginId, item.scheduleId) === id && item.runtimeId === run.runtimeId)) {
          run.cancelled = true;
          run.cancel?.();
        }
      }
      for (const declaration of declarations) {
        const id = key(declaration.pluginId, declaration.scheduleId);
        const previousRuntime = this.runtimeIds.get(id);
        this.runtimeIds.set(id, declaration.runtimeId);
        const row = this.getState(declaration.pluginId, declaration.scheduleId);
        if (previousRuntime && previousRuntime !== declaration.runtimeId && row.paused && row.attempts >= SCHEDULE_FAILURE_LIMIT) {
          await this.update(row.pluginId, row.scheduleId, (current) => current.paused && current.attempts >= SCHEDULE_FAILURE_LIMIT ? { ...current, paused: false, attempts: 0 } : current);
        }
        if (this.stopped || this.running.has(id) || this.getState(declaration.pluginId, declaration.scheduleId).paused) continue;
        try {
          const now = this.deps.clock.now();
          const next = this.next(declaration, now);
          if (next <= now && (declaration.runWhen !== "idle" || this.deps.idleSeconds() >= SCHEDULE_IDLE_SECONDS)) {
            void this.run(declaration, false).catch(this.deps.onError);
          }
        } catch (error) {
          this.deps.onError(error);
        }
      }
    } finally {
      this.scanning = false;
      if (!this.stopped && this.deps.declarations().length > 0) {
        this.timer = this.deps.clock.setTimeout(() => void this.tick().catch(this.deps.onError), POLL_MS);
      } else {
        this.stopped = true;
      }
    }
  }

  async cancelPlugin(pluginId: string): Promise<void> {
    const active = [...this.running.values()].filter((run) => run.pluginId === pluginId);
    for (const run of active) {
      run.cancelled = true;
      run.cancel?.();
    }
    await Promise.all(active.map((run) => run.done));
  }

  forgetSchedule(pluginId: string, scheduleId: string): void {
    const id = key(pluginId, scheduleId);
    this.state.delete(id);
    this.initialCron.delete(id);
    this.runtimeIds.delete(id);
  }

  forgetPlugin(pluginId: string): void {
    for (const [id, row] of this.state) if (row.pluginId === pluginId) {
      this.state.delete(id);
      this.initialCron.delete(id);
      this.runtimeIds.delete(id);
    }
  }

  getState(pluginId: string, scheduleId: string): ScheduleState {
    return this.state.get(key(pluginId, scheduleId)) ?? { pluginId, scheduleId, lastRunAt: null, lastOk: null, attempts: 0, paused: false };
  }

  next(declaration: ScheduleDeclaration, now = this.deps.clock.now()): number {
    const row = this.getState(declaration.pluginId, declaration.scheduleId);
    if (row.lastRunAt !== null || declaration.every !== undefined) return nextSchedule(declaration, row.lastRunAt, now);
    const id = key(declaration.pluginId, declaration.scheduleId);
    const previous = this.initialCron.get(id);
    if (previous?.runtimeId === declaration.runtimeId) return previous.at;
    const at = nextSchedule(declaration, null, now);
    this.initialCron.set(id, { runtimeId: declaration.runtimeId, at });
    return at;
  }

  async setPaused(pluginId: string, scheduleId: string, paused: boolean): Promise<void> {
    if (!this.deps.declarations().some((item) => item.pluginId === pluginId && item.scheduleId === scheduleId)) throw new Error("Schedule is not loaded");
    await this.update(pluginId, scheduleId, (row) => ({ ...row, paused, attempts: paused ? row.attempts : 0 }));
    if (!paused) await this.tick();
  }

  async runNow(pluginId: string, scheduleId: string): Promise<void> {
    const declaration = this.deps.declarations().find((item) => item.pluginId === pluginId && item.scheduleId === scheduleId);
    if (!declaration || this.getState(pluginId, scheduleId).paused) throw new Error("Schedule is paused or not loaded");
    this.next(declaration);
    await this.run(declaration, true);
  }

  private async update(pluginId: string, scheduleId: string, change: (row: ScheduleState) => ScheduleState): Promise<ScheduleState> {
    const id = key(pluginId, scheduleId);
    const previousWrite = this.writes.get(id) ?? Promise.resolve();
    const pending = previousWrite.then(async () => {
      const previous = this.getState(pluginId, scheduleId);
      const row = change(previous);
      await this.deps.write(row);
      this.state.set(id, row);
      this.deps.onChange?.();
      return previous;
    });
    // The caller receives the error; later independent writes are not blocked by it.
    const settled = pending.then(() => {}, () => {});
    this.writes.set(id, settled);
    try { return await pending; }
    finally { if (this.writes.get(id) === settled) this.writes.delete(id); }
  }

  private async run(declaration: ScheduleDeclaration, manual: boolean): Promise<void> {
    const id = key(declaration.pluginId, declaration.scheduleId);
    if (this.running.has(id)) throw new Error("Schedule is already running");
    let finish = () => {};
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const run: { pluginId: string; runtimeId: string; cancelled: boolean; cancel?: () => void; done: Promise<void>; finish: () => void } = { pluginId: declaration.pluginId, runtimeId: declaration.runtimeId, cancelled: false, done, finish };
    this.running.set(id, run);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      let firedAt = 0;
      const previous = await this.update(declaration.pluginId, declaration.scheduleId, (row) => {
        if (row.paused || this.stopped || run.cancelled) throw new Error("Schedule is paused or unloaded");
        firedAt = this.deps.clock.now();
        return { ...row, lastRunAt: firedAt, lastOk: null };
      });
      const event = { scheduleId: declaration.scheduleId, firedAt, missed: manual ? 0 : missedTicks(declaration, previous.lastRunAt, firedAt) };
      if (this.stopped || run.cancelled || !this.deps.declarations().some((item) => item.pluginId === declaration.pluginId && item.scheduleId === declaration.scheduleId && item.runtimeId === run.runtimeId)) return;
      let timedOut = false;
      const controller = new AbortController();
      const deadline = new Promise<never>((_, reject) => {
        timeout = this.deps.clock.setTimeout(() => {
          timedOut = true;
          const error = new Error("Schedule handler timed out");
          controller.abort(error);
          reject(error);
        }, SCHEDULE_TIMEOUT_MS);
        run.cancel = () => {
          if (timeout !== undefined) this.deps.clock.clearTimeout(timeout);
          timeout = undefined;
          controller.abort(new Error("Schedule was unloaded"));
          reject(new Error("Schedule was unloaded"));
        };
      });
      let ok = true;
      try {
        await Promise.race([this.deps.deliver(declaration, event, controller.signal), deadline]);
      } catch {
        ok = false;
      }
      if (this.stopped || run.cancelled) return;
      await this.update(declaration.pluginId, declaration.scheduleId, (current) => {
        const attempts = ok ? 0 : current.attempts + 1;
        return { ...current, lastOk: ok, attempts, paused: current.paused || attempts >= SCHEDULE_FAILURE_LIMIT };
      });
      if (manual && !ok) throw new Error(timedOut ? "Schedule handler timed out" : "Plugin schedule handler failed");
    } finally {
      if (timeout) this.deps.clock.clearTimeout(timeout);
      if (this.running.get(id) === run) this.running.delete(id);
      run.finish();
    }
  }
}
