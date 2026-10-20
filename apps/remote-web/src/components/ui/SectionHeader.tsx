import type { HTMLAttributes, ReactNode } from "react";

export interface SectionHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  action?: ReactNode;
}

export function SectionHeader({ title, action, className = "", ...rest }: SectionHeaderProps) {
  return (
    <div
      className={`flex items-center justify-between px-1 pb-2 pt-6 text-[13px] font-normal leading-[18px] text-[var(--rm-text-muted)] first:pt-3 ${className}`}
      {...rest}
    >
      <div className="font-medium tracking-wide">{title}</div>
      {action ? <div className="text-[13px]">{action}</div> : null}
    </div>
  );
}
