/**
 * Status dots, status labels, chips, and compact `.tag` badges (ADR mobile-redesign D4).
 *
 * `StatusDot` uses the `.rm-status-pulse` halo on `online`, two breathing cycles
 * on `running`, and two purple pulses on `decision`. `Tag` implements the
 * prototype's compact 20 px `.tag` badges (including the Aurora gradient-border
 * `.tag.g` variant used for capability chips and session strip items).
 */
import { AlertCircle, Check } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";

export type StatusType =
  | "online"
  | "offline"
  | "running"
  | "decision"
  | "done"
  | "error"
  | "muted";

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  status: StatusType;
  size?: "small" | "large";
}

export function StatusDot({ status, size = "small", className = "", ...rest }: StatusDotProps) {
  // Kept in this order on purpose: `w-2 h-2` is the class pair other tests use
  // to count dots, so the halo slot must not change the dot's own classes.
  const dotSize = size === "large" ? "w-2.5 h-2.5" : "w-2 h-2";
  /**
   * The dot sits in a slot wider than itself because its halo grows past the
   * dot, and the containers it is placed in — a navigation subtitle, a row
   * title — clip what leaves them. The slot is the room the halo needs, so the
   * ring reads as a ring instead of a sliced wedge.
   */
  const slotSize = size === "large" ? "h-5 w-5" : "h-4 w-4";

  let statusStyles = "";
  if (status === "online") {
    statusStyles = "rm-status-pulse";
  } else if (status === "done") {
    statusStyles = "bg-[var(--rm-success)]";
  } else if (status === "offline") {
    statusStyles = "bg-transparent shadow-[inset_0_0_0_1.5px_var(--rm-text-faint)]";
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
    <span className={`inline-grid shrink-0 place-items-center ${slotSize} ${className}`} {...rest}>
      <span className={`rounded-full ${dotSize} ${statusStyles}`} />
    </span>
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

export type ChipTone =
  | "neutral"
  | "running"
  | "warn"
  | "error"
  | "decision"
  | "success"
  | "gradient";

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  children: ReactNode;
}

const CHIP_TONE_CLASSES: Record<ChipTone, string> = {
  neutral: "bg-[var(--rm-bg-surface-2)] text-[var(--rm-text-secondary)]",
  running:
    "bg-[color-mix(in_srgb,var(--rm-running)_16%,transparent)] text-[var(--rm-running)]",
  warn: "bg-[color-mix(in_srgb,var(--rm-warn)_16%,transparent)] text-[var(--rm-warn)]",
  error:
    "bg-[color-mix(in_srgb,var(--rm-error)_15%,transparent)] text-[var(--rm-error)]",
  decision:
    "bg-[color-mix(in_srgb,var(--rm-decision)_16%,transparent)] text-[var(--rm-decision)]",
  success:
    "bg-[color-mix(in_srgb,var(--rm-success)_15%,transparent)] text-[var(--rm-success)]",
  gradient:
    "border border-transparent text-[var(--rm-text-primary)] [background:linear-gradient(var(--rm-bg-solid),var(--rm-bg-solid))_padding-box,var(--rm-aurora)_border-box]",
};

export function Chip({ tone = "neutral", children, className = "", ...rest }: ChipProps) {
  return (
    <span
      className={`inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-full px-2 text-[12px] font-semibold ${CHIP_TONE_CLASSES[tone]} ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}

export type TagTone = ChipTone;
export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: TagTone;
  children?: ReactNode;
}

/**
 * Compact 20 px badge matching `.tag` in `design/prototype/redesign.html`
 * (model capability chips, conversation tags, and status badges).
 */
export function Tag({ tone = "neutral", children, className = "", ...rest }: TagProps) {
  return (
    <span
      className={`inline-flex h-[20px] items-center gap-1 whitespace-nowrap rounded-[6px] px-[7px] text-[11px] font-semibold ${CHIP_TONE_CLASSES[tone]} ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}
