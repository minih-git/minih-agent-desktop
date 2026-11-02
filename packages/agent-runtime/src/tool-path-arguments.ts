import { isRecord } from "./agent-messages.js";
/** Accepted path spellings, in execution precedence after the canonical path. */
export const PATH_ARG_ALIASES = {
  file_path: "path",
  filepath: "path",
  filePath: "path",
  filename: "path",
  fileName: "path",
  file: "path",
} as const;

/** The stored spelling must resolve exactly as normalizeToolParams executes it. */
export function fileOperationPath(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const key = ["path", ...Object.keys(PATH_ARG_ALIASES)].find((name) => args[name] !== undefined);
  const value = key === undefined ? undefined : args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
