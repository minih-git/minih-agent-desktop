import { ErrorCodes } from "@minih-agent/shared";

/**
 * The code a failed IPC call reports to the renderer.
 *
 * Two conventions meet at this boundary: a main-process failure throws an
 * `Error` carrying `errorCode` (the `AppError` shape), while anything that
 * crossed a Host boundary arrives as a `RacpError` — a `packages/agent-host`
 * class whose code lives in `code`. Reading only `errorCode` reported every
 * remote failure as `INTERNAL`, and the renderer can only turn that into a
 * generic "the remote operation failed"; the reason a person could act on
 * (path outside the browsable root, Host unreachable, Host too old to browse)
 * was lost on the way through.
 *
 * Only a registered application code is adopted. A Node system error carries
 * `code` too (`ENOENT`, `ECONNREFUSED`), and an errno is not an application
 * code: those keep reporting `INTERNAL`.
 */
export function ipcErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return ErrorCodes.INTERNAL;
  const fields = error as {
    data?: { errorCode?: unknown };
    errorCode?: unknown;
    code?: unknown;
  };
  const declared = typeof fields.data?.errorCode === "string"
    ? fields.data.errorCode
    : typeof fields.errorCode === "string"
      ? fields.errorCode
      : undefined;
  if (declared) return declared;
  const code = fields.code;
  if (typeof code === "string" && Object.hasOwn(ErrorCodes, code)) return code;
  return ErrorCodes.INTERNAL;
}