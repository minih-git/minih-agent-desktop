import "./session-subagent-roster.css";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@minih-agent/i18n";
import { SessionSubagentRoster } from "../../apps/desktop/src/components/workpanel/SessionSubagentRoster";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";

declare global {
  var sessionSubagentRosterProbe: () => Promise<{ ok: true }>;
}

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const waitFor = async (check: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
};

globalThis.sessionSubagentRosterProbe = async () => {
  const previousStore = useAppStore.getState();
  const host = document.createElement("div");
  host.style.cssText = "width: 360px; height: 640px; background: #212121; color: #fff;";
  document.body.append(host);

  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });

  const opened: Array<[string, string | undefined]> = [];
  const many = Array.from({ length: 12 }, (_, index) => ({
    id: `call-bulk-${index}`,
    role: "tool",
    content: "",
    createdAt: `2026-10-18T00:${String(index).padStart(2, "0")}:00.000Z`,
    toolName: "Task",
    toolCallId: `call-bulk-${index}`,
    toolArgs: { agent: "explorer", task: `Bulk delegated task ${index}` },
    toolResult: { details: { delegationId: `del-bulk-${index}`, status: "completed" } },
  }));
  api.getSessionDelegations = async (sessionId) => ({
    sessionId,
    complete: true,
    messages: [...many,
      {
        id: "call-old",
        role: "tool",
        content: "",
        createdAt: "2026-10-18T00:00:00.000Z",
        toolName: "Task",
        toolCallId: "call-old",
        toolArgs: { agent: "explorer", task: "Old settled task" },
        toolResult: { details: { delegationId: "del-old", status: "completed" } },
      },
      {
        id: "call-live",
        role: "tool",
        content: "",
        createdAt: "2026-10-18T00:01:00.000Z",
        toolName: "Task",
        toolCallId: "call-live",
        toolArgs: { agent: "test-runner", task: "Running task" },
        toolResult: { details: { delegationId: "del-live", status: "running" } },
      },
    ],
  });

  const uncaught: unknown[] = [];
  const root = createRoot(host, {
    onUncaughtError: (error) => uncaught.push(error),
  });

  try {
    flushSync(() =>
      useAppStore.setState({
        ...previousStore,
        activeSessionId: "session-roster",
        messages: [],
        retainedTranscripts: {},
        runningSessions: { "session-roster": true },
        workPanelTabs: [{ id: "subagent:del-old", kind: "subagent", resource: "del-old" }],
        activeWorkPanelTabId: "subagent:del-old",
        openSubagentTab: (delegationId, agentName) =>
          opened.push([delegationId, agentName]),
      }),
    );
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <SessionSubagentRoster />
        </I18nextProvider>,
      ),
    );

    await waitFor(
      () => Boolean(host.querySelector('[data-delegation-id="del-live"]')),
      "the live roster row",
    );

    const rows = [...host.querySelectorAll(".subagent-roster-row")];
    assert(rows.length >= 2, `expected the bulk roster rows, got ${rows.length}`);
    const bulkBody = host.querySelector(".subagent-roster-body") as HTMLElement;
    const cap = Number.parseFloat(getComputedStyle(bulkBody).maxHeight);
    assert(
      Number.isFinite(cap) && bulkBody.getBoundingClientRect().height <= cap + 1,
      `the roster body must stay within its height cap (height=${bulkBody.getBoundingClientRect().height}, cap=${cap})`,
    );
    assert(
      bulkBody.scrollHeight > bulkBody.clientHeight,
      "many delegations must scroll inside the roster, not grow the body",
    );
    // Focus the two rows the assertions below describe rather than assuming a
    // fixed total count from the bulk fixture.
    rows.splice(0, rows.length, ...rows.filter((row) =>
      ["del-live", "del-old"].includes(row.getAttribute("data-delegation-id") ?? ""),
    ));
    assert(rows.length === 2, `expected the two named roster rows, got ${rows.length}`);
    // The running delegate leads even though it started later.
    assert(
      rows[0].getAttribute("data-delegation-id") === "del-live",
      "the running delegate must lead the roster",
    );
    assert(
      rows[1].getAttribute("data-delegation-id") === "del-old",
      "the settled delegate must follow",
    );
    assert(
      rows[0].textContent?.includes("Running task"),
      "the row must show the Task brief",
    );
    assert(
      rows[0].textContent?.includes("test-runner"),
      "the row must show the delegate's agent",
    );
    assert(
      rows[1].getAttribute("aria-current") === "true",
      "the open detail tab must mark its row",
    );
    const groupLabels = [...host.querySelectorAll(".subagent-roster-group-label")].map(
      (node) => node.textContent,
    );
    assert(
      groupLabels.join("|") === "Running|Finished",
      `unexpected groups: ${groupLabels.join("|")}`,
    );

    // Clicking a row opens the existing subagent detail tab; it does not create
    // a second detail surface.
    (rows[0] as HTMLButtonElement).click();
    assert(opened.length === 1, "clicking a roster row must open one tab");
    assert(opened[0][0] === "del-live", "the clicked delegation must be opened");
    assert(opened[0][1] === "test-runner", "the tab keeps the agent name");

    // Collapse keeps the summary and hides the rows, then expands again.
    const header = host.querySelector(".subagent-roster-header") as HTMLButtonElement;
    assert(header.getAttribute("aria-expanded") === "true", "roster starts expanded");
    header.click();
    await waitFor(
      () => !host.querySelector(".subagent-roster-row"),
      "collapsed rows",
    );
    assert(
      header.getAttribute("aria-expanded") === "false",
      "collapse must update aria-expanded",
    );
    const collapsedText = header.textContent ?? "";
    assert(collapsedText.includes("1 running"), "collapsed header keeps the live count");
    header.click();
    await waitFor(
      () => Boolean(host.querySelector(".subagent-roster-row")),
      "expanded rows",
    );

    assert(uncaught.length === 0, `uncaught render error: ${String(uncaught[0])}`);
    const section = host.querySelector(".subagent-roster") as HTMLElement;
    const body = host.querySelector(".subagent-roster-body") as HTMLElement;
    return {
      ok: true,
      sectionHeight: Math.round(section.getBoundingClientRect().height),
      bodyHeight: Math.round(body.getBoundingClientRect().height),
      bodyOverflows: body.scrollHeight > body.clientHeight,
    };
  } finally {
    useAppStore.setState(previousStore, true);
    root.unmount();
    host.remove();
  }
};
