/**
 * Sessions of one host, grouped by project (PR-4, D666 follow-up).
 *
 * The list comes from `session/list` and the groups from `project/list`, ordered
 * the way the desktop sidebar orders them: by most recent activity within a
 * project, and between projects by their most recent session. Sessions with no
 * project, or whose project is no longer in the catalog, stay under "Other", so
 * nothing disappears.
 *
 * A device that holds the `controller` role may create a session here; the Host
 * creates it under one of the projects `project/list` returned, which is what
 * `session/create` takes instead of a path.
 */
import type { RacpProjectSummary, RacpSession } from "@minih-agent/shared";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AddProjectPanel } from "./AddProjectPanel.js";
import { useHostStatus } from "../hooks/useHostStatus.js";
import type { HostCredential } from "../lib/credential-port.js";
import type { OperationFailure } from "../lib/errors.js";
import { createHostClient, type HostClient } from "../lib/host-client.js";
import { createSession, listProjects, listSessions, newSessionMode } from "../lib/mutations.js";
import { gatewayOrigin } from "../lib/runtime.js";
import { groupSessionsByProject, soleProjectForNewSession, type SessionGroup } from "../lib/session-groups.js";
import { Banner } from "../components/ui/Banner.js";
import { Button } from "../components/ui/Button.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { ListGroup } from "../components/ui/ListGroup.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";
import { SectionHeader } from "../components/ui/SectionHeader.js";
import { Skeleton } from "../components/ui/Skeleton.js";
import { StatusDot } from "../components/ui/StatusDot.js";
import { SessionRow } from "../components/sessions/SessionRow.js";

export interface SessionsScreenProps {
  hostId: string;
  hostLabel: string;
  credential: HostCredential;
  /** Roles the Gateway granted this device; absent means "not recorded yet". */
  roles?: readonly string[];
  onOpenSession: (session: RacpSession) => void;
  onBack: () => void;
}

export function SessionsScreen({
  hostId,
  hostLabel,
  credential,
  roles,
  onOpenSession,
  onBack,
}: SessionsScreenProps) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<RacpSession[] | null>(null);
  const [failure, setFailure] = useState<OperationFailure | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [projects, setProjects] = useState<RacpProjectSummary[] | null>(null);
  const [projectsFailure, setProjectsFailure] = useState<OperationFailure | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [choosing, setChoosing] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [createFailure, setCreateFailure] = useState<OperationFailure | null>(null);
  const clientRef = useRef<HostClient | null>(null);
  const credentialKey = credential.kind === "cookie" ? credential.csrfToken : credential.token;
  const { status } = useHostStatus(hostId, credential);
  /**
   * `roles` is what the Gateway granted this device when it was paired or
   * adopted. An entry written before that field existed has none, so the answer
   * is "unknown": the entry point is offered and a `FORBIDDEN` answer is shown
   * as itself. Only a recorded absence hides it.
   */
  const mode = newSessionMode(roles, projects);
  /** A recorded absence of `controller` is the only thing that hides the entry. */
  const canCreate = mode !== "hidden";

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
    } else {
      setFailure(result.failure);
    }
  }, []);

  /**
   * The project catalog only supplies headings. When it cannot be read the list
   * stays usable: every session falls into "Other" and the screen says why.
   */
  const loadProjects = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client || mode === "hidden") return;
    const result = await listProjects(client);
    if (result.ok) {
      setProjects(result.value);
      setProjectsFailure(null);
    } else {
      setProjects([]);
      setProjectsFailure(result.failure);
    }
  }, [mode]);

  useEffect(() => {
    void load();
  }, [load]);

  // The project catalog supplies the headings and the new-session choices, so it
  // loads with the list rather than on first use.
  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // Foreground refresh: coming back to the app re-reads the list, which is the
  // only way a phone learns about a session the computer started meanwhile.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void load();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [load]);

  const isOnline = status.kind === "online";
  const subStatus = (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--rm-text-secondary)]">
      <StatusDot status={isOnline ? "online" : "offline"} size="small" />
      <span>{isOnline ? t("hosts.status.online") : t("hosts.status.offline")}</span>
    </span>
  );

  const groups: SessionGroup[] = sessions === null ? [] : groupSessionsByProject(sessions, projects ?? []);

  const startNewSession = useCallback(
    async (projectId: string) => {
      const client = clientRef.current;
      if (!client) return;
      setCreating(projectId);
      setCreateFailure(null);
      const result = await createSession(client, { projectId });
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

  const newSessionButton = () => {
    if (mode === "hidden") {
      // A read-only device gets the reason instead of a disabled button.
      return <span className="text-[13px] text-[var(--rm-text-muted)]">{t("sessions.createReadOnly")}</span>;
    }
    if (mode === "unavailable") {
      return <span className="text-[13px] text-[var(--rm-text-muted)]">{t("sessions.noProjects")}</span>;
    }
    return (
      <Button
        variant="plain"
        size="small"
        disabled={creating !== null || (mode !== "unknown" && projects === null)}
        onClick={() => {
          const sole = soleProjectForNewSession(projects ?? []);
          if (sole) {
            void startNewSession(sole.id);
            return;
          }
          setChoosing((current) => !current);
        }}
      >
        {creating ? t("sessions.creating") : t("sessions.create")}
      </Button>
    );
  };

  return (
    <Screen>
      <NavBar
        title={hostLabel}
        subtitle={subStatus}
        onBack={onBack}
        trailing={
          <button
            type="button"
            onClick={() => {
              void load();
              void loadProjects();
            }}
            disabled={isRefreshing}
            aria-label={t("common.refresh")}
            className="flex h-9 w-9 items-center justify-center rounded-[8px] text-[var(--rm-text-secondary)] active:opacity-60"
          >
            <RefreshCw className={`h-5 w-5 ${isRefreshing ? "animate-spin" : ""}`} aria-hidden="true" />
          </button>
        }
      />

      <ScreenContent>
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

        {projectsFailure ? (
          <div className="mb-4">
            <Banner tone="neutral">{t("sessions.projectsFailed")}</Banner>
          </div>
        ) : null}

        {createFailure ? (
          <div className="mb-4">
            <Banner tone="error">{createFailure.message || t("operation.sessionCreate")}</Banner>
          </div>
        ) : null}

        <SectionHeader title={t("sessions.title")} action={newSessionButton()} />

        {choosing && canCreate ? (
          <div className="mb-4">
            {addingProject ? (
              <AddProjectPanel
                client={() => clientRef.current}
                onRegistered={(project) => {
                  // The folder is a project now: open a session in it directly, so
                  // the user does not have to find it again in the list.
                  setAddingProject(false);
                  void loadProjects();
                  void startNewSession(project.id);
                }}
                onCancel={() => setAddingProject(false)}
              />
            ) : (
              <>
                <SectionHeader title={t("sessions.chooseProject")} />
                <ListGroup>
                  {(projects ?? [])
                    .filter((project) => !project.archived)
                    .map((project) => (
                      <button
                        key={project.id}
                        type="button"
                        disabled={creating !== null}
                        onClick={() => void startNewSession(project.id)}
                        className="flex min-h-[56px] w-full items-center gap-3 px-4 py-3 text-left text-[15px] text-[var(--rm-text-primary)] transition-colors active:bg-[var(--rm-bg-inset)]"
                      >
                        {project.label}
                      </button>
                    ))}
                </ListGroup>
                <div className="mt-2 flex flex-col gap-2">
                  <Button variant="secondary" size="medium" disabled={creating !== null} onClick={() => setAddingProject(true)}>
                    {t("sessions.addProject")}
                  </Button>
                  <Button variant="plain" size="medium" onClick={() => setChoosing(false)}>
                    {t("common.cancel")}
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : null}

        {sessions === null ? (
          <div className="space-y-4">
            <SectionHeader title=" " />
            <ListGroup>
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="flex min-h-[56px] items-center gap-3 px-4 py-3">
                  <Skeleton className="h-2 w-2 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/5" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </ListGroup>
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState title={t("session.emptyTitle")} description={t("session.emptyDesc")} />
        ) : (
          <div className="space-y-5">
            {groups.map((group) => {
              const isCollapsed = collapsed[group.key] === true;
              const heading = group.label ?? t("sessions.otherGroup");
              return (
                <section key={group.key} aria-label={heading}>
                  <SectionHeader
                    title={
                      <button
                        type="button"
                        aria-expanded={!isCollapsed}
                        onClick={() => setCollapsed((current) => ({ ...current, [group.key]: !isCollapsed }))}
                        className="flex items-center gap-2 text-left"
                      >
                        <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
                        <span>{heading}</span>
                        <span className="text-[var(--rm-text-faint)]">{group.sessions.length}</span>
                      </button>
                    }
                  />
                  {isCollapsed ? null : (
                    <ListGroup>
                      {group.sessions.map((session) => (
                        <SessionRow key={session.id} session={session} onOpen={() => onOpenSession(session)} />
                      ))}
                    </ListGroup>
                  )}
                </section>
              );
            })}

            <p className="pt-2 text-center text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
              {t("session.computerNotice")}
            </p>
          </div>
        )}
      </ScreenContent>
    </Screen>
  );
}
