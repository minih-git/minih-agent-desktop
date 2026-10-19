import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTranscriptView } from "../../hooks/use-transcript-view";
import { sideNoteInputState, sideNotesFromMessages } from "../../lib/side-notes";
import { useAppStore } from "../../stores/app-store";
import { IconChat } from "../icons";
import { Button, Textarea } from "../ui";
import { WorkTabEmpty } from "./WorkTabEmpty";

/**
 * The per-session side-notes tab (ADR active-turn-steering).
 *
 * A note reaches the running turn through the same channel the Composer's
 * Alt+Enter uses: the turn keeps its task and answers the note at its next safe
 * point, so nothing here interrupts or replaces the work in progress. The list
 * reads the session's own transcript — the durable rows carry the `sideNote`
 * marker — so a reload shows the same notes without a second store.
 */
export function SideNotesTab() {
  const { t } = useTranslation();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const sendSideNote = useAppStore((state) => state.sendSideNote);
  const running = useAppStore((state) =>
    sessionId ? (state.runningSessions[sessionId] ?? false) : false,
  );
  const turnId = useAppStore((state) =>
    sessionId ? state.agentStatuses[sessionId]?.currentTurnId : undefined,
  );
  const planPending = useAppStore((state) =>
    sessionId ? state.pendingPlans[sessionId]?.status === "pending" : false,
  );
  const transcript = useTranscriptView(sessionId ?? "");
  const notes = useMemo(
    () => sideNotesFromMessages(transcript.messages),
    [transcript.messages],
  );
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const ready =
    sideNoteInputState({ running, turnId, planPending }) === "ready";

  const send = async (text: string) => {
    const note = text.trim();
    if (!note || !ready || sending) return;
    setSending(true);
    try {
      // A refused note keeps its text so the user can send it again.
      if (await sendSideNote(note)) {
        setDraft((current) => current === text ? "" : current);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="side-notes-tab">
      {notes.length ? (
        <ol className="side-notes-list" aria-label={t("panel.tabs.sideNotes")}>
          {notes.map((note) => (
            <li className="side-note-row" key={note.id}>
              {note.content}
            </li>
          ))}
        </ol>
      ) : (
        <WorkTabEmpty
          icon={IconChat}
          title={t("panel.sideNotes.emptyTitle")}
          body={t("panel.sideNotes.emptyBody")}
        />
      )}
      <div className="side-notes-composer">
        <Textarea
          className="side-notes-input"
          rows={2}
          value={draft}
          disabled={!ready}
          aria-label={t("panel.sideNotes.inputLabel")}
          placeholder={t(
            ready
              ? "panel.sideNotes.placeholder"
              : "panel.sideNotes.idlePlaceholder",
          )}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.shiftKey ||
              event.nativeEvent.isComposing
            ) {
              return;
            }
            event.preventDefault();
            void send(draft);
          }}
        />
        <div className="side-notes-actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="side-notes-preset"
            disabled={!ready || sending}
            onClick={() => void send(t("panel.sideNotes.presetProgress"))}
          >
            {t("panel.sideNotes.presetProgressLabel")}
          </Button>
          <Button
            type="button"
            size="sm"
            className="side-notes-send"
            disabled={!ready || sending || !draft.trim()}
            onClick={() => void send(draft)}
          >
            {t("panel.sideNotes.send")}
          </Button>
        </div>
        <p className="side-notes-hint">
          {t(ready ? "panel.sideNotes.hint" : "panel.sideNotes.idleHint")}
        </p>
      </div>
    </div>
  );
}
