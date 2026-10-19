/**
 * The self-hosted gateway, folded away (rollout R5, ADR 0331).
 *
 * A registration code is only for a Gateway the user runs themselves. Account
 * mode names the Gateway for the user, so the fields that exist for the other
 * path stay collapsed under "Advanced: self-hosted gateway" — reachable, never
 * in the way, and never offered as a second way to enroll once the account
 * already registered this desktop (that would overwrite the account
 * credentials with a self-hosted certificate).
 */
import { useTranslation } from "react-i18next";
import { accountModeReplacesEnrollment, accountModeVisible } from "../../lib/remote-gateway-state";
import { Button, Field, Input, Textarea } from "../ui";
import { SettingsDisclosure } from "./SettingsDisclosure";
import type { RemoteControl } from "./useRemoteControl";

export function SelfHostedGatewaySection({ control }: { control: RemoteControl }) {
  const { t } = useTranslation();
  const { status } = control;
  // Enrolled through a Gateway the user runs: account mode is unavailable, so
  // the credentials cannot be account-bound. Open the area so the registration
  // state is not hidden from someone looking for it.
  const selfHostedEnrolled = status?.enrolled === true && status.accountMode?.available !== true;
  const showsForm = !accountModeReplacesEnrollment(status);

  return (
    <section className="settings-card-block">
      <SettingsDisclosure
        open={selfHostedEnrolled}
        title={t("settings.remoteGateway.advancedTitle")}
        titleClassName="settings-row-title"
        data-testid="remote-gateway-advanced"
      >
        <p className="text-xs text-text-secondary">{t("settings.remoteGateway.advancedHint")}</p>
        {showsForm ? (
          <div className="space-y-3">
            <Field label={t("settings.remoteGateway.url")}>
              <Input
                value={control.url}
                placeholder={t("settings.remoteGateway.urlPlaceholder")}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(event) => {
                  control.urlTouched.current = true;
                  control.setUrl(event.currentTarget.value);
                }}
              />
            </Field>
            <Field label={t("settings.remoteGateway.caPem")}>
              <Textarea
                value={control.caPem}
                placeholder={t("settings.remoteGateway.caPemPlaceholder")}
                rows={4}
                onChange={(event) => control.setCaPem(event.currentTarget.value)}
              />
            </Field>
            <Field label={t("settings.remoteGateway.registrationCode")}>
              <Input
                value={control.registrationCode}
                placeholder={t("settings.remoteGateway.registrationCodePlaceholder")}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(event) => control.setRegistrationCode(event.currentTarget.value)}
              />
            </Field>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="primary"
                disabled={
                  control.enrolling ||
                  !control.url.trim() ||
                  !control.caPem.trim() ||
                  !control.registrationCode.trim()
                }
                aria-busy={control.enrolling}
                onClick={() => void control.onEnroll()}
              >
                {control.enrolling
                  ? t("settings.remoteGateway.enrolling")
                  : t("settings.remoteGateway.enroll")}
              </Button>
              <span className="text-xs text-text-secondary">
                {t("settings.remoteGateway.enrollHint")}
              </span>
            </div>
            {control.enrollSucceeded && !control.enrollError ? (
              <p className="text-sm text-text-secondary" role="status">
                {t("settings.remoteGateway.enrollSucceeded")}
              </p>
            ) : null}
            {control.enrollError ? (
              <p className="text-sm text-danger" role="alert">
                {control.enrollError}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2" role="status">
            <div className="settings-row-title">
              {status?.enrolled
                ? t("settings.remoteGateway.accountEnrollTitle")
                : t("settings.remoteGateway.accountEnrollPendingTitle")}
            </div>
            <p className="text-sm text-text-secondary">
              {status?.enrolled
                ? t("settings.remoteGateway.accountEnrollBody")
                : t("settings.remoteGateway.accountEnrollPendingBody")}
            </p>
            {accountModeVisible(status) ? (
              <p className="text-xs text-text-secondary">
                {t("settings.remoteGateway.enrollHint")}
              </p>
            ) : null}
          </div>
        )}
      </SettingsDisclosure>
    </section>
  );
}
