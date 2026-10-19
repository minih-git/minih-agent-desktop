/**
 * The suggestion inbox (ADR agent-long-term-memory §4).
 *
 * Extraction may only propose, and this is where the user decides. One row per
 * suggestion shows what the agent would keep, where it would apply, and the
 * user's own words it was derived from — the citation is the whole point, since
 * a note cannot be judged without it. Accepting is the only path that activates
 * a suggestion; rejecting erases it and records the same tombstone a delete
 * does, so the same evidence is never proposed twice.
 *
 * Nothing here interrupts: the tab renders a quiet count and the rows, and no
 * dialog or toast asks the user to look at it.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LearnedMemorySuggestion } from "@minih-agent/shared";
import { api } from "../lib/api";
import { badgeCount, suggestionSummary } from "../lib/learned-memory-manager";
import { Button } from "./ui";
import { IconCheck, IconClose, IconSparkles } from "./icons";

/** The quiet badge the manager's tab shows; nothing when the inbox is empty. */
export function SuggestionBadge({ count }: { count: number }) {
  const value = badgeCount(count);
  if (value === null) return null;
  return (
    <span className="learned-memory-badge" aria-label={String(value)}>
      {value > 99 ? "99+" : value}
    </span>
  );
}

export function SuggestionInbox({
  scope,
  projectPath,
  busy,
  onBusyChange,
  onCountChange,
  onError,
}: {
  scope: "project" | "user";
  projectPath?: string;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onCountChange: (count: number) => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const [suggestions, setSuggestions] = useState<LearnedMemorySuggestion[] | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.listLearnedMemorySuggestions({
        scope,
        ...(scope === "project" && projectPath ? { path: projectPath } : {}),
      });
      setSuggestions(result.entries);
      onCountChange(result.count);
    } catch (error) {
      onError(error);
      setSuggestions([]);
    }
  }, [onCountChange, onError, projectPath, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = (suggestion: LearnedMemorySuggestion, decision: "accept" | "reject") => {
    onBusyChange(true);
    void (async () => {
      try {
        await api.decideLearnedMemorySuggestion(suggestion.id, decision);
        setSuggestions((current) => {
          const next = (current ?? []).filter((row) => row.id !== suggestion.id);
          onCountChange(next.length);
          return next;
        });
      } catch (error) {
        onError(error);
      } finally {
        onBusyChange(false);
      }
    })();
  };

  if (suggestions === null) return null;
  if (!suggestions.length) {
    return (
      <div className="project-memory-dialog-empty">
        <IconSparkles size={18} aria-hidden />
        <span>{t("memory.suggestionsEmpty")}</span>
      </div>
    );
  }
  return (
    <div className="project-memory-dialog-list" role="list">
      {suggestions.map((suggestion) => {
        const summary = suggestionSummary(suggestion);
        return (
          <article
            className="project-memory-card learned-memory-card"
            key={suggestion.id}
            role="listitem"
            data-memory-suggestion={suggestion.id}
          >
            <div className="learned-memory-card-head">
              <span className={`learned-memory-kind learned-memory-kind-${suggestion.kind}`}>
                {t(`memory.kind.${suggestion.kind}`)}
              </span>
              <span className="learned-memory-meta">
                {suggestion.scopeKind === "user"
                  ? t("memory.rememberScopeUser")
                  : t("memory.rememberScopeProject")}
                {" · "}
                {new Date(suggestion.createdAt).toISOString().slice(0, 10)}
              </span>
            </div>
            <p className="learned-memory-content">{suggestion.content}</p>
            {suggestion.rationale ? (
              <p className="project-memory-dialog-hint">{suggestion.rationale}</p>
            ) : null}
            {summary.quote ? (
              <blockquote className="learned-memory-quote">
                <span className="learned-memory-quote-label">{t("memory.suggestionQuotedFrom")}</span>
                {summary.quote}
              </blockquote>
            ) : null}
            <div className="learned-memory-actions">
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => decide(suggestion, "accept")}
              >
                <IconCheck size={14} aria-hidden />
                {t("memory.suggestionAccept")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => decide(suggestion, "reject")}
              >
                <IconClose size={14} aria-hidden />
                {t("memory.suggestionReject")}
              </Button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
