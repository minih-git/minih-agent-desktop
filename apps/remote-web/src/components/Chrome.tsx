/**
 * Shared shell pieces for the H5 screens.
 * Reskinned to bridge to src/components/ui/ components.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { OperationFailure } from "../lib/errors.js";
import { failureText } from "../lib/i18n.js";
import {
  Banner,
  Button as UiButton,
  NavBar,
  Screen,
  ScreenContent,
  ScreenDock,
  type ButtonVariant as UiButtonVariant,
} from "./ui/index.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "warning";

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
  let mappedVariant: UiButtonVariant = "secondary";
  if (variant === "primary") mappedVariant = "primary";
  else if (variant === "ghost") mappedVariant = "plain";
  else if (variant === "danger") mappedVariant = "destructive";
  else if (variant === "warning") mappedVariant = "secondary";

  return (
    <UiButton variant={mappedVariant} className={className} {...rest}>
      {children}
    </UiButton>
  );
}

export function AppShell({
  title,
  onBack,
  actions,
  children,
  footer,
}: {
  title: string;
  onBack?: () => void;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Screen>
      <NavBar
        title={title}
        onBack={onBack}
        backLabel={t("common.back")}
        trailing={actions}
      />
      <ScreenContent hasDock={Boolean(footer)}>
        <div className="flex min-h-0 flex-1 flex-col gap-3 py-3">{children}</div>
      </ScreenContent>
      {footer ? <ScreenDock>{footer}</ScreenDock> : null}
    </Screen>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-[16px] bg-[var(--rm-bg-surface)] p-4 shadow-[0_1px_0_var(--rm-separator)] ${className}`}
    >
      {children}
    </section>
  );
}

export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "ok" | "warn" | "bad";
  children: ReactNode;
}) {
  let toneStyles = "bg-[var(--rm-bg-inset)] text-[var(--rm-text-secondary)]";
  if (tone === "ok") {
    toneStyles =
      "bg-[color-mix(in_srgb,var(--rm-success)_var(--rm-tint),var(--rm-bg-surface))] text-[var(--rm-success)]";
  } else if (tone === "warn") {
    toneStyles =
      "bg-[color-mix(in_srgb,var(--rm-running)_var(--rm-tint),var(--rm-bg-surface))] text-[var(--rm-running)]";
  } else if (tone === "bad") {
    toneStyles =
      "bg-[color-mix(in_srgb,var(--rm-error)_var(--rm-tint),var(--rm-bg-surface))] text-[var(--rm-error)]";
  }

  return (
    <span
      className={`inline-flex h-[22px] items-center gap-1 rounded-full px-2 text-[12px] font-semibold ${toneStyles}`}
    >
      {children}
    </span>
  );
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
    <Banner
      tone="error"
      action={
        onDismiss ? (
          <Button variant="ghost" onClick={onDismiss} className="h-7 px-2 text-xs">
            {t("common.cancel")}
          </Button>
        ) : undefined
      }
    >
      <p>{failureText(t, operationKey, failure)}</p>
    </Banner>
  );
}
