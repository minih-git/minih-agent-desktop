import type { HTMLAttributes } from "react";

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {}

export function Skeleton({ className = "", ...rest }: SkeletonProps) {
  return (
    <div
      className={`animate-[rm-skel_1.2s_ease-in-out_infinite] rounded-[6px] bg-[var(--rm-bg-inset)] ${className}`}
      {...rest}
    />
  );
}

export function SkeletonRow() {
  return (
    <div className="flex min-h-[64px] items-center gap-3 px-4 py-3">
      <Skeleton className="h-8 w-8 rounded-[9px]" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}
