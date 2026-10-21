/**
 * D1 Chats root (ADR mobile-direct-gateway-chat, first stage).
 *
 * A placeholder that keeps the two-root navigation and launch rule shippable
 * before the direct-chat screens exist: no network call, no credential, no
 * history. The real list (search, pinned, recent, Archived link) replaces this
 * screen in the history stage; its entries and title text live in i18n.
 */
import { useTranslation } from "react-i18next";

import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";

export function ChatsScreen() {
  const { t } = useTranslation();
  return (
    <Screen>
      <NavBar title={t("chats.title")} />
      <ScreenContent className="flex flex-col items-center justify-center gap-1 pb-8 text-center">
        <p className="text-[15px] font-semibold text-[var(--rm-text-primary)]">{t("chats.placeholderTitle")}</p>
        <p className="max-w-[280px] text-[13px] leading-snug text-[var(--rm-text-muted)]">
          {t("chats.placeholderHint")}
        </p>
      </ScreenContent>
    </Screen>
  );
}
