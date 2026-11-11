import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fallbackBuiltinDefinitions } from "@minih-agent/shared";
import { api } from "../../lib/api";

/** One selectable definition: the `Task` handle plus a readable name. */
export type BotDefinitionOption = { id: string; label: string };

/** Preset copy the subagents page already ships for the built-in handles. */
const PRESET_NAME_KEYS: Record<string, string> = {
  explorer: "extensions.subagents.presetExplorerName",
  "code-reviewer": "extensions.subagents.presetReviewerName",
  "test-runner": "extensions.subagents.presetTestRunnerName",
  fixer: "extensions.subagents.presetFixerName",
  "ui-designer": "extensions.subagents.presetUiDesignerName",
};

/**
 * The definition handles an employee can run as (ADR bot-sessions-and-steward
 * §2). `steward` is a shipped built-in, so it appears here like any other.
 *
 * A failed catalog read keeps the shipped defaults instead of emptying the
 * picker: an employee with no definition is a valid row, but a picker that
 * silently lost `steward` would hide the one definition that dispatches work.
 */
export function useBotDefinitions(): BotDefinitionOption[] {
  const { t } = useTranslation();
  const [handles, setHandles] = useState<string[]>(() =>
    fallbackBuiltinDefinitions().map((definition) => definition.name),
  );

  useEffect(() => {
    let cancelled = false;
    void api
      .subagentCatalog()
      .then((catalog) => {
        if (cancelled) return;
        const names = (catalog.builtins ?? catalog.subagents ?? [])
          .filter((item) => item.enabled !== false)
          .map((item) => item.name)
          .filter((name): name is string => Boolean(name));
        if (names.length > 0) setHandles([...new Set(names)]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return handles.map((id) => {
    const nameKey = PRESET_NAME_KEYS[id];
    const name = nameKey ? t(nameKey) : "";
    return { id, label: name ? `${id} · ${name}` : id };
  });
}
