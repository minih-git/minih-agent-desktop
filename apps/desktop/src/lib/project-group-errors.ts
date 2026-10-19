/**
 * The one project-group write failure the renderer explains in its own words.
 *
 * Merging folders' pinned memory can pass the host's 32 KiB cap. The host then
 * refuses the whole write — group, group memory, and re-keyed learned memory —
 * and reports `PROJECT_MEMORY_TOO_LARGE` (ADR 0249 §8). Its own message is
 * English, so the dialogs translate that one code and leave every other failure
 * exactly as the host reported it.
 */
import type { TFunction } from "i18next";
import { ErrorCodes } from "@minih-agent/shared";

/** The `AppError.code` of a thrown API error; `invoke` stores it as `code`. */
export function projectGroupErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; errorCode?: unknown };
  const code = typeof value.code === "string" ? value.code : value.errorCode;
  return typeof code === "string" ? code : undefined;
}

/**
 * What a group write should be reported with: an error carrying the localized
 * sentence when the host refused the merge over the cap, and the untouched
 * failure otherwise. Callers keep their existing toast/`onError` display.
 */
export function projectGroupWriteError(error: unknown, t: TFunction): unknown {
  if (projectGroupErrorCode(error) !== ErrorCodes.PROJECT_MEMORY_TOO_LARGE) return error;
  return Object.assign(new Error(t("project.memoryTooLarge")), {
    code: ErrorCodes.PROJECT_MEMORY_TOO_LARGE,
  });
}
