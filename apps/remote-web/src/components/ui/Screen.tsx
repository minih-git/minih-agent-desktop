import type { HTMLAttributes, ReactNode, Ref } from "react";

import { Aurora } from "./Aurora.js";

export interface ScreenProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  animate?: "push" | "pop" | "none";
  /** Render the drifting Aurora glow at the top of the screen. */
  aurora?: boolean;
}

export function Screen({
  children,
  animate = "none",
  aurora = false,
  className = "",
  ...rest
}: ScreenProps) {
  const animClass =
    animate === "push"
      ? "animate-[rm-push_0.28s_var(--rm-ease-out)]"
      : animate === "pop"
        ? "animate-[rm-pop_0.28s_var(--rm-ease-out)]"
        : "";

  return (
    <div
      className={`relative flex h-full w-full flex-col overflow-hidden bg-[var(--rm-bg-page)] text-[var(--rm-text-primary)] ${animClass} ${className}`}
      {...rest}
    >
      {aurora ? <Aurora /> : null}
      <div className="relative z-10 mx-auto flex h-full w-full max-w-[640px] flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}

export interface ScreenContentProps extends HTMLAttributes<HTMLElement> {
  hasDock?: boolean;
  onScroll?: (e: React.UIEvent<HTMLElement>) => void;
  children: ReactNode;
  /**
   * The scrolling element itself. A screen that follows its newest row needs to
   * read and set `scrollTop` on exactly this node (rollout D).
   */
  ref?: Ref<HTMLElement>;
}

export function ScreenContent({
  hasDock = false,
  className = "",
  children,
  ...rest
}: ScreenContentProps) {
  return (
    <main
      className={`rm-gutter relative z-10 flex-1 touch-pan-y overflow-x-hidden overflow-y-auto ${
        hasDock ? "pb-4" : "rm-scroll-end"
      } ${className}`}
      {...rest}
    >
      {children}
    </main>
  );
}

export interface ScreenDockProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function ScreenDock({ children, className = "", ...rest }: ScreenDockProps) {
  return (
    <footer
      className={`rm-dock rm-gutter sticky bottom-0 z-20 flex-none border-t border-[var(--rm-hair)] bg-[var(--rm-glass-strong)] pt-2 backdrop-blur-[22px] backdrop-saturate-[1.6] ${className}`}
      {...rest}
    >
      {children}
    </footer>
  );
}
