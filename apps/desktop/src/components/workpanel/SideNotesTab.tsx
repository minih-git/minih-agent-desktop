import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTranscriptView } from "../../hooks/use-transcript-view";
import { sideNoteInputState, sideNotesFromMessages } from "../../lib/side-notes";
import { sessionAllows } from "../../lib/remote-session-safety";
import { useAppStore } from "../../stores/app-store";
import { IconArrowUp, IconChat, IconSparkles } from "../icons";
import { Markdown } from "../Markdown";
import { Button, Textarea } from "../ui";
import { WorkTabEmpty } from "./WorkTabEmpty";

/** Independent question/answer history. Nothing here steers the main task. */
export function SideNotesTab() {
  const { t } = useTranslation();
  const sessionId = useAppStore(state => state.activeSessionId);
  const session = useAppStore(state => state.sessions.find(row => row.id === sessionId));
  const sendSideNote = useAppStore(state => state.sendSideNote);
  const loadSideNotes = useAppStore(state => state.loadSideNotes);
  const notes = useAppStore(state => sessionId ? state.sideNotes[sessionId] : undefined);
  const pending = useAppStore(state => sessionId ? state.sideNotePending[sessionId] : undefined);
  const running = useAppStore(state => sessionId ? (state.runningSessions[sessionId] ?? false) : false);
  const turnId = useAppStore(state => sessionId ? state.agentStatuses[sessionId]?.currentTurnId : undefined);
  const planPending = useAppStore(state => sessionId ? state.pendingPlans[sessionId]?.status === "pending" : false);
  const transcript = useTranscriptView(sessionId ?? "");
  const legacy = useMemo(() => sideNotesFromMessages(transcript.messages), [transcript.messages]);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLOListElement | null>(null);
  const ready = Boolean(sessionId && session && !sessionId.startsWith("native-pi:") && sessionAllows(session, "canSteer")) &&
    sideNoteInputState({ running, turnId, planPending }) === "ready";
  useEffect(() => { if (sessionId) void loadSideNotes(sessionId); }, [sessionId, loadSideNotes]);
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [legacy.length, notes?.length, pending]);

  const send = async (text: string) => {
    if (!text.trim() || !ready || pending) return;
    if (await sendSideNote(text)) setDraft(current => current === text ? "" : current);
  };

  return (
    <div className="side-notes-tab">
      {legacy.length || notes?.length || pending ? (
        <ol ref={listRef} className="side-notes-list" aria-label={t("panel.tabs.sideNotes")}>
          {legacy.map(note => (
            <li className="side-note-row is-legacy" key={note.id}>
              <div className="side-note-question">
                <strong>{t("panel.sideNotes.question")}</strong>
                <div className="side-note-question-text selectable">{note.content}</div>
              </div>
            </li>
          ))}
          {notes?.map(note => (
            <li className="side-note-row" key={note.id}>
              <div className="side-note-question">
                <strong>{t("panel.sideNotes.question")}</strong>
                <div className="side-note-question-text selectable">{note.question}</div>
              </div>
              <div className="side-note-answer">
                <strong>{t("panel.sideNotes.answer")}</strong>
                <div className="side-note-answer-body prose-chat selectable">
                  <Markdown source={note.answer} />
                </div>
              </div>
            </li>
          ))}
          {pending ? (
            <li className="side-note-row is-pending" aria-busy="true">
              <div className="side-note-question">
                <strong>{t("panel.sideNotes.question")}</strong>
                <div className="side-note-question-text selectable">{pending}</div>
              </div>
              <div className="side-note-answer is-pending">
                <strong>{t("panel.sideNotes.answer")}</strong>
                <p className="side-note-status" role="status">
                  <span className="side-note-status-dot" aria-hidden="true" />
                  <span>{t("panel.sideNotes.answering")}</span>
                </p>
              </div>
            </li>
          ) : null}
        </ol>
      ) : <WorkTabEmpty icon={IconChat} title={t("panel.sideNotes.emptyTitle")} body={t("panel.sideNotes.emptyBody")} />}
      <div className="side-notes-composer">
        <div className="side-notes-composer-shell">
          <Textarea className="side-notes-input" rows={2} value={draft} disabled={!ready && !pending}
            aria-label={t("panel.sideNotes.inputLabel")}
            placeholder={t(ready ? "panel.sideNotes.placeholder" : "panel.sideNotes.idlePlaceholder")}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault(); void send(draft);
            }} />
          <div className="side-notes-actions">
            <Button type="button" variant="secondary" size="sm" className="side-notes-preset" disabled={!ready || Boolean(pending)}
              onClick={() => void send(t("panel.sideNotes.presetProgress"))}>
              <IconSparkles size={12} aria-hidden="true" />
              <span>{t("panel.sideNotes.presetProgressLabel")}</span>
            </Button>
            <Button type="button" variant="primary" size="sm" className="side-notes-send" disabled={!ready || Boolean(pending) || !draft.trim()}
              onClick={() => void send(draft)}>
              <span>{t("panel.sideNotes.send")}</span>
              <IconArrowUp size={13} aria-hidden="true" />
            </Button>
          </div>
        </div>
        <p className="side-notes-hint">{t(ready ? "panel.sideNotes.hint" : "panel.sideNotes.idleHint")}</p>
      </div>
    </div>
  );
}
