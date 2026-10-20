import { Check } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  className = "",
  ...rest
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center px-4 py-16 text-center ${className}`}
      {...rest}
    >
      {icon ? <div className="mb-4 text-[var(--rm-text-faint)]">{icon}</div> : null}
      <h3 className="text-[17px] font-semibold leading-[22px] text-[var(--rm-text-primary)]">
        {title}
      </h3>
      {description ? (
        <p className="mt-2 max-w-[320px] text-[15px] leading-[22px] text-[var(--rm-text-secondary)]">
          {description}
        </p>
      ) : null}
      {(action || secondaryAction) && (
        <div className="mt-6 flex w-full max-w-[280px] flex-col gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

export interface ResultStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  status?: "success" | "error" | "custom";
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
}

export function ResultState({
  status = "success",
  icon,
  title,
  description,
  action,
  secondaryAction,
  className = "",
  ...rest
}: ResultStateProps) {
  let iconElement = icon;
  if (!iconElement) {
    if (status === "success") {
      iconElement = (
        <div className="grid h-[72px] w-[72px] place-items-center rounded-full bg-[color-mix(in_srgb,var(--rm-success)_var(--rm-tint),var(--rm-bg-surface))] text-[var(--rm-success)]">
          <Check className="h-10 w-10 stroke-[2.5]" aria-hidden="true" />
        </div>
      );
    }
  }

  return (
    <div
      className={`flex flex-col items-center justify-center px-4 py-16 text-center ${className}`}
      {...rest}
    >
      {iconElement ? <div className="mb-5">{iconElement}</div> : null}
      <h2 className="text-[28px] font-bold leading-[34px] text-[var(--rm-text-primary)]">
        {title}
      </h2>
      {description ? (
        <p className="mt-2 max-w-[340px] text-[15px] leading-[22px] text-[var(--rm-text-secondary)]">
          {description}
        </p>
      ) : null}
      {(action || secondaryAction) && (
        <div className="mt-8 flex w-full max-w-[280px] flex-col gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
