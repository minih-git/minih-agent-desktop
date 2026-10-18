import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@minih-agent/i18n";
import type { AppSettings, UiMessage } from "@minih-agent/shared";
import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

/*
 * The detailed density opens every tool body at once. Shiki tokenizes on the
 * renderer's main thread, so highlighting the code of every body a retained
 * pane holds — including a pane hidden behind another page — blocked the
 * renderer for seconds on a long session. Code bodies therefore wait for their
 * own visibility: a hidden pane stays plain text, and the tokens land once the
 * block is on screen. Both halves are asserted here on the production
 * transcript components.
 */

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const createdAt = "2026-09-17T00:00:00.000Z";
const message = (
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage => ({ id, role, content, createdAt, status: "complete", ...extra });

const frame = (): Promise<void> =>
  new Promise((resolve) => {
    const budget = window.setTimeout(resolve, 120);
    window.requestAnimationFrame(() => {
      window.clearTimeout(budget);
      resolve();
    });
  });

/** Polls until `done` or the frame budget runs out; returns whether it settled. */
async function until(done: () => boolean, frames = 60): Promise<boolean> {
  for (let attempt = 0; attempt < frames; attempt++) {
    if (done()) return true;
    await frame();
  }
  return done();
}

const SOURCE_LINES = 12;
const source = Array.from(
  { length: SOURCE_LINES },
  (_, index) => `export const value${index} = ${index};`,
).join("\n");

export async function transcriptHighlightProbe() {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  const messages: UiMessage[] = [
    message("highlight-user", "user", "Read the file"),
    message("highlight-read", "tool", "", {
      toolName: "Read",
      toolCallId: "call-highlight-read",
      toolStatus: "success",
      toolArgs: { path: "src/example.ts" },
      toolResult: { details: { content: source } },
    }),
    message("highlight-answer", "assistant", "Done."),
  ];
  const entry = buildTranscriptEntries(messages).entries.find(
    (item) => item.kind === "assistant-turn",
  );
  assert(entry?.kind === "assistant-turn", "highlight probe mounted no turn");
  const initialSettings = useAppStore.getState().settings;
  const baseSettings: AppSettings = {
    defaultMode: "agent",
    theme: "light",
    enterToSend: true,
    onboardingDismissed: true,
    showThinking: true,
    ...initialSettings,
    transcriptDensity: "standard",
  };
  const setDensity = (transcriptDensity: AppSettings["transcriptDensity"]) =>
    flushSync(() =>
      useAppStore.setState({
        settings: { ...baseSettings, transcriptDensity },
      }),
    );
  // A retained pane that another page covers keeps its box but is taken out of
  // rendering, exactly like `.session-pane[data-visible="false"]`.
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;top:0;left:0;width:640px;height:480px;overflow:auto;" +
    "visibility:hidden;content-visibility:hidden";
  document.body.append(host);
  const errors: unknown[] = [];
  const root = createRoot(host, {
    onUncaughtError: (error) => errors.push(error),
  });
  const tokens = () => host.querySelectorAll(".tool-row-body pre span[style]").length;
  const body = () => host.querySelector<HTMLElement>(".tool-row-body pre");
  const notes: string[] = [];
  const check = (value: unknown, note: string) => {
    assert(value, note);
    notes.push(note);
  };
  try {
    setDensity("standard");
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <AssistantTurn entry={entry} isActive={false} />
        </I18nextProvider>,
      ),
    );
    setDensity("detailed");
    await until(() => Boolean(body()));
    check(Boolean(body()), "detailed density opens the tool body of a covered pane");
    check(
      (body()?.textContent ?? "").includes("export const value0 = 0;"),
      "the covered tool body keeps its code text",
    );
    // The highlighter only runs once it can be seen: a covered pane must not
    // tokenize the code every detail row holds.
    await frame();
    await frame();
    check(tokens() === 0, "a covered tool body starts as plain text");

    host.style.visibility = "visible";
    host.style.contentVisibility = "visible";
    check(
      await until(() => tokens() > 0),
      "revealing the pane highlights its code",
    );
    check(
      (body()?.textContent ?? "").includes("export const value0 = 0;"),
      "highlighting keeps the code text",
    );
    check(errors.length === 0, `React reported no error (${errors.map(String)})`);
    return { ok: true, notes };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    flushSync(() => useAppStore.setState({ settings: initialSettings }));
  }
}
