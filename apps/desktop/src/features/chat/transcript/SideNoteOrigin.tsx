import { useTranslation } from "react-i18next";
import { IconChat } from "../../../components/icons";

/**
 * Marks a user row that was sent as a side note to a running turn (ADR
 * active-turn-steering). The marker is the renderer's whole claim about the
 * row: the note was answered inside the turn it was sent to and never replaced
 * that turn's task, which is also why Stop keeps the row as history.
 */
export function SideNoteOrigin() {
  const { t } = useTranslation();
  return (
    <div className="side-note-origin">
      <span className="side-note-kind">
        <IconChat size={13} aria-hidden />
        {t("chat.sideNote")}
      </span>
    </div>
  );
}
