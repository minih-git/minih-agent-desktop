import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@minih-agent/i18n";
import { IPC } from "@minih-agent/shared";
import { Composer } from "../../apps/desktop/src/components/Composer";
import { TaskDock } from "../../apps/desktop/src/components/TaskDock";
import { AskToolCard } from "../../apps/desktop/src/components/AskToolCard";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import type { BackgroundTaskOutput, BackgroundTaskSummary } from "../../apps/desktop/src/lib/api";

const listeners = new Set<() => void>();
const requests: string[] = [];
const pending = new Map<string, (value: BackgroundTaskOutput) => void>();
let tasks: BackgroundTaskSummary[] = [];
let stoppedIds: string[] = [];
let revision = 0;
let deferOutput = false;
let rejectStop = false;
let root: Root | undefined;

function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(predicate: () => boolean, label: string) {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    assert(performance.now() < deadline, label);
    await frame();
  }
}

function output(id: string): BackgroundTaskOutput {
  return {
    id, state: "running", truncated: true,
    stdout: `${"*".repeat(256 * 1024 - 100)}\n${id}: output revision ${revision}`,
    stderr: "*".repeat(256 * 1024),
  };
}

Object.defineProperty(window, "minihAgent", {
  value: {
    invoke: async (channel: string, payload?: { id: string }) => {
      const call = async () => {
        if (channel === IPC.invoke.backgroundTasksList) return { tasks: [...tasks], version: revision };
        if (channel === IPC.invoke.backgroundTasksOutput) {
          const id = payload!.id;
          requests.push(id);
          if (deferOutput) return new Promise<BackgroundTaskOutput>((resolve) => pending.set(id, resolve));
          return output(id);
        }
        if (channel === IPC.invoke.backgroundTasksStop) {
          if (rejectStop) throw new Error("Fixture stop failure");
          stoppedIds.push(payload!.id);
          tasks = tasks.map((task) => task.id === payload!.id ? { ...task, state: "stopped" } : task);
          for (const listener of listeners) listener();
          return { ok: true, found: true };
        }
        if (channel === IPC.invoke.todosGet) return useAppStore.getState().sessionTodos["fixture"];
        throw new Error(`Unexpected fixture IPC: ${channel}`);
      };
      return { ok: true, data: await call() };
    },
    on: (channel: string, listener: () => void) => {
      if (channel !== IPC.event.backgroundTasksChanged) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
});

function sessionSummary(id: string) {
  return {
    id, title: `Session ${id}`, source: "desktop" as const, messageCount: 0,
    mode: "agent" as const, permissionMode: "ask" as const, thinkingLevel: "off" as const,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

/** Mount the production Composer so the container is reached through its real owner. */
async function mountComposer(sessionId: string | null) {
  flushSync(() => root?.unmount());
  pending.clear();
  requests.length = 0;
  stoppedIds = [];
  revision = 0;
  deferOutput = false;
  rejectStop = false;
  document.body.innerHTML = '<main id="root"></main>';
  useAppStore.setState({
    activeSessionId: sessionId,
    sessions: ["session-a", "session-b"].map(sessionSummary),
    sessionTodos: {},
    pendingAsks: {},
    planCheckpoints: {},
    plugins: [],
  });
  root = createRoot(document.getElementById("root")!);
  flushSync(() => root!.render(<I18nextProvider i18n={i18n}><Composer /></I18nextProvider>));
  await until(
    () => document.querySelectorAll(".task-row").length ===
      (sessionId ? sessionTasksOf(sessionId).length : 0),
    "session tasks did not render",
  );
}

const sessionTasksOf = (sessionId: string) =>
  tasks.filter((task) => task.sessionId === sessionId);
/** Session each rendered row belongs to, read from the fixture's command text. */
const barSessions = () => [...document.querySelectorAll<HTMLElement>(".task-command")]
  .map((command) => /--session=([a-z]+)/.exec(command.textContent ?? "")?.[1] ?? "");

async function mount(count = 10) {
  flushSync(() => root?.unmount());
  pending.clear();
  requests.length = 0;
  stoppedIds = [];
  revision = 0;
  deferOutput = false;
  rejectStop = false;
  tasks = Array.from({ length: count }, (_, index) => ({
    id: `task-${index}`, sessionId: "fixture",
    command: `node output-fixture.mjs --task=${index} ${"long-command-".repeat(8)}`,
    commandShellId: "bash", state: "running", elapsedMs: 1_000,
  }));
  document.body.innerHTML = '<main id="root"></main>';
  useAppStore.setState({
    activeSessionId: "fixture",
    sessionTodos: {
      fixture: {
        sessionId: "fixture", revision: 1, updatedAt: 1,
        todos: [{ content: "Verify background commands", status: "in_progress", priority: "medium" }],
      },
    },
  });
  root = createRoot(document.getElementById("root")!);
  flushSync(() => root!.render(
    <I18nextProvider i18n={i18n}>
      <div className="composer-dock composer-dock-docked">
        <div className="composer-stack">
          <TaskDock sessionId="fixture" />
          <AskToolCard request={{
            sessionId: "fixture", requestId: "fixture-ask", toolCallId: "fixture-ask",
            questions: [{ question: "Keep the background commands running?", options: ["Continue", "Stop"] }],
          }} />
          <div className="composer-shell"><textarea aria-label="Fixture message" /></div>
        </div>
      </div>
    </I18nextProvider>,
  ));
  await until(() => document.querySelectorAll(".task-row").length === count, "tasks did not render");
}

function row(index: number) {
  const element = document.querySelectorAll<HTMLElement>(".task-row")[index];
  assert(element, `task ${index} must be reachable`);
  return element;
}

function click(index: number, label = "Output") {
  if (label === "Output") {
    const main = row(index).querySelector<HTMLButtonElement>(".task-main");
    assert(main, "task-main control is missing");
    flushSync(() => main.click());
    return;
  }
  const button = [...row(index).querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => (button.getAttribute("aria-label") ?? button.textContent)?.trim() === label);
  assert(button, `${label} control is missing`);
  flushSync(() => button.click());
}

async function probe() {
  const translation = {
    ...en,
    backgroundTasks: {
      ...en.backgroundTasks,
      headerCount: "{{count}} background tasks",
      removeFailed: "Could not remove this task.",
    },
    taskDock: {
      title: "Todo and background tasks",
      tabTodo: "Todo",
      tabTasks: "Background tasks",
      newTasks: "{{count}} new tasks",
      runningCount: "{{count}} running",
      expand: "Expand {{label}}",
      collapse: "Collapse {{label}}",
      ...(en as { taskDock?: Record<string, string> }).taskDock,
    },
  };
  await i18n.init({ lng: "en", resources: { en: { translation } } });
  const results: { name: string; ok: boolean; error?: string }[] = [];
  let responsiveness: { samples: number; eventLoopDelayP95Ms: number; eventLoopDelayMaxMs: number; outputReads: number } | undefined;
  const unhandled: string[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    event.preventDefault();
    unhandled.push(String(event.reason));
  };
  window.addEventListener("unhandledrejection", onUnhandled);
  const check = async (name: string, run: () => Promise<void>) => {
    try { await run(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: String(error) }); }
  };

  await check("ten tasks scroll inside the shared dock without displacing Ask or input", async () => {
    await mount();
    const dock = document.querySelector<HTMLElement>(".dock")!;
    const panel = [...document.querySelectorAll<HTMLElement>(".dock-panel")].find((node) => !node.hidden)!;
    const box = panel.getBoundingClientRect();
    assert(box.height >= 40, `task list must be visible (${box.height}px)`);
    assert(box.height <= 220, `task list is unbounded (${box.height}px)`);
    assert(panel.scrollHeight > panel.clientHeight, "overflowing rows need an internal scrollport");
    assert(getComputedStyle(panel).overflowY === "auto", "task list must be scrollable");
    const dockBox = dock.getBoundingClientRect();
    const ask = document.querySelector(".asktool-card")!.getBoundingClientRect();
    const input = document.querySelector("textarea")!.getBoundingClientRect();
    assert(dockBox.top >= 0 && dockBox.bottom <= ask.top + 1, "dock must remain above Ask");
    assert(ask.bottom <= input.top + 1, "Ask must remain above the input");
    assert(input.bottom <= innerHeight && input.width > 100, "input must remain usable");
    row(9).scrollIntoView({ block: "nearest" });
    click(9);
    await until(() => !!document.querySelector(".task-output")?.textContent?.includes("task-9"), "last task output is unreachable");
  });

  await check("collapsed tabs remain reachable, expand on click, and badge new tasks without stealing the tab", async () => {
    await mount(1);
    const todoTab = () => document.querySelectorAll<HTMLButtonElement>(".dock-tab")[0]!;
    const tasksTab = () => document.querySelectorAll<HTMLButtonElement>(".dock-tab")[1]!;
    const toggle = () => document.querySelector<HTMLButtonElement>(".dock-toggle")!;
    assert(tasksTab().getAttribute("aria-selected") === "true", "running work selects tasks tab initially");
    flushSync(() => todoTab().click());
    await until(() => todoTab().getAttribute("aria-selected") === "true", "Todo tab must select");
    // New running task arrives while the user is on the Todo tab: must badge, not steal tab.
    tasks = [
      ...tasks,
      { id: "task-new", sessionId: "fixture", command: "npm run watch", commandShellId: "bash", state: "running", elapsedMs: 500 },
    ];
    for (const listener of listeners) listener();
    await until(() => document.querySelector(".dock-tab-badge")?.textContent === "1", "new task must raise badge on tasks tab");
    assert(todoTab().getAttribute("aria-selected") === "true", "new task must not steal the user's Todo tab");
    // Collapse the dock: tabs stay reachable in the header.
    flushSync(() => toggle().click());
    await until(() => toggle().getAttribute("aria-expanded") === "false", "dock toggle must collapse panels");
    // Clicking the tasks tab while collapsed expands the dock and clears the badge.
    flushSync(() => tasksTab().click());
    await until(
      () => toggle().getAttribute("aria-expanded") === "true" &&
        tasksTab().getAttribute("aria-selected") === "true" &&
        !document.querySelector(".dock-tab-badge"),
      "clicking collapsed tasks tab must expand dock and clear badge",
    );
  });

  await check("row lead pointer and native keyboard toggle output without swallowing actions", async () => {
    await mount();
    const main = row(0).querySelector<HTMLButtonElement>(".task-main");
    assert(main?.tagName === "BUTTON", "the row lead must be a native button");
    flushSync(() => row(0).querySelector<HTMLElement>(".task-command")!.click());
    await until(() => main.getAttribute("aria-expanded") === "true", "command click did not open output");
    click(0);
    await until(() => main.getAttribute("aria-expanded") === "false", "row lead click must close once without bubbling");
    main.focus();
    console.log("BACKGROUND_NATIVE_KEY Return");
    await until(() => main.getAttribute("aria-expanded") === "true", "native Enter did not open output");
    console.log("BACKGROUND_NATIVE_KEY Space");
    await until(() => main.getAttribute("aria-expanded") === "false", "native Space did not close output");
    flushSync(() => row(0).querySelector<HTMLElement>(".task-state")!.click());
    await until(() => main.getAttribute("aria-expanded") === "true", "state click did not open output");
    const taskRow = main.closest<HTMLElement>(".task-row")!;
    click(0, "Stop");
    await until(() => taskRow.dataset.state === "stopped", "Stop must keep its own action");
    assert(main.getAttribute("aria-expanded") === "true", "Stop must not toggle output");
    const dismiss = [...taskRow.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Dismiss");
    assert(dismiss, "Dismiss must remain available on the stopped task");
    flushSync(() => dismiss.click());
    await until(() => document.querySelectorAll(".task-row").length === 9, "Dismiss must remove only its own row");
  });

  await check("only the selected log refreshes and remains bounded", async () => {
    await mount();
    assert(requests.length === 0, "collapsed logs must not cross IPC");
    click(0);
    await until(() => !!document.querySelector("pre")?.textContent?.includes("revision 0"), "initial output is missing");
    revision = 1;
    await until(() => !!document.querySelector("pre")?.textContent?.includes("revision 1"), "expanded output never refreshed");
    assert(requests.every((id) => id === "task-0"), "unselected output must not be fetched");
    assert(document.querySelector("pre")!.textContent!.length <= 12_010, "rendered output must stay bounded");
  });

  await check("late output cannot replace the newly selected task", async () => {
    await mount();
    deferOutput = true;
    click(0);
    await until(() => pending.has("task-0"), "first output request is missing");
    click(1);
    await until(() => pending.has("task-1"), "second output request is missing");
    pending.get("task-1")!(output("task-1"));
    await until(() => !!document.querySelector("pre")?.textContent?.includes("task-1"), "second output is missing");
    pending.get("task-0")!(output("task-0"));
    await frame();
    await frame();
    assert(document.querySelector("pre")?.textContent?.includes("task-1"), "late first response erased the current output");
  });

  await check("the container follows the open conversation and never stops another session's task", async () => {
    await mount(0);
    tasks = [
      { id: "task-a", sessionId: "session-a", command: "npm run dev -- --session=a",
        commandShellId: "bash", state: "running", elapsedMs: 1_000 },
      { id: "task-b", sessionId: "session-b", command: "npm run dev -- --session=b",
        commandShellId: "bash", state: "running", elapsedMs: 1_000 },
    ];
    await mountComposer("session-a");
    assert(JSON.stringify(barSessions()) === JSON.stringify(["a"]),
      `session-a must not list session-b's task: ${JSON.stringify(barSessions())}`);
    // Switching conversations only changes what is listed; the running
    // processes of both sessions stay alive.
    flushSync(() => useAppStore.setState({ activeSessionId: "session-b" }));
    await until(() => JSON.stringify(barSessions()) === JSON.stringify(["b"]),
      `session-b must show only its own task: ${JSON.stringify(barSessions())}`);
    assert(stoppedIds.length === 0, `switching conversations must not stop anything: ${stoppedIds}`);
    flushSync(() => useAppStore.setState({ activeSessionId: null }));
    await until(() => document.querySelectorAll(".task-row").length === 0,
      "a draft composer has no conversation to scope tasks to");
    flushSync(() => useAppStore.setState({ activeSessionId: "session-a" }));
    await until(() => JSON.stringify(barSessions()) === JSON.stringify(["a"]),
      "returning to session-a must restore only its task");
    click(0, "Stop");
    await until(() => stoppedIds.length === 1, "the Stop control did not reach the host");
    assert(stoppedIds[0] === "task-a", `Stop must target the open conversation's task: ${stoppedIds[0]}`);
  });

  await check("Stop failures are visible and retryable", async () => {
    await mount();
    rejectStop = true;
    click(0, "Stop");
    await until(() => !!document.querySelector('[role="alert"]'), "Stop failure must be visible");
    rejectStop = false;
    click(0, "Stop");
    await until(() => row(0).dataset.state === "stopped", "Stop retry did not settle");
    assert(unhandled.length === 0, `unhandled rejection: ${unhandled.join(", ")}`);
  });

  await check("typing remains responsive with ten tasks and a full output preview", async () => {
    await mount();
    click(0);
    await until(() => !!document.querySelector("pre")?.textContent?.includes("revision 0"), "output is missing");
    const input = document.querySelector("textarea")!;
    input.focus();
    const gaps: number[] = [];
    let previous = performance.now();
    for (let index = 0; index < 120; index++) {
      revision++;
      input.value = `message-${index}`;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(index) }));
      // A fixed-rate input workload measures event-loop delay independently
      // of compositor frame suppression in an intentionally hidden window.
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
      const now = performance.now();
      gaps.push(Math.max(0, now - previous - 16));
      previous = now;
    }
    gaps.sort((a, b) => a - b);
    responsiveness = {
      samples: gaps.length,
      eventLoopDelayP95Ms: Number(gaps[Math.floor(gaps.length * 0.95)].toFixed(2)),
      eventLoopDelayMaxMs: Number(gaps.at(-1)!.toFixed(2)),
      outputReads: requests.length,
    };
    assert(input.value === "message-119", "typing must remain usable");
    assert(responsiveness.eventLoopDelayP95Ms < 250, "background polling must not stall the renderer");
    assert(requests.every((id) => id === "task-0"), "only the open output may be polled");
  });

  flushSync(() => root?.unmount());
  await frame();
  assert(listeners.size === 0, "unmount must detach the background task listener");
  await mount();
  await frame();
  await frame();
  window.removeEventListener("unhandledrejection", onUnhandled);
  return { viewport: { width: innerWidth, height: innerHeight }, results, responsiveness, ok: results.every((result) => result.ok) };
}

Object.assign(globalThis, { backgroundTasksProbe: probe });
