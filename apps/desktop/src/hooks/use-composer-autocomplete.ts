import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyCompletion,
  compareMatches,
  detectTrigger,
  fileReferenceLabel,
  formatCommandInsert,
  formatFileInsert,
  fuzzyMatchCommand,
  fuzzyMatchPath,
  selectBestMatches,
  type ComposerCommand,
  type ComposerTrigger,
  type FsIndexEntry,
  type FuzzyMatch,
  type SessionSummary,
} from "@minih-agent/shared";
import { api } from "../lib/api";
import {
  fetchComposerCommands,
  prewarmComposerCommands,
  readComposerCommandsCache,
} from "../lib/composer-command-source";
import { useAppStore } from "../stores/app-store";
import { sessionTargetCandidates } from "../features/chat/composer/session-targets";

/**
 * Composer autocomplete state machine (D123–D125, D673): trigger detection
 * over draft+cursor, lazily fetched command/file sources, the session targets
 * the store already holds, local fuzzy filtering, and insert-on-accept. IME
 * freezing and key routing live in the Composer; this hook only refuses to
 * update while `composing` is true.
 */

const MAX_FILE_ITEMS = 50;
const SOURCE_TTL_MS = 10_000;
const FILE_SEARCH_DEBOUNCE_MS = 150;

export type AutocompleteItem =
  | { kind: "command"; command: ComposerCommand; match: FuzzyMatch }
  | { kind: "path"; entry: FsIndexEntry; match: FuzzyMatch }
  | { kind: "session"; session: SessionSummary; match: FuzzyMatch };

/**
 * Module-level TTL cache so re-triggering stays IPC-free. The `/` command
 * source itself lives in `lib/composer-command-source`, because the launch
 * pre-warm (#1543) must seed it before this hook mounts.
 */
let filesCache: {
  key: string;
  at: number;
  entries: FsIndexEntry[];
  truncated: boolean;
} | null = null;

const COMMAND_GROUP_ORDER = {
  template: 0,
  builtin: 1,
  plugin: 2,
  extension: 3,
  mcp: 4,
  skill: 5,
} as const;

function filterCommands(
  commands: ComposerCommand[],
  query: string,
  skillsOnly = false,
): AutocompleteItem[] {
  const matched: Array<{
    command: ComposerCommand;
    match: FuzzyMatch;
    sortText: string;
  }> = [];
  for (const command of commands) {
    if (skillsOnly && command.kind !== "skill") continue;
    const byName = fuzzyMatchCommand(query, command.name);
    if (byName) {
      matched.push({ command, match: byName, sortText: command.name });
      continue;
    }
    // Title/description hits keep the row findable, without name highlights.
    const byTitle =
      fuzzyMatchCommand(query, command.title) ??
      (command.description
        ? fuzzyMatchCommand(query, command.description)
        : null);
    if (byTitle) {
      matched.push({
        command,
        match: { score: Math.max(0, byTitle.score - 20), ranges: [] },
        sortText: command.name,
      });
    }
  }
  matched.sort((a, b) => {
    const groupDelta =
      COMMAND_GROUP_ORDER[a.command.kind] - COMMAND_GROUP_ORDER[b.command.kind];
    if (groupDelta !== 0) return groupDelta;
    return compareMatches(
      { score: a.match.score, text: a.sortText },
      { score: b.match.score, text: b.sortText },
    );
  });
  return matched.map(({ command, match }) => ({ kind: "command", command, match }));
}

function filterFiles(entries: FsIndexEntry[], query: string): AutocompleteItem[] {
  const matched: Array<{ entry: FsIndexEntry; match: FuzzyMatch }> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const match = fuzzyMatchPath(query, entry.path, entry.kind);
    if (!match || seen.has(entry.path)) continue;
    seen.add(entry.path);
    matched.push({ entry, match });
  }
  // The index can hold thousands of entries while the menu shows at most
  // MAX_FILE_ITEMS, so only the bounded top slice is ever ordered.
  return selectBestMatches(matched, MAX_FILE_ITEMS, ({ entry, match }) => ({
    score: match.score,
    text: entry.path,
  })).map(({ entry, match }) => ({ kind: "path", entry, match }));
}

/**
 * Result of resolving one typed "/name" at send time.
 *
 * `unavailable` is the branch that keeps a failed source read from looking like
 * "no such command": the composer can only guess whether `/compact` is a
 * builtin it must not send to the model, so it refuses the submission instead
 * of degrading a control command into prompt text (issue #795).
 */
export type ComposerCommandResolution =
  | { status: "resolved"; command: ComposerCommand }
  | { status: "unknown" }
  | { status: "unavailable"; error: Error };

/**
 * Resolve a typed "/name" against the merged command and skill list at send
 * time (builtin/plugin dispatch and skill validation); templates, non-command
 * names, and unknown names stay on the prompt path. Reuses the menu's TTL cache
 * when warm, so a warm cache keeps resolving through a source blip.
 */
export async function resolveComposerCommand(
  name: string,
): Promise<ComposerCommandResolution> {
  const key = useAppStore.getState().workspace?.path ?? "";
  let commands = readComposerCommandsCache(key);
  if (!commands) {
    try {
      commands = await fetchComposerCommands(key);
    } catch (error) {
      // Deliberately leaves the cache cold: the next attempt re-reads the
      // source, which is what makes the refusal retriable.
      return {
        status: "unavailable",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
  const command = commands.find((c) => c.name === name);
  return command ? { status: "resolved", command } : { status: "unknown" };
}

export function useComposerAutocomplete({
  value,
  cursor,
  composing,
  enabled,
}: {
  value: string;
  cursor: number;
  composing: boolean;
  enabled: boolean;
}) {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const workspaceKey = useAppStore((s) => s.workspace?.path ?? "");
  const hasWorkspace = workspaceKey !== "";
  const fileSourceKey = JSON.stringify([workspaceKey, sessionId ?? ""]);
  const ready = useAppStore((s) => s.ready);
  // The session targets come from the store, not from the host: the list is
  // already there, so a `#` never waits for a round trip.
  const sessions = useAppStore((s) => s.sessions);
  const sessionMeta = useAppStore((s) => s.sessionMeta);
  const activeProjectPath = useAppStore((s) => s.activeProjectPath);
  const [commands, setCommands] = useState<ComposerCommand[] | null>(null);
  const [files, setFiles] = useState<{
    scope: string;
    entries: FsIndexEntry[];
    truncated: boolean;
  } | null>(null);
  const filesHere = files?.scope === fileSourceKey ? files : null;
  const [found, setFound] = useState<{
    scope: string;
    entries: FsIndexEntry[];
    truncated: boolean;
  } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const frozenRef = useRef<ComposerTrigger | null>(null);

  const liveTrigger = useMemo(
    () => (enabled ? detectTrigger(value, cursor) : null),
    [enabled, value, cursor],
  );
  // During IME composition the menu freezes: no opening, closing, or
  // re-filtering until compositionend re-evaluates (D125).
  const trigger = composing ? frozenRef.current : liveTrigger;
  useEffect(() => {
    if (!composing) frozenRef.current = liveTrigger;
  }, [composing, liveTrigger]);

  const triggerKey = trigger ? `${trigger.mode}:${trigger.tokenStart}` : null;
  const dismissed = triggerKey !== null && triggerKey === dismissedKey;

  // Escape-dismissal clears once the trigger token goes away.
  useEffect(() => {
    if (dismissedKey && triggerKey !== dismissedKey) setDismissedKey(null);
  }, [triggerKey, dismissedKey]);

  // Lazy source fetch with a short TTL, keyed by workspace. A `#` group reads
  // the session list the store already holds, so it must not pay for a file
  // index round trip.
  useEffect(() => {
    if (!trigger || dismissed || trigger.mode === "session") return;
    const now = Date.now();
    if (trigger.mode === "slash") {
      const cached = readComposerCommandsCache(workspaceKey);
      if (cached) {
        setCommands(cached);
        return;
      }
      let cancelled = false;
      void fetchComposerCommands(workspaceKey)
        .then((commands) => {
          if (!cancelled) setCommands(commands);
        })
        .catch(() => {
          if (!cancelled) setCommands([]);
        });
      return () => {
        cancelled = true;
      };
    }
    if (!hasWorkspace) {
      setFiles({ scope: fileSourceKey, entries: [], truncated: false });
      return;
    }
    if (
      filesCache &&
      filesCache.key === fileSourceKey &&
      now - filesCache.at < SOURCE_TTL_MS
    ) {
      setFiles({ scope: fileSourceKey, entries: filesCache.entries, truncated: filesCache.truncated });
      return;
    }
    let cancelled = false;
    void api
      .fsIndex(sessionId)
      .then((res) => {
        if (cancelled) return;
        filesCache = { key: fileSourceKey, at: Date.now(), ...res };
        setFiles({ scope: fileSourceKey, ...res });
      })
      .catch(() => {
        if (!cancelled) setFiles({ scope: fileSourceKey, entries: [], truncated: false });
      });
    return () => {
      cancelled = true;
    };
  }, [trigger?.mode, dismissed, workspaceKey, hasWorkspace, sessionId, fileSourceKey]);

  // Search only beyond a truncated snapshot. Every answer belongs to exactly
  // one session, token and query; late results cannot replace the current menu.
  const fileQuery = trigger?.mode === "file" && !dismissed && filesHere?.truncated
    ? trigger.query : "";
  const searchScope = JSON.stringify([fileSourceKey, triggerKey, fileQuery]);
  useEffect(() => {
    if (!fileQuery) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void api.fsSearch(sessionId, fileQuery).then((res) => {
        if (!cancelled) setFound({ scope: searchScope, ...res });
      }).catch(() => {
        // Keep the usable snapshot and its truncation note on search failure.
        if (!cancelled) setFound({ scope: searchScope, entries: [], truncated: true });
      });
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fileQuery, searchScope, sessionId]);
  useEffect(() => {
    if (!triggerKey) setFound(null);
  }, [triggerKey]);
  const foundHere = fileQuery !== "" && found?.scope === searchScope ? found : null;
  const fileTruncated = (filesHere?.truncated ?? false) &&
    (!fileQuery || !foundHere || foundHere.truncated);

  // Warm the `/` source once bootstrap settles, so the first slash of a session
  // does not wait for a cold host round trip (#1543). Waiting for `ready` keeps
  // the pre-warm off the pre-hydration empty workspace key, which would spend a
  // full host assembly and then be discarded.
  useEffect(() => {
    if (!enabled || !ready) return;
    return prewarmComposerCommands(workspaceKey);
  }, [enabled, ready, workspaceKey]);

  const items = useMemo<AutocompleteItem[]>(() => {
    if (!trigger || dismissed) return [];
    if (trigger.mode === "slash") {
      return commands ? filterCommands(commands, trigger.query, trigger.tokenStart > 0) : [];
    }
    if (trigger.mode === "session") {
      return sessionTargetCandidates({
        sessions,
        sessionMeta,
        activeSessionId: sessionId,
        activeProjectPath,
        query: trigger.query,
      }).map(({ session, match }) => ({ kind: "session", session, match }));
    }
    return filesHere ? filterFiles(
      foundHere ? [...foundHere.entries, ...filesHere.entries] : filesHere.entries,
      trigger.query,
    ) : [];
  }, [trigger, dismissed, commands, filesHere, foundHere, sessions, sessionMeta, sessionId, activeProjectPath]);

  // New query or mode restarts keyboard navigation at the top hit.
  const itemsKey = trigger ? `${trigger.mode}:${trigger.query}` : "";
  useEffect(() => {
    setHighlight(0);
  }, [itemsKey]);

  // The session source is the store itself, so it is ready as soon as a trigger
  // exists; a target group with no match never opens at all, which keeps
  // `#123`, `## heading` and the like as the ordinary text they are.
  const sourceReady =
    !!trigger &&
    (trigger.mode === "slash"
      ? commands !== null
      : trigger.mode === "session"
        ? items.length > 0
        : filesHere !== null);
  const open = !!trigger && !dismissed && sourceReady;

  const close = useCallback(() => {
    if (triggerKey) setDismissedKey(triggerKey);
  }, [triggerKey]);

  const accept = useCallback(
    (
      index: number,
    ):
      | {
          value: string;
          cursor: number;
          fileReference?: { path: string; name: string };
          sessionTarget?: { sessionId: string; title: string };
        }
      | null => {
      if (!trigger) return null;
      const item = items[index];
      if (!item) return null;
      if (item.kind === "session") {
        // The target becomes an inline chip, so accepting replaces the typed
        // query with nothing here; the caller splices the chip token and the
        // one space that lets the user keep typing after it.
        return {
          ...applyCompletion(value, trigger, ""),
          sessionTarget: { sessionId: item.session.id, title: item.session.title },
        };
      }
      if (item.kind === "path" && item.entry.kind === "file") {
        return {
          ...applyCompletion(value, trigger, ""),
          fileReference: {
            path: item.entry.path,
            name: fileReferenceLabel(item.entry.path),
          },
        };
      }
      const insert =
        item.kind === "command"
          ? formatCommandInsert(item.command.name)
          : formatFileInsert(item.entry.path, item.entry.kind);
      return applyCompletion(value, trigger, insert);
    },
    [trigger, items, value],
  );

  return {
    open,
    mode: open && trigger ? trigger.mode : null,
    query: open && trigger ? trigger.query : "",
    items: open ? items : [],
    hasItems: open && items.length > 0,
    highlight,
    setHighlight,
    truncated: open && trigger?.mode === "file" ? fileTruncated : false,
    noWorkspace: open && trigger?.mode === "file" && !hasWorkspace,
    close,
    accept,
  };
}
