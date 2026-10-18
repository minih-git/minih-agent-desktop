import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@minih-agent/i18n";
import type { AppSettings, UiMessage } from "@minih-agent/shared";
import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { ShowThinkingRow } from "../../apps/desktop/src/components/settings/ShowThinkingRow";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { TranscriptSearchContext } from "../../apps/desktop/src/lib/transcript-search-context";
import type { TranscriptSearchTarget } from "../../apps/desktop/src/lib/transcript-reading";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const message = (
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage => ({
  id,
  role,
  content,
  createdAt: "2026-09-17T00:00:00.000Z",
  ...extra,
});

const tool = (
  id: string,
  toolName: string,
  extra: Partial<UiMessage> = {},
): UiMessage =>
  message(id, "tool", "", {
    toolName,
    toolCallId: `call-${id}`,
    toolStatus: "success",
    ...extra,
  });

const run = (id: string, command: string): UiMessage =>
  tool(id, "Bash", {
    toolArgs: { command },
    toolResult: { details: { stdout: "ok", exitCode: 0 } },
  });

/** Real mounted React components: disclosure ownership, preference and search. */
export async function turnProcessProbe() {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const initialSettings = useAppStore.getState().settings;
  // The folding contract lives in the compact density; flat densities are
  // asserted further down against the same fixture.
  const baseSettings: AppSettings = {
    defaultMode: "agent",
    theme: "light",
    enterToSend: true,
    onboardingDismissed: true,
    transcriptDensity: "compact",
  };
  const setSettings = (patch: Partial<AppSettings> = {}) =>
    flushSync(() => useAppStore.setState({ settings: { ...baseSettings, ...patch } }));
  setSettings();
  const errors: unknown[] = [];
  const root = createRoot(container, {
    onUncaughtError: (error) => errors.push(error),
  });
  const notes: string[] = [];
  const check = (value: unknown, name: string) => {
    assert(value, name);
    notes.push(name);
  };
  const render = (
    messages: UiMessage[],
    active = false,
    search: TranscriptSearchTarget | null = null,
    key = "turn",
  ) => {
    const entry = buildTranscriptEntries(messages).entries.find(
      (item) => item.kind === "assistant-turn",
    );
    assert(entry?.kind === "assistant-turn", "missing turn");
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <TranscriptSearchContext.Provider value={search}>
            <AssistantTurn key={key} entry={entry} isActive={active} />
          </TranscriptSearchContext.Provider>
        </I18nextProvider>,
      ),
    );
    assert(!errors.length, `React error: ${errors.map(String).join("; ")}`);
  };
  const processHeaders = () =>
    [...container.querySelectorAll<HTMLButtonElement>(".turn-process > button")];
  const firstProcess = () => container.querySelector<HTMLElement>(".turn-process-body");
  const visible = (element: Element | null) =>
    Boolean(element?.getBoundingClientRect().height);
  const click = (element: HTMLElement | null) => {
    assert(element, "missing click target");
    flushSync(() => element.click());
  };
  const row = (id: string) =>
    container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  const allCollapsed = () =>
    [...container.querySelectorAll<HTMLElement>("[aria-expanded]")].every(
      (element) => element.getAttribute("aria-expanded") === "false",
    );

  const intro = message("intro", "assistant", "Inspecting the files", {
    thinking: "reasoning detail",
    status: "complete",
  });
  const read = tool("read", "Read", {
    toolResult: "read output",
    toolArgs: { path: "src/example.ts" },
    toolCompletedAt: "2026-09-17T00:00:02.000Z",
  });
  const grep = tool("grep", "Grep", {
    toolResult: "grep output",
    toolArgs: { query: "todo" },
    toolCompletedAt: "2026-09-17T00:00:02.000Z",
  });
  const bash1 = run("bash1", "pnpm test");
  const bash2 = run("bash2", "pnpm build");
  const edit = tool("edit", "Edit", {
    toolResult: "edit output",
    toolArgs: { path: "src/example.ts" },
    toolCompletedAt: "2026-09-17T00:01:00.000Z",
  });
  const answer = message("answer", "assistant", "The fix is ready.", {
    status: "complete",
    createdAt: "2026-09-17T00:00:03.000Z",
    responseDurationMs: 1000,
  });
  const mixed = [intro, read, grep, bash1, bash2, edit, answer];

  try {
    // Bash has no process ancestor and stays visible with every disclosure
    // collapsed, even across adjacent calls.
    render(mixed);
    const bash1Row = row("bash1");
    const bash2Row = row("bash2");
    check(Boolean(bash1Row) && Boolean(bash2Row), "both adjacent Bash rows render");
    check(
      bash1Row?.closest(".turn-process") === null &&
        bash2Row?.closest(".turn-process") === null,
      "no Bash row is inside any turn-process disclosure",
    );
    check(
      bash1Row?.closest(".turn-run-row") !== null &&
        bash1Row?.closest(".turn-run-row") !== bash2Row?.closest(".turn-run-row"),
      "adjacent Bash rows each render standalone",
    );
    check(
      bash1Row?.closest(".process-activity-group") === null &&
        bash1Row?.closest(".tool-activity-group") === null,
      "Bash rows are not folded into an activity group",
    );
    check(allCollapsed(), "the completed process starts fully collapsed");
    check(
      visible(bash1Row) && visible(bash2Row),
      "Bash rows stay visible with every disclosure collapsed",
    );
    check(
      !visible(row("read")) && !visible(row("grep")),
      "non-run work stays inside its collapsed process",
    );
    // Each process chunk reports its own recorded span, not the whole turn:
    // the pre-Bash chunk ends at 2s and the post-Bash chunk at 1m.
    const chunkTimings = processHeaders().map(
      (header) =>
        header.querySelector(".tool-activity-label")?.textContent ?? "",
    );
    check(
      chunkTimings.length === 2 &&
        chunkTimings[0].includes("2s") &&
        !chunkTimings[0].includes("1m") &&
        chunkTimings[1].startsWith(i18n.t("chat.metaDuration", { time: "1m" })),
      `each process chunk times only itself (${JSON.stringify(chunkTimings)})`,
    );
    // A folded chunk previews the model's last narration under its header;
    // a silent chunk (tools only) renders no preview at all.
    const previews = [...container.querySelectorAll(".turn-process-narration")];
    check(
      previews.length === 1 &&
        previews[0].textContent === "Inspecting the files",
      "a folded chunk previews its last narration and a silent chunk none",
    );
    check(
      bash1Row?.classList.contains("open") !== true,
      "a Bash row keeps its detail closed until opened",
    );
    click(bash1Row?.querySelector<HTMLElement>(".tool-row-header") ?? null);
    check(
      bash1Row?.classList.contains("open") === true,
      "a Bash row opens its own detail on request",
    );

    // Standard density folds the finished turn behind one header that states
    // its duration; the conclusion stays outside, and opening the header shows
    // the narration with one line per step.
    setSettings({ transcriptDensity: "standard" });
    render(mixed, false, null, "flat-standard");
    const turnHeaders = () => processHeaders();
    check(
      turnHeaders().length === 1 &&
        turnHeaders()[0]?.getAttribute("aria-expanded") === "false" &&
        /\d+[smh]/.test(turnHeaders()[0]?.textContent ?? ""),
      "a finished turn folds behind one header stating its duration",
    );
    check(
      (container.textContent ?? "").includes("The fix is ready."),
      "the conclusion stays visible outside the fold",
    );
    check(
      !visible(row("read")) && !visible(row("bash1")),
      "the folded body hides its steps, Bash included",
    );
    click(turnHeaders()[0] ?? null);
    check(
      (container.textContent ?? "").includes("Inspecting the files"),
      "opening the fold reveals the narration",
    );
    check(
      visible(row("read")) && visible(row("bash1")),
      "opening the fold reveals a line per step",
    );
    // A step row carries its content beside the action — the command after
    // "Ran", the path after "Read" — like a thinking row's last line, so no
    // step line reads as a bare verb.
    check(
      (row("bash1")?.textContent ?? "").includes("Ran") &&
        (row("bash1")?.textContent ?? "").includes("pnpm test"),
      "a run step row states the action with its command beside it",
    );
    check(
      (row("read")?.textContent ?? "").includes("src/example.ts"),
      "a read step row carries the file it read beside the action",
    );

    // Detailed density opens the payloads a reader would otherwise click.
    setSettings({ transcriptDensity: "detailed" });
    render(mixed, false, null, "flat-detailed");
    check(
      container.querySelectorAll(".turn-process").length === 0 &&
        visible(row("read")) &&
        visible(row("bash1")),
      "detailed density puts every row in the flow with no fold",
    );
    check(
      row("read")?.classList.contains("open") === true,
      "detailed density opens tool details",
    );
    check(
      container.querySelector(".tool-row.thinking")?.classList.contains("open") === true,
      "detailed density opens completed reasoning rows",
    );

    // A settings switch must reach turns already on screen: the same mounted
    // turn (same key, no re-render call) follows standard <-> detailed.
    setSettings({ transcriptDensity: "standard" });
    render(mixed, false, null, "flat-switch");
    check(
      row("read")?.classList.contains("open") !== true,
      "a mounted standard turn starts with tool details closed",
    );
    setSettings({ transcriptDensity: "detailed" });
    check(
      row("read")?.classList.contains("open") === true &&
        container.querySelector(".tool-row.thinking")?.classList.contains("open") === true,
      "switching a mounted turn to detailed opens its details in place",
    );
    setSettings({ transcriptDensity: "standard" });
    check(
      row("read")?.classList.contains("open") !== true,
      "switching a mounted turn back to standard closes untouched details",
    );
    setSettings();

    // A turn of only Bash calls has no process disclosure at all.
    render([run("only1", "echo 1"), run("only2", "echo 2")], false, null, "only-bash");
    check(
      container.querySelectorAll(".turn-process").length === 0,
      "a Bash-only turn renders no process disclosure",
    );
    check(
      visible(row("only1")) && visible(row("only2")),
      "both Bash-only rows stay visible",
    );

    // Active process content opens while the turn runs and closes when it stops.
    const activeTurn = [intro, read, grep];
    render(activeTurn, true, null, "active");
    check(
      firstProcess() !== null &&
        processHeaders()[0]?.getAttribute("aria-expanded") === "true" &&
        visible(firstProcess()),
      "the active process chunk starts open",
    );
    render(activeTurn, false, null, "active");
    check(
      processHeaders()[0]?.getAttribute("aria-expanded") === "false" &&
        !visible(firstProcess()),
      "an untouched process chunk collapses on completion",
    );

    // A streaming thinking chunk superseded by a later Bash row must not keep a
    // false Thinking header: the real tail is the Bash row.
    const supersededThought = message("thought-before-bash", "assistant", "", {
      thinking: "Reasoning before a command",
      status: "streaming",
    });
    const bashLive = run("bash-live", "pnpm test");
    const thinkingLabel = i18n.t("chat.thinkingFor", { time: "" });
    render([supersededThought, bashLive], true, null, "thinking-to-bash");
    check(
      row("bash-live")?.closest(".turn-process") === null &&
        visible(row("bash-live")),
      "a Bash row that supersedes thinking stays standalone and visible",
    );
    check(
      !processHeaders().some((header) =>
        header
          .querySelector(".tool-activity-label")
          ?.textContent?.startsWith(thinkingLabel),
      ),
      "a superseded thinking chunk does not keep a Thinking header",
    );
    setSettings({ showThinking: false });
    render([supersededThought, bashLive], true, null, "thinking-to-bash-hidden");
    check(
      container.querySelectorAll(".turn-process").length === 0 &&
        visible(row("bash-live")),
      "hidden superseded thinking leaves no empty process and keeps the Bash row",
    );
    setSettings();

    // A separate streamed answer supersedes the thinking chunk the same way.
    const supersededThought2 = message("thought-before-answer", "assistant", "", {
      thinking: "Reasoning before an answer",
      status: "streaming",
    });
    const separateAnswer = message("stream-answer", "assistant", "Answer text", {
      status: "streaming",
    });
    render([supersededThought2, separateAnswer], true, null, "thinking-to-answer");
    check(
      Boolean(row("stream-answer")) &&
        row("stream-answer")?.closest(".turn-process") === null,
      "a separate streamed answer stays outside the process",
    );
    check(
      !processHeaders().some((header) =>
        header
          .querySelector(".tool-activity-label")
          ?.textContent?.startsWith(thinkingLabel),
      ),
      "a separate streamed answer clears the Thinking header",
    );
    setSettings({ showThinking: false });
    render([supersededThought2, separateAnswer], true, null, "thinking-to-answer-hidden");
    check(
      container.querySelectorAll(".turn-process").length === 0 &&
        !container.querySelector(".thinking") &&
        Boolean(row("stream-answer")),
      "hidden thinking superseded by a separate answer leaves no empty process",
    );
    setSettings();

    // Show thinking off: the live indicator stays, completed reasoning leaves
    // nothing behind, and stored reasoning is never deleted.
    const liveThought = message("live-thought", "assistant", "", {
      thinking: "Reasoning before the answer",
      status: "streaming",
    });
    setSettings({ showThinking: false });
    render([liveThought], true, null, "thought-off-live");
    const liveHeader = processHeaders()[0];
    check(
      liveHeader?.querySelector(".tool-activity-label")?.textContent?.startsWith(
        i18n.t("chat.thinkingFor", { time: "" }),
      ),
      "show thinking off keeps the live thinking indicator in the header",
    );
    check(
      Boolean(container.querySelector(".thinking-compact")),
      "show thinking off shows the live thinking row",
    );
    click(liveHeader);
    check(
      allCollapsed() &&
        liveHeader?.querySelector(".tool-activity-label")?.textContent?.startsWith(
          i18n.t("chat.thinkingFor", { time: "" }),
        ),
      "the live thinking indicator stays visible with the process closed",
    );
    render([{ ...liveThought, status: "complete" }], false, null, "thought-off-done");
    check(
      !container.querySelector(".turn-process") && !container.querySelector(".thinking"),
      "completed hidden thinking leaves no empty container",
    );
    check(
      liveThought.thinking === "Reasoning before the answer",
      "hiding thinking never deletes stored reasoning",
    );
    setSettings({ showThinking: true });
    render([{ ...liveThought, status: "complete" }], false, null, "thought-on-done");
    check(
      Boolean(container.querySelector(".tool-row.thinking")),
      "turning show thinking back on restores the completed reasoning row",
    );
    check(
      container.textContent?.includes("Reasoning before the answer"),
      "the restored row shows the retained reasoning text",
    );

    // Search reveal opens the process chunk that owns the named message.
    setSettings();
    render(
      mixed,
      false,
      { sessionId: "s", messageId: "read", query: "read", requestId: 1 },
      "search",
    );
    check(
      processHeaders()[0]?.getAttribute("aria-expanded") === "true" &&
        visible(firstProcess()),
      "search reveals the process chunk that owns the target",
    );

    // The Settings row is a boolean Show thinking toggle.
    let saved: Partial<AppSettings> | undefined;
    const settings: AppSettings = { ...baseSettings, showThinking: false };
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <ShowThinkingRow
            settings={settings}
            saveSettings={async (patch) => {
              saved = patch;
            }}
          />
        </I18nextProvider>,
      ),
    );
    const toggle = container.querySelector<HTMLElement>('[role="switch"]');
    check(
      toggle?.getAttribute("aria-checked") === "false",
      "the Show thinking row reflects the stored preference",
    );
    click(toggle);
    check(
      saved?.showThinking === true,
      "the Show thinking row saves the boolean preference",
    );

    return { ok: true, checks: notes };
  } finally {
    flushSync(() => root.unmount());
    useAppStore.setState({ settings: initialSettings });
    container.remove();
  }
}
