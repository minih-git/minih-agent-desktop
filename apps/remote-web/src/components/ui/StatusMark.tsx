/**
 * One status vocabulary, three placements (spec §17.4).
 *
 * The phone used to say a session's state with a 12 px dot whose only difference
 * between "running" and "needs your approval" was hue, so the one row that
 * actually needed the user looked like all the others. §17 replaces it with three
 * weights and one rule: **never colour alone**. Every state pairs its hue with a
 * glyph and with a word, so a monochrome screenshot still reads, and a screen
 * reader hears the state rather than a coloured pixel.
 *
 * | Weight | States | Mark |
 * |---|---|---|
 * | attention | approval, input | a filled pill carrying an icon and a word |
 * | active | running | a breathing dot and a word |
 * | settled | error, unseen, idle | a glyph, and a word where the glyph alone is ambiguous |
 *
 * The same components draw a session row, a navigation subtitle, and a project
 * card, which is what keeps the three from drifting apart.
 */
import { AlertCircle, Check, CircleHelp, Shield } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { SessionStateView } from "../../lib/session-state.js";

/** The word this state carries. "Idle" has none: nothing to say is the point. */
export function useSessionStateWord(view: SessionStateView): string {
  const { t } = useTranslation();
  if (view === "approval") return t("sessions.status.waiting_permission");
  if (view === "input") return t("sessions.status.waiting_input");
  if (view === "running") return t("sessions.status.running");
  if (view === "error") return t("sessions.status.error");
  if (view === "unseen") return t("sessions.status.finished");
  return "";
}

const TONE: Record<SessionStateView, "decision" | "running" | "error" | "success" | "muted"> = {
  approval: "decision",
  input: "decision",
  running: "running",
  error: "error",
  unseen: "success",
  idle: "muted",
};

function glyphFor(view: SessionStateView) {
  if (view === "approval") return <Shield className="h-[18px] w-[18px]" strokeWidth={2.2} aria-hidden="true" />;
  if (view === "input") return <CircleHelp className="h-[18px] w-[18px]" strokeWidth={2.2} aria-hidden="true" />;
  if (view === "error") return <AlertCircle className="h-[18px] w-[18px]" strokeWidth={2.2} aria-hidden="true" />;
  if (view === "unseen") return <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />;
  return null;
}

const COLOR: Record<string, string> = {
  decision: "text-[var(--rm-decision)]",
  running: "text-[var(--rm-running)]",
  error: "text-[var(--rm-error)]",
  success: "text-[var(--rm-success)]",
  muted: "text-[var(--rm-text-faint)]",
};

/**
 * The leading 20 px slot of a row: a glyph for the states that have one, a dot
 * for the two that do not.
 *
 * "Finished, not looked at" is the same check mark inside a ring rather than
 * outside it — a shape difference, not an opacity difference, because the only
 * thing worse than no signal is a signal nobody can see on a dim screen.
 */
export function SessionStatusGlyph({ view, className = "" }: { view: SessionStateView; className?: string }) {
  const tone = TONE[view];
  if (view === "running") {
    return (
      <span className={`flex h-5 w-5 items-center justify-center ${className}`}>
        <span className="inline-block h-2 w-2 rounded-full bg-[var(--rm-running)] [animation:rm-breathe_1.6s_ease-in-out_2]" />
      </span>
    );
  }
  if (view === "idle") {
    return (
      <span className={`flex h-5 w-5 items-center justify-center ${className}`}>
        <span className="inline-block h-2 w-2 rounded-full bg-[var(--rm-text-faint)] opacity-45" />
      </span>
    );
  }
  const ring =
    view === "unseen"
      ? " bg-[color-mix(in_srgb,var(--rm-success)_var(--rm-tint),transparent)] shadow-[inset_0_0_0_1.5px_var(--rm-success)]"
      : "";
  return (
    <span className={`flex h-5 w-5 items-center justify-center rounded-full ${COLOR[tone]}${ring} ${className}`}>
      {glyphFor(view)}
    </span>
  );
}

/**
 * The status pill, used on a project card and — for the two attention states —
 * inside a session row.
 *
 * "Needs you" is the only filled mark in the product, which is what makes it the
 * thing the eye lands on (spec §3, decisions first). The running pill exists so a
 * card can say "1 running" without inventing a second visual language; a row
 * spends its one pill on attention instead.
 */
export function SessionStatusPill({ view, count }: { view: SessionStateView; count?: number }) {
  const { t } = useTranslation();
  const word = useSessionStateWord(view);
  if (view !== "approval" && view !== "input" && view !== "running") return null;
  const label =
    view === "running"
      ? t("projects.runningCount", { count: count ?? 1 })
      : count && count > 1
        ? t("projects.attentionCount", { count })
        : word;
  if (view === "running") {
    return (
      <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--rm-running)_var(--rm-tint),var(--rm-bg-surface))] px-[7px] text-[12px] font-semibold leading-4 text-[var(--rm-running)]">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--rm-running)] [animation:rm-breathe_1.6s_ease-in-out_2]" />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--rm-decision)_var(--rm-tint),var(--rm-bg-surface))] px-[7px] text-[12px] font-semibold leading-4 text-[var(--rm-decision)]">
      {view === "approval" ? (
        <Shield className="h-3 w-3" strokeWidth={2.4} aria-hidden="true" />
      ) : (
        <CircleHelp className="h-3 w-3" strokeWidth={2.4} aria-hidden="true" />
      )}
      {label}
    </span>
  );
}

/** The settled states' word, for the row subtitle beside the time. */
export function SessionStatusWord({ view }: { view: SessionStateView }) {
  const word = useSessionStateWord(view);
  if (!word || view === "approval" || view === "input") return null;
  return <span className={`shrink-0 font-medium ${COLOR[TONE[view]]}`}>{word}</span>;
}

/**
 * The compact form a navigation subtitle uses: a dot and a word, at subhead size.
 * It keeps the same colours and the same words, so a state never changes meaning
 * between the bar and the list under it.
 */
export function SessionStatusInline({ view }: { view: SessionStateView }) {
  const word = useSessionStateWord(view);
  const tone = TONE[view];
  if (!word) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px] leading-[15px]">
      {view === "running" ? (
        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--rm-running)] [animation:rm-breathe_1.6s_ease-in-out_2]" />
      ) : (
        <span
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
            tone === "decision"
              ? "bg-[var(--rm-decision)]"
              : tone === "error"
                ? "bg-[var(--rm-error)]"
                : "bg-[var(--rm-success)]"
          }`}
        />
      )}
      <span className={`truncate ${COLOR[tone]}`}>{word}</span>
    </span>
  );
}
