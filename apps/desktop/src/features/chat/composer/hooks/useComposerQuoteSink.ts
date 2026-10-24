/**
 * Lends this composer to the transcript's selection overlay
 * (`../quote-sink.ts`) while it is mounted, so a quoted selection lands in the
 * draft the user is looking at (ADR 0334, amended by D681).
 *
 * The quote persists the excerpt through the same paste path a large clipboard
 * text takes (`api.pasteFiles` into the session scratch) and lands as the same
 * attachment chip: the pill's result matches what pasting the selection by
 * hand produces. Materializing a draft session for a home draft is the paste
 * path's own behavior, not the pill's. A persistence failure is reported
 * through the toast host and rethrown, so the pill neither dismisses nor
 * stacks a second message on it.
 *
 * The handle reads through the latest props on every call: a quote arrives
 * from a pointer gesture long after the registration, and the draft, its
 * caret and the references have all moved by then.
 */
import { type RefObject, useEffect, useRef } from "react";
import { materializeDraftSession, useAppStore } from "../../../../stores/app-store";
import { api } from "../../../../lib/api";
import {
  deleteComposerDraft,
  draftFileReference,
  HOME_DRAFT_KEY,
  writeComposerDraft,
} from "../../../../lib/composer-draft-cache";
import type { ComposerDraftFileReference } from "../../../../lib/composer-smart-stop";
import {
  createFileReference,
  editorSelectionRange,
  nextChipToken,
  readEditorValue,
} from "../editor";
import type { ComposerFileReference } from "../model";
import { registerComposerQuoteSink } from "../quote-sink";

type QuoteSinkSource = {
  ref: RefObject<HTMLDivElement | null>;
  inputBlocked: boolean;
  applyEditorDraft: (
    text: string,
    references: ComposerFileReference[],
    caret: number,
    focus?: boolean,
  ) => void;
  snapshotReferences: (sourceSessionId: string) => ComposerDraftFileReference[];
};

type QuoteSinkHandle = QuoteSinkSource & { editor: HTMLDivElement };

/**
 * Persist `quote` into the session scratch and insert its chip at the editor's
 * caret. The draft is read again after the paste round-trip: the user may have
 * typed while it was in flight, and an unfocused composer reports the end of
 * the draft, which is where a quote belongs when they are only reading.
 */
async function pasteQuoteAsChip(
  { editor, applyEditorDraft, snapshotReferences }: QuoteSinkHandle,
  quote: string,
): Promise<void> {
  const sourceSessionId = useAppStore.getState().activeSessionId;
  try {
    let sessionId = sourceSessionId ?? "";
    if (!sessionId) sessionId = (await materializeDraftSession()) ?? "";
    if (!sessionId) throw new Error("session unavailable");
    const bytes = new TextEncoder().encode(quote);
    const result = await api.pasteFiles(sessionId, [
      {
        name: `quoted-text-${crypto.randomUUID().slice(0, 8)}.txt`,
        mimeType: "text/plain",
        data: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      },
    ]);
    const chip = result.files[0];
    if (!chip) throw new Error("quote persistence failed");
    const token = nextChipToken();
    const reference = createFileReference(chip.path, chip.name, sessionId, {
      kind: chip.kind,
      mimeType: chip.mimeType,
      token,
    });
    const liveValue = readEditorValue(editor);
    const { start, end } = editorSelectionRange(editor);
    const nextText = liveValue.slice(0, start) + token + liveValue.slice(end);
    const previousReferences = snapshotReferences(sourceSessionId ?? "");
    const nextReferences = [
      ...previousReferences.map((item) =>
        createFileReference(item.path, item.name, sessionId, item),
      ),
      reference,
    ];
    // The key of a session draft is the session's own id; a quote that started
    // on the home draft materialized that draft into a session, and a stale
    // home snapshot must not come back on top of it.
    writeComposerDraft(sessionId, {
      text: nextText,
      fileReferences: [...previousReferences, draftFileReference(reference)],
    });
    if (useAppStore.getState().activeSessionId === sessionId) {
      applyEditorDraft(nextText, nextReferences, start + token.length);
    } else if (!sourceSessionId) {
      deleteComposerDraft(HOME_DRAFT_KEY);
    }
  } catch (error) {
    useAppStore
      .getState()
      .showToast(
        error instanceof Error ? error.message : String(error),
        { variant: "error" },
      );
    throw error;
  }
}

export function useComposerQuoteSink(source: QuoteSinkSource): void {
  const latest = useRef(source);
  latest.current = source;

  useEffect(() => {
    let inFlight = false;
    return registerComposerQuoteSink(async (quote) => {
      const current = latest.current;
      if (current.inputBlocked || inFlight) return false;
      const element = current.ref.current;
      if (!element) return false;
      inFlight = true;
      try {
        await pasteQuoteAsChip({ ...current, editor: element }, quote);
        return true;
      } finally {
        inFlight = false;
      }
    });
  }, []);
}
