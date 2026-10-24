import { useTranslation } from "react-i18next";

/**
 * The follow-up suggestion rendered in the composer's placeholder slot: grey
 * ghost text that sends itself on click. It is a real button sized to the
 * suggestion text, so clicking the empty area of the input keeps its ordinary
 * focus-and-type behavior instead of sending.
 */
export function ComposerFollowUp({
  text,
  onSend,
}: {
  text: string;
  onSend: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="composer-placeholder composer-followup"
      title={t("chat.followUpSuggestionSend")}
      onClick={onSend}
    >
      {text}
    </button>
  );
}
