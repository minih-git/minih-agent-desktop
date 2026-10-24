/**
 * The root tab bar (ADR mobile-redesign D3, spec §4).
 *
 * Three entries — Chats, Studio, and Computers — shown on the three roots of a
 * native build only (`tabBarVisible`). Switching a tab replaces the root; the
 * app wires that through its one navigation, so the bar itself holds no
 * navigation logic. Styling and the sliding indicator follow
 * `design/prototype/redesign.html`.
 */
import { Laptop, MessageCircle, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { RootKind } from "../lib/screen-stack.js";

const ROOT_ORDER: readonly RootKind[] = ["chats", "studio", "hosts"];

export function TabBar({ root, onSwitch }: { root: RootKind; onSwitch: (root: RootKind) => void }) {
  const { t } = useTranslation();
  const activeIndex = Math.max(0, ROOT_ORDER.indexOf(root));

  const tab = (id: RootKind, label: string, Icon: typeof Laptop) => {
    const active = root === id;
    return (
      <button
        type="button"
        data-tab={id}
        className={`relative z-10 flex min-h-[52px] flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 border-0 bg-transparent text-[11px] leading-[14px] font-semibold transition-colors duration-250 select-none ${
          active ? "text-[var(--rm-text-primary)]" : "text-[var(--rm-text-muted)]"
        }`}
        aria-current={active ? "page" : undefined}
        aria-label={label}
        onClick={() => onSwitch(id)}
      >
        <Icon
          className={`h-[22px] w-[22px] ${
            active
              ? "stroke-[2.2] animate-[rm-tab-bounce_0.45s_var(--rm-ease-spring)]"
              : "stroke-[1.9]"
          }`}
          aria-hidden="true"
        />
        <span>{label}</span>
      </button>
    );
  };

  return (
    <div className="rm-tabbar flex-none bg-transparent px-3 pb-2 pt-1">
      <nav
        className="relative mx-auto flex h-[60px] max-w-[640px] items-stretch rounded-[24px] border border-[var(--rm-hair)] bg-[var(--rm-glass-strong)] p-1.5 shadow-[var(--rm-shadow)] backdrop-blur-[24px] backdrop-saturate-[1.8]"
        aria-label={t("tabs.label")}
      >
        <span
          aria-hidden="true"
          className="rm-tabbar-indicator pointer-events-none"
          style={{
            width: "calc((100% - 12px) / 3)",
            transform: `translateX(${activeIndex * 100}%)`,
          }}
        />
        {tab("chats", t("tabs.chats"), MessageCircle)}
        {tab("studio", t("tabs.studio"), Sparkles)}
        {tab("hosts", t("tabs.computers"), Laptop)}
      </nav>
    </div>
  );
}
