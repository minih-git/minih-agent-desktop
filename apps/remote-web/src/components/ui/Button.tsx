/**
 * Button primitive (ADR mobile-redesign D4, spec §7).
 *
 * Variants:
 * - `primary`: Aurora gradient fill with soft violet glow
 * - `secondary`: frosted surface-2 fill with hairline border
 * - `plain`: transparent background with surface-2 press state
 * - `destructive`: tinted error surface for destructive actions
 * - `destructive-filled`: solid error fill for final confirmation buttons
 */
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "plain"
  | "destructive"
  | "destructive-filled";
export type ButtonSize = "large" | "medium" | "small" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children?: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-[image:var(--rm-aurora)] text-white font-semibold shadow-[0_10px_30px_rgba(124,92,255,0.35)]",
  secondary:
    "bg-[var(--rm-bg-surface-2)] text-[var(--rm-text-primary)] font-semibold border border-[var(--rm-hair)]",
  plain:
    "bg-transparent text-[var(--rm-text-primary)] active:bg-[var(--rm-bg-surface-2)]",
  destructive:
    "bg-[color-mix(in_srgb,var(--rm-error)_12%,transparent)] text-[var(--rm-error)] font-semibold",
  "destructive-filled":
    "bg-[var(--rm-error)] text-white font-semibold shadow-[0_8px_24px_color-mix(in_srgb,var(--rm-error)_35%,transparent)]",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  large:
    "h-[50px] min-h-[50px] w-full px-5 text-[16px] rounded-[var(--rm-radius-button,16px)] active:scale-[0.97]",
  medium:
    "h-[44px] min-h-[44px] px-4 text-[15px] rounded-[var(--rm-radius-control,14px)] active:scale-[0.97]",
  small:
    "h-[32px] min-h-[32px] px-3 text-[13px] rounded-[var(--rm-radius-sm,10px)] active:scale-[0.97]",
  icon: "h-[44px] w-[44px] min-h-[44px] min-w-[44px] p-0 rounded-[var(--rm-radius-control,14px)] flex items-center justify-center active:scale-[0.88]",
};

export function Button({
  variant = "secondary",
  size = "medium",
  loading = false,
  disabled = false,
  className = "",
  children,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      type="button"
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={`relative inline-flex items-center justify-center gap-2 overflow-hidden select-none outline-none transition-[transform,opacity,background-color,box-shadow] duration-150 ease-[var(--rm-ease-out)] focus-visible:ring-2 focus-visible:ring-[var(--rm-accent-1)] disabled:pointer-events-none disabled:opacity-40 disabled:active:scale-100 ${
        VARIANT_CLASSES[variant]
      } ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    >
      {loading ? (
        <Loader2 className="h-5 w-5 animate-spin text-current" aria-hidden="true" />
      ) : (
        children
      )}
    </button>
  );
}
