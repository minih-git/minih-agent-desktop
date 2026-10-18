/**
 * Account sign-in and device request (protocol §11.5, rollout R7 package F).
 *
 * One AccessKey sign-in, one device request, one approval on any computer of
 * the account, and the device then works on all of them. The screen is a thin
 * renderer over `AccountFlow`: it owns the AccessKey input (which never leaves
 * this component), the device name, and the countdown, and it hands every
 * decision — polling, retries, adoption, dropping the account session — to the
 * flow, which is tested without a DOM.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { AppShell, Button, Card, FailureBanner, Pill } from "../components/Chrome.js";
import { defaultAccountDeviceLabel, useAccountFlow } from "../hooks/useAccountFlow.js";
import { rosterSummary, remainingMs } from "../lib/account-flow.js";
import { formatRemaining, retrySeconds } from "../lib/account-format.js";
import type { AccountDeviceHost } from "../lib/account-client.js";
import type { OperationFailure } from "../lib/errors.js";

/** One Host of the roster, with what it can and cannot do for this device. */
function HostRow({ host }: { host: AccountDeviceHost }) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-wrap items-center gap-2 border-t border-slate-200 py-2 first:border-t-0 dark:border-slate-800">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{host.label}</span>
      <Pill tone={host.online ? "ok" : "neutral"}>{host.online ? t("account.hosts.online") : t("account.hosts.offline")}</Pill>
      <Pill tone={host.canConfirm ? "ok" : "warn"}>
        {host.canConfirm ? t("account.hosts.canConfirm") : t("account.hosts.cannotConfirm")}
      </Pill>
      <Pill tone={host.willAcceptGrant ? "ok" : "warn"}>
        {host.willAcceptGrant ? t("account.hosts.willAccept") : t("account.hosts.willNotAccept")}
      </Pill>
    </li>
  );
}

export function AccountScreen({
  onAdopted,
  onUseTicket,
  onBack,
}: {
  onAdopted: () => void;
  /** Falls back to the single-computer pairing ticket of §11.4. */
  onUseTicket: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [accessKey, setAccessKey] = useState("");
  const [label, setLabel] = useState(() => defaultAccountDeviceLabel());
  const { state, flow } = useAccountFlow(() => label);
  const [now, setNow] = useState(() => Date.now());

  // A one-second tick keeps the countdown honest; it never talks to the Gateway.
  useEffect(() => {
    if (state.kind !== "requesting") return undefined;
    const ticker = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(ticker);
  }, [state.kind]);

  const submit = async (): Promise<void> => {
    const key = accessKey.trim();
    if (!key) return;
    await flow.signIn(key);
    // The key is done the moment the Gateway has verified it: drop it from the
    // component either way, so a failed attempt does not leave it on screen.
    setAccessKey("");
  };

  const signingIn = state.kind === "signing-in";
  const failure: OperationFailure | null =
    state.kind === "sign-in-failed" ? state.failure : state.kind === "failed" ? state.failure : null;
  const roster = state.kind === "requesting" ? state.hosts : [];

  return (
    <AppShell title={t("account.title")} onBack={onBack}>
      {state.kind === "idle" || state.kind === "signing-in" || state.kind === "sign-in-failed" ? (
        <Card>
          <p className="text-sm text-slate-600 dark:text-slate-300">{t("account.intro")}</p>
          <label className="mt-3 block text-sm font-medium" htmlFor="account-key">
            {t("account.keyLabel")}
          </label>
          <input
            id="account-key"
            name="minih-account-access-key"
            type="password"
            value={accessKey}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder={t("account.keyPlaceholder")}
            onChange={(event) => setAccessKey(event.target.value)}
            className="app-mono app-tap mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("account.keyNotStored")}</p>
          <div className="mt-4 flex gap-2">
            <Button variant="primary" disabled={signingIn || accessKey.trim().length === 0} onClick={() => void submit()}>
              {signingIn ? t("account.signingIn") : t("account.signIn")}
            </Button>
            <Button variant="ghost" onClick={onUseTicket}>
              {t("account.device.useTicket")}
            </Button>
          </div>
        </Card>
      ) : null}

      {state.kind === "signed-in" ? (
        <>
          <Card>
            <p className="text-sm text-slate-600 dark:text-slate-300">{t("account.signedIn", { accountId: state.accountId })}</p>
            <h2 className="mt-3 text-sm font-semibold">{t("account.hosts.title")}</h2>
            {state.hosts.length === 0 ? (
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{t("account.hosts.empty")}</p>
            ) : (
              <ul className="mt-1">
                {state.hosts.map((host) => (
                  <li
                    key={host.hostId}
                    className="flex items-center gap-2 border-t border-slate-200 py-2 first:border-t-0 dark:border-slate-800"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{host.label}</span>
                    <Pill tone={host.online ? "ok" : "neutral"}>
                      {host.online ? t("account.hosts.online") : t("account.hosts.offline")}
                    </Pill>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <label className="block text-sm font-medium" htmlFor="account-device-label">
              {t("account.device.labelLabel")}
            </label>
            <input
              id="account-device-label"
              value={label}
              maxLength={128}
              placeholder={t("account.device.labelPlaceholder")}
              onChange={(event) => setLabel(event.target.value)}
              className="app-tap mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
            <div className="mt-4 flex gap-2">
              <Button variant="primary" onClick={() => void flow.requestDevice()}>
                {t("account.device.request")}
              </Button>
              <Button variant="ghost" onClick={() => void flow.abandon()}>
                {t("account.signOut")}
              </Button>
            </div>
          </Card>
        </>
      ) : null}

      {state.kind === "requesting" ? (
        <>
          <Card>
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium">{t("account.device.waiting")}</p>
              <span className="app-mono text-xs text-slate-500 dark:text-slate-400">
                {t("account.device.remaining", { time: formatRemaining(remainingMs(state.expiresAt, now)) })}
              </span>
            </div>
            <ul className="mt-2">
              {roster.map((host) => (
                <HostRow key={host.hostId} host={host} />
              ))}
            </ul>
            <div className="mt-4 flex gap-2">
              <Button variant="ghost" onClick={() => flow.cancel()}>
                {t("common.cancel")}
              </Button>
            </div>
          </Card>
          {!rosterSummary(roster).anyCanConfirm ? (
            <Card className="border-amber-300 dark:border-amber-800">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">{t("account.device.noConfirmer")}</p>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{t("account.device.noConfirmerHint")}</p>
              <div className="mt-3">
                <Button variant="warning" onClick={onUseTicket}>
                  {t("account.device.useTicket")}
                </Button>
              </div>
            </Card>
          ) : null}
        </>
      ) : null}

      {state.kind === "granted" ? (
        <Card>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {state.signerHostId
              ? t("account.device.approvedBy", {
                  host: state.hosts.find((host) => host.hostId === state.signerHostId)?.label ?? state.signerHostId,
                })
              : t("account.device.waiting")}
          </p>
        </Card>
      ) : null}

      {state.kind === "adopted" ? (
        <Card>
          <p className="text-sm text-slate-700 dark:text-slate-200">{t("account.device.adopted", { count: state.hostIds.length })}</p>
          <div className="mt-3">
            <Button variant="primary" onClick={onAdopted}>
              {t("account.device.openHosts")}
            </Button>
          </div>
        </Card>
      ) : null}

      {state.kind === "expired" || state.kind === "lost" ? (
        <Card>
          <p className="text-sm text-slate-700 dark:text-slate-200">
            {state.kind === "expired" ? t("account.device.expired") : t("account.device.lost")}
          </p>
          <div className="mt-2">
            <ul>
              {state.hosts.map((host) => (
                <HostRow key={host.hostId} host={host} />
              ))}
            </ul>
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={() => void flow.requestDevice()}>
              {t("account.device.askAgain")}
            </Button>
            <Button variant="ghost" onClick={onUseTicket}>
              {t("account.device.useTicket")}
            </Button>
          </div>
        </Card>
      ) : null}

      {state.kind === "gone" ? (
        <Card>
          <p className="text-sm text-slate-700 dark:text-slate-200">{t("account.device.gone")}</p>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={() => void flow.abandon()}>
              {t("account.device.signInAgain")}
            </Button>
            <Button variant="ghost" onClick={onUseTicket}>
              {t("account.device.useTicket")}
            </Button>
          </div>
        </Card>
      ) : null}

      {state.kind === "failed" ? (
        <Card>
          <p className="text-sm text-slate-700 dark:text-slate-200">{t("account.device.failedHint")}</p>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={() => void flow.retry()}>
              {t("account.device.retry")}
            </Button>
            <Button variant="ghost" onClick={onUseTicket}>
              {t("account.device.useTicket")}
            </Button>
          </div>
        </Card>
      ) : null}

      {failure ? (
        <>
          <FailureBanner
            failure={failure}
            operationKey={state.kind === "sign-in-failed" ? "operation.accountSignIn" : "operation.accountDevice"}
          />
          {retrySeconds(failure) !== null ? (
            <p className="px-3 text-xs text-slate-500 dark:text-slate-400">
              {t("account.retryIn", { seconds: retrySeconds(failure) })}
            </p>
          ) : null}
        </>
      ) : null}
    </AppShell>
  );
}
