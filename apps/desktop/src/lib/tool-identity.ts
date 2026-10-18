import { getToolAction } from "./tool-display";

export type ToolIdentity = {
  kind: "skill" | "mcp" | "plugin" | "tool";
  name: string;
};

/** Presentation only: keep identity separate from action/result classification. */
export function getToolIdentity(toolName: string | undefined, args: unknown): ToolIdentity | null {
  const name = toolName?.trim();
  if (!name) return null;
  const bare = name.split(".").pop()!.toLowerCase();
  if (bare === "skill") {
    const record = args && typeof args === "object" && !Array.isArray(args)
      ? args as Record<string, unknown> : null;
    // `id` is the current contract; imported histories can use `skill` or `name`.
    for (const key of ["id", "skill", "name"]) {
      const value = record?.[key];
      if (typeof value === "string" && value.trim()) {
        return { kind: "skill", name: value.trim() };
      }
    }
    return { kind: "skill", name };
  }
  // Prefixes are authoritative; underscores inside owner/tool ids are ambiguous,
  // so retain the exact qualified name rather than inventing a server boundary.
  if (/^mcp[_-]/.test(bare)) return { kind: "mcp", name };
  if (/^plugin[_-]/.test(bare)) return { kind: "plugin", name };
  return getToolAction(toolName) === "use" ? { kind: "tool", name } : null;
}
