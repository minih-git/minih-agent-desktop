/**
 * D2: connect the model gateway (ADR mobile-direct-gateway-chat §2).
 *
 * One field, one action. The AccessKey is typed or pasted, verified against
 * `GET /api/auth/session` before anything is stored, and then kept in the
 * platform secure store — never in this component's state after the screen
 * closes, never in a URL, never in `localStorage`.
 *
 * The screen says three things the decision requires: which gateway this build
 * talks to (a build-time origin, not a choice), that the key is saved on this
 * phone in the Keychain / Keystore, and that it is separate from the device
 * token a paired computer uses. A failure names what went wrong, because the
 * next step differs: replace the key, wait out a quota, or reach the gateway
 * from an allowed network.
 */
import { Router, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { DirectChatFailure } from "../lib/direct-chat/control.js";
import { Button } from "../components/ui/Button.js";
import { Callout } from "../components/ui/Callout.js";
import { NavBar } from "../components/ui/NavBar.js";
import { Screen, ScreenContent, ScreenDock } from "../components/ui/Screen.js";
import { SecureField } from "../components/ui/Fields.js";

export type ConnectGatewayScreenProps = {
  /** The baked model gateway origin, or null in a build without one. */
  gatewayOrigin: string | null;
  /** Verifies and stores the key; resolves with the failure to show, if any. */
  onConnect: (key: string) => Promise<{ failure: DirectChatFailure | null; restricted: boolean }>;
  onBack: () => void;
  onConnected: () => void;
};

export function ConnectGatewayScreen({
  gatewayOrigin,
  onConnect,
  onBack,
  onConnected,
}: ConnectGatewayScreenProps) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<DirectChatFailure | null>(null);
  const [restricted, setRestricted] = useState(false);

  const unavailable = gatewayOrigin === null;

  async function submit() {
    if (busy || unavailable) return;
    if (!key.trim()) {
      setFailure({ kind: "unauthorized", message: t("directChat.connect.emptyKey") });
      return;
    }
    setBusy(true);
    setFailure(null);
    setRestricted(false);
    const outcome = await onConnect(key);
    setBusy(false);
    if (outcome.failure) {
      setFailure(outcome.failure);
      return;
    }
    // The key is stored; the screen must not keep it in memory any longer.
    setKey("");
    if (outcome.restricted) {
      setRestricted(true);
      return;
    }
    onConnected();
  }

  return (
    <Screen>
      <NavBar title={t("directChat.connect.title")} onBack={onBack} backLabel={t("common.back")} />
      <ScreenContent hasDock>
        <div className="flex flex-col items-center px-4 pt-6 text-center">
          <span className="mb-3 grid h-14 w-14 place-items-center rounded-full bg-[var(--rm-bg-inset)] text-[var(--rm-text-primary)]">
            <Router className="h-7 w-7 stroke-[1.8]" aria-hidden="true" />
          </span>
          <h2 className="text-[20px] font-semibold leading-[26px] text-[var(--rm-text-primary)]">
            {t("directChat.connect.heading")}
          </h2>
          <p className="mt-2 max-w-[320px] text-[15px] leading-[22px] text-[var(--rm-text-secondary)]">
            {t("directChat.connect.subtitle")}
          </p>
        </div>

        <div className="mt-6 px-4">
          <div className="mb-2 ml-1 text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
            {t("directChat.connect.gatewayLabel")}
          </div>
          <div className="rounded-[12px] bg-[var(--rm-bg-surface)] px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--rm-separator)]">
            {unavailable ? (
              <p className="text-[15px] leading-[22px] text-[var(--rm-text-secondary)]">
                {t("directChat.unavailable")}
              </p>
            ) : (
              <p className="break-all font-mono text-[13px] leading-[18px] text-[var(--rm-text-secondary)]">
                {gatewayOrigin}
              </p>
            )}
          </div>
        </div>

        <div className="mt-5 px-4">
          <SecureField
            label={t("directChat.connect.keyLabel")}
            placeholder={t("directChat.connect.keyPlaceholder")}
            value={key}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={unavailable || busy}
            error={failure ? failureReason(t, failure) : undefined}
            onChange={(event) => setKey(event.target.value)}
          />
          {failure && failure.kind === "quota" ? (
            <p className="mt-1.5 ml-1 text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
              {t("directChat.failure.quotaHint")}
            </p>
          ) : null}
          {failure && failure.kind === "network-range" ? (
            <p className="mt-1.5 ml-1 text-[13px] leading-[18px] text-[var(--rm-text-muted)]">
              {t("directChat.failure.networkHint")}
            </p>
          ) : null}
        </div>

        {restricted ? (
          <div className="mt-4 px-4">
            <Callout>
              <span className="inline-flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {t("directChat.connect.restricted")}
              </span>
            </Callout>
          </div>
        ) : null}

        <div className="mt-4 px-4 pb-2">
          <Callout>{t("directChat.connect.keychainNote")}</Callout>
        </div>
      </ScreenContent>

      <ScreenDock>
        <Button
          variant="primary"
          size="large"
          disabled={unavailable || busy}
          onClick={() => void submit()}
        >
          {busy ? t("directChat.connect.verifying") : t("directChat.connect.action")}
        </Button>
        {restricted ? (
          <Button variant="secondary" size="large" onClick={onConnected}>
            {t("directChat.connect.continue")}
          </Button>
        ) : null}
      </ScreenDock>
    </Screen>
  );
}

/**
 * The reason half of the error, in the user's language.
 *
 * A kind is a next step, so each one gets its own sentence instead of the raw
 * gateway text: "the gateway rejected this key" and "this key is limited to
 * particular networks" lead to completely different actions.
 */
function failureReason(t: (key: string) => string, failure: DirectChatFailure): string {
  switch (failure.kind) {
    case "unauthorized":
      return t("directChat.failure.unauthorized");
    case "quota":
      return t("directChat.failure.quota");
    case "network-range":
      return t("directChat.failure.networkRange");
    case "transport":
      return t("directChat.failure.transport");
    default:
      return t("directChat.failure.gateway");
  }
}
