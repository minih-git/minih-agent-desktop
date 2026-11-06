/**
 * S5: the projects of one computer (spec §17.2).
 *
 * The phone used to open a computer straight into every session it had, grouped
 * under collapsible project headings, so choosing a session meant reading four
 * headings and eight rows. This page answers one question instead — "which
 * project needs me" — and the sessions of a project live one tap further.
 *
 * Everything on a card is aggregated here from the two lists the screen already
 * reads: `session/list` gives each session its `projectId`, `status`, and
 * `updatedAt`, and `project/list` gives the names. No protocol field was added
 * for it (§17.2).
 *
 * Both lists are also read from the last successful answer cached for this
 * phone (`../lib/host-cache.ts`) so the cards are on screen before the network
 * answers; the live read still runs on mount and replaces them, and a muted line
 * says which of the two is showing.
 */
import type { RacpProjectSummary, RacpSession } from "@minih-agent/shared";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ProjectCard } from "../components/sessions/ProjectCard.js";
import type { HostStatusView } from "../hooks/useHostStatus.js";
import { cacheHint, resolveCachedValue } from "../lib/cached-view.js";
import type { HostCredential } from "../lib/credential-port.js";
import type { OperationFailure } from "../lib/errors.js";
import { cacheScope } from "../lib/host-cache.js";
import { createHostClient, type HostClient } from "../lib/host-client.js";
import { hostStatusFromFailure } from "../lib/host-status.js";
import { listProjects, listSessions } from "../lib/mutations.js";
import { gatewayOrigin, hostCache } from "../lib/runtime.js";
import { summarizeProjects, type ProjectSummary } from "../lib/session-groups.js";
import { createSessionViews, sessionStateOf } from "../lib/session-state.js";
import { Banner } from "../components/ui/Banner.js";
import { Button } from "../components/ui/Button.js";
import { CacheHint } from "../components/ui/CacheHint.js";
import { EmptyState } from "../components/ui/EmptyState.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent } from "../components/ui/Screen.js";
import { SectionHeader } from "../components/ui/SectionHeader.js";
import { Skeleton } from "../components/ui/Skeleton.js";
import { StatusDot } from "../components/ui/StatusDot.js";

export interface ProjectsScreenProps {
  hostId: string;
  hostLabel: string;
  credential: HostCredential;
  /**
   * The device this phone is to that computer (`HostRegistryEntry.deviceId`).
   * The cache is keyed on it, so two phones — or two accounts on one phone —
   * never read each other's last answer. Absent means "not recorded", and the
   * screen then simply has no cache to paint from.
   */
  deviceId?: string;
  roles?: readonly string[];
  onOpenProject: (project: { id: string; label: string }) => void;
  /**
   * Called once when this computer has exactly one usable project: the list is
   * skipped and its sessions open directly (§17.3). The screen does not render
   * cards before it fires, so the user never sees a one-row list flash by.
   */
  onSoleProject: (project: { id: string; label: string }) => void;
  onBack: () => void;
}

/** The device-local view of a session, which two of the six states depend on. */
const sessionViews = createSessionViews(window.localStorage);

export function ProjectsScreen({
  hostId,
  hostLabel,
  credential,
  deviceId,
  roles,
  onOpenProject,
  onSoleProject,
  onBack,
}: ProjectsScreenProps) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<RacpSession[] | null>(null);
  const [projects, setProjects] = useState<RacpProjectSummary[] | null>(null);
  const [status, setStatus] = useState<HostStatusView>({ kind: "checking" });
  const [failure, setFailure] = useState<OperationFailure | null>(null);
  const [projectsFailure, setProjectsFailure] = useState<OperationFailure | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const clientRef = useRef<HostClient | null>(null);
  const credentialKey = credential.kind === "cookie" ? credential.csrfToken : credential.token;
  /** The sole-project skip fires once; a later refresh must not repeat it. */
  const skipped = useRef(false);
  /**
   * The last answer this phone read from this computer, read synchronously on
   * the first render so the cards are painted before the first round trip
   * returns. It is a starting point only: `load` below overwrites it.
   */
  const scope = useMemo(() => cacheScope(deviceId, hostId), [deviceId, hostId]);
  const cached = useMemo(() => hostCache.readCatalog(scope), [scope]);
  const shownSessions = resolveCachedValue(
    sessions,
    cached?.sessions
      ? { value: cached.sessions, fetchedAt: cached.sessionsFetchedAt ?? cached.lastUsedAt }
      : null,
  );
  const shownProjects = resolveCachedValue(
    projects,
    cached?.projects
      ? { value: cached.projects, fetchedAt: cached.projectsFetchedAt ?? cached.lastUsedAt }
      : null,
  );
  const sessionHint = cacheHint({ fromCache: shownSessions.fromCache, failed: failure !== null });
  const projectsHint = cacheHint({
    fromCache: shownProjects.fromCache,
    failed: projectsFailure !== null,
  });

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

  /**
   * One read answers both questions: `session/list` is this screen's
   * reachability probe (503 means the Host link is down, 401 means the device is
   * not adopted), and its sessions are what the cards count.
   */
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
      // The next visit paints from this answer. A failed read keeps what was
      // cached before instead of replacing a usable list with nothing.
      hostCache.writeSessions(scope, result.value);
    } else {
      setFailure(result.failure);
      setStatus(hostStatusFromFailure(result.failure));
    }
  }, [scope]);

  const loadProjects = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    const result = await listProjects(client);
    if (result.ok) {
      setProjects(result.value);
      setProjectsFailure(null);
      hostCache.writeProjects(scope, result.value);
    } else {
      // The rows stay null instead of becoming an empty list: a failed catalog
      // read must not overwrite cached names with nothing. `projectCatalog` below
      // is what falls back to one flat group when there is no cache either.
      setProjectsFailure(result.failure);
    }
  }, [scope]);

  useEffect(() => {
    void load();
    void loadProjects();
  }, [load, loadProjects]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void load();
        void loadProjects();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [load, loadProjects]);

  /**
   * The catalog to render: the live one, the cached one, or — when the read
   * failed and nothing was cached — an empty list, which is what keeps the
   * screen to one flat "Other" group instead of a skeleton (the rule §17.2
   * already had).
   */
  const projectCatalog = shownProjects.value ?? (projectsFailure ? [] : null);
  const summaries: ProjectSummary[] =
    shownSessions.value === null || projectCatalog === null
      ? []
      : summarizeProjects(shownSessions.value, projectCatalog, (session) =>
          sessionStateOf(session, sessionViews.get(hostId, session.id)),
        );

  // One project is one destination, not a list with one row (§17.3). Decided
  // here because this screen is where the catalog is already in hand — and on
  // the live lists only: skipping the project list is a navigation the user
  // cannot undo in one tap, so it must not be decided from a cache that may be
  // older than the project they just added on the computer.
  useEffect(() => {
    if (skipped.current || !projects || sessions === null) return;
    const usable = projects.filter((project) => !project.archived);
    if (usable.length !== 1) return;
    skipped.current = true;
    onSoleProject({ id: usable[0]!.id, label: usable[0]!.label });
  }, [onSoleProject, projects, sessions]);

  const isOnline = status.kind === "online";
  const checking = status.kind === "checking";
  const subStatus = (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--rm-text-secondary)]">
      <StatusDot status={isOnline ? "online" : checking ? "muted" : "offline"} size="small" />
      <span>
        {isOnline
          ? t("hosts.status.online")
          : checking
            ? t("hosts.status.checking")
            : t("hosts.status.offline")}
      </span>
    </span>
  );

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

      {/*
        The cached lists are on screen, and this is the line that says so: muted,
        under the header, with the moment the Host sent them. It disappears the
        instant the live read lands.
      */}
      {sessionHint && shownSessions.fetchedAt ? (
        <CacheHint kind={sessionHint} fetchedAt={shownSessions.fetchedAt} />
      ) : null}
      {projectsHint && shownProjects.fetchedAt ? (
        <CacheHint kind={projectsHint} fetchedAt={shownProjects.fetchedAt} />
      ) : null}

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
            <Banner tone="neutral">{t("projects.catalogFailed")}</Banner>
          </div>
        ) : null}

        <SectionHeader
          title={t("projects.title")}
          action={
            summaries.length > 0 ? (
              <span className="text-[var(--rm-text-muted)]">{t("projects.count", { count: summaries.length })}</span>
            ) : undefined
          }
        />

        {shownSessions.value === null || shownProjects.value === null ? (
          <div className="space-y-2.5">
            {[1, 2, 3].map((index) => (
              <div key={index} className="rounded-2xl bg-[var(--rm-bg-surface)] px-4 py-3">
                <Skeleton className="h-4 w-2/5" />
                <Skeleton className="mt-2.5 h-3 w-3/5" />
              </div>
            ))}
          </div>
        ) : summaries.length === 0 ? (
          <EmptyState title={t("projects.emptyTitle")} description={t("projects.emptyDesc")} />
        ) : (
          <div className="space-y-2.5">
            {summaries.map((summary) => (
              <ProjectCard
                key={summary.key}
                summary={summary}
                onOpen={() =>
                  onOpenProject({
                    id: summary.projectId ?? summary.key,
                    label: summary.label ?? "",
                  })
                }
              />
            ))}
          </div>
        )}
      </ScreenContent>
    </Screen>
  );
}
