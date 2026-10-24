import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useRef } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@minih-agent/i18n";
import tokensCss from "../../apps/desktop/src/styles/tokens.css";
import uiKitCss from "../../apps/desktop/src/styles/ui-kit.css";
import overlaysCss from "../../apps/desktop/src/styles/overlays.css";
import { Markdown } from "../../apps/desktop/src/components/Markdown";
import { SelectionQuoteButton } from "../../apps/desktop/src/features/chat/transcript/SelectionQuoteButton";
import { useComposerQuoteSink } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerQuoteSink";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import {
  paintEditorValue,
  setEditorCaret,
} from "../../apps/desktop/src/features/chat/composer/editor";
import type { ComposerFileReference } from "../../apps/desktop/src/features/chat/composer/model";

declare global {
  var selectionQuoteProbe: () => Promise<unknown>;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function assertEqual(actual: string, expected: string, what: string): void {
  assert(
    actual === expected,
    `${what} was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  );
}

const FIRST_ANSWER = [
  "The identity $a^2+b^2=c^2$ closes the proof.",
  "",
  "```js",
  "const answer = 42;",
  "```",
  "",
  // Two consecutive blank lines are the point: a collapse of them would quote
  // a program that is not the one on screen.
  "```python",
  "def f():",
  "    a = 1",
  "",
  "",
  "    b = 2",
  "```",
  "",
  "| left | right |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "- first item",
  "- second item",
  "",
  "## A heading",
].join("\n");

const SECOND_ANSWER = "A second answer that is not part of the first.";

/** Row chrome that must never reach the draft, in the shape the turn renders. */
const TOOL_OUTPUT = "TOOL-ROW-PAYLOAD";
const META_TEXT = "META-CHIP-TOKENS";

/**
 * The real sink, the real painter and a real contenteditable, so the assertions
 * below are made against the draft a user would have typed into rather than
 * against a stand-in for it. The store is given a session and `window.minihAgent`
 * serves `composerPasteFiles` from memory, so a quote produces the production
 * chip: persisted, expanded from its token, and painted.
 */
function FixtureComposer({
  editorRef,
  onDraft,
  blocked = false,
}: {
  editorRef: { current: HTMLDivElement | null };
  onDraft: (draft: string) => void;
  blocked?: boolean;
}) {
  const valueRef = useRef("");
  const fileReferencesRef = useRef<ComposerFileReference[]>([]);
  const paint = (element: HTMLDivElement, text: string) =>
    paintEditorValue(element, text, new Map(), () => "", "", () => {}, () => {}, () => {}, () => {});
  useComposerQuoteSink({
    ref: editorRef,
    inputBlocked: blocked,
    applyEditorDraft: (text, references, caret, focus) => {
      valueRef.current = text;
      fileReferencesRef.current = references;
      const element = editorRef.current;
      if (!element) return;
      paint(element, text);
      setEditorCaret(element, caret);
      // The real controller focuses unless the caller says otherwise.
      if (focus !== false) element.focus();
      onDraft(text);
    },
    snapshotReferences: () => [],
  });
  return (
    <div className="composer-dock" data-composer-dock="docked">
      <div
        className="composer-editor"
        contentEditable
        suppressContentEditableWarning
        ref={(node) => {
          editorRef.current = node;
        }}
      />
    </div>
  );
}

globalThis.selectionQuoteProbe = async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${uiKitCss}\n${overlaysCss}`;
  document.head.append(style);

  /*
    The quote lands as an attachment chip through the production paste path, so
    the bridge gets an in-memory `composerPasteFiles` and the store gets one
    active session — the same pieces the desktop window would provide. The
    saved name is recorded so the assertions can tie the chip to its paste.
  */
  const savedFiles: { name: string; sessionId: string; text: string }[] = [];
  (window as unknown as { minihAgent: unknown }).minihAgent = {
    invoke: async (channel: string, payload: { sessionId?: string; files?: { name?: string; data?: ArrayBuffer }[] }) => {
      if (channel !== "minih-agent-desktop/composer/pasteFiles") {
        throw new Error(`unexpected channel: ${channel}`);
      }
      const sessionId = payload?.sessionId ?? "";
      const files = (payload?.files ?? []).map((file, index) => ({
        path: `/tmp/scratch/${sessionId}/quoted-${savedFiles.length}-${index}.txt`,
        name: file?.name ?? `quoted-${index}.txt`,
        kind: "file" as const,
        mimeType: "text/plain",
        size: file?.data?.byteLength ?? 0,
      }));
      for (let index = 0; index < files.length; index += 1) {
        const data = payload?.files?.[index]?.data;
        savedFiles.push({
          name: files[index].name,
          sessionId,
          text: data ? new TextDecoder().decode(data) : "",
        });
      }
      return { ok: true as const, data: { files } };
    },
  };
  useAppStore.setState({ activeSessionId: "e2e-session" });
  const sessionLog: (string | undefined)[] = [];
  useAppStore.subscribe((state) => {
    sessionLog.push(state.activeSessionId);
  });

  // A 320px-tall scroller with the composer docked under it: the pill has to
  // stay in the band between them, which is the geometry this fixture checks.
  const scroller = document.createElement("div");
  scroller.className = "thread-scroll";
  scroller.style.cssText =
    "position:absolute;left:0;top:0;width:560px;height:320px;overflow:auto";
  document.body.append(scroller);
  const host = document.createElement("div");
  host.className = "thread-content";
  scroller.append(host);
  const editorRef: { current: HTMLDivElement | null } = { current: null };
  const drafts: string[] = [];
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <div data-minimap-id="row-a" data-case="a">
          <div className="prose-chat">
            <Markdown source={FIRST_ANSWER} />
          </div>
          {/* The turn's process/tool row and meta chips live inside the same
            * quotable row, which is what makes them worth a case each. */}
          <div className="tool-row" data-case="tool">
            <div className="tool-row-head">
              <span className="tool-row-name">Bash</span>
            </div>
            <pre>{TOOL_OUTPUT}</pre>
          </div>
          <div className="message-meta" data-case="meta">
            <span className="message-meta-chip model">minih-model</span>
            <span className="message-meta-chip">{META_TEXT}</span>
          </div>
        </div>
        <div data-minimap-id="row-b" className="prose-chat" data-case="b">
          <Markdown source={SECOND_ANSWER} />
        </div>
        <SelectionQuoteButton scrollRef={{ current: scroller }} />
        <div style={{ height: "120px" }} />
        <FixtureComposer editorRef={editorRef} onDraft={(draft) => drafts.push(draft)} />
      </I18nextProvider>,
    ),
  );

  const selection = window.getSelection();
  assert(selection, "the document has no selection");
  const row = (name: string) => {
    const element = host.querySelector<HTMLElement>(`[data-case="${name}"]`);
    assert(element, `row ${name} did not render`);
    return element;
  };
  const block = (selector: string) => {
    const element = row("a").querySelector<HTMLElement>(selector);
    assert(element, `${selector} did not render`);
    return element;
  };
  const pill = () => document.querySelector<HTMLElement>('[data-testid="selection-quote"]');
  /*
    The overlay schedules its own work on an animation frame, so the fixture has
    to wait for real frames — and to say so when there are none, which is what a
    throttled renderer looks like from inside the page.
  */
  let rafAlive = 0;
  const frames = async () => {
    const start = rafAlive;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 400);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          clearTimeout(timer);
          resolve(undefined);
        }),
      );
    });
    rafAlive += 1;
    if (rafAlive === start) throw new Error("no animation frames ran in this renderer");
  };
  const diagnostics = () => {
    const range = selection.rangeCount ? selection.getRangeAt(0) : null;
    const node = range?.startContainer ?? null;
    const element = node?.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
    return {
      rafAlive,
      selection: range ? range.toString().slice(0, 60) : null,
      row: element?.closest?.("[data-minimap-id]")?.getAttribute("data-minimap-id") ?? null,
      pill: Boolean(pill()),
      // A quote persisted for diagnostics: never an empty chip in the draft.
      sink: savedFiles.length,
      sessions: [...sessionLog],
      editor: Boolean(editorRef.current),
      html: host.innerHTML.slice(0, 200),
    };
  };

  /** A pointer drag that ends with `range` selected, then one settled frame. */
  const drag = async (range: Range, target: Element = row("a")) => {
    window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    selection.removeAllRanges();
    selection.addRange(range);
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
    await frames();
  };
  const contentsOf = (element: Element): Range => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range;
  };
  /**
   * Drag over `element`, then run the pill's only action. The block is scrolled
   * into the middle of the thread first: a selection that is entirely clipped
   * has no visible anchor and correctly floats nothing. The action is async —
   * the chip lands after the paste round-trip — so the wait covers it.
   */
  const quote = async (element: Element) => {
    (element as HTMLElement).scrollIntoView?.({ block: "center" });
    await frames();
    await drag(contentsOf(element));
    const overlay = pill();
    assert(overlay, "the pill did not appear");
    const button = overlay.querySelector<HTMLButtonElement>("button");
    assert(button, "the pill has no action");
    button.click();
    await frames();
    await frames();
  };

  const cases: string[] = [];

  // 1) A sentence with a formula quotes as the TeX it was written in, and the
  //    action consumes its selection and leaves focus in the composer.
  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      throw new Error(`${name}: ${String(error)} :: ${JSON.stringify(diagnostics())}`);
    }
  };
  await step("formula", async () => {
    await quote(block("p"));
    const draft = drafts.at(-1) ?? "";
    assert(
      /^[\uE000-\uF8FF]$/.test(draft),
      `quoted formula sentence becomes one attachment chip, got ${JSON.stringify(draft)}`,
    );
    assert(!pill(), "the pill must not survive its own action");
    assert(selection.isCollapsed, "the action consumes its selection");
    assert(document.activeElement === editorRef.current, "focus lands in the composer");
  });
  cases.push("formula");

  // 2) A code block keeps its fence and its language, and the second quote
  //    appends its own chip to the live draft.
  await step("code", () => quote(block(".code-block")));
  const draft2 = drafts.at(-1) ?? "";
  assert(
    /^[\uE000-\uF8FF][\uE000-\uF8FF]$/.test(draft2),
    `a second quote appends its chip to the draft, got ${JSON.stringify(draft2)}`,
  );
  cases.push("code");

  // 3) A table row is one line and a heading keeps its level: the Markdown
  //    reduction runs before persistence, so the chip's file holds the source.
  await step("table", () => quote(block("table")));
  /*
    A heading or list item is the range's *ancestor* when its own text is all
    that is selected, so its marker can only be read when the selection spans
    the block. That is what this case drags: from the first list item through
    the heading after it.
  */
  await step("blocks", async () => {
    const spanning = document.createRange();
    spanning.selectNodeContents(block("ul"));
    spanning.setEnd(block("h2"), block("h2").childNodes.length);
    await drag(spanning);
    const overlay = pill();
    assert(overlay, "the pill did not appear for the block range");
    overlay.querySelector<HTMLButtonElement>("button")?.click();
    await frames();
    await frames();
  });
  cases.push("table", "blocks");

  // 4) A code block whose body carries two blank lines keeps them: the fenced
  //    body is quoted verbatim, and the reduction never collapses it.
  await step("code-blank", async () => {
    const python = row("a").querySelectorAll(".code-block")[1];
    assert(python, "the python block did not render");
    await quote(python);
    const text = savedFiles.at(-1)?.text ?? "";
    assert(
      text === "```python\ndef f():\n    a = 1\n\n\n    b = 2\n```",
      `blank lines inside a fence must survive, got ${JSON.stringify(text)}`,
    );
  });
  cases.push("code-blank");

  // 4b) Each quote persisted exactly one text file named for a quote.
  assertEqual(savedFiles.length, 5, "one file per quote");
  assert(
    savedFiles.every((file) => file.name.startsWith("quoted-text-") && file.sessionId === "e2e-session"),
    `the quotes persisted through the paste path, got ${JSON.stringify(savedFiles)}`,
  );

  // 5) A drag that starts in the answer and ends in the meta chips quotes the
  //    answer only: the chips are chrome, not conversation text.
  await step("meta", async () => {
    const heading = block("h2");
    const meta = row("a").querySelector("[data-case=\"meta\"]");
    assert(meta, "the meta chips did not render");
    // A selection with no visible part has nowhere to anchor; bring the drag's
    // own range into the scroller's middle first.
    heading.scrollIntoView?.({ block: "center" });
    await frames();
    const range = document.createRange();
    range.setStart(heading, 0);
    range.setEnd(meta, meta.childNodes.length);
    await drag(range);
    const overlay = pill();
    assert(overlay, "the pill did not appear for the answer-to-meta drag");
    overlay.querySelector<HTMLButtonElement>("button")?.click();
    await frames();
    await frames();
    assertEqual(savedFiles.length, 6, "the answer-to-meta drag persisted one quote");
    const text = savedFiles.at(-1)?.text ?? "";
    assert(!text.includes(META_TEXT), `meta chip text reached the quote: ${JSON.stringify(text.slice(-80))}`);
    assert(!text.includes(TOOL_OUTPUT), "the tool payload must not be quoted");
    assert(text.endsWith("## A heading"), `the quote must end at the answer text: ${JSON.stringify(text.slice(-80))}`);
  });
  cases.push("meta");

  // 6) A gesture that starts inside a tool row floats nothing.
  await step("tool-row", async () => {
    const tool = row("a").querySelector("[data-case=\"tool\"]");
    assert(tool, "the tool row did not render");
    await drag(contentsOf(tool));
    assert(!pill(), "a selection inside a tool row must not float a pill");
    assert(!(drafts.at(-1) ?? "").includes(TOOL_OUTPUT), "tool output must not be quoted");
  });
  cases.push("tool-row");

  // 4) A selection that spans two rows floats nothing.
  const spanning = document.createRange();
  spanning.selectNodeContents(row("a"));
  spanning.setEnd(row("b"), 0);
  await drag(spanning);
  assert(!pill(), "a cross-row selection must not float a pill");
  cases.push("cross-row");

  // 5) The pill is clamped into the scroller and stays above the docked
  //    composer, which floats over the bottom of the thread.
  const dock = document.querySelector<HTMLElement>('[data-composer-dock="docked"]');
  assert(dock, "the fixture has no docked composer");
  dock.style.cssText = "position:fixed;left:0;bottom:0;width:100%;height:150px";
  await frames();
  await drag(contentsOf(block("h2")));
  const overlay = pill();
  assert(overlay, "the pill did not appear for the clamp case");
  const box = overlay.getBoundingClientRect();
  const dockTop = dock.getBoundingClientRect().top;
  const scrollerBox = scroller.getBoundingClientRect();
  assert(box.width > 0 && box.height > 0, "the pill has no measured size");
  assert(box.bottom <= dockTop, `the pill covers the composer (${box.bottom} > ${dockTop})`);
  assert(box.left >= scrollerBox.left, "the pill left the scroller on the left");
  assert(box.right <= scrollerBox.right, "the pill left the scroller on the right");
  cases.push("clamp");

  return { ok: true, cases, drafts, saved: savedFiles.map((file) => file.name) };
};
