/**
 * Empty / hero state and result state (ADR mobile-redesign D4, spec §7).
 *
 * `EmptyState` renders an optional drifting Aurora glow and a floating
 * gradient orb around the icon so empty and welcome screens share the
 * prototype's `.hero` + `.orb` visual signature.
 */
import { AlertCircle, Check, Sparkles } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";

import { Aurora } from "./Aurora.js";

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  /** Render the drifting Aurora glow behind the hero content; defaults to `true`. */
  aurora?: boolean;
  /** Wrap the icon inside the floating Aurora orb; defaults to `true`. */
  orb?: boolean;
  /** Optional suggestion grid or extra content below the description. */
  suggestions?: ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  aurora = true,
  orb = true,
  suggestions,
  className = "",
  ...rest
}: EmptyStateProps) {
  const glyph = icon ?? (orb ? <Sparkles className="h-9 w-9 stroke-[1.9]" aria-hidden="true" /> : null);

  return (
    <div
      // `overflow-hidden` keeps a nested Aurora (its blobs extend well past the
      // box) from widening the scroll area under a screen that already draws
      // one: a hero must never add a horizontal scrollbar.
      className={`relative flex flex-col items-center justify-center overflow-hidden px-5 py-12 text-center ${className}`}
      {...rest}
    >
      {aurora ? <Aurora /> : null}
      <div className="relative z-10 flex w-full flex-col items-center">
        {glyph ? (
          orb ? (
            <div className="rm-orb mb-5 grid h-[84px] w-[84px] place-items-center rounded-[28px] text-white [&_svg]:h-10 [&_svg]:w-10 [&_svg]:text-white">
              {glyph}
            </div>
          ) : (
            <div className="mb-4 text-[var(--rm-text-faint)]">{glyph}</div>
          )
        ) : null}
        <h3 className="text-[22px] font-bold tracking-[-0.01em] leading-[28px] text-[var(--rm-text-primary)]">
          {title}
        </h3>
        {description ? (
          <p className="mt-2 max-w-[320px] text-[15px] leading-[23px] text-[var(--rm-text-muted)]">
            {description}
          </p>
        ) : null}
        {suggestions ? <div className="mt-6 w-full">{suggestions}</div> : null}
        {(action || secondaryAction) && (
          <div className="mt-6 flex w-full max-w-[300px] flex-col gap-2.5">
            {action}
            {secondaryAction}
          </div>
        )}
      </div>
    </div>
  );
}

export interface ResultStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  status?: "success" | "error" | "custom";
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
}

export function ResultState({
  status = "success",
  icon,
  title,
  description,
  action,
  secondaryAction,
  className = "",
  ...rest
}: ResultStateProps) {
  let iconElement = icon;
  if (!iconElement) {
    if (status === "success") {
      iconElement = (
        <div className="grid h-[76px] w-[76px] place-items-center rounded-[26px] bg-[color-mix(in_srgb,var(--rm-success)_18%,var(--rm-bg-surface))] text-[var(--rm-success)] shadow-[0_16px_40px_color-mix(in_srgb,var(--rm-success)_25%,transparent)]">
          <Check className="h-10 w-10 stroke-[2.5]" aria-hidden="true" />
        </div>
      );
    } else if (status === "error") {
      iconElement = (
        <div className="grid h-[76px] w-[76px] place-items-center rounded-[26px] bg-[color-mix(in_srgb,var(--rm-error)_18%,var(--rm-bg-surface))] text-[var(--rm-error)] shadow-[0_16px_40px_color-mix(in_srgb,var(--rm-error)_25%,transparent)]">
          <AlertCircle className="h-10 w-10 stroke-[2.2]" aria-hidden="true" />
        </div>
      );
    }
  }

  return (
    <div
      className={`relative flex flex-col items-center justify-center px-5 py-14 text-center ${className}`}
      {...rest}
    >
      {iconElement ? <div className="mb-5">{iconElement}</div> : null}
      <h2 className="text-[26px] font-bold tracking-[-0.01em] leading-[32px] text-[var(--rm-text-primary)]">
        {title}
      </h2>
      {description ? (
        <p className="mt-2 max-w-[340px] text-[15px] leading-[23px] text-[var(--rm-text-muted)]">
          {description}
        </p>
      ) : null}
      {(action || secondaryAction) && (
        <div className="mt-8 flex w-full max-w-[300px] flex-col gap-2.5">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
