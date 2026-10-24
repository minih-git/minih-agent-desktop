/**
 * Drifting Aurora gradient blobs for hero and root screens (ADR mobile-redesign D4).
 *
 * Purely decorative (`aria-hidden="true"`, `pointer-events-none`) so screen
 * readers and touch targets ignore it completely, and the drift animation is
 * disabled automatically under `prefers-reduced-motion: reduce`.
 */
import type { CSSProperties, HTMLAttributes } from "react";

export interface AuroraProps extends HTMLAttributes<HTMLDivElement> {
  /** Optional height override for tall full-bleed hero screens. */
  height?: number | string;
}

export function Aurora({ height, className = "", style, ...rest }: AuroraProps) {
  const mergedStyle: CSSProperties | undefined =
    height !== undefined ? { height, ...style } : style;

  return (
    <div
      aria-hidden="true"
      className={`rm-aurora pointer-events-none select-none ${className}`}
      style={mergedStyle}
      {...rest}
    >
      <i
        className="rm-aurora-blob"
        style={{
          width: 260,
          height: 260,
          left: "10%",
          top: "15%",
          background: "var(--rm-accent-1)",
        }}
      />
      <i
        className="rm-aurora-blob"
        style={{
          width: 220,
          height: 220,
          left: "50%",
          top: "5%",
          background: "var(--rm-accent-2)",
          animationDelay: "-6s",
          animationDuration: "24s",
        }}
      />
      <i
        className="rm-aurora-blob"
        style={{
          width: 200,
          height: 200,
          left: "30%",
          top: "40%",
          background: "var(--rm-accent-3)",
          animationDelay: "-12s",
          animationDuration: "18s",
        }}
      />
    </div>
  );
}
