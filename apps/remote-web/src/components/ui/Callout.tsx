import type { HTMLAttributes, ReactNode } from "react";

export type CalloutTone = "neutral" | "error" | "warn" | "decision" | "success";

export interface CalloutProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CalloutTone;
  children: ReactNode;
}

const TONE_CLASSES: Record<CalloutTone, string> = {
  neutral: "border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] text-[var(--rm-text-secondary)]",
  error:
    "border-[color-mix(in_srgb,var(--rm-error)_28%,transparent)] bg-[color-mix(in_srgb,var(--rm-error)_14%,transparent)] text-[var(--rm-error)]",
  warn: "border-[color-mix(in_srgb,var(--rm-warn)_28%,transparent)] bg-[color-mix(in_srgb,var(--rm-warn)_14%,transparent)] text-[var(--rm-warn)]",
  decision:
    "border-[color-mix(in_srgb,var(--rm-decision)_28%,transparent)] bg-[color-mix(in_srgb,var(--rm-decision)_14%,transparent)] text-[var(--rm-decision)]",
  success:
    "border-[color-mix(in_srgb,var(--rm-success)_28%,transparent)] bg-[color-mix(in_srgb,var(--rm-success)_14%,transparent)] text-[var(--rm-success)]",
};

export function Callout({ tone = "neutral", children, className = "", ...rest }: CalloutProps) {
  return (
    <div
      className={`rounded-[var(--rm-radius-control,14px)] border p-3.5 text-[14px] leading-[21px] backdrop-blur-md ${TONE_CLASSES[tone]} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
