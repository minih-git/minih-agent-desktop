import {
  fallbackBuiltinDefinitions,
  type SubagentDefinition,
  type UserSubagentRecord,
} from "@minih-agent/shared";
import { api } from "../../lib/api";

/**
 * One shipped default plus whether this installation still offers it and
 * whether `~/.agents/subagents/<name>.md` currently customizes it in place.
 *
 * A switched-off or customized builtin stays in the list on purpose: editing
 * adjusts the builtin in place, and one-click restore removes the override
 * document to return to the factory definition.
 */
export type BuiltinSubagentRow = SubagentDefinition & {
  enabled: boolean;
  customized?: boolean;
  override?: UserSubagentRecord;
};

/** User-owned documents plus the shipped defaults, switched off ones included. */
export type SubagentPageData = {
  owned: UserSubagentRecord[];
  builtins: BuiltinSubagentRow[];
};

export const EMPTY_SUBAGENT_PAGE: SubagentPageData = {
  owned: [],
  builtins: [],
};

/**
 * Merge user-owned records with the shipped built-in catalog so that every
 * built-in stays in `builtins` (with `customized` and `override` attached when
 * `~/.agents/subagents/<handle>.md` exists) and `owned` lists only custom
 * user-defined subagents.
 */
export function buildSubagentPageData(
  owned: readonly UserSubagentRecord[],
  catalogBuiltins: readonly (SubagentDefinition & { enabled: boolean })[],
): SubagentPageData {
  const shipped = fallbackBuiltinDefinitions();
  const builtinHandles = new Set(shipped.map((item) => item.name));
  const overrides = new Map<string, UserSubagentRecord>();
  for (const row of owned) {
    if (builtinHandles.has(row.id)) {
      overrides.set(row.id, row);
    }
  }
  const catalogByHandle = new Map(
    catalogBuiltins
      .filter((item) => item.source === "builtin")
      .map((item) => [item.name, item]),
  );
  const builtins: BuiltinSubagentRow[] = shipped.map((shippedItem) => {
    const item = catalogByHandle.get(shippedItem.name) ?? {
      ...shippedItem,
      enabled: true,
    };
    const override = overrides.get(item.name);
    if (!override) {
      return {
        ...item,
        customized: false,
      };
    }
    return {
      ...item,
      description: override.description ?? item.description,
      tools: override.tools,
      enabled: override.enabled,
      thinkingLevel: override.thinkingLevel ?? item.thinkingLevel,
      maxTokens: override.maxTokens ?? item.maxTokens,
      customized: true,
      override,
    };
  });
  return {
    owned: owned.filter((row) => !builtinHandles.has(row.id)),
    builtins,
  };
}

/**
 * Settings lists two sources: the writable global registry, and the shipped
 * defaults `Task` offers. Catalog load failures must not hide the user list, so
 * builtins fall back to the shared preset catalog — reported enabled, because a
 * failed read cannot say which handles the user turned off.
 */
export async function fetchSubagentPageData(): Promise<SubagentPageData> {
  const ownedResult = await api.listUserSubagents({ level: "global" });
  const owned = ownedResult.subagents ?? [];
  try {
    const catalog = await api.subagentCatalog();
    // Older main processes answer without `builtins`; derive the group from the
    // effective catalog then, which is how this page read it before builtins
    // could be switched off at all.
    const builtins =
      catalog.builtins ??
      (catalog.subagents ?? [])
        .filter((item) => item.source === "builtin")
        .map((item) => ({ ...item, enabled: true }));
    return buildSubagentPageData(owned, builtins);
  } catch {
    return buildSubagentPageData(
      owned,
      fallbackBuiltinDefinitions().map((item) => ({ ...item, enabled: true })),
    );
  }
}
