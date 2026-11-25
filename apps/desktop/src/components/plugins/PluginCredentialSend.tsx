import { useTranslation } from "react-i18next";
import { Input, Select } from "../ui";
import { defaultSendPort } from "./mail-endpoint";
import type { CredentialValues } from "./PluginCredentials";

/**
 * The optional "send through my own server" part of a mailbox slot whose
 * manifest declares `userSend`.
 *
 * These three values belong to the account, not to the plugin: the app stores
 * them with the password and sends from that server and nowhere else, which is
 * why the plugin's own form cannot offer them. Leaving the server empty keeps
 * the account on whatever path `manifest.net.tcp` presets — and an account with
 * neither cannot send at all.
 *
 * The user name is the address above and the password is the same one: a
 * provider that lets you read a mailbox almost always accepts that credential
 * for submission too, and asking for it twice is how accounts end up saved
 * half-configured.
 */
export function CustomMailSendFields({
  security,
  values,
  onChange,
  disabled,
}: {
  security: readonly string[];
  values: CredentialValues;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const chosen = values.sendSecurity || security[0] || "tls";
  const port = values.sendPort ?? "";

  // A server without a port and a transport is not an account anyone can send
  // from, so naming one fills the two values the user did not touch yet.
  const setServer = (value: string) => {
    if (value.trim() && !values.sendServer) {
      onChange("sendSecurity", chosen);
      onChange("sendPort", port || defaultSendPort(chosen));
    }
    onChange("sendServer", value);
  };
  const setSecurity = (next: string) => {
    onChange("sendSecurity", next);
    if (!port || port === defaultSendPort(chosen)) onChange("sendPort", defaultSendPort(next));
  };

  return (
    <details className="plugin-credential-endpoint">
      <summary>{t("pluginCredentials.sendServer")}</summary>
      <p className="plugin-credential-endpoint-hint">{t("pluginCredentials.sendServerHint")}</p>
      <div className="plugin-credential-field">
        <span>{t("pluginCredentials.sendServerHost")}</span>
        <Input
          value={values.sendServer ?? ""}
          onChange={(event) => setServer(event.target.value)}
          placeholder={t("pluginCredentials.sendServerHostPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          aria-label={t("pluginCredentials.sendServerHost")}
          disabled={disabled}
        />
      </div>
      <div className="plugin-credential-field">
        <span>{t("pluginCredentials.sendServerSecurity")}</span>
        <Select
          value={chosen}
          onChange={(event) => setSecurity(event.target.value)}
          aria-label={t("pluginCredentials.sendServerSecurity")}
          disabled={disabled}
        >
          {security.includes("tls") ? (
            <option value="tls">{t("pluginCredentials.sendServerSecurityTls")}</option>
          ) : null}
          {security.includes("starttls") ? (
            <option value="starttls">{t("pluginCredentials.sendServerSecurityStarttls")}</option>
          ) : null}
        </Select>
      </div>
      <div className="plugin-credential-field">
        <span>{t("pluginCredentials.sendServerPort")}</span>
        <Input
          value={port}
          onChange={(event) => onChange("sendPort", event.target.value)}
          inputMode="numeric"
          autoComplete="off"
          aria-label={t("pluginCredentials.sendServerPort")}
          disabled={disabled}
        />
      </div>
    </details>
  );
}