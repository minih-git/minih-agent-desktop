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
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, FailureBanner } from "../components/Chrome.js";
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
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{t("sessions.addProject")}</p>
      {failure ? (
        <FailureBanner failure={failure} operationKey="operation.projectBrowse" onDismiss={() => setFailure(null)} />
      ) : null}
      <p className="truncate text-xs text-slate-500 dark:text-slate-400" title={here ? displayPath(here, root) : ""}>
        {here ? displayPath(here, root) : t("app.loading")}
      </p>
      {listing === null ? null : listing.entries.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">{t("sessions.folderEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {listing.entries.map((entry) => (
            <li key={entry.path} className="flex items-center gap-1">
              <Button
                variant="secondary"
                className="min-w-0 flex-1 justify-start truncate"
                disabled={registering}
                onClick={() => void open(entry.path)}
              >
                {entry.name}
              </Button>
              <Button
                variant="ghost"
                className="shrink-0 text-xs"
                disabled={registering}
                onClick={() => void register(entry.path)}
              >
                {t("sessions.useFolder")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        {parent ? (
          <Button variant="ghost" disabled={registering} onClick={() => void open(parent)}>
            {t("sessions.parentFolder")}
          </Button>
        ) : null}
        {here && listing?.parent === undefined ? (
          // At the root there is nothing left to register: the root itself is
          // what everything else lives under.
          <span className="text-xs text-slate-500 dark:text-slate-400">{t("sessions.rootFolder")}</span>
        ) : here ? (
          <Button variant="secondary" disabled={registering} onClick={() => void register(here)}>
            {registering ? t("sessions.registering") : t("sessions.useThisFolder")}
          </Button>
        ) : null}
        <Button variant="ghost" className="ml-auto" disabled={registering} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
