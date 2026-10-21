/**
 * S5b: the sessions of one project (spec §17.2).
 *
 * This page used to be the computer's whole session list, grouped under
 * collapsible project headings. §17 moved the grouping up into a page of its own,
 * so what is left here answers a narrower question — "what happened in *this*
 * project" — and can spend the space on sections that matter: what needs the
 * user, what is running, and everything else newest first.
 *
 * The model catalog and the project catalog are still read the way the old screen
 * read them (`model/list` once per sheet open; `project/list` only to offer the
 * new-session choices), and every credential rule is unchanged.
 */
import type { RacpModelSummary, RacpProjectSummary, RacpSession } from "@minih-agent/shared";
import { Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AddProjectPanel } from "./AddProjectPanel.js";
import type { HostStatusView } from "../hooks/useHostStatus.js";
import type { HostCredential } from "../lib/credential-port.js";
import type { OperationFailure } from "../lib/errors.js";
import { createHostClient, type HostClient } from "../lib/host-client.js";
import { hostStatusFromFailure } from "../lib/host-status.js";
import { createSession, listModels, listProjects, listSessions, newSessionMode } from "../lib/mutations.js";
import { gatewayOrigin } from "../lib/runtime.js";
import { UNGROUPED_KEY, projectSessions } from "../lib/session-groups.js";
import { createSessionViews, needsUser, sessionStateOf, type SessionStateView } from "../lib/session-state.js";
import { Banner } from "../components/ui/Banner.js";
import { Button } from "../components/ui/Button.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ListGroup } from "../components/ui/ListGroup.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";
import { SectionHeader } from "../components/ui/SectionHeader.js";
import { Skeleton } from "../components/ui/Skeleton.js";
import { StatusDot } from "../components/ui/StatusDot.js";
import { NewSessionSheet, type NewSessionChoice } from "../components/sessions/NewSessionSheet.js";
import { SessionRow } from "../components/sessions/SessionRow.js";

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
  onBack,
}: ProjectSessionsScreenProps) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<RacpSession[] | null>(null);
  /**
   * The list read is also this screen's reachability probe: `session/list`
   * answers 503 while the Host link is down and 401 before this Host has adopted
   * the device, so a second request to ask the same question would cost a round
   * trip per visit and could disagree with the list on screen.
   */
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
  const mode = newSessionMode(roles, projects);
  const canCreate = mode !== "hidden" && projectId !== UNGROUPED_KEY;
  const readOnly = roles !== undefined && !roles.includes("controller");

  useEffect(() => {
    const client = createHostClient({
      gatewayOrigin,
      hostId,
      credential,
      onEvent: () => undefined,
      log: (level, message, data) => console.warn(`[remote-web] ${message}`, data ?? {}),
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

  /**
   * The project catalog is only needed for the new-session sheet, so a read-only
   * device never asks for it.
   */
  const loadProjects = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client || readOnly) return;
    const result = await listProjects(client);
    setProjects(result.ok ? result.value : []);
  }, [readOnly]);

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

  const rows = sessions ?? [];
  const mine =
    projectId === UNGROUPED_KEY
      ? rows.filter((session) => {
          const known = projects?.some((project) => project.id === session.projectId && !project.archived);
          return !known;
        })
      : projectSessions(
          rows.filter((session) => session.projectId === projectId),
          projectId,
        );
  const waitingCount = mine.filter((session) => needsUser(stateOf(session))).length;

  const sections: Section[] = [
    { key: "needsYou" as const, title: t("sessions.sections.needsYou"), rows: mine.filter((session) => needsUser(stateOf(session))) },
    { key: "running" as const, title: t("sessions.sections.running"), rows: mine.filter((session) => stateOf(session) === "running") },
    {
      key: "recent" as const,
      title: t("sessions.sections.recent"),
      rows: mine.filter((session) => !needsUser(stateOf(session)) && stateOf(session) !== "running"),
    },
  ].filter((section) => section.rows.length > 0);

  const startNewSession = useCallback(
    async (choice: NewSessionChoice) => {
      const client = clientRef.current;
      if (!client) return;
      setCreating(choice.projectId);
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
    setModelsFailure(result.ok || result.failure.code === "CAPABILITY_UNAVAILABLE" ? null : result.failure.message);
  }, [modelsLoaded]);

  const newSessionEntry = () => {
    if (projectId === UNGROUPED_KEY) return null;
    if (mode === "hidden") {
      return <span className="text-[13px] text-[var(--rm-text-muted)]">{t("sessions.createReadOnly")}</span>;
    }
    if (mode === "unavailable") {
      return <span className="text-[13px] text-[var(--rm-text-muted)]">{t("sessions.noProjects")}</span>;
    }
    return (
      <button
        type="button"
        onClick={() => void openNewSessionSheet()}
        disabled={creating !== null}
        aria-label={t("sessions.create")}
        className="flex h-9 w-9 items-center justify-center rounded-[8px] text-[var(--rm-text-secondary)] active:opacity-60 disabled:opacity-40"
      >
        <Plus className="h-5 w-5" aria-hidden="true" />
      </button>
    );
  };

  const title = projectId === UNGROUPED_KEY ? t("sessions.otherGroup") : projectLabel;
  const subtitle = (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--rm-text-secondary)]">
      <StatusDot status={isOnline ? "online" : "offline"} size="small" />
      <span className="truncate">{hostLabel}</span>
    </span>
  );

  return (
    <Screen>
      <NavBar
        title={title}
        subtitle={subtitle}
        onBack={onBack}
        trailing={
          <div className="flex items-center">
            {!failure ? newSessionEntry() : null}
            <button
              type="button"
              onClick={() => void load()}
              disabled={isRefreshing}
              aria-label={t("common.refresh")}
              className="flex h-9 w-9 items-center justify-center rounded-[8px] text-[var(--rm-text-secondary)] active:opacity-60"
            >
              <RefreshCw className={`h-5 w-5 ${isRefreshing ? "animate-spin" : ""}`} aria-hidden="true" />
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
              initialProjectId={projectId}
              projectLocked
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
                  action={<span className="text-[var(--rm-text-muted)]">{section.rows.length}</span>}
                />
                <ListGroup>
                  {section.rows.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      view={stateOf(session)}
                      {...(section.key === "needsYou" && waitingCount > 1 ? { waitingCount } : {})}
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
