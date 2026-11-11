import { useTranslation } from "react-i18next";
import { IconChat } from "../../../components/icons";

/**
 * Marks a delegate's own user row: an instruction the agent that started the
 * delegation injected while it was still running (ADR
 * parent-steers-running-delegation).
 *
 * The marker is the whole claim this row makes. The row is instruction, not a
 * user message: it complemented the brief the delegate already had and never
 * came from the person watching the session, which is why it renders inside the
 * delegation and not in the turn stream.
 */
export function DelegateInstructionOrigin() {
  const { t } = useTranslation();
  return (
    <div className="delegate-instruction-origin">
      <span className="delegate-instruction-kind">
        <IconChat size={13} aria-hidden />
        {t("chat.delegateInstruction")}
      </span>
    </div>
  );
}
