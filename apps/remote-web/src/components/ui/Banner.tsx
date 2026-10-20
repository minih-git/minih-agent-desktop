import { AlertCircle, Loader2 } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";

export type BannerTone = "neutral" | "running" | "error";

export interface BannerProps extends HTMLAttributes<HTMLDivElement> {
  tone?: BannerTone;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}

export function Banner({
  tone = "neutral",
  icon,
  action,
  children,
  className = "",
  ...rest
}: BannerProps) {
  let toneClass = "bg-[var(--rm-bg-inset)] text-[var(--rm-text-secondary)]";
  let defaultIcon = null;

  if (tone === "running") {
    toneClass =
      "bg-[color-mix(in_srgb,var(--rm-running)_var(--rm-tint),var(--rm-bg-page))] text-[var(--rm-running)]";
    defaultIcon = <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />;
  } else if (tone === "error") {
    toneClass =
      "bg-[color-mix(in_srgb,var(--rm-error)_var(--rm-tint),var(--rm-bg-page))] text-[var(--rm-error)]";
    defaultIcon = <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />;
  }

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex shrink-0 animate-[rm-fade-down_0.2s_cubic-bezier(0.2,0,0,1)] items-center gap-2 px-4 py-2 text-[14px] leading-[20px] ${toneClass} ${className}`}
      {...rest}
    >
      {icon ?? defaultIcon}
      <div className="min-w-0 flex-1">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
