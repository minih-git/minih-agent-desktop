/**
 * "Add a project": walk the Host's folders, register one, start a session in it
 * (rollout A2).
 *
 * This is the phone's answer to a missing project. It talks to the same two
 * operations the desktop uses (`project/browse`, `project/register`) and ends by
 * handing the new project to the caller, which starts a session in it — so a
 * folder that is not a project yet takes one flow, not a detour through
 * settings.
 *
 * Two rules come from the Host and are not re-implemented here:
 *   - the walk starts at and never leaves the Host's browse root (the user's
 *     home directory), so `parent` is absent at the top;
 *   - `project/register` canonicalizes the path again and refuses anything
 *     outside that root.
 *
 * What this module does own is presentation: a path under the root is shown as
 * `~/…`, because the absolute form would print the account name on a phone.
 */
import type { RacpProjectSummary } from "@minih-agent/shared";
import { Folder } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { FailureBanner } from "../components/Chrome.js";
import { Button } from "../components/ui/Button.js";
import type { OperationFailure } from "../lib/errors.js";
import type { HostClient } from "../lib/host-client.js";
import { browseProjects, registerProject, type ProjectBrowseResult } from "../lib/mutations.js";
import { displayPath } from "../lib/path-display.js";

export function AddProjectPanel({
  client,
  onRegistered,
  onCancel,
}: {
  client: () => HostClient | null;
  /** The caller starts a session in the folder that was just registered. */
  onRegistered: (project: RacpProjectSummary) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [listing, setListing] = useState<ProjectBrowseResult | null>(null);
  const [failure, setFailure] = useState<OperationFailure | null>(null);
  const [registering, setRegistering] = useState(false);
  /**
   * The root the first answer named. Every later path is shown relative to it,
   * so the phone never prints the account's home directory verbatim.
   */
  const [root, setRoot] = useState<string | null>(null);

  const open = useCallback(
    async (path?: string): Promise<void> => {
      const host = client();
      if (!host) return;
      setFailure(null);
      const result = await browseProjects(host, path);
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      setListing(result.value);
      // The first answer with no path is the browse root itself.
      setRoot((current) => current ?? (path ? null : result.value.path));
    },
    [client],
  );

  useEffect(() => {
    void open();
  }, [open]);

  const register = useCallback(
    async (path: string): Promise<void> => {
      const host = client();
      if (!host) return;
      setRegistering(true);
      setFailure(null);
      const result = await registerProject(host, path);
      setRegistering(false);
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      onRegistered(result.value);
    },
    [client, onRegistered],
  );

  // The absolute path the request needs, rebuilt from what the Host answered
  // rather than from the shortened text on screen.
  const here = listing?.path;
  const parent = listing?.parent;

  return (
    <div className="flex flex-col gap-2.5 rounded-[20px] border border-[var(--rm-hair)] bg-[var(--rm-bg-surface)] p-4 backdrop-blur-md">
      <p className="text-[15px] font-semibold text-[var(--rm-text-primary)]">
        {t("sessions.addProject")}
      </p>
      {failure ? (
        <FailureBanner
          failure={failure}
          operationKey="operation.projectBrowse"
          onDismiss={() => setFailure(null)}
        />
      ) : null}
      <p
        className="truncate font-mono text-[12px] text-[var(--rm-text-muted)]"
        title={here ? displayPath(here, root) : ""}
      >
        {here ? displayPath(here, root) : t("app.loading")}
      </p>
      {listing === null ? null : listing.entries.length === 0 ? (
        <p className="text-[13px] text-[var(--rm-text-secondary)]">{t("sessions.folderEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {listing.entries.map((entry) => (
            <li key={entry.path} className="flex items-center gap-1.5">
              <Button
                variant="secondary"
                size="small"
                className="min-w-0 flex-1 justify-start truncate"
                disabled={registering}
                onClick={() => void open(entry.path)}
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--rm-accent-2)]" aria-hidden="true" />
                <span className="truncate">{entry.name}</span>
              </Button>
              <Button
                variant="plain"
                size="small"
                className="shrink-0"
                disabled={registering}
                onClick={() => void register(entry.path)}
              >
                {t("sessions.useFolder")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2 pt-1">
        {parent ? (
          <Button variant="plain" size="small" disabled={registering} onClick={() => void open(parent)}>
            {t("sessions.parentFolder")}
          </Button>
        ) : null}
        {here && listing?.parent === undefined ? (
          <span className="text-[12px] text-[var(--rm-text-muted)]">{t("sessions.rootFolder")}</span>
        ) : here ? (
          <Button variant="secondary" size="small" disabled={registering} onClick={() => void register(here)}>
            {registering ? t("sessions.registering") : t("sessions.useThisFolder")}
          </Button>
        ) : null}
        <Button variant="plain" size="small" className="ml-auto" disabled={registering} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
