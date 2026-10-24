import type { HTMLAttributes } from "react";

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {}

export function Skeleton({ className = "", ...rest }: SkeletonProps) {
  return (
    <div
      className={`animate-[rm-skel_1.4s_ease-in-out_infinite] rounded-[10px] bg-[var(--rm-bg-surface-2)] ${className}`}
      {...rest}
    />
  );
}

export function SkeletonRow() {
  return (
    <div className="flex min-h-[56px] items-center gap-3 px-4 py-3">
      <Skeleton className="h-[34px] w-[34px] rounded-[10px]" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-1/3 rounded-[6px]" />
        <Skeleton className="h-3 w-2/3 rounded-[6px]" />
      </div>
    </div>
  );
}
