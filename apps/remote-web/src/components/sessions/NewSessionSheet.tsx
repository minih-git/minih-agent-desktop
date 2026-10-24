/**
 * The new-session sheet (R7, spec §15.2).
 *
 * Four rows in the order the decision is actually made — project, model, mode,
 * permission mode — because the client grew up with "start on whatever the
 * computer defaults to", and a session started on the wrong model is the
 * failure this screen exists to prevent.
 */
import type { RacpModelSummary, RacpProjectSummary, ThinkingLevel } from "@minih-agent/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  describeModel,
  isThinkingLevel,
  modelKey,
  orderedThinkingLevels,
  resolveNewSessionModel,
  type ModelChoice,
} from "../../lib/model-choice.js";
import { Button } from "../ui/Button.js";
import { Sheet } from "../ui/Sheet.js";

export type NewSessionMode = "agent" | "plan" | "goal";
export type NewSessionPermission = "ask" | "accept-edits" | "auto";

export type NewSessionChoice = {
  /** Absent for a session that belongs to no project — the "Other" group. */
  projectId?: string;
  providerId?: string;
  modelId?: string;
  /** Absent lets the Host use the model's own default. */
  thinkingLevel?: string;
  mode: NewSessionMode;
  permissionMode: NewSessionPermission;
};

export type NewSessionSheetProps = {
  open: boolean;
  projects: readonly RacpProjectSummary[];
  models: readonly RacpModelSummary[];
  /** Whether the model catalog could not be read; the sheet then says so. */
  modelsFailure?: string | null;
  /** A project to preselect, e.g. a folder the user just registered. */
  initialProjectId?: string | null;
  /**
   * The project cannot be changed here. Used by S5b, where the user is standing
   * in a project and starting a session elsewhere would be a surprise (§17.2):
   * the row then reads as a value, not as a chooser.
   */
  projectLocked?: boolean;
  /**
   * Whether a session with no project may be started from here. The "Other"
   * group lists exactly those sessions, so starting another one there is the
   * natural action and the project row says "no project" instead of offering a
   * folder the user did not ask for.
   */
  allowNoProject?: boolean;
  creating: boolean;
  failure?: string | null;
  onCancel: () => void;
  onAddProject: () => void;
  onCreate: (choice: NewSessionChoice) => void;
};

const MODES: NewSessionMode[] = ["agent", "plan", "goal"];
const PERMISSIONS: NewSessionPermission[] = ["ask", "accept-edits", "auto"];

export function NewSessionSheet({
  open,
  projects,
  models,
  modelsFailure,
  initialProjectId,
  projectLocked = false,
  allowNoProject = false,
  creating,
  failure,
  onCancel,
  onAddProject,
  onCreate,
}: NewSessionSheetProps) {
  const { t } = useTranslation();
  const usable = projects.filter((project) => !project.archived);
  // `""` is "no project" — a session that belongs to no folder, which the
  // "Other" group on the sessions screen lists.
  const [projectId, setProjectId] = useState<string>(
    initialProjectId ?? (allowNoProject ? "" : usable[0]?.id ?? ""),
  );
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const [mode, setMode] = useState<NewSessionMode>("agent");
  const [permission, setPermission] = useState<NewSessionPermission>("ask");
  const [picking, setPicking] = useState<
    "project" | "model" | "thinking" | "mode" | "permission" | null
  >(null);
  /** `null` means "whatever the chosen model defaults to". */
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);

  const choice: ModelChoice = resolveNewSessionModel(models, chosenModel);
  const noProject = allowNoProject && projectId === "";
  const selectedProject = noProject
    ? null
    : (usable.find((project) => project.id === projectId) ?? usable[0] ?? null);

  /**
   * The thinking levels the model about to be used offers, and the one the new
   * session starts on. A model that publishes none gets no row at all: the Host
   * would have nothing to apply such a choice to.
   */
  const chosenSummary = choice.kind === "model" ? choice.model : null;
  const levels = chosenSummary ? orderedThinkingLevels(chosenSummary) : [];
  const defaultLevel = chosenSummary?.defaultThinkingLevel;
  const level: ThinkingLevel | null =
    thinkingLevel && levels.includes(thinkingLevel)
      ? thinkingLevel
      : isThinkingLevel(defaultLevel) && levels.includes(defaultLevel)
        ? defaultLevel
        : (levels[0] ?? null);

  const levelLabel = (value: ThinkingLevel) => t(`thinkingLevel.${value}`);

  const picker = (title: string, rows: React.ReactNode) => (
    <>
      <div className="mb-1 text-center text-[13px] text-[var(--rm-text-muted)]">{title}</div>
      <div className="flex flex-col">{rows}</div>
      <Button variant="plain" size="medium" onClick={() => setPicking(null)}>
        {t("common.back")}
      </Button>
    </>
  );

  const option = (label: string, description: string | null, selected: boolean, onSelect: () => void, disabled = false) => (
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
        <span className="block text-[15px] leading-[20px] text-[var(--rm-text-primary)]">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-[13px] leading-[18px] text-[var(--rm-text-muted)]">{description}</span>
        ) : null}
      </span>
    </button>
  );

  const row = (title: string, value: string, onClick: () => void, disabled = false) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-[52px] w-full items-center gap-3 border-t border-[var(--rm-separator)] px-1 text-left disabled:opacity-50"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] leading-[18px] text-[var(--rm-text-muted)]">{title}</span>
        <span className="block truncate text-[15px] leading-[20px] text-[var(--rm-text-primary)]">{value}</span>
      </span>
      <span className="text-[13px] text-[var(--rm-text-faint)]">›</span>
    </button>
  );

  const modelValue =
    choice.kind === "model"
      ? describeModel(choice.model)
      : choice.kind === "unavailable"
        ? t("model.unavailable")
        : t("model.hostDefault");

  return (
    <Sheet open={open} onClose={onCancel} title={picking ? undefined : t("sessions.new.title")}>
      {picking === "project"
        ? picker(
            t("sessions.new.project"),
            <div className="flex flex-col">
              {allowNoProject
                ? option(t("sessions.noProject"), null, noProject, () => {
                    setProjectId("");
                    setPicking(null);
                  })
                : null}
              {usable.map((project) => option(project.label, null, project.id === selectedProject?.id, () => {
                setProjectId(project.id);
                setPicking(null);
              }))}
              {/* Registering a folder is part of choosing where a session goes,
                  so it stays on this list rather than on the sheet: with two or
                  more projects the row only opens the picker. */}
              <Button variant="secondary" size="medium" onClick={onAddProject}>
                {t("sessions.addProject")}
              </Button>
            </div>,
          )
        : null}

      {picking === "model"
        ? picker(
            t("model.title"),
            models.length === 0
              ? [
                  <p key="empty" className="px-2 py-3 text-center text-[13px] text-[var(--rm-text-muted)]">
                    {modelsFailure ?? t("model.none")}
                  </p>,
                ]
              : models.map((model) =>
                  option(
                    model.label + (model.isDefault ? ` · ${t("model.computerDefault")}` : ""),
                    `${model.providerLabel}${model.supportsImages ? ` · ${t("model.readsImages")}` : ""}`,
                    choice.kind === "model" && modelKey(choice.model) === modelKey(model),
                    () => {
                      setChosenModel(modelKey(model));
                      // Keep a level the new model also offers; otherwise the new
                      // model's own default applies to this session.
                      setThinkingLevel(
                        level && orderedThinkingLevels(model).includes(level) ? level : null,
                      );
                      setPicking(null);
                    },
                  ),
                ),
          )
        : null}

      {picking === "thinking"
        ? picker(
            t("sessions.new.thinking"),
            levels.map((candidate) =>
              option(levelLabel(candidate), null, candidate === level, () => {
                setThinkingLevel(candidate);
                setPicking(null);
              }),
            ),
          )
        : null}

      {picking === "mode"
        ? picker(
            t("sessions.new.mode"),
            MODES.map((candidate) =>
              option(t(`mode.${candidate}.title`), t(`mode.${candidate}.description`), candidate === mode, () => {
                setMode(candidate);
                setPicking(null);
              }),
            ),
          )
        : null}

      {picking === "permission"
        ? picker(
            t("sessions.new.permission"),
            PERMISSIONS.map((candidate) =>
              option(
                t(`permission.${candidate}.title`),
                t(`permission.${candidate}.description`),
                candidate === permission,
                () => {
                  setPermission(candidate);
                  setPicking(null);
                },
              ),
            ),
          )
        : null}

      {picking === null ? (
        <>
          {row(
            t("sessions.new.project"),
            selectedProject?.label ??
              (allowNoProject ? t("sessions.noProject") : t("sessions.noProjects")),
            () => (usable.length > 0 ? setPicking("project") : onAddProject()),
            projectLocked,
          )}
          {row(t("sessions.new.model"), modelValue, () => setPicking("model"))}
          {levels.length > 0 && level
            ? row(t("sessions.new.thinking"), levelLabel(level), () => setPicking("thinking"))
            : null}
          {row(t("sessions.new.mode"), t(`mode.${mode}.title`), () => setPicking("mode"))}
          {row(t("sessions.new.permission"), t(`permission.${permission}.title`), () => setPicking("permission"))}
          {failure ? (
            <p className="mt-2 text-center text-[13px] leading-[18px] text-[var(--rm-error)]">{failure}</p>
          ) : null}
          <div className="mt-3 flex flex-col gap-2">
            <Button
              variant="primary"
              size="large"
              disabled={creating || (!selectedProject && !noProject)}
              onClick={() =>
                onCreate({
                  ...(selectedProject ? { projectId: selectedProject.id } : {}),
                  ...(choice.kind === "model"
                    ? { providerId: choice.model.providerId, modelId: choice.model.modelId }
                    : {}),
                  ...(level ? { thinkingLevel: level } : {}),
                  mode,
                  permissionMode: permission,
                })
              }
            >
              {creating ? t("sessions.creating") : t("sessions.new.start")}
            </Button>
            <Button variant="plain" size="medium" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          </div>
        </>
      ) : null}
    </Sheet>
  );
}
