import { isAbsolute } from "node:path";

const MEMORY_SCOPES = new Set(["user", "project"]);
const MEMORY_KINDS = new Set(["preference", "feedback", "fact", "reference"]);

export type PluginMemoryReadHostService = {
  memory?: {
    list: (pluginId: string, input: Record<string, unknown>) => Promise<unknown>;
  };
};

function apiError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "INVALID_PARAMS" });
}

/** Validate and bound the plugin-facing memory listing request before host dispatch. */
export function normalizePluginMemoryListInput(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw apiError("memory input must be an object");
  }
  const value = input as Record<string, unknown>;
  const scope = value.scope;
  if (typeof scope !== "string" || !MEMORY_SCOPES.has(scope)) {
    throw apiError("scope must be user or project");
  }

  const normalized: Record<string, unknown> = {
    scope,
    limit: 50,
    offset: 0,
  };
  const rawPath = value.path;
  if (rawPath !== undefined && rawPath !== null) {
    if (typeof rawPath !== "string" || !rawPath.trim() || !isAbsolute(rawPath)) {
      throw apiError("path must be a non-empty absolute path");
    }
    normalized.path = rawPath;
  } else if (scope === "project") {
    throw apiError("path is required for project scope");
  }

  if (value.kind !== undefined && value.kind !== null) {
    if (typeof value.kind !== "string" || !MEMORY_KINDS.has(value.kind)) {
      throw apiError("kind is not supported");
    }
    normalized.kind = value.kind;
  }
  if (value.limit !== undefined && value.limit !== null) {
    if (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 200) {
      throw apiError("limit must be an integer between 1 and 200");
    }
    normalized.limit = value.limit;
  }
  if (value.offset !== undefined && value.offset !== null) {
    if (
      typeof value.offset !== "number" ||
      !Number.isSafeInteger(value.offset) ||
      value.offset < 0
    ) {
      throw apiError("offset must be a non-negative integer");
    }
    normalized.offset = value.offset;
  }
  return normalized;
}

/** Skip the learned-memory RPC entirely while the user's read switch is off. */
export async function listPluginMemoryWhenEnabled(
  isReadEnabled: () => Promise<boolean>,
  list: () => Promise<unknown>,
): Promise<unknown> {
  if (!(await isReadEnabled())) {
    return { readEnabled: false, entries: [], nextOffset: null };
  }
  return list();
}
