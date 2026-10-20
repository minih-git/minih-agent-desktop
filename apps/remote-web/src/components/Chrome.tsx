/**
 * Shared shell pieces for the H5 screens (PR-4).
 *
 * Mobile-first: every control is at least 44px tall, the header sticks, and the
 * content area carries the safe-area insets. Colours follow
 * `prefers-color-scheme` through Tailwind's `dark:` variants.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { OperationFailure } from "../lib/errors.js";
import { failureText } from "../lib/i18n.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "warning";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900",
  secondary:
    "border border-slate-300 bg-white text-slate-900 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800",
  ghost: "text-slate-700 hover:bg-slate-200 dark:text-slate-200 dark:hover:bg-slate-800",
  danger: "bg-red-600 text-white hover:bg-red-500",
  warning: "bg-amber-600 text-white hover:bg-amber-500",
};

export function Button({
  variant = "secondary",
  className = "",
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  className?: string;
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`app-tap inline-flex items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * The app frame: a fixed header, one scrolling body, and an optional footer.
 *
 * The body is the scroll container (`mainRef` hands it to a screen that needs to
 * know where it is scrolled), and the frame is exactly one viewport tall
 * (`h-dvh`) rather than at least one (`min-h-dvh`). Before rollout D the whole
 * document scrolled, so a long conversation opened at its oldest row with the
 * composer far below the fold and new rows arriving off-screen.
 */
export function AppShell({
  title,
  onBack,
  actions,
  children,
  footer,
  mainRef,
}: {
  title: string;
  onBack?: () => void;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** The scrolling element, for a screen that follows its newest row. */
  mainRef?: (element: HTMLElement | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-dvh flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="app-safe-area z-10 flex shrink-0 items-center gap-1 border-b border-slate-200 bg-white/95 px-2 py-1 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
        {onBack ? (
          <Button variant="ghost" aria-label={t("common.back")} title={t("common.back")} onClick={onBack} className="px-3">
            <span aria-hidden="true">←</span>
          </Button>
        ) : null}
        <h1 className="min-w-0 flex-1 truncate px-1 text-base font-semibold">{title}</h1>
        {actions}
      </header>
      {/* `[overflow-anchor:none]` turns off the engine's own scroll anchoring:
          the compensation below is the only mechanism, so a browser that lacks
          anchoring (WebKit on iOS) behaves the same and the E2E proves the code
          rather than the engine. */}
      <main
        ref={mainRef}
        className="app-safe-area flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3 py-3 [overflow-anchor:none]"
      >
        {children}
      </main>
      {footer}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900 ${className}`}
    >
      {children}
    </section>
  );
}

export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "bad"; children: ReactNode }) {
  const tones = {
    neutral: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
    ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200",
    warn: "bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100",
    bad: "bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-100",
  } as const;
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

/**
 * One failed operation, named together with its reason. The Gateway's own
 * message is shown when the client has no localized reason for the code.
 */
export function FailureBanner({
  failure,
  operationKey,
  onDismiss,
}: {
  failure: OperationFailure;
  operationKey: string;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100"
    >
      <p className="flex-1">{failureText(t, operationKey, failure)}</p>
      {onDismiss ? (
        <Button variant="ghost" onClick={onDismiss} className="px-2 text-xs">
          {t("common.cancel")}
        </Button>
      ) : null}
    </div>
  );
}
