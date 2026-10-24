/**
 * What this session runs on (R7, spec §15.6, ADR mobile-redesign §D7).
 *
 * A sheet rather than a screen: the reader is looking at a conversation, wants
 * one fact or one change, and goes back. Every edit is a `session/configure` or
 * `session/rename` round trip — nothing is applied optimistically, and the sheet
 * keeps showing the old value until the Host answers.
 *
 * Deleting or archiving a remote session stays desktop-only (§D7): the sheet
 * explains this plainly instead of rendering a dead or fake button.
 */
import type { RacpModelSummary, RacpPermissionMode, RacpSession } from "@minih-agent/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  describeModel,
  effectiveThinkingLevel,
  isThinkingLevel,
  modelKey,
  modelSwitchBlockedReason,
  orderedThinkingLevels,
  thinkingLevelOnModelSwitch,
} from "../../lib/model-choice.js";
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
  onConfigure: (input: {
    providerId?: string;
    modelId?: string;
    thinkingLevel?: string;
    mode?: "agent" | "plan" | "goal";
    permissionMode?: RacpPermissionMode;
  }) => void;
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
  const [picker, setPicker] = useState<"model" | "thinking" | "mode" | "permission" | null>(null);

  useEffect(() => {
    setTitle(session?.title ?? "");
  }, [session?.title, open]);

  // A recorded absence of `controller` is the only thing that removes the edit
  // affordances; an entry from before roles existed is treated as unknown.
  const editable = !roles || roles.includes("controller");
  const locked = modelSwitchBlockedReason({ running, hasPendingDecision });
  const currentModel =
    models.find(
      (model) =>
        (session?.providerId &&
          model.providerId === session.providerId &&
          model.modelId === session?.modelId) ||
        (!session?.providerId && session?.modelId && model.modelId === session.modelId),
    ) ??
    (!session?.modelId ? (models.find((model) => model.isDefault) ?? models[0]) : undefined);

  /**
   * Thinking levels this session can be put on.
   *
   * The list is the current model's own — a model that publishes none has no
   * row at all, rather than a picker whose every option the Host would refuse.
   * The value shown is what the session recorded, or the model's default when
   * it recorded nothing; `off` is never invented.
   */
  const thinkingLevels = currentModel ? orderedThinkingLevels(currentModel) : [];
  const thinkingLevel = effectiveThinkingLevel(currentModel, session?.thinkingLevel);
  const thinkingLevelLabel = (level: string): string =>
    isThinkingLevel(level) || level === "omit" ? t(`thinkingLevel.${level}`) : level;

  const row = (label: string, value: string, onClick?: () => void) => (
    <div className="flex min-h-[50px] items-center gap-3 border-t border-[var(--rm-hair)] px-1">
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] leading-[16px] text-[var(--rm-text-muted)]">
          {label}
        </span>
        <span className="block truncate text-[15px] font-medium leading-[20px] text-[var(--rm-text-primary)]">
          {value}
        </span>
      </span>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="text-[13px] font-medium text-[var(--rm-link)]"
        >
          {t("common.change")}
        </button>
      ) : null}
    </div>
  );

  const option = (
    label: string,
    description: string | null,
    selected: boolean,
    disabled: boolean,
    onSelect: () => void,
  ) => (
    <button
      key={label}
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`flex min-h-[52px] items-center gap-3 rounded-[12px] px-3 py-2 text-left ${
        selected ? "bg-[var(--rm-bg-surface-2)]" : ""
      } disabled:opacity-50`}
    >
      <span
        className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border ${
          selected
            ? "border-[var(--rm-accent)] bg-[var(--rm-accent)]"
            : "border-[var(--rm-separator)]"
        }`}
        aria-hidden="true"
      >
        {selected ? <span className="h-1.5 w-1.5 rounded-full bg-[var(--rm-bg-raised)]" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium leading-[20px] text-[var(--rm-text-primary)]">
          {label}
        </span>
        {description ? (
          <span className="mt-0.5 block text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
            {description}
          </span>
        ) : null}
      </span>
    </button>
  );

  const title_ =
    picker === "model"
      ? t("model.title")
      : picker === "thinking"
        ? t("sessions.new.thinking")
        : picker === "mode"
          ? t("sessions.new.mode")
          : picker === "permission"
            ? t("sessions.new.permission")
            : session?.title || t("session.untitled");

  const handleClose = () => {
    setPicker(null);
    setRenaming(false);
    onClose();
  };

  return (
    <Sheet open={open} onClose={handleClose} title={title_}>
      {picker ? (
        <>
          {picker === "model" ? (
            <>
              {locked ? (
                <p className="mb-2 rounded-[12px] bg-[var(--rm-bg-surface-2)] px-3 py-2 text-[13px] leading-[18px] text-[var(--rm-text-secondary)]">
                  {t(locked)}
                </p>
              ) : null}
              {models.length === 0 ? (
                <p className="px-2 py-3 text-center text-[13px] text-[var(--rm-text-muted)]">
                  {t("model.none")}
                </p>
              ) : (
                models.map((model) =>
                  option(
                    model.label,
                    `${model.providerLabel}${model.supportsImages ? ` · ${t("model.readsImages")}` : ""}`,
                    currentModel ? modelKey(model) === modelKey(currentModel) : false,
                    locked !== null || pending,
                    () => {
                      // A level the new model still offers is kept by leaving the
                      // field out; one it does not offer falls back to the new
                      // model's default, exactly as the desktop does.
                      const next = thinkingLevelOnModelSwitch(model, session?.thinkingLevel);
                      onConfigure({
                        providerId: model.providerId,
                        modelId: model.modelId,
                        ...(next ? { thinkingLevel: next } : {}),
                      });
                      setPicker(null);
                    },
                  ),
                )
              )}
            </>
          ) : null}
          {picker === "thinking" ? (
            <>
              {locked ? (
                <p className="mb-2 rounded-[12px] bg-[var(--rm-bg-surface-2)] px-3 py-2 text-[13px] leading-[18px] text-[var(--rm-text-secondary)]">
                  {t(locked)}
                </p>
              ) : null}
              {thinkingLevels.map((level) =>
                option(
                  thinkingLevelLabel(level),
                  null,
                  thinkingLevel === level,
                  locked !== null || pending,
                  () => {
                    onConfigure({ thinkingLevel: level });
                    setPicker(null);
                  },
                ),
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
                className="min-w-0 flex-1 rounded-[12px] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface-2)] px-3 py-2 text-[16px] text-[var(--rm-text-primary)] outline-none focus:border-[var(--rm-accent)]"
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
            currentModel
              ? describeModel(currentModel)
              : session?.modelLabel || session?.modelId || t("model.hostDefault"),
            editable ? () => setPicker("model") : undefined,
          )}
          {thinkingLevels.length > 0
            ? row(
                t("sessions.new.thinking"),
                thinkingLevel ? thinkingLevelLabel(thinkingLevel) : t("thinkingLevel.default"),
                editable ? () => setPicker("thinking") : undefined,
              )
            : null}
          {row(
            t("sessions.new.mode"),
            t(`mode.${session?.mode ?? "agent"}.title`),
            editable ? () => setPicker("mode") : undefined,
          )}
          {row(
            t("sessions.new.permission"),
            t(`permission.${session?.permissionMode ?? "ask"}.title`),
            editable ? () => setPicker("permission") : undefined,
          )}
          {failure ? (
            <p className="mt-2 text-center text-[13px] leading-[18px] text-[var(--rm-error)]">
              {failure}
            </p>
          ) : null}
          <p className="mt-3 rounded-[12px] bg-[var(--rm-bg-surface-2)] px-3 py-2.5 text-[12px] leading-[17px] text-[var(--rm-text-muted)]">
            {t("session.deleteOwnerOnlyBody")}
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {editable && !renaming ? (
              <Button variant="secondary" size="medium" onClick={() => setRenaming(true)}>
                {t("session.rename")}
              </Button>
            ) : null}
            <Button variant="plain" size="medium" onClick={handleClose}>
              {t("common.done")}
            </Button>
          </div>
        </>
      )}
    </Sheet>
  );
}
