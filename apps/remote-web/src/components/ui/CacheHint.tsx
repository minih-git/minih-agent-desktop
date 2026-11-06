/**
 * The line under a header that says where the data on screen came from.
 *
 * A cached list is a real answer from this computer, just not a fresh one, so
 * the line stays muted: it is the reason the screen is usable before the network
 * answers, and shouting about it would make every visit start with an alarm.
 * The failure banner above carries the reason when the refresh actually failed;
 * this line only ever says "this is the last one I have, and when it was".
 */
import { useTranslation } from "react-i18next";

import type { CacheHintKind } from "../../lib/cached-view.js";
import { relativeTimeText } from "../../lib/session-format.js";

export interface CacheHintProps {
  kind: CacheHintKind;
  /** When the Host sent the data on screen (ISO). */
  fetchedAt: string;
}

export function CacheHint({ kind, fetchedAt }: CacheHintProps) {
  const { t } = useTranslation();
  const when = relativeTimeText(fetchedAt, {
    justNow: t("common.justNow"),
    yesterday: t("common.yesterday"),
  });
  return (
    <p
      role="status"
      className="px-4 pb-2 text-[12px] leading-[16px] text-[var(--rm-text-muted)]"
      data-cache-hint={kind}
    >
      {kind === "offline" ? t("cache.offline", { date: when }) : t("cache.refreshing", { date: when })}
    </p>
  );
}