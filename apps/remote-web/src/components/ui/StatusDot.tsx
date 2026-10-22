import { AlertCircle, Check } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";

export type StatusType = "online" | "offline" | "running" | "decision" | "done" | "error" | "muted";

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  status: StatusType;
  size?: "small" | "large";
}

export function StatusDot({ status, size = "small", className = "", ...rest }: StatusDotProps) {
  const sizeClasses = size === "large" ? "w-2.5 h-2.5" : "w-2 h-2";

  let statusStyles = "";
  if (status === "online" || status === "done") {
    statusStyles = "bg-[var(--rm-success)]";
  } else if (status === "offline") {
    statusStyles = "bg-transparent shadow-[inset_0_0_0_1.5px_var(--rm-text-muted)]";
  } else if (status === "running") {
    statusStyles = "bg-[var(--rm-running)] [animation:rm-breathe_1.6s_ease-in-out_2]";
  } else if (status === "decision") {
    statusStyles = "bg-[var(--rm-decision)] [animation:rm-pulse_1.6s_ease-in-out_2]";
  } else if (status === "error") {
    statusStyles = "bg-[var(--rm-error)]";
  } else {
    statusStyles = "bg-[var(--rm-text-faint)]";
  }

  return (
    <span
      className={`inline-block shrink-0 rounded-full ${sizeClasses} ${statusStyles} ${className}`}
      {...rest}
    />
  );
}

export interface StatusLabelProps extends HTMLAttributes<HTMLSpanElement> {
  status: StatusType;
  label: string;
}

export function StatusLabel({ status, label, className = "", ...rest }: StatusLabelProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[13px] text-[var(--rm-text-muted)] ${className}`}
      {...rest}
    >
      {status === "done" ? (
        <Check className="h-3.5 w-3.5 text-[var(--rm-success)] stroke-[2.5]" aria-hidden="true" />
      ) : status === "error" ? (
        <AlertCircle className="h-3.5 w-3.5 text-[var(--rm-error)] stroke-[2]" aria-hidden="true" />
      ) : (
        <StatusDot status={status} />
      )}
      <span>{label}</span>
    </span>
  );
}

export type ChipTone = "neutral" | "running" | "error" | "decision";

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  children: ReactNode;
}

export function Chip({ tone = "neutral", children, className = "", ...rest }: ChipProps) {
  let toneClass = "bg-[var(--rm-bg-inset)] text-[var(--rm-text-secondary)]";
  if (tone === "running") {
    toneClass =
      "bg-[color-mix(in_srgb,var(--rm-running)_var(--rm-tint),var(--rm-bg-surface))] text-[var(--rm-running)]";
  } else if (tone === "error") {
    toneClass =
      "bg-[color-mix(in_srgb,var(--rm-error)_var(--rm-tint),var(--rm-bg-surface))] text-[var(--rm-error)]";
  } else if (tone === "decision") {
    toneClass =
      "bg-[color-mix(in_srgb,var(--rm-decision)_var(--rm-tint),var(--rm-bg-surface))] text-[var(--rm-decision)]";
  }

  return (
    <span
      className={`inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-full px-2 text-[12px] font-semibold ${toneClass} ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}
