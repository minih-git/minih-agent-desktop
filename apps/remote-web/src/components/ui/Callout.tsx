import type { HTMLAttributes, ReactNode } from "react";

export type CalloutTone = "neutral" | "error";

export interface CalloutProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CalloutTone;
  children: ReactNode;
}

export function Callout({ tone = "neutral", children, className = "", ...rest }: CalloutProps) {
  let toneClasses = "bg-[var(--rm-bg-inset)] text-[var(--rm-text-secondary)]";
  if (tone === "error") {
    toneClasses =
      "bg-[color-mix(in_srgb,var(--rm-error)_var(--rm-tint),var(--rm-bg-surface))] text-[var(--rm-error)]";
  }

  return (
    <div
      className={`rounded-[12px] p-3.5 text-[15px] leading-[22px] ${toneClasses} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
