/**
 * Host list (PR-4).
 *
 * Each row probes its own host with `GET /hosts/{hostId}/v1/sessions`, because
 * the device cookie is scoped to `/hosts/{hostId}` and the Gateway's
 * `GET /v1/hosts` is therefore unreachable from the browser.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AppShell, Button, Card, Pill } from "../components/Chrome.js";
import { useAccountAvailability } from "../hooks/useAccountFlow.js";
import { useHostStatus } from "../hooks/useHostStatus.js";
import { forgetHost } from "../lib/forget.js";
import { credentialPort, gatewayOrigin, hostRegistry, isNativeApp } from "../lib/runtime.js";
import { unacceptedNextStep, type HostRegistryEntry } from "../lib/host-registry.js";

function statusKey(kind: "checking" | "online" | "offline" | "revoked" | "unaccepted" | "error"): string {
  return `hosts.status.${kind}`;
}

function HostRow({
  entry,
  onOpen,
  onForget,
  onAskAgain,
}: {
  entry: HostRegistryEntry;
  onOpen: () => void;
  onForget: () => void;
  /** Opens the account screen, where a new device request is made. */
  onAskAgain: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const credential = credentialPort.credentialFor(entry.hostId);
  const { status, refresh } = useHostStatus(entry.hostId, credential);
  const tone =
    status.kind === "online"
      ? "ok"
      : status.kind === "offline" || status.kind === "error" || status.kind === "unaccepted"
        ? "warn"
        : status.kind === "revoked"
          ? "bad"
          : "neutral";

  return (
    <Card>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{entry.label}</h2>
          <p className="app-mono truncate text-xs text-slate-500 dark:text-slate-400">{entry.hostId}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Pill tone={tone}>{t(statusKey(status.kind))}</Pill>
            {entry.pairedAt ? (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {t("hosts.pairedAt", { date: new Date(entry.pairedAt).toLocaleDateString(i18n.language) })}
              </span>
            ) : null}
          </div>
          {status.kind === "revoked" ? <p className="mt-2 text-xs text-red-700 dark:text-red-300">{t("hosts.revokeHint")}</p> : null}
          {status.kind === "unaccepted" ? (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              {t(unacceptedNextStep(entry) === "own-confirmation" ? "hosts.unacceptedStrictHint" : "hosts.unacceptedHint")}
            </p>
          ) : null}
          {status.kind === "error" ? <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{status.message}</p> : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" disabled={status.kind !== "online"} onClick={onOpen}>
          {t("hosts.open")}
        </Button>
        <Button variant="ghost" aria-label={`${t("common.refresh")}: ${entry.label}`} onClick={refresh}>
          {t("common.refresh")}
        </Button>
        {status.kind === "unaccepted" ? (
          <Button variant="secondary" onClick={onAskAgain}>
            {t("hosts.askAgain")}
          </Button>
        ) : null}
        {confirming ? (
          <>
            <Button variant="danger" onClick={onForget}>
              {t("hosts.forget")}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            {t("hosts.forget")}
          </Button>
        )}
      </div>
      {confirming ? (
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{t("hosts.forgetConfirm", { label: entry.label })}</p>
      ) : null}
    </Card>
  );
}

export function HostsScreen({
  hosts,
  onOpenHost,
  onAddHost,
  onAddAccount,
}: {
  hosts: HostRegistryEntry[];
  onOpenHost: (entry: HostRegistryEntry) => void;
  onAddHost: () => void;
  /** Signs in with an account key; only offered when the Gateway serves it. */
  onAddAccount: () => void;
}) {
  const { t } = useTranslation();
  // Only a Gateway that answered for the account routes gets the entry: a
  // Gateway without account mode keeps exactly the pairing flow it had.
  const accountMode = useAccountAvailability();
  return (
    <AppShell
      title={t("hosts.title")}
      actions={
        <Button variant="primary" onClick={onAddHost}>
          {t("hosts.add")}
        </Button>
      }
    >
      {hosts.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-600 dark:text-slate-300">{t("hosts.empty")}</p>
        </Card>
      ) : null}
      {accountMode === "supported" ? (
        <Card>
          <p className="text-sm text-slate-600 dark:text-slate-300">{t("account.intro")}</p>
          <div className="mt-3">
            <Button variant="secondary" onClick={onAddAccount}>
              {t("account.entry")}
            </Button>
          </div>
        </Card>
      ) : null}
      {hosts.map((entry) => (
        <HostRow
          key={entry.hostId}
          entry={entry}
          onOpen={() => onOpenHost(entry)}
          // Push is taken away before the credential is, so the phone can still
          // be told to stop (§11.6). The browser build ships no push and its
          // device cookie is scoped to `/hosts/{hostId}`, so the registration
          // route is unreachable from it: only the native app unregisters.
          onForget={() =>
            void forgetHost(entry.hostId, {
              registry: hostRegistry,
              credentialPort,
              ...(isNativeApp ? { push: { gatewayOrigin } } : {}),
            })
          }
          onAskAgain={onAddAccount}
        />
      ))}
    </AppShell>
  );
}
