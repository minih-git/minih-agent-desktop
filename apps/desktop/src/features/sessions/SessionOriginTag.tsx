import type { SessionSummary } from "@minih-agent/shared";
import { useTranslation } from "react-i18next";

import {
  originLabelKey,
  originTooltip,
  sessionOrigin,
} from "./session-origin-tags";

/**
 * The creator tag the sidebar shows before a session's title.
 *
 * Same `.thread-item-source` element as the Pi and remote labels, so the row
 * keeps one quiet vocabulary: a word, faint, single line. The person's own
 * conversations carry no tag — the absence is what "I made this" looks like —
 * and the tooltip names the session (or task) that dispatched it.
 */
export function SessionOriginTag({
  session,
}: {
  session: Pick<SessionSummary, "origin" | "originSession" | "originTaskId" | "title">;
}) {
  const { t } = useTranslation();
  const labelKey = originLabelKey(sessionOrigin(session));
  if (!labelKey) return null;
  const tooltip = originTooltip(session);
  return (
    <span
      className="thread-item-source"
      data-origin={sessionOrigin(session)}
      title={t(tooltip.key, { title: tooltip.title, defaultValue: "" })}
    >
      {t(labelKey)}
    </span>
  );
}