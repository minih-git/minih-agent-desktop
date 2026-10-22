/**
 * The accounts page's advanced area (rollout R8 package F).
 *
 * Folded, and holding the two things that are real destinations of their own:
 * the SSH hosts inventory (its settings id is kept, so links into it survive)
 * and the self-hosted gateway form, which account mode replaces with an
 * explanation while it can register this desktop itself.
 */
import { useTranslation } from "react-i18next";
import { Button } from "../ui";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { SelfHostedGatewaySection } from "./SelfHostedGatewaySection";
import { useAppStore } from "../../stores/app-store";
import type { RemoteControl } from "./useRemoteControl";

export function AccountsAdvancedSection({ control }: { control: RemoteControl }) {
  const { t } = useTranslation();
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);

  return (
    <section className="settings-card-block" aria-labelledby="accounts-advanced-heading">
      <div className="settings-card-heading-row">
        <h3 id="accounts-advanced-heading" className="settings-card-heading">
          {t("settings.accountsAdvancedSection.title")}
        </h3>
      </div>
      <SettingsDisclosure
        title={t("settings.accountsAdvancedSection.sshTitle")}
        titleClassName="settings-row-title"
        data-testid="accounts-advanced"
      >
        <p className="text-sm text-text-secondary">{t("settings.accountsAdvancedSection.sshDesc")}</p>
        <Button
          type="button"
          variant="secondary"
          data-testid="accounts-advanced-ssh-open"
          onClick={() => setSettingsTab("remoteHosts")}
        >
          {t("settings.accountsAdvancedSection.sshOpen")}
        </Button>
      </SettingsDisclosure>
      <SelfHostedGatewaySection control={control} />
    </section>
  );
}
