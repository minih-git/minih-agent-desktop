/**
 * Remote session header status strip chips (ADR mobile-redesign §3 Stage 5).
 *
 * The remote session header displays what the desktop shows for this session:
 * model (+ thinking level when present), mode, and permission mode — each
 * rendered as a `Tag` that opens the session info sheet.
 *
 * Every value is read strictly from the RACP session record (`RacpSession`).
 * If a field is absent from the session record, its chip is omitted rather than
 * invented or inferred from message text.
 */
import type { RacpPermissionMode, RacpSession } from "@minih-agent/shared";

export type SessionChipKind = "model" | "mode" | "permission";

export type SessionChipRecord = Partial<
  Pick<
    RacpSession,
    "modelId" | "modelLabel" | "thinkingLevel" | "mode" | "permissionMode"
  >
>;

export interface SessionChip {
  kind: SessionChipKind;
  tone: "gradient" | "neutral";
  label: string;
}

export interface SessionChipFormatters {
  modeLabel?: (mode: "agent" | "plan" | "goal") => string;
  permissionLabel?: (permissionMode: RacpPermissionMode) => string;
}

const VALID_MODES = new Set<RacpSession["mode"]>(["agent", "plan", "goal"]);
const VALID_PERMISSIONS = new Set<RacpPermissionMode>([
  "ask",
  "accept-edits",
  "auto",
]);

/**
 * Turn an RACP session record into the ordered status strip chips to render.
 *
 * - `model`: uses `session.modelLabel` (falling back to `session.modelId` when
 *   `modelLabel` is absent). If `session.thinkingLevel` is also present and
 *   non-empty, it is appended as `${model} · ${thinkingLevel}`. If neither
 *   `modelLabel` nor `modelId` is present on the session record, no model chip
 *   is emitted.
 * - `mode`: emitted only when `session.mode` is `"agent" | "plan" | "goal"`.
 * - `permission`: emitted only when `session.permissionMode` is
 *   `"ask" | "accept-edits" | "auto"`.
 */
export function sessionChips(
  session: SessionChipRecord | null | undefined,
  formatters?: SessionChipFormatters,
): SessionChip[] {
  if (!session) return [];

  const chips: SessionChip[] = [];

  const modelName = session.modelLabel?.trim() || session.modelId?.trim() || "";
  if (modelName) {
    const thinking = session.thinkingLevel?.trim() || "";
    const label = thinking ? `${modelName} · ${thinking}` : modelName;
    chips.push({
      kind: "model",
      tone: "gradient",
      label,
    });
  }

  if (session.mode && VALID_MODES.has(session.mode)) {
    chips.push({
      kind: "mode",
      tone: "neutral",
      label: formatters?.modeLabel
        ? formatters.modeLabel(session.mode)
        : session.mode,
    });
  }

  if (
    session.permissionMode &&
    VALID_PERMISSIONS.has(session.permissionMode)
  ) {
    chips.push({
      kind: "permission",
      tone: "neutral",
      label: formatters?.permissionLabel
        ? formatters.permissionLabel(session.permissionMode)
        : session.permissionMode,
    });
  }

  return chips;
}
