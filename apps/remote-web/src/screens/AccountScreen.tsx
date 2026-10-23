import { Check, Globe, Laptop, Lock, Phone, User } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { GatewaySheet } from "../components/hosts/HostSheets.js";
import { Banner } from "../components/ui/Banner.js";
import { Button } from "../components/ui/Button.js";
import { Callout } from "../components/ui/Callout.js";
import { ResultState } from "../components/ui/EmptyState.js";
import { SecureField } from "../components/ui/Fields.js";
import { ListGroup, ListRow } from "../components/ui/ListGroup.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent, ScreenDock } from "../components/ui/Screen.js";
import { SectionHeader } from "../components/ui/SectionHeader.js";
import { StatusDot } from "../components/ui/StatusDot.js";
import { defaultAccountDeviceLabel, useAccountFlow } from "../hooks/useAccountFlow.js";
import { remainingMs, rosterSummary } from "../lib/account-flow.js";
import { formatRemaining, retrySeconds } from "../lib/account-format.js";
import type { OperationFailure } from "../lib/errors.js";
import { gatewayOrigin } from "../lib/runtime.js";

function Stepper({ currentStep }: { currentStep: 0 | 1 | 2 }) {
  const { t } = useTranslation();
  const steps = [
    t("account.step.signIn"),
    t("account.step.request"),
    t("account.step.confirm"),
  ];

  return (
    <div className="flex items-center gap-2 py-2 px-1 text-[13px] text-[var(--rm-text-muted)] mb-2">
      {steps.map((label, index) => {
        const isCurrent = index === currentStep;
        const isDone = index < currentStep;
        return (
          <Fragment key={label}>
            <span
              className={`flex items-center gap-1 font-medium ${
                isCurrent
                  ? "text-[var(--rm-text-primary)] font-semibold"
                  : isDone
                    ? "text-[var(--rm-text-secondary)]"
                    : "text-[var(--rm-text-muted)]"
              }`}
            >
              {isDone && <Check className="w-3.5 h-3.5 stroke-[2.5]" />}
              {label}
            </span>
            {index < steps.length - 1 && (
              <span className="flex-1 h-px bg-[var(--rm-separator)]" />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function CountdownRing({
  remainingSeconds,
  totalSeconds = 300,
}: {
  remainingSeconds: number;
  totalSeconds?: number;
}) {
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const fraction = Math.max(0, Math.min(1, remainingSeconds / totalSeconds));
  const offset = circumference * (1 - fraction);

  const m = Math.floor(remainingSeconds / 60);
  const s = remainingSeconds % 60;
  const formatted = `${m}:${String(s).padStart(2, "0")}`;

  return (
    <div className="relative w-[104px] h-[104px] my-2">
      <svg width="104" height="104" className="-rotate-90">
        <circle
          cx="52"
          cy="52"
          r={radius}
          fill="none"
          stroke="var(--rm-bg-inset)"
          strokeWidth="6"
        />
        <circle
          cx="52"
          cy="52"
          r={radius}
          fill="none"
          stroke="var(--rm-status-decision)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-1000 ease-linear"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center font-mono text-[20px] font-semibold text-[var(--rm-text-primary)]">
        {formatted}
      </div>
    </div>
  );
}

export function AccountScreen({
  onAdopted,
  onUseTicket,
  onBack,
}: {
  onAdopted: () => void;
  onUseTicket: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [accessKey, setAccessKey] = useState("");
  const [label, setLabel] = useState(() => defaultAccountDeviceLabel());
  const { state, flow } = useAccountFlow(() => label);
  const [now, setNow] = useState(() => Date.now());
  const [gatewayOpen, setGatewayOpen] = useState(false);

  useEffect(() => {
    if (state.kind !== "requesting") return undefined;
    const ticker = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(ticker);
  }, [state.kind]);

  const submit = async (): Promise<void> => {
    const key = accessKey.trim();
    if (!key) return;
    await flow.signIn(key);
    setAccessKey("");
  };

  const signingIn = state.kind === "signing-in";
  const failure: OperationFailure | null =
    state.kind === "sign-in-failed"
      ? state.failure
      : state.kind === "failed"
        ? state.failure
        : null;

  // Step 1: Sign in
  if (
    state.kind === "idle" ||
    state.kind === "signing-in" ||
    state.kind === "sign-in-failed"
  ) {
    const retrySec = failure ? retrySeconds(failure) : null;
    const isRateLimited = retrySec !== null && retrySec > 0;

    return (
      <Screen>
        <NavBar title={t("account.title")} onBack={onBack} backLabel={t("common.back")} />
        <ScreenContent hasDock>
          <Stepper currentStep={0} />

          <div className="mb-3 flex items-center justify-between gap-2 rounded-xl bg-[var(--rm-bg-surface)] px-3 py-2 text-[12px] ring-1 ring-[var(--rm-separator)]">
            <div className="flex min-w-0 items-center gap-1.5 text-[var(--rm-text-secondary)]">
              <Globe className="h-3.5 w-3.5 shrink-0 text-[var(--rm-accent)]" aria-hidden="true" />
              <span className="truncate font-mono">{gatewayOrigin}</span>
            </div>
            <button
              type="button"
              onClick={() => setGatewayOpen(true)}
              className="shrink-0 font-medium text-[var(--rm-link)] active:opacity-70"
            >
              {t("hosts.switchGateway")}
            </button>
          </div>
          <div className="space-y-4 pt-1">
            <SecureField
              label={t("account.keyLabel")}
              value={accessKey}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={t("account.keyPlaceholder")}
              onChange={(e) => setAccessKey(e.target.value)}
            />

            <p className="flex items-center gap-1.5 text-xs text-[var(--rm-text-muted)] ml-1">
              <Lock className="w-3.5 h-3.5 flex-none" />
              <span>{t("account.keyNotStored")}</span>
            </p>

            <Callout>
              {t("account.introBox")}
            </Callout>

            {failure ? (
              <Banner tone="error">
                {failure.message ||
                  (failure.code
                    ? `${t("operation.accountSignIn")}: ${failure.code}`
                    : t("operation.accountSignIn"))}
              </Banner>
            ) : null}
          </div>
        </ScreenContent>

        <ScreenDock>
          <div className="flex flex-col gap-2.5">
            <Button
              variant="primary"
              size="large"
              loading={signingIn}
              disabled={signingIn || accessKey.trim().length === 0 || isRateLimited}
              onClick={() => void submit()}
            >
              {isRateLimited
                ? t("account.retryIn", { seconds: retrySec })
                : signingIn
                  ? t("account.signingIn")
                  : t("account.signIn")}
            </Button>
            <Button variant="plain" size="large" onClick={onUseTicket}>
              {t("account.device.useTicket")}
            </Button>
          </div>
        </ScreenDock>
        <GatewaySheet open={gatewayOpen} onClose={() => setGatewayOpen(false)} />
      </Screen>
    );
  }

  // Step 2: Request device
  if (state.kind === "signed-in") {
    return (
      <Screen>
        <NavBar title={t("account.title")} onBack={onBack} backLabel={t("common.back")} />
        <ScreenContent hasDock>
          <Stepper currentStep={1} />

          <ListGroup className="mt-2">
            <ListRow
              compact
              leading={
                <div className="w-8 h-8 rounded-[8px] bg-[var(--rm-bg-inset)] text-[var(--rm-text-secondary)] flex items-center justify-center">
                  <User className="w-4 h-4" />
                </div>
              }
              title={
                <span className="font-semibold text-[15px]">
                  {t("account.signedIn", { accountId: state.accountId })}
                </span>
              }
              trailing={
                <Button
                  variant="plain"
                  size="small"
                  onClick={() => void flow.abandon()}
                >
                  {t("account.signOut")}
                </Button>
              }
            />
          </ListGroup>

          <SectionHeader title={t("account.hosts.title")} />

          {state.hosts.length === 0 ? (
            <div className="rounded-2xl bg-[var(--rm-bg-surface)] py-5 px-4 text-sm text-[var(--rm-text-muted)] text-center ring-1 ring-[var(--rm-separator)]">
              {t("account.hosts.empty")}
            </div>
          ) : (
            <div className="space-y-2.5">
              {state.hosts.map((host) => (
                <div
                  key={host.hostId}
                  className="flex items-center gap-3 rounded-2xl bg-[var(--rm-bg-surface)] px-4 py-3.5 shadow-[var(--rm-shadow)] ring-1 ring-[var(--rm-separator)]"
                >
                  <div
                    className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--rm-bg-inset)] ${
                      host.online ? "text-[var(--rm-text-primary)]" : "text-[var(--rm-text-muted)]"
                    }`}
                  >
                    <Laptop className="h-5 w-5" aria-hidden="true" />
                    <span className="absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-[var(--rm-bg-surface)]">
                      <StatusDot status={host.online ? "online" : "offline"} size="small" />
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[16px] font-semibold leading-[22px] text-[var(--rm-text-primary)]">
                      {host.label}
                    </div>
                    <div
                      className={`mt-0.5 truncate text-[13px] leading-[18px] ${
                        host.online ? "text-[var(--rm-success)]" : "text-[var(--rm-text-secondary)]"
                      }`}
                    >
                      {host.online ? t("account.hosts.online") : t("account.hosts.offline")}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-5 space-y-1.5">
            <label
              htmlFor="device-name"
              className="ml-1 block text-[13px] font-normal leading-[18px] text-[var(--rm-text-muted)]"
            >
              {t("account.device.labelLabel")}
            </label>
            <div className="flex min-h-[52px] w-full items-center gap-2.5 rounded-[12px] bg-[var(--rm-bg-surface)] px-3.5 shadow-[inset_0_0_0_1px_var(--rm-separator)] transition-shadow focus-within:shadow-[inset_0_0_0_2px_var(--rm-accent)]">
              <Phone className="w-4 h-4 text-[var(--rm-text-muted)] flex-none" />
              <input
                id="device-name"
                value={label}
                maxLength={128}
                placeholder={t("account.device.labelPlaceholder")}
                onChange={(e) => setLabel(e.target.value)}
                className="w-full bg-transparent text-[16px] leading-[24px] text-[var(--rm-text-primary)] outline-none"
              />
            </div>
          </div>
        </ScreenContent>

        <ScreenDock>
          <Button
            variant="primary"
            size="large"
            className="w-full"
            onClick={() => void flow.requestDevice()}
          >
            {t("account.device.request")}
          </Button>
        </ScreenDock>
      </Screen>
    );
  }

  // Step 3: Waiting for confirmation
  if (state.kind === "requesting") {
    const leftSec = Math.max(0, Math.round(remainingMs(state.expiresAt, now) / 1000));
    const summary = rosterSummary(state.hosts);
    const anyCanConfirm = summary.anyCanConfirm;

    return (
      <Screen>
        <NavBar title={t("account.title")} />
        <ScreenContent hasDock>
          <Stepper currentStep={2} />

          <div className="flex flex-col items-center text-center py-6 px-3">
            <CountdownRing remainingSeconds={leftSec} />
            <h2 className="text-[20px] font-semibold leading-[26px] text-[var(--rm-text-primary)] mt-3">
              {t("account.device.waiting")}
            </h2>
            <p className="mt-2 text-[15px] leading-[22px] text-[var(--rm-text-secondary)] whitespace-pre-line">
              {t("account.waitingHint", { device: label })}
            </p>
          </div>

          {!anyCanConfirm ? (
            <Callout tone="error" className="mb-4">
              <div className="font-semibold text-sm">
                {t("account.device.noConfirmer")}
              </div>
              <div className="text-xs mt-0.5 opacity-90">
                {t("account.device.noConfirmerHint")}
              </div>
            </Callout>
          ) : null}

          <SectionHeader title={t("account.waitingSentTitle")} />

          <div className="space-y-2.5">
            {state.hosts.map((host) => {
              const sub = !host.online
                ? t("account.hosts.offline")
                : host.canConfirm
                  ? t("account.hosts.canConfirm")
                  : t("account.hosts.cannotConfirm");

              return (
                <div
                  key={host.hostId}
                  className="flex items-center gap-3 rounded-2xl bg-[var(--rm-bg-surface)] px-4 py-3.5 shadow-[var(--rm-shadow)] ring-1 ring-[var(--rm-separator)]"
                >
                  <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--rm-bg-inset)] text-[var(--rm-text-primary)]">
                    <Laptop className="h-5 w-5" aria-hidden="true" />
                    <span className="absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-[var(--rm-bg-surface)]">
                      <StatusDot status={host.online ? "decision" : "offline"} size="small" />
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[16px] font-semibold leading-[22px] text-[var(--rm-text-primary)]">
                      {host.label}
                    </div>
                    <div className="mt-0.5 truncate text-[13px] leading-[18px] text-[var(--rm-text-secondary)]">
                      {sub}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScreenContent>

        <ScreenDock>
          <div className="flex flex-col gap-2.5">
            {!anyCanConfirm ? (
              <Button
                variant="primary"
                size="large"
                className="w-full"
                onClick={onUseTicket}
              >
                {t("account.device.useTicket")}
              </Button>
            ) : null}
            <Button
              variant="plain"
              size="large"
              className="w-full"
              onClick={() => flow.cancel()}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </ScreenDock>
      </Screen>
    );
  }

  // Result: Adopted
  if (state.kind === "adopted") {
    return (
      <Screen>
        <NavBar title="" />
        <ScreenContent hasDock>
          <ResultState
            status="success"
            title={t("account.device.adopted", { count: state.hostIds.length })}
            description={t("account.adoptedDesc")}
            action={
              <Button
                variant="primary"
                size="large"
                className="w-full"
                onClick={onAdopted}
              >
                {t("account.device.openHosts")}
              </Button>
            }
          />
        </ScreenContent>
      </Screen>
    );
  }

  // Result: Expired or Lost
  if (state.kind === "expired" || state.kind === "lost") {
    return (
      <Screen>
        <NavBar title={t("account.title")} onBack={onBack} backLabel={t("common.back")} />
        <ScreenContent hasDock>
          <ResultState
            status="error"
            title={
              state.kind === "expired"
                ? t("account.device.expired")
                : t("account.device.lost")
            }
            description={t("account.device.failedHint")}
            action={
              <Button
                variant="primary"
                size="large"
                onClick={() => void flow.requestDevice()}
              >
                {t("account.device.askAgain")}
              </Button>
            }
            secondaryAction={
              <Button variant="secondary" size="large" onClick={onUseTicket}>
                {t("account.device.useTicket")}
              </Button>
            }
          />
        </ScreenContent>
      </Screen>
    );
  }

  // Result: Gone or other failure
  return (
    <Screen>
      <NavBar title={t("account.title")} onBack={onBack} backLabel={t("common.back")} />
      <ScreenContent hasDock>
        <ResultState
          status="error"
          title={
            state.kind === "gone"
              ? t("account.device.gone")
              : t("account.device.failedHint")
          }
          action={
            <Button
              variant="primary"
              size="large"
              onClick={() => void (state.kind === "gone" ? flow.abandon() : flow.retry())}
            >
              {state.kind === "gone"
                ? t("account.device.signInAgain")
                : t("account.device.retry")}
            </Button>
          }
          secondaryAction={
            <Button variant="secondary" size="large" onClick={onUseTicket}>
              {t("account.device.useTicket")}
            </Button>
          }
        />
      </ScreenContent>
    </Screen>
  );
}
