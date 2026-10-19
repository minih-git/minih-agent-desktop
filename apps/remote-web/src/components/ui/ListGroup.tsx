import { ChevronRight } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";

export interface ListGroupProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function ListGroup({ children, className = "", ...rest }: ListGroupProps) {
  return (
    <div
      className={`relative divide-y divide-[var(--rm-separator)] overflow-hidden rounded-[16px] bg-[var(--rm-bg-surface)] ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface ListRowProps {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  chevron?: boolean;
  onClick?: () => void;
  className?: string;
  compact?: boolean;
  children?: ReactNode;
  badge?: ReactNode;
}

export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  chevron = false,
  onClick,
  className = "",
  compact = false,
  children,
}: ListRowProps) {
  const isInteractive = Boolean(onClick);
  const minHeight = compact ? "min-h-[52px]" : "min-h-[64px]";

  const content = (
    <div
      className={`relative flex w-full items-center gap-3 px-4 py-2.5 text-left select-none ${minHeight} ${
        isInteractive
          ? "cursor-pointer transition-colors active:bg-[color-mix(in_srgb,var(--rm-text-primary)_4%,transparent)]"
          : ""
      } ${className}`}
      onClick={onClick}
    >
      {leading ? <div className="flex shrink-0 items-center justify-center">{leading}</div> : null}

      <div className="min-w-0 flex-1">
        <div className="text-[16px] font-semibold leading-[22px] text-[var(--rm-text-primary)]">
          {title}
        </div>
        {subtitle ? (
          <div className="mt-0.5 text-[14px] leading-[20px] text-[var(--rm-text-secondary)]">
            {subtitle}
          </div>
        ) : null}
        {children}
      </div>

      {(trailing || chevron) && (
        <div className="flex shrink-0 items-center gap-1 text-[var(--rm-text-faint)]">
          {trailing}
          {chevron ? <ChevronRight className="h-5 w-5 stroke-[2]" aria-hidden="true" /> : null}
        </div>
      )}
    </div>
  );

  return content;
}

export interface IconTileProps extends HTMLAttributes<HTMLDivElement> {
  badge?: ReactNode;
  children: ReactNode;
}

export function IconTile({ badge, children, className = "", ...rest }: IconTileProps) {
  return (
    <div
      className={`relative grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-[var(--rm-bg-inset)] text-[var(--rm-text-primary)] ${className}`}
      {...rest}
    >
      {children}
      {badge ? (
        <span className="absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-[var(--rm-bg-surface)]">
          {badge}
        </span>
      ) : null}
    </div>
  );
}
