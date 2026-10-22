import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@minih-agent/shared";
import type { RemoteProjectEntry, RemoteProjectGroup } from "../../lib/remote-project-catalog";
import { remoteProjectBlockedReasonKey } from "../../lib/remote-project-catalog";
import { useAppStore } from "../../stores/app-store";
import { IconFolder, IconNewProject } from "../icons";
import { Button, TooltipButton } from "../ui";

/** The same project/chat hierarchy, keyed by Host identity rather than local paths. */
export function RemoteProjectGroups({ groups, renderSessions }: {
  groups: RemoteProjectGroup[]; renderSessions: (sessions: SessionSummary[]) => ReactNode;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const open = async (project: RemoteProjectEntry) => {
    if (busy) return;
    setBusy(project.key);
    try { await useAppStore.getState().newSession({ remoteProject: project }); }
    catch (error) { useAppStore.getState().showToast(error instanceof Error ? error.message : String(error), { variant: "error" }); }
    finally { setBusy(null); }
  };
  return <>{groups.map(({ project, sessions }) => {
    // An offline or outdated computer keeps its rows but takes no new work:
    // creating a session would fail on the Host or, worse, fall back to running
    // the Agent here. The reason is stated under the name instead of hiding the
    // project, because a project that silently disappears looks like data loss.
    const blockedReasonKey = remoteProjectBlockedReasonKey(project);
    return <section className="sidebar-session-group" key={project.key}>
      <div className="sidebar-session-group-header">
        <Button variant="ghost" className="sidebar-session-group-title" disabled={busy !== null || blockedReasonKey !== null}
          title={blockedReasonKey ? t(blockedReasonKey) : `${project.hostLabel} · ${project.label}`} onClick={() => void open(project)}>
          <IconFolder size={13} aria-hidden /><span>{project.label} · {project.hostLabel}</span>
        </Button>
        <TooltipButton tooltip={blockedReasonKey ? t(blockedReasonKey) : t("nav.newTask")}
          ariaLabel={`${t("nav.newTask")}: ${project.label} · ${project.hostLabel}`}
          disabled={busy !== null || blockedReasonKey !== null} onClick={() => void open(project)}>
          <IconNewProject size={14} />
        </TooltipButton>
      </div>
      {blockedReasonKey ? <p className="sidebar-remote-group-status" role="note">{t(blockedReasonKey)}</p> : null}
      {renderSessions(sessions)}
    </section>;
  })}</>;
}
