import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteHostSummary } from "@minih-agent/shared";
import { hostUnusableReasonKey, hostUsableForNewProject } from "../../lib/project-create-sources";
import { Button, Field, Input, Select } from "../ui";
import { RemoteFolderDialog } from "./RemoteFolderDialog";
import { needsAbsoluteRemotePath } from "../../lib/remote-folder-navigation";

/** One account computer's folder, picked for a new project (package E). */
export type AccountProjectSelection = { hostKey: string; hostLabel: string; path: string };

/**
 * The account-computer half of New project.
 *
 * It is deliberately not `RemoteProjectPicker`: that component serves the SSH
 * flow, where the folder is opened by a *local* Agent over remote tools, and its
 * wording and defaults follow from that. Here the folder becomes a project on
 * the other computer and the Agent runs there, so the host list is the account
 * computers only and a computer that cannot be used says why instead of being
 * silently missing.
 */
export function AccountComputerPicker({ busy, hosts, hostKey, onHostChange, onChange, onBrowsingChange }: {
  busy: boolean;
  hosts: RemoteHostSummary[];
  hostKey: string;
  onHostChange: (hostKey: string) => void;
  onChange: (selection: AccountProjectSelection | null) => void;
  onBrowsingChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [path, setPath] = useState("");
  const [browseOpen, setBrowseOpen] = useState(false);
  const host = hosts.find((item) => item.hostKey === hostKey);
  const unusableReason = host ? hostUnusableReasonKey(host) : null;
  const usable = host ? hostUsableForNewProject(host) : false;

  const setBrowsing = (open: boolean) => {
    setBrowseOpen(open);
    onBrowsingChange(open);
  };

  const select = (nextHostKey: string) => {
    onHostChange(nextHostKey);
    setPath("");
    onChange(null);
    setBrowsing(false);
  };

  const setChosenPath = (nextPath: string) => {
    setPath(nextPath);
    const selected = hosts.find((item) => item.hostKey === hostKey);
    onChange(selected && nextPath.trim() ? { hostKey, hostLabel: selected.label, path: nextPath.trim() } : null);
  };

  return (
    <section className="project-create-dialog-section remote-project-picker" aria-busy={busy}>
      <Field label={t("project.accountComputerLabel")}>
        <Select
          aria-label={t("project.accountComputerLabel")}
          value={hostKey}
          disabled={busy}
          onChange={(event) => select(event.target.value)}
        >
          {!hosts.length ? <option value="">{t("project.noAccountComputers")}</option> : null}
          {hosts.map((item) => (
            <option key={item.hostKey} value={item.hostKey}>
              {hostUsableForNewProject(item) ? item.label : `${item.label} — ${t(hostUnusableReasonKey(item) ?? "")}`}
            </option>
          ))}
        </Select>
      </Field>
      {/* A computer that cannot be used explains itself here, because the select
          option truncates and the reason is the actionable part. */}
      {unusableReason ? (
        <p className="remote-project-error" role="alert" data-account-computer-blocked>
          {t(unusableReason)}
        </p>
      ) : null}
      {host && usable ? (
        <Field label={t("project.accountComputerFolder")}>
          <div className="remote-folder-dialog-path-entry">
            <Input
              value={path}
              aria-label={t("project.accountComputerFolder")}
              placeholder={t("remote:pathPlaceholder")}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setChosenPath(event.target.value)}
            />
            <Button type="button" disabled={busy} onClick={() => setBrowsing(true)}>
              {t("remote:browseFolders")}
            </Button>
          </div>
        </Field>
      ) : null}
      {needsAbsoluteRemotePath(path.trim()) ? (
        <p className="remote-project-error" role="alert">{t("remote:REMOTE_ABSOLUTE_PATH_REQUIRED")}</p>
      ) : null}
      {browseOpen && host ? (
        <RemoteFolderDialog
          key={hostKey}
          hostKey={hostKey}
          hostLabel={host.label}
          initialPath={path}
          onChoose={(selected) => { setChosenPath(selected); setBrowsing(false); }}
          onClose={() => setBrowsing(false)}
        />
      ) : null}
    </section>
  );
}
