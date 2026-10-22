import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTranscriptView } from "../../hooks/use-transcript-view";
import { sideNoteInputState, sideNotesFromMessages } from "../../lib/side-notes";
import { sessionAllows } from "../../lib/remote-session-safety";
import { useAppStore } from "../../stores/app-store";
import { IconChat } from "../icons";
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
  const ready = Boolean(sessionId && session && !sessionId.startsWith("native-pi:") && sessionAllows(session, "canSteer")) &&
    sideNoteInputState({ running, turnId, planPending }) === "ready";
  useEffect(() => { if (sessionId) void loadSideNotes(sessionId); }, [sessionId, loadSideNotes]);

  const send = async (text: string) => {
    if (!text.trim() || !ready || pending) return;
    if (await sendSideNote(text)) setDraft(current => current === text ? "" : current);
  };

  return (
    <div className="side-notes-tab">
      {legacy.length || notes?.length || pending ? (
        <ol className="side-notes-list" aria-label={t("panel.tabs.sideNotes")}>
          {legacy.map(note => <li className="side-note-row" key={note.id}>{note.content}</li>)}
          {notes?.map(note => (
            <li className="side-note-row" key={note.id}>
              <div className="side-note-question"><strong>{t("panel.sideNotes.question")}</strong><div>{note.question}</div></div>
              <div className="side-note-answer"><strong>{t("panel.sideNotes.answer")}</strong><Markdown source={note.answer} /></div>
            </li>
          ))}
          {pending ? <li className="side-note-row" aria-busy="true"><div>{pending}</div><p role="status">{t("panel.sideNotes.answering")}</p></li> : null}
        </ol>
      ) : <WorkTabEmpty icon={IconChat} title={t("panel.sideNotes.emptyTitle")} body={t("panel.sideNotes.emptyBody")} />}
      <div className="side-notes-composer">
        <Textarea className="side-notes-input" rows={2} value={draft} disabled={!ready && !pending}
          aria-label={t("panel.sideNotes.inputLabel")}
          placeholder={t(ready ? "panel.sideNotes.placeholder" : "panel.sideNotes.idlePlaceholder")}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault(); void send(draft);
          }} />
        <div className="side-notes-actions">
          <Button type="button" variant="ghost" size="sm" className="side-notes-preset" disabled={!ready || Boolean(pending)}
            onClick={() => void send(t("panel.sideNotes.presetProgress"))}>{t("panel.sideNotes.presetProgressLabel")}</Button>
          <Button type="button" size="sm" className="side-notes-send" disabled={!ready || Boolean(pending) || !draft.trim()}
            onClick={() => void send(draft)}>{t("panel.sideNotes.send")}</Button>
        </div>
        <p className="side-notes-hint">{t(ready ? "panel.sideNotes.hint" : "panel.sideNotes.idleHint")}</p>
      </div>
    </div>
  );
}
