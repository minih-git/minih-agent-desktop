/**
 * S5b: the sessions of one project, with a horizontal project switcher rail at
 * the top when multiple projects exist (spec §17.2, ADR mobile-redesign §3 Stage 5).
 *
 * The model catalog and the project catalog are read the same way (`model/list`
 * once per sheet open; `project/list` for the rail and new-session choices),
 * and every status vocabulary rule from `session-groups`, `session-format`, and
 * `host-status` is preserved without re-deriving status in the component.
 */
import type { RacpModelSummary, RacpProjectSummary, RacpSession } from "@minih-agent/shared";
import { Folder, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { NewSessionSheet, type NewSessionChoice } from "../components/sessions/NewSessionSheet.js";
import { SessionRow } from "../components/sessions/SessionRow.js";
import { Banner } from "../components/ui/Banner.js";
import { Button } from "../components/ui/Button.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ListGroup } from "../components/ui/ListGroup.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";
import { SectionHeader } from "../components/ui/SectionHeader.js";
import { Skeleton } from "../components/ui/Skeleton.js";
import { StatusDot } from "../components/ui/StatusDot.js";
import { SessionStatusPill } from "../components/ui/StatusMark.js";
import type { HostStatusView } from "../hooks/useHostStatus.js";
import type { HostCredential } from "../lib/credential-port.js";
import type { OperationFailure } from "../lib/errors.js";
import { createHostClient, type HostClient } from "../lib/host-client.js";
import { hostStatusFromFailure } from "../lib/host-status.js";
import {
  createSession,
  listModels,
  listProjects,
  listSessions,
  newSessionMode,
} from "../lib/mutations.js";
import { gatewayOrigin } from "../lib/runtime.js";
import {
  projectSessions,
  summarizeProjects,
  UNGROUPED_KEY,
  type ProjectSummary,
} from "../lib/session-groups.js";
import {
  createSessionViews,
  needsUser,
  sessionStateOf,
  type SessionStateView,
} from "../lib/session-state.js";
import { AddProjectPanel } from "./AddProjectPanel.js";

export interface ProjectSessionsScreenProps {
  hostId: string;
  hostLabel: string;
  /** `UNGROUPED_KEY` lists the sessions that belong to no project. */
  projectId: string;
  projectLabel: string;
  credential: HostCredential;
  /** Roles the Gateway granted this device; absent means "not recorded yet". */
  roles?: readonly string[];
  onOpenSession: (session: RacpSession) => void;
  /**
   * Switch the rail to another project. The parent rewrites the current screen
   * entry instead of pushing a new one, so Back still returns to the project
   * list and the project the user comes back to is the one they left.
   */
  onSwitchProject: (project: { id: string; label: string }) => void;
  onBack: () => void;
}

const sessionViews = createSessionViews(window.localStorage);

type Section = { key: "needsYou" | "running" | "recent"; title: string; rows: RacpSession[] };

export function ProjectSessionsScreen({
  hostId,
  hostLabel,
  projectId,
  projectLabel,
  credential,
  roles,
  onOpenSession,
  onSwitchProject,
  onBack,
}: ProjectSessionsScreenProps) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<RacpSession[] | null>(null);
  const [status, setStatus] = useState<HostStatusView>({ kind: "checking" });
  const [failure, setFailure] = useState<OperationFailure | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [projects, setProjects] = useState<RacpProjectSummary[] | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [createFailure, setCreateFailure] = useState<OperationFailure | null>(null);
  const [models, setModels] = useState<RacpModelSummary[]>([]);
  const [modelsFailure, setModelsFailure] = useState<string | null>(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const clientRef = useRef<HostClient | null>(null);
  const credentialKey = credential.kind === "cookie" ? credential.csrfToken : credential.token;

  /**
   * The screen names the project it shows, so there is no local copy of the
   * choice to drift from it: the rail navigates, and the highlight follows.
   */
  const currentProjectId = projectId;
  const currentProjectLabel = projectLabel;

  const mode = newSessionMode(roles, projects);
  /**
   * "Other" lists the sessions that belong to no project, and starting one there
   * is what the group is for — the Host creates it with no `projectId` — so this
   * group is never the reason the action goes away.
   */
  const canCreate = mode !== "hidden";

  useEffect(() => {
    const client = createHostClient({
      gatewayOrigin,
      hostId,
      credential,
      onEvent: () => undefined,
      log: (_level, message, data) => console.warn(`[remote-web] ${message}`, data ?? {}),
    });
    clientRef.current = client;
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [hostId, credentialKey]);

  const load = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    setIsRefreshing(true);
    const result = await listSessions(client);
    setIsRefreshing(false);
    if (result.ok) {
      setSessions(result.value);
      setFailure(null);
      setStatus({ kind: "online" });
    } else {
      setFailure(result.failure);
      setStatus(hostStatusFromFailure(result.failure));
    }
  }, []);

  const loadProjects = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    const result = await listProjects(client);
    setProjects(result.ok ? result.value : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [load]);

  const isOnline = status.kind === "online";
  const stateOf = (session: RacpSession): SessionStateView =>
    sessionStateOf(session, sessionViews.get(hostId, session.id));

  const projectSummaries: ProjectSummary[] =
    sessions === null || projects === null
      ? []
      : summarizeProjects(sessions, projects, stateOf);

  const rows = sessions ?? [];
  const mine =
    currentProjectId === UNGROUPED_KEY
      ? rows.filter((session) => {
          const known = projects?.some(
            (project) => project.id === session.projectId && !project.archived,
          );
          return !known;
        })
      : projectSessions(
          rows.filter((session) => session.projectId === currentProjectId),
          currentProjectId,
        );
  const waitingCount = mine.filter((session) => needsUser(stateOf(session))).length;

  const sections: Section[] = [
    {
      key: "needsYou" as const,
      title: t("sessions.sections.needsYou"),
      rows: mine.filter((session) => needsUser(stateOf(session))),
    },
    {
      key: "running" as const,
      title: t("sessions.sections.running"),
      rows: mine.filter((session) => stateOf(session) === "running"),
    },
    {
      key: "recent" as const,
      title: t("sessions.sections.recent"),
      rows: mine.filter(
        (session) => !needsUser(stateOf(session)) && stateOf(session) !== "running",
      ),
    },
  ].filter((section) => section.rows.length > 0);

  const startNewSession = useCallback(
    async (choice: NewSessionChoice) => {
      const client = clientRef.current;
      if (!client) return;
      // No project is a legitimate choice here, so the in-flight marker only has to
      // be non-null.
      setCreating(choice.projectId ?? "");
      setCreateFailure(null);
      const result = await createSession(client, choice);
      setCreating(null);
      if (!result.ok) {
        setCreateFailure(result.failure);
        return;
      }
      setChoosing(false);
      onOpenSession(result.value);
    },
    [onOpenSession],
  );

  const openNewSessionSheet = useCallback(async () => {
    setChoosing(true);
    setCreateFailure(null);
    const client = clientRef.current;
    if (!client || modelsLoaded) return;
    const result = await listModels(client);
    setModelsLoaded(true);
    setModels(result.ok ? result.value : []);
    setModelsFailure(
      result.ok || result.failure.code === "CAPABILITY_UNAVAILABLE"
        ? null
        : result.failure.message,
    );
  }, [modelsLoaded]);

  const newSessionEntry = () => {
    if (mode === "hidden") {
      return (
        <span className="text-[13px] text-[var(--rm-text-muted)]">
          {t("sessions.createReadOnly")}
        </span>
      );
    }
    if (mode === "unavailable" && currentProjectId !== UNGROUPED_KEY) {
      return (
        <span className="text-[13px] text-[var(--rm-text-muted)]">
          {t("sessions.noProjects")}
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={() => void openNewSessionSheet()}
        disabled={creating !== null}
        aria-label={t("sessions.create")}
        className="flex h-9 w-9 items-center justify-center rounded-[10px] text-[var(--rm-text-secondary)] active:opacity-60 disabled:opacity-40"
      >
        <Plus className="h-5 w-5" aria-hidden="true" />
      </button>
    );
  };

  const title =
    currentProjectId === UNGROUPED_KEY ? t("sessions.otherGroup") : currentProjectLabel;
  const subtitle = (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--rm-text-secondary)]">
      <StatusDot status={isOnline ? "online" : "offline"} size="small" />
      <span className="truncate">{hostLabel}</span>
    </span>
  );

  return (
    <Screen>
      <NavBar
        solid
        title={title}
        subtitle={subtitle}
        onBack={onBack}
        trailing={
          <div className="flex items-center">
            {!failure ? newSessionEntry() : null}
            <button
              type="button"
              onClick={() => {
                void load();
                void loadProjects();
              }}
              disabled={isRefreshing}
              aria-label={t("common.refresh")}
              className="flex h-9 w-9 items-center justify-center rounded-[10px] text-[var(--rm-text-secondary)] active:opacity-60"
            >
              <RefreshCw
                className={`h-5 w-5 ${isRefreshing ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
            </button>
          </div>
        }
      />

      <ScreenContent hasDock={mine.length === 0 && sessions !== null && canCreate}>
        {failure ? (
          <div className="mb-4">
            <Banner
              tone="error"
              action={
                <Button variant="plain" size="small" onClick={() => void load()}>
                  {t("common.refresh")}
                </Button>
              }
            >
              {failure.message || t("operation.sessionList")}
            </Banner>
          </div>
        ) : null}

        {createFailure ? (
          <div className="mb-4">
            <Banner tone="error">{createFailure.message || t("operation.sessionCreate")}</Banner>
          </div>
        ) : null}

        {/* Horizontal project switcher rail (prototype 6b) */}
        {projectSummaries.length > 0 ? (
          <section aria-label={t("projects.title")} className="mb-2">
            <SectionHeader
              title={t("projects.title")}
              action={
                <span className="text-[var(--rm-text-muted)]">
                  {projectSummaries.length}
                </span>
              }
            />
            <div className="-mx-4 flex gap-2.5 overflow-x-auto px-4 pt-1 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {projectSummaries.map((summary) => {
                const summaryId = summary.projectId ?? summary.key;
                const summaryLabel = summary.label ?? t("sessions.otherGroup");
                const isSelected = summaryId === currentProjectId;
                return (
                  <button
                    key={summary.key}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => {
                      if (isSelected) return;
                      onSwitchProject({ id: summaryId, label: summary.label ?? "" });
                    }}
                    className={`flex w-[156px] shrink-0 flex-col items-start rounded-[18px] p-3 text-left transition-transform duration-150 ease-[var(--rm-ease-out)] active:scale-[0.97] ${
                      isSelected
                        ? "bg-[image:var(--rm-aurora)] text-white shadow-[0_8px_20px_-6px_rgba(124,92,255,0.45)]"
                        : "border border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] text-[var(--rm-text-primary)] backdrop-blur-md"
                    }`}
                  >
                    <div className="mb-2 flex w-full items-center justify-between gap-1.5">
                      <span
                        aria-hidden="true"
                        className={`grid h-7 w-7 shrink-0 place-items-center rounded-[9px] ${
                          isSelected
                            ? "bg-white/25 text-white"
                            : "bg-[var(--rm-bg-surface-2)] text-[var(--rm-accent-2)]"
                        }`}
                      >
                        <Folder className="h-3.5 w-3.5 stroke-[2.2]" />
                      </span>
                      {!isSelected && summary.waiting > 0 ? (
                        <SessionStatusPill view="approval" count={summary.waiting} />
                      ) : !isSelected && summary.running > 0 ? (
                        <SessionStatusPill view="running" count={summary.running} />
                      ) : null}
                    </div>
                    <b
                      className={`block w-full truncate text-[14px] font-semibold leading-[18px] ${
                        isSelected ? "text-white" : "text-[var(--rm-text-primary)]"
                      }`}
                    >
                      {summaryLabel}
                    </b>
                    <small
                      className={`mt-0.5 block truncate text-[11px] leading-[15px] ${
                        isSelected ? "text-white/80" : "text-[var(--rm-text-muted)]"
                      }`}
                    >
                      {summary.total === 0
                        ? t("projects.noSessions")
                        : t("projects.sessionCount", { count: summary.total })}
                    </small>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        {choosing && canCreate ? (
          addingProject ? (
            <div className="mb-4">
              <AddProjectPanel
                client={() => clientRef.current}
                onRegistered={() => {
                  setAddingProject(false);
                  void loadProjects();
                }}
                onCancel={() => setAddingProject(false)}
              />
            </div>
          ) : (
            <NewSessionSheet
              open
              projects={projects ?? []}
              models={models}
              modelsFailure={modelsFailure}
              initialProjectId={currentProjectId === UNGROUPED_KEY ? null : currentProjectId}
              projectLocked
              allowNoProject={currentProjectId === UNGROUPED_KEY}
              creating={creating !== null}
              failure={createFailure ? createFailure.message || t("operation.sessionCreate") : null}
              onCancel={() => setChoosing(false)}
              onAddProject={() => setAddingProject(true)}
              onCreate={(choice) => void startNewSession(choice)}
            />
          )
        ) : null}

        {sessions === null ? (
          <div className="space-y-4">
            <SectionHeader title=" " />
            <ListGroup>
              {[1, 2, 3, 4, 5, 6].map((index) => (
                <div key={index} className="flex min-h-[64px] items-center gap-3 px-4 py-3">
                  <Skeleton className="h-2 w-2 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/5" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </ListGroup>
          </div>
        ) : mine.length === 0 ? (
          <div className="pt-10">
            <EmptyState
              title={t("projects.projectEmptyTitle", { project: title })}
              description={t("projects.projectEmptyDesc")}
            />
          </div>
        ) : (
          <div className="space-y-1">
            {sections.map((section) => (
              <section key={section.key} aria-label={section.title}>
                <SectionHeader
                  title={section.title}
                  action={
                    <span className="text-[var(--rm-text-muted)]">{section.rows.length}</span>
                  }
                />
                <ListGroup>
                  {section.rows.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      view={stateOf(session)}
                      {...(section.key === "needsYou" && waitingCount > 1
                        ? { waitingCount }
                        : {})}
                      onOpen={() => onOpenSession(session)}
                    />
                  ))}
                </ListGroup>
              </section>
            ))}
          </div>
        )}
      </ScreenContent>

      {sessions !== null && mine.length === 0 && canCreate ? (
        <div className="rm-dock shrink-0 border-t border-[var(--rm-separator)] bg-[var(--rm-bg-page)] px-4 pt-2">
          <Button variant="primary" size="large" onClick={() => void openNewSessionSheet()}>
            {t("sessions.create")}
          </Button>
        </div>
      ) : null}
    </Screen>
  );
}
