/**
 * Lends this composer to the transcript's selection overlay
 * (`../quote-sink.ts`) while it is mounted, so a quoted selection lands in the
 * draft the user is looking at (ADR 0334).
 *
 * The handle reads through the latest props on every call: a quote arrives
 * from a pointer gesture long after the registration, and the draft, its
 * caret and the references have all moved by then.
 */
import { type RefObject, useEffect, useRef } from "react";
import { insertQuoteIntoDraft } from "../../../../lib/chat-quotes";
import { editorSelectionRange, readEditorValue } from "../editor";
import type { ComposerFileReference } from "../model";
import { registerComposerQuoteSink } from "../quote-sink";

type QuoteSinkSource = {
  ref: RefObject<HTMLDivElement | null>;
  valueRef: { current: string };
  fileReferencesRef: { current: ComposerFileReference[] };
  inputBlocked: boolean;
  applyEditorDraft: (
    text: string,
    references: ComposerFileReference[],
    caret: number,
    focus?: boolean,
  ) => void;
};

export function useComposerQuoteSink(source: QuoteSinkSource): void {
  const latest = useRef(source);
  latest.current = source;

  useEffect(() => {
    return registerComposerQuoteSink((quote) => {
      const current = latest.current;
      if (current.inputBlocked) return false;
      const element = current.ref.current;
      const draft = element ? readEditorValue(element) : current.valueRef.current;
      // An unfocused composer reports the end of the draft, which is where a
      // quote belongs when the user is reading the conversation.
      const selection = element
        ? editorSelectionRange(element)
        : { start: draft.length, end: draft.length };
      const next = insertQuoteIntoDraft(draft, selection, quote);
      current.applyEditorDraft(next.text, [...current.fileReferencesRef.current], next.caret);
      return true;
    });
  }, []);
}
