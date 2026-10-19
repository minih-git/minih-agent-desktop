import type { DetailsHTMLAttributes, ReactNode } from "react";
import { cx } from "../ui";
import { IconChevronDown } from "../icons";

/**
 * Native disclosure: keyboard semantics and hidden-content focus stay
 * browser-owned.
 *
 * `titleClassName` lets a caller mark the summary as the row's title, which is
 * what the settings search flashes when a hit lands inside the folded body —
 * the fields themselves are hidden and cannot be scrolled to.
 */
export function SettingsDisclosure({
  title,
  className,
  titleClassName,
  children,
  ...props
}: Omit<DetailsHTMLAttributes<HTMLDetailsElement>, "title"> & {
  title: string;
  titleClassName?: string;
  children: ReactNode;
}) {
  return (
    <details className={cx("settings-disclosure", className)} {...props}>
      <summary>
        <span className={titleClassName}>{title}</span>
        <IconChevronDown size={16} aria-hidden="true" />
      </summary>
      <div className="settings-disclosure-body">{children}</div>
    </details>
  );
}
