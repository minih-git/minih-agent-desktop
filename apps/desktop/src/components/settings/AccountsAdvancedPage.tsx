/**
 * 账户 ▸ Advanced.
 *
 * The two surfaces that stopped being first-level destinations: the SSH host
 * inventory (its own settings id stays for links, and it now renders here
 * instead of behind a detour) and the self-hosted gateway form, which account
 * mode replaces with an explanation while it can register this desktop itself.
 */
import { useTranslation } from "react-i18next";
import { RemoteHostsPage } from "./RemoteHostsPage";
import { SelfHostedGatewaySection } from "./SelfHostedGatewaySection";
import { useRemoteControl } from "./useRemoteControl";

export function AccountsAdvancedPage() {
  const { t } = useTranslation();
  // One control instance: the self-hosted form and the link it feeds read the
  // same status the account page reads.
  const control = useRemoteControl();

  return (
    <div className="settings-stack">
      <RemoteHostsPage />
      <section className="settings-card-block" aria-labelledby="accounts-advanced-heading">
        <div className="settings-card-heading-row">
          <h3 id="accounts-advanced-heading" className="settings-card-heading">
            {t("settings.accountsAdvancedSection.selfHostedTitle")}
          </h3>
        </div>
        <SelfHostedGatewaySection control={control} />
      </section>
    </div>
  );
}
