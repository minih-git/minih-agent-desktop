import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@minih-agent/i18n";
import { SessionSubagentRoster } from "../../apps/desktop/src/components/workpanel/SessionSubagentRoster";
import { SubagentTranscriptTab } from "../../apps/desktop/src/components/workpanel/SubagentTranscriptTab";
import { ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import { SlotSessionProvider } from "../../apps/desktop/src/plugins/renderer-slots/use-slots";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";
import type { UiMessage } from "@minih-agent/shared";

declare global {
  var sessionSubagentRosterProbe: () => Promise<{
    ok: true;
    sectionHeight: number;
    bodyHeight: number;
    bodyOverflows: boolean;
  }>;
}

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function until(check: () => boolean, label: string) {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await frame();
  }
}

const message = (
  id: string,
  role: UiMessage["role"],
  extra: Partial<UiMessage> = {},
): UiMessage => ({
  id,
  role,
  content: "",
  createdAt: "2026-10-18T00:00:00.000Z",
  ...extra,
});

/** A settled `Task` call whose session is far longer than the reading window. */
const storedTask = message("task-row", "tool", {
  toolName: "Task",
  toolCallId: "call-1",
  toolArgs: { agent: "explorer", task: "Inspect authentication" },
  toolResult: {
    details: { delegationId: "del-1", status: "completed", agent: "explorer" },
  },
});

const storedAnswer = message("stored-answer", "assistant", {
  content: "The stored report from an earlier turn.",
  parentToolCallId: "call-1",
  agentName: "explorer",
});

/**
 * The whole session is 40 messages long and the renderer only holds the tail,
 * which is what made the old detail tab announce "details unavailable" for a
 * delegation it had just listed.
 */
const recentTail = [
  message("recent-user", "user", { content: "Continue" }),
  ...Array.from({ length: 39 }, (_, index) =>
    message(`filler-${index}`, "assistant", { content: `filler ${index}` }),
  ),
];

const otherTask: UiMessage = {
  ...storedTask,
  id: "other-task",
  toolCallId: "call-2",
  toolResult: { details: { delegationId: "del-2", status: "completed", agent: "explorer" } },
};

function Harness() {
  const panelOpen = useAppStore((state) => state.workPanelOpen);
  const active = useAppStore((state) =>
    state.workPanelTabs.find((tab) => tab.id === state.activeWorkPanelTabId),
  );
  return (
    <>
      <SlotSessionProvider sessionId="session-roster">
        <ToolRow message={storedTask} variant="topology" />
        <ToolRow message={otherTask} variant="topology" />
      </SlotSessionProvider>
      {panelOpen ? (
        <div data-testid="probe-panel">
          <SessionSubagentRoster />
          {active?.kind === "subagent" ? (
            <SubagentTranscriptTab delegationId={active.resource ?? ""} />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

globalThis.sessionSubagentRosterProbe = async () => {
  const previousStore = useAppStore.getState();
  const host = document.createElement("div");
  host.style.cssText = "width: 360px; height: 680px; background: #212121; color: #fff;";
  document.body.append(host);

  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });

  let rosterRows: UiMessage[] = [];
  let detailMessages: UiMessage[] | null = null;
  let rosterError: Error | null = null;
  api.getSessionDelegations = async (sessionId) => {
    if (rosterError) throw rosterError;
    return { sessionId, messages: rosterRows };
  };
  api.getSessionDelegation = async (sessionId, delegationId) => ({
    sessionId,
    delegationId,
    messages: detailMessages,
    truncated: false,
  });

  const setSession = (messages: UiMessage[], running: boolean) =>
    useAppStore.setState({
      ...previousStore,
      activeSessionId: "session-roster",
      messages,
      retainedTranscripts: {},
      runningSessions: { "session-roster": running },
      workPanelTabs: [],
      activeWorkPanelTabId: null,
      workPanelContexts: {},
      workPanelOpen: true,
      openSubagentTab: (delegationId: string, agentName?: string) =>
        previousStore.openSubagentTab(delegationId, agentName),
    });

  const uncaught: unknown[] = [];
  let root = createRoot(host, { onUncaughtError: (error) => uncaught.push(error) });
  const mount = () =>
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <Harness />
        </I18nextProvider>,
      ),
    );

  try {
    // 1. A live delegate settles while its row keeps the same identity.
    rosterRows = [];
    detailMessages = null;
    setSession([message("live-task", "tool", {
      toolName: "Task",
      toolCallId: "call-live",
      toolArgs: { agent: "test-runner", task: "Run the suite" },
      toolResult: { details: { delegationId: "del-live", status: "running" } },
    })], true);
    mount();
    await until(
      () => host.querySelector('[data-delegation-id="del-live"]')?.classList.contains("is-running") === true,
      "the running row",
    );
    flushSync(() =>
      useAppStore.setState({
        messages: [message("live-task", "tool", {
          toolName: "Task",
          toolCallId: "call-live",
          toolArgs: { agent: "test-runner", task: "Run the suite" },
          toolResult: { details: { delegationId: "del-live", status: "completed" } },
        })],
      }),
    );
    await until(
      () => host.querySelector('[data-delegation-id="del-live"]')?.classList.contains("is-completed") === true,
      "the settled row to update in place",
    );

    // 2. An old delegation from the stored history opens a real conversation,
    //    even though the renderer's live window does not contain its rows.
    flushSync(() => root.unmount());
    root = createRoot(host, { onUncaughtError: (error) => uncaught.push(error) });
    rosterRows = [storedTask];
    detailMessages = [storedTask, storedAnswer];
    setSession(recentTail, false);
    mount();
    await until(
      () => Boolean(host.querySelector('[data-delegation-id="del-1"]')),
      "the historical roster row",
    );
    (host.querySelector('[data-delegation-id="del-1"]') as HTMLButtonElement).click();
    await until(
      () => host.textContent?.includes("The stored report from an earlier turn.") === true,
      "the stored conversation",
    );
    assert(
      !host.textContent?.includes("no longer available"),
      "a listed delegation must not report its details as unavailable",
    );
    assert(
      useAppStore.getState().messages.map((entry) => entry.id).includes("recent-user"),
      "opening a delegation must not rewrite the main transcript",
    );

    // A topology disclosure toggles the visible panel, not the retained tab.
    const headers = host.querySelectorAll<HTMLButtonElement>(".subagent-topology-node-header");
    const first = headers[0];
    const second = headers[1];
    assert(first.getAttribute("aria-expanded") === "true", "the active visible delegation is expanded");
    const retainedTabs = useAppStore.getState().workPanelTabs;
    first.focus();
    flushSync(() => first.click());
    assert(!useAppStore.getState().workPanelOpen, "clicking the active topology node again must collapse the panel");
    assert(first.getAttribute("aria-expanded") === "false", "a hidden retained tab is not expanded");
    assert(!first.hasAttribute("aria-controls"), "a hidden panel is not an accessible disclosure target");
    assert(!host.querySelector('[data-testid="probe-panel"]'), "the collapsed panel leaves the layout");
    assert(useAppStore.getState().workPanelTabs === retainedTabs, "collapse must preserve delegation tabs");
    assert(document.activeElement === first, "collapsing keeps focus on the node");
    flushSync(() => first.click());
    assert(useAppStore.getState().workPanelOpen, "the same node reopens its retained tab");
    assert(useAppStore.getState().workPanelTabs.length === 1, "reopening must not duplicate the tab");
    flushSync(() => second.click());
    assert(useAppStore.getState().workPanelOpen && useAppStore.getState().activeWorkPanelTabId === "subagent:del-2", "another node switches delegations without collapsing");
    assert(first.getAttribute("aria-expanded") === "false" && second.getAttribute("aria-expanded") === "true", "only the visible delegation is expanded");
    flushSync(() => first.click());
    assert(useAppStore.getState().workPanelOpen && useAppStore.getState().activeWorkPanelTabId === "subagent:del-1", "an inactive retained delegation activates instead of collapsing");
    flushSync(() => useAppStore.getState().collapseWorkPanel());
    assert(first.getAttribute("aria-expanded") === "false", "external panel collapse clears the node disclosure");
    flushSync(() => first.click());
    assert(useAppStore.getState().workPanelOpen && first.getAttribute("aria-expanded") === "true", "a node reopens after external collapse");

    // 3. A failed read is visible with a retry, never an empty panel.
    flushSync(() => root.unmount());
    root = createRoot(host, { onUncaughtError: (error) => uncaught.push(error) });
    rosterRows = [];
    detailMessages = null;
    rosterError = new Error("host read failed");
    setSession([], false);
    mount();
    await until(
      () => host.textContent?.includes("Could not load this session's subagents.") === true,
      "the roster failure state",
    );
    assert(
      host.textContent?.includes("Retry"),
      "a failed roster read must offer a retry",
    );
    rosterError = null;

    // 4. Many delegations scroll inside the cap instead of squeezing the body.
    flushSync(() => root.unmount());
    root = createRoot(host, { onUncaughtError: (error) => uncaught.push(error) });
    rosterRows = Array.from({ length: 12 }, (_, index) =>
      message(`bulk-${index}`, "tool", {
        toolName: "Task",
        toolCallId: `call-bulk-${index}`,
        toolArgs: { agent: "explorer", task: `Bulk task ${index}` },
        toolResult: { details: { delegationId: `del-bulk-${index}`, status: "completed" } },
      }),
    );
    setSession([], false);
    mount();
    await until(
      () => host.querySelectorAll(".subagent-roster-row").length === 12,
      "the bulk rows",
    );
    const body = host.querySelector(".subagent-roster-body") as HTMLElement;
    const cap = Number.parseFloat(getComputedStyle(body).maxHeight);
    assert(Number.isFinite(cap), "the roster body must declare a height cap");
    assert(
      body.getBoundingClientRect().height <= cap + 1,
      `roster height ${body.getBoundingClientRect().height} exceeds cap ${cap}`,
    );
    assert(
      body.scrollHeight > body.clientHeight,
      "many delegations must scroll inside the roster",
    );

    assert(uncaught.length === 0, `uncaught render error: ${String(uncaught[0])}`);
    const section = host.querySelector(".subagent-roster") as HTMLElement;
    const measurements = {
      sectionHeight: Math.round(section.getBoundingClientRect().height),
      bodyHeight: Math.round(body.getBoundingClientRect().height),
      bodyOverflows: body.scrollHeight > body.clientHeight,
    };
    const rosterHeader = host.querySelector<HTMLButtonElement>(".subagent-roster-header")!;
    flushSync(() => rosterHeader.click());
    assert(rosterHeader.getAttribute("aria-expanded") === "false" && !host.querySelector(".subagent-roster-body"), "the roster itself can collapse independently");
    flushSync(() => root.unmount());
    root = createRoot(host, { onUncaughtError: (error) => uncaught.push(error) });
    mount();
    await until(() => Boolean(host.querySelector(".subagent-roster-header")), "the retained collapsed roster");
    const restoredHeader = host.querySelector<HTMLButtonElement>(".subagent-roster-header")!;
    assert(restoredHeader.getAttribute("aria-expanded") === "false", "remounting preserves the session's collapsed roster");
    flushSync(() => restoredHeader.click());
    await until(() => host.querySelectorAll(".subagent-roster-row").length === 12, "the expanded roster rows");
    assert(restoredHeader.getAttribute("aria-expanded") === "true", "the roster reopens after remounting");
    assert(uncaught.length === 0, `uncaught render error: ${String(uncaught[0])}`);
    return { ok: true, ...measurements };
  } finally {
    useAppStore.setState(previousStore, true);
    root.unmount();
    host.remove();
  }
};
