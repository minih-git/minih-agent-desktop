/**
 * The root tab bar (ADR mobile-direct-gateway-chat, spec §4).
 *
 * Two entries — Chats and Computers — shown on the two roots of a native build
 * only (`tabBarVisible`). Switching a tab replaces the root; the app wires that
 * through its one navigation, so the bar itself holds no navigation logic.
 * Styling follows `design/prototype/direct-chat.html`.
 */
import { Laptop, MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { RootKind } from "../lib/screen-stack.js";

export function TabBar({ root, onSwitch }: { root: RootKind; onSwitch: (root: RootKind) => void }) {
  const { t } = useTranslation();
  const tab = (id: RootKind, label: string, Icon: typeof Laptop) => (
    <button
      type="button"
      className={`flex min-h-[49px] flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 border-0 bg-transparent pt-1 text-[11px] leading-[14px] font-medium ${
        root === id ? "font-semibold text-[var(--rm-text-primary)]" : "text-[var(--rm-text-faint)]"
      }`}
      aria-current={root === id ? "page" : undefined}
      aria-label={label}
      onClick={() => onSwitch(id)}
    >
      <Icon className={root === id ? "h-6 w-6 stroke-[2.2]" : "h-6 w-6 stroke-[1.8]"} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
  return (
    <nav
      className="rm-tabbar flex flex-none items-stretch bg-[var(--rm-navbg)] shadow-[0_-1px_0_var(--rm-separator)]"
      aria-label={t("tabs.label")}
    >
      {tab("chats", t("tabs.chats"), MessageCircle)}
      {tab("hosts", t("tabs.computers"), Laptop)}
    </nav>
  );
}
