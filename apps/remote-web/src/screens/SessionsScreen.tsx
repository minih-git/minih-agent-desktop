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
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AppShell, Button, Card, FailureBanner, Pill } from "../components/Chrome.js";
import { useHostStatus } from "../hooks/useHostStatus.js";
import type { HostCredential } from "../lib/credential-port.js";
import type { OperationFailure } from "../lib/errors.js";
import { createHostClient, type HostClient } from "../lib/host-client.js";
import { createSession, listProjects, listSessions, newSessionMode } from "../lib/mutations.js";
import { gatewayOrigin } from "../lib/runtime.js";
import { groupSessionsByProject, soleProjectForNewSession, type SessionGroup } from "../lib/session-groups.js";

function statusTone(status: RacpSession["status"]): "ok" | "warn" | "bad" | "neutral" {
  if (status === "running") return "ok";
  if (status === "waiting_permission") return "warn";
  if (status === "error") return "bad";
  return "neutral";
}

export function SessionsScreen({
  hostId,
  hostLabel,
  credential,
  roles,
  onOpenSession,
  onBack,
}: {
  hostId: string;
  hostLabel: string;
  credential: HostCredential;
  /** Roles the Gateway granted this device; absent means "not recorded yet". */
  roles?: readonly string[];
  onOpenSession: (session: RacpSession) => void;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [sessions, setSessions] = useState<RacpSession[] | null>(null);
  const [failure, setFailure] = useState<OperationFailure | null>(null);
  const [projects, setProjects] = useState<RacpProjectSummary[] | null>(null);
  const [projectsFailure, setProjectsFailure] = useState<OperationFailure | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [choosing, setChoosing] = useState(false);
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
    const result = await listSessions(client);
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

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

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
      // A read-only device has no entry at all; the hint explains why instead
      // of leaving a disabled button with no reason.
      return (
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {t("sessions.createReadOnly")}
        </span>
      );
    }
    if (mode === "unavailable") {
      return (
        <span className="text-xs text-slate-500 dark:text-slate-400">{t("sessions.noProjects")}</span>
      );
    }
    return (
      <Button
        variant="secondary"
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
    <AppShell
      title={hostLabel}
      onBack={onBack}
      actions={
        <>
          <Pill tone={status.kind === "online" ? "ok" : status.kind === "revoked" ? "bad" : "warn"}>
            {t(`hosts.status.${status.kind}`)}
          </Pill>
          <Button
            variant="ghost"
            aria-label={t("common.refresh")}
            title={t("common.refresh")}
            onClick={() => {
              void load();
              void loadProjects();
            }}
          >
            {t("common.refresh")}
          </Button>
        </>
      }
    >
      {failure ? (
        <FailureBanner failure={failure} operationKey="operation.sessionList" onDismiss={() => setFailure(null)} />
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t("sessions.title")}</h2>
        {newSessionButton()}
      </div>

      {choosing && canCreate ? (
        <Card>
          <p className="mb-2 text-sm font-medium">{t("sessions.chooseProject")}</p>
          {(projects ?? []).filter((project) => !project.archived).length === 0 ? (
            <p className="text-sm text-slate-600 dark:text-slate-300">{t("sessions.noProjects")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {(projects ?? [])
                .filter((project) => !project.archived)
                .map((project) => (
                  <li key={project.id}>
                    <Button
                      variant="secondary"
                      className="w-full justify-start"
                      disabled={creating !== null}
                      onClick={() => void startNewSession(project.id)}
                    >
                      {project.label}
                    </Button>
                  </li>
                ))}
            </ul>
          )}
          <Button variant="ghost" className="mt-2" onClick={() => setChoosing(false)}>
            {t("common.cancel")}
          </Button>
        </Card>
      ) : null}

      {createFailure ? (
        <FailureBanner
          failure={createFailure}
          operationKey="operation.sessionCreate"
          onDismiss={() => setCreateFailure(null)}
        />
      ) : null}

      {projectsFailure ? (
        <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-100">
          {t("sessions.projectsFailed")}
        </p>
      ) : null}

      {sessions === null ? (
        <p className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">{t("app.loading")}</p>
      ) : sessions.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-600 dark:text-slate-300">{t("sessions.empty")}</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((group) => {
            const isCollapsed = collapsed[group.key] === true;
            const heading = group.label ?? t("sessions.otherGroup");
            return (
              <section key={group.key} aria-label={heading} className="flex flex-col gap-2">
                <button
                  type="button"
                  className="app-tap flex items-center justify-between gap-2 rounded-lg px-1 py-1 text-left"
                  aria-expanded={!isCollapsed}
                  onClick={() =>
                    setCollapsed((current) => ({ ...current, [group.key]: !isCollapsed }))
                  }
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
                    <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      {heading}
                    </span>
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">{group.sessions.length}</span>
                </button>
                {isCollapsed ? null : (
                  <ul className="flex flex-col gap-2">
                    {group.sessions.map((session) => (
                      <li key={session.id}>
                        <button
                          type="button"
                          className="app-tap w-full rounded-xl border border-slate-200 bg-white p-3 text-left hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-800"
                          aria-label={`${session.title || session.id}`}
                          onClick={() => onOpenSession(session)}
                        >
                          <span className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">
                              {session.title || session.id}
                            </span>
                            <Pill tone={statusTone(session.status)}>
                              {t(`sessions.status.${session.status}`)}
                            </Pill>
                          </span>
                          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
                            {t("sessions.updated", {
                              date: new Date(session.updatedAt).toLocaleString(i18n.language),
                            })}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
