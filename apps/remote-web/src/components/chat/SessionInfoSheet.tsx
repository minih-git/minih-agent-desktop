/**
 * What this session runs on (R7, spec §15.6).
 *
 * A sheet rather than a screen: the reader is looking at a conversation, wants
 * one fact or one change, and goes back. Every edit is a `session/configure` or
 * `session/rename` round trip — nothing is applied optimistically, and the sheet
 * keeps showing the old value until the Host answers.
 */
import type { RacpModelSummary, RacpPermissionMode, RacpSession } from "@minih-agent/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { describeModel, modelKey, modelSwitchBlockedReason } from "../../lib/model-choice.js";
import { Button } from "../ui/Button.js";
import { Sheet } from "../ui/Sheet.js";

export type SessionInfoSheetProps = {
  open: boolean;
  session: RacpSession | null;
  computerLabel: string;
  /** Roles the Gateway granted this device; absent means "not recorded". */
  roles?: readonly string[];
  models: readonly RacpModelSummary[];
  running: boolean;
  hasPendingDecision: boolean;
  pending: boolean;
  failure: string | null;
  onClose: () => void;
  onRename: (title: string) => void;
  onConfigure: (input: { providerId?: string; modelId?: string; mode?: "agent" | "plan" | "goal"; permissionMode?: RacpPermissionMode }) => void;
};

const MODES: Array<"agent" | "plan" | "goal"> = ["agent", "plan", "goal"];
const PERMISSIONS: RacpPermissionMode[] = ["ask", "accept-edits", "auto"];

export function SessionInfoSheet({
  open,
  session,
  computerLabel,
  roles,
  models,
  running,
  hasPendingDecision,
  pending,
  failure,
  onClose,
  onRename,
  onConfigure,
}: SessionInfoSheetProps) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(session?.title ?? "");
  const [picker, setPicker] = useState<"model" | "mode" | "permission" | null>(null);
  // A recorded absence of `controller` is the only thing that removes the edit
  // affordances; an entry from before roles existed is treated as unknown.
  const editable = !roles || roles.includes("controller");
  const locked = modelSwitchBlockedReason({ running, hasPendingDecision });
  const currentModel = models.find(
    (model) => model.providerId === session?.providerId && model.modelId === session?.modelId,
  );

  const row = (label: string, value: string, onClick?: () => void) => (
    <div className="flex min-h-[48px] items-center gap-3 border-t border-[var(--rm-separator)] px-1">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] leading-[18px] text-[var(--rm-text-muted)]">{label}</span>
        <span className="block truncate text-[15px] leading-[20px] text-[var(--rm-text-primary)]">{value}</span>
      </span>
      {onClick ? (
        <button type="button" onClick={onClick} className="text-[13px] text-[var(--rm-link)]">
          {t("common.change")}
        </button>
      ) : null}
    </div>
  );

  const option = (label: string, description: string | null, selected: boolean, disabled: boolean, onSelect: () => void) => (
    <button
      key={label}
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`flex min-h-[52px] items-center gap-3 rounded-[10px] px-3 py-2 text-left ${
        selected ? "bg-[var(--rm-bg-inset)]" : ""
      } disabled:opacity-50`}
    >
      <span
        className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border ${
          selected ? "border-[var(--rm-accent)] bg-[var(--rm-accent)]" : "border-[var(--rm-separator)]"
        }`}
        aria-hidden="true"
      >
        {selected ? <span className="h-1.5 w-1.5 rounded-full bg-[var(--rm-bg-raised)]" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] leading-[20px]">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-[13px] leading-[18px] text-[var(--rm-text-muted)]">{description}</span>
        ) : null}
      </span>
    </button>
  );

  const title_ = picker === "model" ? t("model.title") : picker === "mode" ? t("sessions.new.mode") : picker === "permission" ? t("sessions.new.permission") : (session?.title || t("session.untitled"));

  return (
    <Sheet open={open} onClose={onClose} title={title_}>
      {picker ? (
        <>
          {picker === "model" ? (
            <>
              {locked ? (
                <p className="mb-2 rounded-[10px] bg-[var(--rm-bg-inset)] px-3 py-2 text-[13px] leading-[18px] text-[var(--rm-text-secondary)]">
                  {t(locked)}
                </p>
              ) : null}
              {models.length === 0 ? (
                <p className="px-2 py-3 text-center text-[13px] text-[var(--rm-text-muted)]">{t("model.none")}</p>
              ) : (
                models.map((model) =>
                  option(
                    model.label,
                    `${model.providerLabel}${model.supportsImages ? ` · ${t("model.readsImages")}` : ""}`,
                    currentModel ? modelKey(model) === modelKey(currentModel) : false,
                    locked !== null || pending,
                    () => {
                      onConfigure({ providerId: model.providerId, modelId: model.modelId });
                      setPicker(null);
                    },
                  ),
                )
              )}
            </>
          ) : null}
          {picker === "mode"
            ? MODES.map((mode) =>
                option(
                  t(`mode.${mode}.title`),
                  t(`mode.${mode}.description`),
                  session?.mode === mode,
                  pending,
                  () => {
                    onConfigure({ mode });
                    setPicker(null);
                  },
                ),
              )
            : null}
          {picker === "permission"
            ? PERMISSIONS.map((mode) =>
                option(
                  t(`permission.${mode}.title`),
                  t(`permission.${mode}.description`),
                  session?.permissionMode === mode,
                  pending,
                  () => {
                    onConfigure({ permissionMode: mode });
                    setPicker(null);
                  },
                ),
              )
            : null}
          <Button variant="plain" size="medium" onClick={() => setPicker(null)}>
            {t("common.back")}
          </Button>
        </>
      ) : (
        <>
          {renaming ? (
            <div className="mb-2 flex items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded-[10px] border border-[var(--rm-separator)] bg-[var(--rm-bg-inset)] px-3 py-2 text-[15px] text-[var(--rm-text-primary)]"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                aria-label={t("session.rename")}
              />
              <Button
                variant="primary"
                size="small"
                disabled={pending || !title.trim()}
                onClick={() => {
                  onRename(title);
                  setRenaming(false);
                }}
              >
                {t("common.done")}
              </Button>
            </div>
          ) : null}
          {row(t("session.computer"), computerLabel)}
          {row(
            t("sessions.new.model"),
            currentModel ? describeModel(currentModel) : session?.modelLabel || t("model.hostDefault"),
            editable && models.length > 0 ? () => setPicker("model") : undefined,
          )}
          {row(t("sessions.new.mode"), t(`mode.${session?.mode ?? "agent"}.title`), editable ? () => setPicker("mode") : undefined)}
          {row(
            t("sessions.new.permission"),
            t(`permission.${session?.permissionMode ?? "ask"}.title`),
            editable ? () => setPicker("permission") : undefined,
          )}
          {failure ? (
            <p className="mt-2 text-center text-[13px] leading-[18px] text-[var(--rm-error)]">{failure}</p>
          ) : null}
          <div className="mt-3 flex flex-col gap-2">
            {editable && !renaming ? (
              <Button variant="secondary" size="medium" onClick={() => setRenaming(true)}>
                {t("session.rename")}
              </Button>
            ) : null}
            <Button variant="plain" size="medium" onClick={onClose}>
              {t("common.done")}
            </Button>
          </div>
        </>
      )}
    </Sheet>
  );
}
