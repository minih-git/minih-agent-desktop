import type { HTMLAttributes, ReactNode } from "react";

export interface ScreenProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  animate?: "push" | "pop" | "none";
}

export function Screen({ children, animate = "none", className = "", ...rest }: ScreenProps) {
  const animClass =
    animate === "push"
      ? "animate-[rm-push_0.28s_cubic-bezier(0.2,0,0,1)]"
      : animate === "pop"
        ? "animate-[rm-pop_0.28s_cubic-bezier(0.2,0,0,1)]"
        : "";

  return (
    <div
      className={`relative flex h-dvh w-full flex-col overflow-hidden bg-[var(--rm-bg-page)] text-[var(--rm-text-primary)] ${animClass} ${className}`}
      {...rest}
    >
      <div className="mx-auto flex h-full w-full max-w-[640px] flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}

export interface ScreenContentProps extends HTMLAttributes<HTMLElement> {
  hasDock?: boolean;
  onScroll?: (e: React.UIEvent<HTMLElement>) => void;
  children: ReactNode;
}

export function ScreenContent({
  hasDock = false,
  className = "",
  children,
  ...rest
}: ScreenContentProps) {
  return (
    <main
      className={`rm-gutter flex-1 overflow-x-hidden overflow-y-auto ${
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
      className={`rm-dock rm-gutter sticky bottom-0 z-10 flex-none bg-[var(--rm-bg-page)]/95 pt-2 backdrop-blur transition-all ${className}`}
      {...rest}
    >
      {children}
    </footer>
  );
}
