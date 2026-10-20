import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "plain" | "destructive" | "destructive-filled";
export type ButtonSize = "large" | "medium" | "small" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children?: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-[var(--rm-accent)] text-[var(--rm-on-accent)] font-semibold",
  secondary:
    "bg-[var(--rm-bg-surface)] text-[var(--rm-text-primary)] shadow-[inset_0_0_0_1px_var(--rm-separator)]",
  plain: "bg-transparent text-[var(--rm-text-primary)] active:opacity-60",
  destructive:
    "bg-[var(--rm-bg-surface)] text-[var(--rm-error)] shadow-[inset_0_0_0_1px_var(--rm-separator)]",
  "destructive-filled": "bg-[var(--rm-error)] text-white font-semibold",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  large: "h-[52px] min-h-[52px] w-full px-5 text-[16px] rounded-[12px]",
  medium: "h-[44px] min-h-[44px] px-4 text-[15px] rounded-[12px]",
  small: "h-[32px] min-h-[32px] px-3 text-[13px] rounded-[8px]",
  icon: "h-[44px] w-[44px] min-h-[44px] min-w-[44px] p-0 rounded-[10px] flex items-center justify-center",
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
      className={`inline-flex items-center justify-center gap-2 select-none outline-none transition-all active:scale-[0.98] active:opacity-85 disabled:opacity-40 disabled:pointer-events-none disabled:active:scale-100 ${
        VARIANT_CLASSES[variant]
      } ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    >
      {loading ? <Loader2 className="h-5 w-5 animate-spin text-current" aria-hidden="true" /> : children}
    </button>
  );
}
